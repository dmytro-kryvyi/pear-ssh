// Regenerate every raster brand asset from the master pear (build/icon.svg):
// desktop icon.png/.ico, the ui favicon, and the Android adaptive launcher
// mipmaps. Run after any change to the master:
//
//   node scripts/gen-brand-icons.mjs
//
// Deps (sharp, png-to-ico) are resolved from site/node_modules — the landing
// site owns the image toolchain, so run `npm install` in site/ first.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire, } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'site', 'package.json'));
const sharp = require('sharp');
const pngToIco = require('png-to-ico');

const MASTER = path.join(ROOT, 'build/icon.svg');

// The pear WITHOUT the rounded-square background — the Android adaptive
// foreground layer (Android draws the background color itself). Keep the
// paths in sync with build/icon.svg.
const FG_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <defs><linearGradient id="body" x1="0.15" y1="0.05" x2="0.85" y2="1">
    <stop offset="0" stop-color="#C2E86B"/><stop offset="0.55" stop-color="#8FC63D"/><stop offset="1" stop-color="#5E9A2E"/>
  </linearGradient></defs>
  <path d="M258 152 C 252 128, 254 110, 262 96" stroke="#7A5540" stroke-width="15" stroke-linecap="round" fill="none"/>
  <path d="M268 140 C 300 100, 354 94, 374 104 C 360 150, 308 164, 270 150 Z" fill="#69A83B"/>
  <path fill="url(#body)" d="M256 150 C 288 150, 302 178, 297 208 C 292 240, 331 260, 353 288 C 380 322, 388 358, 381 390 C 372 438, 320 472, 256 472 C 192 472, 140 438, 131 390 C 124 358, 132 322, 159 288 C 181 260, 220 240, 215 208 C 210 178, 224 150, 256 150 Z"/>
  <ellipse cx="212" cy="330" rx="30" ry="46" fill="#FFFFFF" opacity="0.17" transform="rotate(-18 212 330)"/>
</svg>`;

const png = (buf, size) => sharp(buf, { density: 512 }).resize(size, size).png().toBuffer();
const icoFrom = async (buf) =>
  pngToIco(await Promise.all([16, 32, 48, 64, 128, 256].map((s) => png(buf, s))));

async function circleMask(input, size) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(input).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

// Foreground trimmed to content and scaled to ~60% of the tile so the pear
// stays inside the adaptive-icon safe zone.
async function foreground(size) {
  const tight = await sharp(Buffer.from(FG_SVG), { density: 1024 }).png().toBuffer();
  const trimmed = await sharp(tight).trim().toBuffer();
  const inner = Math.round(size * 0.6);
  const fit = await sharp(trimmed)
    .resize({ width: inner, height: inner, fit: 'inside' })
    .toBuffer();
  const m = await sharp(fit).metadata();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([
      {
        input: fit,
        left: Math.round((size - m.width) / 2),
        top: Math.round((size - m.height) / 2),
      },
    ])
    .png()
    .toBuffer();
}

async function main() {
  const master = await readFile(MASTER);

  await writeFile(path.join(ROOT, 'build/icon.png'), await png(master, 1024));
  await writeFile(path.join(ROOT, 'build/icon.ico'), await icoFrom(master));
  await writeFile(path.join(ROOT, 'ui/public/favicon.ico'), await icoFrom(master));
  console.log('✓ build/icon.png+ico, ui/public/favicon.ico');

  const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
  const FG = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
  const resDir = path.join(ROOT, 'mobile/android/app/src/main/res');
  for (const [density, size] of Object.entries(LEGACY)) {
    const full = await png(master, size);
    const dir = path.join(resDir, `mipmap-${density}`);
    await writeFile(path.join(dir, 'ic_launcher.png'), full);
    await writeFile(path.join(dir, 'ic_launcher_round.png'), await circleMask(full, size));
    await writeFile(path.join(dir, 'ic_launcher_foreground.png'), await foreground(FG[density]));
  }
  console.log('✓ android ic_launcher / _round / _foreground (5 densities)');
  console.log('  (site favicons regenerate via site/build.mjs)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
