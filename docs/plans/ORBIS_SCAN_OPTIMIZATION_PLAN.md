# Orbis scan optimization plan

This plan turns the SquirrelDisk and PDU research into independently testable implementation stages. Complete and measure each stage before starting the next one. Do not combine stages in one change.

Supporting research: [`../research/squirreldisk-orbis-optimizations.md`](../research/squirreldisk-orbis-optimizations.md)

Resume-specific stages are tracked in [`../../ORBIS_RESUME_OPTIMIZATION_PLAN.md`](../../ORBIS_RESUME_OPTIMIZATION_PLAN.md). Stage 5 now scopes hard-link, scheduler, and aggregate recovery to affected rows; scoped mismatches abort without a recursive global rebuild. Focused lifecycle coverage, fresh-scan parity, schema-8 diagnostics, and matched recovery measurements have passed. The plan's <=25% whole-load receipt timing gate remains open.

The schema, native transport, checkpoint, and incremental-refresh proposals below are historical. The scan pipeline redesign supersedes those unchecked items. See [`../benchmarks/orbis-scan-pipeline-redesign.md`](../benchmarks/orbis-scan-pipeline-redesign.md) and [`../architecture/orbis-progressive-scanning.md`](../architecture/orbis-progressive-scanning.md) for the retained design.

## Goals

- Reduce full-scan time without changing reported allocated sizes.
- Keep memory bounded on startup-volume scans.
- Keep the UI responsive and preserve cancellation.
- Continue skipping symlinks, nested mounts, unreadable entries, and duplicate hard links.
- Keep partial indexes private to the worker until atomic publication.
- Preserve the previous completed index during rescans and cancellation.

## Non-goals for the initial stages

- Do not copy SquirrelDisk's full in-memory tree or whole-result JSON transfer.
- Do not replace allocated-block accounting with apparent file length.
- Do not weaken mount detection or hard-link deduplication.
- Do not persist indexes across normal application shutdown yet.
- Do not introduce a native helper until measurements show Node traversal is still the bottleneck.

## Rules for every stage

1. Capture baseline and post-change measurements with the same fixture and machine state.
2. Keep each stage separately reviewable and reversible.
3. Run the focused Orbis tests before the full verification commands.
4. Do not accept speed improvements that change scan totals or leave partial databases behind.
5. Record results in the measurement table at the end of this document.

---

## Stage 0: build the benchmark and timing baseline

### Purpose

Determine whether traversal, SQLite writes, finalization, or main-process snapshot construction dominates on representative scans. Browser rendering requires a separate Electron measurement.

### Implementation

- [x] Add named timing boundaries for:
  - worker startup;
  - database creation;
  - filesystem traversal and node insertion;
  - directory aggregation;
  - SQLite index creation and metadata writing;
  - database close and atomic rename;
  - controller publication and first snapshot;
  - first chart and largest-items queries.
- [x] Record item, file, directory, skipped, and unreadable counts.
- [x] Record output database size and sampled process memory.
- [x] Keep user-facing progress snapshots compatible. Diagnostics use internal channels and a separate opt-in worker message.
- [x] Add deterministic fixture generators for:
  - a wide tree with many sibling files;
  - a deep directory tree;
  - many tiny files;
  - mixed large and small files;
  - symlinks and duplicate hard links;
  - simulated unreadable and disappearing entries.
- [x] Add a repeatable benchmark command that refuses live targets unless explicitly allowed.
- [ ] Run at least one manual cold-cache and warm-cache startup-volume comparison. Do not automate cache flushing in normal tests.

### Likely files

- `src/main/scanner.ts`
- `src/main/database.ts`
- `src/main/controller.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`
- A new benchmark script under `apps/integrated/Orbis/scripts/` or `scripts/`

### Verification

```sh
pnpm -C apps/integrated/Orbis test -- scanner.test.ts
pnpm -C apps/integrated/Orbis typecheck
```

### Exit criteria

