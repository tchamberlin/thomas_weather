#!/usr/bin/env node

/**
 * Wrapper that runs scripts/upload-history-kv.mjs for each neighbor of a
 * primary station. Reads data/neighbors.json for the neighbor list.
 *
 * Usage:
 *   node scripts/upload-neighbors-kv.mjs --primary KVALAKEF29 [--remote --yes]
 *
 * Forwards relevant flags through to upload-history-kv.mjs.
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

const neighborsPath = args.neighborsFile ?? 'data/neighbors.json';
const neighborsData = JSON.parse(await readFile(neighborsPath, 'utf8'));
const entry = neighborsData.stations?.[primary];
if (!entry) fail(`No neighbor entry for primary ${primary} in ${neighborsPath}.`);
const neighbors = entry.neighbors.filter((n) => n.stationId !== primary);
if (neighbors.length === 0) fail(`No neighbors listed for ${primary}.`);

const passthrough = ['endpoint', 'in', 'binding', 'persistTo'];
const flagPassthrough = ['local', 'remote', 'yes', 'dryRun', 'force', 'includeEmpty'];

console.log(`Primary: ${primary}`);
console.log(`Neighbors: ${neighbors.map((n) => n.stationId).join(', ')}`);

let okCount = 0;
let failCount = 0;
for (const n of neighbors) {
	console.log(`\n=== ${n.stationId} ===`);
	try {
		await runUpload(n.stationId);
		okCount += 1;
	} catch (err) {
		failCount += 1;
		console.warn(`  FAILED: ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log(`\nDone. ${okCount} ok, ${failCount} failed.`);

async function runUpload(stationId) {
	const argv = [path.join('scripts', 'upload-history-kv.mjs'), '--station', stationId];
	for (const k of passthrough) {
		if (args[k] !== undefined) argv.push(`--${camelToFlag(k)}`, args[k]);
	}
	for (const k of flagPassthrough) {
		if (args[k] === '1') argv.push(`--${camelToFlag(k)}`);
	}
	await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, argv, { stdio: 'inherit' });
		child.on('exit', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`upload-history-kv.mjs exited with code ${code}`));
		});
		child.on('error', reject);
	});
}

function camelToFlag(s) {
	return s.replace(/([A-Z])/g, (_, c) => `-${c.toLowerCase()}`);
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
	console.log(`Usage: node scripts/upload-neighbors-kv.mjs --primary <stationId> [options]

Runs scripts/upload-history-kv.mjs for each neighbor of <primary>.

Options:
  --primary <id>           Primary station whose neighbors to upload (required)
  --neighbors-file <path>  Default: data/neighbors.json
  --endpoint <hourly>      Default: hourly (only supported value)
  --in <path>              Forwarded
  --binding <name>         Forwarded
  --persist-to <path>      Forwarded
  --local / --remote       Forwarded
  --yes                    Required for --remote
  --dry-run / --force / --include-empty   Forwarded
`);
}
