/**
 * waxwing_wx - PWS rainfall dashboard (Weather Underground)
 *
 * Uses Weather Company / Weather Underground PWS historical daily summaries as
 * the source of truth for daily rainfall. Current conditions are fetched only
 * as a live supplement for today's in-progress reading and last observation.
 *
 * Config via secrets (set with `npx wrangler secret put <NAME>`):
 *   WU_API_KEY      - Weather Underground API key
 *   WU_STATION_IDS  - Comma-separated PWS station IDs (e.g. "KVALAKEF29,KFOO")
 *
 * Routes:
 *   /                          - Station index (placeholder)
 *   /pws/<stationId>           - Redirects to /pws/<stationId>/dashboard
 *   /pws/<stationId>/dashboard            - Per-station dashboard
 *   /pws/<stationId>/rain[/<spec>]        - Rainfall page; spec ∈ today (default) | yesterday | YYYY-MM-DD
 *
 * Optional KV namespace: WEATHER. Used as a cache when the historical API is
 * temporarily unavailable.
 */

import neighborsData from '../data/neighbors.json';

interface NeighborEntry {
	stationId: string;
	name: string | null;
	lat: number | null;
	lon: number | null;
	distanceKm: number | null;
	distanceMi: number | null;
	qcStatus: number | null;
	updateTimeUtc: number | null;
}
interface NeighborsFile {
	generatedAt: string;
	stations: Record<string, { lat: number; lon: number; neighborhood: string | null; neighbors: NeighborEntry[] }>;
}
const NEIGHBORS: NeighborsFile = neighborsData as NeighborsFile;

interface NeighborRainReading {
	stationId: string;
	name: string | null;
	distanceMi: number | null;
	rainfall: number | null;
	error: string | null;
}

interface UnitValues {
	precipTotal?: number;
	precipRate?: number;
	temp?: number;
	tempHigh?: number;
	tempLow?: number;
	tempAvg?: number;
	dewpt?: number;
	dewptHigh?: number;
	dewptLow?: number;
	dewptAvg?: number;
	heatIndex?: number;
	heatindexHigh?: number;
	heatindexLow?: number;
	heatindexAvg?: number;
	windChill?: number;
	windchillHigh?: number;
	windchillLow?: number;
	windchillAvg?: number;
	windSpeed?: number;
	windspeedHigh?: number;
	windspeedLow?: number;
	windspeedAvg?: number;
	windGust?: number | null;
	windgustHigh?: number | null;
	windgustLow?: number | null;
	windgustAvg?: number | null;
	pressure?: number;
	pressureMax?: number | null;
	pressureMin?: number | null;
	pressureTrend?: number | null;
}

interface WUCurrentObservation {
	stationID?: string;
	obsTimeLocal?: string;
	obsTimeUtc?: string;
	tz?: string;
	lat?: number;
	lon?: number;
	humidity?: number;
	realtimeFrequency?: number | null;
	imperial?: UnitValues;
}

interface WUCurrentResponse {
	observations?: WUCurrentObservation[];
}

interface WUDailySummary {
	stationID?: string;
	tz?: string;
	obsTimeLocal?: string;
	obsTimeUtc?: string;
	epoch?: number;
	humidityHigh?: number;
	humidityLow?: number;
	humidityAvg?: number;
	uvHigh?: number | null;
	winddirAvg?: number | null;
	imperial?: UnitValues;
}

interface WUDailySummaryResponse {
	summaries?: WUDailySummary[];
}

interface WUHistoryObservation {
	stationID?: string;
	obsTimeLocal?: string;
	obsTimeUtc?: string;
	epoch?: number;
	humidityAvg?: number;
	imperial?: UnitValues;
}

interface WUHistoryResponse {
	observations?: WUHistoryObservation[];
}

interface DailyWeather {
	date: string;
	obsTimeLocal: string;
	rainfall: number | null;
	tempHigh: number | null;
	tempLow: number | null;
	tempAvg: number | null;
	humidityAvg: number | null;
	windAvg: number | null;
	windGustHigh: number | null;
	pressureMax: number | null;
	pressureMin: number | null;
	records?: number;
	tz?: string;
	source: 'historical' | 'history' | 'cache';
}

interface HistoryIndex {
	stationId: string;
	endpoint: 'hourly';
	earliestDate: string | null;
	latestDate: string | null;
	blocksStored: number;
	recordsStored: number;
	updatedAt: string;
}

interface BackfillState {
	stationId: string;
	startDate: string;
	endDate: string;
	cursorDate: string;
	done: boolean;
	blocksFetched: number;
	recordsStored: number;
	updatedAt: string;
	lastBlock?: {
		startDate: string;
		endDate: string;
		recordsFetched: number;
		kvKey: string;
	};
}

interface DashboardData {
	stationId: string;
	today: DailyWeather | null;
	recentDays: DailyWeather[];
	hourly7Day: WUHistoryObservation[];
	historyIndex: HistoryIndex | null;
	current: WUCurrentObservation | null;
	lastReading: string;
	lastScheduledRun: string | null;
	nextScheduledRun: string | null;
	dataSource: string;
	warning: string | null;
	timezone: string | null;
}

const CACHE_PREFIX = 'weather:dailySummaries:v1';
const HISTORY_PREFIX = 'weather:history:hourly:raw';
const HISTORY_BLOCK_DAYS = 31;

export default {
	async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('[cron] scheduled run started');
		const stationIds = getStationIds(env);
		for (const stationId of stationIds) {
			await refreshDailySummaryCache(env, stationId);
			await refreshRecentHistory(env, stationId);
		}
		console.log('[cron] scheduled run completed');
	},

	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

		if (url.pathname === '/__live-reload') {
			return liveReloadStream();
		}
		if (url.pathname.startsWith('/vendor/')) {
			return env.ASSETS.fetch(req);
		}

		// New home page (placeholder)
		if (url.pathname === '/') {
			const stationIds = getStationIds(env);
			return new Response(renderHomePage(stationIds), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		// /pws/<id> -> /pws/<id>/dashboard
		const pwsBareMatch = /^\/pws\/([^/]+)\/?$/.exec(url.pathname);
		if (pwsBareMatch) {
			return Response.redirect(`${url.origin}/pws/${pwsBareMatch[1]}/dashboard`, 302);
		}

		// /pws/<id>/rain[/<spec>]   spec defaults to today; can be 'today', 'yesterday', or YYYY-MM-DD
		const pwsRainMatch = /^\/pws\/([^/]+)\/rain(?:\/([^/]+))?\/?$/.exec(url.pathname);
		if (pwsRainMatch) {
			const stationId = decodeURIComponent(pwsRainMatch[1]);
			const spec = pwsRainMatch[2] ? decodeURIComponent(pwsRainMatch[2]) : 'today';
			if (!isValidStation(env, stationId)) {
				return new Response('Station not found.', { status: 404 });
			}
			const { WU_API_KEY } = weatherConfig(env);
			if (!WU_API_KEY) {
				return new Response('Missing WU_API_KEY configuration.', { status: 500 });
			}
			try {
				const dashboard = await buildDashboard(env, stationId);
				const target = resolveRainTarget(dashboard, spec);
				if ('error' in target) {
					return new Response(target.error, { status: 400 });
				}
				const rainfall = await loadRainfallForDate(env, stationId, dashboard, target.date, target.isToday);
				const neighborRain = await fetchNeighborRainfallForDate(env, stationId, target.date);
				return new Response(renderRainPage(dashboard, target, rainfall, neighborRain), {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`PWS rain page error (${spec}):`, msg);
				return new Response(`Error: ${msg}`, { status: 500 });
			}
		}

		// /pws/<id>/<question>
		const pwsQMatch = /^\/pws\/([^/]+)\/([^/]+)$/.exec(url.pathname);
		if (pwsQMatch) {
			const stationId = decodeURIComponent(pwsQMatch[1]);
			const question = pwsQMatch[2];
			if (!isValidStation(env, stationId)) {
				return new Response('Station not found.', { status: 404 });
			}
			const { WU_API_KEY } = weatherConfig(env);
			if (!WU_API_KEY) {
				return new Response('Missing WU_API_KEY configuration.', { status: 500 });
			}
			try {
				const dashboard = await buildDashboard(env, stationId);
				if (question === 'dashboard') {
					return new Response(renderDashboard(dashboard, isLocalHost(url.hostname)), {
						headers: { 'Content-Type': 'text/html; charset=utf-8' },
					});
				}
				return new Response('Unknown question.', { status: 404 });
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`PWS page error (${question}):`, msg);
				return new Response(`Error: ${msg}`, { status: 500 });
			}
		}

		// API routes
		if (url.pathname === '/api/stations/coords') {
			const coords = await getAllStationCoords(env);
			return new Response(JSON.stringify(coords), {
				headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
			});
		}
		if (url.pathname === '/api/history/daily') {
			return handleHistoryDaily(req, env);
		}
		if (url.pathname === '/admin/backfill/hourly') {
			return handleHourlyBackfill(req, env);
		}
		if (url.pathname === '/admin/history/status') {
			const auth = authorizeAdmin(req, env);
			if (auth) return auth;
			const urlObj = new URL(req.url);
			const stationId = urlObj.searchParams.get('stationId') ?? getDefaultStation(env);
			if (!stationId) {
				return jsonResponse({ error: 'Missing stationId query parameter.' }, 400);
			}
			return jsonResponse({ index: await readHistoryIndex(env, stationId), backfill: await readBackfillState(env, stationId) });
		}

		return new Response('Not found.', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

function liveReloadStream(): Response {
	let interval: ReturnType<typeof setInterval>;
	const stream = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			controller.enqueue(encoder.encode('event: open\ndata: ok\n\n'));
			interval = setInterval(() => {
				controller.enqueue(encoder.encode(': keepalive\n\n'));
			}, 15_000);
		},
		cancel() {
			clearInterval(interval);
		},
	});
	return new Response(stream, {
		headers: {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-store',
			Connection: 'keep-alive',
		},
	});
}

