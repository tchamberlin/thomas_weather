import { describe, it, expect } from 'vitest';
import { createStationCache, putDeduped } from '../src/index';

// In-memory KVNamespace fake. It counts .put() calls, so the Write-dedup
// invariant ("same payload => no PUT") is directly assertable — which a real
// (miniflare) KV would hide. Param types are derived from the exported factory
// so the test needn't reach for the global KVNamespace type.
type Kv = Parameters<typeof createStationCache>[0];

function fakeKv() {
	const store = new Map<string, { value: string; metadata?: unknown }>();
	const kv = {
		puts: 0,
		store,
		async get(key: string) {
			return store.get(key)?.value ?? null;
		},
		async getWithMetadata(key: string) {
			const entry = store.get(key);
			return { value: entry?.value ?? null, metadata: entry?.metadata ?? null };
		},
		async put(key: string, value: string, opts?: { metadata?: unknown }) {
			kv.puts += 1;
			store.set(key, { value, metadata: opts?.metadata });
		},
	};
	return kv;
}

function makeCache() {
	const kv = fakeKv();
	const cache = createStationCache(kv as unknown as Kv, new Map<string, string>());
	return { kv, cache };
}

type Obs = Parameters<ReturnType<typeof createStationCache>['current']['write']>[1];
type Days = Parameters<ReturnType<typeof createStationCache>['daily']['write']>[1];

const obs = (overrides: Record<string, unknown> = {}): Obs =>
	({ stationID: 'K1', lat: 40.1, lon: -80.2, imperial: { temp: 70, precipTotal: 0.5 }, ...overrides }) as unknown as Obs;

const days = (rainfall: number): Days =>
	[{ date: '2026-05-20', obsTimeLocal: '2026-05-20 23:59:00', rainfall, source: 'cache' }] as unknown as Days;

describe('putDeduped — the Write-dedup invariant lives here', () => {
	it('writes once, suppresses an identical re-write, and reports which happened', async () => {
		const kv = fakeKv();
		const dedup = new Map<string, string>();
		expect(await putDeduped(kv as unknown as Kv, dedup, 'k', 'payload')).toBe(true);
		expect(await putDeduped(kv as unknown as Kv, dedup, 'k', 'payload')).toBe(false);
		expect(await putDeduped(kv as unknown as Kv, dedup, 'k', 'changed')).toBe(true);
		expect(kv.puts).toBe(2);
	});

	it('passes metadata through only when provided', async () => {
		const kv = fakeKv();
		await putDeduped(kv as unknown as Kv, new Map(), 'k', 'v', { tag: 1 });
		expect(kv.store.get('k')?.metadata).toEqual({ tag: 1 });
	});
});

describe('station cache — current', () => {
	it('dedups identical observations within an isolate', async () => {
		const { kv, cache } = makeCache();
		await cache.current.write('K1', obs());
		await cache.current.write('K1', obs());
		expect(kv.puts).toBe(1);
	});

	it('writes again when the observation changes', async () => {
		const { kv, cache } = makeCache();
		await cache.current.write('K1', obs({ imperial: { temp: 70 } }));
		await cache.current.write('K1', obs({ imperial: { temp: 71 } }));
		expect(kv.puts).toBe(2);
	});

	it('round-trips the value and surfaces cachedAt as lastWriteAt', async () => {
		const { cache } = makeCache();
		await cache.current.write('K1', obs({ imperial: { temp: 68 } }));
		const { value, lastWriteAt } = await cache.current.read('K1');
		expect(value?.imperial?.temp).toBe(68);
		expect(lastWriteAt).not.toBeNull();
		expect(Number.isFinite(Date.parse(lastWriteAt!))).toBe(true);
	});

	it('reads a never-written station as null with no stamp', async () => {
		const { cache } = makeCache();
		expect(await cache.current.read('MISSING')).toEqual({ value: null, lastWriteAt: null });
	});
});

describe('station cache — coords (write precondition lives in the accessor)', () => {
	it('no-ops when lat/lon are not numeric', async () => {
		const { kv, cache } = makeCache();
		await cache.coords.write('K1', obs({ lat: undefined, lon: undefined }));
		expect(kv.puts).toBe(0);
		expect(await cache.coords.read('K1')).toBeNull();
	});

	it('stores and reads back numeric lat/lon, then dedups', async () => {
		const { kv, cache } = makeCache();
		await cache.coords.write('K1', obs({ lat: 40.1, lon: -80.2 }));
		await cache.coords.write('K1', obs({ lat: 40.1, lon: -80.2 }));
		expect(kv.puts).toBe(1);
		expect(await cache.coords.read('K1')).toEqual({ lat: 40.1, lon: -80.2 });
	});
});

describe('station cache — daily', () => {
	it('no-ops on an empty list', async () => {
		const { kv, cache } = makeCache();
		await cache.daily.write('K1', days(0).slice(0, 0));
		expect(kv.puts).toBe(0);
	});

	it('round-trips and dedups a non-empty list', async () => {
		const { kv, cache } = makeCache();
		await cache.daily.write('K1', days(0.5));
		await cache.daily.write('K1', days(0.5));
		expect(kv.puts).toBe(1);
		const read = await cache.daily.read('K1');
		expect(read).toHaveLength(1);
		expect(read[0].rainfall).toBe(0.5);
	});
});

describe('isolate boundary', () => {
	it('a fresh dedup map re-PUTs a value the previous isolate already wrote', async () => {
		const kv = fakeKv();
		const first = createStationCache(kv as unknown as Kv, new Map());
		await first.current.write('K1', obs());
		// Same backing KV, new isolate => new (empty) dedup map.
		const second = createStationCache(kv as unknown as Kv, new Map());
		await second.current.write('K1', obs());
		expect(kv.puts).toBe(2);
	});
});
