// Build the Pear landing page into dist/ as a fully static, self-contained site.
//
//   node build.mjs
//
// Produces: minified index.html, responsive AVIF/WebP/PNG screenshots, a 1200x630
// OG card, self-hosted fonts, favicons, robots.txt and sitemap.xml — everything the
// browser needs with zero external requests.

import { readFile, writeFile, rm, mkdir, cp, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { minify } from 'html-minifier-terser';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = (...p) => path.join(__dirname, ...p);

// ── The ONLY place the deployed origin lives. Change this (no trailing slash)
//    when a custom domain is ready, then re-run the build. ──────────────────
const BASE_URL = 'https://pear.pages.dev';

const SRC = R('src');
const ASSETS_SRC = R('assets-src');
const DIST = R('dist');
const DIST_ASSETS = R('dist/assets');
const DIST_FONTS = R('dist/fonts');

// name → source screenshot metadata + the render widths we emit AVIF/WebP for.
// Widths never exceed the native size (no upscaling).
const IMAGES = [
  { name: 'shot-desktop-main', w: 1440, h: 900, widths: [768, 1216, 1440] },
  { name: 'shot-editor',       w: 1440, h: 900, widths: [640, 900, 1280] },
  { name: 'shot-cluster',      w: 755,  h: 520, widths: [560, 755] },
  { name: 'shot-tasks',        w: 857,  h: 500, widths: [560, 857] },
  { name: 'shot-claude-dock',  w: 382,  h: 900, widths: [382] },
  { name: 'shot-mob-hosts',    w: 404,  h: 516, widths: [404] },
  { name: 'shot-mob-cluster',  w: 404,  h: 516, widths: [404] },
  { name: 'shot-mob-claude',   w: 404,  h: 516, widths: [404] },
];

const replaceTokens = (s) => s.replaceAll('%BASE_URL%', BASE_URL);

const missing = [];

// A dark, correctly-sized stand-in so the layout (and srcset) stay intact when a
// source screenshot is absent or truncated. Replace the real file and rebuild.
async function placeholder(img) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${img.w}" height="${img.h}">
      <rect width="100%" height="100%" fill="#171d23"/>
      <rect x="1" y="1" width="${img.w - 2}" height="${img.h - 2}" fill="none"
        stroke="#2f373f" stroke-width="2" rx="10"/>
      <text x="50%" y="50%" font-family="monospace" font-size="${Math.max(13, Math.round(img.w / 34))}"
        fill="#6f8088" text-anchor="middle" dominant-baseline="middle">${img.name} · image pending</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Return a decodable source buffer for an image, or a placeholder if the file is
// missing or corrupt (e.g. truncated by the Design MCP's 256 KiB cap).
async function loadImage(img) {
  const p = path.join(ASSETS_SRC, `${img.name}.png`);
  if (existsSync(p)) {
    const buf = await readFile(p);
    try {
      await sharp(buf).resize(16).toBuffer(); // full decode probe
      return buf;
    } catch { /* corrupt/truncated → fall through */ }
  }
  missing.push(img.name);
  return placeholder(img);
}

async function clean() {
  await rm(DIST, { recursive: true, force: true });
  await mkdir(DIST_ASSETS, { recursive: true });
  await mkdir(DIST_FONTS, { recursive: true });
}

async function buildHtml() {
  const raw = await readFile(R('src/index.html'), 'utf8');
  const out = await minify(replaceTokens(raw), {
    collapseWhitespace: true,
    conservativeCollapse: true,
    removeComments: true,
    minifyCSS: true,
    minifyJS: true,
    sortAttributes: true,
    sortClassName: true,
  });
  await writeFile(R('dist/index.html'), out);
}

async function copyStatic() {
  // favicon.svg passes through untouched.
  await cp(R('src/favicon.svg'), R('dist/favicon.svg'));
  // robots.txt carries the sitemap URL → token replace.
  await writeFile(R('dist/robots.txt'), replaceTokens(await readFile(R('src/robots.txt'), 'utf8')));
  // _headers is consumed by Cloudflare Pages verbatim.
  await cp(R('src/_headers'), R('dist/_headers'));
}

async function buildImages() {
  for (const img of IMAGES) {
    const input = await loadImage(img);

    for (const w of img.widths) {
      const base = sharp(input).resize({ width: w, withoutEnlargement: true });
      await base.clone().avif({ quality: 52, effort: 5 })
        .toFile(path.join(DIST_ASSETS, `${img.name}-${w}.avif`));
      await base.clone().webp({ quality: 80, effort: 5 })
        .toFile(path.join(DIST_ASSETS, `${img.name}-${w}.webp`));
    }

    // Universal PNG fallback at native width for the <img src>.
    await sharp(input)
      .resize({ width: img.w, withoutEnlargement: true })
      .png({ compressionLevel: 9, palette: true })
      .toFile(path.join(DIST_ASSETS, `${img.name}.png`));
  }
}

async function buildOgImage() {
  const W = 1200, H = 630;
  const bg = '#10161b';

  // Screenshot on the right, framed.
  const shotW = 664, shotH = Math.round((shotW * 900) / 1440); // 415
  const shotX = W - shotW - 52, shotY = Math.round((H - shotH) / 2); // 484, 108
  const shot = await sharp(await readFile(path.join(ASSETS_SRC, 'shot-desktop-main.png')))
    .resize({ width: shotW, height: shotH, fit: 'cover' })
    .png()
    .toBuffer();
  const frame = await sharp({
    create: { width: shotW + 4, height: shotH + 4, channels: 4, background: '#2f363d' },
  }).png().toBuffer();

  // Left text panel + top glow, drawn as one SVG overlay.
  const overlay = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#45cbc6"/><stop offset="1" stop-color="#1c9bb3"/>
        </linearGradient>
        <radialGradient id="glow" cx="0.25" cy="0" r="0.9">
          <stop offset="0" stop-color="#38c9c4" stop-opacity="0.20"/>
          <stop offset="1" stop-color="#38c9c4" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="${W}" height="${H}" fill="url(#glow)"/>
      <g transform="translate(72,86)">
        <rect width="56" height="56" rx="14" fill="url(#lg)"/>
        <path transform="translate(12,12) scale(1.0)" fill="#10161b" fill-rule="evenodd"
          d="M9 25V7h9c3.2 0 5 2.2 5 5.5S21.2 18 18 18h-5v7H9Zm4-15v5h4.5c1.4 0 2.3-1 2.3-2.5S18.9 10 17.5 10H13Z"/>
        <text x="72" y="40" font-family="sans-serif" font-size="40" font-weight="700" fill="#f4f7f8">Pear</text>
      </g>
      <text x="72" y="250" font-family="sans-serif" font-size="46" font-weight="800" fill="#f4f7f8">Every host,</text>
      <text x="72" y="304" font-family="sans-serif" font-size="46" font-weight="800" fill="#45cbc6">one workspace.</text>
      <text x="72" y="362" font-family="sans-serif" font-size="22" fill="#9fb0b8">Files, terminal, live metrics and</text>
      <text x="72" y="392" font-family="sans-serif" font-size="22" fill="#9fb0b8">container orchestration for every</text>
      <text x="72" y="422" font-family="sans-serif" font-size="22" fill="#9fb0b8">server you run.</text>
      <text x="72" y="520" font-family="monospace" font-size="18" fill="#6f8088">Free &amp; open source · no backend</text>
    </svg>`);

  await sharp({ create: { width: W, height: H, channels: 4, background: bg } })
    .composite([
      { input: overlay, top: 0, left: 0 },
      { input: frame, top: shotY - 2, left: shotX - 2 },
      { input: shot, top: shotY, left: shotX },
    ])
    .png()
    .toFile(R('dist/og-image.png'));
}

async function buildFavicons() {
  const svg = await readFile(R('src/favicon.svg'));
  // apple-touch-icon: 180x180, opaque background for iOS.
  await sharp(svg, { density: 512 })
    .resize(180, 180)
    .flatten({ background: '#10161b' })
    .png()
    .toFile(R('dist/apple-touch-icon.png'));
  // favicon.ico from a crisp 32x32 raster.
  const ico32 = await sharp(svg, { density: 512 }).resize(32, 32).png().toBuffer();
  await writeFile(R('dist/favicon.ico'), await pngToIco([ico32]));
}

async function copyFonts() {
  // @fontsource-variable ships the variable latin woff2 under files/. Pick the
  // upright latin axis file (not latin-ext, not italic).
  const pick = async (pkg, out) => {
    const dir = R('node_modules', pkg, 'files');
    const files = await readdir(dir);
    const f = files.find((n) => n.endsWith('-latin-wght-normal.woff2'));
    if (!f) throw new Error(`no latin variable woff2 in ${pkg}`);
    await cp(path.join(dir, f), path.join(DIST_FONTS, out));
  };
  await pick('@fontsource-variable/inter', 'inter.woff2');
  await pick('@fontsource-variable/jetbrains-mono', 'jetbrains-mono.woff2');
}

async function buildSitemap() {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${BASE_URL}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
  await writeFile(R('dist/sitemap.xml'), xml);
}

async function main() {
  console.log('Base URL:', BASE_URL);
  await clean();
  await Promise.all([
    buildHtml(),
    copyStatic(),
    buildImages(),
    buildOgImage(),
    buildFavicons(),
    copyFonts(),
    buildSitemap(),
  ]);
  console.log('✓ Built site → dist/');
  if (missing.length) {
    console.warn(`\n⚠ ${missing.length} screenshot(s) used a PLACEHOLDER (missing or truncated source):`);
    for (const n of missing) console.warn(`   · assets-src/${n}.png`);
    console.warn('  Drop the full-resolution files in assets-src/ and rebuild.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
