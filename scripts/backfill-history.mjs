#!/usr/bin/env node

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const API_BASE = 'https://api.weather.com';
const MAX_RANGE_DAYS = 31;

const args = parseArgs(process.argv.slice(2));
const dotEnv = await readDevVars(args.env ?? '.dev.vars');
const apiKey = cleanSecret(args.apiKey ?? process.env.WU_API_KEY ?? dotEnv.WU_API_KEY);
const stationId = cleanSecret(args.station);
const endpoint = args.endpoint ?? 'hourly';
const outDir = args.out ?? 'data/wunderground';
const units = args.units ?? 'e';
const delayMs = Number(args.delayMs ?? 250);
const maxBlocks = args.maxBlocks === undefined ? Number.POSITIVE_INFINITY : Number(args.maxBlocks);
const emptyStop = Number(args.emptyStop ?? 2);
const endDate = args.end ?? dateToYmd(addUtcDays(new Date(), -1));
const startDate = args.start;
const direction = startDate ? 'forward' : 'backward';

if (args.help) {
	printHelp();
	process.exit(0);
}

if (!apiKey) {
	fail('Missing WU_API_KEY. Set env var or .dev.vars.');
}
if (!stationId) {
	fail('Missing --station. Pass --station <stationId>.');
}

if (!['hourly', 'daily'].includes(endpoint)) {
	fail('--endpoint must be hourly or daily. Use hourly for finest historical granularity.');
}

if (!isYmd(endDate) || (startDate && !isYmd(startDate))) {
	fail('--start and --end must be YYYYMMDD.');
}

await mkdir(outputRoot(), { recursive: true });

const manifestPath = path.join(outputRoot(), 'manifest.json');
const manifest = {
	stationId,
	endpoint,
	units,
	startDate: startDate ?? null,
	endDate,
	direction,
	startedAt: new Date().toISOString(),
	finishedAt: null,
	blocks: [],
};

let blocksFetched = 0;
let recordsFetched = 0;
let emptyBlocks = 0;

console.log(`Station: ${stationId}`);
console.log(`Endpoint: /v2/pws/history/${endpoint}`);
console.log(`Output: ${outputRoot()}`);
const blockLimitLabel = Number.isFinite(maxBlocks) ? `up to ${maxBlocks} block${maxBlocks === 1 ? '' : 's'} (~${maxBlocks * MAX_RANGE_DAYS} days)` : 'until empty/error';
console.log(`Mode: ${direction}${startDate ? ` ${startDate}..${endDate}` : ` from ${endDate}`} (${blockLimitLabel})`);
console.log('');

if (direction === 'forward') {
	let cursor = startDate;
	while (cursor <= endDate && blocksFetched < maxBlocks) {
		const blockEnd = minYmd(dateToYmd(addUtcDays(ymdToDate(cursor), MAX_RANGE_DAYS - 1)), endDate);
		const result = await fetchAndStoreBlock(cursor, blockEnd);
		blocksFetched += 1;
		recordsFetched += result.count;
		manifest.blocks.push(result);
		await writeManifest(manifestPath, manifest);
		cursor = dateToYmd(addUtcDays(ymdToDate(blockEnd), 1));
		await sleep(delayMs);
	}
} else {
	let blockEnd = endDate;
	while (blocksFetched < maxBlocks) {
		const blockStart = dateToYmd(addUtcDays(ymdToDate(blockEnd), -MAX_RANGE_DAYS + 1));
		const result = await fetchAndStoreBlock(blockStart, blockEnd);
		blocksFetched += 1;
		recordsFetched += result.count;
		manifest.blocks.push(result);
		await writeManifest(manifestPath, manifest);

		if (result.count === 0) {
			emptyBlocks += 1;
			if (emptyBlocks >= emptyStop) break;
		} else {
			emptyBlocks = 0;
		}

		blockEnd = dateToYmd(addUtcDays(ymdToDate(blockStart), -1));
		await sleep(delayMs);
	}
}

