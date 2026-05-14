/*
 * Shared helpers for the Weather Underground CLI scripts.
 *
 * CLI arg parsing, .dev.vars loading, the WU API calls (current obs +
 * location/near), and the station-ids KV read. Anything that more than one
 * script in scripts/ needs lives here.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

export const API_BASE = 'https://api.weather.com';
export const STATION_IDS_KV_KEY = 'weather:config:station-ids';
export const DEFAULT_BINDING = 'WEATHER';

// --- CLI helpers -----------------------------------------------------------

export function parseArgs(argv) {
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

export function toCamel(value) {
	return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

export function cleanSecret(value) {
	if (!value) return '';
	const trimmed = String(value).trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

export function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

export async function readDevVars(filePath) {
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

// --- WU API ----------------------------------------------------------------

export async function fetchCurrent(stationId, apiKey) {
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

export async function fetchNear(lat, lon, apiKey) {
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

export function expandNear(payload) {
	const loc = payload?.location;
	if (!loc) return [];
	const ids = loc.stationId ?? [];
	const rows = ids.map((id, i) => ({
		stationId: id,
		name: loc.stationName?.[i] ?? null,
		lat: loc.latitude?.[i] ?? null,
		lon: loc.longitude?.[i] ?? null,
		distanceKm: loc.distanceKm?.[i] ?? null,
		distanceMi: loc.distanceMi?.[i] ?? null,
		qcStatus: loc.qcStatus?.[i] ?? null,
		updateTimeUtc: loc.updateTimeUtc?.[i] ?? null,
	}));
	// location/near routinely repeats a station across its parallel arrays;
	// keep one row per stationId, preferring the nearest.
	const byId = new Map();
	for (const row of rows) {
		const existing = byId.get(row.stationId);
		if (!existing || (row.distanceMi ?? Infinity) < (existing.distanceMi ?? Infinity)) {
			byId.set(row.stationId, row);
		}
	}
	return [...byId.values()];
}

// --- KV --------------------------------------------------------------------

// Reads a single KV key via wrangler. Returns '' for a missing key or any
// wrangler failure — callers treat both as "nothing there".
export async function readKvKey(key, scope, binding = DEFAULT_BINDING) {
	const scopeArg = scope === 'remote' ? '--remote' : '--local';
	const result = await new Promise((resolve) => {
		const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['wrangler', 'kv', 'key', 'get', key, '--binding', binding, scopeArg], {
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

export function readStationIdsFromKv(scope, binding = DEFAULT_BINDING) {
	return readKvKey(STATION_IDS_KV_KEY, scope, binding);
}
