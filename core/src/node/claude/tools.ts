import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ClaudeExecutor } from './executor';
import type { PermissionBridge } from './permission-bridge';

/** Command/file output cap per tool result — the model should filter big
 *  output remotely (grep/tail) instead of paging megabytes through context. */
const MAX_OUTPUT = 16 * 1024;
const READ_MAX_BYTES = 256 * 1024;

/** Keeps head and tail — errors usually live at the end of output. */
export function truncateOutput(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  const dropped = text.length - max;
  return (
    text.slice(0, half) +
    `\n… [${dropped} bytes truncated — narrow with grep/head/tail] …\n` +
    text.slice(-half)
  );
}

type ToolText = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

const ok = (text: string): ToolText => ({ content: [{ type: 'text', text }] });
const fail = (err: unknown): ToolText => ({
  content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

const HOST_PARAM = z
  .string()
  .describe(
    "Target host — a name or id from list_hosts (e.g. 'edge-01'). If the user " +
      'did not name a host, default to the one marked focused in list_hosts; ' +
      'when no host is focused or the request plausibly means a different one, ' +
      'ask the user to confirm the target before running anything.',
  );

/** The `pear` MCP tool surface: everything runs over the app's existing SSH
 *  connections to the referenced host. When a PermissionBridge is provided
 *  (chat mode), an `approve` tool is also registered for the CLI's
 *  --permission-prompt-tool flow. */
export function registerPearTools(
  server: McpServer,
  executor: ClaudeExecutor,
  bridge?: PermissionBridge,
): void {
  if (bridge) {
    server.registerTool(
      'approve',
      {
        description:
          'Internal permission gate used by the Pear app UI. Never call this tool yourself.',
        inputSchema: {
          tool_name: z.string(),
          input: z.unknown().optional(),
          tool_use_id: z.string().optional(),
        },
      },
      async ({ tool_name, input }) => {
        try {
          return ok(await bridge.request(tool_name, input));
        } catch (err) {
          return ok(
            JSON.stringify({
              behavior: 'deny',
              message: `Permission prompt failed: ${err instanceof Error ? err.message : err}`,
            }),
          );
        }
      },
    );
  }
  server.registerTool(
    'list_hosts',
    {
      description:
        "The user's servers registered in Pear: names, addresses, kind " +
        '(docker/swarm/proxmox/plain) and whether a connection is currently open. ' +
        'Call this before targeting a host. Hosts connect automatically on first use. ' +
        '`focused: true` marks the host the user is currently looking at in the app ' +
        "(with focusedPath = the directory in view) — that's what bare references " +
        'like "this host", "here" or an unnamed target usually mean.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify(executor.listHosts(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'run_command',
    {
      description:
        'Run a shell command on a host over SSH. Returns exit code, stdout and stderr ' +
        '(truncated at ~16 KB — filter large output with grep/tail). The command is ' +
        'killed after timeoutSec (default 60), so long-running/interactive commands ' +
        'need an explicit timeout or a detached/one-shot form.',
      inputSchema: {
        host: HOST_PARAM,
        command: z.string().describe('POSIX shell command line'),
        timeoutSec: z
          .number()
          .optional()
          .describe('Kill the command after this many seconds (default 60, max 600)'),
      },
    },
    async ({ host, command, timeoutSec }) => {
      try {
        const r = await executor.runCommand(host, command, timeoutSec);
        const parts = [
          r.timedOut ? `exit code: 124 (timed out and was killed)` : `exit code: ${r.code}`,
        ];
        if (r.stdout) parts.push(`── stdout ──\n${truncateOutput(r.stdout)}`);
        if (r.stderr) parts.push(`── stderr ──\n${truncateOutput(r.stderr)}`);
        if (!r.stdout && !r.stderr) parts.push('(no output)');
        return ok(parts.join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'read_file',
    {
      description:
        'Read a file on a host (UTF-8, over SFTP). Fails on files larger than ' +
        'maxBytes (default 256 KB) — read big files piecewise with run_command.',
      inputSchema: {
        host: HOST_PARAM,
        path: z.string().describe("Absolute path, or '~/…' for the login home"),
        maxBytes: z.number().optional().describe('Size cap in bytes (default 262144)'),
      },
    },
    async ({ host, path, maxBytes }) => {
      try {
        return ok(await executor.readFile(host, path, maxBytes ?? READ_MAX_BYTES));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'write_file',
    {
      description:
        'Create or overwrite a file on a host with UTF-8 content (over SFTP). ' +
        'For edits, read_file first and write the full new content.',
      inputSchema: {
        host: HOST_PARAM,
        path: z.string().describe("Absolute path, or '~/…' for the login home"),
        content: z.string(),
      },
    },
    async ({ host, path, content }) => {
      try {
        await executor.writeFile(host, path, content);
        return ok(`Wrote ${Buffer.byteLength(content, 'utf8')} bytes to ${path}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'edit_file',
    {
      description:
        'Replace an exact string in a file on a host. old_string must match the ' +
        'file content exactly (whitespace included) and exactly once — expand it ' +
        'with surrounding context if ambiguous, or set replace_all. For full ' +
        'rewrites or new files use write_file.',
      inputSchema: {
        host: HOST_PARAM,
        path: z.string().describe("Absolute path, or '~/…' for the login home"),
        old_string: z.string().describe('Exact text to replace'),
        new_string: z.string().describe('Replacement text'),
        replace_all: z.boolean().optional().describe('Replace every occurrence'),
      },
    },
    async ({ host, path, old_string, new_string, replace_all }) => {
      try {
        const r = await executor.editFile(host, path, old_string, new_string, replace_all);
        return ok(
          `Replaced ${r.count} occurrence${r.count === 1 ? '' : 's'} in ${path} (${r.bytes} bytes)`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'host_vitals',
    {
      description:
        'CPU / memory / load / disk / network snapshot of a host with usage rates. ' +
        'Takes about 1 second (two samples for rates) — prefer this over ad-hoc ' +
        'top/free/df, but do not poll it in a tight loop.',
      inputSchema: { host: HOST_PARAM },
    },
    async ({ host }) => {
      try {
        return ok(JSON.stringify(await executor.hostVitals(host), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'service_ps',
    {
      description:
        'Tasks of a Docker Swarm service (docker service ps): current and ' +
        'historical replicas with state, node, and error messages of failed ' +
        'tasks. Run on a swarm manager host.',
      inputSchema: { host: HOST_PARAM, service: z.string().describe('Service name or id') },
    },
    async ({ host, service }) => {
      try {
        return ok(JSON.stringify(await executor.serviceTasks(host, service), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'service_logs',
    {
      description:
        'Logs of a Swarm service or a single task, with real stdout/stderr ' +
        'attribution. One-shot: to follow, re-call with since set to the lastTs ' +
        'from the previous result (since is inclusive — skip lines you already saw).',
      inputSchema: {
        host: HOST_PARAM,
        target: z.string().describe('Service name, or a task id from service_ps'),
        tail: z.number().optional().describe('Last N lines (default 200); ignored with since'),
        since: z.string().optional().describe('RFC3339 cursor from a previous call'),
      },
    },
    async ({ host, target, tail, since }) => {
      try {
        const chunk = await executor.taskLogs(host, target, { tail, since });
        if (chunk.lines.length === 0) return ok('(no log lines)');
        const text = chunk.lines
          .map((l) => `${l.ts} ${l.stream === 'err' ? '[err] ' : ''}${l.text}`)
          .join('\n');
        return ok(`${truncateOutput(text)}\nlastTs: ${chunk.lastTs}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_guests',
    {
      description:
        'VMs and LXC containers on a Proxmox node (vmid, name, type, status, ' +
        'cpu/mem), plus node resource totals. Fails on non-Proxmox hosts.',
      inputSchema: { host: HOST_PARAM },
    },
    async ({ host }) => {
      try {
        return ok(JSON.stringify(await executor.listGuests(host), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_terminals',
    {
      description:
        'Terminal tabs the user has open in the Pear UI: id, host, title, and ' +
        'which one is active. Use before read_terminal when targeting a ' +
        'specific terminal.',
      inputSchema: {},
    },
    async () => {
      try {
        return ok(JSON.stringify(await executor.listTerminals(), null, 2));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'read_terminal',
    {
      description:
        'Plain-text screen + scrollback of a terminal the user has open in ' +
        'Pear — use it to see what the user is looking at or what a command ' +
        'printed. Reads the active terminal unless a terminal id is given.',
      inputSchema: {
        terminal: z
          .string()
          .optional()
          .describe('Terminal id from list_terminals; omit for the active terminal'),
        lines: z.number().optional().describe('Last N lines (default 200)'),
      },
    },
    async ({ terminal, lines }) => {
      try {
        const text = await executor.readTerminal(terminal, lines);
        return ok(text === '' ? '(terminal is empty)' : truncateOutput(text));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'reveal_in_app',
    {
      description:
        'Show something to the user in the Pear UI. Opens a tab or drawer — ' +
        'never modifies anything. Use it to anchor an answer: open the file ' +
        'you found, the directory in question, or the logs of a failing service.',
      inputSchema: {
        action: z.enum(['open_dir', 'open_file', 'open_service_logs', 'focus_host']),
        host: HOST_PARAM,
        path: z.string().optional().describe('Required for open_dir / open_file'),
        service: z.string().optional().describe('Required for open_service_logs'),
        task_id: z.string().optional().describe('open_service_logs: preselect this task'),
      },
    },
    async ({ action, host, path, service, task_id }) => {
      try {
        const hostId = executor.resolve(host).id;
        if (action === 'open_dir' || action === 'open_file') {
          if (!path) throw new Error(`'path' is required for ${action}`);
          await executor.reveal({ type: action, hostId, path });
        } else if (action === 'open_service_logs') {
          if (!service) throw new Error(`'service' is required for open_service_logs`);
          await executor.reveal({
            type: action,
            hostId,
            service,
            ...(task_id ? { taskId: task_id } : {}),
          });
        } else {
          await executor.reveal({ type: 'focus_host', hostId });
        }
        return ok('Shown in the app.');
      } catch (err) {
        return fail(err);
      }
    },
  );

  const jobLine = (j: {
    id: string;
    status: string;
    stage: number;
    stages: number;
    bytesDone: number;
    bytesTotal: number;
    currentName: string | null;
    label: string;
    error?: string;
  }): string =>
    `${j.id}  ${j.status}` +
    (j.stages === 2 ? `  stage ${j.stage + 1}/2 (${j.stage === 0 ? 'download' : 'upload'})` : '') +
    `  ${j.bytesDone}/${j.bytesTotal} bytes` +
    (j.currentName ? `  current: ${j.currentName}` : '') +
    `  ${j.label}` +
    (j.error ? `\n  error: ${j.error}` : '');

  server.registerTool(
    'transfer_between_hosts',
    {
      description:
        'Copy or move files/directories between two hosts through Pear. ' +
        "Cross-host jobs relay in 2 stages through the user's machine " +
        "(download, then upload). Use host 'local' for the user's own machine. " +
        'Asynchronous: returns a job id immediately — poll transfer_status; ' +
        'the user also sees live progress in the Transfers panel. Do not ' +
        're-start a job just because it is slow.',
      inputSchema: {
        src_host: HOST_PARAM.describe("Source host, or 'local' for the user's machine"),
        src_dir: z.string().describe('Directory on the source containing the entries'),
        names: z.array(z.string()).describe('Entry names (files or directories) inside src_dir'),
        dest_host: HOST_PARAM.describe("Destination host, or 'local'"),
        dest_dir: z.string().describe('Destination directory'),
        move: z.boolean().optional().describe('Move instead of copy (removes the source)'),
        conflict: z
          .enum(['rename', 'overwrite', 'skip'])
          .optional()
          .describe('On name collision (default rename)'),
        verify: z.boolean().optional().describe('SHA-256 verify each file after copy'),
      },
    },
    async ({ src_host, src_dir, names, dest_host, dest_dir, move, conflict, verify }) => {
      try {
        const snap = executor.startTransfer(src_host, src_dir, names, dest_host, dest_dir, {
          move,
          conflict,
          verify,
        });
        return ok(`Transfer started:\n${jobLine(snap)}\nPoll transfer_status with this job id.`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'transfer_status',
    {
      description:
        'Status of Pear transfer jobs: state, stage, bytes done/total, current ' +
        'file, error. Without job_id lists all jobs not yet cleared by the user.',
      inputSchema: {
        job_id: z.string().optional().describe('A job id from transfer_between_hosts'),
      },
    },
    async ({ job_id }) => {
      try {
        const jobs = executor.transferStatus(job_id);
        return ok(jobs.length === 0 ? '(no transfer jobs)' : jobs.map(jobLine).join('\n'));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'port_forward',
    {
      description:
        "Forward a local port on the user's machine to a port on (or reachable " +
        'from) a host, over SSH. Returns the local address to use (e.g. for ' +
        'curl or a browser). The tunnel persists across turns until closed ' +
        'with close_port_forward or the host disconnects — close what you ' +
        'opened when done. Not available for sub-hosts or the local host.',
      inputSchema: {
        host: HOST_PARAM,
        remote_port: z.number().describe('Port to reach'),
        remote_host: z
          .string()
          .optional()
          .describe('Destination as seen from the host (default 127.0.0.1)'),
        local_port: z.number().optional().describe('Local port to bind (default: any free port)'),
      },
    },
    async ({ host, remote_port, remote_host, local_port }) => {
      try {
        const f = await executor.portForward(host, remote_port, remote_host, local_port);
        return ok(
          `Forwarding 127.0.0.1:${f.localPort} → ${f.hostName}:${f.remoteHost}:${f.remotePort} ` +
            `(id ${f.id}). Stays open until closed or the host disconnects.`,
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_port_forwards',
    {
      description: 'Open SSH port forwards created via port_forward.',
      inputSchema: {},
    },
    async () => {
      try {
        const list = executor.listForwards();
        return ok(
          list.length === 0
            ? '(no open forwards)'
            : list
                .map(
                  (f) =>
                    `${f.id}  127.0.0.1:${f.localPort} → ${f.hostName}:${f.remoteHost}:${f.remotePort}`,
                )
                .join('\n'),
        );
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'close_port_forward',
    {
      description: 'Close a port forward opened with port_forward.',
      inputSchema: { id: z.string().describe('Forward id from port_forward / list_port_forwards') },
    },
    async ({ id }) => {
      try {
        executor.closeForward(id);
        return ok(`Closed forward ${id}`);
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'list_dir',
    {
      description: 'List a directory on a host (over SFTP).',
      inputSchema: {
        host: HOST_PARAM,
        path: z.string().describe("Absolute path, or '~' for the login home"),
      },
    },
    async ({ host, path }) => {
      try {
        const { path: resolved, entries } = await executor.listDir(host, path);
        const lines = entries.map(
          (e) =>
            `${e.mode}  ${String(e.size).padStart(10)}  ${new Date(e.mtimeMs)
              .toISOString()
              .slice(0, 16)
              .replace('T', ' ')}  ${e.name}${e.kind === 'dir' ? '/' : e.kind === 'link' ? '@' : ''}`,
        );
        return ok(`${resolved}\n${truncateOutput(lines.join('\n'))}`);
      } catch (err) {
        return fail(err);
      }
    },
  );
}
