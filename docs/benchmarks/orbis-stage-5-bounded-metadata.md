# Orbis Stage 5 bounded metadata results

Captured on 2026-08-24. This report evaluates scan-wide bounded metadata concurrency against the same implementation at concurrency 1.

## Change

The scanner now uses one ordered concurrent mapper for the whole scan. It:

- admits at most the configured number of filesystem metadata operations at once;
- retains at most four times that number of admitted result records across suspended directory traversals;
- yields results in deterministic name order, keeping SQLite writes, IDs, and hard-link winner selection serialized;
- stops admission on cancellation and drains admitted operations before database cleanup;
- uses a total name comparator so locale-equivalent names still have deterministic order.

The production default is 4, matching Node's default libuv filesystem thread-pool width. `ORBIS_SCAN_CONCURRENCY` remains an internal override clamped to 1-64. The benchmark exposes the same setting as `--concurrency` and records its effective value.

This is bounded metadata concurrency, not unrestricted parallel subtree traversal. Directory recursion and database writes remain coordinated and deterministic. A broader subtree scheduler is unnecessary unless later real-volume measurements show serial directory enumeration is still limiting.

## Tuning sweep

The initial sweep used one warm-up and three measured runs per fixture.

| Concurrency | Wide | Deep | Tiny | Mixed |
|---:|---:|---:|---:|---:|
| 1 | 46.93 ms | 20.85 ms | 190.73 ms | 47.66 ms |
| 4 | 32.78 ms | 20.56 ms | 134.23 ms | 35.03 ms |
| 8 | 32.96 ms | 21.35 ms | 136.00 ms | 35.26 ms |
| 16 | 34.41 ms | 21.65 ms | 141.50 ms | 36.20 ms |
| 32 | 33.63 ms | 19.76 ms | 136.97 ms | 35.40 ms |

Four was the best conservative setting across the wide, tiny, and mixed fixtures. Higher values did not provide a consistent gain and increase pressure on filesystems that may handle parallel access poorly. Deep traversal has one immediate child per level and therefore does not benefit materially from this implementation.

## Ten-sample comparison

Both sides use the Stage 5 implementation; only the configured concurrency differs. This avoids attributing async-mapper overhead or unrelated code changes to concurrency.

| Fixture | Concurrency 1 | Concurrency 4 | Change | Throughput at 1 | Throughput at 4 |
|---|---:|---:|---:|---:|---:|
| wide | 45.02 ms | 32.92 ms | -26.9% | 44,442 items/s | 60,775 items/s |
| deep | 20.76 ms | 20.66 ms | -0.5% | 12,377 items/s | 12,442 items/s |
| tiny | 187.70 ms | 136.23 ms | -27.4% | 53,816 items/s | 74,147 items/s |
| mixed | 46.92 ms | 35.68 ms | -24.0% | 43,069 items/s | 56,647 items/s |
| semantics | 3.68 ms | 3.62 ms | -1.7% | 1,902 items/s | 1,935 items/s |

Median absolute deviation remained below 1.1 ms in both configurations. The large-fixture improvements are well outside that spread.

Median RSS increases changed from 10.44 to 12.22 MiB wide, 10.05 to 10.08 MiB deep, 15.25 to 15.48 MiB tiny, and 10.36 to 10.70 MiB mixed. The wide increase was 1.78 MiB; other changes were below 0.35 MiB. Database sizes were unchanged.

## Correctness and safety

Tests verify that:

- active metadata operations never exceed the scan-wide limit, including nested branching directories;
- completed-result buffering remains globally bounded;
- output rows and totals match concurrency 1 exactly;
- IDs and hard-link representatives remain deterministic;
- hard links spanning top-level subtrees are counted once;
- cancellation stops admission and drains in-flight operations;
- early consumer exit and operation errors drain admitted work without unhandled rejections;
- cancellation during final publication removes the published database;
- directory aggregates, mount checks, symlink handling, allocated blocks, and skip counters remain unchanged.

The cancellation and nested-limit stress selection passed ten consecutive runs. No external disk was mounted for a controlled fixture run, so external or rotational-media validation remains pending. The default of 4 is intentionally conservative, and users are not exposed to the override.

## Environment

| Field | Value |
|---|---|
| Moirasia base commit | `b5d95d31f6832ac2050c0b15842a2148632169f5` |
| Moirasia benchmark working-tree hash | `3be693a0b45fe6bbe0fe43e0a3a6dd966aaf613d47e7acf7c7320bf9780573a3` |
| Orbis base commit | `2869d2145b58f0a0b1a7c4d8586561f54054c309` |
| Orbis benchmark working-tree hash | `054caca6b0b4e867ff24ee6ebfc4e000a1e7e52885d960b98d20fb47ee5a68c2` |
| Built worker SHA-256 | `f963ab0edbbd5a6eb995659c811e8ea25dc1a0f37abbf617338a1e60b455daee` |
| Benchmark runner SHA-256 | `767df6389bb921a7c45b79c954b0295553ed7b00f992389d7dab7d988e71a327` |
| Node | 22.22.3 |
| OS | macOS Darwin 25.4.0, arm64 |
| CPU | Apple M5 Pro, 18 logical CPUs |
| Cache label | warm |
| Samples | 1 warm-up, then 10 measured runs per fixture and setting |

## Reproduction

```sh
pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline --warmup 1 --samples 10 --fixture all \
  --concurrency 1 --output benchmark-results/stage-5-serial.json

pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline --warmup 1 --samples 10 --fixture all \
  --concurrency 4 --output benchmark-results/stage-5-bounded.json
```

## Decision

Keep scan-wide bounded metadata concurrency with a default of 4. It materially improves wide, tiny-file, and mixed scans while preserving deterministic publication and bounded work. Treat controlled external-disk measurement as an outstanding portability check rather than increasing concurrency further.