manifest.finishedAt = new Date().toISOString();
await writeManifest(manifestPath, manifest);

console.log('');
console.log(`Done. Blocks: ${blocksFetched}. Records: ${recordsFetched}.`);
console.log(`Manifest: ${manifestPath}`);

async function fetchAndStoreBlock(start, end) {
	const filePath = blockPath(start, end);
	const existing = await existingBlock(filePath);
	if (existing) {
		console.log(`SKIP ${start}..${end} ${existing.count} records ${filePath}`);
		return { startDate: start, endDate: end, count: existing.count, bytes: existing.bytes, file: filePath, skipped: true };
	}

	const url = new URL(`${API_BASE}/v2/pws/history/${endpoint}`);
	url.searchParams.set('stationId', stationId);
	url.searchParams.set('format', 'json');
	url.searchParams.set('units', units);
	url.searchParams.set('numericPrecision', 'decimal');
	url.searchParams.set('startDate', start);
	url.searchParams.set('endDate', end);
	url.searchParams.set('apiKey', apiKey);

	const redacted = new URL(url.toString());
	redacted.searchParams.set('apiKey', `<redacted:${apiKey.length}>`);
	console.log(`GET ${start}..${end}`);
	console.log(`  ${redacted.toString()}`);

	const res = await fetch(url, { headers: { Accept: 'application/json' } });
	const text = await res.text();
	if (!res.ok) {
		const errorPath = filePath.replace(/\.json$/, `.error-${res.status}.txt`);
		await writeFile(errorPath, text);
		throw new Error(`Weather API returned ${res.status}. Body saved to ${errorPath}`);
	}

	const body = parseJson(text);
	const count = Array.isArray(body.observations) ? body.observations.length : 0;
	await mkdir(path.dirname(filePath), { recursive: true });
	await writeFile(filePath, `${JSON.stringify(body, null, 2)}\n`);
	const bytes = Buffer.byteLength(text);
	console.log(`  wrote ${count} records, ${bytes} raw bytes -> ${filePath}`);
	return { startDate: start, endDate: end, count, bytes, file: filePath, skipped: false };
}

async function existingBlock(filePath) {
	try {
		const info = await stat(filePath);
		const body = parseJson(await readFile(filePath, 'utf8'));
		return { bytes: info.size, count: Array.isArray(body.observations) ? body.observations.length : 0 };
	} catch {
		return null;
	}
}

function blockPath(start, end) {
	return path.join(outputRoot(), `${start}_${end}.json`);
}

function outputRoot() {
	return path.join(outDir, stationId, endpoint);
}

async function writeManifest(filePath, value) {
	await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch (err) {
		throw new Error(`Invalid JSON response: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function cleanSecret(value) {
	if (!value) return '';
	const trimmed = String(value).trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function isYmd(value) {
	return /^\d{8}$/.test(value) && dateToYmd(ymdToDate(value)) === value;
}

function ymdToDate(value) {
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	return new Date(Date.UTC(year, month - 1, day));
}

function dateToYmd(date) {
	return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function addUtcDays(date, days) {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function minYmd(a, b) {
	return a < b ? a : b;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function printHelp() {
	console.log(`Usage:
  npm run backfill:history -- [options]

Defaults to hourly history, raw/all fields, backward from yesterday until two empty blocks.

Options:
  --start YYYYMMDD       Start date. If provided, runs forward to --end.
  --end YYYYMMDD         End date. Default: yesterday UTC.
  --endpoint hourly|daily
  --station KVALAKEF29   PWS station ID (required).
  --out DIR              Default: data/wunderground.
  --max-blocks N         Limit number of 31-day requests for testing.
  --empty-stop N         Backward mode stops after N empty blocks. Default: 2.
  --delay-ms N           Delay between requests. Default: 250.
  --env FILE             Default: .dev.vars.

Examples:
  npm run backfill:history -- --max-blocks 1
  npm run backfill:history -- --start 20250101 --end 20250131
  npm run backfill:history -- --end 20260509 --max-blocks 12
`);
}
