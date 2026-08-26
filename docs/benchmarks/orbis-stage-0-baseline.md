# Orbis Stage 0 scan baseline

Captured on 2026-08-24. This report measures the serial scanner before Stage 1 database changes.

## Environment

| Field | Value |
|---|---|
| Moirasia base commit | `85f7e54c93afb570230ce7c40aae001ec6083885` |
| Moirasia working-tree hash | `89e78d7d4d78d4aa4c5e219db64129f885d854b982e0dfeb2c535265173ce9c7` |
| Orbis base commit | `81a37083bdbe4f11b5594cd674849b1d82eed669` |
| Orbis working-tree hash | `83f2607546bd1d0acedb5060d5a081aff7822e0aa9da9ce2519d8b31020fffbd` |
| Built worker SHA-256 | `a815f871a20b1f8986730d32fd82a24b2f0737396613706857dab4fb613db6ee` |
| Benchmark runner SHA-256 | `3934f0703b9c48a25ed0273c06af22153b4e630668e886f1900f623331f4cbb5` |
| Node | 22.22.3 |
| OS | macOS Darwin 25.4.0, arm64 |
| CPU | Apple M5 Pro, 18 logical CPUs |
| Memory | 64 GiB |
| Fixture filesystem type | 26, APFS on this machine |
| Cache label | warm |
| Samples | 1 warm-up, then 5 measured runs |

The benchmark ran the built worker, real SQLite publication, `OrbisController`, and first completed snapshot. Fixture creation happened before timing. Diagnostics add event allocation and one worker message, so these numbers describe the instrumented path. RSS is process-wide and sampled every 20 ms. The report uses RSS increase from the start of each sample because absolute RSS includes the benchmark runner and earlier fixtures.

This baseline does not measure the React commit, browser layout, or paint. It measures chart construction and largest-item queries in the main process. Renderer work needs a separate Electron measurement if it later appears significant.

## Fixture definitions

| Fixture | Indexed items | Shape |
|---|---:|---|
| wide | 2,001 | 2,000 sibling files in the root |
| deep | 257 | 128 nested directories with one file at each level |
| tiny | 10,101 | 100 directories containing 100 one-byte files each |
| mixed | 2,021 | 20 directories containing 100 deterministic mixed-size files each |
| semantics | 7 | Three files, four directories, two symlinks, and one hard-link alias |

The semantics fixture verified three skips: two symlinks and one duplicate hard link. Scanner tests separately cover unreadable entries, disappearing entries, and a simulated nested mount.

## Results

| Fixture | Scan median | Worker run median | Traversal median | Aggregation median | Controller publication | Throughput | DB size | DB bytes/item | Median RSS increase |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| wide | 75.92 ms | 90.81 ms | 67.35 ms | 4.10 ms | 0.89 ms | 26,358 items/s | 0.42 MiB | 221.1 | 10.58 MiB |
| deep | 55.75 ms | 70.32 ms | 22.81 ms | 28.46 ms | 0.57 ms | 4,610 items/s | 0.16 MiB | 669.4 | 10.36 MiB |
| tiny | 281.57 ms | 294.93 ms | 238.11 ms | 34.15 ms | 1.64 ms | 35,874 items/s | 2.14 MiB | 222.6 | 23.59 MiB |
| mixed | 65.22 ms | 78.04 ms | 53.96 ms | 7.52 ms | 1.30 ms | 30,988 items/s | 0.46 MiB | 237.1 | 10.30 MiB |
| semantics | 5.56 ms | 18.10 ms | 1.52 ms | 0.80 ms | 0.41 ms | 1,260 items/s | 0.03 MiB | 4,096.0 | 0.00 MiB |

Worker startup was stable at roughly 10 ms. Controller publication stayed below 1.7 ms. Neither is a current main-process bottleneck. The zero semantics RSS increase means no 20 ms sample exceeded the process baseline during that short scan.