- [x] The benchmark produces stage timings and throughput in items per second.
- [x] Five-sample fixture runs have a median absolute deviation below 7.1 percent; rerun noisy fixtures when a change is near that spread.
- [x] Baseline measurements are recorded here and in `../benchmarks/orbis-stage-0-baseline.md`.
- [x] Production scan results, snapshots, IPC, and progress contracts are unchanged.

---

## Stage 1: remove SQLite autocommit and prepare overhead

Results: [`../benchmarks/orbis-stage-1-transaction.md`](../benchmarks/orbis-stage-1-transaction.md)

### Purpose

Fix the most obvious avoidable database cost before changing traversal behavior.

### Implementation

- [x] Keep aggregation updates, metadata inserts, and index creation inside an explicit transaction.
- [x] Use one transaction covering construction of the unpublished partial database.
- [x] Prepare the node insertion statement once per scan instead of once per node.
- [x] Prepare and reuse unreadable-marker, directory-update, and metadata statements.
- [x] Release prepared statements by closing their owning `DatabaseSync`; Node 22 `StatementSync` has no explicit finalizer.
- [x] Preserve rollback and cleanup behavior for cancellation and errors.
- [x] Keep the `.partial.sqlite` to `.sqlite` rename after commit and database close.
- [x] Test that a canceled scan leaves neither partial nor published files.
- [x] Test that a failed replacement database cannot replace the active completed index.

### Likely files

- `src/main/database.ts`
- `src/main/scanner.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`
- `apps/integrated/Orbis/tests/controller.test.ts`

### Verification

```sh
pnpm -C apps/integrated/Orbis test -- scanner.test.ts controller.test.ts
pnpm -C apps/integrated/Orbis verify
pnpm test -- orbis-feature.test.ts
```

### Exit criteria

- [x] SQL writes during a scan use an explicit transaction and reused statements.
- [x] Scan totals and database query results match the Stage 0 baseline fixture.
- [x] Cancellation, failure cleanup, and atomic publication tests pass.
- [x] Finalization time is recorded; aggregation improved by 41.8-97.8% across fixtures.

---

## Stage 2: aggregate directory totals during traversal

Results: [`../benchmarks/orbis-stage-2-bottom-up.md`](../benchmarks/orbis-stage-2-bottom-up.md)

### Purpose

Remove the full-table JavaScript reconstruction and second recursive aggregation pass.

### Implementation

- [x] Make each directory traversal return its aggregate result:
  - allocated bytes;
  - direct child count;
  - descendant count;
  - unreadable count.
- [x] Update a directory row when its subtree finishes.
- [x] Include the directory's own allocated blocks in its total, matching current behavior.
- [x] Preserve unreadable-directory accounting.
- [x] Remove the all-row `SELECT`, node map, child map, and recursive finalization walk once equivalence tests pass.
- [x] Create the `nodes_parent_size` index only after node and directory writes finish.
- [x] Ensure deep trees do not add a new synchronous recursion limit; test a synthetic 1,500-level tree.
- [x] Compare root size and every fixture directory's size, descendant count, and unreadable count with an independent oracle.

### Likely files

- `src/main/scanner.ts`
- `src/main/database.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`

### Verification

```sh
pnpm -C apps/integrated/Orbis test -- scanner.test.ts
pnpm -C apps/integrated/Orbis verify
```

### Exit criteria

- [x] Finalization no longer loads every node into a JavaScript map.
- [x] Fixture results are identical to Stage 1.
- [x] Sampled memory and directory-update time are recorded; the fixture RSS sampler is too coarse for a general memory claim.
- [x] Cancellation still rolls back completed subtree updates and removes the partial database.

---

## Stage 3: compact the scan database

### Purpose

Reduce bytes written per item and shrink the parent-size index before adding concurrency.

### Part A: remove repeated absolute paths

- [ ] Store the scan target once in metadata.
- [ ] Store each node's parent and basename, not its complete absolute path.
- [ ] Reconstruct a node path by walking its ancestors when Reveal in Finder is used.
- [ ] Validate reconstructed paths remain inside the scan target.
- [ ] Keep paths out of renderer snapshots.
- [ ] Test root, nested, Unicode, and unusual filename reconstruction.

