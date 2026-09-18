#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, parseArgs, USAGE } from './config';
import { isLoopbackBind } from './security';
import { createPearServer } from './server';

// Dropped SSH links surface as socket errors on connections nobody is
// awaiting any more; the disconnect flow already handles them. They must not
// take the whole server — and everyone's terminals — down.
const NETWORK_ERROR =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|ENOTFOUND|socket hang up|[Kk]eepalive timeout/;
process.on('uncaughtException', (err) => {
  if (NETWORK_ERROR.test(err.message)) return console.warn(`[net] ${err.message}`);
  console.error(err);
  process.exit(1);
});

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void process.stdout.write(USAGE);

  const { config, generatedPassword } = await loadConfig(args);
  if (generatedPassword) {
    console.log(
      `\n  Password: ${generatedPassword}\n  (shown once — only its hash is stored, in ${args.configPath})\n`,
    );
  }
  if (args.resetPassword) return;

  const version = (
    JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }
  ).version;
  const server = createPearServer(config, `${version}-${Date.now().toString(36)}`, { version });
  const { port } = await server.listen();

  const shown =
    config.publicUrl ??
    `http://${config.host.includes(':') ? `[${config.host}]` : config.host}:${port}`;
  console.log(`Pear server ${version} — ${shown}`);
  console.log(`  auth: ${config.auth}   data: ${config.dataDir}`);
  if (config.auth === 'none') {
    console.log('  No login: whatever can reach this port has your hosts and keys.');
  }
  if (isLoopbackBind(config.host) && !config.publicUrl) {
    console.log('  Listening on loopback only. Other devices need HTTPS in front of it:');
    console.log('    a reverse proxy here, or --host 0.0.0.0 for one elsewhere — docs/SERVER.md');
  }

  let closing = false;
  const shutdown = () => {
    if (closing) process.exit(1);
    closing = true;
    console.log('\nShutting down…');
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
