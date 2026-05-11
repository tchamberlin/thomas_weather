#!/usr/bin/env node

/*
 * Add a new PWS to this deployment in one command.
 *
 * Steps:
 *   1. Backfill ~31 days of hourly history for the station into data/wunderground/<id>/hourly.
 *   2. Upload those blocks to local Wrangler KV.
 *   3. Upload those blocks to remote Cloudflare KV.
 *   4. Read the canonical station-ids list from remote KV, append <id>, write back
 *      to remote KV and local KV. (KV is the sole source of truth.)
 *
 * Usage:
 *   npm run add-station -- --station KVALAKEF29
 *   npm run add-station -- --station KVALAKEF29 --max-blocks 1 --local-only
 */

import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const STATION_IDS_KV_KEY = 'weather:config:station-ids';
const DEFAULT_BINDING = 'WEATHER';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printHelp();
	process.exit(0);
}

const stationId = clean(args.station);
if (!stationId) fail('Missing --station. Pass --station <stationId>.');
if (!/^[A-Za-z0-9]{3,32}$/.test(stationId)) fail(`Invalid station id: ${stationId}`);

const maxBlocks = args.maxBlocks ?? '1';
const binding = args.binding ?? DEFAULT_BINDING;
const localOnly = Boolean(args.localOnly);
const skipBackfill = Boolean(args.skipBackfill);
const skipUpload = Boolean(args.skipUpload);
const skipNeighbors = Boolean(args.skipNeighbors);
const dryRun = Boolean(args.dryRun);

console.log(`Adding station: ${stationId}`);
console.log(`Mode: ${localOnly ? 'local-only' : 'local + remote'}${dryRun ? ' (dry-run)' : ''}`);
console.log('');

if (!skipBackfill) {
	console.log(`Step 1/4: backfill history (--max-blocks ${maxBlocks})`);
	await run('node', ['scripts/backfill-history.mjs', '--station', stationId, '--max-blocks', String(maxBlocks)]);
} else {
	console.log('Step 1/4: backfill skipped (--skip-backfill)');
}

if (!skipUpload) {
	console.log('');
	console.log('Step 2/4: upload blocks to local KV');
	await run('node', ['scripts/upload-history-kv.mjs', '--station', stationId, '--local']);

	if (!localOnly) {
		console.log('');
		console.log('Step 3/4: upload blocks to remote KV');
		await run('node', ['scripts/upload-history-kv.mjs', '--station', stationId, '--remote', '--yes']);
	} else {
		console.log('');
		console.log('Step 3/4: remote upload skipped (--local-only)');
	}
} else {
	console.log('');
	console.log('Steps 2-3/4: uploads skipped (--skip-upload)');
}

console.log('');
console.log('Step 4/5: update station-ids in KV');
await updateStationIds(stationId);

console.log('');
console.log('Step 5/5: regenerate neighbors -> KV');
if (skipNeighbors) {
	console.log('  skipped (--skip-neighbors)');
} else {
	const neighborArgs = ['scripts/discover-neighbors.mjs'];
	if (localOnly) neighborArgs.push('--local-only');
	await run('node', neighborArgs);
}

console.log('');
console.log(`Done. ${stationId} added.`);
if (!localOnly && !skipNeighbors) {
	console.log('Remember: deploy is no longer required for neighbor data (KV is read at runtime).');
}

async function updateStationIds(newId) {
	const localList = await readStationIdsFrom('local');
	const remoteList = localOnly ? null : await readStationIdsFrom('remote');

	const seed = pickSeed([remoteList, localList]);
	const merged = mergeUnique(seed, [newId]);
	const value = merged.join(',');

	console.log(`  seed (${seed.length}): ${seed.join(',') || '<empty>'}`);
	console.log(`  next (${merged.length}): ${value}`);

	if (dryRun) {
		console.log('  dry-run: not writing.');
		return;
	}

	await writeStationIdsTo('local', value);
	if (!localOnly) await writeStationIdsTo('remote', value);
}

