import { Injectable, signal } from '@angular/core';
import type { ClaudeStore } from './claude-store';

// Scripted M1 demo of the Claude chat (design src-mobile/claude.jsx). The
// block/view models intentionally mirror what core's ClaudeChatEvent stream
// coalesces into, so M4 swaps the data source, not the UI.

export type ClaudeMsg =
  | { id: string; role: 'user' | 'assistant'; text: string }
  | { id: string; role: 'think'; secs: number; text: string }
  | { id: string; role: 'tool'; cmd: string; status: 'running' | 'done' | 'error'; ms?: number; out?: string }
  | { id: string; role: 'permission'; status: 'pending' | 'once' | 'always' | 'denied'; cmd: string; why: string }
  | { id: string; role: 'question'; prompt: string; options: string[]; answer: number | null }
  | { id: string; role: 'report'; title: string; tone: 'plan' | 'warn' | 'ok'; lines: { k: 'cause' | 'step' | 'ok' | 'warn'; t: string }[] }
  | { id: string; role: 'divider'; text: string };

export interface ClaudeDemoSession {
  id: string;
  title: string;
  when: string;
  turns: number;
  tokens: number;
  seed: () => ClaudeMsg[];
}

export const CTX_MAX = 200_000;

/** Omit that distributes over a union instead of collapsing it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

let seq = 2000;
const mid = () => `cm${++seq}`;

const seedMain = (): ClaudeMsg[] => [
  { id: mid(), role: 'user', text: 'api.pear.sh started returning 502s right after the last deploy. Can you find out why and fix it?' },
  { id: mid(), role: 'think', secs: 4, text: 'The vhost proxies to 127.0.0.1:8080. A 502 usually means the upstream is down. Let me check the site config, then whether the gateway container is actually running.' },
  { id: mid(), role: 'assistant', text: "I'll inspect the vhost and the gateway it proxies to." },
  { id: mid(), role: 'tool', cmd: 'cat /etc/nginx/sites-available/api.pear.sh', status: 'done', ms: 120, out: 'location / {\n    proxy_pass http://127.0.0.1:8080;\n    ...\n}' },
  { id: mid(), role: 'tool', cmd: 'docker ps -a --filter name=api-gateway', status: 'done', ms: 240, out: 'api-gateway   Exited (1) 27 hours ago' },
  { id: mid(), role: 'assistant', text: 'Found it. **`api-gateway` exited 27h ago**, so nginx has nothing on :8080 — hence the 502. The `2.4.2` rollout crash-looped and gave up.' },
  { id: mid(), role: 'report', title: 'Diagnosis & plan', tone: 'plan', lines: [
    { k: 'cause', t: 'Upstream api-gateway container is stopped (exit 1)' },
    { k: 'step', t: 'Restart the gateway on a known-good tag' },
    { k: 'step', t: 'Validate nginx config, then reload' },
    { k: 'step', t: 'Confirm /healthz returns 200' },
  ] },
  { id: mid(), role: 'question', prompt: 'Which image tag should I restart the gateway on?', options: ['2.4.1 — last known good', '2.4.2 — current (crashed)', 'Pin to digest sha256:9f2c…'], answer: 0 },
  { id: mid(), role: 'assistant', text: "Good call, rolling back to `2.4.1`. I'd like to start the container now." },
  { id: mid(), role: 'permission', status: 'pending', cmd: 'docker start api-gateway', why: 'Starts the rolled-back gateway so nginx has an upstream again.' },
];

export const DEMO_SESSIONS: ClaudeDemoSession[] = [
  { id: 's1', title: 'Fix api.pear.sh 502s', when: 'now', turns: 11, tokens: 38_200, seed: seedMain },
  {
    id: 's2', title: 'TLS cert expiry audit', when: '2h ago', turns: 4, tokens: 9_400,
    seed: () => [
      { id: mid(), role: 'user', text: 'Are any TLS certs on edge-01 expiring soon?' },
      { id: mid(), role: 'tool', cmd: 'certbot certificates', status: 'done', ms: 320, out: 'api.pear.sh   VALID: 71 days\napp.pear.sh   VALID: 8 days' },
      { id: mid(), role: 'report', title: 'Certificate audit', tone: 'warn', lines: [
        { k: 'ok', t: 'api.pear.sh — valid for 71 days' },
        { k: 'warn', t: 'app.pear.sh — expires in 8 days, renew soon' },
      ] },
      { id: mid(), role: 'assistant', text: 'One cert needs attention. Want me to renew `app.pear.sh` now?' },
    ],
  },
  {
    id: 's3', title: 'Prune dangling images', when: 'yesterday', turns: 6, tokens: 15_100,
    seed: () => [
      { id: mid(), role: 'user', text: 'Free up disk on edge-02.' },
      { id: mid(), role: 'assistant', text: 'Reclaimed 3.1 GB by pruning dangling images and stopped containers.' },
    ],
  },
];

@Injectable({ providedIn: 'root' })
export class ClaudeDemo implements ClaudeStore {
  readonly sessions = signal(
    DEMO_SESSIONS.map(({ id, title, when, turns, tokens }) => ({ id, title, when, turns, tokens })),
  );
  readonly sessionId = signal('s1');
  readonly messages = signal<ClaudeMsg[]>(seedMain());
  readonly tokens = signal(38_200);
  readonly busy = signal(false);
  readonly autoApprove = signal(false);

  private push(...items: DistributiveOmit<ClaudeMsg, 'id'>[]): void {
    this.messages.update((prev) => [...prev, ...items.map((x) => ({ id: mid(), ...x }) as ClaudeMsg)]);
  }

  load(sessionId: string): void {
    const s = DEMO_SESSIONS.find((x) => x.id === sessionId);
    if (!s) return;
    this.sessionId.set(s.id);
    this.messages.set(s.seed());
    this.tokens.set(s.tokens);
  }

  refreshSessions(): void {
    // static demo data
  }

  toggleAutoApprove(): void {
    this.autoApprove.update((on) => !on);
  }

  newSession(): void {
    this.sessionId.set(`new-${mid()}`);
    this.messages.set([]);
    this.tokens.set(1_200);
  }

  compact(): void {
    this.messages.update((prev) => [
      { id: mid(), role: 'divider', text: 'context compacted · freed 21.4k' },
      ...prev.slice(-4),
    ]);
    this.tokens.update((t) => Math.round(t * 0.42));
  }

  answerQuestion(id: string, choice: number): void {
    this.messages.update((prev) =>
      prev.map((m) => (m.id === id && m.role === 'question' ? { ...m, answer: choice } : m)),
    );
  }

  resolvePermission(id: string, decision: 'once' | 'always' | 'denied'): void {
    if (decision === 'always') this.autoApprove.set(true);
    this.messages.update((prev) =>
      prev.map((m) => (m.id === id && m.role === 'permission' ? { ...m, status: decision } : m)),
    );
    if (decision === 'denied') {
      setTimeout(
        () => this.push({ role: 'assistant', text: "Understood — I won't run it. Let me know how you'd like to proceed." }),
        350,
      );
      return;
    }
    this.busy.set(true);
    const runningId = mid();
    this.messages.update((prev) => [
      ...prev,
      { id: runningId, role: 'tool', cmd: 'docker start api-gateway', status: 'running' },
    ]);
    setTimeout(() => {
      this.messages.update((prev) =>
        prev.map((m) =>
          m.id === runningId && m.role === 'tool'
            ? { ...m, status: 'done' as const, ms: 640, out: 'api-gateway' }
            : m,
        ),
      );
      this.tokens.update((t) => t + 900);
      setTimeout(() => {
        this.push(
          { role: 'tool', cmd: 'nginx -t', status: 'done', ms: 90, out: 'nginx: configuration file /etc/nginx/nginx.conf test is successful' },
          { role: 'tool', cmd: 'curl -s -o /dev/null -w "%{http_code}" https://api.pear.sh/healthz', status: 'done', ms: 210, out: '200' },
          { role: 'report', title: 'Resolved', tone: 'ok', lines: [
            { k: 'ok', t: 'api-gateway running on **2.4.1** (upstream restored)' },
            { k: 'ok', t: 'nginx config valid — no reload needed' },
            { k: 'ok', t: '/healthz returns **200**, 502s cleared' },
          ] },
          { role: 'assistant', text: 'All green. I left the gateway pinned to `2.4.1`. Want me to open a ticket on why `2.4.2` crash-looped?' },
        );
        this.busy.set(false);
      }, 620);
    }, 900);
  }

  send(text: string): void {
    if (!text || this.busy()) return;
    if (text === '/clear') {
      this.newSession();
      return;
    }
    if (text === '/compact') {
      this.compact();
      return;
    }
    this.push({ role: 'user', text });
    this.tokens.update((t) => t + 700);
    this.busy.set(true);
    setTimeout(() => {
      this.push({ role: 'think', secs: 3, text: 'Interpreting the request against the current host state and recent actions before responding.' });
      setTimeout(() => {
        this.push({ role: 'assistant', text: "Here's what I found — happy to take the next step whenever you're ready." });
        this.tokens.update((t) => t + 1_100);
        this.busy.set(false);
      }, 700);
    }, 500);
  }
}
