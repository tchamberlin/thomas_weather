/**
 * waxwing_wx - PWS rainfall dashboard (Weather Underground)
 *
 * Uses Weather Company / Weather Underground PWS historical daily summaries as
 * the source of truth for daily rainfall. Current conditions are fetched only
 * as a live supplement for today's in-progress reading and last observation.
 *
 * Config via secrets (set with `npx wrangler secret put <NAME>`):
 *   WU_API_KEY      - Weather Underground API key
 *   WU_STATION_ID   - Your PWS station ID (e.g. "KVALAKEF29")
 *
 * Optional KV namespace: RAINFALL. Used as a cache when the historical API is
 * temporarily unavailable.
 */

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
	humidity?: number;
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
	source: 'historical' | 'cache';
}

interface DashboardData {
	stationId: string;
	yesterday: DailyWeather | null;
	today: DailyWeather | null;
	recentDays: DailyWeather[];
	current: WUCurrentObservation | null;
	lastReading: string;
	dataSource: string;
	warning: string | null;
}

const CACHE_KEY = 'weather:dailySummaries:v1';

export default {
	async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
		await refreshDailySummaryCache(env);
	},

	async fetch(_req: Request, env: Env): Promise<Response> {
		const { WU_API_KEY, WU_STATION_ID } = weatherConfig(env);
		if (!WU_API_KEY || !WU_STATION_ID) {
			return new Response(
				'Missing configuration. Set WU_API_KEY and WU_STATION_ID via `npx wrangler secret put <NAME>`.',
				{ status: 500 },
			);
		}

		try {
			const dashboard = await buildDashboard(env);
			return new Response(renderDashboard(dashboard), {
				headers: { 'Content-Type': 'text/html; charset=utf-8' },
			});
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error('Dashboard error:', msg);
			return new Response(`Error: ${msg}`, { status: 500 });
		}
	},
} satisfies ExportedHandler<Env>;

async function buildDashboard(env: Env): Promise<DashboardData> {
	const [dailyResult, currentResult] = await Promise.all([loadDailySummaries(env), loadCurrent(env)]);
	const current = currentResult.current;
	const recentDays = dailyResult.days;
	const currentLocalDate = current?.obsTimeLocal ? localDate(current.obsTimeLocal) : null;
	const latestSummaryDate = recentDays[recentDays.length - 1]?.date ?? null;
	const todayDate = currentLocalDate ?? latestSummaryDate;
	const today = todayDate ? findDay(recentDays, todayDate) : null;
	const yesterday = todayDate ? findPreviousDay(recentDays, todayDate) : recentDays.at(-2) ?? null;
	const lastReading = current?.obsTimeLocal ?? current?.obsTimeUtc ?? recentDays.at(-1)?.obsTimeLocal ?? 'N/A';

	return {
		stationId: env.WU_STATION_ID,
		yesterday,
		today: mergeTodayWithCurrent(today, current, todayDate),
		recentDays,
		current,
		lastReading,
		dataSource: dailyResult.source,
		warning: joinWarnings(dailyResult.warning, currentResult.warning),
	};
}

async function loadCurrent(env: Env): Promise<{ current: WUCurrentObservation | null; warning: string | null }> {
	try {
		return { current: await fetchCurrent(env), warning: null };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		return { current: null, warning: `Current conditions unavailable. ${msg}` };
	}
}

async function fetchCurrent(env: Env): Promise<WUCurrentObservation | null> {
	const body = await fetchJson<WUCurrentResponse>(env, '/v2/pws/observations/current', {
		numericPrecision: false,
	});
	return body.observations?.[0] ?? null;
}

