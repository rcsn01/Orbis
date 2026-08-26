# Orbis Stage 2 bottom-up aggregation results

Captured on 2026-08-24. This report compares Stage 2 with the Stage 1 SQLite writer on the same deterministic fixtures and machine.

## Change

Directory traversal now returns each subtree's allocated bytes, direct-child count, descendant count, and unreadable count. The scanner writes a directory's aggregate once when that asynchronous subtree completes. The root return value supplies `scannedBytes`.

This removes the post-traversal full-table `SELECT`, JavaScript node map, child map, and synchronous recursive aggregation pass. Index creation, metadata, commit, close, and atomic publication remain unchanged and stay inside the Stage 1 writer lifecycle.

The `aggregation` diagnostic changed meaning in this stage. It is now a nested subphase of `traversal` and accumulates prepared directory-update statement time. Aggregate arithmetic remains in traversal. Phase reconciliation and unattributed-time calculation exclude this nested value to avoid double-counting. Stage 1 `traversal + aggregation` should therefore be compared with Stage 2 `traversal`.

## Environment

| Field | Value |
|---|---|
| Moirasia base commit | `0ac2a4f6909d6aba8a8a1531f146000e88d2fe4a` |
| Moirasia working-tree hash | `d03e95e31c028bf18bffa843b9555d5eaa8d7654c3385fc620f6a952cc3b9550` |
| Orbis base commit | `8444610f992397d99fcdd43e0a1d999fd5f1e105` |
| Orbis working-tree hash | `0d221d61719b64e9a69669f912a8e033691dc9dee2d760f073bfa3f0f42a4bc6` |
| Built worker SHA-256 | `2584b2f35b5a83a6999bcf8cb2b12bd4feaaa271eca3564bbf0d2f007b478cb0` |
| Benchmark runner SHA-256 | `4c2318d9f5ebcfed51091bb7c5fe7ff4c3fb018ae714228f7caf3b66205e4285` |
| Node | 22.22.3 |
| OS | macOS Darwin 25.4.0, arm64 |
| CPU | Apple M5 Pro, 18 logical CPUs |
| Memory | 64 GiB |
| Cache label | warm |
| Samples | 1 warm-up, then 10 measured runs per fixture |

## Results

| Fixture | Stage 1 scan | Stage 2 scan | Change | Stage 1 traversal + aggregation | Stage 2 traversal | Stage 2 directory updates | Stage 2 MAD |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 44.90 ms | 44.59 ms | -0.7% | 41.57 ms | 41.17 ms | 0.02 ms | 1.71 ms |
| deep | 19.83 ms | 20.50 ms | +3.3% | 17.30 ms | 17.76 ms | 0.25 ms | 0.66 ms |
| tiny | 190.53 ms | 196.51 ms | +3.1% | 184.99 ms | 190.52 ms | 0.37 ms | 9.50 ms |
| mixed | 47.98 ms | 50.54 ms | +5.3% | 44.57 ms | 46.88 ms | 0.10 ms | 2.88 ms |
| semantics | 3.54 ms | 3.88 ms | +9.5% | 1.36 ms | 1.38 ms | 0.02 ms | 0.13 ms |

The Stage 2 medians varied between repeated runs, and the differences on the substantial fixtures are within the observed spread. This report therefore treats scan-time impact as inconclusive rather than claiming either a speedup or regression. The semantics fixture is too short for its percentage change to be meaningful.

Stage 2 is a structural memory-bound improvement. It eliminates simultaneous JavaScript maps containing every database row and parent-child edge. The deterministic fixtures are too small, and the process-wide 20 ms RSS sampler too coarse, to quantify that peak reliably. Median sampled RSS increases were 10.31 MiB wide, 3.71 MiB deep, 15.20 MiB tiny, 10.33 MiB mixed, and below sampler resolution for semantics. These values are not treated as a general memory claim.

## Correctness

- Indexed item counts, allocated byte totals, database sizes, and semantic skip counters matched Stage 1.
- An independent test oracle reconstructs expected totals from `own_bytes`, `own_unreadable`, and parent relationships, then checks every persisted directory on wide, deep, tiny, mixed, and semantics fixtures.
- Unreadable directories retain their own allocated blocks and propagate one unreadable count through every ancestor.
- Failed child metadata reads remain skipped work and do not create a persisted unreadable node, matching Stage 1.
- A synthetic 1,500-level tree verifies that aggregation does not introduce synchronous recursive finalization.
- Cancellation after one subtree has completed rolls back its directory updates and removes partial and published artifacts.

Database sizes remained unchanged: 0.42 MiB wide, 0.16 MiB deep, 2.14 MiB tiny, 0.46 MiB mixed, and 0.03 MiB semantics.

## Reproduction

```sh
pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline \
  --warmup 1 \
  --samples 10 \
  --fixture all \
  --output benchmark-results/stage-2-bottom-up.json
```

The raw JSON file is a local ignored artifact.

## Decision

Keep bottom-up traversal aggregation. It does not show a reliable latency improvement on these fixtures, but correctness is unchanged and scan memory no longer scales with a second full copy of every database row and parent-child edge. Proceed to schema compaction as a separate Stage 3 change.