function isLocalHost(hostname: string): boolean {
	return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function getCron15Times(now: Date = new Date()): { last: string; next: string } {
	const minutes = now.getUTCMinutes();
	const lastMinute = Math.floor(minutes / 15) * 15;
	const nextMinute = lastMinute + 15;

	const last = new Date(now);
	last.setUTCMinutes(lastMinute, 0, 0);

	const next = new Date(now);
	next.setUTCMinutes(nextMinute, 0, 0);
	if (nextMinute >= 60) {
		next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
	}

	const result = { last: last.toISOString(), next: next.toISOString() };
	console.log('[cron] getCron15Times:', result);
	return result;
}

async function buildDashboard(env: Env, stationId: string): Promise<DashboardData> {
	console.log('[dashboard] buildDashboard started');
	const [dailyResult, currentResult, historyIndex, hourly7Day] = await Promise.all([
		loadDailySummaries(env, stationId),
		loadCurrent(env, stationId),
		readHistoryIndex(env, stationId),
		fetchHourly7Day(env, stationId),
	]);
	const current = currentResult.current;
	const recentDays = dailyResult.days;
	const currentLocalDate = current?.obsTimeLocal ? localDate(current.obsTimeLocal) : null;
	const latestSummaryDate = recentDays[recentDays.length - 1]?.date ?? null;
	const todayDate = currentLocalDate ?? latestSummaryDate;
	const today = todayDate ? findDay(recentDays, todayDate) : null;
	const lastReading = current?.obsTimeLocal ?? current?.obsTimeUtc ?? recentDays.at(-1)?.obsTimeLocal ?? 'N/A';
	const { last: lastScheduledRun, next: nextScheduledRun } = getCron15Times();
	console.log('[dashboard] nextScheduledRun:', nextScheduledRun);

	return {
		stationId,
		today: mergeTodayWithCurrent(today, current, todayDate),
		recentDays,
		historyIndex,
		hourly7Day,
		current,
		lastReading,
		lastScheduledRun,
		nextScheduledRun,
		dataSource: dailyResult.source,
		warning: joinWarnings(dailyResult.warning, currentResult.warning),
		timezone: current?.tz ?? recentDays.findLast((d) => !!d.tz)?.tz ?? null,
	};
}

async function loadCurrent(env: Env, stationId: string): Promise<{ current: WUCurrentObservation | null; warning: string | null }> {
	try {
		return { current: await fetchCurrent(env, stationId), warning: null };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { current: null, warning: `Current conditions unavailable. ${msg}` };
	}
}

async function fetchCurrent(env: Env, stationId: string): Promise<WUCurrentObservation | null> {
	const body = await fetchJson<WUCurrentResponse>(env, stationId, '/v2/pws/observations/current', {
		numericPrecision: false,
	});
	return body.observations?.[0] ?? null;
}

async function fetchDailySummaries(env: Env, stationId: string): Promise<DailyWeather[]> {
	const body = await fetchJson<WUDailySummaryResponse>(env, stationId, '/v2/pws/dailysummary/7day', {
		numericPrecision: true,
	});
	return (body.summaries ?? [])
		.map((summary) => normalizeDailySummary(summary, 'historical'))
		.filter((day): day is DailyWeather => day !== null)
		.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchNeighborRainfallForDate(
	env: Env,
	primaryId: string,
	date: string,
): Promise<NeighborRainReading[]> {
	const entry = NEIGHBORS.stations[primaryId];
	if (!entry || entry.neighbors.length === 0) return [];
	return Promise.all(
		entry.neighbors.map(async (n): Promise<NeighborRainReading> => {
			try {
				const days = await loadHistoryDailyRange(env, n.stationId, date, date);
				const match = days.find((d) => d.date === date);
				return {
					stationId: n.stationId,
					name: n.name,
					distanceMi: n.distanceMi,
					rainfall: match?.rainfall ?? null,
					error: match ? null : 'no data in KV',
				};
			} catch (err: unknown) {
				return {
					stationId: n.stationId,
					name: n.name,
					distanceMi: n.distanceMi,
					rainfall: null,
					error: err instanceof Error ? err.message : String(err),
				};
			}
		}),
	);
}

async function fetchHistoryHourlyRawRange(
	env: Env,
	stationId: string,
	startDate: string,
	endDate: string,
): Promise<{ text: string; records: number }> {
	const text = await fetchRaw(env, stationId, '/v2/pws/history/hourly', {
		numericPrecision: true,
		params: { startDate, endDate },
	});
	const parsed: unknown = JSON.parse(text);
	const records =
		typeof parsed === 'object' &&
		parsed !== null &&
		Array.isArray((parsed as { observations?: unknown }).observations)
			? (parsed as { observations: unknown[] }).observations.length
			: 0;
	return { text, records };
}

async function fetchJson<T>(
	env: Env,
	stationId: string,
	path: string,
	options: { numericPrecision: boolean; params?: Record<string, string> },
): Promise<T> {
	const { WU_API_KEY } = weatherConfig(env);
	const url = new URL(`https://api.weather.com${path}`);
	url.searchParams.set('stationId', stationId);
	url.searchParams.set('format', 'json');
	url.searchParams.set('units', 'e');
	if (options.numericPrecision) {
		url.searchParams.set('numericPrecision', 'decimal');
	}
	for (const [key, value] of Object.entries(options.params ?? {})) {
		url.searchParams.set(key, value);
	}
	url.searchParams.set('apiKey', WU_API_KEY);

	const res = await fetch(url.toString(), {
		headers: { Accept: 'application/json' },
	});

	if (!res.ok) {
		const body = await res.text();
		const detail = body ? `: ${body.slice(0, 240)}` : '';
		throw new Error(`Weather API ${path} returned ${res.status}${detail}`);
	}

	return res.json();
}

async function fetchRaw(
	env: Env,
	stationId: string,
	path: string,
	options: { numericPrecision: boolean; params?: Record<string, string> },
): Promise<string> {
	const { WU_API_KEY } = weatherConfig(env);
	const url = new URL(`https://api.weather.com${path}`);
	url.searchParams.set('stationId', stationId);
	url.searchParams.set('format', 'json');
	url.searchParams.set('units', 'e');
	if (options.numericPrecision) {
		url.searchParams.set('numericPrecision', 'decimal');
	}
	for (const [key, value] of Object.entries(options.params ?? {})) {
		url.searchParams.set(key, value);
	}
	url.searchParams.set('apiKey', WU_API_KEY);

	const res = await fetch(url.toString(), {
		headers: { Accept: 'application/json' },
	});
	const body = await res.text();

	if (!res.ok) {
		const detail = body ? `: ${body.slice(0, 240)}` : '';
		throw new Error(`Weather API ${path} returned ${res.status}${detail}`);
	}

	return body;
}

function weatherConfig(env: Env): { WU_API_KEY: string } {
	return {
		WU_API_KEY: cleanSecret(env.WU_API_KEY),
	};
}
function getStationIds(env: Env): string[] {
	return cleanSecret(env.WU_STATION_IDS).split(',').map((s) => s.trim()).filter(Boolean);
}

function getDefaultStation(env: Env): string | undefined {
	return getStationIds(env)[0];
}

function isValidStation(env: Env, stationId: string): boolean {
	return getStationIds(env).includes(stationId);
}

function isKnownNeighbor(stationId: string): boolean {
	for (const entry of Object.values(NEIGHBORS.stations)) {
		if (entry.neighbors.some((n) => n.stationId === stationId)) return true;
	}
	return false;
}

type StationRole = 'primary' | 'neighbor' | 'unknown';
function getStationRole(env: Env, stationId: string): StationRole {
	if (isValidStation(env, stationId)) return 'primary';
	if (isKnownNeighbor(stationId)) return 'neighbor';
	return 'unknown';
}

interface StationCoords {
	id: string;
	lat: number;
	lon: number;
}

const COORDS_KV_PREFIX = 'station:coords:v1';
const COORDS_TTL_SECONDS = 60 * 60 * 24 * 30;

async function getStationCoords(env: Env, stationId: string): Promise<StationCoords | null> {
	const key = `${COORDS_KV_PREFIX}:${stationId}`;
	const cached = await env.WEATHER.get(key);
	if (cached) {
		try {
			const parsed = JSON.parse(cached) as { lat: number; lon: number };
			if (typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
				return { id: stationId, lat: parsed.lat, lon: parsed.lon };
			}
		} catch {}
	}
	const current = await fetchCurrent(env, stationId).catch(() => null);
	if (current && typeof current.lat === 'number' && typeof current.lon === 'number') {
		await env.WEATHER.put(key, JSON.stringify({ lat: current.lat, lon: current.lon }), {
			expirationTtl: COORDS_TTL_SECONDS,
		});
		return { id: stationId, lat: current.lat, lon: current.lon };
	}
	return null;
}

async function getAllStationCoords(env: Env): Promise<StationCoords[]> {
	const ids = getStationIds(env);
	const results = await Promise.all(ids.map((id) => getStationCoords(env, id)));
	return results.filter((c): c is StationCoords => c !== null);
}


function cleanSecret(value: string | undefined): string {
	if (!value) return '';
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function joinWarnings(...warnings: Array<string | null>): string | null {
	const active = warnings.filter((warning): warning is string => Boolean(warning));
	return active.length > 0 ? active.join(' ') : null;
}

async function handleHourlyBackfill(req: Request, env: Env, fallbackStationId?: string): Promise<Response> {
	const auth = authorizeAdmin(req, env);
	if (auth) return auth;

	const url = new URL(req.url);
	const stationId = url.searchParams.get('stationId') ?? fallbackStationId ?? getDefaultStation(env);
	if (!stationId) {
		return jsonResponse({ error: 'Missing stationId. Pass ?stationId=ID or configure a default station.' }, 400);
	}
	const today = new Date();
	const defaultEnd = dateToYmd(addUtcDays(today, -1));
	const requestedStart = url.searchParams.get('start');
	const requestedEnd = url.searchParams.get('end') ?? defaultEnd;
	const reset = url.searchParams.get('reset') === '1';

	if (!isYmd(requestedEnd)) {
		return jsonResponse({ error: 'Invalid end date. Use YYYYMMDD.' }, 400);
	}

	let state = reset ? null : await readBackfillState(env, stationId);
	if (!state || requestedStart) {
		if (!requestedStart || !isYmd(requestedStart)) {
			return jsonResponse({ error: 'Missing or invalid start date. Use /admin/backfill/hourly?start=YYYYMMDD.' }, 400);
		}
		state = {
			stationId: stationId,
			startDate: requestedStart,
			endDate: requestedEnd,
			cursorDate: requestedStart,
			done: false,
			blocksFetched: 0,
			recordsStored: 0,
			updatedAt: new Date().toISOString(),
		};
	}

	if (state.done || state.cursorDate > state.endDate) {
		state = { ...state, done: true, updatedAt: new Date().toISOString() };
		await writeBackfillState(env, state);
		return jsonResponse({ status: 'done', state, index: await readHistoryIndex(env, stationId) });
	}

	const blockStart = state.cursorDate;
	const blockEnd = minYmd(dateToYmd(addUtcDays(ymdToDate(blockStart), HISTORY_BLOCK_DAYS - 1)), state.endDate);
	const raw = await fetchHistoryHourlyRawRange(env, stationId, blockStart, blockEnd);
	const kvKey = historyBlockKey(stationId, blockStart, blockEnd);
	await writeHistoryBlock(env, stationId, kvKey, raw.text, blockStart, blockEnd, raw.records);

	const nextCursor = dateToYmd(addUtcDays(ymdToDate(blockEnd), 1));
	const done = nextCursor > state.endDate;
	const nextState: BackfillState = {
		...state,
		cursorDate: nextCursor,
		done,
		blocksFetched: state.blocksFetched + 1,
		recordsStored: state.recordsStored + raw.records,
		updatedAt: new Date().toISOString(),
		lastBlock: {
			startDate: blockStart,
			endDate: blockEnd,
			recordsFetched: raw.records,
			kvKey,
		},
	};
	await writeBackfillState(env, nextState);

	return jsonResponse({
		status: done ? 'done' : 'ok',
		nextUrl: done ? null : `/admin/backfill/hourly?stationId=${encodeURIComponent(stationId)}`,
		state: nextState,
		index: await readHistoryIndex(env, stationId),
	});
}

function authorizeAdmin(req: Request, env: Env): Response | null {
	const expected = cleanSecret(env.BACKFILL_TOKEN);
	const url = new URL(req.url);
	const provided = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? '';
	if (!expected) {
		return jsonResponse({ error: 'Set BACKFILL_TOKEN before using admin backfill.' }, 403);
	}
	if (provided !== expected) {
		return jsonResponse({ error: 'Unauthorized.' }, 401);
	}
	return null;
}

async function refreshDailySummaryCache(env: Env, stationId: string): Promise<void> {
	const days = await fetchDailySummaries(env, stationId);
	await cacheDailySummaries(env, stationId, days);
}

async function refreshRecentHistory(env: Env, stationId: string): Promise<void> {
	const end = dateToYmd(addUtcDays(new Date(), -1));
	const start = dateToYmd(addUtcDays(ymdToDate(end), -HISTORY_BLOCK_DAYS + 1));
	const raw = await fetchHistoryHourlyRawRange(env, stationId, start, end);
	await writeHistoryBlock(env, stationId, historyBlockKey(stationId, start, end), raw.text, start, end, raw.records);
}

async function fetchHourly7Day(env: Env, stationId: string): Promise<WUHistoryObservation[]> {
	const today = dateToYmd(new Date());
	const start = dateToYmd(addUtcDays(ymdToDate(today), -6));
	const isoStart = ymdToIsoDate(start);
	const isoEnd = ymdToIsoDate(today);

	if (env.WEATHER) {
		try {
			const entries = await listHistoryBlockKeys(env, stationId, start, today);
			if (entries.length > 0) {
				const blocks = await Promise.all(entries.map((entry) => env.WEATHER.get(entry.name)));
				const observations = blocks.flatMap((raw) => parseHistoryObservations(raw));
				const filtered = observations.filter((obs) => {
					if (!obs.obsTimeLocal) return false;
					const date = localDate(obs.obsTimeLocal);
					return date >= isoStart && date <= isoEnd;
				});
				if (filtered.length > 0) {
					return filtered.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
				}
			}
		} catch {
			// Fall through to API
		}
	}

	try {
		const raw = await fetchHistoryHourlyRawRange(env, stationId, start, today);
		const parsed = parseHistoryObservations(raw.text);
		return parsed
			.filter((obs) => {
				if (!obs.obsTimeLocal) return false;
				const date = localDate(obs.obsTimeLocal);
				return date >= isoStart && date <= isoEnd;
			})
			.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
	} catch {
		return [];
	}
}

async function writeHistoryBlock(
	env: Env,
	stationId: string,
	kvKey: string,
	rawJson: string,
	startDate: string,
	endDate: string,
	records: number,
): Promise<void> {
	if (!env.WEATHER) return;
	await env.WEATHER.put(kvKey, rawJson, {
		metadata: {
			stationId: stationId,
			endpoint: 'hourly',
			startDate,
			endDate,
			records,
			storedAt: new Date().toISOString(),
		},
	});
	await updateHistoryIndex(env, stationId, startDate, endDate, records);
}

async function updateHistoryIndex(env: Env, stationId: string, startDate: string, endDate: string, records: number): Promise<void> {
	const existing = await readHistoryIndex(env, stationId);
	const next: HistoryIndex = {
		stationId: stationId,
		endpoint: 'hourly',
		earliestDate:
			existing?.earliestDate && existing.earliestDate < ymdToIsoDate(startDate)
				? existing.earliestDate
				: ymdToIsoDate(startDate),
		latestDate:
			existing?.latestDate && existing.latestDate > ymdToIsoDate(endDate)
				? existing.latestDate
				: ymdToIsoDate(endDate),
		blocksStored: (existing?.blocksStored ?? 0) + 1,
		recordsStored: (existing?.recordsStored ?? 0) + records,
		updatedAt: new Date().toISOString(),
	};
	await env.WEATHER.put(historyIndexKey(stationId), JSON.stringify(next));
}

async function readHistoryIndex(env: Env, stationId: string): Promise<HistoryIndex | null> {
	if (!env.WEATHER) return null;
	const raw = await env.WEATHER.get(historyIndexKey(stationId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<HistoryIndex>;
		if (parsed.stationId !== stationId) return null;
		return {
			stationId: parsed.stationId,
			endpoint: 'hourly',
			earliestDate: typeof parsed.earliestDate === 'string' ? parsed.earliestDate : null,
			latestDate: typeof parsed.latestDate === 'string' ? parsed.latestDate : null,
			blocksStored: numberOrZero(parsed.blocksStored),
			recordsStored: numberOrZero(parsed.recordsStored),
			updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
		};
	} catch {
		return null;
	}
}

async function readBackfillState(env: Env, stationId: string): Promise<BackfillState | null> {
	if (!env.WEATHER) return null;
	const raw = await env.WEATHER.get(backfillStateKey(stationId));
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as BackfillState;
		return parsed.stationId === stationId ? parsed : null;
	} catch {
		return null;
	}
}

async function writeBackfillState(env: Env, state: BackfillState): Promise<void> {
	if (!env.WEATHER) return;
	await env.WEATHER.put(backfillStateKey(state.stationId), JSON.stringify(state));
}

function historyBlockKey(stationId: string, startDate: string, endDate: string): string {
	return `${HISTORY_PREFIX}:${stationId}:${startDate}:${endDate}`;
}

function historyIndexKey(stationId: string): string {
	return `${HISTORY_PREFIX}:${stationId}:index`;
}

function backfillStateKey(stationId: string): string {
	return `${HISTORY_PREFIX}:${stationId}:backfill`;
}

async function handleHistoryDaily(req: Request, env: Env, fallbackStationId?: string): Promise<Response> {
	const url = new URL(req.url);
	const stationId = url.searchParams.get('stationId') ?? fallbackStationId ?? getDefaultStation(env);
	if (!stationId) {
		return jsonResponse({ error: 'Missing stationId. Pass ?stationId=ID or configure a default station.' }, 400);
	}
	const today = dateToYmd(new Date());
	const defaultEnd = ymdToIsoDate(dateToYmd(addUtcDays(ymdToDate(today), -1)));
	const defaultStart = ymdToIsoDate(dateToYmd(addUtcDays(ymdToDate(today), -30)));
	const start = url.searchParams.get('start') ?? defaultStart;
	const end = url.searchParams.get('end') ?? defaultEnd;

	if (!isIsoDate(start) || !isIsoDate(end) || start > end) {
		return jsonResponse({ error: 'Invalid range. Use start=YYYY-MM-DD&end=YYYY-MM-DD.' }, 400);
	}

	const maxEnd = ymdToIsoDate(dateToYmd(addUtcDays(isoDateToDate(start), 370)));
	if (end > maxEnd) {
		return jsonResponse({ error: 'Range is too large. Request at most 371 days.' }, 400);
	}

	const days = await loadHistoryDailyRange(env, stationId, start, end);
	return jsonResponse({ stationId: stationId, start, end, days, index: await readHistoryIndex(env, stationId) });
}

async function loadHistoryDailyRange(env: Env, stationId: string, start: string, end: string): Promise<DailyWeather[]> {
	if (!env.WEATHER) return [];
	const entries = await listHistoryBlockKeys(env, stationId, isoDateToYmd(start), isoDateToYmd(end));
	const blocks = await Promise.all(entries.map((entry) => env.WEATHER.get(entry.name)));
	const observations = blocks.flatMap((raw) => parseHistoryObservations(raw));
	return aggregateHistoryObservations(observations, start, end);
}

async function listHistoryBlockKeys(
	env: Env,
	stationId: string,
	startYmd: string,
	endYmd: string,
): Promise<Array<{ name: string }>> {
	const prefix = `${HISTORY_PREFIX}:${stationId}:`;
	const entries: Array<{ name: string }> = [];
	let cursor: string | undefined;
	do {
		const page = await env.WEATHER.list({ prefix, cursor });
		for (const key of page.keys) {
			const range = parseHistoryBlockKey(stationId, key.name);
			if (range && rangesOverlap(startYmd, endYmd, range.startDate, range.endDate)) {
				entries.push({ name: key.name });
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return entries.sort((a, b) => a.name.localeCompare(b.name));
}

function parseHistoryBlockKey(stationId: string, key: string): { startDate: string; endDate: string } | null {
	const prefix = `${HISTORY_PREFIX}:${stationId}:`;
	if (!key.startsWith(prefix)) return null;
	const suffix = key.slice(prefix.length);
	const match = /^(\d{8}):(\d{8})$/.exec(suffix);
	if (!match) return null;
	return { startDate: match[1], endDate: match[2] };
}

function rangesOverlap(startA: string, endA: string, startB: string, endB: string): boolean {
	return startA <= endB && startB <= endA;
}

function parseHistoryObservations(raw: string | null): WUHistoryObservation[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw) as WUHistoryResponse;
		return Array.isArray(parsed.observations) ? parsed.observations : [];
	} catch {
		return [];
	}
}

function aggregateHistoryObservations(observations: WUHistoryObservation[], start: string, end: string): DailyWeather[] {
	const buckets = new Map<string, WUHistoryObservation[]>();
	for (const observation of observations) {
		if (!observation.obsTimeLocal) continue;
		const date = localDate(observation.obsTimeLocal);
		if (date < start || date > end) continue;
		const bucket = buckets.get(date) ?? [];
		bucket.push(observation);
		buckets.set(date, bucket);
	}

	return [...buckets.entries()]
		.map(([date, bucket]) => normalizeHistoryDay(date, bucket))
		.filter((day): day is DailyWeather => day !== null)
		.sort((a, b) => a.date.localeCompare(b.date));
}

function normalizeHistoryDay(date: string, observations: WUHistoryObservation[]): DailyWeather | null {
	const sorted = observations
		.slice()
		.sort((a, b) => (a.obsTimeLocal ?? '').localeCompare(b.obsTimeLocal ?? ''));
	const units = sorted.map((observation) => observation.imperial ?? {});
	const tempValues = units.map((unit) => numberOrNull(unit.tempAvg ?? unit.temp)).filter(isNumber);
	const precipTotals = units.map((unit) => numberOrNull(unit.precipTotal)).filter(isNumber);
	const windValues = units.map((unit) => numberOrNull(unit.windspeedAvg ?? unit.windSpeed)).filter(isNumber);
	const gustValues = units.map((unit) => numberOrNull(unit.windgustHigh ?? unit.windGust)).filter(isNumber);
	const humidityValues = sorted.map((observation) => numberOrNull(observation.humidityAvg)).filter(isNumber);
	const pressureMaxValues = units.map((unit) => numberOrNull(unit.pressureMax ?? unit.pressure)).filter(isNumber);
	const pressureMinValues = units.map((unit) => numberOrNull(unit.pressureMin ?? unit.pressure)).filter(isNumber);
	const latest = sorted.at(-1);
	if (!latest?.obsTimeLocal) return null;

	return {
		date,
		obsTimeLocal: latest.obsTimeLocal,
		rainfall: precipTotals.length > 0 ? Math.max(...precipTotals) : null,
		tempHigh: maxOrNull(tempValues),
		tempLow: minOrNull(tempValues),
		tempAvg: avgOrNull(tempValues),
		humidityAvg: avgOrNull(humidityValues),
		windAvg: avgOrNull(windValues),
		windGustHigh: maxOrNull(gustValues),
		pressureMax: maxOrNull(pressureMaxValues),
		pressureMin: minOrNull(pressureMinValues),
		records: sorted.length,
		source: 'history',
	};
}

async function loadDailySummaries(env: Env, stationId: string): Promise<{ days: DailyWeather[]; source: string; warning: string | null }> {
	const cachedDays = await readCachedDailySummaries(env, stationId);
	if (cachedDays.length > 0) {
		return { days: cachedDays, source: 'KV cache (refreshed by cron every 15m)', warning: null };
	}
	try {
		const days = await fetchDailySummaries(env, stationId);
		await cacheDailySummaries(env, stationId, days);
		return { days, source: 'wunderground.com /v2/pws/dailysummary/7day (cache miss)', warning: null };
	} catch (err: unknown) {
		throw err;
	}
}

async function cacheDailySummaries(env: Env, stationId: string, days: DailyWeather[]): Promise<void> {
	if (!env.WEATHER || days.length === 0) return;
	await env.WEATHER.put(dailySummariesCacheKey(stationId), JSON.stringify(days), {
		metadata: { stationId: stationId, cachedAt: new Date().toISOString() },
	});
}

async function readCachedDailySummaries(env: Env, stationId: string): Promise<DailyWeather[]> {
	if (!env.WEATHER) return [];

	const raw = await env.WEATHER.get(dailySummariesCacheKey(stationId));
	if (!raw) return [];

	try {
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((day) => normalizeCachedDay(day))
			.filter((day): day is DailyWeather => day !== null)
			.sort((a, b) => a.date.localeCompare(b.date));
	} catch {
		return [];
	}
}

function dailySummariesCacheKey(stationId: string): string {
	return `${CACHE_PREFIX}:${stationId}`;
}

function normalizeDailySummary(summary: WUDailySummary, source: DailyWeather['source']): DailyWeather | null {
	if (!summary.obsTimeLocal) return null;
	const imperial = summary.imperial ?? {};

	return {
		date: localDate(summary.obsTimeLocal),
		obsTimeLocal: summary.obsTimeLocal,
		rainfall: numberOrNull(imperial.precipTotal),
		tempHigh: numberOrNull(imperial.tempHigh),
		tempLow: numberOrNull(imperial.tempLow),
		tempAvg: numberOrNull(imperial.tempAvg),
		humidityAvg: numberOrNull(summary.humidityAvg),
		windAvg: numberOrNull(imperial.windspeedAvg),
		windGustHigh: numberOrNull(imperial.windgustHigh),
		pressureMax: numberOrNull(imperial.pressureMax),
		pressureMin: numberOrNull(imperial.pressureMin),
		tz: summary.tz,
		source,
	};
}

function normalizeCachedDay(value: unknown): DailyWeather | null {
	if (typeof value !== 'object' || value === null) return null;
	const day = value as Partial<DailyWeather>;
	if (typeof day.date !== 'string' || typeof day.obsTimeLocal !== 'string') return null;

	return {
		date: day.date,
		obsTimeLocal: day.obsTimeLocal,
		rainfall: numberOrNull(day.rainfall),
		tempHigh: numberOrNull(day.tempHigh),
		tempLow: numberOrNull(day.tempLow),
		tempAvg: numberOrNull(day.tempAvg),
		humidityAvg: numberOrNull(day.humidityAvg),
		windAvg: numberOrNull(day.windAvg),
		windGustHigh: numberOrNull(day.windGustHigh),
		pressureMax: numberOrNull(day.pressureMax),
		pressureMin: numberOrNull(day.pressureMin),
		tz: typeof day.tz === 'string' ? day.tz : undefined,
		source: 'cache',
	};
}

function mergeTodayWithCurrent(
	today: DailyWeather | null,
	current: WUCurrentObservation | null,
	todayDate: string | null,
): DailyWeather | null {
	if (!current?.imperial || !todayDate) return today;
	if (current.obsTimeLocal && localDate(current.obsTimeLocal) !== todayDate) return today;

	const liveRainfall = numberOrNull(current.imperial.precipTotal);

	return {
		date: todayDate,
		obsTimeLocal: current.obsTimeLocal ?? today?.obsTimeLocal ?? current.obsTimeUtc ?? todayDate,
		rainfall: liveRainfall === null ? today?.rainfall ?? null : Math.max(today?.rainfall ?? 0, liveRainfall),
		tempHigh: today?.tempHigh ?? null,
		tempLow: today?.tempLow ?? null,
		tempAvg: numberOrNull(current.imperial.temp) ?? today?.tempAvg ?? null,
		humidityAvg: numberOrNull(current.humidity) ?? today?.humidityAvg ?? null,
		windAvg: numberOrNull(current.imperial.windSpeed) ?? today?.windAvg ?? null,
		windGustHigh: numberOrNull(current.imperial.windGust) ?? today?.windGustHigh ?? null,
		pressureMax: today?.pressureMax ?? numberOrNull(current.imperial.pressure),
		pressureMin: today?.pressureMin ?? numberOrNull(current.imperial.pressure),
		source: today?.source ?? 'historical',
	};
}

function findDay(days: DailyWeather[], date: string): DailyWeather | null {
	return days.find((day) => day.date === date) ?? null;
}

interface RainTarget {
	date: string;
	isToday: boolean;
	isYesterday: boolean;
}

function resolveRainTarget(dashboard: DashboardData, spec: string): RainTarget | { error: string } {
	const todayDate = dashboard.today?.date ?? new Date().toISOString().slice(0, 10);
	const yesterdayDate = ymdToIsoDate(dateToYmd(addUtcDays(isoDateToDate(todayDate), -1)));
	const lower = spec.toLowerCase();
	let date: string;
	if (lower === 'today') date = todayDate;
	else if (lower === 'yesterday') date = yesterdayDate;
	else if (isIsoDate(spec)) date = spec;
	else return { error: `Invalid date '${spec}'. Use YYYY-MM-DD, 'today', or 'yesterday'.` };
	return { date, isToday: date === todayDate, isYesterday: date === yesterdayDate };
}

async function loadRainfallForDate(
	env: Env,
	stationId: string,
	dashboard: DashboardData,
	date: string,
	isToday: boolean,
): Promise<number | null> {
	if (isToday && dashboard.today) {
		return dashboard.today.rainfall;
	}
	const recent = dashboard.recentDays.find((d) => d.date === date);
	if (recent) return recent.rainfall;
	const days = await loadHistoryDailyRange(env, stationId, date, date);
	return days.find((d) => d.date === date)?.rainfall ?? null;
}

function localDate(obsTimeLocal: string): string {
	return obsTimeLocal.slice(0, 10);
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function numberOrZero(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function isNumber(value: number | null): value is number {
	return value !== null;
}

function avgOrNull(values: number[]): number | null {
	if (values.length === 0) return null;
	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function minOrNull(values: number[]): number | null {
	return values.length === 0 ? null : Math.min(...values);
}

function maxOrNull(values: number[]): number | null {
	return values.length === 0 ? null : Math.max(...values);
}

function isYmd(value: string): boolean {
	return /^\d{8}$/.test(value) && dateToYmd(ymdToDate(value)) === value;
}

function isIsoDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && ymdToIsoDate(isoDateToYmd(value)) === value;
}

function isoDateToDate(value: string): Date {
	return ymdToDate(isoDateToYmd(value));
}

function isoDateToYmd(value: string): string {
	return value.replace(/-/g, '');
}

function ymdToDate(value: string): Date {
	const year = Number(value.slice(0, 4));
	const month = Number(value.slice(4, 6));
	const day = Number(value.slice(6, 8));
	return new Date(Date.UTC(year, month - 1, day));
}

function ymdToIsoDate(value: string): string {
	return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function dateToYmd(date: Date): string {
	return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function addUtcDays(date: Date, days: number): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
}

function minYmd(a: string, b: string): string {
	return a < b ? a : b;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}

function renderDashboard(d: DashboardData, includeLiveReload: boolean): string {
	const current = d.current?.imperial;
	const hourlyChartPayload = buildHourlyChartPayload(d.hourly7Day);
	const metrics = [
		metricPanel({
			title: 'Current Temp',
			value: fmtNumber(current?.temp ?? d.today?.tempAvg ?? null, ' F'),
			subtitle: `Today low / high: ${fmtTempRange(d.today)}`,
			color: '#e07b00',
		}),
		metricPanel({
			title: 'Today Rain',
			value: fmtRain(d.today?.rainfall ?? null),
			subtitle: `Rate: ${fmtNumber(current?.precipRate ?? null, ' in/hr')}`,
			color: '#0e7fcf',
		}),
		metricPanel({
			title: 'Current Wind',
			value: fmtNumber(current?.windSpeed ?? d.today?.windAvg ?? null, ' mph'),
			subtitle: `Daily avg: ${fmtNumber(d.today?.windAvg ?? null, ' mph')}`,
			color: '#1d9646',
		}),
		metricPanel({
			title: 'Current Gust',
			value: fmtNumber(current?.windGust ?? d.today?.windGustHigh ?? null, ' mph'),
			subtitle: `Daily high: ${fmtNumber(d.today?.windGustHigh ?? null, ' mph')}`,
			color: '#a020bc',
		}),
	].join('');
	const chartJson = safeScriptJson(hourlyChartPayload);
	const historyIndexJson = safeScriptJson(d.historyIndex);
	const liveReloadScript = includeLiveReload ? renderLiveReloadScript() : '';
	const currentFreshness = fmtCurrentFreshness(d.current);
	const staleMs = d.current?.obsTimeUtc ? Date.parse(d.current.obsTimeUtc) : null;
	const pwsAge = staleMs && Number.isFinite(staleMs) ? Math.max(0, Math.floor((Date.now() - staleMs) / 60_000)) : null;
	const refreshAge = d.lastScheduledRun ? Math.max(0, Math.floor((Date.now() - Date.parse(d.lastScheduledRun)) / 60_000)) : null;
	const scheduleCountdown = d.nextScheduledRun
		? `<span id="schedule-countdown" data-next-run="${Date.parse(d.nextScheduledRun)}">--:--</span>`
		: '';
	const rows = d.recentDays
		.slice()
		.reverse()
		.map(
			(day) => /* html */ `<tr>
        <td>${escHtml(day.date)}</td>
        <td>${fmtRain(day.rainfall)}</td>
        <td>${fmtTempRange(day)}</td>
        <td>${fmtNumber(day.windAvg, ' mph')}</td>
        <td>${fmtNumber(day.windGustHigh, ' mph')}</td>
      </tr>`,
		)
		.join('');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(d.stationId)} - Weather Dashboard</title>
<link rel="stylesheet" href="/vendor/uplot/uPlot.min.css" />
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f7f9fc;
    color: #1a1f2c;
    min-height: 100vh;
    padding: 24px;
  }
  main {
    max-width: 1120px;
    margin: 0 auto;
  }
  header {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  h1 {
    margin: 0 0 4px;
    font-size: clamp(1.5rem, 4vw, 2.4rem);
    font-weight: 700;
    color: #1a1f2c;
    overflow-wrap: anywhere;
  }
  .subtitle, .meta, .footer {
    color: #5a6878;
    font-size: .86rem;
  }
  #stale-timer { color: #e07b00; font-weight: 600; font-variant-numeric: tabular-nums; }
  #schedule-countdown {
    color: #0e7fcf;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    transition: color 0.3s;
  }
  #schedule-countdown.overdue {
    color: #d83737;
  }
  .metric-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .card, .chart-shell, .history-panel, .table-wrap {
    background: #ffffff;
    border: 1px solid #dde4ec;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
  }
	  .chart-shell {
	    margin-bottom: 12px;
	    padding: 16px;
	  }
	  .history-panel {
	    margin-top: 12px;
	    padding: 16px;
	  }
  .chart-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 8px;
  }
  .chart-title {
    color: #1a1f2c;
    font-size: 1rem;
    font-weight: 700;
  }
  .readout {
    display: grid;
    grid-template-columns: repeat(5, max-content);
    gap: 6px 12px;
    align-items: baseline;
    margin-top: 12px;
    min-height: 42px;
    color: #1a1f2c;
    font-size: .82rem;
  }
  .readout div {
    white-space: nowrap;
  }
  .readout span {
    color: var(--readout-color);
    font-weight: 750;
  }
  .legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px 12px;
    color: #5a6878;
    font-size: .78rem;
  }
  .legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
  }
	  .legend i {
    width: 18px;
    height: 3px;
    border-radius: 999px;
    background: var(--legend-color);
	  }
	  .history-controls {
	    display: flex;
	    flex-wrap: wrap;
	    align-items: end;
	    gap: 10px;
	    margin: 14px 0 12px;
	  }
	  .field {
	    display: grid;
	    gap: 5px;
	  }
	  .field span {
	    color: #5a6878;
	    font-size: .76rem;
	    font-weight: 650;
	    text-transform: uppercase;
	  }
	  input[type="date"], button {
	    height: 36px;
	    border-radius: 6px;
	    border: 1px solid #c5d0dc;
	    background: #ffffff;
	    color: #1a1f2c;
	    font: inherit;
	    font-size: .9rem;
	  }
	  input[type="date"] {
	    padding: 0 10px;
	    min-width: 150px;
	  }
	  button {
	    padding: 0 14px;
	    cursor: pointer;
	    background: #1a6fd6;
	    border-color: #155cb6;
	    font-weight: 700;
	  }
	  button:disabled {
	    cursor: wait;
	    opacity: .65;
	  }
	  .status {
	    color: #5a6878;
	    font-size: .84rem;
	    min-height: 1.3em;
	  }
	  .history-table {
	    margin-top: 10px;
	    max-height: 300px;
	    overflow: auto;
	    border-top: 1px solid #dde4ec;
	  }
	  .history-table table {
	    min-width: 720px;
	  }
  .card {
    min-width: 0;
    padding: 16px;
  }
  .label {
    color: #5a6878;
    font-size: .84rem;
    margin-bottom: 10px;
  }
  .value {
    color: var(--accent);
    font-size: clamp(1.45rem, 3vw, 2.15rem);
    line-height: 1;
    font-weight: 750;
    overflow-wrap: anywhere;
  }
  .subvalue {
    margin-top: 8px;
    color: #5a6878;
    font-size: .82rem;
    min-height: 1.2em;
  }
  .chart {
    width: 100%;
    height: 320px;
  }
  .history-panel .chart {
    height: 380px;
  }
  .uplot {
    background: transparent;
    color: #7d8b9b;
    font-family: inherit;
  }
  .uplot .u-over, .uplot .u-under {
    overflow: hidden;
    border-radius: 4px;
  }
  .uplot .u-axis text {
    fill: #7d8b9b;
    font-size: 10px;
  }
  .uplot .u-axis path,
  .uplot .u-axis line,
  .uplot .u-grid {
    stroke: #e6ecf3;
  }
  .uplot .u-cursor-x,
  .uplot .u-cursor-y {
    stroke: #5a6878;
  }
  .uplot .u-legend {
    display: none;
  }
  .table-wrap {
    margin-top: 12px;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    min-width: 620px;
  }
  th, td {
    padding: 12px 14px;
    text-align: left;
    border-bottom: 1px solid #dde4ec;
    white-space: nowrap;
  }
  th {
    color: #3a4858;
    font-size: .78rem;
    font-weight: 650;
    text-transform: uppercase;
  }
  td {
    color: #1a1f2c;
    font-size: .9rem;
  }
  tr:last-child td { border-bottom: 0; }
  .notice {
    margin: 12px 0;
    padding: 10px 12px;
    border: 1px solid #e6c97a;
    background: #fff5d6;
    border-radius: 8px;
    color: #7a5a00;
    font-size: .86rem;
  }
  .footer {
    margin-top: 14px;
    line-height: 1.6;
  }
	  @media (max-width: 700px) {
    body { padding: 14px; }
    header { display: block; }
    .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .chart { height: 260px; }
    .chart-head { display: block; }
    .legend { justify-content: flex-start; margin-top: 10px; }
	    .readout { grid-template-columns: repeat(2, max-content); }
	    .history-controls { align-items: stretch; }
	    .field, .history-controls button { flex: 1 1 150px; }
	  }
  @media (max-width: 460px) {
    .metric-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escHtml(d.stationId)}</h1>
      <div class="subtitle">Temperature, rain, wind avg, and gusts</div>
    </div>
    <div class="meta">
      PWS → WU: ${escHtml(d.lastReading)}${pwsAge !== null ? ` (${fmtDuration(pwsAge)} ago)` : ''}<br>
      Last worker refresh: ${d.lastScheduledRun ? escHtml(d.lastScheduledRun.slice(11, 16)) + ' UTC' + (refreshAge !== null ? ` (${fmtDuration(refreshAge)} ago)` : '') : 'N/A'}<br>
      Reading stale: ${staleMs && Number.isFinite(staleMs) ? `<span id="stale-timer" data-stale-ms="${staleMs}">--:--</span>` : 'N/A'}<br>
      Next fetch: ${scheduleCountdown || 'N/A'}
    </div>
  </header>

  ${d.warning ? `<div class="notice">${escHtml(d.warning)}</div>` : ''}

  <section class="chart-shell">
    <div class="chart-head">
      <div>
        <div class="label">7 day trend</div>
        <div class="chart-title">Temperature, rain, wind, and gusts</div>
        <div id="chart-readout" class="readout"></div>
      </div>
      <div class="legend">
        <span><i style="--legend-color:#e07b00"></i>Temp avg</span>
        <span><i style="--legend-color:#0e7fcf"></i>Rain</span>
        <span><i style="--legend-color:#1d9646"></i>Wind avg</span>
        <span><i style="--legend-color:#a020bc"></i>Gusts</span>
      </div>
    </div>
    <div id="weather-chart" class="chart"></div>
  </section>

  <section class="metric-grid">${metrics}</section>

  <section class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Rain</th>
          <th>Temperature</th>
          <th>Wind Avg</th>
          <th>Gust High</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5">No historical daily summaries returned.</td></tr>'}</tbody>
    </table>
  </section>

  <section class="history-panel">
    <div class="chart-head">
      <div>
        <div class="label">Historical weather</div>
        <div class="chart-title">Daily aggregates from hourly KV history</div>
        <div id="history-status" class="status"></div>
      </div>
      <div class="legend">
        <span><i style="--legend-color:#e07b00"></i>Temp avg</span>
        <span><i style="--legend-color:#0e7fcf"></i>Rain</span>
        <span><i style="--legend-color:#1d9646"></i>Wind avg</span>
        <span><i style="--legend-color:#a020bc"></i>Gusts</span>
      </div>
    </div>
    <form id="history-form" class="history-controls">
      <label class="field"><span>Start</span><input id="history-start" type="date"></label>
      <label class="field"><span>End</span><input id="history-end" type="date"></label>
      <button id="history-submit" type="submit">Load</button>
    </form>
    <div id="history-chart" class="chart"></div>
    <div class="history-table">
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Obs Time</th>
            <th>Rain</th>
            <th>Temperature</th>
            <th>Wind Avg</th>
            <th>Gust High</th>
            <th>Records</th>
          </tr>
        </thead>
        <tbody id="history-rows"><tr><td colspan="7">Choose a range to load historical data.</td></tr></tbody>
      </table>
    </div>
  </section>

  <div class="footer">
    Source: ${escHtml(d.dataSource)}<br>
    Daily trends come from /v2/pws/dailysummary/7day; live values come from /v2/pws/observations/current.
  </div>
</main>
<script>
(function() {
  const staleEl = document.getElementById('stale-timer');
  const nextEl = document.getElementById('schedule-countdown');
  console.log('[client] countdown init, nextRun:', nextEl?.dataset.nextRun);

  function fmt(m, s) {
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function tick() {
    const now = Date.now();

    if (staleEl) {
      const staleMs = parseInt(staleEl.dataset.staleMs, 10);
      const totalSec = Math.floor((now - staleMs) / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      staleEl.textContent = fmt(m, s);
    }

    if (nextEl) {
      const nextMs = parseInt(nextEl.dataset.nextRun, 10);
      const remaining = nextMs - now;
      if (remaining <= 0) {
        nextEl.textContent = 'Running now';
        nextEl.classList.add('overdue');
        if (!nextEl.dataset.reloadScheduled) {
          nextEl.dataset.reloadScheduled = '1';
          console.log('[client] countdown overdue, scheduling reload in 20s');
          setTimeout(() => location.reload(), 20000);
        }
      } else {
        nextEl.classList.remove('overdue');
        nextEl.dataset.reloadScheduled = '';
        const m = Math.floor(remaining / 60000);
        const s = Math.floor((remaining % 60000) / 1000);
        nextEl.textContent = fmt(m, s);
      }
    }
  }

  tick();
  setInterval(tick, 1000);
})();
</script>
<script src="/vendor/uplot/uPlot.iife.min.js"></script>
<script>
(() => {
  const payload = ${chartJson};
  const chartApi = window.__waxwingWxChart || (window.__waxwingWxChart = (() => {
    const fmtNumber = (value, suffix, digits = 1) =>
      value == null ? 'N/A' : value.toFixed(digits).replace(/\\.0$/, '') + suffix;
    const createSeries = () => ([
      {},
      { label: 'Temp low', scale: 'temp', stroke: '#e07b00', width: 1, points: { show: false } },
      { label: 'Temp avg', scale: 'temp', stroke: '#e07b00', width: 3, points: { show: false } },
      { label: 'Temp high', scale: 'temp', stroke: '#e07b00', width: 1, points: { show: false } },
      {
        label: 'Rain',
        scale: 'rain',
        stroke: '#0e7fcf',
        fill: '#0e7fcf66',
        width: 1,
        paths: uPlot.paths.bars({ size: [0.82, Infinity, 1], align: 0 }),
        points: { show: false },
      },
      { label: 'Wind avg', scale: 'wind', stroke: '#1d9646', width: 3, points: { show: false } },
      { label: 'Gusts', scale: 'wind', stroke: '#a020bc', width: 3, dash: [8, 5], points: { show: false } },
    ]);
    const createAxes = (labelFormatter, rotate = 45, space = 56) => ([
      {
        stroke: '#7d8b9b',
        grid: { stroke: '#e6ecf3', width: 1 },
        values: (u, ticks) => ticks.map(labelFormatter),
        rotate,
        space,
        align: 2,
        size: 80,
      },
      {
        scale: 'temp',
        label: 'F',
        size: 42,
        stroke: '#e07b00',
        grid: { stroke: '#e6ecf3', width: 1 },
      },
      {
        scale: 'rain',
        label: 'in',
        side: 1,
        size: 42,
        stroke: '#0e7fcf',
        grid: { show: false },
      },
      {
        scale: 'wind',
        label: 'mph',
        side: 1,
        size: 46,
        stroke: '#7d8b9b',
        grid: { show: false },
      },
    ]);
    const makePlot = ({ el, readout, x, tempLow, tempAvg, tempHigh, rainfall, windAvg, windGustHigh, labelFormatter, readoutLabelFormatter, rotate = 45, space = 56 }) => {
      if (!el || !x.length || !window.uPlot) return null;
      const renderReadout = (idx) => {
        if (!readout || idx == null || idx < 0) return;
        readout.innerHTML = [
          '<div>' + readoutLabelFormatter(x[idx]) + '</div>',
          '<div>Temp <span style="--readout-color:#e07b00">' + fmtNumber(tempLow[idx], ' F') + '–' + fmtNumber(tempHigh[idx], ' F') + ' (avg ' + fmtNumber(tempAvg[idx], ' F') + ')</span></div>',
          '<div>Rain <span style="--readout-color:#0e7fcf">' + fmtNumber(rainfall[idx], ' in', 2) + '</span></div>',
          '<div>Wind <span style="--readout-color:#1d9646">' + fmtNumber(windAvg[idx], ' mph') + '</span></div>',
          '<div>Gust <span style="--readout-color:#a020bc">' + fmtNumber(windGustHigh[idx], ' mph') + '</span></div>',
        ].join('');
      };
      const opts = {
        width: el.clientWidth,
        height: el.clientHeight,
        cursor: { drag: { x: false, y: false } },
        legend: { show: false, live: false },
        hooks: {
          setCursor: [
            (u) => {
              const idx = u.cursor.idx;
              if (idx != null) renderReadout(idx);
            },
          ],
        },
        scales: {
          x: { time: true },
          temp: { auto: true },
          rain: { auto: true, range: (u, min, max) => [0, Math.max(0.1, max * 1.2)] },
          wind: { auto: true, range: (u, min, max) => [0, Math.max(8, max * 1.15)] },
        },
        axes: createAxes(labelFormatter, rotate, space),
        series: createSeries(),
        bands: [{ series: [1, 3], fill: 'rgba(255, 180, 84, 0.35)' }],
      };
      const plot = new uPlot(opts, [x, tempLow, tempAvg, tempHigh, rainfall, windAvg, windGustHigh], el);
      renderReadout(x.length - 1);
      return plot;
    };
    return { makePlot };
  })());
  const el = document.getElementById('weather-chart');
  const readout = document.getElementById('chart-readout');
  const fmtDay = (ts) => {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'numeric', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };
  // 7-day hourly chart (single line per metric, no min/max bands)
  const fmtNumber = (value, suffix, digits = 1) =>
    value == null ? 'N/A' : value.toFixed(digits).replace(/\\.0$/, '') + suffix;

  const renderReadout = (idx) => {
    if (!readout || idx == null || idx < 0) return;
    readout.innerHTML = [
      '<div>' + fmtDay(payload.x[idx]) + '</div>',
      '<div>Temp <span style="--readout-color:#e07b00">' + fmtNumber(payload.temp[idx], ' F') + '</span></div>',
      '<div>Rain <span style="--readout-color:#0e7fcf">' + fmtNumber(payload.rainfall[idx], ' in', 2) + '</span></div>',
      '<div>Wind <span style="--readout-color:#1d9646">' + fmtNumber(payload.windAvg[idx], ' mph') + '</span></div>',
      '<div>Gust <span style="--readout-color:#a020bc">' + fmtNumber(payload.windGustHigh[idx], ' mph') + '</span></div>',
    ].join('');
  };

  const opts = {
    width: el.clientWidth,
    height: el.clientHeight,
    cursor: { drag: { x: false, y: false } },
    legend: { show: false, live: false },
    hooks: {
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          if (idx != null) renderReadout(idx);
        },
      ],
    },
    scales: {
      x: { time: true },
      temp: { auto: true },
      rain: { auto: true, range: (u, min, max) => [0, Math.max(0.1, max * 1.2)] },
      wind: { auto: true, range: (u, min, max) => [0, Math.max(8, max * 1.15)] },
    },
    axes: [
      {
        stroke: '#7d8b9b',
        grid: { stroke: '#e6ecf3', width: 1 },
        values: (u, ticks) => ticks.map(fmtDay),
        rotate: 45,
        space: 80,
        align: 2,
        size: 80,
      },
      {
        scale: 'temp',
        label: 'F',
        size: 42,
        stroke: '#e07b00',
        grid: { stroke: '#e6ecf3', width: 1 },
      },
      {
        scale: 'rain',
        label: 'in',
        side: 1,
        size: 42,
        stroke: '#0e7fcf',
        grid: { show: false },
      },
      {
        scale: 'wind',
        label: 'mph',
        side: 1,
        size: 46,
        stroke: '#7d8b9b',
        grid: { show: false },
      },
    ],
    series: [
      {},
      { label: 'Temp', scale: 'temp', stroke: '#e07b00', width: 2, points: { show: false } },
      {
        label: 'Rain',
        scale: 'rain',
        stroke: '#0e7fcf',
        fill: '#0e7fcf66',
        width: 1,
        paths: uPlot.paths.bars({ size: [0.82, Infinity, 1], align: 0 }),
        points: { show: false },
      },
      { label: 'Wind avg', scale: 'wind', stroke: '#1d9646', width: 2, points: { show: false } },
      { label: 'Gusts', scale: 'wind', stroke: '#a020bc', width: 2, dash: [8, 5], points: { show: false } },
    ],
  };

  const plot = new uPlot(opts, [payload.x, payload.temp, payload.rainfall, payload.windAvg, payload.windGustHigh], el);
  renderReadout(payload.x.length - 1);

  addEventListener('resize', () => {
    plot.setSize({ width: el.clientWidth, height: el.clientHeight });
  }, { passive: true });
})();
</script>
<script>
(() => {
  const index = ${historyIndexJson};
  const form = document.getElementById('history-form');
  const startInput = document.getElementById('history-start');
  const endInput = document.getElementById('history-end');
  const submit = document.getElementById('history-submit');
  const status = document.getElementById('history-status');
  const chartEl = document.getElementById('history-chart');
  const rowsEl = document.getElementById('history-rows');
  if (!form || !startInput || !endInput || !submit || !status || !chartEl || !rowsEl || !window.uPlot) return;
  const chartApi = window.__waxwingWxChart;
  if (!chartApi) return;

  const today = new Date();
  const iso = (date) => date.toISOString().slice(0, 10);
  const addDays = (date, days) => {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  };
  const latest = index && index.latestDate ? index.latestDate : iso(addDays(today, -1));
  const earliest = index && index.earliestDate ? index.earliestDate : iso(addDays(today, -30));
  endInput.value = latest;
  startInput.value = iso(addDays(new Date(latest + 'T00:00:00Z'), -30));
  if (startInput.value < earliest) startInput.value = earliest;
  startInput.min = earliest;
  startInput.max = latest;
  endInput.min = earliest;
  endInput.max = latest;

  let plot = null;
  const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
  const fmtValue = (value, suffix, digits = 1) => value == null ? 'N/A' : value.toFixed(digits).replace(/\\.0$/, '') + suffix;
  const esc = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  const setStatus = (text) => {
    status.textContent = text;
  };

  const renderTable = (days) => {
    rowsEl.innerHTML = days.slice().reverse().map((day) => '<tr>' +
      '<td>' + esc(day.date) + '</td>' +
      '<td>' + esc(day.obsTimeLocal ?? '') + '</td>' +
      '<td>' + fmtValue(day.rainfall, ' in', 2) + '</td>' +
      '<td>' + fmtValue(day.tempLow, ' F') + ' / ' + fmtValue(day.tempHigh, ' F') + '</td>' +
      '<td>' + fmtValue(day.windAvg, ' mph') + '</td>' +
      '<td>' + fmtValue(day.windGustHigh, ' mph') + '</td>' +
      '<td>' + esc(day.records ?? '') + '</td>' +
    '</tr>').join('') || '<tr><td colspan="7">No hourly KV records found for this range.</td></tr>';
  };

  const renderChart = (days) => {
    if (plot) {
      plot.destroy();
      plot = null;
    }
    if (!days.length) return;
    const x = days.map((day) => Math.floor(Date.parse(day.date + 'T12:00:00Z') / 1000));
    plot = chartApi.makePlot({
      el: chartEl,
      readout: null,
      x,
      tempLow: days.map((day) => day.tempLow),
      tempAvg: days.map((day) => day.tempAvg),
      tempHigh: days.map((day) => day.tempHigh),
      rainfall: days.map((day) => day.rainfall),
      windAvg: days.map((day) => day.windAvg),
      windGustHigh: days.map((day) => day.windGustHigh),
      labelFormatter: fmtDate,
      readoutLabelFormatter: fmtDate,
      rotate: 45,
      space: 60,
    });
  };

  const load = async () => {
    submit.disabled = true;
    setStatus('Loading ' + startInput.value + ' to ' + endInput.value + '...');
    try {
      const res = await fetch('/api/history/daily?stationId=' + encodeURIComponent('${escHtml(d.stationId)}') + '&start=' + encodeURIComponent(startInput.value) + '&end=' + encodeURIComponent(endInput.value));
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'History request failed.');
      renderTable(body.days || []);
      renderChart(body.days || []);
      const coverage = index ? 'Stored range: ' + (index.earliestDate || 'unknown') + ' to ' + (index.latestDate || 'unknown') + '. ' : '';
      setStatus(coverage + (body.days || []).length + ' daily rows loaded.');
    } catch (err) {
      rowsEl.innerHTML = '<tr><td colspan="7">' + esc(err.message || String(err)) + '</td></tr>';
      setStatus('Unable to load historical data.');
    } finally {
      submit.disabled = false;
    }
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    load();
  });
  addEventListener('resize', () => {
    if (plot) {
      plot.setSize({ width: chartEl.clientWidth, height: chartEl.clientHeight });
    }
  }, { passive: true });
  load();
})();
</script>
${liveReloadScript}
</body>
	</html>`;
}

function renderLiveReloadScript(): string {
	return /* html */ `<script>
