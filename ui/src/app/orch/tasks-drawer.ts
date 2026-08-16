import {
  Component,
  DestroyRef,
  type ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { SwarmServiceInfo, SwarmTaskInfo, TaskLogLine } from '@pear/core';
import { Pear } from '../pear';
import { PearIcon } from '../icons/icon';
import { HostCatalog } from '../hosts';
import { HostActions } from '../host-actions';
import { OrchStore, type TasksDrawerCtx, type TasksState } from './store';

const FAILED = new Set(['failed', 'rejected', 'orphaned']);
const PENDING = new Set([
  'new',
  'allocated',
  'pending',
  'assigned',
  'accepted',
  'preparing',
  'ready',
  'starting',
]);

export type TaskFilter = 'all' | 'running' | 'failed' | 'pending';
const FILTERS: TaskFilter[] = ['all', 'running', 'failed', 'pending'];

export function taskTone(t: SwarmTaskInfo): 'ok' | 'warn' | 'err' | 'off' {
  if (t.state === 'running') return 'ok';
  if (FAILED.has(t.state)) return 'err';
  if (PENDING.has(t.state)) return 'warn';
  return 'off';
}

/** Plain-language read of a task's error column, for the log-pane callout. */
export function diagnose(error: string): { title: string; hint: string } | null {
  if (!error) return null;
  if (/non-zero exit \(137\)/.test(error)) {
    return {
      title: 'Killed at the memory limit (exit 137)',
      hint: 'The container hit its cgroup memory cap. Raise --limit-memory or find the leak.',
    };
  }
  if (/no suitable node/i.test(error)) {
    return {
      title: 'Never scheduled — no node satisfies the constraints',
      hint: 'Placement constraints or resource reservations fit no node. Free capacity or lower --reserve-*.',
    };
  }
  if (/no such image/i.test(error)) {
    return {
      title: 'Image missing on the assigned node',
      hint: 'The tag was not pushed to the registry, or the node cannot authenticate to pull it.',
    };
  }
  if (/context deadline exceeded/i.test(error)) {
    return {
      title: 'Node stopped responding while starting the task',
      hint: 'The node is down or overloaded. Drain it so Swarm stops placing tasks there.',
    };
  }
  if (/non-zero exit \(1\)/.test(error)) {
    return {
      title: 'Process exited with code 1 at startup',
      hint: 'Usually a config error in the container — see the last stderr lines below.',
    };
  }
  return { title: error, hint: 'See the task log below for the last output before exit.' };
}

const LOG_TAIL = 200;
const FOLLOW_MS = 2000;
const MAX_LINES = 2000;

/**
 * The `docker service ps` → `docker service logs` loop as a right-side
 * overlay drawer: task table on top, selected task's log underneath.
 * Rendered from app.html; open state lives in OrchStore.drawer.
 */
@Component({
  selector: 'pear-tasks-drawer',
  imports: [PearIcon],
  templateUrl: './tasks-drawer.html',
  styleUrl: './tasks-drawer.scss',
})
export class TasksDrawer {
  readonly ctx = input.required<TasksDrawerCtx>();
  readonly closed = output<void>();

  private readonly pear = inject(Pear);
  private readonly store = inject(OrchStore);
  private readonly actions = inject(HostActions);
  private readonly catalog = inject(HostCatalog);

  readonly filters = FILTERS;
  readonly taskTone = taskTone;
  readonly diagnose = diagnose;

  // ---- task table ------------------------------------------------------
  readonly hostName = computed(() => this.catalog.nameOf(this.ctx().hostId));
  /** Live service info — stays current across refreshes, null if it vanished. */
  readonly service = computed<SwarmServiceInfo | null>(() => {
    const { hostId, serviceName } = this.ctx();
    const services = this.store.states()[hostId]?.data?.swarm?.services ?? [];
    return services.find((s) => s.name === serviceName) ?? null;
  });
  private readonly key = computed(() => `${this.ctx().hostId}/${this.ctx().serviceName}`);
  readonly tasksState = computed<TasksState | null>(() => this.store.tasks()[this.key()] ?? null);
  readonly tasks = computed(() => this.tasksState()?.tasks ?? []);

  readonly filter = signal<TaskFilter>('all');
  matches(t: SwarmTaskInfo, f: TaskFilter): boolean {
    if (f === 'running') return t.state === 'running';
    if (f === 'failed') return FAILED.has(t.state);
    if (f === 'pending') return taskTone(t) === 'warn';
    return true;
  }
  count(f: TaskFilter): number {
    return this.tasks().filter((t) => this.matches(t, f)).length;
  }
  readonly shown = computed(() => this.tasks().filter((t) => this.matches(t, this.filter())));

  readonly selectedId = signal<string | null>(null);
  readonly selected = computed<SwarmTaskInfo | null>(() => {
    const list = this.shown();
    return list.find((t) => t.id === this.selectedId()) ?? list[0] ?? null;
  });

  readonly missing = computed(() => {
    const s = this.service();
    return !s || s.mode === 'global' ? 0 : Math.max(0, s.desired - s.running);
  });
  readonly failedCount = computed(() => this.tasks().filter((t) => FAILED.has(t.state)).length);

  readonly busy = signal(false);
  readonly copied = signal<string | null>(null);

  taskLabel(t: SwarmTaskInfo): string {
    const s = this.service();
    return s?.mode === 'global' ? `${this.ctx().serviceName} · ${t.node}` : t.name;
  }

  readonly psCmd = computed(() => `docker service ps --no-trunc ${this.ctx().serviceName}`);
  readonly logsCmd = computed(() => {
    const t = this.selected();
    return t ? `docker service logs --raw -t --no-trunc --tail ${LOG_TAIL} ${t.id}` : '';
  });

  // ---- log pane --------------------------------------------------------
  readonly logLines = signal<TaskLogLine[]>([]);
  readonly logError = signal<string | null>(null);
  readonly logLoading = signal(false);
  readonly follow = signal(false);
  readonly stderrOnly = signal(false);
  readonly grep = signal('');
  private lastTs: string | null = null;
  private loadedId: string | null = null;
  private inflight = false;

  readonly visibleLines = computed(() => {
    const q = this.grep().toLowerCase();
    return this.logLines().filter(
      (l) => (!this.stderrOnly() || l.stream === 'err') && (!q || l.text.toLowerCase().includes(q)),
    );
  });

  private readonly logScroll = viewChild<ElementRef<HTMLElement>>('logScroll');

  constructor() {
    // Initial row: the task that opened the drawer, else the first troubled
    // one (failed or pending), else the first.
    effect(() => {
      const list = this.tasks();
      if (!list.length || untracked(this.selectedId)) return;
      const init = this.ctx().initialTaskId;
      const pick =
        (init && list.find((t) => t.id === init)) ||
        list.find((t) => taskTone(t) === 'err' || taskTone(t) === 'warn') ||
        list[0];
      this.selectedId.set(pick.id);
    });

    // (Re)load the log whenever the selected task actually changes.
    effect(() => {
      const id = this.selected()?.id ?? null;
      if (id === this.loadedId) return;
      this.loadedId = id;
      untracked(() => {
        this.logLines.set([]);
        this.logError.set(null);
        this.follow.set(false);
        this.stderrOnly.set(false);
        this.grep.set('');
        this.lastTs = null;
        if (id) void this.loadLogs(id);
      });
    });

    // Follow: poll with --since from the last seen timestamp.
    effect((onCleanup) => {
      const id = this.selected()?.id;
      if (!this.follow() || !id) return;
      const timer = setInterval(() => void this.poll(id), FOLLOW_MS);
      onCleanup(() => clearInterval(timer));
    });

    // Keep the log pinned to the bottom while following.
    effect(() => {
      this.visibleLines();
      if (!this.follow()) return;
      const el = this.logScroll()?.nativeElement;
      if (el) queueMicrotask(() => (el.scrollTop = el.scrollHeight));
    });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.closed.emit();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      if (e.target instanceof HTMLInputElement) return;
      e.preventDefault();
      const list = this.shown();
      const i = list.findIndex((t) => t.id === this.selected()?.id);
      const next = list[Math.min(list.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      if (next) this.selectedId.set(next.id);
    };
    window.addEventListener('keydown', onKey);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('keydown', onKey));
  }

  private async loadLogs(taskId: string): Promise<void> {
    this.logLoading.set(true);
    try {
      const chunk = await this.pear.api.orch.taskLogs(this.ctx().hostId, taskId, {
        tail: LOG_TAIL,
      });
      if (this.loadedId !== taskId) return; // selection moved on meanwhile
      this.logLines.set(chunk.lines);
      this.lastTs = chunk.lastTs;
    } catch (err) {
      if (this.loadedId === taskId) this.logError.set(friendlyLogError(err));
    } finally {
      if (this.loadedId === taskId) this.logLoading.set(false);
    }
  }

  private async poll(taskId: string): Promise<void> {
    if (this.inflight || document.hidden || this.loadedId !== taskId) return;
    this.inflight = true;
    try {
      const since = this.lastTs;
      const chunk = await this.pear.api.orch.taskLogs(
        this.ctx().hostId,
        taskId,
        since ? { since } : { tail: LOG_TAIL },
      );
      if (this.loadedId !== taskId) return;
      // --since is inclusive: drop everything at or before the cursor that we
      // already have (key match covers same-timestamp neighbours).
      const lastMs = since ? Date.parse(since) : -1;
      const key = (l: TaskLogLine) => `${l.ts} ${l.stream} ${l.text}`;
      const edge = new Set(
        this.logLines()
          .filter((l) => Date.parse(l.ts) === lastMs)
          .map(key),
      );
      const fresh = chunk.lines.filter((l) => {
        const ms = Date.parse(l.ts);
        return ms > lastMs || (ms === lastMs && !edge.has(key(l)));
      });
      if (fresh.length) {
        this.logLines.update((lines) => [...lines, ...fresh].slice(-MAX_LINES));
        this.lastTs = chunk.lastTs ?? this.lastTs;
      }
    } catch {
      // Transient follow errors (reconnects) are silent; the next tick retries.
    } finally {
      this.inflight = false;
    }
  }

  // ---- actions ---------------------------------------------------------
  copy(what: string, text: string): void {
    void navigator.clipboard?.writeText(text).catch(() => {});
    this.copied.set(what);
    setTimeout(() => this.copied() === what && this.copied.set(null), 1200);
  }

  runInTerminal(command: string, title: string): void {
    this.actions.orchCommand(this.ctx().hostId, { command, title });
  }

  /** Stream this task's log live in a real terminal tab. */
  followInTerminal(): void {
    const t = this.selected();
    if (t) this.runInTerminal(`docker service logs -f --tail ${LOG_TAIL} ${t.id}`, this.taskLabel(t));
  }

  async restart(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.store.action(this.ctx().hostId, {
        type: 'service',
        name: this.ctx().serviceName,
        op: 'restart',
      });
      await this.store.fetchTasks(this.ctx().hostId, this.ctx().serviceName);
    } finally {
      this.busy.set(false);
    }
  }

  refreshTasks(): void {
    void this.store.fetchTasks(this.ctx().hostId, this.ctx().serviceName);
  }

  clock(ts: string): string {
    return ts.slice(11, 19) || ts;
  }

  shortId(id: string): string {
    return id.slice(0, 12);
  }
}

function friendlyLogError(err: unknown): string {
  const msg = (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
  if (/no such task|not found|not yet|no logs/i.test(msg)) {
    return 'No logs yet — the task has not produced any output.';
  }
  return msg;
}