### Part B: compact internal IDs

- [ ] Replace text database keys such as `n-123` with SQLite integer keys.
- [ ] Keep the renderer contract opaque. Convert IDs at the main-process boundary if string IDs remain useful there.
- [ ] Update parent queries, breadcrumbs, focus, reveal, and chart lookups.
- [ ] Confirm stale or malformed renderer IDs cannot select arbitrary rows.

### Likely files

- `src/main/database.ts`
- `src/main/index-store.ts`
- `src/main/controller.ts`
- `src/shared/contracts.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`
- `apps/integrated/Orbis/tests/controller.test.ts`
- `apps/integrated/Orbis/tests/ipc.test.ts`

### Verification

```sh
pnpm -C apps/integrated/Orbis test
pnpm -C apps/integrated/Orbis verify
pnpm test -- orbis-feature.test.ts
```

### Exit criteria

- [ ] Reveal in Finder resolves the same path as before for every fixture node.
- [ ] Renderer snapshots still contain opaque IDs and no filesystem paths.
- [ ] Database size per indexed item is recorded and lower than Stage 2.
- [ ] Chart, breadcrumbs, largest-items, focus, and reveal tests pass.

---

## Stage 4: remove unnecessary traversal sorting

### Purpose

Avoid the numeric, case-insensitive locale sort performed in every directory.

### Implementation

- [ ] Confirm no product behavior depends on lexical traversal order or stable generated IDs.
- [ ] Add tests that define the actual required ordering at query and renderer boundaries.
- [ ] Remove scan-time sorting and use directory enumeration order, or replace it with a cheaper comparison if deterministic traversal remains required.
- [ ] Keep displayed children ordered by size and name through SQLite.
- [ ] Measure separately on wide directories, where sort cost is easiest to see.

### Likely files

- `src/main/scanner.ts`
- `src/main/index-store.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`

### Verification

```sh
pnpm -C apps/integrated/Orbis test -- scanner.test.ts renderer.test.tsx
pnpm -C apps/integrated/Orbis typecheck
```

### Exit criteria

- [ ] User-visible ordering remains deterministic where required.
- [ ] Internal traversal no longer performs an expensive locale sort without a product reason.
- [ ] Wide-tree benchmark results are recorded.

---

## Stage 5: add bounded parallel metadata traversal

Results: [`../benchmarks/orbis-stage-5-bounded-metadata.md`](../benchmarks/orbis-stage-5-bounded-metadata.md)

### Purpose

Apply PDU's strongest technique without copying its full in-memory result model.

### Design constraints

- One coordinator owns cancellation, counters, IDs, and database writes.
- Filesystem metadata reads and directory enumeration may run concurrently.
- The number of active and queued tasks must remain bounded.
- Hard-link identity is global across the scan.
- Only the root device is accepted.
- A late task from a canceled generation cannot write or publish data.

### Implementation

- [x] Introduce one scan-wide bounded mapper for metadata operations.
- [x] Keep configurable concurrency behind an internal option and environment variable.
- [x] Benchmark concurrency values 1, 4, 8, 16, and 32.
- [x] Separate concurrent metadata collection from serialized database writes.
- [x] Keep a shared hard-link identity set with serialized check-and-add semantics at the coordinator.
- [x] Stop admission immediately on cancellation.
- [x] Drain in-flight results before database cleanup.
- [x] Bound active operations and completed-result records across nested directories.
- [x] Preserve nested-mount, symlink, special-file, unreadable, and disappearing-item counts.
- [x] Add race-focused tests for cancellation, rescan replacement, worker exit, stale completion, and final publication.
- [x] Test hard links placed in different top-level subtrees.

### Likely files

- `src/main/scanner.ts`
- A new queue helper under `src/main/`
- `src/main/scan-worker.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`
- `apps/integrated/Orbis/tests/controller.test.ts`

### Verification

