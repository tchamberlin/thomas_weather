import { describe, it, expect } from 'vitest';
import { compareRainfall } from '../src/index';

// Derive the neighbour-reading shape from the function so the test needn't import
// the internal type.
type Neighbor = Parameters<typeof compareRainfall>[2][number];
const nb = (stationId: string, rainfall: number | null, distanceMi: number | null = 1): Neighbor =>
	({ stationId, name: null, distanceMi, rainfall, error: null });

describe('compareRainfall', () => {
	it('returns an empty comparison when nothing has a reading', () => {
		const c = compareRainfall('K1', null, []);
		expect(c).toEqual({ byRainfall: [], byDistance: [], rank: 0, count: 0, median: null });
	});

	it('ranks the primary first when alone, with no neighbour median', () => {
		const c = compareRainfall('K1', 0.5, []);
		expect(c.count).toBe(1);
		expect(c.rank).toBe(1);
		expect(c.median).toBeNull();
		expect(c.byRainfall[0]).toMatchObject({ id: 'K1', isPrimary: true, distanceMi: 0 });
	});

	it('ranks the primary among neighbours by rainfall', () => {
		const c = compareRainfall('K1', 0.3, [nb('N1', 0.5), nb('N2', 0.1)]);
		expect(c.count).toBe(3);
		expect(c.byRainfall.map((s) => s.rainfall)).toEqual([0.5, 0.3, 0.1]);
		expect(c.rank).toBe(2);
	});

	it('drops neighbours without a reading', () => {
		const c = compareRainfall('K1', 0.2, [nb('N1', null), nb('N2', 0.4)]);
		expect(c.count).toBe(2);
		expect(c.byRainfall.map((s) => s.id)).toEqual(['N2', 'K1']);
	});

	it('orders byDistance nearest-first, primary (0) first, treating null distance as 0', () => {
		const c = compareRainfall('K1', 0.1, [nb('N1', 0.2, null), nb('N2', 0.3, 3)]);
		expect(c.byDistance.map((s) => s.id)).toEqual(['K1', 'N1', 'N2']);
		expect(c.byDistance[0].isPrimary).toBe(true);
	});

	it('keeps the primary first among rainfall ties (stable)', () => {
		const c = compareRainfall('K1', 0.5, [nb('N1', 0.5)]);
		expect(c.byRainfall[0].isPrimary).toBe(true);
		expect(c.rank).toBe(1);
	});

	describe('neighbourhood median (true median, primary excluded)', () => {
		it('averages the two middle values for an even neighbour count', () => {
			// Behaviour change: the old code returned the upper middle (0.4); a true
			// median averages the two middles.
			const c = compareRainfall('K1', 9, [nb('N1', 0.2), nb('N2', 0.4)]);
			expect(c.median).toBeCloseTo(0.3, 10);
		});

		it('takes the middle value for an odd neighbour count', () => {
			const c = compareRainfall('K1', 9, [nb('N1', 0.1), nb('N2', 0.3), nb('N3', 0.2)]);
			expect(c.median).toBe(0.2);
		});

		it('excludes the primary from the median', () => {
			// Primary is the wettest; median is of the neighbours only.
			const c = compareRainfall('K1', 100, [nb('N1', 1), nb('N2', 3)]);
			expect(c.median).toBe(2);
		});

		it('computes a neighbour median even when the primary has no reading', () => {
			const c = compareRainfall('K1', null, [nb('N1', 0.2), nb('N2', 0.6)]);
			expect(c.rank).toBe(0);
			expect(c.count).toBe(2);
			expect(c.median).toBeCloseTo(0.4, 10);
		});
	});
});
