/**
 * waxwing_wx - PWS rainfall dashboard (Weather Underground)
 *
 * Uses Weather Company / Weather Underground PWS historical daily summaries as
 * the source of truth for daily rainfall. Current conditions are fetched only
 * as a live supplement for today's in-progress reading and last observation.
 *
 * Config via secrets (set with `npx wrangler secret put <NAME>`):
 *   WU_API_KEY      - Weather Underground API key
 *   (station IDs live in KV under `weather:config:station-ids`, managed via `npm run add-station`)
 *
 * Routes:
 *   /[?pws=K1,K2]              - Station index (placeholder when no pws param)
 *   /rain[/<spec>]?pws=K1,K2   - Rain page for the listed stations
 *   /api/stations/coords?pws=K1,K2 - Coords JSON for the listed stations
 *
 * The `pws` param accepts bare IDs or `Label:ID` pairs, comma-separated, and may
 * be repeated (?pws=Alice:K1&pws=Bob:K2). Labels are shown in place of the raw
 * station ID on the home and rain pages.
 *   /pws/<stationId>           - Redirects to /pws/<stationId>/dashboard
 *   /pws/<stationId>/dashboard            - Per-station dashboard
 *   /pws/<stationId>/rain[/<spec>]        - Rainfall page; spec ∈ today (default) | yesterday | YYYY-MM-DD
 *
 * Optional KV namespace: WEATHER. Used as a cache when the historical API is
 * temporarily unavailable.
 */

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
const NEIGHBORS_KV_KEY = 'weather:config:neighbors';
const EMPTY_NEIGHBORS: NeighborsFile = { generatedAt: '', stations: {} };

// Refresh and display only the nearest few neighbors per primary. The stored
// config over-collects (discover-neighbors found 40+), and every extra neighbor
// is ~3 WU calls per refresh. Capping here — at the single read-point all
// consumers (cron refresh set, rain pages) go through — bounds WU volume no
// matter what's in KV.
export const MAX_NEIGHBORS_PER_STATION = 3;

export function nearestNeighbors(entries: NeighborEntry[]): NeighborEntry[] {
	return [...entries]
		.sort((a, b) => (a.distanceMi ?? Number.POSITIVE_INFINITY) - (b.distanceMi ?? Number.POSITIVE_INFINITY))
		.slice(0, MAX_NEIGHBORS_PER_STATION);
}

async function getNeighbors(env: Env): Promise<NeighborsFile> {
	const raw = await env.WEATHER.get(NEIGHBORS_KV_KEY);
	if (!raw) return EMPTY_NEIGHBORS;
	try {
		const parsed = JSON.parse(raw) as NeighborsFile;
		if (parsed && typeof parsed === 'object' && parsed.stations) {
			for (const entry of Object.values(parsed.stations)) {
				entry.neighbors = nearestNeighbors(entry.neighbors ?? []);
			}
			return parsed;
		}
	} catch {}
	return EMPTY_NEIGHBORS;
}

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

export interface DashboardData {
	stationId: string;
	today: DailyWeather | null;
	recentDays: DailyWeather[];
	hourly7Day: WUHistoryObservation[];
	historyIndex: HistoryIndex | null;
	current: WUCurrentObservation | null;
	lastReading: string;
	// When the cron last *successfully wrote* this station's current cache (from
	// the KV value's `cachedAt` metadata). This is ground truth for "is the
	// pipeline alive", unlike lastScheduledRun which is just the computed cron
	// clock and stays "fresh" even when every write is failing.
	lastWriteAt: string | null;
	lastScheduledRun: string | null;
	nextScheduledRun: string | null;
	dataSource: string;
	warning: string | null;
	timezone: string | null;
}

const CACHE_PREFIX = 'weather:dailySummaries:v1';
const HISTORY_PREFIX = 'weather:history:hourly:raw';
const HISTORY_BLOCK_DAYS = 31;

// Primaries fetch `current` every cron tick, but the slower-moving daily-summary
// and hourly-history only every Nth tick (4 => hourly). Cuts primary WU calls ~3x
// without making today's headline rainfall (driven by `current`) any staler.
const PRIMARY_FULL_EVERY_N_TICKS = 4;

// In-isolate dedup: skip KV PUTs when payload bytes match the last value we wrote
// for that key. Isolate restarts will re-PUT once; that's acceptable. Shared by
// the Station cache and the History block store, so the Write-dedup invariant
// lives in exactly one function — putDeduped.
const _stationDedup = new Map<string, string>();

/**
 * THE single place a KV write is suppressed (the Write-dedup invariant). Returns
 * true when it actually wrote, false when the payload was byte-identical to this
 * isolate's last write for the key — so callers with follow-on work (e.g. the
 * history index) can skip it too.
 */
export async function putDeduped(
	kv: KVNamespace,
	dedup: Map<string, string>,
	key: string,
	payload: string,
	metadata?: Record<string, unknown>,
): Promise<boolean> {
	if (dedup.get(key) === payload) return false;
	await kv.put(key, payload, metadata ? { metadata } : undefined);
	dedup.set(key, payload);
	return true;
}

/**
 * The Station cache: the single-value, id-keyed KV caches the cron writes and the
 * request path reads (current observation, coords, daily summaries). Owns each
 * cache's key, JSON shaping, metadata, write preconditions, and read parsing; the
 * Write-dedup invariant is delegated to putDeduped. Constructed with a
 * KVNamespace + dedup map so an in-memory fake can stand in for tests.
 */
export interface StationCache {
	current: {
		read(id: string): Promise<{ value: WUCurrentObservation | null; lastWriteAt: string | null }>;
		write(id: string, obs: WUCurrentObservation): Promise<void>;
	};
	coords: {
		read(id: string): Promise<{ lat: number; lon: number } | null>;
		/** No-ops unless the observation carries numeric lat/lon. */
		write(id: string, obs: WUCurrentObservation): Promise<void>;
	};
	daily: {
		read(id: string): Promise<DailyWeather[]>;
		/** No-ops on an empty list. */
		write(id: string, days: DailyWeather[]): Promise<void>;
	};
}

export function createStationCache(kv: KVNamespace, dedup: Map<string, string>): StationCache {
	return {
		current: {
			async read(id) {
				// One read fetches both the value and the cron's `cachedAt` write stamp.
				const { value, metadata } = await kv.getWithMetadata<{ cachedAt?: string }>(currentCacheKey(id));
				const lastWriteAt = typeof metadata?.cachedAt === 'string' ? metadata.cachedAt : null;
				if (!value) return { value: null, lastWriteAt };
				try {
					return { value: JSON.parse(value) as WUCurrentObservation, lastWriteAt };
				} catch {
					return { value: null, lastWriteAt };
				}
			},
			async write(id, obs) {
				await putDeduped(kv, dedup, currentCacheKey(id), JSON.stringify(obs), {
					stationId: id,
					cachedAt: new Date().toISOString(),
				});
			},
		},
		coords: {
			async read(id) {
				const raw = await kv.get(coordsCacheKey(id));
				if (!raw) return null;
				try {
					const parsed = JSON.parse(raw) as { lat: number; lon: number };
					if (typeof parsed.lat === 'number' && typeof parsed.lon === 'number') {
						return { lat: parsed.lat, lon: parsed.lon };
					}
				} catch {}
				return null;
			},
			async write(id, obs) {
				if (typeof obs.lat !== 'number' || typeof obs.lon !== 'number') return;
				await putDeduped(kv, dedup, coordsCacheKey(id), JSON.stringify({ lat: obs.lat, lon: obs.lon }));
			},
		},
		daily: {
			async read(id) {
				const raw = await kv.get(dailySummariesCacheKey(id));
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
			},
			async write(id, days) {
				if (days.length === 0) return;
				await putDeduped(kv, dedup, dailySummariesCacheKey(id), JSON.stringify(days), {
					stationId: id,
					cachedAt: new Date().toISOString(),
				});
			},
		},
	};
}

// One Station cache per isolate: the dedup map persists across requests (bounding
// writes against the KV budget) while kv is taken fresh from each invocation's
// env — bindings are per-invocation in Workers, so we memoize the map, not the
// binding.
function getStationCache(env: Env): StationCache {
	return createStationCache(env.WEATHER, _stationDedup);
}
// Marks (station, blockStart, blockEnd) tuples whose contribution is already reflected
// in the history index for this isolate — lets updateHistoryIndex short-circuit without a GET.
const HISTORY_INDEX_DONE = new Set<string>();
// Per-isolate marker: have we ensured the previous-month block exists for this station?
const PREV_MONTH_ENSURED = new Set<string>();

