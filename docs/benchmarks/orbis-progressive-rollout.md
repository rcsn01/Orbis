# Orbis progressive-scanning rollout benchmark

Captured 2026-08-24 on the warm local filesystem cache. This is a quick-profile comparison of the new progressive scanner with the legacy rollback scanner on the same generated fixtures. Each fixture used one warm-up and five measured runs at metadata concurrency 4. The tables are the checked-in rollout comparison; rerun them with the documented `--native-addon` option when measuring the native path. Legacy runs intentionally use the legacy Node scanner.

## Results

| Fixture | Items | Progressive median (ms) | Legacy median (ms) | Progressive first preview p95 (ms) | Progressive DB (KiB) | Legacy DB (KiB) |
|---|---:|---:|---:|---:|---:|---:|
| wide | 201 | 24.73 | 11.91 | 25.23 | 180 | 72 |
| deep | 65 | 25.38 | 9.95 | 21.42 | 112 | 44 |
| tiny | 211 | 30.84 | 13.33 | 24.62 | 188 | 76 |
| mixed | 106 | 19.37 | 9.57 | 22.56 | 128 | 52 |
| semantics | 7 | 9.25 | 4.48 | 22.31 | 56 | 28 |

Baseline profile (one warm-up, five measured runs):

| Fixture | Items | Progressive median (ms) | Legacy median (ms) | Progressive first preview p95 (ms) | Progressive DB (KiB) | Legacy DB (KiB) |
|---|---:|---:|---:|---:|---:|---:|
| wide | 2,001 | 139.85 | 48.97 | 25.66 | 1,204 | 472 |
| deep | 257 | 108.83 | 28.13 | 21.75 | 452 | 172 |
| tiny | 10,101 | 880.42 | 209.42 | 26.69 | 6,048 | 2,308 |
| mixed | 2,021 | 173.13 | 54.53 | 26.49 | 1,256 | 500 |
| semantics | 7 | 9.71 | 4.65 | 24.30 | 56 | 28 |

The progressive path intentionally does more work: it writes provisional state, maintains construction-only scheduling/estimate tables, and produces path-free snapshots while traversal is still running. Its first preview arrived within 25.23 ms at p95 on these quick fixtures. The legacy path emits no preview and remains available only with `ORBIS_LEGACY_SCAN=1`. Reports also include native bulk-entry and Node fallback-entry counts for exact traversal.

Both runs completed the same fixture counters and publication validation. The progressive benchmark also recorded preview payloads below the 400-segment/100-largest-item limits. These quick fixtures are not a claim that progressive scanning is faster than the legacy path; perceived readiness and bounded interactive work are the rollout goals.

The baseline profile uses the same final implementation and confirms the same trade-off: progressive first-preview p95 was 21.75–26.69 ms on the large fixtures, while full-scan medians were 139.85 ms (wide), 108.83 ms (deep), 880.42 ms (tiny), and 173.13 ms (mixed), versus 48.97, 28.13, 209.42, and 54.53 ms for legacy. The documented ≤10% full-scan performance gate is therefore unresolved; keep the environment rollback available while progressive scheduling, native/fallback parity, and publication are validated in production-like runs.

## Persistent refresh scenarios

Benchmark report schema 4 adds `scenario`, outcome and strategy, fallback reason, journal replay, candidate clone, incremental traversal, hard-link repair, aggregate repair, validation, candidate publication, alias rows, and persistent-table bytes. Non-initial scenarios build and drain an unmeasured persistent baseline before timing the requested refresh.

Run matched samples with the same profile, fixture, sample count, native addon, and cache conditions:

```sh
# Initial full and clean warm replay
pnpm -C apps/Orbis benchmark:scan -- --scenario initial-full --fixture mixed --profile baseline --samples 5
pnpm -C apps/Orbis benchmark:scan -- --scenario warm-no-change --fixture mixed --profile baseline --samples 5

# Exact incremental traversal
pnpm -C apps/Orbis benchmark:scan -- --scenario one-file-allocation --fixture mixed --profile baseline --samples 5
pnpm -C apps/Orbis benchmark:scan -- --scenario directory-rename --fixture deep --profile baseline --samples 5
pnpm -C apps/Orbis benchmark:scan -- --scenario hardlink-owner-change --fixture deep --profile baseline --samples 5

# Conservative full fallback via a deliberately mismatched journal UUID
pnpm -C apps/Orbis benchmark:scan -- --scenario dropped-history-fallback --fixture mixed --profile baseline --samples 5
```

The dropped-history scenario uses a UUID mismatch because benchmark fixtures cannot safely force the kernel or FSEvents daemon to emit a dropped-history flag. It exercises the same full-refresh dispatch and cursor non-advancement path.

## Resume scenarios

Resume adds `synchronous=FULL` checkpoint commits to uninterrupted full scans. Acceptance requires a matched uninterrupted run, a checkpointed run, app restart, a wide incomplete directory, no-change resume, and mutations during downtime. Compare the final rows and counters with a fresh scan, not with the provisional database. The current directory may be enumerated again after restart.

Record checkpoint count and latency, retained and reset directory counts, active and wall-clock elapsed time, and saved-database bytes. The median uninterrupted full-scan overhead must remain within 10 percent on baseline fixtures. If it does not, adjust checkpoint cadence without weakening recovery or publication checks. Resume results are not yet included in the tables above, so this gate remains open.

A benchmark that changes target identity, invalidates the FSEvents UUID, drops history, changes a policy version, or explicitly discards progress must report a fresh full scan. `ORBIS_LEGACY_SCAN=1` and `ORBIS_DISABLE_INCREMENTAL_SCAN=1` remain non-resumable controls. `ORBIS_DISABLE_BULK_METADATA=1` still exercises resumable scans through Node metadata fallback.

## Reproduction

```sh
pnpm -C apps/Orbis benchmark:scan -- \
  --profile quick --warmup 1 --samples 5 --fixture all \
  --scanner progressive --concurrency 4 \
  --native-addon native/orbis-metadata.darwin-arm64.node \
  --output benchmark-results/progressive-rollout-quick-final.json

pnpm -C apps/Orbis benchmark:scan -- \
  --profile quick --warmup 1 --samples 5 --fixture all \
  --scanner legacy --concurrency 4 \
  --output benchmark-results/legacy-rollout-quick-final.json

# For the baseline table, use --profile baseline and the corresponding
# progressive-rollout-baseline-final.json / legacy-rollout-baseline-final.json names.
```

## Environment

| Field | Value |
|---|---|
| Moirasia base commit | `f399dd103cfbb2e369086622d4946a62c6016fb8` |
| Orbis base commit | `9bf1509b90fe52eac135e78f2032da4ae24147e5` |
| Node | 22.22.3 |
| Platform | macOS Darwin 25.4.0, arm64 |
| Scanner default | progressive |
| Legacy rollback | `ORBIS_LEGACY_SCAN=1` |