```sh
pnpm -C apps/integrated/Orbis test
pnpm -C apps/integrated/Orbis verify
pnpm test -- orbis-feature.test.ts
pnpm -C apps/integrated/Orbis test:smoke
```

### Exit criteria

- [x] Concurrency is scan-wide bounded and has a measured default of 4.
- [ ] The default beats concurrency 1 on the internal SSD; controlled external-disk validation remains pending because no external test volume was mounted.
- [x] Results match concurrency 1 for all correctness fixtures.
- [x] Cancellation and stale-generation tests pass under repeated runs.
- [x] No unbounded operation or result queue, `EMFILE`, or material fixture-memory regression appears in stress tests.

---

## Stage 6: tune temporary SQLite durability

### Purpose

Reduce journal and sync work for an unpublished, regenerable index without weakening atomic publication.

### Implementation

- [ ] Benchmark the current `journal_mode=DELETE; synchronous=FULL` configuration.
- [ ] Benchmark `synchronous=NORMAL`.
- [ ] Benchmark an in-memory journal for the partial database.
- [ ] Do not use a mode that allows readers to see an incomplete database.
- [ ] Simulate worker termination during traversal, finalization, close, and publication.
- [ ] Confirm startup or the next scan removes corrupt partial files.
- [ ] Add cleanup for stale generation files left by crashes, limited strictly to the owned indexes directory.
- [ ] Document that deletion is ordinary filesystem deletion, not secure erasure.

### Likely files

- `src/main/database.ts`
- `src/main/controller.ts`
- `apps/integrated/Orbis/tests/scanner.test.ts`
- `apps/integrated/Orbis/tests/controller.test.ts`
- `apps/integrated/Orbis/README.md`

### Verification

```sh
pnpm -C apps/integrated/Orbis test -- scanner.test.ts controller.test.ts
pnpm -C apps/integrated/Orbis verify
```

### Exit criteria

- [ ] The selected pragmas have benchmark evidence.
- [ ] A crash can leave only an owned partial or stale index, which later cleanup removes.
- [ ] A completed index is never opened before commit, close, and rename.
- [ ] Cleanup cannot remove files outside the Orbis indexes directory.

---

## Stage 7: decide on selective indexing

### Purpose

Reduce storage and query costs when users care about large items more than every small file.

This is a product decision. Do not implement it automatically as a hidden optimization.

### Proposed fast mode

- Store every directory.
- Calculate exact totals from every visited file.
- Store only the largest N files per directory.
- Store omitted file count and bytes as an aggregate row.
- Keep the existing complete index as a full mode.

### Implementation checklist

- [ ] Prototype database size and scan-time savings with several N values.
- [ ] Define how aggregated files appear in the sunburst and largest-items list.
- [ ] Prevent Reveal in Finder on aggregate rows.
- [ ] Label incomplete file listings clearly.
- [ ] Keep skipped or unreadable data separate from intentionally aggregated data.
- [ ] Decide whether users select fast or full mode before scanning.
- [ ] Add mode and aggregation fields to the shared snapshot contract only after the product decision.

### Exit criteria

- [ ] A written product decision records whether fast mode is worth the loss of per-file drilldown.
- [ ] If implemented, exact directory totals match full mode.
- [ ] The UI distinguishes indexed, aggregated, and unreadable space.
- [ ] Database and scan-time savings justify the extra product complexity.

---

## Stage 8: evaluate a native scanner (superseded)

### Purpose

Determine whether a Rust or Swift scanner is justified after the Node implementation has been optimized.

### Entry requirement

Do not start this stage unless Stage 5 measurements show filesystem traversal still dominates and misses the agreed performance target.

The redesign kept the TypeScript coordinator and added a narrow native metadata transport rather than a second scanner. Packed `ORB1` pages and descriptor-relative traversal now cover the measured N-API and path-opening costs. The full-scanner prototype checklist no longer applies.

### Superseded prototype

