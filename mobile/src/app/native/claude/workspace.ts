import { shq, type SshTransport } from '@pear/core';

const CLAUDE_MD = `# Pear

You are running inside Pear, an SSH workspace app on the user's phone. The
user manages remote servers here (Docker hosts, Swarm clusters, Proxmox
nodes) and you help configure and operate them. You are executing on ONE of
those servers (the designated Claude host); the Pear app itself runs on the
phone.

## Acting on servers

All server work goes through the \`pear\` MCP tools, which run over Pear's
SSH connections from the phone:

- \`list_hosts\` — the user's servers. Call it first to see what exists.
- \`run_command(host, command, timeoutSec?)\` — run a shell command on a host.
- \`read_file\` / \`write_file\` / \`list_dir\` — remote files over SFTP.
- \`edit_file\` — exact-string replacement in a remote file. Prefer it over
  write_file for targeted changes: the user sees a real diff.
- \`host_vitals\` — CPU/mem/load/disk/net with rates. Prefer it over ad-hoc
  top/free/df. Takes ~1s; don't poll it in a loop.
- \`service_ps\` / \`service_logs\` — Swarm service tasks and logs.
  service_logs is one-shot: follow by re-calling with since = lastTs.
- \`list_guests\` — VMs/CTs on a Proxmox node.

Refer to hosts by name (as shown in list_hosts) or id. Hosts connect
automatically on first use.

## Important

- Your built-in Bash and file tools run on the CLAUDE HOST (the server this
  CLI is executing on), not on the phone and not on other servers. Use the
  \`pear\` tools to reach the other hosts.
- Command output is truncated at ~16 KB — narrow large output remotely with
  grep/head/tail instead of reading everything.
- Inspect before you mutate: prefer read-only commands first, and be explicit
  about what a destructive command will do before running it.
`;

/**
 * (Re)provision the workspace dir on the Claude host: .mcp.json pointing at
 * the tunneled relay endpoint (remote port + bearer token change every run)
 * and a CLAUDE.md explaining the setup. Mirrors the desktop
 * provisionClaudeWorkspace, but over SFTP/exec instead of node fs.
 */
export async function provisionSshWorkspace(
  transport: SshTransport,
  dir: string,
  remotePort: number,
  token: string,
): Promise<void> {
  // 700 before anything secret lands inside: .mcp.json carries the MCP
  // bearer token, and the SFTP write below is not atomic-with-mode.
  await transport.exec(`mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)}`);
  const mcpConfig = {
    mcpServers: {
      pear: {
        type: 'http',
        url: `http://127.0.0.1:${remotePort}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };
  await transport.writeFile(`${dir}/.mcp.json`, JSON.stringify(mcpConfig, null, 2) + '\n');
  await transport.exec(`chmod 600 ${shq(`${dir}/.mcp.json`)}`);
  await transport.writeFile(`${dir}/CLAUDE.md`, CLAUDE_MD);
}

/** The CLI's login-home workspace dir on the Claude host. */
export async function claudeWorkspaceDir(transport: SshTransport): Promise<string> {
  const home = (await transport.exec('printf %s "$HOME"')).stdout.trim();
  if (!home.startsWith('/')) throw new Error('Could not resolve $HOME on the Claude host');
  return `${home}/.pear-claude`;
}
