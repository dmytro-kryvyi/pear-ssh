import type {
  ContainerInfo,
  FileEntry,
  HostConfig,
  HostGroup,
  HostStatus,
  Orchestration,
  ProxmoxGuestInfo,
  SwarmNodeInfo,
  SwarmServiceInfo,
} from '@pear/core';
import { pseudoCpu, pseudoMemFrac } from '../util/fmt';

// In-memory world for the M1 mock backend — the design's demo data
// (design src/data.jsx) mapped onto real core types so screens are written
// against exactly what the native backend will return in M3.

const GB = 1024 ** 3;

let epSeq = 0;
const ep = (label: string, addr: string, port = 22, note = '') => ({
  id: `e${++epSeq}`,
  label,
  addr,
  port,
  note,
});

export const SEED_HOSTS: HostConfig[] = [
  {
    id: 'h1', name: 'edge-01', host: 'edge-01.prod.internal', port: 22, user: 'deploy',
    kind: 'swarm', color: 'red', aliases: ['e1', 'edge'], tags: ['prod', 'edge', 'swarm-mgr'],
    cwd: '/srv/edge', auth: { method: 'key', privateKeyPath: '~/.ssh/id_ed25519', agent: true },
    endpoints: [
      ep('Internal DNS', 'edge-01.prod.internal'),
      ep('Private IP', '10.0.2.11'),
      ep('Public (fallback)', '203.0.113.21', 2222, 'rate-limited'),
    ],
    env: [
      { k: 'DOCKER_HOST', v: 'unix:///var/run/docker.sock' },
      { k: 'COMPOSE_PROJECT_NAME', v: 'edge' },
    ],
    startup: ['tmux attach -t ops || tmux new -s ops'],
    notes: 'Swarm leader. Drain before reboots — see runbook RB-14.',
  },
  {
    id: 'h2', name: 'edge-02', host: 'edge-02.prod.internal', port: 22, user: 'deploy',
    kind: 'docker', color: 'red', aliases: ['e2'], tags: ['prod', 'edge'], cwd: '/srv/edge',
    auth: { method: 'key', privateKeyPath: '~/.ssh/id_ed25519', agent: true },
    endpoints: [ep('Internal DNS', 'edge-02.prod.internal'), ep('Private IP', '10.0.2.12')],
  },
  {
    id: 'h3', name: 'db-primary', host: '10.0.4.12', port: 22, user: 'root',
    kind: 'docker', color: 'amber', aliases: ['db'], tags: ['prod', 'database'],
    cwd: '/var/lib/postgresql', auth: { method: 'key', privateKeyPath: '~/.ssh/id_db', agent: false },
    endpoints: [ep('Private IP', '10.0.4.12'), ep('Mgmt VLAN', '10.9.4.12')],
    env: [{ k: 'PGDATA', v: '/var/lib/postgresql/16/main' }],
    notes: 'Never restart pgbouncer during business hours.',
  },
  {
    id: 'h4', name: 'analytics', host: 'analytics.staging.local', port: 22, user: 'lewis',
    kind: 'docker', color: 'violet', aliases: ['ana'], tags: ['staging', 'analytics'], cwd: '/data',
    auth: { method: 'agent', agent: true },
    endpoints: [ep('Internal DNS', 'analytics.staging.local'), ep('Private IP', '10.0.7.31')],
  },
  {
    id: 'h5', name: 'ci-runner-3', host: '10.0.9.44', port: 2200, user: 'runner',
    kind: 'docker', color: 'teal', aliases: ['ci3'], tags: ['ci'], cwd: '/home/runner',
    auth: { method: 'key', privateKeyPath: '~/.ssh/id_ci', agent: false },
    endpoints: [ep('Private IP', '10.0.9.44', 2200)],
  },
  {
    id: 'h6', name: 'pve-01', host: '10.0.1.10', port: 22, user: 'root',
    kind: 'proxmox', color: 'blue', aliases: ['pve1'], tags: ['pve', 'homelab'], cwd: '/etc/pve',
    auth: { method: 'key', privateKeyPath: '~/.ssh/id_ed25519', agent: true },
    endpoints: [ep('Private IP', '10.0.1.10'), ep('Tailscale', '100.84.12.3')],
  },
  {
    id: 'h7', name: 'workshop-vps', host: 'workshop.fra.hcloud.tld', port: 22, user: 'lewis',
    kind: 'docker', color: 'green', aliases: ['ws', 'shop'], tags: ['pers'], cwd: '/opt/stacks',
    auth: { method: 'key', privateKeyPath: '~/.ssh/id_personal', agent: true },
    endpoints: [
      ep('Public DNS', 'workshop.fra.hcloud.tld'),
      ep('IPv6', '2a01:4f8:c17:2a::1'),
      ep('Tailscale', '100.99.4.7'),
    ],
    env: [{ k: 'TZ', v: 'Europe/Berlin' }],
    startup: ['cd /opt/stacks'],
  },
  {
    id: 'h8', name: 'pve-02', host: '10.0.1.11', port: 22, user: 'root',
    kind: 'proxmox', color: 'blue', aliases: ['pve2'], tags: ['pve', 'homelab'], cwd: '/etc/pve',
    auth: { method: 'key', privateKeyPath: '~/.ssh/id_ed25519', agent: true },
    endpoints: [ep('Private IP', '10.0.1.11')],
    notes: 'PSU replacement pending.',
  },
];