- [ ] Define a small versioned protocol for start, progress, cancellation, error, and completion.
- [ ] Compare a Rust Rayon implementation with the optimized Node scanner.
- [ ] For a macOS-specific helper, investigate bulk metadata APIs such as `getattrlistbulk`.
- [ ] Preserve allocated-block accounting, device boundaries, hard-link deduplication, and typed errors.
- [ ] Stream compact batches or write the SQLite partial index directly. Do not emit one full JSON tree.
- [ ] Include helper launch, IPC, database publication, and renderer readiness in benchmarks.
- [ ] Evaluate packaging, code signing, crash reporting, and architecture support before adoption.

### Exit criteria

- [ ] The prototype has an end-to-end comparison against Stage 5, not only traversal microbenchmarks.
- [ ] The speedup is large enough to justify a native binary and protocol.
- [ ] Cancellation, errors, and publication are at least as safe as the Node implementation.
- [ ] If the benefit is insufficient, record the result and stop without integrating the helper.

---

## Stage 9: evaluate persistent and incremental indexes

### Purpose

Improve perceived startup and repeat-scan speed after full scans are already efficient.

This stage changes Orbis's current privacy and retention behavior. Treat it as a separate feature.

### Product decisions required first

- [ ] Decide whether persistence is opt-in or default.
- [ ] Set a retention period.
- [ ] Define when an index is considered stale.
- [ ] Define how the UI displays index age and refresh status.
- [ ] Provide a Clear Index action.

### Technical work

- [ ] Load the last completed index immediately, then refresh in the background.
- [ ] Investigate FSEvents for changed-subtree detection.
- [ ] Define reconciliation for renames, deletes, mount changes, hard links, and permission changes.
- [ ] Refresh volume capacity and free-space metadata independently.
- [ ] Fall back to a full scan whenever incremental correctness is uncertain.
- [ ] Clean stale and crash-leftover databases on startup.
- [ ] Document that the retained database contains filenames and directory structure.

### Exit criteria

- [ ] Users can see when the displayed index was captured.
- [ ] Users can delete retained scan data.
- [ ] Incremental and full scans converge on the same fixture results.
- [ ] Privacy and retention behavior is documented in the UI and README.

---

## Final verification after each implementation stage

Use the narrow commands during development, then run the complete checks before considering a stage finished:

```sh
pnpm -C apps/integrated/Orbis verify
pnpm typecheck
pnpm test
```

Run the standalone smoke test for worker, IPC, renderer, or publication changes:

```sh
pnpm -C apps/integrated/Orbis test:smoke
```

## Measurement log

Fill in one row after each stage using the same primary fixture. Add separate tables for materially different disks or fixtures.