## Allocated-size baseline

The report stores both `scannedBytes` and `discoveredBytes`. They matched for every sample.

| Fixture | Scanned bytes | Skipped | Unreadable | Nested mounts | Symlinks | Duplicate hard links | Disappearing |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 8,192,000 | 0 | 0 | 0 | 0 | 0 | 0 |
| deep | 524,288 | 0 | 0 | 0 | 0 | 0 | 0 |
| tiny | 40,960,000 | 0 | 0 | 0 | 0 | 0 | 0 |
| mixed | 69,623,808 | 0 | 0 | 0 | 0 | 0 | 0 |
| semantics | 61,440 | 3 | 0 | 0 | 2 | 1 | 0 |

## Raw scan totals

These are the five `scan-total` samples in milliseconds. The local JSON report contains every worker phase, controller phase, correctness counter, database byte count, RSS sample, Git status, and working-tree hash.

| Fixture | Sample 1 | Sample 2 | Sample 3 | Sample 4 | Sample 5 | Median absolute deviation |
|---|---:|---:|---:|---:|---:|---:|
| wide | 63.99 | 77.48 | 75.92 | 70.58 | 84.87 | 5.33 ms |
| deep | 55.75 | 61.99 | 52.83 | 55.27 | 55.84 | 0.48 ms |
| tiny | 283.45 | 296.17 | 281.57 | 272.66 | 275.33 | 6.24 ms |
| mixed | 64.83 | 65.74 | 65.44 | 64.77 | 65.22 | 0.39 ms |
| semantics | 5.74 | 5.46 | 5.65 | 5.56 | 5.48 | 0.10 ms |

Warm-run median absolute deviation stayed below 7.1 percent. The wide fixture was the noisiest. Stage comparisons should use the same fixture order and increase its sample count if a measured change is close to that spread.

## Phase interpretation

Traversal consumed 88.7 percent of the wide scan, 84.6 percent of the tiny-file scan, and 82.7 percent of the mixed scan. This phase includes serial metadata reads and per-node SQLite statement preparation and insertion.

Aggregation behaved differently on the deep fixture. It consumed 51.1 percent of scan time there, compared with 5.4 percent on wide, 12.1 percent on tiny, and 11.5 percent on mixed. The current finalizer issues one autocommitted update per directory after the traversal transaction. Deep trees expose that cost even with only 257 indexed items.

The measurements support the existing Stage 1 order:

1. Put finalization writes in an explicit transaction.
2. Reuse prepared insert, update, and metadata statements.
3. Measure again before changing traversal concurrency.

Prepared insertion should affect the dominant traversal phase. Transactional finalization should affect directory-heavy and deep trees. Main-process publication and chart-query work is too small to optimize now. This report makes no claim about browser rendering.

## Reproduction

```sh
pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline \
  --warmup 1 \
  --samples 5 \
  --fixture all \
  --output benchmark-results/stage-0-baseline.json
```

The command rejects worker failures, cancellations, and timeouts. It validates node counts, allocated-size metadata, semantic skip counts, required timing phases, phase reconciliation, and diagnostic-message ordering before writing the report.

## Remaining manual measurement

A true cold-cache startup-volume measurement requires a restart or another controlled cache state. Building the worker or benchmark after restart would contaminate that run, so prepare both first:

```sh
pnpm -C apps/Orbis benchmark:scan:prepare
```

After restarting, run the prepared bundle without a build:

```sh
pnpm -C apps/Orbis benchmark:scan:prepared -- \
  --target / \
  --allow-live-target \
  --cache-state cold-manual \
  --warmup 0 \
  --samples 1
```

Repeat the same prepared command with `--cache-state warm` for the warm comparison. The label records operator intent; the benchmark does not flush or inspect macOS caches. A live report records that it scanned a live target but omits the absolute target path. The fixture baseline is complete. The startup-volume rows remain unfilled until those manual runs occur.