/** Presence, which is session state on desktop, is seeded per host here. */
export const HOST_META: Record<string, { status: HostStatus; lastSeen: string }> = {
  h1: { status: 'online', lastSeen: 'active now' },
  h2: { status: 'online', lastSeen: 'active now' },
  h3: { status: 'online', lastSeen: '3m ago' },
  h4: { status: 'online', lastSeen: '12m ago' },
  h5: { status: 'idle', lastSeen: '2h ago' },
  h6: { status: 'online', lastSeen: 'active now' },
  h7: { status: 'online', lastSeen: 'active now' },
  h8: { status: 'offline', lastSeen: '2d ago' },
};

export const SEED_GROUPS: HostGroup[] = [
  { id: 'w1', name: 'Production', color: 'red', icon: 'layers', desc: 'Customer-facing edge, gateway and database tier.', hostIds: ['h1', 'h2', 'h3'] },
  { id: 'w2', name: 'Homelab', color: 'blue', icon: 'server', desc: 'Two Proxmox nodes and the Hetzner box.', hostIds: ['h6', 'h8', 'h7'] },
  { id: 'w3', name: 'CI & data', color: 'violet', icon: 'cpu', desc: 'Runners and the analytics stack.', hostIds: ['h5', 'h4'] },
  { id: 'w4', name: 'On call', color: 'amber', icon: 'lightning', desc: 'Everything the pager can wake me for.', hostIds: ['h1', 'h3', 'h6'] },
];

export const RECENT_IDS = ['h1', 'h7', 'h4'];

// ---- orchestration ---------------------------------------------------------

const container = (
  id: string, name: string, image: string, running: boolean, status: string, ports: string,
): ContainerInfo => ({
  id, name, image, running, status, ports,
  project: null,
  cpu: running ? pseudoCpu(name) : null,
  mem: running ? pseudoMemFrac(name) * 2 * GB : null,
  maxmem: running ? 2 * GB : null,
});