| Stage | Fixture | Cache | Items | Scan ms | Traverse ms | Aggregate ms | Controller publish ms | DB MiB | RSS increase MiB | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| 0 baseline | wide | warm | 2,001 | 75.92 | 67.35 | 4.10 | 0.89 | 0.42 | 10.58 | 5 instrumented runs; highest variance |
| 0 baseline | deep | warm | 257 | 55.75 | 22.81 | 28.46 | 0.57 | 0.16 | 10.36 | Directory-heavy aggregation |
| 0 baseline | tiny | warm | 10,101 | 281.57 | 238.11 | 34.15 | 1.64 | 2.14 | 23.59 | Many one-byte files |
| 0 baseline | mixed | warm | 2,021 | 65.22 | 53.96 | 7.52 | 1.30 | 0.46 | 10.30 | 62.98 MiB file data |
| 0 baseline | semantics | warm | 7 | 5.56 | 1.52 | 0.80 | 0.41 | 0.03 | 0.00 | Too short for the 20 ms RSS sampler |
| 0 baseline | startup volume | cold-manual | | | | | | | | Pending a restart and prepared manual run |
| 1 SQLite transaction | wide | warm | 2,001 | 44.90 | 39.18 | 2.39 | 0.64 | 0.42 | 10.41 | 40.8% lower scan median |
| 1 SQLite transaction | deep | warm | 257 | 19.83 | 16.66 | 0.64 | 0.49 | 0.16 | 10.02 | Aggregation down 97.8% |
| 1 SQLite transaction | tiny | warm | 10,101 | 190.53 | 172.29 | 12.70 | 1.54 | 2.14 | 16.11 | 32.3% lower scan median |
| 1 SQLite transaction | mixed | warm | 2,021 | 47.98 | 41.68 | 2.89 | 1.25 | 0.46 | 12.00 | 26.4% lower scan median |
| 1 SQLite transaction | semantics | warm | 7 | 3.54 | 1.22 | 0.14 | 0.44 | 0.03 | 0.00 | Correctness counters unchanged |
| 2 bottom-up totals | wide | warm | 2,001 | 44.59 | 41.17 | 0.02 | 0.65 | 0.42 | 10.31 | 10 runs; aggregation is nested update time |
| 2 bottom-up totals | deep | warm | 257 | 20.50 | 17.76 | 0.25 | 0.51 | 0.16 | 3.71 | Stage 1 difference is inconclusive |
| 2 bottom-up totals | tiny | warm | 10,101 | 196.51 | 190.52 | 0.37 | 1.53 | 2.14 | 15.20 | Stage 1 difference is inconclusive |
| 2 bottom-up totals | mixed | warm | 2,021 | 50.54 | 46.88 | 0.10 | 1.44 | 0.46 | 10.33 | Stage 1 difference is inconclusive |
| 2 bottom-up totals | semantics | warm | 7 | 3.88 | 1.38 | 0.02 | 0.53 | 0.03 | 0.00 | Too short for a latency conclusion |
| 3 compact schema | | cold | | | | | | | | |
| 4 no scan sort | | cold | | | | | | | | |
| 5 bounded concurrency | wide | warm | 2,001 | 32.92 | 29.70 | 0.02 | 0.57 | 0.42 | 12.22 | 26.9% faster than concurrency 1 |
| 5 bounded concurrency | deep | warm | 257 | 20.66 | 18.11 | 0.18 | 0.48 | 0.16 | 10.08 | One-child levels do not benefit materially |
| 5 bounded concurrency | tiny | warm | 10,101 | 136.23 | 130.95 | 0.30 | 1.41 | 2.14 | 15.48 | 27.4% faster than concurrency 1 |
| 5 bounded concurrency | mixed | warm | 2,021 | 35.68 | 32.44 | 0.13 | 1.24 | 0.46 | 10.70 | 24.0% faster than concurrency 1 |
| 5 bounded concurrency | semantics | warm | 7 | 3.62 | 1.42 | 0.02 | 0.44 | 0.03 | 0.00 | Correctness counters unchanged |
| 6 SQLite durability | | cold | | | | | | | | |

## Decision log

Record decisions that affect later stages.

| Date | Stage | Decision | Evidence | Consequences |
|---|---:|---|---|---|
| 2026-08-24 | 0 | Keep diagnostics internal and opt-in | Production result and snapshot contracts do not need benchmark data | Worker sends a separate diagnostics message only when enabled |
| 2026-08-24 | 0 | Proceed with transaction and statement reuse before concurrency | Traversal used 82-88% on wide, tiny, and mixed fixtures; aggregation used 52.5% on the deep fixture | Stage 1 can address both measured costs without changing traversal behavior |
| 2026-08-24 | 1 | Keep one construction transaction and reusable writer statements | Scan medians fell 26.4-64.4%; deep aggregation fell 97.8%; database sizes and scan totals were unchanged | Proceed to bottom-up aggregation as a separate Stage 2 change |
| 2026-08-24 | 2 | Keep bottom-up aggregation for bounded memory | Ten-sample latency differences were within observed spread; all-row reconstruction was removed and fixture results remained identical | Scan memory no longer needs a second full copy of database rows and edges; proceed to Stage 3 separately |
| 2026-08-24 | 5 | Use scan-wide metadata concurrency 4 | Against concurrency 1, scan medians improved 26.9% wide, 27.4% tiny, and 24.0% mixed; 8-32 gave no consistent additional benefit | Preserve ordered serialized writes; validate the conservative default on external media when available |
