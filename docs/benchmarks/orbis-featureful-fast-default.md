# Orbis feature-rich fast scanner default

Captured 2026-08-25 on an Apple M5 Pro, Node 22.22.3, warm APFS fixtures, native metadata addon, metadata concurrency 4, and 256-entry pages.

## Decision

The optimized progressive scanner is the production default for `pnpm dev`. It retains live previews, saved paused previews, durable checkpoints and resume, persistent indexes, focus and reveal, incremental refresh, exact allocated-size accounting, deterministic hard-link ownership, mount exclusion, and symlink exclusion.

`ORBIS_LEGACY_SCAN=1` no longer selects the Stage 5 reference implementation. The compatibility command below therefore uses the same feature-rich scanner as plain development while still applying the requested concurrency:

```sh
ORBIS_LEGACY_SCAN=1 ORBIS_SCAN_CONCURRENCY=4 pnpm dev
```

The independent Stage 5 scanner remains reachable only through an explicit benchmark worker option. No production environment variable selects it. It is not a production rollback because it cannot provide the required progressive features.

## Final full-scan result

Command:

```sh
ORBIS_DISABLE_INCREMENTAL_SCAN=1 pnpm -C apps/Orbis benchmark:scan -- \
  --profile baseline --warmup 1 --samples 5 --fixture all \
  --scanner progressive --concurrency 4 --batch-size 256 \
  --native-addon native/orbis-metadata.darwin-arm64.node \
  --output benchmark-results/featureful-stage5-integrated-final.json
```

`ORBIS_DISABLE_INCREMENTAL_SCAN=1` isolates full-traversal cost; it is not the production default. The scanner still builds the same live-preview and persistent-index database. Resume, journal, and incremental behavior are covered separately by their integration tests.

| Fixture | Items | Before | Final | Change | First preview median |
|---|---:|---:|---:|---:|---:|
| Wide | 2,001 | 13,999 items/s | 30,029 items/s | 2.15× | 30.37 ms |
| Deep | 257 | 2,233 items/s | 2,513 items/s | 1.13× | 28.19 ms |
| Tiny files | 10,101 | 13,346 items/s | 33,307 items/s | 2.50× | 26.41 ms |
| Mixed | 2,021 | 13,181 items/s | 27,206 items/s | 2.06× | 27.72 ms |

The final report records 10,000 alias rows for the tiny-file fixture and all entries through native bulk metadata. The optimized path therefore did not obtain speed by dropping persistent alias data or falling back to apparent file sizes.

## Attempts

Every implementation attempted during this optimization pass is listed here, including reverted experiments.

### 1. Progressive baseline

Report: `benchmark-results/featureful-fast-baseline-progressive.json`

The baseline prepared a number of statements inside per-entry methods and ran recursive ancestor, direct-child, and observation updates once per accepted entry. Median throughput was 13,999 items/s wide and 13,346 items/s tiny.

### 2. Direct Stage 5 comparison

The first `--scanner legacy` attempt failed because the report reader unconditionally queried the progressive `file_aliases` table. The harness was corrected to report zero aliases and zero persistent-table bytes when that table is absent. A matched five-sample rerun measured 46,878 items/s wide, 55,908 items/s tiny, and zero previews, aliases, checkpoints, or incremental work. This is faster but confirms the feature and schema mismatch. The older 60,775–74,147 items/s values remain historical Stage 5 warm-fixture numbers, not feature-equivalent measurements.

Report: `benchmark-results/featureful-fast-reference-legacy.json`

### 3. Prepared statements and aggregate deltas — retained

Hot statements are prepared once. A metadata page now coalesces recursive ancestor totals, direct-child counts, and observations by parent before writing them. This raised tiny-file throughput to 25,705 items/s and mixed throughput to 24,308 items/s.

Report: `benchmark-results/featureful-fast-batched-progressive.json`

### 4. In-memory owner, focus, and estimate caches — partly retained

Task focus is read once per page and absent root-estimate deletion is skipped through the bounded estimate-name cache. A full in-memory hard-link owner cache was also tested; the isolated tiny-file result was 25,910 items/s, within the preceding run's noise. The full owner cache was removed because it would grow with every filesystem identity on a startup-volume scan. The final implementation keeps only pending owners for the current bounded page and queries SQLite for earlier owners.

Report: `benchmark-results/featureful-fast-cached-progressive-tiny.json`

### 5. JSON page writes for aliases and hard-link owners — retained

File aliases and final hard-link owners are inserted from one JSON page rather than one statement call per entry. Throughput reached 29,711 items/s wide and 28,397 items/s tiny.

Report: `benchmark-results/featureful-fast-json-batched-progressive.json`

### 6. JSON page writes for file nodes — retained

