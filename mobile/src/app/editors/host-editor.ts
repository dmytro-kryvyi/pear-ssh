import { Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { autoShort, type HostConfig, type HostEndpoint } from '@pear/core';
import { PEAR_BACKEND } from '../backend';
import { PmSeg, PmWsGlyph } from '../chrome/chrome';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';
import { wsColor } from '../util/fmt';
import { PmEditorShell, type EditorSection } from './editor-shell';
import { PmCheckRow, PmChips, PmColors } from './forms';

type ProbeUi = { state: 'pending' | 'ok' | 'fail'; ms?: number };

const SECTIONS: EditorSection[] = [
  { id: 'connection', label: 'Connection', icon: 'network' },
  { id: 'identity', label: 'Identity', icon: 'pencil' },
  { id: 'advanced', label: 'Advanced', icon: 'settings' },
  { id: 'spaces', label: 'Workspaces', icon: 'layers' },
];

/** Host editor — full-screen sheet on the phone, centered modal on tablet. */
@Component({
  selector: 'pm-host-editor',
  imports: [PmEditorShell, PmSeg, PmChips, PmColors, PmCheckRow, PmWsGlyph, PmIcon],
  templateUrl: './host-editor.html',
  styleUrl: './host-editor.scss',
})
export class PmHostEditor {
  readonly host = input.required<HostConfig>();
  readonly wide = input(false);
  readonly connectHost = output<HostConfig>();

  protected readonly session = inject(PearSession);
  private readonly backend = inject(PEAR_BACKEND);

  protected readonly sections = SECTIONS;
  protected readonly section = signal('connection');
  protected readonly draft = signal<HostConfig | null>(null);
  protected readonly probe = signal<Record<string, ProbeUi>>({});
  protected readonly memberIds = signal<string[]>([]);

  protected readonly d = computed(() => this.draft() ?? this.host());
  protected readonly isNew = computed(() => !this.host().name);
  protected readonly stripeColor = computed(() => wsColor(this.d().color));
  protected readonly autoLabel = computed(() => autoShort(this.d().name) || '—');

  constructor() {
    effect(() => {
      const h = this.host();
      this.draft.set(structuredClone(h));
      this.memberIds.set(this.session.groupsOf(h.id).map((w) => w.id));
      this.probe.set({});
      this.section.set('connection');
    });
  }

  protected set<K extends keyof HostConfig>(key: K, value: HostConfig[K]): void {
    this.draft.set({ ...this.d(), [key]: value });
  }
  protected setAuth(patch: Partial<NonNullable<HostConfig['auth']>>): void {
    this.set('auth', { ...(this.d().auth ?? {}), ...patch });
  }

  // ---- endpoints -----------------------------------------------------------

  protected setEp(id: string, patch: Partial<HostEndpoint>): void {
    this.set(
      'endpoints',
      (this.d().endpoints ?? []).map((e) => (e.id === id ? { ...e, ...patch } : e)),
    );
  }
  protected moveEp(i: number, delta: number): void {
    const list = [...(this.d().endpoints ?? [])];
    const j = i + delta;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    this.set('endpoints', list);
  }
  protected removeEp(id: string): void {
    this.set('endpoints', (this.d().endpoints ?? []).filter((e) => e.id !== id));
  }
  protected addEp(): void {
    this.set('endpoints', [
      ...(this.d().endpoints ?? []),
      { id: `e${Math.random().toString(36).slice(2, 8)}`, label: '', addr: '', port: 22 },
    ]);
  }

  protected async testEp(e: HostEndpoint): Promise<void> {
    if (!e.addr.trim()) {
      this.probe.update((p) => ({ ...p, [e.id]: { state: 'fail' } }));
      return;
    }
    this.probe.update((p) => ({ ...p, [e.id]: { state: 'pending' } }));
    const result = await this.backend.hosts.probe({ addr: e.addr, port: e.port });
    this.probe.update((p) => ({
      ...p,
      [e.id]: result.ok ? { state: 'ok', ms: result.latencyMs } : { state: 'fail' },
    }));
  }
  protected testAll(): void {
    for (const e of this.d().endpoints ?? []) void this.testEp(e);
  }
  protected probeText(id: string): string {
    const p = this.probe()[id];
    if (!p) return 'untested';
    if (p.state === 'pending') return 'testing…';
    if (p.state === 'ok') return `${p.ms} ms`;
    return 'no route';
  }

  // ---- membership / env / startup ------------------------------------------

  protected toggleMember(id: string): void {
    this.memberIds.update((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
  }
  protected setEnv(i: number, key: 'k' | 'v', value: string): void {
    this.set('env', (this.d().env ?? []).map((e, j) => (j === i ? { ...e, [key]: value } : e)));
  }
  protected removeEnv(i: number): void {
    this.set('env', (this.d().env ?? []).filter((_, j) => j !== i));
  }
  protected addEnv(): void {
    this.set('env', [...(this.d().env ?? []), { k: '', v: '' }]);
  }
  protected setStartup(i: number, value: string): void {
    this.set('startup', (this.d().startup ?? []).map((c, j) => (j === i ? value : c)));
  }
  protected removeStartup(i: number): void {
    this.set('startup', (this.d().startup ?? []).filter((_, j) => j !== i));
  }
  protected addStartup(): void {
    this.set('startup', [...(this.d().startup ?? []), '']);
  }

  // ---- lifecycle -----------------------------------------------------------

  protected close(): void {
    this.session.editHost.set(null);
  }

  protected async save(): Promise<void> {
    const d = this.d();
    const eps = (d.endpoints ?? []).filter((e) => e.addr.trim());
    const next: HostConfig = {
      ...d,
      name: d.name.trim() || 'new-host',
      endpoints: eps.length
        ? eps
        : [{ id: `e${Math.random().toString(36).slice(2, 8)}`, label: 'Primary', addr: 'localhost', port: 22 }],
      env: (d.env ?? []).filter((e) => e.k.trim()),
      startup: (d.startup ?? []).filter((c) => c.trim()),
    };
    await this.session.saveHost(next, this.memberIds());
  }

  protected async remove(): Promise<void> {
    await this.session.deleteHost(this.d().id);
  }

  protected connect(): void {
    const saved = this.session.hosts().find((h) => h.id === this.d().id);
    if (saved) {
      this.close();
      this.connectHost.emit(saved);
    }
  }
}