(() => {
  let opened = false;
  const events = new EventSource('/__live-reload');
  events.addEventListener('open', () => { opened = true; });
  events.addEventListener('error', () => {
    if (!opened) return;
    events.close();
    setTimeout(() => location.reload(), 250);
  });
})();
</script>`;
}

function mergeRecentToday(days: DailyWeather[], today: DailyWeather | null): DailyWeather[] {
	if (!today) return days;
	const merged = days.map((day) => (day.date === today.date ? today : day));
	if (merged.some((day) => day.date === today.date)) return merged;
	return [...merged, today].sort((a, b) => a.date.localeCompare(b.date));
}

function metricPanel(options: { title: string; value: string; subtitle: string; color: string }): string {
	return /* html */ `<article class="card" style="--accent: ${options.color}">
    <div class="label">${escHtml(options.title)}</div>
    <div class="value">${options.value}</div>
    <div class="subvalue">${options.subtitle}</div>
  </article>`;
}

function buildChartPayload(days: DailyWeather[]): Record<string, Array<number | null>> {
	return {
		x: days.map((day) => Math.floor(Date.parse(`${day.date}T00:00:00Z`) / 1000)),
		tempLow: days.map((day) => day.tempLow),
		tempAvg: days.map((day) => day.tempAvg),
		tempHigh: days.map((day) => day.tempHigh),
		rainfall: days.map((day) => day.rainfall),
		windAvg: days.map((day) => day.windAvg),
		windGustHigh: days.map((day) => day.windGustHigh),
	};
}

function buildHourlyChartPayload(observations: WUHistoryObservation[]): Record<string, Array<number | null>> {
	const sorted = observations
		.filter((obs) => obs.epoch != null)
		.sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
	return {
		x: sorted.map((obs) => obs.epoch!),
		temp: sorted.map((obs) => numberOrNull(obs.imperial?.tempAvg ?? obs.imperial?.temp)),
		rainfall: sorted.map((obs) => numberOrNull(obs.imperial?.precipTotal)),
		windAvg: sorted.map((obs) => numberOrNull(obs.imperial?.windspeedAvg ?? obs.imperial?.windSpeed)),
		windGustHigh: sorted.map((obs) => numberOrNull(obs.imperial?.windgustHigh ?? obs.imperial?.windGust)),
	};
}

function safeScriptJson(value: unknown): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

function fmtRain(inches: number | null): string {
	if (inches === null) return 'N/A';
	return `${inches.toFixed(2)} in`;
}

function fmtNumber(value: number | null | undefined, suffix = ''): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
	return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

function fmtCurrentFreshness(current: WUCurrentObservation | null): string | null {
	if (!current?.obsTimeUtc) return null;
	const observedAt = Date.parse(current.obsTimeUtc);
	if (!Number.isFinite(observedAt)) return null;

	const ageMinutes = Math.max(0, Math.floor((Date.now() - observedAt) / 60_000));
	const parts = [`Current age: ${fmtDuration(ageMinutes)}`];

	if (typeof current.realtimeFrequency === 'number' && Number.isFinite(current.realtimeFrequency)) {
		const cadence = Math.max(1, current.realtimeFrequency);
		const nextMinutes = Math.max(0, Math.ceil((observedAt + cadence * 60_000 - Date.now()) / 60_000));
		parts.push(`station cadence: ${fmtDuration(cadence)}`);
		parts.push(`next expected: ${nextMinutes === 0 ? 'any minute' : `in ${fmtDuration(nextMinutes)}`}`);
	}

	return parts.join(' · ');
}

function fmtDuration(minutes: number): string {
	if (minutes < 60) return `${Math.round(minutes)} min`;
	const hours = Math.floor(minutes / 60);
	const remainder = Math.round(minutes % 60);
	return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

function fmtTempRange(day: DailyWeather | null | undefined): string {
	if (!day) return 'N/A';
	if (day.tempLow === null && day.tempHigh === null) return fmtNumber(day.tempAvg, ' F');
	return `${fmtNumber(day.tempLow, ' F')} / ${fmtNumber(day.tempHigh, ' F')}`;
}


const STATION_MAP_HEAD = `<link rel="stylesheet" href="/vendor/leaflet/leaflet.css">
<script src="/vendor/leaflet/leaflet.js"></script>`;

const STATION_MAP_STYLES = `#map { height: 60vh; min-height: 420px; width: 100%; border-radius: 8px; background: #eef2f7; }
.leaflet-container { background: #eef2f7; }
.leaflet-popup-content a { color: #1a6fd6; }`;

const STATION_MAP_INIT_SCRIPT = `<script>
(async function () {
  const el = document.getElementById('map');
  if (!el || typeof L === 'undefined') return;
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  map.setView([39.5, -98.35], 4);
  try {
    const res = await fetch('/api/stations/coords');
    const stations = await res.json();
    if (!Array.isArray(stations) || stations.length === 0) return;
    const markers = stations.map((s) =>
      L.marker([s.lat, s.lon])
        .bindPopup('<strong>' + s.id + '</strong><br><a href="/pws/' + encodeURIComponent(s.id) + '/dashboard">Dashboard</a>')
        .addTo(map),
    );
    if (markers.length === 1) {
      map.setView(markers[0].getLatLng(), 11);
    } else {
      const group = L.featureGroup(markers);
      map.fitBounds(group.getBounds(), { padding: [40, 40] });
    }
  } catch (err) {
    console.error('Failed to load station coords', err);
  }
})();
</script>`;

function renderHomePage(stationIds: string[]): string {
	const links = stationIds.map((id) =>
		'<li><a href="/pws/' + escHtml(id) + '/dashboard">' + escHtml(id) + '</a></li>'
	).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Weather Stations</title>
${STATION_MAP_HEAD}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f7f9fc; color: #1a1f2c; }
  .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
  h1 { color: #1a1f2c; margin: 0 0 16px; }
  a { color: #0e7fcf; text-decoration: none; }
  a:hover { text-decoration: underline; }
  ul { line-height: 2; }
  .empty { color: #5a6878; }
  ${STATION_MAP_STYLES}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Weather Dashboard</h1>
    <div id="map"></div>
    <p>Select a Personal Weather Station:</p>
    ${stationIds.length ? '<ul>' + links + '</ul>' : '<p class="empty">No stations configured. Set WU_STATION_IDS.</p>'}
  </div>
${STATION_MAP_INIT_SCRIPT}
</body>
</html>`;
}

function fmtPrettyDate(ymd: string): string {
	const [y, m, d] = ymd.split('-').map(Number);
	const date = new Date(Date.UTC(y, m - 1, d));
	return date.toLocaleDateString('en-US', {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric',
		timeZone: 'UTC',
	});
}

function renderRainPage(
	d: DashboardData,
	target: RainTarget,
	rainfall: number | null,
	neighborRain: NeighborRainReading[] = [],
): string {
	const prettyDate = fmtPrettyDate(target.date);
	const tz = d.timezone;
	const heading = target.isToday
		? 'How much has it rained today?'
		: target.isYesterday
			? 'How much did it rain yesterday?'
			: `How much did it rain on ${prettyDate}?`;
	const dateLine = target.isToday
		? `${prettyDate} (so far) at ${d.stationId}`
		: `${prettyDate} at ${d.stationId}`;
	const titleVerb = target.isToday ? "Today's" : target.isYesterday ? "Yesterday's" : prettyDate;

	const all: Array<{ id: string; name: string | null; distanceMi: number | null; rainfall: number; isPrimary: boolean }> = [];
	if (rainfall !== null) {
		all.push({ id: d.stationId, name: null, distanceMi: 0, rainfall, isPrimary: true });
	}
	for (const n of neighborRain) {
		if (n.rainfall !== null) {
			all.push({ id: n.stationId, name: n.name, distanceMi: n.distanceMi, rainfall: n.rainfall, isPrimary: false });
		}
	}
	const sorted = [...all].sort((a, b) => b.rainfall - a.rainfall);
	const primaryRank = rainfall !== null ? sorted.findIndex((s) => s.isPrimary) + 1 : 0;
	const others = sorted.filter((s) => !s.isPrimary).map((s) => s.rainfall);
	const median = others.length > 0 ? others.slice().sort((a, b) => a - b)[Math.floor(others.length / 2)] : null;

	const tableRows = [...all]
		.sort((a, b) => (a.distanceMi ?? 0) - (b.distanceMi ?? 0))
		.map((s) => {
			const cls = s.isPrimary ? ' class="you"' : '';
			const dist = s.isPrimary ? 'you' : s.distanceMi !== null ? `${s.distanceMi.toFixed(2)} mi` : '—';
			return `<tr${cls}><td>${escHtml(dist)}</td><td>${escHtml(s.id)}</td><td>${escHtml(s.rainfall.toFixed(2))}"</td></tr>`;
		})
		.join('');

	const comparisonBlock = all.length > 1
		? `<section class="compare">
    <div class="compare-summary">
      You ranked <strong>${primaryRank}</strong> of <strong>${sorted.length}</strong>${median !== null ? ` · neighborhood median <strong>${escHtml(median.toFixed(2))}"</strong>` : ''}
    </div>
    <table class="compare-table">
      <thead><tr><th>Distance</th><th>Station</th><th>Rain</th></tr></thead>
      <tbody>${tableRows}</tbody>
    </table>
  </section>`
		: '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(titleVerb)} Rain at ${escHtml(d.stationId)}</title>
${STATION_MAP_HEAD}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f7f9fc;
    color: #1a1f2c;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  main { text-align: center; max-width: 1000px; width: 100%; }
  h1 {
    margin: 0 0 8px;
    font-size: clamp(1.2rem, 3vw, 1.6rem);
    font-weight: 400;
    color: #5a6878;
  }
  .date {
    color: #1a1f2c;
    font-size: clamp(1rem, 2.5vw, 1.4rem);
    margin-bottom: 8px;
  }
  .answer {
    font-size: clamp(3rem, 10vw, 6rem);
    font-weight: 700;
    color: #0e7fcf;
    line-height: 1.1;
    margin: 16px 0 4px;
  }
  .unit { color: #5a6878; font-size: clamp(1rem, 2.5vw, 1.4rem); margin-bottom: 8px; }
  .none { color: #5a6878; font-size: clamp(2rem, 6vw, 3.5rem); font-weight: 600; margin: 16px 0; }
  .meta { color: #5a6878; font-size: .9rem; margin-top: 24px; line-height: 1.6; }
  .meta a { color: #0e7fcf; text-decoration: none; }
  .meta a:hover { text-decoration: underline; }
  .warning { color: #7a5a00; }
  .compare { margin-top: 40px; text-align: left; }
  .compare-summary { color: #1a1f2c; font-size: 1rem; margin-bottom: 12px; text-align: center; }
  .compare-table { width: 100%; border-collapse: collapse; font-size: .95rem; }
  .compare-table th, .compare-table td { padding: 6px 10px; border-bottom: 1px solid #e3e8ef; text-align: left; }
  .compare-table th { color: #5a6878; font-weight: 500; font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; }
  .compare-table tr.you { background: #e8f3fc; font-weight: 600; }
  .compare-table td:last-child, .compare-table th:last-child { text-align: right; }
  .map-section { margin-top: 32px; }
  ${STATION_MAP_STYLES}
  @media (max-width: 500px) { body { padding: 16px; } }
</style>
</head>
<body>
<main>
  <h1>${escHtml(heading)}</h1>
  <div class="date">${escHtml(dateLine)}</div>
  ${rainfall !== null
		? `<div class="answer">${escHtml(rainfall.toFixed(2))}"</div><div class="unit">inches</div>`
		: `<div class="none">No data available</div>`
  }
  ${comparisonBlock}
  <div class="map-section"><div id="map"></div></div>
  <div class="meta">
    ${tz ? `Timezone: ${escHtml(tz)}<br>` : ''}
    Source: ${escHtml(d.dataSource)}${d.warning ? `<br><span class="warning">${escHtml(d.warning)}</span>` : ''}<br>
    <a href="/pws/${escHtml(d.stationId)}/dashboard">Full dashboard →</a>
  </div>
</main>
<script id="rain-map-data" type="application/json">${safeScriptJson(buildRainMapData(d.stationId, rainfall, neighborRain))}</script>
<script>
(function () {
  const el = document.getElementById('map');
  const dataEl = document.getElementById('rain-map-data');
  if (!el || !dataEl || typeof L === 'undefined') return;
  let data;
  try { data = JSON.parse(dataEl.textContent || '{}'); } catch { return; }
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  map.setView([39.5, -98.35], 4);
  const fmtRain = (v) => v == null ? 'no data' : v.toFixed(2) + '"';
  const layers = [];
  if (data.primary && typeof data.primary.lat === 'number' && typeof data.primary.lon === 'number') {
    layers.push(
      L.circleMarker([data.primary.lat, data.primary.lon], {
        radius: 11, color: '#ffffff', weight: 2, fillColor: '#d83737', fillOpacity: 0.95,
      })
        .bindPopup('<strong>' + data.primary.id + '</strong> (you)<br>Rain: ' + fmtRain(data.primary.rainfall))
        .addTo(map),
    );
  }
  for (const n of (data.neighbors || [])) {
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue;
    layers.push(
      L.circleMarker([n.lat, n.lon], {
        radius: 7, color: '#ffffff', weight: 1.5, fillColor: '#1a6fd6', fillOpacity: 0.85,
      })
        .bindPopup('<strong>' + n.id + '</strong><br>' + (n.distanceMi != null ? n.distanceMi.toFixed(2) + ' mi away<br>' : '') + 'Rain: ' + fmtRain(n.rainfall))
        .addTo(map),
    );
  }
  if (layers.length === 1) {
    map.setView(layers[0].getLatLng(), 12);
  } else if (layers.length > 1) {
    map.fitBounds(L.featureGroup(layers).getBounds(), { padding: [40, 40] });
  }
})();
</script>
</body>
</html>`;
}

interface RainMapData {
	primary: { id: string; lat: number | null; lon: number | null; rainfall: number | null };
	neighbors: Array<{ id: string; lat: number | null; lon: number | null; rainfall: number | null; distanceMi: number | null }>;
}

function buildRainMapData(primaryId: string, primaryRainfall: number | null, neighborRain: NeighborRainReading[]): RainMapData {
	const primaryEntry = NEIGHBORS.stations[primaryId];
	const neighborMeta = new Map<string, NeighborEntry>();
	for (const n of primaryEntry?.neighbors ?? []) {
		neighborMeta.set(n.stationId, n);
	}
	return {
		primary: {
			id: primaryId,
			lat: primaryEntry?.lat ?? null,
			lon: primaryEntry?.lon ?? null,
			rainfall: primaryRainfall,
		},
		neighbors: neighborRain.map((n) => {
			const meta = neighborMeta.get(n.stationId);
			return {
				id: n.stationId,
				lat: meta?.lat ?? null,
				lon: meta?.lon ?? null,
				rainfall: n.rainfall,
				distanceMi: n.distanceMi,
			};
		}),
	};
}

function escHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
