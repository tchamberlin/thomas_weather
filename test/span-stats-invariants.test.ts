import { describe, it, expect } from 'vitest';
import { computeSpanStats, sumPrecipDeltas } from '../src/index';

// Deterministic PRNG so the property tests are reproducible (no fast-check dep).
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const NOW = Date.parse('2026-05-24T18:00:00Z');
const TZ_OFFSET_MS = 4 * 3600_000; // pretend US Eastern (UTC-4) for obsTimeLocal

function hourly(precipTotals: number[], date = '2026-05-23'): any[] {
	// One observation per element, 30 min apart, all on the same local date,
	// inside the last 24h so computeSpanStats' 24h filter keeps them.
	return precipTotals.map((pt, i) => {
		const t = NOW - (precipTotals.length - i) * 30 * 60_000;
		return {
			obsTimeUtc: new Date(t).toISOString(),
			obsTimeLocal: `${date} ${String(12 + i).padStart(2, '0')}:00:00`,
			epoch: Math.floor(t / 1000),
			imperial: { precipTotal: pt, temp: 70, windSpeed: 5 },
		};
	});
}

describe('sumPrecipDeltas — non-monotonic precipTotal must not inflate', () => {
	it('regression: the real KNCASHEV457 dip sequence yields the increment, not 5.71"', () => {
		// Actual KV data that the old delta-summing code blew up to 5.71".
		const seq = [1.3, 1.33, 1.33, 1.3, 1.15, 1.15, 1.13, 1.1, 1.0, 1.0];
		const rain = sumPrecipDeltas(hourly(seq));
		// Single local date → max(1.33) − first(1.30) = 0.03.
		expect(rain).toBeCloseTo(0.03, 5);
		expect(rain!).toBeLessThan(0.5); // emphatically not 5.71
	});

	it('never re-counts within-day dips (each downward step used to add the full counter)', () => {
		const rain = sumPrecipDeltas(hourly([0.5, 0.2, 0.7, 0.3, 0.9]));
		expect(rain).toBeCloseTo(0.4, 5); // 0.9 − 0.5, not 1.6
	});

	it('sums full daily maxes across days, partial-crediting only the oldest day', () => {
		const obs = [...hourly([0.2, 1.0], '2026-05-23'), ...hourly([0.1, 0.5], '2026-05-24')];
		// oldest day: 1.0 − 0.2 = 0.8 ; newer day (fully inside window): 0.5
		expect(sumPrecipDeltas(obs)).toBeCloseTo(1.3, 5);
	});

	it('is always non-negative and never exceeds the sum of per-day maxes', () => {
		const rng = mulberry32(99);
		for (let iter = 0; iter < 1000; iter++) {
			const n = 1 + Math.floor(rng() * 12);
			const seq = Array.from({ length: n }, () => +(rng() * 3).toFixed(2));
			const rain = sumPrecipDeltas(hourly(seq));
			if (rain === null) continue;
			expect(rain).toBeGreaterThanOrEqual(0);
			// All same date here → bounded by that day's max.
			expect(rain).toBeLessThanOrEqual(Math.max(...seq) + 1e-9);
		}
	});
});

function current(precipTotal: number | undefined) {
	return precipTotal === undefined ? null : { imperial: { precipTotal, temp: 70, windSpeed: 5 } };
}

function randomHourly(rng: () => number, n: number): any[] {
	return Array.from({ length: n }, () => {
		const ageMin = Math.floor(rng() * 7 * 24 * 60); // anywhere in the last 7 days
		const t = NOW - ageMin * 60_000;
		const local = new Date(t - TZ_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
		return {
			obsTimeUtc: new Date(t).toISOString(),
			obsTimeLocal: local,
			epoch: Math.floor(t / 1000),
			imperial: { precipTotal: +(rng() * 3).toFixed(2), temp: +(rng() * 90).toFixed(1), windSpeed: +(rng() * 20).toFixed(1) },
		};
	});
}

function randomDays(rng: () => number, n: number): any[] {
	return Array.from({ length: n }, (_, i) => {
		const date = new Date(NOW - i * 86_400_000).toISOString().slice(0, 10);
		return {
			date,
			obsTimeLocal: `${date} 00:00:00`,
			rainfall: +(rng() * 2).toFixed(2),
			tempHigh: 80, tempLow: 60, tempAvg: 70, humidityAvg: 50,
			windAvg: 5, windGustHigh: 10, pressureMax: 30, pressureMin: 29,
			source: 'history' as const,
		};
	});
}

describe('computeSpanStats — the 24h ≤ 7d invariant is impossible to violate', () => {
	it('holds for thousands of random (current, hourly, daily) combinations', () => {
		const rng = mulberry32(1234);
		for (let iter = 0; iter < 3000; iter++) {
			const stats = computeSpanStats(
				current(rng() < 0.5 ? +(rng() * 3).toFixed(2) : undefined),
				randomHourly(rng, Math.floor(rng() * 40)),
				randomDays(rng, Math.floor(rng() * 8)),
				NOW,
			);
			for (const span of [stats.current, stats.day, stats.week]) {
				if (span.rain !== null) expect(span.rain).toBeGreaterThanOrEqual(0);
			}
			if (stats.day.rain !== null && stats.week.rain !== null) {
				expect(stats.day.rain).toBeLessThanOrEqual(stats.week.rain + 1e-9);
			}
		}
	});

	it('clamps a pathological hourly over-count down to the authoritative 7d total', () => {
		// Hourly screams 10"+ this "day"; daily summaries say the week saw 1".
		const obs = hourly([0, 10, 0, 9, 0, 8]); // adversarial saw-tooth on one date
		const days = [
			{ date: '2026-05-24', obsTimeLocal: '2026-05-24 00:00:00', rainfall: 0.6, tempHigh: 80, tempLow: 60, tempAvg: 70, humidityAvg: 50, windAvg: 5, windGustHigh: 10, pressureMax: 30, pressureMin: 29, source: 'history' as const },
			{ date: '2026-05-23', obsTimeLocal: '2026-05-23 00:00:00', rainfall: 0.4, tempHigh: 80, tempLow: 60, tempAvg: 70, humidityAvg: 50, windAvg: 5, windGustHigh: 10, pressureMax: 30, pressureMin: 29, source: 'history' as const },
		];
		const stats = computeSpanStats(null, obs, days, NOW);
		expect(stats.week.rain).toBeCloseTo(1.0, 5);
		expect(stats.day.rain).toBeLessThanOrEqual(stats.week.rain! + 1e-9); // clamped, never 10"
	});

	it('leaves the 24h figure intact when there is no 7d total to bound it', () => {
		const stats = computeSpanStats(null, hourly([0.1, 0.9]), [], NOW);
		expect(stats.week.rain).toBeNull();
		expect(stats.day.rain).toBeCloseTo(0.8, 5); // unclamped, but still correct
	});
});
