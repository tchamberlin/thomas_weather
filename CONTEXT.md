# thomas_weather

A PWS rainfall dashboard on Cloudflare Workers. The cron is the only thing that
touches Weather Underground; it refreshes KV caches that the request path reads.
This file fixes the names for the domain (what the data is) and the architecture
(where behaviour lives) so reviews and refactors don't drift.

## Language

### Stations

**Station** (PWS):
A personal weather station, identified by a Weather Underground station ID.
_Avoid_: sensor, site, device.

**Primary station**:
A station the user tracks directly — listed in KV under `weather:config:station-ids`, refreshed every cron tick.
_Avoid_: tracked station, main station.

**Neighbor station**:
A nearby station discovered for rainfall comparison against a **Primary station**, refreshed on a slower cron cadence.
_Avoid_: nearby station, peer.

### Weather data

**Current observation**:
A station's latest live reading (`/v2/pws/observations/current`). Supplies today's in-progress rainfall and the staleness clock.
_Avoid_: current conditions, live data.

**Daily summary**:
One day's aggregated weather for a station (`/v2/pws/dailysummary/7day`).
_Avoid_: daily rollup.

**History block**:
A month-aligned span of raw hourly observations stored under one KV key (`weather:history:hourly:raw:<id>:<start>:<end>`).
_Avoid_: history chunk, backfill block.

**Span stats**:
A station's current / 24h / 7d rollup of rain, temp, and wind, derived by `computeSpanStats`.
_Avoid_: summary stats.

### Comparison

**Rainfall comparison**:
A ranking of a **Primary station** against its **Neighbor station**s by rainfall for one date — yields the rank, the count, the neighbourhood median (a true median of the neighbours, primary excluded), and the standings shown on the rain pages. Produced by `compareRainfall`.
_Avoid_: leaderboard, ranking.

**Standing**:
One station's entry in a **Rainfall comparison** — its id, distance, rainfall, and whether it is the primary.
_Avoid_: row, entry.

### Storage & seams

**Station cache**:
The module owning the single-value, id-keyed KV caches — **Current observation**, coords, and **Daily summary**. It owns their keys, JSON shaping, metadata, and the env guard. Constructed with a `KVNamespace` so an in-memory fake can stand in for tests.
_Avoid_: KV wrapper, cache layer.

**History block store**:
The separate module owning **History block** reads/writes and the history index. Distinct from the **Station cache** because its keys are date-range scoped, it passes raw JSON through unparsed, and writing triggers an index update.
_Avoid_: history cache.

**Write-dedup invariant**:
A KV write is suppressed when its payload is byte-identical to the last value written for that key in this isolate — the mechanism that bounds writes against the KV budget. Lives in exactly one function, `putDeduped`, shared by the **Station cache** and the **History block store**.
_Avoid_: cache busting, write throttle.

**WuClient**:
The capability object that authorizes Weather Underground access. Constructable only by the cron and by admin handlers after authorization, so the request path is statically barred from reaching WU.
_Avoid_: WU client, API client.

## Example dialogue

> **Dev:** The dashboard showed stale data but the cron logs looked fine. Cache bug?
>
> **Expert:** Check the **write-dedup invariant** first. Every **Station cache** write goes through `putDeduped` — if a write is being suppressed when it shouldn't, the **Current observation**'s `cachedAt` stamp stops advancing and the staleness clock trips. That's one function to look at, not four.
>
> **Dev:** And the 7-day history chart?
>
> **Expert:** Different module. Hourly data is **History block**s in the **History block store**, keyed by date range, not the **Station cache**. The store shares `putDeduped`, but its reads and its index update are its own.
>
> **Dev:** Could the request path have written a bad value?
>
> **Expert:** No — the request path can't construct a **WuClient**, so it never fetches or writes fresh data. Only the cron does.
