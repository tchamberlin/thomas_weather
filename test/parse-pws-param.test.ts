import { describe, it, expect } from 'vitest';
import { parsePwsParam } from '../src/index';

describe('parsePwsParam', () => {
	it('parses bare comma-separated IDs and uppercases them', () => {
		expect(parsePwsParam(['kvalakef29,kwvarbov2'])).toEqual([
			{ id: 'KVALAKEF29' },
			{ id: 'KWVARBOV2' },
		]);
	});

	it('parses label:id syntax, uppercasing the id but preserving label case', () => {
		expect(parsePwsParam(['Alice:kvalakef29'])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
		]);
	});

	it('merges repeated pws values in order', () => {
		expect(parsePwsParam(['Alice:KVALAKEF29', 'Bob:KWVARBOV2'])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
			{ id: 'KWVARBOV2', label: 'Bob' },
		]);
	});

	it('handles labeled and bare entries mixed within one value', () => {
		expect(parsePwsParam(['Alice:KVALAKEF29,KWVARBOV2'])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
			{ id: 'KWVARBOV2' },
		]);
	});

	it('dedups by id, keeping the first occurrence and its label', () => {
		expect(parsePwsParam(['Alice:KVALAKEF29,Alice2:kvalakef29'])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
		]);
	});

	it('skips entries whose id is not a valid PWS id', () => {
		expect(parsePwsParam(['ab', 'Bob:b@d', 'Alice:KVALAKEF29', ''])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
		]);
	});

	it('returns an empty array for empty input', () => {
		expect(parsePwsParam([])).toEqual([]);
		expect(parsePwsParam([''])).toEqual([]);
	});

	it('trims whitespace around label and id', () => {
		expect(parsePwsParam([' Alice : kvalakef29 , KWVARBOV2 '])).toEqual([
			{ id: 'KVALAKEF29', label: 'Alice' },
			{ id: 'KWVARBOV2' },
		]);
	});

	it('caps the result at 32 stations', () => {
		const ids = Array.from({ length: 40 }, (_, i) => `KSTATION${i}`);
		expect(parsePwsParam([ids.join(',')])).toHaveLength(32);
	});
});
