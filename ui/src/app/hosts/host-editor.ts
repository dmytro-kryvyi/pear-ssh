import { Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  autoShort,
  uuid,
  type AuthMethod,
  type HostColor,
  type HostConfig,
  type HostEndpoint,
  type HostKind,
} from '@pear/core';
import { Pear } from '../pear';
import { HOST_COLORS, HostCatalog } from '../hosts';
import { HostGroups } from './groups';
import { Settings } from '../settings';
import { PearChips, PearSeg, PearSwatches } from './forms';
import { PearIcon } from '../icons/icon';

export type HostEditorSection = 'connection' | 'identity' | 'advanced' | 'workspaces';

interface ProbeState {
  state: 'pending' | 'ok' | 'fail';
  ms?: number;
  detail?: string;
}

interface EndpointDraft {
  id: string;
  label: string;
  addr: string;
  port: string;
  note: string;
}

const SECTIONS: { id: HostEditorSection; label: string; icon: string }[] = [
  { id: 'connection', label: 'Connection', icon: 'network' },
  { id: 'identity', label: 'Identity', icon: 'pencil' },
  { id: 'advanced', label: 'Advanced', icon: 'settings' },
  { id: 'workspaces', label: 'Workspaces', icon: 'layers' },
];

/**
 * Full host editor: connection profile (ordered endpoint failover list with
 * live probes, auth), identity (naming, aliases, tags, color), advanced
 * session options (cwd, env, startup) and workspace membership.
 */
@Component({
  selector: 'pear-host-editor',
  imports: [FormsModule, PearIcon, PearChips, PearSeg, PearSwatches],
  templateUrl: './host-editor.html',
  styleUrl: './host-editor.scss',
})
export class HostEditor {
  private readonly pear = inject(Pear);
  private readonly settings = inject(Settings);
  readonly catalog = inject(HostCatalog);
  readonly groups = inject(HostGroups);

  /** null = create a new host. */
  readonly host = input.required<HostConfig | null>();

  readonly closed = output<void>();
  readonly saved = output<HostConfig>();
  readonly removed = output<string>();
  readonly connect = output<string>();

  readonly sections = SECTIONS;
  readonly section = signal<HostEditorSection>('connection');
  readonly probes = signal<Record<string, ProbeState>>({});
  readonly memberIds = signal<string[]>([]);
  readonly saving = signal(false);
  readonly error = signal<string | null>(null);

  // Draft form state (plain fields for ngModel, initialized in ngOnInit).
  name = '';
  short = '';
  user = 'root';
  aliases: string[] = [];
  tags: string[] = [];
  color: HostColor | null = null;
  notes = '';
  kindSel: 'auto' | HostKind = 'auto';
  cwd = '';
  env: { k: string; v: string }[] = [];
  startup: string[] = [];
  endpoints: EndpointDraft[] = [];
  method: AuthMethod | 'auto' = 'auto';
  keyPath = '';
  agentForward = false;
  passwordInput = '';
  passphraseInput = '';
  passwordCleared = false;
  passphraseCleared = false;

  ngOnInit(): void {
    const h = this.host();
    if (h) {
      this.name = h.name;
      this.short = h.short ?? '';
      this.user = h.user;
      this.aliases = [...(h.aliases ?? [])];
      this.tags = [...(h.tags ?? (h.tag ? [h.tag] : []))];
      this.color = h.color ?? null;
      this.notes = h.notes ?? '';
      this.kindSel = h.kindManual ? h.kind : 'auto';
      this.cwd = h.cwd ?? '';
      this.env = (h.env ?? []).map((e) => ({ ...e }));
      this.startup = [...(h.startup ?? [])];
      this.endpoints = (h.endpoints ?? [{ id: uuid(), addr: h.host, port: h.port }]).map((e) => ({
        id: e.id,
        label: e.label ?? '',
        addr: e.addr,
        port: String(e.port),
        note: e.note ?? '',
      }));
      this.method = h.auth?.method ?? 'auto';
      this.keyPath = h.auth?.privateKeyPath ?? '';
      this.agentForward = h.auth?.agentForward ?? false;
      this.memberIds.set(this.groups.groupsOf(h.id).map((g) => g.id));
    } else {
      this.endpoints = [this.blankEndpoint()];
      // A host created while a workspace is active joins it by default.
      const active = this.groups.byId(this.settings.activeGroup());
      if (active) this.memberIds.set([active.id]);
    }
  }

  readonly isNew = computed(() => this.host() === null);
  /** Local hosts and exec sub-hosts have no dialable SSH endpoint of their own. */
  readonly noEndpoints = computed(() => {
    const h = this.host();
    return Boolean(h && (h.local || h.parentId));
  });

  get existing(): HostConfig | null {
    return this.host();
  }

  hasPassword(): boolean {
    return !this.passwordCleared && Boolean(this.host()?.auth?.hasPassword);
  }
  hasPassphrase(): boolean {
    return !this.passphraseCleared && Boolean(this.host()?.auth?.hasPassphrase);
  }

  autoShortOf(): string {
    return autoShort(this.name);
  }

  subtitle(): string {
    const h = this.host();
    if (h?.local) return 'this computer — no SSH';
    if (h?.parentId) return 'sub-host — connects through its parent';
    const primary = this.endpoints[0];
    if (!primary?.addr) return '—';
    const port = primary.port && primary.port !== '22' ? `:${primary.port}` : '';
    return `${this.user}@${primary.addr}${port}`;
  }

  headerColor(): string {
    return this.color ? HOST_COLORS[this.color] : 'var(--accent)';
  }

  // ---- endpoints -----------------------------------------------------------