const CONTAINERS: Record<string, ContainerInfo[]> = {
  h1: [
    container('c1', 'nginx-edge', 'nginx:1.25-alpine', true, 'Up 14 days', '80,443'),
    container('c2', 'api-gateway', 'pear/gateway:2.4.1', true, 'Up 6 days', '8080'),
    container('c3', 'redis-session', 'redis:7.2', true, 'Up 14 days', '6379'),
    container('c4', 'cert-renewer', 'certbot/certbot', false, 'Exited (0) 2 hours ago', '—'),
  ],
  h2: [
    container('c5', 'nginx-edge', 'nginx:1.25-alpine', true, 'Up 14 days', '80,443'),
    container('c6', 'api-gateway', 'pear/gateway:2.4.1', false, 'Exited (1) 1 day ago', '—'),
  ],
  h3: [
    container('c14', 'postgres', 'postgres:16', true, 'Up 30 days', '5432'),
    container('c15', 'pgbouncer', 'edoburu/pgbouncer:1.22', true, 'Up 30 days', '6432'),
    container('c16', 'pg-backup', 'prodrigestivill/pg-backup', false, 'Exited (0) 6 hours ago', '—'),
  ],
  h4: [
    container('c7', 'clickhouse', 'clickhouse/clickhouse:24.3', true, 'Up 3 days', '8123,9000'),
    container('c8', 'grafana', 'grafana/grafana:10.4', true, 'Up 3 days', '3000'),
    container('c9', 'vector-agent', 'timberio/vector:0.35', false, 'Exited (0) 4 hours ago', '—'),
  ],
  h5: [],
  h7: [
    container('c10', 'caddy', 'caddy:2.7', true, 'Up 21 days', '80,443'),
    container('c11', 'linkding', 'sissbruecker/linkding:1.26', true, 'Up 21 days', '9090'),
    container('c12', 'miniflux', 'miniflux/miniflux:2.1', true, 'Up 21 days', '8081'),
    container('c13', 'backup-cron', 'offen/docker-volume-backup', false, 'Exited (0) 2 days ago', '—'),
  ],
};

const SWARM_NODES: SwarmNodeInfo[] = [
  { name: 'edge-01', role: 'manager', ready: true, leader: true, addr: '10.0.2.11' },
  { name: 'edge-02', role: 'manager', ready: true, leader: false, addr: '10.0.2.12' },
  { name: 'edge-03', role: 'worker', ready: true, leader: false, addr: '10.0.2.13' },
  { name: 'edge-04', role: 'worker', ready: true, leader: false, addr: '10.0.2.14' },
  { name: 'edge-05', role: 'worker', ready: false, leader: false, addr: '10.0.2.15' },
];

const SWARM_SERVICES: SwarmServiceInfo[] = [
  { id: 's1', name: 'web_frontend', image: 'pear/web:3.1', mode: 'replicated', running: 4, desired: 4, ports: '80,443', stack: null },
  { id: 's2', name: 'api_gateway', image: 'pear/gateway:2.4.1', mode: 'replicated', running: 3, desired: 3, ports: '8080', stack: null },
  { id: 's3', name: 'worker_queue', image: 'pear/worker:2.4.1', mode: 'replicated', running: 2, desired: 6, ports: '—', stack: null },
  { id: 's4', name: 'redis', image: 'redis:7.2', mode: 'replicated', running: 1, desired: 1, ports: '6379', stack: null },
  { id: 's5', name: 'node_exporter', image: 'prom/node-exporter:1.7', mode: 'global', running: 5, desired: 5, ports: '9100', stack: null },
];

const guest = (
  vmid: number, name: string, type: 'vm' | 'lxc', running: boolean,
  cpu: number, memGb: number, maxmemGb: number,
): ProxmoxGuestInfo => ({
  vmid, name, type, running, status: running ? 'running' : 'stopped',
  cpu, mem: memGb * GB, maxmem: maxmemGb * GB,
});

/** Live orchestration per host id — mutated by mock orch actions. */
export const ORCH: Record<string, Orchestration> = {
  h1: {
    swarm: {
      nodes: SWARM_NODES,
      services: SWARM_SERVICES,
      stacks: [{ stack: null, services: SWARM_SERVICES }],
    },
  },
  h6: {
    proxmox: {
      resources: { cpu: 0.18, mem: 31.2 * GB, maxmem: 64 * GB, disk: 1.4 * 1024 * GB, maxdisk: 4 * 1024 * GB, uptime: 62 * 86400 + 4 * 3600 },
      guests: [
        guest(100, 'win-builder', 'vm', true, 0.12, 8.0, 16),
        guest(101, 'k3s-node-1', 'vm', true, 0.34, 6.1, 8),
        guest(102, 'k3s-node-2', 'vm', true, 0.28, 5.4, 8),
        guest(200, 'gitea', 'lxc', true, 0.02, 0.4, 2),
        guest(201, 'postgres', 'lxc', true, 0.06, 1.8, 4),
        guest(202, 'nightly-backup', 'lxc', false, 0, 0, 2),
      ],
      groups: [],
    },
  },
  h8: {
    proxmox: {
      resources: { cpu: 0.03, mem: 6 * GB, maxmem: 32 * GB, disk: 220 * GB, maxdisk: 900 * GB, uptime: 0 },
      guests: [guest(110, 'staging-vm', 'vm', false, 0, 0, 8), guest(210, 'vault', 'lxc', false, 0, 0, 2)],
      groups: [],
    },
  },
};