async function fetchDailySummaries(env: Env): Promise<DailyWeather[]> {
	const body = await fetchJson<WUDailySummaryResponse>(env, '/v2/pws/dailysummary/7day', {
		numericPrecision: true,
	});
	return (body.summaries ?? [])
		.map((summary) => normalizeDailySummary(summary, 'historical'))
		.filter((day): day is DailyWeather => day !== null)
		.sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchJson<T>(env: Env, path: string, options: { numericPrecision: boolean }): Promise<T> {
	const { WU_API_KEY, WU_STATION_ID } = weatherConfig(env);
	const url = new URL(`https://api.weather.com${path}`);
	url.searchParams.set('stationId', WU_STATION_ID);
	url.searchParams.set('format', 'json');
	url.searchParams.set('units', 'e');
	if (options.numericPrecision) {
		url.searchParams.set('numericPrecision', 'decimal');
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

function weatherConfig(env: Env): { WU_API_KEY: string; WU_STATION_ID: string } {
	return {
		WU_API_KEY: cleanSecret(env.WU_API_KEY),
		WU_STATION_ID: cleanSecret(env.WU_STATION_ID),
	};
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

async function refreshDailySummaryCache(env: Env): Promise<void> {
	const days = await fetchDailySummaries(env);
	await cacheDailySummaries(env, days);
}

async function loadDailySummaries(env: Env): Promise<{ days: DailyWeather[]; source: string; warning: string | null }> {
	try {
		const days = await fetchDailySummaries(env);
		await cacheDailySummaries(env, days);
		return { days, source: 'Weather Company daily summary', warning: null };
	} catch (err: unknown) {
		const cachedDays = await readCachedDailySummaries(env);
		if (cachedDays.length > 0) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				days: cachedDays,
				source: 'Cached Weather Company daily summary',
				warning: `Historical API unavailable; showing cached data. ${msg}`,
			};
		}
		throw err;
	}
}

async function cacheDailySummaries(env: Env, days: DailyWeather[]): Promise<void> {
	if (!env.RAINFALL || days.length === 0) return;
	await env.RAINFALL.put(CACHE_KEY, JSON.stringify(days), {
		metadata: { cachedAt: new Date().toISOString() },
	});
}

async function readCachedDailySummaries(env: Env): Promise<DailyWeather[]> {
	if (!env.RAINFALL) return [];

	const raw = await env.RAINFALL.get(CACHE_KEY);
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
	if (liveRainfall === null) return today;

	return {
		date: todayDate,
		obsTimeLocal: current.obsTimeLocal ?? today?.obsTimeLocal ?? current.obsTimeUtc ?? todayDate,
		rainfall: Math.max(today?.rainfall ?? 0, liveRainfall),
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

function findPreviousDay(days: DailyWeather[], date: string): DailyWeather | null {
	const earlier = days.filter((day) => day.date < date);
	return earlier.at(-1) ?? null;
}

function localDate(obsTimeLocal: string): string {
	return obsTimeLocal.slice(0, 10);
}

function numberOrNull(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function renderDashboard(d: DashboardData): string {
	const current = d.current?.imperial;
	const rows = d.recentDays
		.slice()
		.reverse()
		.map(
			(day) => /* html */ `<tr>
        <td>${escHtml(day.date)}</td>
        <td>${fmtRain(day.rainfall)}</td>
        <td>${fmtTempRange(day)}</td>
        <td>${fmtNumber(day.humidityAvg, '%')}</td>
        <td>${fmtNumber(day.windGustHigh, ' mph')}</td>
      </tr>`,
		)
		.join('');

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escHtml(d.stationId)} - Rainfall Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #0b1a2a;
    color: #e0e8f0;
    min-height: 100vh;
    padding: 24px;
  }
  main {
    max-width: 900px;
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
    color: #f4f8fb;
    overflow-wrap: anywhere;
  }
  .subtitle, .meta, .footer {
    color: #8da7b7;
    font-size: .86rem;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .card, .table-wrap {
    background: #112b3c;
    border: 1px solid #1e4056;
    border-radius: 8px;
    box-shadow: 0 8px 28px rgba(0,0,0,.28);
  }
  .card {
    padding: 18px;
  }
  .label {
    color: #9eb9c9;
    font-size: .84rem;
    margin-bottom: 8px;
  }
  .value {
    font-size: clamp(1.8rem, 5vw, 3rem);
    line-height: 1;
    font-weight: 750;
  }
  .value.primary { color: #64c8ff; }
  .value.today { color: #91d18b; }
  .details {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px 14px;
    margin-top: 14px;
    color: #bfd2dc;
    font-size: .9rem;
  }
  .details span {
    color: #7899ad;
    display: block;
    font-size: .76rem;
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
    border-bottom: 1px solid #1e4056;
    white-space: nowrap;
  }
  th {
    color: #8ab4d8;
    font-size: .78rem;
    font-weight: 650;
    text-transform: uppercase;
  }
  td {
    color: #dce8ef;
    font-size: .9rem;
  }
  tr:last-child td { border-bottom: 0; }
  .notice {
    margin: 12px 0;
    padding: 10px 12px;
    border: 1px solid #715f23;
    background: #2a260f;
    border-radius: 8px;
    color: #f2d27a;
    font-size: .86rem;
  }
  .footer {
    margin-top: 14px;
    line-height: 1.6;
  }
  @media (max-width: 700px) {
    body { padding: 14px; }
    header, .grid { display: block; }
    .card { margin-bottom: 12px; }
    .details { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escHtml(d.stationId)}</h1>
      <div class="subtitle">PWS historical daily summary</div>
    </div>
    <div class="meta">Last reading: ${escHtml(d.lastReading)}</div>
  </header>

  ${d.warning ? `<div class="notice">${escHtml(d.warning)}</div>` : ''}

  <section class="grid">
    <div class="card">
      <div class="label">Yesterday${d.yesterday ? ` - ${escHtml(d.yesterday.date)}` : ''}</div>
      <div class="value primary">${fmtRain(d.yesterday?.rainfall ?? null)}</div>
      <div class="details">
        <div><span>Temperature</span>${d.yesterday ? fmtTempRange(d.yesterday) : 'N/A'}</div>
        <div><span>Humidity avg</span>${fmtNumber(d.yesterday?.humidityAvg ?? null, '%')}</div>
        <div><span>Wind gust high</span>${fmtNumber(d.yesterday?.windGustHigh ?? null, ' mph')}</div>
        <div><span>Pressure</span>${fmtPressureRange(d.yesterday)}</div>
      </div>
    </div>

    <div class="card">
      <div class="label">Today so far${d.today ? ` - ${escHtml(d.today.date)}` : ''}</div>
      <div class="value today">${fmtRain(d.today?.rainfall ?? null)}</div>
      <div class="details">
        <div><span>Current temp</span>${fmtNumber(current?.temp ?? null, ' F')}</div>
        <div><span>Current humidity</span>${fmtNumber(d.current?.humidity ?? null, '%')}</div>
        <div><span>Rain rate</span>${fmtNumber(current?.precipRate ?? null, ' in/hr')}</div>
        <div><span>Wind</span>${fmtNumber(current?.windSpeed ?? null, ' mph')}</div>
      </div>
    </div>
  </section>

  <section class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Rain</th>
          <th>Temperature</th>
          <th>Humidity Avg</th>
          <th>Gust High</th>
        </tr>
      </thead>
      <tbody>${rows || '<tr><td colspan="5">No historical daily summaries returned.</td></tr>'}</tbody>
    </table>
  </section>

  <div class="footer">
    Source: ${escHtml(d.dataSource)}<br>
    Daily rainfall comes from /v2/pws/dailysummary/7day; live values come from /v2/pws/observations/current.
  </div>
</main>
</body>
</html>`;
}

function fmtRain(inches: number | null): string {
	if (inches === null) return 'N/A';
	const mm = inches * 25.4;
	return `${inches.toFixed(2)} in (${mm.toFixed(1)} mm)`;
}

function fmtNumber(value: number | null | undefined, suffix = ''): string {
	if (typeof value !== 'number' || !Number.isFinite(value)) return 'N/A';
	return `${value.toFixed(1).replace(/\.0$/, '')}${suffix}`;
}

function fmtTempRange(day: DailyWeather | null | undefined): string {
	if (!day) return 'N/A';
	if (day.tempLow === null && day.tempHigh === null) return fmtNumber(day.tempAvg, ' F');
	return `${fmtNumber(day.tempLow, ' F')} / ${fmtNumber(day.tempHigh, ' F')}`;
}

function fmtPressureRange(day: DailyWeather | null | undefined): string {
	if (!day) return 'N/A';
	if (day.pressureMin === null && day.pressureMax === null) return 'N/A';
	return `${fmtNumber(day.pressureMin, ' in')} / ${fmtNumber(day.pressureMax, ' in')}`;
}

function escHtml(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