  private blankEndpoint(): EndpointDraft {
    return { id: uuid(), label: '', addr: '', port: '22', note: '' };
  }

  addEndpoint(): void {
    this.endpoints = [...this.endpoints, this.blankEndpoint()];
  }

  removeEndpoint(id: string): void {
    this.endpoints = this.endpoints.filter((e) => e.id !== id);
  }

  moveEndpoint(index: number, delta: number): void {
    const next = [...this.endpoints];
    const j = index + delta;
    if (j < 0 || j >= next.length) return;
    [next[index], next[j]] = [next[j], next[index]];
    this.endpoints = next;
  }

  sanitizePort(ep: EndpointDraft): void {
    ep.port = ep.port.replace(/\D/g, '');
  }

  async probe(ep: EndpointDraft): Promise<void> {
    if (!ep.addr.trim()) return;
    this.probes.update((p) => ({ ...p, [ep.id]: { state: 'pending' } }));
    const result = await this.pear.api.hosts.probe({
      addr: ep.addr.trim(),
      port: Number(ep.port) || 22,
    });
    this.probes.update((p) => ({
      ...p,
      [ep.id]: result.ok
        ? { state: 'ok', ms: result.latencyMs }
        : { state: 'fail', detail: result.error },
    }));
  }

  testAll(): void {
    for (const ep of this.endpoints) void this.probe(ep);
  }

  probeLabel(ep: EndpointDraft): string {
    const p = this.probes()[ep.id];
    if (!p) return 'untested';
    if (p.state === 'pending') return '…';
    if (p.state === 'ok') return `${p.ms} ms`;
    return p.detail === 'timeout' ? 'timeout' : 'no route';
  }

  probeState(ep: EndpointDraft): string {
    return this.probes()[ep.id]?.state ?? 'idle';
  }

  reachableNote(): string | null {
    const first = this.endpoints.find((e) => this.probes()[e.id]?.state === 'ok');
    return first ? first.addr : null;
  }

  // ---- advanced ------------------------------------------------------------

  addEnv(): void {
    this.env = [...this.env, { k: '', v: '' }];
  }
  removeEnv(index: number): void {
    this.env = this.env.filter((_, i) => i !== index);
  }
  addStartup(): void {
    this.startup = [...this.startup, ''];
  }
  removeStartup(index: number): void {
    this.startup = this.startup.filter((_, i) => i !== index);
  }
  trackIndex(index: number): number {
    return index;
  }

  // ---- membership ----------------------------------------------------------

  toggleMember(groupId: string): void {
    this.memberIds.update((ids) =>
      ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId],
    );
  }

  // ---- save / remove / connect ---------------------------------------------

  private buildPayload(): Omit<HostConfig, 'id'> & { id?: string } {
    const h = this.host();
    const endpoints: HostEndpoint[] = this.endpoints
      .filter((e) => e.addr.trim())
      .map((e) => ({
        id: e.id,
        label: e.label.trim() || undefined,
        addr: e.addr.trim(),
        port: Number(e.port) || 22,
        note: e.note.trim() || undefined,
      }));
    const primary = endpoints[0];
    const manualKind = this.kindSel !== 'auto';

    const payload: Omit<HostConfig, 'id'> & { id?: string } = {
      ...(h ? { id: h.id, parentId: h.parentId, target: h.target, via: h.via, local: h.local } : {}),
      name: this.name.trim() || primary?.addr || 'new-host',
      host: primary?.addr ?? h?.host ?? 'localhost',
      port: primary?.port ?? h?.port ?? 22,
      user: this.user.trim() || 'root',
      kind: manualKind ? (this.kindSel as HostKind) : (h?.kind ?? 'plain'),
      kindManual: manualKind || undefined,
      tags: this.tags.length ? this.tags : undefined,
      aliases: this.aliases.length ? this.aliases : undefined,
      short: this.short.trim() || undefined,
      color: this.color ?? undefined,
      notes: this.notes.trim() || undefined,
      cwd: this.cwd.trim() || undefined,
      env: this.env.filter((e) => e.k.trim()).length
        ? this.env.filter((e) => e.k.trim())
        : undefined,
      startup: this.startup.filter((c) => c.trim()).length
        ? this.startup.map((c) => c.trim()).filter(Boolean)
        : undefined,
    };
    if (!this.noEndpoints()) {
      payload.endpoints = endpoints.length
        ? endpoints
        : [{ id: uuid(), addr: payload.host, port: payload.port }];
      payload.auth = {
        method: this.method === 'auto' ? undefined : this.method,
        agent: this.method === 'auto' ? h?.auth?.agent : undefined,
        agentForward: this.agentForward || undefined,
        privateKeyPath: this.keyPath.trim() || undefined,
        password: this.passwordCleared ? '' : this.passwordInput || undefined,
        passphrase: this.passphraseCleared ? '' : this.passphraseInput || undefined,
      };
    }
    return payload;
  }

  async save(openAfter = false): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set(null);
    try {
      const saved = await this.pear.api.hosts.upsert(this.buildPayload());
      const before = new Set(this.groups.groupsOf(saved.id).map((g) => g.id));
      const after = new Set(this.memberIds());
      for (const g of this.groups.groups()) {
        const want = after.has(g.id);
        if (want !== before.has(g.id)) {
          await this.groups.setMembership(saved.id, g.id, want);
        }
      }
      await this.catalog.refresh();
      this.saved.emit(saved);
      if (openAfter) this.connect.emit(saved.id);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.saving.set(false);
    }
  }

  remove(): void {
    const h = this.host();
    if (h) this.removed.emit(h.id);
  }
}