export default {
	// The cron is the ONLY place WU is touched on a schedule. It constructs the
	// `WuClient` capability and refreshes every KV cache the request path reads.
	async scheduled(event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		console.log('[cron] scheduled run started');
		const wu = createWuClient(env);

		const tickIndex = Math.floor(event.scheduledTime / (15 * 60 * 1000));
		const neighborEveryN = neighborRefreshEveryNTicks(env);
		const refreshNeighbors = tickIndex % neighborEveryN === 0;
		// Primaries get the full refresh (current + daily + history) only on the
		// hourly tick; every other tick refreshes just `current`.
		const primaryFull = tickIndex % PRIMARY_FULL_EVERY_N_TICKS === 0;

		const primaryIds = await getStationIds(env);
		console.log(`[cron] refreshing ${primaryIds.length} primary stations (tick ${tickIndex}, full=${primaryFull})`);
		for (const stationId of primaryIds) {
			await refreshStation(wu, env, stationId, { full: primaryFull });
		}

		if (refreshNeighbors) {
			const neighborIds = await getNeighborStationIds(env);
			console.log(`[cron] refreshing ${neighborIds.length} neighbor stations (tick ${tickIndex}, every ${neighborEveryN})`);
			for (const stationId of neighborIds) {
				await refreshStation(wu, env, stationId, { full: true });
			}
		} else {
			console.log(`[cron] skipping neighbor refresh (tick ${tickIndex}, cadence every ${neighborEveryN})`);
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

		// Home page — static shell; the station list is hydrated client-side
		// from the localStorage manifest. Any ?pws= param is consumed by the
		// client store script, which then redirects to a clean "/".
		if (url.pathname === '/') {
			return new Response(renderHomePage(), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		}

		// /pws/<id> -> /pws/<id>/dashboard
		const pwsBareMatch = /^\/pws\/([^/]+)\/?$/.exec(url.pathname);
		if (pwsBareMatch) {
			return Response.redirect(`${url.origin}/pws/${pwsBareMatch[1]}/dashboard`, 302);
		}

		// /rain[/<spec>]?pws=K1,K2   all listed stations on one page
		const allRainMatch = /^\/rain(?:\/([^/]+))?\/?$/.exec(url.pathname);
		if (allRainMatch) {
			const spec = allRainMatch[1] ? decodeURIComponent(allRainMatch[1]) : 'today';
			const pwsStations = parsePwsParam(url.searchParams.getAll('pws'));
			if (pwsStations.length === 0) {
				return new Response('Missing ?pws=K1,K2 query parameter.', { status: 400 });
			}
			try {
				const stations = await Promise.all(pwsStations.map(async ({ id: stationId, label }) => {
					const dashboard = await buildDashboard(env, stationId);
					const target = resolveRainTarget(dashboard, spec);
					if ('error' in target) return { error: target.error, stationId };
					const [rainfall, neighborRain] = await Promise.all([
						loadRainfallForDate(env, stationId, dashboard, target.date, target.isToday),
						fetchNeighborRainfallForDate(env, stationId, target.date),
					]);
					return { stationId, label, dashboard, target, rainfall, neighborRain };
				}));
				const firstError = stations.find((s): s is { error: string; stationId: string } => 'error' in s);
				if (firstError) return new Response(firstError.error, { status: 400 });
				const neighbors = await getNeighbors(env);
				return new Response(renderAllRainPage(spec, stations as MultiRainEntry[], neighbors), {
					headers: { 'Content-Type': 'text/html; charset=utf-8' },
				});
			} catch (err: unknown) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error(`All-rain page error (${spec}):`, msg);
				return new Response(`Error: ${msg}`, { status: 500 });
			}
		}

		// /pws/<id>/rain[/<spec>]   spec defaults to today; can be 'today', 'yesterday', or YYYY-MM-DD
		const pwsRainMatch = /^\/pws\/([^/]+)\/rain(?:\/([^/]+))?\/?$/.exec(url.pathname);
		if (pwsRainMatch) {
			const stationId = decodeURIComponent(pwsRainMatch[1]);
			const spec = pwsRainMatch[2] ? decodeURIComponent(pwsRainMatch[2]) : 'today';
			if (!(await isValidStation(env, stationId))) {
				return new Response('Station not found.', { status: 404 });
			}
			try {
				const dashboard = await buildDashboard(env, stationId);
				const target = resolveRainTarget(dashboard, spec);
				if ('error' in target) {
					return new Response(target.error, { status: 400 });
				}
				const rainfall = await loadRainfallForDate(env, stationId, dashboard, target.date, target.isToday);
				const neighborRain = await fetchNeighborRainfallForDate(env, stationId, target.date);
				const neighbors = await getNeighbors(env);
				return new Response(renderRainPage(dashboard, target, rainfall, neighborRain, neighbors), {
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
			if (!(await isValidStation(env, stationId))) {
				return new Response('Station not found.', { status: 404 });
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
			const pwsStations = parsePwsParam(url.searchParams.getAll('pws'));
			if (pwsStations.length === 0) {
				return new Response(JSON.stringify({ error: 'Missing ?pws=K1,K2 query parameter.' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}
			const coords = await getStationCoordsList(env, pwsStations.map((s) => s.id));
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
			const stationId = urlObj.searchParams.get('stationId') ?? (await getDefaultStation(env));
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
		loadHourly7Day(env, stationId),
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
		lastWriteAt: currentResult.lastWriteAt,
		lastScheduledRun,
		nextScheduledRun,
		dataSource: dailyResult.source,
		warning: joinWarnings(dailyResult.warning, currentResult.warning),
		timezone: current?.tz ?? recentDays.findLast((d) => !!d.tz)?.tz ?? null,
	};
}

async function loadCurrent(
	env: Env,
	stationId: string,
): Promise<{ current: WUCurrentObservation | null; lastWriteAt: string | null; warning: string | null }> {
	if (!env.WEATHER) return { current: null, lastWriteAt: null, warning: 'Current conditions unavailable (no KV).' };
	const { value, lastWriteAt } = await getStationCache(env).current.read(stationId);
	if (!value) {
		return { current: null, lastWriteAt, warning: 'Current conditions unavailable (not yet cached by the scheduled refresh).' };
	}
	return { current: value, lastWriteAt, warning: null };
}

const CURRENT_PREFIX = 'weather:current:v1';

function currentCacheKey(stationId: string): string {
	return `${CURRENT_PREFIX}:${stationId}`;
}

async function readCachedCurrent(env: Env, stationId: string): Promise<WUCurrentObservation | null> {
	if (!env.WEATHER) return null;
	return (await getStationCache(env).current.read(stationId)).value;
}

/** KV write only — no WU access. Caller supplies the observation from the cron's single fetch. */
async function cacheCurrent(env: Env, stationId: string, current: WUCurrentObservation): Promise<void> {
	if (!env.WEATHER) return;
	await getStationCache(env).current.write(stationId, current);
}

async function fetchCurrent(wu: WuClient, stationId: string): Promise<WUCurrentObservation | null> {
	const body = await fetchJson<WUCurrentResponse>(wu, stationId, '/v2/pws/observations/current', {
		numericPrecision: false,
	});
	return body.observations?.[0] ?? null;
}

async function fetchDailySummaries(wu: WuClient, stationId: string): Promise<DailyWeather[]> {
	const body = await fetchJson<WUDailySummaryResponse>(wu, stationId, '/v2/pws/dailysummary/7day', {
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
	const neighbors = await getNeighbors(env);
	const entry = neighbors.stations[primaryId];
	if (!entry || entry.neighbors.length === 0) {
		console.log(`[neighbors] no neighbors configured for primary=${primaryId}`);
		return [];
	}
	console.log(`[neighbors] primary=${primaryId} date=${date} fetching for ${entry.neighbors.length} neighbors`);
	return Promise.all(
		entry.neighbors.map(async (n): Promise<NeighborRainReading> => {
			const base = { stationId: n.stationId, name: n.name, distanceMi: n.distanceMi };
			// KV history blocks only — populated by the cron. The request path never
			// hits WU live; neighbor data not yet in KV simply reads as unavailable.
			try {
				const days = await loadHistoryDailyRange(env, n.stationId, date, date);
				const match = days.find((d) => d.date === date);
				if (match && match.rainfall !== null) {
					console.log(`[neighbors] KV-HIT  ${n.stationId} ${date} rain=${match.rainfall}`);
					return { ...base, rainfall: match.rainfall, error: null };
				}
				const reason = match ? 'date matched but rainfall=null' : `no block covered ${date} (blocks loaded=${days.length}, dates=${days.map((d) => d.date).join(',') || 'none'})`;
				console.warn(`[neighbors] KV-MISS ${n.stationId} ${date} — ${reason}`);
				return { ...base, rainfall: null, error: 'no data in KV' };
			} catch (err: unknown) {
				const msg = errMsg(err);
				console.warn(`[neighbors] KV-ERR  ${n.stationId} ${date}: ${msg}`);
				return { ...base, rainfall: null, error: msg };
			}
		}),
	);
}

async function fetchHistoryHourlyRawRange(
	wu: WuClient,
	stationId: string,
	startDate: string,
	endDate: string,
): Promise<{ text: string; records: number }> {
	const text = await fetchRaw(wu, stationId, '/v2/pws/history/hourly', {
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
	wu: WuClient,
	stationId: string,
	path: string,
	options: { numericPrecision: boolean; params?: Record<string, string> },
): Promise<T> {
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
	url.searchParams.set('apiKey', wu.apiKey);
	assertWuUrl(url, wu);

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
	wu: WuClient,
	stationId: string,
	path: string,
	options: { numericPrecision: boolean; params?: Record<string, string> },
): Promise<string> {
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
	url.searchParams.set('apiKey', wu.apiKey);
	assertWuUrl(url, wu);

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

/**
 * Capability object that authorizes Weather Underground API access.
 *
 * Constructed ONLY in `scheduled()` (the cron) and in admin handlers after
 * `authorizeAdmin` passes. The request path never builds one, so reader code
 * cannot reach WU — the boundary is enforced by the type system. `fetchJson` /
 * `fetchRaw` take a `WuClient` instead of `env`, so the API key is unreachable
 * without this capability.
 */
interface WuClient {
	readonly apiKey: string;
}

function createWuClient(env: Env): WuClient {
	const apiKey = cleanSecret(env.WU_API_KEY);
	if (!apiKey) throw new Error('Missing WU_API_KEY configuration.');
	return { apiKey };
}

/** Tripwire: the only two functions that fetch WU must go through here. */
function assertWuUrl(url: URL, wu: WuClient): void {
	if (url.hostname !== 'api.weather.com' || !wu.apiKey) {
		throw new Error(`Refusing WU fetch: host=${url.hostname} authorized=${Boolean(wu.apiKey)}`);
	}
}

function errMsg(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Cron tick cadence for refreshing neighbor stations (every Nth 15-min tick). */
function neighborRefreshEveryNTicks(env: Env): number {
	const raw = cleanSecret(env.NEIGHBOR_REFRESH_EVERY_N_TICKS);
	const n = raw ? Number.parseInt(raw, 10) : NaN;
	return Number.isFinite(n) && n >= 1 ? n : 4;
}
const STATION_IDS_KV_KEY = 'weather:config:station-ids';

function parseStationIdList(raw: string): string[] {
	return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

async function getStationIds(env: Env): Promise<string[]> {
	const fromKv = await env.WEATHER.get(STATION_IDS_KV_KEY);
	if (!fromKv) return [];
	return parseStationIdList(cleanSecret(fromKv));
}

async function getDefaultStation(env: Env): Promise<string | undefined> {
	return (await getStationIds(env))[0];
}

async function isValidStation(env: Env, stationId: string): Promise<boolean> {
	return (await getStationIds(env)).includes(stationId);
}

async function isKnownNeighbor(env: Env, stationId: string): Promise<boolean> {
	const neighbors = await getNeighbors(env);
	for (const entry of Object.values(neighbors.stations)) {
		if (entry.neighbors.some((n) => n.stationId === stationId)) return true;
	}
	return false;
}

// Distinct neighbor station IDs across all primaries — the set the cron
// refreshes on the slower `NEIGHBOR_REFRESH_EVERY_N_TICKS` cadence.
async function getNeighborStationIds(env: Env): Promise<string[]> {
	const neighbors = await getNeighbors(env);
	const ids = new Set<string>();
	for (const entry of Object.values(neighbors.stations)) {
		for (const n of entry.neighbors) ids.add(n.stationId);
	}
	return [...ids];
}

type StationRole = 'primary' | 'neighbor' | 'unknown';
async function getStationRole(env: Env, stationId: string): Promise<StationRole> {
	if (await isValidStation(env, stationId)) return 'primary';
	if (await isKnownNeighbor(env, stationId)) return 'neighbor';
	return 'unknown';
}

interface SpanStats {
	rain: number | null;
	tempAvg: number | null;
	windAvg: number | null;
}
interface StationSpanStats {
	current: SpanStats;
	day: SpanStats;
	week: SpanStats;
}
interface StationCoords {
	id: string;
	lat: number;
	lon: number;
	stats: StationSpanStats;
}

const COORDS_KV_PREFIX = 'station:coords:v1';

type StationLatLon = Omit<StationCoords, 'stats'>;

function coordsCacheKey(stationId: string): string {
	return `${COORDS_KV_PREFIX}:${stationId}`;
}

// Read-only: coords are populated by the cron via `cacheStationCoords`. A
// station with no cached coords is simply omitted from the response — the
// request path never fetches WU to discover them.
async function getStationCoords(env: Env, stationId: string): Promise<StationLatLon | null> {
	const coords = await getStationCache(env).coords.read(stationId);
	return coords ? { id: stationId, lat: coords.lat, lon: coords.lon } : null;
}

/**
 * KV write only — derives coords from the cron's already-fetched observation.
 *
 * Coords are effectively static, but this ran every cron tick for every station
 * (no dedup, TTL-only), which alone burned ~1 write/station/tick — the single
 * biggest contributor to blowing the daily KV write budget. We now dedup on
 * payload like the other caches and drop the TTL: a station's lat/lon never
 * changes, so re-writing it (and letting it expire) is pure waste.
 */
async function cacheStationCoords(env: Env, stationId: string, current: WUCurrentObservation): Promise<void> {
	if (!env.WEATHER) return;
	await getStationCache(env).coords.write(stationId, current);
}

function meanOrNull(vals: Array<number | null>): number | null {
	const nums = vals.filter((v): v is number => typeof v === 'number');
	return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

// Rainfall over a recent window from hourly observations.
//
// WU's hourly `precipTotal` is a per-LOCAL-DAY running counter, but it is NOT
// monotonic — QC corrections nudge it back down within the day (you'll see it
// drift down even while precipRate is 0). The previous implementation summed
// deltas and treated every downward step as a midnight rollover, re-adding the
// full counter each time; on a single rainy day that inflated the 24h figure to
// several times the real total (famously making "24h" exceed "7d").
//
// Instead we never infer rollovers from value drops: we bucket by obsTimeLocal
// date and take each date's max (its daily total). The window's oldest date is
// only partially covered, so we subtract the counter value at the window's
// start. Each date thus contributes <= its daily-summary total, which keeps this
// consistent with the 7-day sum and guarantees 24h <= 7d.
export function sumPrecipDeltas(obs: WUHistoryObservation[]): number | null {
	const points = obs
		.map((o) => ({
			date: o.obsTimeLocal ? localDate(o.obsTimeLocal) : null,
			pt: numberOrNull(o.imperial?.precipTotal),
			t: obsTimeMs(o),
		}))
		.filter((p): p is { date: string; pt: number; t: number } => p.date !== null && p.pt !== null && Number.isFinite(p.t))
		.sort((a, b) => a.t - b.t);
	if (points.length === 0) return null;

	const byDate = new Map<string, { first: number; max: number }>();
	for (const p of points) {
		const cur = byDate.get(p.date);
		if (!cur) byDate.set(p.date, { first: p.pt, max: p.pt });
		else cur.max = Math.max(cur.max, p.pt);
	}

	const dates = [...byDate.keys()].sort();
	let total = 0;
	dates.forEach((date, i) => {
		const { first, max } = byDate.get(date)!;
		// Oldest date is the partial boundary — count only what fell after the
		// window opened. Later dates sit fully inside the window.
		total += i === 0 ? Math.max(0, max - first) : max;
	});
	return total;
}

function obsTimeMs(o: WUHistoryObservation): number {
	if (o.obsTimeUtc) {
		const t = Date.parse(o.obsTimeUtc);
		if (Number.isFinite(t)) return t;
	}
	return typeof o.epoch === 'number' ? o.epoch * 1000 : NaN;
}

// Pure derivation of the current / 24h / 7d span stats. Separated from KV IO so
// the rainfall invariants below can be exhaustively tested (see
// test/span-stats-invariants.test.ts). `nowMs` is injected for determinism.
export function computeSpanStats(
	current: WUCurrentObservation | null,
	hourly: WUHistoryObservation[],
	days: DailyWeather[],
	nowMs: number,
): StationSpanStats {
	const empty = (): SpanStats => ({ rain: null, tempAvg: null, windAvg: null });

	const cur = empty();
	if (current?.imperial) {
		cur.tempAvg = numberOrNull(current.imperial.temp);
		cur.windAvg = numberOrNull(current.imperial.windSpeed);
		cur.rain = numberOrNull(current.imperial.precipTotal);
	}

	const day = empty();
	const cutoffMs = nowMs - 24 * 3600 * 1000;
	const recent = hourly.filter((o) => {
		const t = obsTimeMs(o);
		return Number.isFinite(t) && t >= cutoffMs;
	});
	if (recent.length > 0) {
		day.tempAvg = meanOrNull(recent.map((o) => numberOrNull(o.imperial?.tempAvg ?? o.imperial?.temp)));
		day.windAvg = meanOrNull(recent.map((o) => numberOrNull(o.imperial?.windspeedAvg ?? o.imperial?.windSpeed)));
		day.rain = sumPrecipDeltas(recent);
	}

	const week = empty();
	if (days.length > 0) {
		const rainVals = days.map((d) => d.rainfall).filter((r): r is number => typeof r === 'number');
		week.rain = rainVals.length > 0 ? rainVals.reduce((a, b) => a + b, 0) : null;
		week.tempAvg = meanOrNull(days.map((d) => d.tempAvg));
		week.windAvg = meanOrNull(days.map((d) => d.windAvg));
	}

	// INVARIANT (enforced + tested): rain over the last 24h can never exceed rain
	// over the last 7d. The two come from different WU endpoints (hourly vs daily
	// summary), so a source disagreement could in principle violate it. Clamping
	// the 24h figure to the 7d total — a hard upper bound on any sub-window — can
	// only ever tighten an over-count, never fabricate rain. So we can guarantee
	// the user is never shown 24h > 7d.
	if (day.rain !== null && week.rain !== null && day.rain > week.rain) {
		day.rain = week.rain;
	}

	return { current: cur, day, week };
}

// Thin IO wrapper: loads the caches the cron populates (no WU access), then
// defers all arithmetic to the pure computeSpanStats above.
async function getStationSpanStats(env: Env, stationId: string): Promise<StationSpanStats> {
	const [current, hourly, days] = await Promise.all([
		readCachedCurrent(env, stationId),
		loadHourly7Day(env, stationId),
		loadDailySummaries(env, stationId).then((r) => r.days),
	]);
	const stats = computeSpanStats(current, hourly, days, Date.now());
	console.log(
		`[spanstats] ${stationId} hourly=${hourly.length} ` +
		`current={t:${stats.current.tempAvg},w:${stats.current.windAvg},r:${stats.current.rain}} ` +
		`day={t:${stats.day.tempAvg},w:${stats.day.windAvg},r:${stats.day.rain}} ` +
		`week={t:${stats.week.tempAvg},w:${stats.week.windAvg},r:${stats.week.rain}}`,
	);
	return stats;
}

async function getStationCoordsList(env: Env, stationIds: string[]): Promise<StationCoords[]> {
	const results = await Promise.all(
		stationIds.map(async (id): Promise<StationCoords | null> => {
			const [coords, stats] = await Promise.all([
				getStationCoords(env, id),
				getStationSpanStats(env, id),
			]);
			return coords ? { ...coords, stats } : null;
		}),
	);
	return results.filter((c): c is StationCoords => c !== null);
}

const PWS_ID_RE = /^[A-Za-z0-9]{3,32}$/;
export interface PwsStation {
	id: string;
	label?: string;
}

export function parsePwsParam(raw: string[]): PwsStation[] {
	const out: PwsStation[] = [];
	const seen = new Set<string>();
	for (const value of raw) {
		for (const piece of value.split(',')) {
			const colon = piece.lastIndexOf(':');
			const id = (colon >= 0 ? piece.slice(colon + 1) : piece).trim().toUpperCase();
			const label = colon >= 0 ? piece.slice(0, colon).trim() : '';
			if (!PWS_ID_RE.test(id)) continue;
			if (seen.has(id)) continue;
			seen.add(id);
			out.push(label ? { id, label } : { id });
			if (out.length >= 32) return out;
		}
	}
	return out;
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

	// WU access is granted only after the admin token check above passes.
	const wu = createWuClient(env);
	const url = new URL(req.url);
	const stationId = url.searchParams.get('stationId') ?? fallbackStationId ?? (await getDefaultStation(env));
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
	const raw = await fetchHistoryHourlyRawRange(wu, stationId, blockStart, blockEnd);
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

async function refreshDailySummaryCache(wu: WuClient, env: Env, stationId: string): Promise<void> {
	const days = await fetchDailySummaries(wu, stationId);
	await cacheDailySummaries(env, stationId, days);
}

async function refreshRecentHistory(wu: WuClient, env: Env, stationId: string): Promise<void> {
	const now = new Date();
	const yesterdayYmd = dateToYmd(addUtcDays(now, -1));
	const currentMonthStart = monthStartYmd(now);
	const currentMonthEnd = monthEndYmd(now);

	// Stable per-calendar-month key. Mid-month payloads are partial; the key range claims
	// the full month so readers can look it up deterministically.
	if (currentMonthStart <= yesterdayYmd) {
		const fetchEnd = minYmd(currentMonthEnd, yesterdayYmd);
		const raw = await fetchHistoryHourlyRawRange(wu, stationId, currentMonthStart, fetchEnd);
		const key = historyBlockKey(stationId, currentMonthStart, currentMonthEnd);
		await writeHistoryBlock(env, stationId, key, raw.text, currentMonthStart, currentMonthEnd, raw.records);
	}

	// Make sure the previous month's block exists. Once written, dedup keeps subsequent
	// ticks no-op since the prior month no longer changes.
	const prevAnchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15));
	const prevStart = monthStartYmd(prevAnchor);
	const prevEnd = monthEndYmd(prevAnchor);
	const prevMarker = `${stationId}:${prevStart}`;
	if (!PREV_MONTH_ENSURED.has(prevMarker)) {
		const existing = await env.WEATHER.get(historyBlockKey(stationId, prevStart, prevEnd));
		if (!existing) {
			const raw = await fetchHistoryHourlyRawRange(wu, stationId, prevStart, prevEnd);
			const key = historyBlockKey(stationId, prevStart, prevEnd);
			await writeHistoryBlock(env, stationId, key, raw.text, prevStart, prevEnd, raw.records);
		}
		PREV_MONTH_ENSURED.add(prevMarker);
	}
}

// Refreshes the KV caches the request path reads for one station. `current` is
// fetched on every call (cheap, changes every tick, and keeps today's headline
// rainfall + the staleness clock fresh); the heavier daily-summary and hourly-
// history fetches run only when `full` is set, so primaries can poll `current`
// every 15m while the slower data refreshes hourly — keeping WU calls under the
// PWS API quota. A single `fetchCurrent` feeds both the current and coords
// caches. Per-station errors are logged and swallowed so one bad station can't
// abort the rest of the cron run.
async function refreshStation(wu: WuClient, env: Env, stationId: string, opts: { full: boolean }): Promise<void> {
	try {
		const current = await fetchCurrent(wu, stationId).catch((err) => {
			console.warn(`[cron] ${stationId} current fetch failed: ${errMsg(err)}`);
			return null;
		});
		if (current) {
			await cacheCurrent(env, stationId, current);
			await cacheStationCoords(env, stationId, current);
		}
		if (opts.full) {
			await refreshDailySummaryCache(wu, env, stationId);
			await refreshRecentHistory(wu, env, stationId);
		}
	} catch (err: unknown) {
		console.error(`[cron] ${stationId} refresh failed: ${errMsg(err)}`);
	}
}

/** Read-only: builds the 7-day hourly view from KV history blocks. Never hits WU. */
async function loadHourly7Day(env: Env, stationId: string): Promise<WUHistoryObservation[]> {
	if (!env.WEATHER) return [];
	const today = dateToYmd(new Date());
	const start = dateToYmd(addUtcDays(ymdToDate(today), -6));
	const isoStart = ymdToIsoDate(start);
	const isoEnd = ymdToIsoDate(today);

	try {
		const keys = monthKeysForRange(stationId, start, today);
		const blocks = await Promise.all(keys.map((key) => env.WEATHER.get(key)));
		const observations = blocks.flatMap((raw) => parseHistoryObservations(raw));
		return observations
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
	const wrote = await putDeduped(env.WEATHER, _stationDedup, kvKey, rawJson, {
		stationId: stationId,
		endpoint: 'hourly',
		startDate,
		endDate,
		records,
		storedAt: new Date().toISOString(),
	});
	// Payload unchanged since this isolate's last write — skip the downstream index
	// update too (it would have no effect on the covered range).
	if (wrote) await updateHistoryIndex(env, stationId, startDate, endDate, records);
}

async function updateHistoryIndex(env: Env, stationId: string, startDate: string, endDate: string, records: number): Promise<void> {
	if (!env.WEATHER) return;
	const signature = `${stationId}:${startDate}:${endDate}`;
	if (HISTORY_INDEX_DONE.has(signature)) return;

	const existing = await readHistoryIndex(env, stationId);
	const startIso = ymdToIsoDate(startDate);
	const endIso = ymdToIsoDate(endDate);
	const earliest = existing?.earliestDate && existing.earliestDate < startIso ? existing.earliestDate : startIso;
	const latest = existing?.latestDate && existing.latestDate > endIso ? existing.latestDate : endIso;

	if (existing && existing.earliestDate === earliest && existing.latestDate === latest) {
		// Index already covers this contribution — no PUT needed.
		HISTORY_INDEX_DONE.add(signature);
		return;
	}

	const next: HistoryIndex = {
		stationId: stationId,
		endpoint: 'hourly',
		earliestDate: earliest,
		latestDate: latest,
		// Counters frozen: the cron now rewrites stable month-aligned keys, so naive
		// "+1 per call" inflated them indefinitely. Treat both as best-effort metadata
		// rather than authoritative state.
		blocksStored: existing?.blocksStored ?? 0,
		recordsStored: existing?.recordsStored ?? 0,
		updatedAt: new Date().toISOString(),
	};
	await env.WEATHER.put(historyIndexKey(stationId), JSON.stringify(next));
	HISTORY_INDEX_DONE.add(signature);
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
	const stationId = url.searchParams.get('stationId') ?? fallbackStationId ?? (await getDefaultStation(env));
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

async function loadHistoryDailyRange(
	env: Env,
	stationId: string,
	start: string,
	end: string,
	options: { deterministic?: boolean } = {},
): Promise<DailyWeather[]> {
	if (!env.WEATHER) return [];

	// Hot path: skip WEATHER.list entirely by deriving month-aligned keys from the range.
	// Only safe for stations whose data is written by the cron (primary stations);
	// neighbor stations may have legacy 31-day backfill keys that aren't month-aligned.
	if (options.deterministic) {
		const keys = monthKeysForRange(stationId, isoDateToYmd(start), isoDateToYmd(end));
		const blocks = await Promise.all(keys.map((key) => env.WEATHER.get(key)));
		const observations = blocks.flatMap((raw) => parseHistoryObservations(raw));
		return aggregateHistoryObservations(observations, start, end);
	}

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

// Read-only: daily summaries come from KV, populated by the cron. On a cache
// miss the request path returns empty rather than reaching WU live.
async function loadDailySummaries(env: Env, stationId: string): Promise<{ days: DailyWeather[]; source: string; warning: string | null }> {
	const cachedDays = await readCachedDailySummaries(env, stationId);
	if (cachedDays.length > 0) {
		return { days: cachedDays, source: 'KV cache (refreshed by cron every 15m)', warning: null };
	}
	return { days: [], source: 'none', warning: 'Daily summaries unavailable (not yet cached by the scheduled refresh).' };
}

async function cacheDailySummaries(env: Env, stationId: string, days: DailyWeather[]): Promise<void> {
	if (!env.WEATHER) return;
	await getStationCache(env).daily.write(stationId, days);
}

async function readCachedDailySummaries(env: Env, stationId: string): Promise<DailyWeather[]> {
	if (!env.WEATHER) return [];
	return getStationCache(env).daily.read(stationId);
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
	const days = await loadHistoryDailyRange(env, stationId, date, date, { deterministic: true });
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

function monthStartYmd(date: Date): string {
	return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}01`;
}

function monthEndYmd(date: Date): string {
	const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
	return dateToYmd(last);
}

// Returns the month-aligned history block keys covering the given YMD range, in order.
function monthKeysForRange(stationId: string, startYmd: string, endYmd: string): string[] {
	const keys: string[] = [];
	const startDate = ymdToDate(startYmd);
	let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
	const endDate = ymdToDate(endYmd);
	while (cursor <= endDate) {
		keys.push(historyBlockKey(stationId, monthStartYmd(cursor), monthEndYmd(cursor)));
		cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
	}
	return keys;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value, null, 2), {
		status,
		headers: { 'Content-Type': 'application/json; charset=utf-8' },
	});
}

// Data is considered stale after more than two cron ticks (15m each) without a
// successful write. One number, used by both the staleness verdict and the test
// that proves the UI can't hide staleness.
export const STALE_AFTER_MINUTES = 35;

export interface Freshness {
	/** Minutes since the cron last successfully wrote this station (null = never). */
	writeAgeMinutes: number | null;
	/** True when the shown data must be flagged stale. */
	stale: boolean;
}

/**
 * THE single source of truth for "is the data the dashboard is about to show
 * stale?". `renderDashboard` derives its staleness banner from exactly this, and
 * test/freshness-honesty.test.ts asserts the biconditional `stale <=> banner
 * present` across the full range of write ages — so showing stale data without
 * the indicator (or crying wolf when fresh) is a test failure.
 */
export function evaluateFreshness(lastWriteAt: string | null, nowMs: number): Freshness {
	const writeMs = lastWriteAt ? Date.parse(lastWriteAt) : null;
	const writeAgeMinutes =
		writeMs !== null && Number.isFinite(writeMs) ? Math.max(0, Math.floor((nowMs - writeMs) / 60_000)) : null;
	return { writeAgeMinutes, stale: writeAgeMinutes === null || writeAgeMinutes > STALE_AFTER_MINUTES };
}

export function renderDashboard(d: DashboardData, includeLiveReload: boolean, nowMs: number = Date.now()): string {
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
	const pwsAge = staleMs && Number.isFinite(staleMs) ? Math.max(0, Math.floor((nowMs - staleMs) / 60_000)) : null;
	// Freshness from the actual last successful write, not the cron clock. If the
	// cron is running but its KV writes are failing (e.g. the daily write limit),
	// lastScheduledRun still ticks forward while lastWriteAt goes stale — so this
	// is what we trust and surface. Single chokepoint: evaluateFreshness.
	const { writeAgeMinutes: dataAge, stale: dataStale } = evaluateFreshness(d.lastWriteAt, nowMs);
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
  .notice-error {
    border-color: #e2a3a3;
    background: #fdeaea;
    color: #8a1f1f;
    font-weight: 600;
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
      <h1 data-pws-id="${escHtml(d.stationId)}">${escHtml(d.stationId)}</h1>
      <div class="subtitle">Temperature, rain, wind avg, and gusts</div>
    </div>
    <div class="meta">
      PWS → WU: ${escHtml(d.lastReading)}${pwsAge !== null ? ` (${fmtDuration(pwsAge)} ago)` : ''}<br>
      Last data update: ${
				d.lastWriteAt
					? escHtml(d.lastWriteAt.slice(11, 16)) +
						' UTC' +
						(dataAge !== null ? ` (${fmtDuration(dataAge)} ago)` : '') +
						(dataStale ? ' ⚠' : '')
					: 'never'
			}<br>
      Reading stale: ${staleMs && Number.isFinite(staleMs) ? `<span id="stale-timer" data-stale-ms="${staleMs}">--:--</span>` : 'N/A'}<br>
      Next fetch: ${scheduleCountdown || 'N/A'} (scheduled)
    </div>
  </header>

  ${
		dataStale
			? `<div class="notice notice-error" data-testid="stale-banner">Data hasn't refreshed ${
					dataAge !== null ? `in ${fmtDuration(dataAge)}` : 'yet'
				}. The scheduled worker may be running but failing to write (e.g. the daily KV write limit). Showing the last values that landed in KV.</div>`
			: ''
	}
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
${PWS_STORE_SCRIPT}
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

// Client-side PWS store. localStorage holds the manifest of "my stations" as
// [{id, label?}]. Any ?pws= param is treated purely as a loader: it upserts
// into the manifest (an incoming label overwrites a stored one; a bare id never
// clobbers an existing label) and is then stripped from the URL. On the home
// page that means a redirect to "/"; elsewhere the bare ids are kept so the
// server can still resolve the page. window.PwsStore exposes the manifest plus
// displayName(id) -> "Label (ID)" and decorate(), which rewrites every
// [data-pws-id] element to its display name.
const PWS_STORE_SCRIPT = `<script>
(function () {
  var KEY = 'pwsStations';
  var ID_RE = /^[A-Za-z0-9]{3,32}$/;
  function read() {
    try {
      var arr = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr
        .filter(function (s) { return s && typeof s.id === 'string' && ID_RE.test(s.id); })
        .map(function (s) { return s.label ? { id: s.id, label: String(s.label) } : { id: s.id }; });
    } catch (e) { return []; }
  }
  function write(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list)); } catch (e) {}
  }
  function parseParam(values) {
    var out = [], seen = {};
    for (var i = 0; i < values.length; i++) {
      var pieces = values[i].split(',');
      for (var j = 0; j < pieces.length; j++) {
        var piece = pieces[j];
        var colon = piece.lastIndexOf(':');
        var id = (colon >= 0 ? piece.slice(colon + 1) : piece).trim().toUpperCase();
        var label = colon >= 0 ? piece.slice(0, colon).trim() : '';
        if (!ID_RE.test(id) || seen[id]) continue;
        seen[id] = 1;
        out.push(label ? { id: id, label: label } : { id: id });
        if (out.length >= 32) return out;
      }
    }
    return out;
  }
  function merge(stored, incoming) {
    var byId = {}, order = [];
    for (var i = 0; i < stored.length; i++) { byId[stored[i].id] = stored[i]; order.push(stored[i].id); }
    for (var k = 0; k < incoming.length; k++) {
      var inc = incoming[k];
      if (byId[inc.id]) {
        if (inc.label) byId[inc.id] = { id: inc.id, label: inc.label };
      } else {
        byId[inc.id] = inc;
        order.push(inc.id);
      }
    }
    return order.map(function (id) { return byId[id]; });
  }
  var params = new URLSearchParams(location.search);
  var rawPws = params.getAll('pws');
  var redirected = false;
  if (rawPws.length) {
    var incoming = parseParam(rawPws);
    if (incoming.length) write(merge(read(), incoming));
    if (location.pathname === '/') {
      location.replace('/');
      redirected = true;
    } else if (incoming.some(function (s) { return !!s.label; })) {
      // keep the page working but drop the "ugly" Label: prefixes from the bar
      params.delete('pws');
      params.append('pws', incoming.map(function (s) { return s.id; }).join(','));
      history.replaceState(null, '', location.pathname + '?' + params.toString());
    }
  }
  var store = read();
  function labelFor(id) {
    id = String(id || '').toUpperCase();
    for (var i = 0; i < store.length; i++) if (store[i].id === id) return store[i].label || null;
    return null;
  }
  function displayName(id) {
    id = String(id || '').toUpperCase();
    var l = labelFor(id);
    return l ? l + ' (' + id + ')' : id;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // safe for innerHTML/leaflet popups — labels come from the URL, so escape them
  function displayNameHtml(id) { return escapeHtml(displayName(id)); }
  function decorate(root) {
    (root || document).querySelectorAll('[data-pws-id]').forEach(function (el) {
      var id = (el.getAttribute('data-pws-id') || '').toUpperCase();
      if (id) el.textContent = displayName(id);
    });
  }
  window.PwsStore = {
    all: function () { return store.slice(); },
    labelFor: labelFor,
    displayName: displayName,
    displayNameHtml: displayNameHtml,
    decorate: decorate,
    redirected: redirected,
  };
  if (!redirected) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { decorate(); });
    else decorate();
  }
})();
</script>`;

const STATION_MAP_STYLES = `#map { height: 60vh; min-height: 420px; width: 100%; border-radius: 8px; background: #eef2f7; }
.leaflet-container { background: #eef2f7; }
.leaflet-popup-content a { color: #1a6fd6; }
.gauge-marker { background: transparent; border: none; }
.gauge-marker svg { display: block; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.35)); }
.gauge-tip { display: block; text-align: center; color: #1a1f2c; text-decoration: none; }
.gauge-tip:hover strong { text-decoration: underline; }
.gauge-tip-stats { display: block; color: #5a6878; font-size: 0.85em; font-weight: 400; margin-top: 1px; }
.span-select { display: flex; justify-content: center; margin: 12px 0; }
.span-select label { padding: 6px 16px; border: 1px solid #d4dae3; border-left-width: 0; background: #fff; cursor: pointer; font-size: 0.9rem; color: #5a6878; user-select: none; }
.span-select label:first-of-type { border-left-width: 1px; border-radius: 6px 0 0 6px; }
.span-select label:last-of-type { border-radius: 0 6px 6px 0; }
.span-select label:has(input:checked) { background: #0e7fcf; color: #fff; border-color: #0e7fcf; }
.span-select input { position: absolute; opacity: 0; pointer-events: none; }`;

// Home page bootstrap: renders the station list, rain links and map entirely
// from the localStorage manifest (window.PwsStore). The server ships an empty
// shell — there are no ?pws= params by the time this runs.
function homeInitScript(): string {
	return `<script>
(async function () {
  if (!window.PwsStore || window.PwsStore.redirected) return;
  const stationList = window.PwsStore.all();
  const content = document.getElementById('pws-content');
  const empty = document.getElementById('pws-empty');
  if (!stationList.length) { if (empty) empty.hidden = false; return; }
  if (content) content.hidden = false;
  const ids = stationList.map((s) => s.id);

  // station list
  const ul = document.getElementById('pws-list');
  for (const s of stationList) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = '/pws/' + encodeURIComponent(s.id) + '/dashboard';
    a.setAttribute('data-pws-id', s.id);
    a.textContent = window.PwsStore.displayName(s.id);
    li.appendChild(a);
    ul.appendChild(li);
  }

  // rain links (bare ids — labels live in localStorage, not the URL)
  const pwsParam = encodeURIComponent(ids.join(','));
  const rainLinks = document.getElementById('rain-links');
  if (rainLinks) {
    rainLinks.innerHTML = '<a href="/rain/today?pws=' + pwsParam + '">Rain — listed stations (today)</a> · ' +
      '<a href="/rain/yesterday?pws=' + pwsParam + '">yesterday</a>';
  }

  // map
  const el = document.getElementById('map');
  if (!el || typeof L === 'undefined') return;
  const map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19,
    subdomains: 'abcd',
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
  }).addTo(map);
  map.setView([39.5, -98.35], 4);
  var RAIN_MAX = { current: 1, day: 2, week: 3 };
  var TEMP_MIN_F = 20, TEMP_MAX_F = 90;
  var WIND_MAX_MPH = 15;
  var EMPTY_STATS = { rain: null, tempAvg: null, windAvg: null };
  function clamp01(x) { return Math.max(0, Math.min(1, x)); }
  function markerSvg(st, span) {
    // thermometer (left) — mercury level by temp
    var tf = st.tempAvg == null ? 0 : clamp01((st.tempAvg - TEMP_MIN_F) / (TEMP_MAX_F - TEMP_MIN_F));
    var mh = 20 * tf;
    var thermo =
      '<rect x="9" y="6" width="4" height="24" rx="2" fill="#ffffff" stroke="#5a6878" stroke-width="1.6"/>' +
      '<circle cx="11" cy="31" r="5" fill="#ffffff" stroke="#5a6878" stroke-width="1.6"/>' +
      '<circle cx="11" cy="31" r="3" fill="#d83737"/>' +
      '<rect x="9.8" y="' + (28 - mh).toFixed(1) + '" width="2.4" height="' + (mh + 4).toFixed(1) + '" rx="1.2" fill="#d83737"/>' +
      '<line x1="13" y1="11" x2="15" y2="11" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="13" y1="16" x2="15" y2="16" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="13" y1="21" x2="15" y2="21" stroke="#5a6878" stroke-width="1.2"/>';
    // rain gauge (center) — water level by rainfall over the span
    var rf = st.rain == null ? 0 : clamp01(st.rain / (RAIN_MAX[span] || 3));
    var gh = 22 * rf;
    var water = gh > 0.5
      ? '<rect x="35.6" y="' + (34 - gh).toFixed(1) + '" width="6.8" height="' + gh.toFixed(1) + '" rx="1.2" fill="#1a6fd6"/>'
      : '';
    var gauge =
      '<path d="M29 4h20l-6 8H35z" fill="#5a6878"/>' +
      '<rect x="34" y="11" width="10" height="24" rx="2.5" fill="#ffffff" stroke="#5a6878" stroke-width="1.6"/>' +
      water +
      '<line x1="41" y1="15" x2="37.5" y2="15" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="41" y1="19" x2="38.5" y2="19" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="41" y1="23" x2="37.5" y2="23" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="41" y1="27" x2="38.5" y2="27" stroke="#5a6878" stroke-width="1.2"/>' +
      '<line x1="41" y1="31" x2="37.5" y2="31" stroke="#5a6878" stroke-width="1.2"/>';
    // windsock (right) — lifts from drooping to horizontal by wind
    var wf = st.windAvg == null ? 0 : clamp01(st.windAvg / WIND_MAX_MPH);
    var px = 58, py = 9;
    var rot = (90 * (1 - wf)).toFixed(1);
    var sock =
      '<line x1="' + px + '" y1="5" x2="' + px + '" y2="35" stroke="#5a6878" stroke-width="2" stroke-linecap="round"/>' +
      '<g transform="rotate(' + rot + ' ' + px + ' ' + py + ')">' +
      '<path d="M' + px + ' ' + (py - 3.2) + ' L' + (px + 15) + ' ' + (py - 1.4) + ' L' + (px + 15) + ' ' + (py + 1.4) + ' L' + px + ' ' + (py + 3.2) + ' Z" fill="#e8862e"/>' +
      '<rect x="' + (px + 5) + '" y="' + (py - 2.6) + '" width="3" height="5.2" fill="#ffffff" opacity="0.85"/>' +
      '</g>' +
      '<circle cx="' + px + '" cy="' + py + '" r="1.6" fill="#5a6878"/>';
    return '<svg width="76" height="40" viewBox="0 0 76 40" xmlns="http://www.w3.org/2000/svg">' +
      thermo + gauge + sock + '</svg>';
  }
  function stationIcon(st, span) {
    return L.divIcon({
      html: markerSvg(st, span),
      className: 'gauge-marker',
      iconSize: [76, 40],
      iconAnchor: [39, 37],
      popupAnchor: [0, -35],
      tooltipAnchor: [0, -35],
    });
  }
  try {
    const res = await fetch('/api/stations/coords?pws=' + encodeURIComponent(ids.join(',')));
    const stations = await res.json();
    if (!Array.isArray(stations) || stations.length === 0) return;
    const fmtRain = (v) => v == null ? '—' : v.toFixed(2) + '"';
    const fmtTemp = (v) => v == null ? '—' : Math.round(v) + '°';
    const fmtWind = (v) => v == null ? '—' : Math.round(v) + ' mph';
    const dashUrl = (s) => '/pws/' + encodeURIComponent(s.id) + '/dashboard';
    const statsFor = (s, span) => (s.stats && s.stats[span]) || EMPTY_STATS;
    const tipHtml = (s, span) => {
      const st = statsFor(s, span);
      return '<a class="gauge-tip" href="' + dashUrl(s) + '"><strong>' + window.PwsStore.displayNameHtml(s.id) + '</strong>' +
        '<span class="gauge-tip-stats">' + fmtRain(st.rain) + ' · ' + fmtTemp(st.tempAvg) + ' · ' + fmtWind(st.windAvg) + '</span></a>';
    };
    let span = 'week';
    const markers = stations.map((s) =>
      L.marker([s.lat, s.lon], { icon: stationIcon(statsFor(s, span), span) })
        .on('click', () => { window.location.href = dashUrl(s); })
        .bindTooltip(tipHtml(s, span), { permanent: true, direction: 'top', interactive: true })
        .addTo(map),
    );
    const applySpan = (next) => {
      span = next;
      stations.forEach((s, i) => {
        markers[i].setIcon(stationIcon(statsFor(s, span), span));
        markers[i].setTooltipContent(tipHtml(s, span));
      });
    };
    document.querySelectorAll('input[name="map-span"]').forEach((radio) => {
      radio.addEventListener('change', () => { if (radio.checked) applySpan(radio.value); });
    });
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
}

// The home page is a static shell: the station list, rain links and map are
// all populated client-side from the localStorage manifest by homeInitScript().
function renderHomePage(): string {
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
  code { background: #eef2f7; padding: 2px 6px; border-radius: 4px; }
  .empty { color: #5a6878; }
  [hidden] { display: none !important; }
  ${STATION_MAP_STYLES}
</style>
</head>
<body>
  <div class="wrap">
    <h1>Weather Dashboard</h1>
    <div id="pws-content" hidden>
      <div id="map"></div>
      <div class="span-select" role="group" aria-label="Map data timespan">
        <label><input type="radio" name="map-span" value="current"> Current</label>
        <label><input type="radio" name="map-span" value="day"> 24 hr</label>
        <label><input type="radio" name="map-span" value="week" checked> 7 days</label>
      </div>
      <p id="rain-links"></p>
      <p>Personal Weather Stations:</p>
      <ul id="pws-list"></ul>
    </div>
    <p id="pws-empty" class="empty" hidden>Append <code>?pws=Label:K1,Label:K2</code> to register one or more PWS station IDs (with optional custom names). They are saved to this browser, so plain <code>/</code> shows them next time. Or visit <code>/pws/&lt;id&gt;/dashboard</code> directly.</p>
  </div>
${PWS_STORE_SCRIPT}
${homeInitScript()}
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
	neighbors: NeighborsFile = EMPTY_NEIGHBORS,
): string {
	const prettyDate = fmtPrettyDate(target.date);
	const tz = d.timezone;
	const heading = target.isToday
		? 'How much has it rained today?'
		: target.isYesterday
			? 'How much did it rain yesterday?'
			: `How much did it rain on ${prettyDate}?`;
	const stationSpan = `<span data-pws-id="${escHtml(d.stationId)}">${escHtml(d.stationId)}</span>`;
	const dateLine = target.isToday
		? `${escHtml(prettyDate)} (so far) at ${stationSpan}`
		: `${escHtml(prettyDate)} at ${stationSpan}`;
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
			return `<tr${cls}><td>${escHtml(dist)}</td><td data-pws-id="${escHtml(s.id)}">${escHtml(s.id)}</td><td>${escHtml(s.rainfall.toFixed(2))}"</td></tr>`;
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
  <div class="date">${dateLine}</div>
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
${PWS_STORE_SCRIPT}
<script id="rain-map-data" type="application/json">${safeScriptJson(buildRainMapData(d.stationId, rainfall, neighborRain, neighbors))}</script>
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
  for (const n of (data.neighbors || [])) {
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue;
    layers.push(
      L.circleMarker([n.lat, n.lon], {
        radius: 7, color: '#ffffff', weight: 1.5, fillColor: '#1a6fd6', fillOpacity: 0.55, opacity: 0.7,
      })
        .bindPopup('<strong>' + window.PwsStore.displayNameHtml(n.id) + '</strong><br>' + (n.distanceMi != null ? n.distanceMi.toFixed(2) + ' mi away<br>' : '') + 'Rain: ' + fmtRain(n.rainfall))
        .addTo(map),
    );
  }
  if (data.primary && typeof data.primary.lat === 'number' && typeof data.primary.lon === 'number') {
    const m = L.circleMarker([data.primary.lat, data.primary.lon], {
      radius: 11, color: '#ffffff', weight: 2, fillColor: '#d83737', fillOpacity: 0.75, opacity: 0.9,
    })
      .bindPopup('<strong>' + window.PwsStore.displayNameHtml(data.primary.id) + '</strong> (you)<br>Rain: ' + fmtRain(data.primary.rainfall))
      .addTo(map);
    m.bringToFront();
    layers.push(m);
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

interface MultiRainEntry {
	stationId: string;
	label?: string;
	dashboard: DashboardData;
	target: RainTarget;
	rainfall: number | null;
	neighborRain: NeighborRainReading[];
}

function renderAllRainPage(spec: string, entries: MultiRainEntry[], neighbors: NeighborsFile = EMPTY_NEIGHBORS): string {
	const lower = spec.toLowerCase();
	const isToday = lower === 'today';
	const isYesterday = lower === 'yesterday';
	const repDate = entries[0]?.target.date ?? new Date().toISOString().slice(0, 10);
	const prettyDate = fmtPrettyDate(repDate);
	const heading = isToday
		? 'How much has it rained today?'
		: isYesterday
			? 'How much did it rain yesterday?'
			: `How much did it rain on ${prettyDate}?`;
	const dateLine = isToday ? `${prettyDate} (so far)` : prettyDate;
	const titleVerb = isToday ? "Today's" : isYesterday ? "Yesterday's" : prettyDate;

	const cards = entries.map((e) => renderStationRainCard(e)).join('');

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(titleVerb)} Rain — All Stations</title>
${STATION_MAP_HEAD}
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f7f9fc; color: #1a1f2c; padding: 24px; }
  main { max-width: 1400px; margin: 0 auto; }
  h1 { text-align: center; margin: 0 0 8px; font-size: clamp(1.2rem, 3vw, 1.6rem); font-weight: 400; color: #5a6878; }
  .date { text-align: center; color: #1a1f2c; font-size: clamp(1rem, 2.5vw, 1.4rem); margin-bottom: 24px; }
  .map-section { margin-bottom: 32px; }
  .stations-row { display: flex; flex-wrap: wrap; gap: 20px; align-items: stretch; }
  .station-card { flex: 1 1 0; min-width: 260px; background: #ffffff; border: 1px solid #e3e8ef; border-radius: 8px; padding: 16px; }
  .station-card h2 { margin: 0 0 4px; font-size: 1rem; color: #5a6878; font-weight: 500; }
  .station-card .answer { font-size: clamp(2rem, 4vw, 3rem); font-weight: 700; color: #0e7fcf; line-height: 1.1; margin: 8px 0 2px; }
  .station-card .unit { color: #5a6878; font-size: .9rem; margin-bottom: 12px; }
  .station-card .none { color: #5a6878; font-size: 1.5rem; font-weight: 600; margin: 8px 0 12px; }
  .station-card .summary { font-size: .9rem; color: #1a1f2c; margin-bottom: 8px; }
  .station-card table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  .station-card th, .station-card td { padding: 4px 6px; border-bottom: 1px solid #e3e8ef; text-align: left; }
  .station-card th { color: #5a6878; font-weight: 500; font-size: .75rem; text-transform: uppercase; letter-spacing: .04em; }
  .station-card tr.you { background: #e8f3fc; font-weight: 600; }
  .station-card td:last-child, .station-card th:last-child { text-align: right; }
  .station-card .dash-link { display: block; margin-top: 10px; font-size: .85rem; }
  .station-card .dash-link a { color: #0e7fcf; text-decoration: none; }
  .station-card .dash-link a:hover { text-decoration: underline; }
  ${STATION_MAP_STYLES}
</style>
</head>
<body>
<main>
  <h1>${escHtml(heading)}</h1>
  <div class="date">${escHtml(dateLine)}</div>
  <div class="map-section"><div id="map"></div></div>
  <div class="stations-row">${cards}</div>
</main>
${PWS_STORE_SCRIPT}
<script id="all-rain-map-data" type="application/json">${safeScriptJson(buildAllRainMapData(entries, neighbors))}</script>
<script>
(function () {
  const el = document.getElementById('map');
  const dataEl = document.getElementById('all-rain-map-data');
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
  for (const n of (data.neighbors || [])) {
    if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue;
    layers.push(
      L.circleMarker([n.lat, n.lon], {
        radius: 7, color: '#ffffff', weight: 1.5, fillColor: '#1a6fd6', fillOpacity: 0.55, opacity: 0.7,
      })
        .bindPopup('<strong>' + window.PwsStore.displayNameHtml(n.id) + '</strong><br>Rain: ' + fmtRain(n.rainfall))
        .addTo(map),
    );
  }
  for (const p of (data.primaries || [])) {
    if (typeof p.lat !== 'number' || typeof p.lon !== 'number') continue;
    const m = L.circleMarker([p.lat, p.lon], {
      radius: 11, color: '#ffffff', weight: 2, fillColor: '#d83737', fillOpacity: 0.75, opacity: 0.9,
    })
      .bindPopup('<strong>' + window.PwsStore.displayNameHtml(p.id) + '</strong> (primary)<br>Rain: ' + fmtRain(p.rainfall) + '<br><a href="/pws/' + encodeURIComponent(p.id) + '/rain' + (data.specPath || '') + '">Station rain page →</a>')
      .addTo(map);
    m.bringToFront();
    layers.push(m);
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

function renderStationRainCard(e: MultiRainEntry): string {
	const { stationId, rainfall, neighborRain } = e;
	const all: Array<{ id: string; distanceMi: number | null; rainfall: number; isPrimary: boolean }> = [];
	if (rainfall !== null) {
		all.push({ id: stationId, distanceMi: 0, rainfall, isPrimary: true });
	}
	for (const n of neighborRain) {
		if (n.rainfall !== null) {
			all.push({ id: n.stationId, distanceMi: n.distanceMi, rainfall: n.rainfall, isPrimary: false });
		}
	}
	const sorted = [...all].sort((a, b) => b.rainfall - a.rainfall);
	const primaryRank = rainfall !== null ? sorted.findIndex((s) => s.isPrimary) + 1 : 0;
	const others = sorted.filter((s) => !s.isPrimary).map((s) => s.rainfall);
	const median = others.length > 0 ? others.slice().sort((a, b) => a - b)[Math.floor(others.length / 2)] : null;

	const rows = [...all]
		.sort((a, b) => (a.distanceMi ?? 0) - (b.distanceMi ?? 0))
		.map((s) => {
			const cls = s.isPrimary ? ' class="you"' : '';
			const dist = s.isPrimary ? 'you' : s.distanceMi !== null ? `${s.distanceMi.toFixed(2)} mi` : '—';
			return `<tr${cls}><td>${escHtml(dist)}</td><td data-pws-id="${escHtml(s.id)}">${escHtml(s.id)}</td><td>${escHtml(s.rainfall.toFixed(2))}"</td></tr>`;
		})
		.join('');

	const answer = rainfall !== null
		? `<div class="answer">${escHtml(rainfall.toFixed(2))}"</div><div class="unit">inches</div>`
		: `<div class="none">No data</div>`;
	const summary = all.length > 1
		? `<div class="summary">Ranked <strong>${primaryRank}</strong> of <strong>${sorted.length}</strong>${median !== null ? ` · median <strong>${escHtml(median.toFixed(2))}"</strong>` : ''}</div>`
		: '';

	return `<div class="station-card">
    <h2 data-pws-id="${escHtml(stationId)}">${escHtml(e.label ?? stationId)}</h2>
    ${answer}
    ${summary}
    <table>
      <thead><tr><th>Dist</th><th>Station</th><th>Rain</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="dash-link"><a href="/pws/${escHtml(stationId)}/rain/${escHtml(e.target.date)}">Station page →</a></div>
  </div>`;
}

interface AllRainMapData {
	primaries: Array<{ id: string; label?: string; lat: number | null; lon: number | null; rainfall: number | null }>;
	neighbors: Array<{ id: string; lat: number | null; lon: number | null; rainfall: number | null }>;
	specPath: string;
}

function buildAllRainMapData(entries: MultiRainEntry[], neighbors: NeighborsFile): AllRainMapData {
	const primaries: AllRainMapData['primaries'] = [];
	const neighborMap = new Map<string, { id: string; lat: number | null; lon: number | null; rainfall: number | null }>();
	const primaryIds = new Set(entries.map((e) => e.stationId));
	for (const e of entries) {
		const entry = neighbors.stations[e.stationId];
		primaries.push({
			id: e.stationId,
			label: e.label,
			lat: entry?.lat ?? null,
			lon: entry?.lon ?? null,
			rainfall: e.rainfall,
		});
		const neighborMeta = new Map<string, NeighborEntry>();
		for (const n of entry?.neighbors ?? []) neighborMeta.set(n.stationId, n);
		for (const nr of e.neighborRain) {
			if (primaryIds.has(nr.stationId)) continue;
			const meta = neighborMeta.get(nr.stationId);
			const existing = neighborMap.get(nr.stationId);
			if (existing && existing.rainfall !== null) continue;
			neighborMap.set(nr.stationId, {
				id: nr.stationId,
				lat: meta?.lat ?? null,
				lon: meta?.lon ?? null,
				rainfall: nr.rainfall,
			});
		}
	}
	const specPath = entries[0]?.target.date ? `/${entries[0].target.date}` : '';
	return { primaries, neighbors: Array.from(neighborMap.values()), specPath };
}

interface RainMapData {
	primary: { id: string; lat: number | null; lon: number | null; rainfall: number | null };
	neighbors: Array<{ id: string; lat: number | null; lon: number | null; rainfall: number | null; distanceMi: number | null }>;
}

function buildRainMapData(primaryId: string, primaryRainfall: number | null, neighborRain: NeighborRainReading[], neighbors: NeighborsFile): RainMapData {
	const primaryEntry = neighbors.stations[primaryId];
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