for (const [hid, list] of Object.entries(CONTAINERS)) {
  const facet = { containers: list, groups: [{ project: null, containers: list }] };
  ORCH[hid] = { ...(ORCH[hid] ?? {}), docker: facet };
}
for (const o of Object.values(ORCH)) {
  if (o.proxmox) {
    o.proxmox.groups = (['vm', 'lxc'] as const).map((type) => ({
      type,
      guests: o.proxmox!.guests.filter((g) => g.type === type),
    }));
  }
}

// ---- file tree -------------------------------------------------------------

const D = (name: string): FileEntry => ({ name, kind: 'dir', size: 0, mtimeMs: Date.UTC(2026, 2, 12), mode: 'drwxr-xr-x' });
const F = (name: string, size: number, m: number, d: number, mode = '-rw-r--r--'): FileEntry => ({
  name, kind: 'file', size, mtimeMs: Date.UTC(2026, m - 1, d), mode,
});

/** Absolute path → children. Shared by every mock host, mutated by fs ops. */
export const TREE: Record<string, FileEntry[]> = {
  '/': [D('bin'), D('etc'), D('home'), D('opt'), D('srv'), D('tmp'), D('usr'), D('var')],
  '/etc': [
    D('nginx'), D('systemd'), D('ssh'), D('docker'),
    F('hostname', 14, 3, 12), F('hosts', 312, 3, 12), F('os-release', 402, 2, 2),
    F('resolv.conf', 88, 4, 1), F('fstab', 678, 2, 2),
  ],
  '/etc/nginx': [
    D('conf.d'), D('sites-available'), D('sites-enabled'), D('snippets'), D('modules-enabled'),
    F('nginx.conf', 2458, 4, 14), F('mime.types', 5225, 2, 2), F('fastcgi_params', 1024, 2, 2),
    F('scgi_params', 664, 2, 2), F('uwsgi_params', 664, 2, 2), F('proxy_params', 255, 2, 2),
  ],
  '/etc/nginx/sites-available': [
    F('default', 2150, 3, 28), F('api.pear.sh', 1331, 4, 14), F('app.pear.sh', 1126, 4, 14),
  ],
  '/etc/nginx/conf.d': [F('gzip.conf', 412, 2, 2), F('ssl.conf', 1229, 3, 4)],
  '/home': [D('deploy'), D('lewis')],
  '/var': [D('log'), D('lib'), D('cache'), D('www')],
};

export const FILE_CONTENTS: Record<string, string> = {
  '/etc/nginx/nginx.conf': `user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 2048;
    multi_accept on;
}

http {
    sendfile           on;
    tcp_nopush         on;
    tcp_nodelay        on;
    keepalive_timeout  65;
    types_hash_max_size 2048;
    server_tokens      off;

    include       /etc/nginx/mime.types;
    default_type  application/octet-stream;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;

    access_log /var/log/nginx/access.log;
    error_log  /var/log/nginx/error.log;

    gzip on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
`,
  '/etc/nginx/sites-available/api.pear.sh': `server {
    listen 443 ssl http2;
    server_name api.pear.sh;

    ssl_certificate     /etc/letsencrypt/live/api.pear.sh/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.pear.sh/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }

    location /healthz {
        access_log off;
        return 200 "ok\\n";
    }
}
`,
  '/etc/hosts': `127.0.0.1       localhost
127.0.1.1       edge-01
10.0.4.12       db-primary
10.0.9.44       ci-runner-3

# IPv6
::1             localhost ip6-localhost ip6-loopback
ff02::1         ip6-allnodes
ff02::2         ip6-allrouters
`,
  '/etc/os-release': `PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"
NAME="Debian GNU/Linux"
VERSION_ID="12"
VERSION="12 (bookworm)"
VERSION_CODENAME=bookworm
ID=debian
HOME_URL="https://www.debian.org/"
`,
};