File-node writes were added to the same rollback-safe page. This reduced measured aggregation work substantially but did not improve end-to-end throughput beyond run-to-run noise: 28,684 items/s wide and 28,235 items/s tiny. It remains because it gives the page one coherent atomic write boundary and keeps hard-link replacement correct for owners discovered within the same page.

Report: `benchmark-results/featureful-fast-json-node-batched-progressive.json`

### 7. Scan-wide ordered metadata admission — retained for asynchronous fallback

The Stage 5 `OrderedConcurrentMapper` is now shared by every Node metadata cursor instead of being recreated per page. Its semaphore admits at most the configured number of `lstat` operations scan-wide, supports concurrent map consumers without exhausting a shared budget, and holds only a bounded number of completed records. Directory pages can be read concurrently and are still committed in deterministic scheduler order. Pause stops new waves, drains the admitted wave, commits it, and then checkpoints the durable frontier.

The first plain `Promise.all` version remains a rejected experiment for the synchronous native cursor: it measured 28,956 items/s wide and 28,522 items/s tiny because synchronous `getattrlistbulk` work cannot overlap on the JavaScript thread. The retained wave scheduler therefore uses source-advertised concurrency; the synchronous native source advertises one.

Reports: `benchmark-results/featureful-fast-concurrent-progressive.json`, `benchmark-results/featureful-stage5-pipelined-final.json`

### 8. SQLite `WITHOUT ROWID` construction tables — reverted

`nodes`, task, alias, owner, group, and observation tables were tested as `WITHOUT ROWID`. Tiny-file throughput fell from roughly 28,200 to 21,073 items/s and persistent table bytes increased in this schema. The schema change was removed.

Report: `benchmark-results/featureful-fast-without-rowid-tiny.json`

### 9. Native metadata worker threads — reverted

A bounded worker-thread pool was prototyped to overlap synchronous native directory pages. It preserved ordered main-thread SQLite consumption and improved one tiny-file run to 32,366 items/s, but startup and IPC costs regressed wide, deep, and mixed fixtures. A later five-sample comparison measured 33,401 items/s at concurrency four versus 34,820 items/s on the same code at concurrency one. The pool, eval worker protocol, and shutdown lifecycle were removed; the addon remains synchronous and local.

Reports: `benchmark-results/featureful-threaded-stage5-native.json`, `benchmark-results/featureful-native-single-thread-linkcount.json`

### 10. Link-count-aware hard-link decisions — retained

The native metadata page now includes exact `nlink`. Files with link count one cannot be duplicates, so construction skips both the owner lookup and owner upsert for those entries. Backends without link counts conservatively retain the old database-backed decision path, and files with multiple links still use lexical replacement in deterministic consumption order. Publication derives persistent hard-link groups by joining final file nodes to aliases, so singleton refresh identities remain present. This raised the final matched tiny-file result from 28,627 to 33,307 items/s while retaining 10,000 aliases.

### 11. Single-page task transitions and preview index — retained

Directories whose first page is complete now transition directly from queued to complete instead of writing start, advance, yield, and finish states that can never be resumed between those operations. Multi-page directories retain the durable cursor transitions. The construction-only preview index was narrowed to `nodes(parent_id)` because preview ordering already sorts the small bounded result; this avoids maintaining unused size/name keys during every aggregate update.

### 12. Publication-only alias construction — reverted

Deferring singleton alias rows and deriving them set-wise at publication was tested. It did not improve traversal materially and made construction/resume representation less direct, so singleton aliases remain durable in every committed metadata page.

### 13. Deferred alias and hard-link indexes — reverted

Construction without `file_aliases_parent`, `file_aliases_identity_path`, and `hardlink_groups_node` was tested. The indexes are retained in the schema because the construction gain was not repeatable and the lifecycle/schema complexity was not justified.

### 14. Unfenced live-journal benchmark attempt — not used as a throughput result

A default incremental benchmark was attempted against benchmark fixtures whose index directory and FSEvents activity share the measured target. One baseline run failed post-scan reconciliation; a quick diagnostic run completed but spent 5.96 seconds cycling checkpoints and journal work for 106 items. This setup measures fixture/index event feedback rather than traversal and is not used to claim production throughput. Incremental refresh, journal reconciliation, checkpoint restoration, and resume remain verified by deterministic integration tests.

## Interpretation

The retained work more than doubled feature-rich throughput on the broad fixtures and raised tiny-file throughput by 2.5×, but it did not reproduce the historical 60k–74k Stage 5 rates. Those rates came from a scanner that did not write the progressive scheduling, alias, checkpoint, preview, and persistence state. No 60k claim is made for the feature-rich path, and warm synthetic rates should not be projected onto a cold startup-volume scan.
