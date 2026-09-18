// Pack pear-server into a self-contained, prebuilt tarball:
//
//   npm run build:web && node scripts/pack-server.mjs      → release/pear-server.tar.gz
//
// Why a bundle: installing from source means compiling two Angular apps on the
// target — minutes of CPU and ~2 GB of RAM on what is often a tiny container.
// The bundle carries the built output; the target only runs
// `npm install --omit=dev` for the handful of runtime packages (ssh2, node-pty's
// prebuilt binary for *its* platform, ws, the MCP SDK). server/install.sh does
// exactly that.
//
// Layout mirrors the repository, because server/dist/config.js finds the UI
// builds relative to itself:
//
//   pear-server/
//     package.json          deps: ws + @pear/core → file:./vendor/core
//     vendor/core/          @pear/core: package.json, dist/, node/
//     server/               dist/, public/, package.json, pear-server.service
//     ui/dist/ui/browser/   desktop workspace
//     mobile/dist/mobile/browser/   touch UI

import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'release');
const STAGE = path.join(OUT, 'pear-server');

const json = async (p) => JSON.parse(await readFile(path.join(ROOT, p), 'utf8'));
// Ship what runs: no tests, no fixtures, no source maps.
const runtimeOnly = (src) =>
  !/\.test\.(js|d\.ts)(\.map)?$/.test(src) &&
  !src.endsWith('.map') &&
  !src.includes(`${path.sep}testing${path.sep}`);

async function copy(from, to, filter) {
  await cp(path.join(ROOT, from), path.join(STAGE, to), { recursive: true, filter });
}

async function main() {
  const version = process.env.PEAR_VERSION || (await json('package.json')).version;
  for (const must of [
    'core/dist/node/index.js',
    'server/dist/cli.js',
    'ui/dist/ui/browser/index.html',
    'mobile/dist/mobile/browser/index.html',
  ]) {
    await readFile(path.join(ROOT, must)).catch(() => {
      throw new Error(`${must} is missing — run "npm run build:web" first`);
    });
  }

  await rm(STAGE, { recursive: true, force: true });
  await mkdir(STAGE, { recursive: true });

  await copy('core/dist', 'vendor/core/dist', runtimeOnly);
  await copy('core/node', 'vendor/core/node');
  const core = await json('core/package.json');
  await writeFile(
    path.join(STAGE, 'vendor/core/package.json'),
    JSON.stringify(
      {
        name: core.name,
        version,
        main: core.main,
        types: core.types,
        dependencies: core.dependencies,
        license: core.license,
      },
      null,
      2,
    ) + '\n',
  );

  await copy('server/dist', 'server/dist', runtimeOnly);
  await copy('server/public', 'server/public');
  await copy('server/pear-server.service', 'server/pear-server.service');
  // The installer travels with the release it installs: the auto-update timer
  // runs the installed copy, which then replaces itself with the newer one.
  await copy('server/install.sh', 'server/install.sh');
  const server = await json('server/package.json');
  await writeFile(
    path.join(STAGE, 'server/package.json'),
    JSON.stringify({ name: server.name, version, license: server.license }, null, 2) + '\n',
  );

  await copy('ui/dist/ui/browser', 'ui/dist/ui/browser', (src) => !src.endsWith('.map'));
  await copy(
    'mobile/dist/mobile/browser',
    'mobile/dist/mobile/browser',
    (src) => !src.endsWith('.map'),
  );
  await copy('LICENSE', 'LICENSE');

  const { '@pear/core': _workspace, ...serverDeps } = server.dependencies;
  await writeFile(
    path.join(STAGE, 'package.json'),
    JSON.stringify(
      {
        name: 'pear-server-bundle',
        version,
        private: true,
        description: 'Prebuilt pear-server. Install runtime deps with: npm install --omit=dev',
        bin: { 'pear-server': 'server/dist/cli.js' },
        scripts: { start: 'node server/dist/cli.js' },
        engines: { node: '>=20' },
        dependencies: { '@pear/core': 'file:./vendor/core', ...serverDeps },
        license: 'MIT',
      },
      null,
      2,
    ) + '\n',
  );

  const tarball = path.join(OUT, 'pear-server.tar.gz');
  execFileSync('tar', ['-C', OUT, '-czf', tarball, 'pear-server']);
  await rm(STAGE, { recursive: true, force: true });
  const size = execFileSync('du', ['-h', tarball]).toString().split('\t')[0];
  console.log(`✓ ${path.relative(ROOT, tarball)}  (${size}, version ${version})`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
