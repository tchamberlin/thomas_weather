import { describe, it, expect } from 'vitest';
import { nearestNeighbors, MAX_NEIGHBORS_PER_STATION } from '../src/index';

const mk = (stationId: string, distanceMi: number | null) => ({
	stationId, name: null, lat: null, lon: null,
	distanceKm: distanceMi === null ? null : distanceMi * 1.60934,
	distanceMi, qcStatus: null, updateTimeUtc: null,
});

describe('nearestNeighbors', () => {
	it('keeps only the closest, ordered by distance', () => {
		const r = nearestNeighbors([mk('A', 5), mk('B', 1), mk('C', 9), mk('D', 3), mk('E', 7)]);
		expect(r.map((n) => n.stationId)).toEqual(['B', 'D', 'A']);
	});

	it('caps at MAX_NEIGHBORS_PER_STATION', () => {
		const many = Array.from({ length: 20 }, (_, i) => mk(`S${i}`, i));
		expect(nearestNeighbors(many)).toHaveLength(MAX_NEIGHBORS_PER_STATION);
	});

	it('sorts unknown (null) distances last', () => {
		const r = nearestNeighbors([mk('A', null), mk('B', 2), mk('C', 1)]);
		expect(r.map((n) => n.stationId)).toEqual(['C', 'B', 'A']);
	});

	it('does not mutate the input array', () => {
		const input = [mk('A', 5), mk('B', 1)];
		const copy = input.map((n) => n.stationId);
		nearestNeighbors(input);
		expect(input.map((n) => n.stationId)).toEqual(copy);
	});

	it('handles fewer than the cap', () => {
		expect(nearestNeighbors([mk('A', 2)]).map((n) => n.stationId)).toEqual(['A']);
		expect(nearestNeighbors([])).toEqual([]);
	});
});
