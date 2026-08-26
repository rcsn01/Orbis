# Orbis Stage 1 SQLite transaction results

Captured on 2026-08-24. This report compares Stage 1 against the instrumented Stage 0 serial scanner on the same machine and deterministic fixtures.

## Change

Stage 1 replaces the scanner's raw SQLite connection with a `ScanDatabase` writer that owns:

- one transaction from schema setup through aggregation, metadata, and index creation;
- prepared statements reused for node inserts, unreadable markers, directory updates, and metadata;
- explicit `building`, committed, rollback, and closed lifecycle behavior;
- commit, rollback, close, and partial-file cleanup before atomic publication.

`DiskIndex` remains a separate read-only query object. Scan results, progress, snapshots, IPC, allocated-block accounting, mount checks, symlink handling, and hard-link deduplication are unchanged.

## Environment

| Field | Value |
|---|---|
| Moirasia base commit | `5e6b4676eac8ba3f8ffc47237570f889a76ff01b` |
| Moirasia working-tree hash | `ddc24741cb7654a638fdc25c5fdb21310c65231bdd4c04222f7426dee0a5b521` |
| Orbis base commit | `9312fb6db7c2851572ea004e39cd5dac533642b5` |
| Orbis working-tree hash | `25247ca12cbe526587d1ec5d8cc86a507698be724d1a831bf4d3a30eb0775fdb` |
| Built worker SHA-256 | `9c1c1a002c73faa3b436028d73fe42d96d011e92d32ea916135c1799be50e7b2` |
| Benchmark runner SHA-256 | `42af43f6e0bbf5fbaf92903d978effa28182a5e9f2a4f56f16ad145cafdc87f9` |
| Node | 22.22.3 |
| OS | macOS Darwin 25.4.0, arm64 |
| CPU | Apple M5 Pro, 18 logical CPUs |
| Memory | 64 GiB |
| Cache label | warm |
| Samples | 1 warm-up, then 5 measured runs |

Both runs used the same baseline fixture profile and real worker/controller publication path. Fixture creation happened before timing.

## Results

| Fixture | Stage 0 scan | Stage 1 scan | Scan change | Stage 0 traversal | Stage 1 traversal | Stage 0 aggregation | Stage 1 aggregation | Throughput change |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| wide | 75.92 ms | 44.90 ms | -40.8% | 67.35 ms | 39.18 ms | 4.10 ms | 2.39 ms | +69.1% |
| deep | 55.75 ms | 19.83 ms | -64.4% | 22.81 ms | 16.66 ms | 28.46 ms | 0.64 ms | +181.1% |
| tiny | 281.57 ms | 190.53 ms | -32.3% | 238.11 ms | 172.29 ms | 34.15 ms | 12.70 ms | +47.8% |
| mixed | 65.22 ms | 47.98 ms | -26.4% | 53.96 ms | 41.68 ms | 7.52 ms | 2.89 ms | +35.9% |
| semantics | 5.56 ms | 3.54 ms | -36.2% | 1.52 ms | 1.22 ms | 0.80 ms | 0.14 ms | +56.8% |

The improvements are well outside the Stage 0 spread, including the noisiest wide fixture, so a ten-sample rerun was not needed. Stage 1 scan median absolute deviation ranged from 0.22% to 3.0% of the median.

The traversal comparison includes a small accounting change: Stage 0's traversal phase included its transaction commit, while Stage 1 reports commit separately. The Stage 1 median commit was 0.19-1.21 ms, much smaller than the 6.15-65.82 ms traversal reductions. Reused insertion statements account for most of the remaining improvement.

Deep-tree aggregation fell by 97.8%. Stage 0 autocommitted each directory update under `synchronous=FULL`; Stage 1 performs those updates inside the construction transaction. Directory aggregation also improved by 41.8-82.8% on the other fixtures.

## Invariants and resource use

- Indexed item counts, allocated byte totals, skip counters, and semantic counters matched Stage 0 for every sample.
- Database sizes were byte-for-byte unchanged: 0.42 MiB wide, 0.16 MiB deep, 2.14 MiB tiny, 0.46 MiB mixed, and 0.03 MiB semantics.
- Median RSS increase was 10.41 MiB wide, 10.02 MiB deep, 16.11 MiB tiny, 12.00 MiB mixed, and below the 20 ms sampler resolution for semantics. RSS is process-wide and noisy; Stage 1 does not claim a general memory improvement.
- Controller publication medians remained between 0.44 and 1.54 ms and are not a bottleneck.
- Tests cover commit readability, rollback of inserts and aggregate/index writes, lifecycle guards, sidecar cleanup, cancellation cleanup, and rejection of an invalid rescan database without replacing the previous index.

## Raw scan totals

| Fixture | Sample 1 | Sample 2 | Sample 3 | Sample 4 | Sample 5 | MAD |
|---|---:|---:|---:|---:|---:|---:|
| wide | 43.98 | 45.22 | 44.90 | 44.18 | 46.36 | 0.72 ms |
| deep | 19.82 | 19.83 | 20.30 | 19.51 | 20.27 | 0.32 ms |
| tiny | 193.34 | 188.37 | 192.67 | 190.40 | 190.53 | 2.14 ms |
| mixed | 47.76 | 50.45 | 47.88 | 48.51 | 47.98 | 0.22 ms |
| semantics | 3.54 | 3.59 | 3.35 | 3.44 | 3.78 | 0.11 ms |

## Reproduction

```sh
pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline \
  --warmup 1 \
  --samples 5 \
  --fixture all \
  --output benchmark-results/stage-1-transaction.json
```

The benchmark now requires a separate `database-commit` timing in addition to the Stage 0 phases. The raw JSON remains a local ignored artifact.

## Decision

Stage 1 met its exit criteria. Keep the transaction and prepared-statement design. Proceed to Stage 2 as a separate change: calculate directory totals during traversal and remove the full-table JavaScript reconstruction pass.