async function readStationIdsFrom(scope) {
	const scopeArg = scope === 'remote' ? '--remote' : '--local';
	const result = await runWrangler(['kv', 'key', 'get', STATION_IDS_KV_KEY, '--binding', binding, scopeArg], { capture: true, allowFail: true });
	const stdout = (result.stdout || '').trim();
	const stderr = (result.stderr || '').trim();
	const combined = `${stdout}\n${stderr}`.toLowerCase();
	if (/value not found|key .* does not exist|key not found/.test(combined)) {
		return [];
	}
	if (result.code !== 0) {
		console.warn(`  warn: failed to read ${scope} KV (${result.code}): ${stderr}`);
		return null;
	}
	return parseList(stdout);
}

async function writeStationIdsTo(scope, value) {
	const scopeArg = scope === 'remote' ? '--remote' : '--local';
	const argv = ['kv', 'key', 'put', STATION_IDS_KV_KEY, value, '--binding', binding, scopeArg];
	const result = await runWrangler(argv, { capture: true });
	if (result.code !== 0) {
		throw new Error(`wrangler kv key put (${scope}) failed: ${result.stderr || result.stdout}`);
	}
	console.log(`  ${scope} KV: PUT ${STATION_IDS_KV_KEY} = ${value}`);
}

function pickSeed(candidates) {
	for (const list of candidates) {
		if (Array.isArray(list) && list.length > 0) return list;
	}
	return [];
}

function mergeUnique(existing, additions) {
	const seen = new Set();
	const out = [];
	for (const id of [...existing, ...additions]) {
		const trimmed = clean(id);
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		out.push(trimmed);
	}
	return out;
}

function parseList(raw) {
	return clean(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function clean(value) {
	if (value === undefined || value === null) return '';
	const trimmed = String(value).trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function run(cmd, argv) {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, argv, { stdio: 'inherit', cwd: process.cwd(), env: process.env });
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}`));
		});
	});
}

function runWrangler(argv, options = {}) {
	return new Promise((resolve) => {
		const capture = options.capture !== false;
		const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', ...argv], {
			cwd: process.cwd(),
			env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(process.cwd(), '.wrangler-config') },
			stdio: ['ignore', capture ? 'pipe' : 'inherit', capture ? 'pipe' : 'inherit'],
		});
		let stdout = '';
		let stderr = '';
		if (capture) {
			child.stdout.on('data', (c) => { stdout += c; });
			child.stderr.on('data', (c) => { stderr += c; });
		}
		child.on('close', (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
}

function parseArgs(argv) {
	const parsed = {};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') { parsed.help = true; continue; }
		if (!arg.startsWith('--')) fail(`Unexpected argument: ${arg}`);
		const eq = arg.indexOf('=');
		if (eq !== -1) { parsed[toCamel(arg.slice(2, eq))] = arg.slice(eq + 1); continue; }
		const key = toCamel(arg.slice(2));
		const next = argv[i + 1];
		if (!next || next.startsWith('--')) { parsed[key] = true; continue; }
		parsed[key] = next;
		i += 1;
	}
	return parsed;
}

function toCamel(s) {
	return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function fail(msg) {
	console.error(`Error: ${msg}`);
	process.exit(1);
}

function printHelp() {
	console.log(`Usage:
  npm run add-station -- --station <id> [options]

Backfills ~31 days of hourly history for a new PWS, uploads to KV (local + remote),
and appends the station to the canonical station-ids list in KV.

Options:
  --station <id>      PWS station ID (required).
  --max-blocks N      Number of 31-day backfill blocks (default: 1, ~31 days).
  --binding NAME      KV binding name (default: WEATHER).
  --local-only        Skip remote KV upload and remote station-ids update.
  --skip-backfill     Skip step 1 (history backfill).
  --skip-upload       Skip steps 2-3 (KV uploads).
  --skip-neighbors    Skip step 5 (neighbor regeneration).
  --dry-run           Print station-ids changes without writing.

Examples:
  npm run add-station -- --station KVALAKEF29
  npm run add-station -- --station KVALAKEF29 --max-blocks 3
  npm run add-station -- --station KVALAKEF29 --local-only
`);
}
