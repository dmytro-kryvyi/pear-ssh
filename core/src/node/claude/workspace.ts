import { promises as fs } from 'node:fs';
import { join } from 'node:path';

export interface ClaudeWorkspaceConfig {
  /** The directory `claude` will be launched in (its "project"). */
  dir: string;
  /** MCP endpoint URL from PearMcpServer.start(). */
  url: string;
  token: string;
}

const CLAUDE_MD = `# Pear

You are running inside Pear, a desktop SSH workspace. The user manages remote
servers here (Docker hosts, Swarm clusters, Proxmox nodes) and you help
configure and operate them.

## Acting on servers

All server work goes through the \`pear\` MCP tools, which run over Pear's
existing SSH connections:

- \`list_hosts\` — the user's servers. Call it first to see what exists.
- \`run_command(host, command, timeoutSec?)\` — run a shell command on a host.
- \`read_file\` / \`write_file\` / \`list_dir\` — remote files over SFTP.
- \`edit_file\` — exact-string replacement in a remote file. Prefer it over
  write_file for targeted changes: the user sees a real diff.
- \`host_vitals\` — CPU/mem/load/disk/net with rates. Prefer it over ad-hoc
  top/free/df. Takes ~1s; don't poll it in a loop.
- \`service_ps\` / \`service_logs\` — Swarm service tasks and logs (real
  stdout/stderr split). service_logs is one-shot: follow by re-calling with
  since = the previous result's lastTs.
- \`list_guests\` — VMs/CTs on a Proxmox node.
- \`list_terminals\` / \`read_terminal\` — the terminals the user has open in
  Pear and their text. When the user says "this error" or "my terminal",
  read_terminal shows you what they see.
- \`reveal_in_app\` — open a directory, file, or service-logs drawer in the
  Pear UI. Use it to show the user what you found instead of only describing
  it; it never modifies anything.
- \`transfer_between_hosts\` / \`transfer_status\` — copy/move files between
  hosts (host \`local\` = the user's machine). Asynchronous: start once, then
  poll transfer_status; never restart a job because it looks slow.
- \`port_forward\` / \`list_port_forwards\` / \`close_port_forward\` — SSH
  tunnels from the user's machine to a host's ports. Forwards persist across
  turns: close what you opened when you're done. Sub-hosts can't forward.

Refer to hosts by name (as shown in list_hosts) or id. Hosts connect
automatically on first use.

## Important

- Your built-in Bash and file tools run on the user's LOCAL machine, not on
  the servers. Use the \`pear\` tools for anything server-side; only use local
  tools when the user explicitly wants local work.
- Command output is truncated at ~16 KB — narrow large output remotely with
  grep/head/tail instead of reading everything.
- Inspect before you mutate: prefer read-only commands first, and be explicit
  about what a destructive command will do before running it.
`;

/**
 * (Re)provisions the directory Pear launches `claude` in: a .mcp.json wiring
 * the CLI to this run's MCP endpoint (port and bearer token change every app
 * start, so both files are rewritten each launch) and a CLAUDE.md telling the
 * agent how to work through Pear. The CLI's own project scoping (sessions,
 * /resume, tool approvals) keys off this directory.
 */
export async function provisionClaudeWorkspace(cfg: ClaudeWorkspaceConfig): Promise<void> {
  await fs.mkdir(cfg.dir, { recursive: true });
  const mcpConfig = {
    mcpServers: {
      pear: {
        type: 'http',
        url: cfg.url,
        headers: { Authorization: `Bearer ${cfg.token}` },
      },
    },
  };
  await fs.writeFile(join(cfg.dir, '.mcp.json'), JSON.stringify(mcpConfig, null, 2) + '\n', {
    mode: 0o600,
  });
  // chmod explicitly — writeFile's mode only applies on create.
  await fs.chmod(join(cfg.dir, '.mcp.json'), 0o600);
  await fs.writeFile(join(cfg.dir, 'CLAUDE.md'), CLAUDE_MD);
}
