#!/usr/bin/env node

/*
 * Scout for new PWS to track.
 *
 * Given a coordinate (or an existing station to anchor on), list nearby
 * Weather Underground PWS ranked by distance. Pure discovery: prints a table
 * and writes nothing. Stations already in the tracked station-ids list are
 * annotated so you can spot genuinely new candidates, then hand the IDs you
 * want to `npm run add-station`.
 *
 * Usage:
 *   npm run find-pws -- --geocode "47.61,-122.33"
 *   npm run find-pws -- --near-station KVALAKEF29 --max-distance-mi 5
 *   npm run find-pws -- --geocode "47.61,-122.33" --new-only
 */

import process from 'node:process';

import {
	cleanSecret,
	expandNear,
	fail,
	fetchCurrent,
	fetchNear,
	parseArgs,
	readDevVars,
	readStationIdsFromKv,
} from './lib/wu.mjs';

const args = parseArgs(process.argv.slice(2));
if (args.help) {
	printHelp();
	process.exit(0);
}

const dotEnv = await readDevVars(args.env ?? '.dev.vars');
const apiKey = cleanSecret(args.apiKey ?? process.env.WU_API_KEY ?? dotEnv.WU_API_KEY);
if (!apiKey) fail('Missing WU_API_KEY. Set env var or .dev.vars.');

const geocode = cleanSecret(args.geocode);
const nearStation = cleanSecret(args.nearStation);
if (!geocode && !nearStation) fail('Pass --geocode "lat,lon" or --near-station <stationId>.');
if (geocode && nearStation) fail('Pass only one of --geocode or --near-station.');

const maxDistanceMi = args.maxDistanceMi === undefined ? null : Number(args.maxDistanceMi);
const requireQc = args.requireQc !== '0';
const newOnly = args.newOnly === '1' || args.newOnly === true;
const kvScope = args.kvRemote ? 'remote' : 'local';

// Resolve the origin coordinate.
let lat;
let lon;
let originLabel;
if (geocode) {
	const parts = geocode.split(',').map((p) => Number(p.trim()));
	if (parts.length !== 2 || parts.some((n) => !Number.isFinite(n))) {
		fail(`Invalid --geocode: ${geocode}. Expected "lat,lon".`);
	}
	[lat, lon] = parts;
	originLabel = `${lat}, ${lon}`;
} else {
	const obs = await fetchCurrent(nearStation, apiKey);
	if (!obs) fail(`Could not fetch current obs for ${nearStation}.`);
	({ lat, lon } = obs);
	originLabel = `${nearStation} → ${lat}, ${lon} (${obs.neighborhood ?? '?'})`;
}

console.log(`Origin: ${originLabel}`);

const near = await fetchNear(lat, lon, apiKey);
if (!near) fail('location/near request failed.');

// Tracked set, so we can flag (or hide) PWS already in the KV.
const trackedRaw = await readStationIdsFromKv(kvScope);
const tracked = new Set(
	trackedRaw.split(',').map((s) => s.trim()).filter(Boolean),
);

let stations = expandNear(near)
	.filter((s) => !requireQc || s.qcStatus === 1)
	.filter((s) => maxDistanceMi === null || s.distanceMi <= maxDistanceMi)
	.sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));

if (newOnly) stations = stations.filter((s) => !tracked.has(s.stationId));

if (stations.length === 0) {
	console.log('No matching stations.');
	process.exit(0);
}

console.log(`\n${stations.length} station(s)${newOnly ? ' (new only)' : ''}:\n`);
for (const s of stations) {
	const mark = tracked.has(s.stationId) ? ' [tracked]' : '';
	const dist = (s.distanceMi ?? 0).toFixed(2).padStart(6);
	console.log(`  ${s.stationId.padEnd(14)} ${dist}mi  ${s.name ?? ''}${mark}`);
}

const candidates = stations.filter((s) => !tracked.has(s.stationId)).map((s) => s.stationId);
if (candidates.length > 0 && !newOnly) {
	console.log(`\n${candidates.length} not yet tracked. Add one with:`);
	console.log(`  npm run add-station -- --station ${candidates[0]}`);
}

function printHelp() {
	console.log(`Usage: node scripts/find-pws.mjs [options]

Lists nearby Weather Underground PWS for a coordinate, ranked by distance.
Discovery only — writes nothing. Stations already in the tracked station-ids
list are marked [tracked].

Options:
  --geocode "lat,lon"     Origin coordinate to search around
  --near-station <id>     Use an existing station's coordinates as the origin
  --max-distance-mi <n>   Drop stations farther than this distance
  --require-qc=0          Skip the qcStatus===1 filter (default: filter on)
  --new-only              Show only stations not already tracked
  --kv-remote             Read tracked station-ids from remote KV (default: local)
  --api-key <key>         WU API key (default: WU_API_KEY env or .dev.vars)
  --env <path>            Path to .dev.vars (default: .dev.vars)
`);
}
