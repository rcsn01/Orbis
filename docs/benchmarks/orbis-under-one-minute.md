# Full-volume scan optimization log

## Goal and method

The acceptance target is an exact initial scan of `/` in less than 60 seconds on this MacBook. Iteration runs use the Orbis checkout because it has about 42,800 indexed nodes across source, Git data, build output, and dependencies. Every optimization gets its own branch. Raw reports remain in the ignored `benchmark-results/` directory.

The benchmark reports worker `scanTotalMs`. It validates the published SQLite node count, root allocated size, metadata totals, and scan counters before writing a result.

## Environment

- Apple M5 Pro, 18 logical CPUs, 64 GiB RAM
- macOS Darwin 25.4.0, arm64
- Node 22.22.3
- Main baseline commit: `a2d7d60a78e4675c133ab4cafa0d0a2a773c5553`
- Metadata concurrency: 4
- Metadata page size: 256
- Cache label: warm

## Results

| Method | Branch | Target | Samples | Indexed nodes | Scan median | Traversal median | Metadata open | Metadata read | Aggregation | Result |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Current progressive scanner | `main` | Orbis checkout | 1 | 42,764 | 3,404.99 ms | 3,086.48 ms | 901.20 ms | 630.00 ms | 1,735.12 ms | Baseline |
| Cache 128 native directory descriptors and open from the nearest cached parent | `perf/parent-fd-cache` | Orbis checkout | 3 after 1 warmup | 42,794 | 3,417.58 ms | 3,075.43 ms | 877.54 ms | 627.22 ms | 1,733.66 ms | Rejected, no end-to-end gain |
| Native depth-first `getattrlistbulk` traversal prototype | `perf/native-batched-traversal` | Orbis checkout | 5 | 42,828 | 165.68 ms traversal-only | 165.62 ms | n/a | included | n/a | 20.6x faster than the baseline end-to-end scan; integration pending |
| Native depth-first `getattrlistbulk` traversal prototype | `perf/native-batched-traversal` | `/` | 1 | 4,079,698 | 57,829.87 ms traversal-only | 57,829.68 ms | n/a | included | n/a | Raw traversal meets 60 seconds by 2.17 seconds; not an end-to-end pass |
| Eight native workers split across root subtrees | `perf/native-parallel-traversal` | Orbis checkout | 5 | 42,845 | 161.73 ms traversal-only | 161.66 ms | n/a | included | n/a | Checkout has one dominant subtree; 2.4% faster than sequential native median |
| Eight native workers split across root subtrees | `perf/native-parallel-traversal` | `/` | 1 | 4,079,718 | 40,792.26 ms traversal-only | 40,791.99 ms | n/a | included | 29.5% faster than sequential native; 19.2 seconds remain for indexing |

Raw reports:

- `benchmark-results/iteration-main-baseline.json`
- `benchmark-results/iteration-parent-fd-cache.json`
- Native prototype output was captured directly from `scanTreeSummary()` because this branch measures traversal before production integration.

The node count changed by 30 because build and benchmark artifacts inside the live checkout changed between runs. Throughput fell from 12,559 to 12,522 nodes per second. Traversal changed by less than 0.4 percent, while total scan time increased by 0.4 percent. Descriptor caching does not address the per-directory JavaScript, N-API, scheduling, preview, and SQLite work.

## Full-volume evidence

The prepared baseline command was:

```sh
pnpm benchmark:scan:prepared -- \
  --target / --allow-live-target --cache-state warm \
  --warmup 0 --samples 1 --timeout-ms 1800000 \
  --output benchmark-results/full-mac-main-baseline.json
```

The run was stopped after about 22 minutes so iteration could move to a smaller target. Its resumable construction database contained 807,875 nodes and 244,689 directory tasks. Of those tasks, 170,201 were complete, 74,171 were queued, 71 were scanning, and 246 were unreadable. The database was 430,764,032 bytes with a 54,375,792-byte WAL. This is a censored run, not a completed baseline, but it proves the current per-directory construction path cannot meet the 60-second target.

## Native traversal prototype

The native prototype owns depth-first descriptor-relative traversal and does not cross N-API per directory. It uses `getattrlistbulk`, skips startup exclusions, symlinks, nested devices, and special entries, and deduplicates multi-link files by device and inode. Five checkout samples were 601.95, 174.88, 165.68, 165.02, and 163.91 ms. The first sample followed the full-volume run and was a cache outlier. Every sample returned identical counts and bytes.

The `/` prototype completed in 57.83 seconds with 77,512,704 bytes maximum RSS. It found 3,357,951 files and 721,747 directories. It skipped 122,728 symlinks, 42,428 duplicate hard links, and 265 unreadable entries. The result reports exact aggregate allocated bytes but does not yet build the per-node SQLite index, expose previews, or support cancellation, so it does not satisfy the final gate.

## Parallel native traversal

Eight workers claim top-level subtrees and use depth-first descriptor-relative traversal within each subtree. This keeps open descriptors bounded by subtree width and depth while avoiding path replay. The full-volume run fell from 57.83 to 40.79 seconds, a 29.5 percent reduction. Maximum RSS fell from 77.5 MB to 52.2 MB in the measured processes. Counts changed slightly because the live filesystem changed between runs.

The Orbis checkout improved only 2.4 percent at the median because most entries sit under one top-level build subtree. That target remains useful for per-entry CPU and database costs but does not model full-volume parallelism well.

## Next method

Build the final SQLite schema from native traversal. Use one writer transaction and prepared statements, overlap it with metadata workers, and calculate directory totals bottom-up after discovery. This must preserve every file, deterministic hard-link ownership, allocated-byte totals, startup exclusions, cancellation, and atomic publication.
