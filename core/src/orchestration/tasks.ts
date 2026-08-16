import type { SwarmTaskInfo, SwarmTaskState, TaskLogChunk, TaskLogLine } from '../types';
import { jsonLines, must, type Exec } from './orchestration';
import { shq } from '../shq';

interface DockerTaskRow {
  ID: string;
  Name: string;
  Image: string;
  Node: string;
  DesiredState: string;
  CurrentState: string;
  Error: string;
  Ports: string;
}

const TASK_STATES = new Set<SwarmTaskState>([
  'new',
  'allocated',
  'pending',
  'assigned',
  'accepted',
  'preparing',
  'ready',
  'starting',
  'running',
  'complete',
  'shutdown',
  'failed',
  'rejected',
  'remove',
  'orphaned',
]);

/** "Running 4 hours ago" -> { state: 'running', sinceText: '4 hours ago' } */
export function parseCurrentState(s: string): { state: SwarmTaskState; sinceText: string } {
  const space = s.indexOf(' ');
  const word = (space > 0 ? s.slice(0, space) : s).toLowerCase();
  return {
    state: TASK_STATES.has(word as SwarmTaskState) ? (word as SwarmTaskState) : 'new',
    sinceText: space > 0 ? s.slice(space + 1).trim() : '',
  };
}

/**
 * Task list for one service (`docker service ps`) — includes historical
 * shutdown/failed entries, which is the point: they carry the errors.
 */
export async function fetchServiceTasks(exec: Exec, service: string): Promise<SwarmTaskInfo[]> {
  const out = must(
    await exec(`docker service ps --no-trunc --format '{{json .}}' ${shq(service)}`),
    'docker service ps',
  );
  return jsonLines<DockerTaskRow>(out).map((row) => {
    const { state, sinceText } = parseCurrentState(row.CurrentState);
    return {
      id: row.ID,
      name: row.Name,
      // Slicing off "<service>." is immune to dots inside the service name,
      // unlike splitting on '.'.
      slot: row.Name.startsWith(`${service}.`) ? row.Name.slice(service.length + 1) : row.Name,
      image: row.Image,
      node: row.Node,
      desiredState: row.DesiredState.toLowerCase(),
      state,
      sinceText,
      // The task formatter wraps errors in literal double quotes.
      error: row.Error.replace(/^"([\s\S]*)"$/, '$1'),
    };
  });
}

export interface TaskLogsOptions {
  tail?: number;
  /** RFC3339 timestamp (inclusive) — the follow cursor. Overrides tail. */
  since?: string;
}

// `--raw` drops the "svc.1.taskid@node |" prefix, so with -t each log line is
// "<RFC3339Nano> <message>". Lines without a timestamp are continuations of
// the previous line (multi-line frames).
const LOG_LINE = /^(\d{4}-\d{2}-\d{2}T\S+)\s?(.*)$/;

/** Exported for tests. CLI noise (timestamp-less leading lines) is dropped. */
export function parseLogStream(raw: string, stream: 'out' | 'err'): TaskLogLine[] {
  const lines: TaskLogLine[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    const m = line.match(LOG_LINE);
    if (m) lines.push({ ts: m[1], stream, text: m[2] });
    else if (lines.length) lines[lines.length - 1].text += `\n${line}`;
  }
  return lines;
}

/**
 * One-shot log fetch for a single task. Follow is the caller re-invoking with
 * `since = lastTs`; since is inclusive, so drop returned lines at or before
 * the cursor that were already seen.
 *
 * The docker CLI demultiplexes service logs onto its own stdout/stderr, and
 * exec captures the two streams separately — so the out/err tags are real.
 * Tasks running with a TTY merge everything into 'out'.
 */
export async function fetchTaskLogs(
  exec: Exec,
  taskId: string,
  opts?: TaskLogsOptions,
): Promise<TaskLogChunk> {
  const range = opts?.since ? `--since ${shq(opts.since)}` : `--tail ${opts?.tail ?? 200}`;
  const result = await exec(`docker service logs --raw -t --no-trunc ${range} ${shq(taskId)}`);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `docker service logs failed: exit ${result.code}`);
  }
  const lines = [...parseLogStream(result.stdout, 'out'), ...parseLogStream(result.stderr, 'err')];
  // RFC3339Nano trims trailing zeros, so lexicographic ts compare is unsafe;
  // millisecond precision plus a stable sort is enough for display order.
  const ms = new Map(lines.map((l) => [l, Date.parse(l.ts)]));
  lines.sort((a, b) => (ms.get(a) ?? 0) - (ms.get(b) ?? 0));
  const last = lines[lines.length - 1];
  return { lines, lastTs: last ? last.ts : null };
}
