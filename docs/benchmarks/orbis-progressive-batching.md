# Orbis progressive batching benchmark

Captured on 2026-08-25 on an Apple M5 Pro with 64 GiB RAM, macOS 25.4.0, and Node 22.22.3.

## Method

Each cell contains ten measured baseline-profile scans after one warmup. The matrix covers the wide, tiny-file, and mixed fixtures with the native metadata cursor and with `ORBIS_DISABLE_BULK_METADATA=1`. The worker was rebuilt with the batch diagnostics before measurement. `ORBIS_DISABLE_INCREMENTAL_SCAN=1` isolated traversal from fixture-creation FSEvents, which otherwise caused post-scan reconciliation failures on the tiny fixture. This means checkpoint count is zero in this matrix. Separate resumable tests cover checkpoint cadence and batch rollback.

All sizes kept the one-time 32-entry root preview. Only later reads used the selected batch size. RSS values are median increases from each runner's pre-scan reading. Read calls count metadata cursor invocations, not entries or native fallback filesystem calls.

## Results

| Adapter | Batch | Fixture | Scan median ms | First preview p95 ms | RSS increase MiB | Cursor calls median |
|---|---:|---|---:|---:|---:|---:|
| Native | 32 | wide | 159.94 | 31.47 | 11.87 | 63 |
| Native | 32 | tiny | 1,045.88 | 30.51 | 17.59 | 983 |
| Native | 32 | mixed | 186.63 | 27.45 | 12.02 | 180 |
| Native | 256 | wide | 145.04 | 31.33 | 16.00 | 9 |
| Native | 256 | tiny | 828.81 | 30.12 | 17.18 | 102 |
| Native | 256 | mixed | 174.96 | 35.26 | 12.03 | 21 |
| Native | 512 | wide | 145.25 | 30.24 | 16.05 | 5 |
| Native | 512 | tiny | 813.33 | 31.40 | 17.18 | 102 |
| Native | 512 | mixed | 162.67 | 29.77 | 12.11 | 21 |
| Node fallback | 32 | wide | 175.63 | 30.56 | 12.02 | 63 |
| Node fallback | 32 | tiny | 1,208.12 | 30.94 | 19.02 | 983 |
| Node fallback | 32 | mixed | 216.42 | 31.66 | 15.83 | 180 |
| Node fallback | 256 | wide | 154.62 | 29.25 | 16.26 | 9 |
| Node fallback | 256 | tiny | 897.60 | 34.83 | 18.02 | 102 |
| Node fallback | 256 | mixed | 179.40 | 29.98 | 16.28 | 21 |
| Node fallback | 512 | wide | 161.94 | 30.48 | 16.30 | 5 |
| Node fallback | 512 | tiny | 854.73 | 31.35 | 18.08 | 102 |
| Node fallback | 512 | mixed | 186.28 | 33.55 | 16.27 | 21 |

## Decision

Use 256 entries for steady-state metadata batches.

The 256-entry runs passed fixture validation. First-preview p95 stayed below 36 ms, and the largest median RSS increase over the corresponding 32-entry control was 4.24 MiB. No wide, tiny, or mixed median regressed. Native medians improved by 6.3% to 20.8%; Node fallback medians improved by 12.0% to 25.7%.

Do not promote 512. Its native wide median was effectively tied with 256, 145.25 ms against 145.04 ms. Its Node fallback wide median regressed to 161.94 ms from 154.62 ms. It therefore misses the required 5% wide-fixture improvement in both modes, regardless of median absolute deviation.

The benchmark JSON runner records batch size, scan and preview time, RSS, native and Node cursor calls, and checkpoint count. `--batch-size` sets the internal `ORBIS_METADATA_BATCH_SIZE` override; there is no user preference.
