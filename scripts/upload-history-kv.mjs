#!/usr/bin/env node

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const args = parseArgs(process.argv.slice(2));
const stationId = args.station;
const endpoint = args.endpoint ?? 'hourly';
const inDir = args.in ?? 'data/wunderground';
const binding = args.binding ?? 'WEATHER';
const mode = args.local ? 'local' : args.remote ? 'remote' : 'local';
const dryRun = Boolean(args.dryRun);
const force = Boolean(args.force);
const includeEmpty = Boolean(args.includeEmpty);
const persistTo = args.persistTo;

if (args.help) {
	printHelp();
	process.exit(0);
}

if (!stationId) fail('Missing --station. Pass --station <stationId>.');
if (endpoint !== 'hourly') fail('Only --endpoint hourly is supported for raw KV history upload right now.');
if (mode === 'remote' && !args.yes) fail('Remote upload requires --yes.');

const root = path.join(inDir, stationId, endpoint);
const blocks = await readBlocks(root);
if (blocks.length === 0) fail(`No block files found in ${root}. Run npm run backfill:history first.`);

const uploadedAt = new Date().toISOString();
const nonEmptyBlocks = blocks.filter((block) => block.records > 0 || includeEmpty);
if (nonEmptyBlocks.length === 0) fail(`No non-empty block files found in ${root}. Pass --include-empty to upload empty API responses.`);

const index = {
	stationId,
	endpoint,
	earliestDate: ymdToIsoDate(nonEmptyBlocks[0].startDate),
	latestDate: ymdToIsoDate(nonEmptyBlocks.at(-1).endDate),
	blocksStored: nonEmptyBlocks.length,
	recordsStored: nonEmptyBlocks.reduce((sum, block) => sum + block.records, 0),
	updatedAt: uploadedAt,
};

const uploadManifest = {
	stationId,
	endpoint,
	mode,
	dryRun,
	force,
	includeEmpty,
	startedAt: uploadedAt,
	finishedAt: null,
	blocks: [],
	index,
};

console.log(`Station: ${stationId}`);
console.log(`Input: ${root}`);
console.log(`KV binding: ${binding}`);
console.log(`Mode: ${mode}${dryRun ? ' dry-run' : ''}`);
console.log(`Blocks: ${nonEmptyBlocks.length} stored (${blocks.length - nonEmptyBlocks.length} empty skipped), records: ${index.recordsStored}`);
console.log('');

for (const block of blocks) {
	if (block.records === 0 && !includeEmpty) {
		console.log(`SKIP EMPTY ${block.startDate}..${block.endDate}`);
		uploadManifest.blocks.push({
			startDate: block.startDate,
			endDate: block.endDate,
			records: block.records,
			bytes: block.bytes,
			file: block.file,
			skipped: true,
			reason: 'empty',
		});
		continue;
	}

	const key = historyBlockKey(stationId, block.startDate, block.endDate);
	const metadata = {
		stationId,
		endpoint,
		startDate: block.startDate,
		endDate: block.endDate,
		records: block.records,
		sourceFile: block.file,
		uploadedAt,
	};
	const entry = { ...metadata, kvKey: key, bytes: block.bytes, skipped: false };

	if (!force && await remoteKeyExists(key)) {
		entry.skipped = true;
		console.log(`SKIP ${key}`);
		uploadManifest.blocks.push(entry);
		continue;
	}

	console.log(`${dryRun ? 'WOULD PUT' : 'PUT'} ${key} (${block.records} records, ${block.bytes} bytes)`);
	if (!dryRun) {
		await wranglerKvPut(key, { path: block.file, metadata });
	}
	uploadManifest.blocks.push(entry);
}

const indexKey = historyIndexKey(stationId);
console.log(`${dryRun ? 'WOULD PUT' : 'PUT'} ${indexKey}`);
if (!dryRun) {
	const tempIndex = path.join(root, '.upload-index.json');
	await writeFile(tempIndex, `${JSON.stringify(index, null, 2)}\n`);
	await wranglerKvPut(indexKey, { path: tempIndex });
}

uploadManifest.finishedAt = new Date().toISOString();
await writeFile(path.join(root, 'upload-manifest.json'), `${JSON.stringify(uploadManifest, null, 2)}\n`);
console.log('');
console.log(`Upload manifest: ${path.join(root, 'upload-manifest.json')}`);

async function readBlocks(rootDir) {
	const files = await readdir(rootDir);
	const blocks = [];
	for (const fileName of files) {
		const match = /^(\d{8})_(\d{8})\.json$/.exec(fileName);
		if (!match) continue;
		const file = path.join(rootDir, fileName);
		const raw = await readFile(file, 'utf8');
		const parsed = JSON.parse(raw);
		const info = await stat(file);
		blocks.push({
			startDate: match[1],
			endDate: match[2],
			file,
			bytes: info.size,
			records: Array.isArray(parsed.observations) ? parsed.observations.length : 0,
		});
	}
	return blocks.sort((a, b) => a.startDate.localeCompare(b.startDate));
}

async function remoteKeyExists(key) {
	if (dryRun || force) return false;
	const result = await runWrangler(['kv', 'key', 'get', key, '--binding', binding, ...wranglerScopeArgs()], { capture: true });
	return result.code === 0;
}

async function wranglerKvPut(key, options) {
	const cmd = ['kv', 'key', 'put', key, '--binding', binding, '--path', options.path, ...wranglerScopeArgs()];
	if (options.metadata) {
		cmd.push('--metadata', JSON.stringify(options.metadata));
	}
	const result = await runWrangler(cmd, { capture: true });
	if (result.code !== 0) {
		throw new Error(`wrangler ${cmd.join(' ')} failed:\n${result.stderr || result.stdout}`);
	}
}

function wranglerScopeArgs() {
	const scope = [];
	if (mode === 'remote') scope.push('--remote');
	if (mode === 'local') scope.push('--local');
	if (persistTo) scope.push('--persist-to', persistTo);
	return scope;
}

function runWrangler(argv, options = { capture: true }) {
	return new Promise((resolve) => {
		const capture = options.capture !== false;
		const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', ...argv], {
			cwd: process.cwd(),
			env: { ...process.env, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? path.join(process.cwd(), '.wrangler-config') },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let stdout = '';
		let stderr = '';
		if (capture) {
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
		}
		child.on('close', (code) => {
			resolve({ code: code ?? 1, stdout, stderr });
		});
	});
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
			parsed[key] = true;
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

function historyBlockKey(station, startDate, endDate) {
	return `weather:history:hourly:raw:${station}:${startDate}:${endDate}`;
}

function historyIndexKey(station) {
	return `weather:history:hourly:raw:${station}:index`;
}

function ymdToIsoDate(value) {
	return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function printHelp() {
	console.log(`Usage:
  npm run upload:history-kv -- [options]

Uploads local raw hourly history blocks into Workers KV.

Options:
  --station KVALAKEF29   PWS station ID (required).
  --in DIR               Default: data/wunderground.
  --binding WEATHER     KV binding name. Default: WEATHER.
  --local                Upload to local Wrangler KV storage. Default.
  --remote --yes         Upload to remote Cloudflare KV namespace.
  --dry-run              Print planned writes without writing.
  --force                Re-upload keys even if they already exist.
  --include-empty        Upload 0-record API responses. Default: skip.
  --persist-to DIR       Wrangler local KV persistence directory.

Examples:
  npm run upload:history-kv -- --dry-run
  npm run upload:history-kv --
  npm run upload:history-kv -- --remote --yes
`);
}
