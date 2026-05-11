#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const API_BASE = 'https://api.weather.com';
const STATION_IDS_KV_KEY = 'weather:config:station-ids';
const NEIGHBORS_KV_KEY = 'weather:config:neighbors';
const DEFAULT_BINDING = 'WEATHER';

const args = parseArgs(process.argv.slice(2));
const dotEnv = await readDevVars(args.env ?? '.dev.vars');
const apiKey = cleanSecret(args.apiKey ?? process.env.WU_API_KEY ?? dotEnv.WU_API_KEY);
const kvScope = args.kvRemote ? 'remote' : 'local';
const stationsArg = cleanSecret(args.stations) || await readStationIdsFromKv(kvScope);
const outPath = args.out ? String(args.out) : null;
const localOnly = args.localOnly === '1' || args.localOnly === true;
const maxDistanceMi = args.maxDistanceMi === undefined ? null : Number(args.maxDistanceMi);
const includeSelf = args.includeSelf === '1';
const requireQc = args.requireQc !== '0';
const delayMs = Number(args.delayMs ?? 250);

if (args.help) {
	printHelp();
	process.exit(0);
}

if (!apiKey) fail('Missing WU_API_KEY. Set env var or .dev.vars.');
if (!stationsArg) fail(`Missing stations. Pass --stations or seed KV key ${STATION_IDS_KV_KEY} via npm run add-station.`);

const primaries = stationsArg.split(',').map((s) => s.trim()).filter(Boolean);
if (primaries.length === 0) fail('No primary stations parsed from input.');

console.log(`Discovering neighbors for ${primaries.length} primary station(s)…`);

const result = {
	generatedAt: new Date().toISOString(),
	stations: {},
};

for (const primary of primaries) {
	console.log(`\n→ ${primary}`);
	const obs = await fetchCurrent(primary);
	if (!obs) {
		console.warn(`  skip: could not fetch current obs`);
		continue;
	}
	const { lat, lon } = obs;
	console.log(`  origin: ${lat}, ${lon} (${obs.neighborhood ?? '?'})`);

	await sleep(delayMs);
	const near = await fetchNear(lat, lon);
	if (!near) {
		console.warn(`  skip: location/near failed`);
		continue;
	}

	const neighbors = expandNear(near)
		.filter((s) => includeSelf || s.stationId !== primary)
		.filter((s) => !requireQc || s.qcStatus === 1)
		.filter((s) => maxDistanceMi === null || s.distanceMi <= maxDistanceMi);

	console.log(`  kept ${neighbors.length} neighbor(s)`);
	for (const n of neighbors) {
		console.log(`    ${n.stationId.padEnd(14)} ${n.distanceMi.toFixed(2).padStart(5)}mi  ${n.name}`);
	}

	result.stations[primary] = {
		lat,
		lon,
		neighborhood: obs.neighborhood ?? null,
		neighbors,
	};

	await sleep(delayMs);
}

const serialized = `${JSON.stringify(result, null, 2)}\n`;

const tempFile = path.join('data', '.neighbors.kv.json');
await mkdir(path.dirname(tempFile), { recursive: true });
await writeFile(tempFile, serialized);

console.log('');
await writeNeighborsToKv('local', tempFile);
if (!localOnly) await writeNeighborsToKv('remote', tempFile);

if (outPath) {
	await mkdir(path.dirname(outPath), { recursive: true });
	await writeFile(outPath, serialized);
	console.log(`Wrote ${outPath} (local debug copy)`);
}

