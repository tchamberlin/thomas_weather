import { describe, it, expect } from 'vitest';
import { evaluateFreshness, renderDashboard, STALE_AFTER_MINUTES, type DashboardData } from '../src/index';

const NOW = Date.parse('2026-05-24T18:00:00Z');

/** ISO timestamp `ageMin` minutes before NOW (null passes through). */
function writtenAgo(ageMin: number | null): string | null {
	return ageMin === null ? null : new Date(NOW - ageMin * 60_000).toISOString();
}

function dashboard(lastWriteAt: string | null, extra: Partial<DashboardData> = {}): DashboardData {
	return {
		stationId: 'KTEST1',
		today: null,
		recentDays: [],
		hourly7Day: [],
		historyIndex: null,
		current: { obsTimeUtc: new Date(NOW).toISOString(), imperial: { temp: 70, precipTotal: 0.1, windSpeed: 5 } },
		lastReading: '2026-05-24 14:00:00',
		lastWriteAt,
		lastScheduledRun: new Date(NOW).toISOString(),
		nextScheduledRun: new Date(NOW + 60_000).toISOString(),
		dataSource: 'test',
		warning: null,
		timezone: 'America/New_York',
		...extra,
	};
}

const STALE_BANNER = 'data-testid="stale-banner"';

describe('evaluateFreshness', () => {
	it('treats a never-written cache as stale', () => {
		expect(evaluateFreshness(null, NOW)).toEqual({ writeAgeMinutes: null, stale: true });
	});

	it('treats an unparseable timestamp as stale', () => {
		expect(evaluateFreshness('not-a-date', NOW)).toEqual({ writeAgeMinutes: null, stale: true });
	});

	it('is fresh up to and including the threshold, stale after it', () => {
		expect(evaluateFreshness(writtenAgo(0), NOW).stale).toBe(false);
		expect(evaluateFreshness(writtenAgo(STALE_AFTER_MINUTES), NOW).stale).toBe(false);
		expect(evaluateFreshness(writtenAgo(STALE_AFTER_MINUTES + 1), NOW).stale).toBe(true);
		expect(evaluateFreshness(writtenAgo(60 * 24), NOW).stale).toBe(true);
	});
});

describe('honesty invariant: the dashboard cannot show stale data without flagging it', () => {
	// The whole grid, including null and both sides of the threshold.
	const ages: Array<number | null> = [null, 0, 1, 10, 20, 34, STALE_AFTER_MINUTES, STALE_AFTER_MINUTES + 1, 50, 120, 60 * 24, 60 * 24 * 9];

	it('renders the stale banner for EXACTLY the inputs evaluateFreshness calls stale (biconditional)', () => {
		for (const age of ages) {
			const writeAt = writtenAgo(age);
			const expectedStale = evaluateFreshness(writeAt, NOW).stale;
			const html = renderDashboard(dashboard(writeAt), false, NOW);
			const bannerShown = html.includes(STALE_BANNER);
			// stale  => banner present ; fresh => banner absent. No third case.
			expect(bannerShown, `age=${age}min expected stale=${expectedStale} but banner=${bannerShown}`).toBe(expectedStale);
		}
	});

	it('marks the "Last data update" line with ⚠ whenever a (known) write is stale', () => {
		const html = renderDashboard(dashboard(writtenAgo(200)), false, NOW);
		expect(html).toContain(STALE_BANNER);
		expect(html).toMatch(/Last data update:[^\n]*⚠/);
	});

	it('shows no warning glyph and no banner when data is fresh', () => {
		const html = renderDashboard(dashboard(writtenAgo(5)), false, NOW);
		expect(html).not.toContain(STALE_BANNER);
		expect(html).not.toContain('⚠');
	});

	it('still renders the (stale) data alongside the banner — stale-but-labelled is allowed', () => {
		const html = renderDashboard(dashboard(writtenAgo(300)), false, NOW);
		expect(html).toContain(STALE_BANNER); // flagged
		expect(html).toContain('KTEST1'); // ...but the data is still shown, not hidden
		expect(html).toContain('metric-grid');
	});

	it('a fresh cron clock does NOT mask a stale write (the original silent-freeze bug)', () => {
		// lastScheduledRun ticking forward must not suppress the banner — only the
		// real write time (lastWriteAt) decides staleness.
		const html = renderDashboard(
			dashboard(writtenAgo(200), { lastScheduledRun: new Date(NOW).toISOString() }),
			false,
			NOW,
		);
		expect(html).toContain(STALE_BANNER);
	});
});
