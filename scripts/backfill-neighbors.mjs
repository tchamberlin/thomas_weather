#!/usr/bin/env node

/**
 * Wrapper that runs scripts/backfill-history.mjs for each neighbor of a
 * primary station. Reads data/neighbors.json for the neighbor list and the
 * primary's existing manifest to clamp the start date.
 *
 * Usage:
 *   node scripts/backfill-neighbors.mjs --primary KVALAKEF29 [--endpoint hourly|daily]
 *
 * Forwards relevant flags through to backfill-history.mjs.
 */

import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printHelp();
	process.exit(0);
}

const primary = args.primary;
if (!primary) fail('Missing --primary <stationId>.');

const endpoint = args.endpoint ?? 'hourly';
const neighborsPath = args.neighborsFile ?? 'data/neighbors.json';
const outDir = args.out ?? 'data/wunderground';
const delayMs = args.delayMs;
const maxBlocks = args.maxBlocks;
const emptyStop = args.emptyStop;
const explicitStart = args.start;
const explicitEnd = args.end;
const dryRun = args.dryRun === '1';

const neighborsData = JSON.parse(await readFile(neighborsPath, 'utf8'));
const entry = neighborsData.stations?.[primary];
if (!entry) fail(`No neighbor entry for primary ${primary} in ${neighborsPath}.`);
const neighbors = entry.neighbors.filter((n) => n.stationId !== primary);
if (neighbors.length === 0) fail(`No neighbors listed for ${primary}.`);

let startDate = explicitStart;
if (!startDate) {
	startDate = await deriveStartFromPrimaryManifest(primary, endpoint);
	if (!startDate) {
		fail(
			`Could not derive --start from primary manifest at ${primaryManifestPath(primary, endpoint)}. ` +
				`Pass --start YYYYMMDD explicitly.`,
		);
	}
	console.log(`Clamping start to primary's earliest data: ${startDate}`);
}

console.log(`Primary: ${primary}`);
console.log(`Endpoint: ${endpoint}`);
console.log(`Start: ${startDate}${explicitEnd ? `  End: ${explicitEnd}` : ''}`);
console.log(`Neighbors: ${neighbors.map((n) => n.stationId).join(', ')}`);
console.log('');

let okCount = 0;
let failCount = 0;
for (const n of neighbors) {
	console.log(`\n=== ${n.stationId} (${n.distanceMi?.toFixed(2) ?? '?'} mi) ===`);
	if (dryRun) {
		console.log('  [dry-run] would spawn backfill-history.mjs');
		continue;
	}
	try {
		await runBackfill(n.stationId);
		okCount += 1;
	} catch (err) {
		failCount += 1;
		console.warn(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log(`\nDone. ${okCount} ok, ${failCount} failed.`);

async function runBackfill(stationId) {
	const argv = [
		path.join('scripts', 'backfill-history.mjs'),
		'--station',
		stationId,
		'--endpoint',
		endpoint,
		'--start',
		startDate,
		'--out',
		outDir,
	];
	if (explicitEnd) argv.push('--end', explicitEnd);
	if (delayMs !== undefined) argv.push('--delay-ms', delayMs);
	if (maxBlocks !== undefined) argv.push('--max-blocks', maxBlocks);
	if (emptyStop !== undefined) argv.push('--empty-stop', emptyStop);
	if (args.env) argv.push('--env', args.env);

	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, argv, { stdio: 'inherit' });
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`backfill-history.mjs exited with code ${code}`));
		});
		child.on('error', reject);
	});
}

function primaryManifestPath(stationId, ep) {
	return path.join(outDir, stationId, ep, 'manifest.json');
}

async function deriveStartFromPrimaryManifest(stationId, ep) {
	try {
		const manifest = JSON.parse(await readFile(primaryManifestPath(stationId, ep), 'utf8'));
		const dates = (manifest.blocks ?? [])
			.filter((b) => (b.count ?? 0) > 0)
			.map((b) => b.startDate)
			.filter(Boolean);
		if (dates.length === 0) return null;
		return dates.sort()[0];
	} catch {
		return null;
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

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function printHelp() {
	console.log(`Usage: node scripts/backfill-neighbors.mjs --primary <stationId> [options]

Runs scripts/backfill-history.mjs for each neighbor of <primary>, clamped to
the primary's earliest backfilled date.

Options:
  --primary <id>         Primary station whose neighbors to backfill (required)
  --endpoint <hourly|daily>  Default: hourly
  --start <YYYYMMDD>     Override start date (default: derive from primary manifest)
  --end <YYYYMMDD>       Override end date (default: yesterday, via backfill-history)
  --neighbors-file <path>  Default: data/neighbors.json
  --out <path>           Output root (default: data/wunderground)
  --delay-ms <n>         Forwarded to backfill-history
  --max-blocks <n>       Forwarded to backfill-history
  --empty-stop <n>       Forwarded to backfill-history
  --env <path>           Forwarded to backfill-history
  --dry-run              Print what would run without spawning
`);
}