async function fetchCurrent(stationId) {
	const url = new URL(`${API_BASE}/v2/pws/observations/current`);
	url.searchParams.set('stationId', stationId);
	url.searchParams.set('format', 'json');
	url.searchParams.set('units', 'e');
	url.searchParams.set('apiKey', apiKey);
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  current obs HTTP ${res.status}`);
		return null;
	}
	const data = await res.json();
	const o = data?.observations?.[0];
	if (!o) return null;
	return { lat: o.lat, lon: o.lon, neighborhood: o.neighborhood };
}

async function fetchNear(lat, lon) {
	const url = new URL(`${API_BASE}/v3/location/near`);
	url.searchParams.set('geocode', `${lat},${lon}`);
	url.searchParams.set('product', 'pws');
	url.searchParams.set('format', 'json');
	url.searchParams.set('apiKey', apiKey);
	const res = await fetch(url);
	if (!res.ok) {
		console.warn(`  location/near HTTP ${res.status}`);
		return null;
	}
	return res.json();
}

function expandNear(payload) {
	const loc = payload?.location;
	if (!loc) return [];
	const ids = loc.stationId ?? [];
	return ids.map((id, i) => ({
		stationId: id,
		name: loc.stationName?.[i] ?? null,
		lat: loc.latitude?.[i] ?? null,
		lon: loc.longitude?.[i] ?? null,
		distanceKm: loc.distanceKm?.[i] ?? null,
		distanceMi: loc.distanceMi?.[i] ?? null,
		qcStatus: loc.qcStatus?.[i] ?? null,
		updateTimeUtc: loc.updateTimeUtc?.[i] ?? null,
	}));
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
			env[trimmed.slice(0, idx)] = cleanSecret(trimmed.slice(idx + 1));
		}
		return env;
	} catch {
		return {};
	}
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

function cleanSecret(value) {
	if (!value) return '';
	const trimmed = String(value).trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeNeighborsToKv(scope, filePath, binding = DEFAULT_BINDING) {
	const scopeArg = scope === 'remote' ? '--remote' : '--local';
	const result = await new Promise((resolve) => {
		const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'kv', 'key', 'put', NEIGHBORS_KV_KEY, '--binding', binding, '--path', filePath, scopeArg], {
			cwd: process.cwd(),
			env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(process.cwd(), '.wrangler-config') },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => { stdout += c; });
		child.stderr.on('data', (c) => { stderr += c; });
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
	if (result.code !== 0) {
		throw new Error(`wrangler kv key put (${scope}) failed: ${result.stderr || result.stdout}`);
	}
	console.log(`  ${scope} KV: PUT ${NEIGHBORS_KV_KEY}`);
}

async function readStationIdsFromKv(scope, binding = DEFAULT_BINDING) {
	const scopeArg = scope === 'remote' ? '--remote' : '--local';
	const result = await new Promise((resolve) => {
		const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'kv', 'key', 'get', STATION_IDS_KV_KEY, '--binding', binding, scopeArg], {
			cwd: process.cwd(),
			env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(process.cwd(), '.wrangler-config') },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (c) => { stdout += c; });
		child.stderr.on('data', (c) => { stderr += c; });
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
	const stdout = (result.stdout || '').trim();
	const combined = `${stdout}\n${result.stderr || ''}`.toLowerCase();
	if (/value not found|key .* does not exist|key not found/.test(combined)) return '';
	if (result.code !== 0) return '';
	return stdout;
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function printHelp() {
	console.log(`Usage: node scripts/discover-neighbors.mjs [options]

Discovers nearby Weather Underground PWS for each primary station and writes
a cached neighbor map to data/neighbors.json.

Options:
  --stations <ids>       Comma-separated primary station IDs (default: read from KV weather:config:station-ids)
  --kv-remote            Read station IDs from remote KV instead of local (default: local)
  --local-only           Skip remote KV write (default: write local + remote KV)
  --out <path>           Also write a debug JSON copy to this path (default: KV only)
  --out <path>           Output JSON path (default: data/neighbors.json)
  --max-distance-mi <n>  Filter neighbors farther than this distance
  --include-self         Keep the primary station itself in its neighbor list
  --require-qc=0         Skip the qcStatus===1 filter (default: filter on)
  --delay-ms <n>         Delay between API calls (default: 250)
  --api-key <key>        WU API key (default: WU_API_KEY env or .dev.vars)
  --env <path>           Path to .dev.vars (default: .dev.vars)
`);
}
