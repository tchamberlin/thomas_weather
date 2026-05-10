#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import process from 'node:process';
import QRCode from 'qrcode';

const execAsync = promisify(exec);

/**
 * Per-station question routes: slug → display title above the QR code.
 * Routes are generated for every station in WU_STATION_IDS.
 * Add new entries here as the app grows more pages.
 */
const QUESTIONS = [
  { slug: 'dashboard', title: 'Full Weather Dashboard' },
  { slug: 'rain-yesterday', title: 'How much rain did we get yesterday?' },
];

async function buildRoutes() {
  const devVars = await readDevVars('.dev.vars');
  const raw = process.env.WU_STATION_IDS ?? devVars.WU_STATION_IDS ?? '';
  const stationIds = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (stationIds.length === 0) {
    fail('No stations configured. Set WU_STATION_IDS (comma-separated) in env or .dev.vars.');
  }
  const routes = [];
  for (const stationId of stationIds) {
    for (const q of QUESTIONS) {
      routes.push({
        path: `/pws/${encodeURIComponent(stationId)}/${q.slug}`,
        title: `${q.title} — ${stationId}`,
        slug: `${stationId}-${q.slug}`,
      });
    }
  }
  return routes;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const baseUrl = await resolveBaseUrl(args);
if (!baseUrl) {
  fail(`Could not determine production URL.

Tried:
  1. wrangler deployments list (requires local CF auth)
  2. wrangler.jsonc worker name → https://<name>.workers.dev
  3. QR_BASE_URL env var
  4. --base-url argument

Set --base-url explicitly, or run where wrangler is authenticated.`);
}

const outDir = args.out ?? 'qr-codes';
const format = args.format ?? 'html'; // html | svg
const width = Number(args.width ?? 300);
const shouldOpen = args.open === '1';

await mkdir(outDir, { recursive: true });

const routes = await buildRoutes();

let outputPath;
if (format === 'html') {
  outputPath = await generateHtml(outDir, baseUrl, width, routes);
} else if (format === 'svg') {
  await generateIndividualSvgs(outDir, baseUrl, width, routes);
} else {
  fail(`Unknown format: ${format}. Use html or svg.`);
}

if (shouldOpen && outputPath) {
  await openInBrowser(outputPath);
}

async function resolveBaseUrl(args) {
  // Priority 1: explicit CLI arg
  if (args.baseUrl) {
    return args.baseUrl.replace(/\/$/, '');
  }

  // Priority 2: env var
  const envUrl = process.env.QR_BASE_URL;
  if (envUrl) {
    return envUrl.replace(/\/$/, '');
  }

  // Priority 3: .dev.vars DEPLOYED_URL
  const devVars = await readDevVars('.dev.vars');
  if (devVars.DEPLOYED_URL) {
    const url = devVars.DEPLOYED_URL.replace(/\/$/, '');
    console.error(`Using DEPLOYED_URL from .dev.vars: ${url}`);
    return url;
  }

  // Priority 4: wrangler deployments list (requires local CF auth)
  const wranglerUrl = await fetchWranglerDeploymentUrl();
  if (wranglerUrl) {
    console.error(`Auto-detected URL from wrangler: ${wranglerUrl}`);
    return wranglerUrl;
  }

  // Priority 5: construct from wrangler.jsonc name
  const configUrl = await inferUrlFromWranglerConfig();
  if (configUrl) {
    console.error(`Inferred URL from wrangler.jsonc: ${configUrl}`);
    console.error(`Tip: Add DEPLOYED_URL=https://your-domain.com to .dev.vars to override.`);
    return configUrl;
  }

  return null;
}

async function fetchWranglerDeploymentUrl() {
  try {
    const { stdout } = await execAsync(
      'npx wrangler deployments list 2>/dev/null',
      { timeout: 15000, cwd: process.cwd() }
    );
    // Match patterns like:
    // https://weather.abc123.workers.dev
    // https://weather.pages.dev
    const match = stdout.match(/https:\/\/[^\s\n]+\.(?:workers\.dev|pages\.dev)/);
    if (match) {
      return match[0].replace(/\/$/, '');
    }
    // Also try matching any https URL in the output as a looser fallback
    const looseMatch = stdout.match(/https:\/\/[^\s\n]+/);
    if (looseMatch) {
      return looseMatch[0].replace(/\/$/, '');
    }
  } catch {
    // wrangler not authenticated or not installed
  }
  return null;
}

async function inferUrlFromWranglerConfig() {
  try {
    const configPath = path.join(process.cwd(), 'wrangler.jsonc');
    const raw = await readFile(configPath, 'utf8');
    // Strip comments to parse as JSON
    const stripped = raw
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    const config = JSON.parse(stripped);
    const name = config?.name;
    if (typeof name === 'string' && name) {
      return `https://${name}.workers.dev`;
    }
  } catch {
    // wrangler.jsonc missing or malformed
  }
  return null;
}

async function generateHtml(outDir, baseUrl, width, routes) {
  const cards = [];
  const items = [];
  for (const { path: route, title } of routes) {
    const url = `${baseUrl}${route}`;
    const svg = await QRCode.toString(url, {
      type: 'svg',
      width,
      margin: 2,
      color: {
        dark: '#101c2b',
        light: '#f4f8fb',
      },
    });
    cards.push(`
      <div class="card">
        <div class="title">${escHtml(title)}</div>
        <div class="qr">${svg}</div>
        <div class="url">${escHtml(url)}</div>
      </div>
    `);
    items.push({ title, url });
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>QR Codes — ${escHtml(baseUrl)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #08111d;
    color: #e9eef4;
    padding: 32px 24px;
  }
  h1 {
    text-align: center;
    font-size: 1.5rem;
    margin: 0 0 28px;
    color: #f4f8fb;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(${width + 40}px, 1fr));
    gap: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  .card {
    background: #101c2b;
    border: 1px solid #22344a;
    border-radius: 12px;
    padding: 20px;
    text-align: center;
    box-shadow: 0 8px 28px rgba(0,0,0,.28);
  }
  .title {
    font-size: 1.05rem;
    font-weight: 600;
    color: #dce8ef;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  .qr svg {
    width: 100%;
    height: auto;
    max-width: ${width}px;
    border-radius: 8px;
  }
  .url {
    margin-top: 12px;
    font-size: 0.8rem;
    color: #94a8b8;
    word-break: break-all;
  }
  @media print {
    body { background: #fff; color: #000; }
    .card { background: #fff; border-color: #ccc; box-shadow: none; break-inside: avoid; }
    .title { color: #000; }
    .url { color: #666; }
  }
</style>
</head>
<body>
<h1>Scan to open a page</h1>
<div class="grid">
${cards.join('\n')}
</div>
</body>
</html>`;

  const outPath = path.join(outDir, 'index.html');
  await writeFile(outPath, html);
  console.log(`\nGenerated ${items.length} QR code(s):`);
  for (const { title, url } of items) {
    console.log(`  • ${title}`);
    console.log(`    → ${url}`);
  }
  console.log(`\nOutput: ${outPath}`);
  return outPath;
}

async function generateIndividualSvgs(outDir, baseUrl, width, routes) {
  for (const { path: route, title, slug } of routes) {
    const url = `${baseUrl}${route}`;
    const svg = await QRCode.toString(url, {
      type: 'svg',
      width,
      margin: 2,
    });
    const outPath = path.join(outDir, `${slug}.svg`);
    await writeFile(outPath, svg);
    console.log(`${title} → ${outPath}`);
  }
}

function escHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      parsed[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1);
      continue;
    }
    const key = toCamel(arg.slice(2));
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = '1';
      continue;
    }
    parsed[key] = next;
    i += 1;
  }
  return parsed;
}

function toCamel(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

async function readDevVars(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      env[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

async function openInBrowser(filePath) {
  let command, args;
  if (process.platform === 'darwin') {
    command = 'open';
    args = [filePath];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', filePath];
  } else {
    command = 'xdg-open';
    args = [filePath];
  }
  const proc = spawn(command, args, { stdio: 'ignore', detached: true });
  proc.unref();
  console.log(`Opened ${filePath} in browser`);
}

function printHelp() {
  console.log(`Usage:
  npm run generate:qr [-- --base-url <url>] [options]

Generate QR codes for each public page in the app.

Auto-detects the production URL in this order:
  1. --base-url argument
  2. QR_BASE_URL env var
  3. DEPLOYED_URL in .dev.vars
  4. wrangler deployments list (requires local Cloudflare auth)
  5. wrangler.jsonc name → https://<name>.workers.dev

Options:
  --base-url <url>   Override auto-detection.
  --out <dir>        Output directory. Default: qr-codes.
  --format <fmt>     html | svg. Default: html.
  --width <px>       QR code width in pixels. Default: 300.
  --open             Open the generated HTML in your default browser.
  --help, -h         Show this help.

Examples:
  npm run generate:qr                    # auto-detect URL, generate HTML
  npm run generate:qr -- --format svg    # individual SVG files
  npm run generate:qr -- --open           # generate + auto-open in browser
  npm run generate:qr -- --base-url https://myapp.example.com --out assets/qr
`);
}
