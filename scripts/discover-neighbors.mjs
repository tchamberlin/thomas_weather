#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
	DEFAULT_BINDING,
	STATION_IDS_KV_KEY,
	cleanSecret,
	expandNear,
	fail,
	fetchCurrent,
	fetchNear,
	parseArgs,
	readDevVars,
	readKvKey,
	readStationIdsFromKv,
	sleep,
} from './lib/wu.mjs';

const NEIGHBORS_KV_KEY = 'weather:config:neighbors';

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
const merge = args.merge === '1' || args.merge === true;
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

// In --merge mode, seed from the existing KV map so we only re-fetch the
// stations passed in this run and leave every other station's data intact.
let baseStations = {};
if (merge) {
	const existingRaw = await readKvKey(NEIGHBORS_KV_KEY, kvScope);
	if (existingRaw) {
		try {
			baseStations = JSON.parse(existingRaw).stations ?? {};
			console.log(`Merging into ${Object.keys(baseStations).length} existing station(s) from ${kvScope} KV.`);
		} catch {
			console.warn(`Could not parse existing ${NEIGHBORS_KV_KEY}; writing a fresh map.`);
		}
	}
}

const result = {
	generatedAt: new Date().toISOString(),
	stations: { ...baseStations },
};

for (const primary of primaries) {
	console.log(`\n→ ${primary}`);
	const obs = await fetchCurrent(primary, apiKey);
	if (!obs) {
		console.warn(`  skip: could not fetch current obs`);
		continue;
	}
	const { lat, lon } = obs;
	console.log(`  origin: ${lat}, ${lon} (${obs.neighborhood ?? '?'})`);

	await sleep(delayMs);
	const near = await fetchNear(lat, lon, apiKey);
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

function printHelp() {
	console.log(`Usage: node scripts/discover-neighbors.mjs [options]

Discovers nearby Weather Underground PWS for each primary station and writes
a cached neighbor map to data/neighbors.json.

Options:
  --stations <ids>       Comma-separated primary station IDs (default: read from KV weather:config:station-ids)
  --kv-remote            Read station IDs (and --merge base) from remote KV (default: local)
  --merge                Update only --stations in the existing neighbors map (default: rebuild whole map)
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
