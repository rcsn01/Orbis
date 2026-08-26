# SquirrelDisk lessons for Orbis scanning

Research date: 2026-03-10

## What SquirrelDisk actually does

SquirrelDisk does not implement its active filesystem traversal in Tauri. Its Rust command wrapper launches a bundled `pdu` sidecar with JSON output, progress reporting, and a minimum display ratio. See SquirrelDisk [`scan.rs` at a440815b](https://github.com/adileo/squirreldisk/blob/a440815b5c61bbf953a521c80df0ef126a25ab2f/src-tauri/src/scan.rs) and [`tauri.conf.json`](https://github.com/adileo/squirreldisk/blob/a440815b5c61bbf953a521c80df0ef126a25ab2f/src-tauri/tauri.conf.json).

`pdu`, or Parallel Disk Usage, supplies the important performance technique. It enumerates a directory, collects its immediate children, and sends child subtrees through Rayon's parallel iterator. Filesystem metadata comes from Rust's `symlink_metadata`, so it does not read file contents or follow symlinks. See PDU [`fs_tree_builder.rs`](https://github.com/KSXGitHub/parallel-disk-usage/blob/43c333cec59c2abbb129c1c66a8fc31dd30f33ff/src/fs_tree_builder.rs) and [`tree_builder.rs`](https://github.com/KSXGitHub/parallel-disk-usage/blob/43c333cec59c2abbb129c1c66a8fc31dd30f33ff/src/tree_builder.rs).

PDU builds the complete tree in memory. After traversal it prunes nodes below `min_ratio`, recursively sorts the retained tree, converts names to UTF-8, and serializes one complete JSON result to stdout. Its ratio therefore reduces result size and rendering work, not filesystem traversal time. See [`app/sub.rs`](https://github.com/KSXGitHub/parallel-disk-usage/blob/43c333cec59c2abbb129c1c66a8fc31dd30f33ff/src/app/sub.rs).

Progress uses atomic counters polled about every 100 ms on a separate thread. See [`progress_and_error_reporter.rs`](https://github.com/KSXGitHub/parallel-disk-usage/blob/43c333cec59c2abbb129c1c66a8fc31dd30f33ff/src/reporter/progress_and_error_reporter.rs).

SquirrelDisk's root scan excludes a hard-coded set of top-level paths. PDU itself does not detect or stop at filesystem mount boundaries, and it counts hard-linked paths independently. PDU documents both limitations in its [README](https://github.com/KSXGitHub/parallel-disk-usage/blob/43c333cec59c2abbb129c1c66a8fc31dd30f33ff/README.md).

SquirrelDisk advertises a fast scan and says its Electron-to-Tauri port targeted better performance, but it publishes no end-to-end SquirrelDisk benchmark. PDU's first-party v0.8.1 benchmark reports 114.2 ± 0.7 ms for one Linux sample, compared with 183.5 ± 0.4 ms for `du`. This excludes Tauri startup, process IPC, JSON parsing, and rendering. See the [PDU benchmark report](https://github.com/KSXGitHub/parallel-disk-usage-0.8.1-benchmarks/blob/16dd2361fb40da5a6fba9e87ade3276b26e933ab/tmp.benchmark-report.competing.blksize.md).

## What Orbis should copy

### 1. Bounded parallel subtree traversal

Orbis currently awaits each `lstat` and each directory recursion serially in `src/main/scanner.ts`. PDU's main advantage is parallel work across independent child subtrees.

Start in Node with a bounded work queue rather than an unbounded `Promise.all`. Benchmark concurrency levels such as 4, 8, 16, and 32. Keep database writes and ID assignment coordinated. Retain Orbis's stronger behavior:

- stop at device boundaries;
- count allocated blocks rather than apparent bytes;
- deduplicate hard links;
- preserve typed skipped and unreadable counts;
- support cancellation and stale-generation rejection.

Parallel traversal must use one shared hard-link identity set or merge subtree results without double-counting identities that cross subtree boundaries.

### 2. Coalesced progress

PDU reports aggregate progress on a timer rather than transporting every visited path. Orbis already throttles progress to roughly 100 ms, so there is little to copy here. With parallel traversal, move progress ownership to the queue coordinator and keep the same update rate.

### 3. A native worker only if measurements justify it

If bounded Node concurrency remains metadata-CPU-bound, move traversal into a Rust or Swift sidecar. A Rust implementation could use Rayon like PDU. A macOS-only helper could also investigate bulk metadata APIs such as `getattrlistbulk`.

Do not assume Tauri itself makes SquirrelDisk's scan fast. The active speedup comes from PDU's native parallel scanner. A sidecar adds packaging, signing, protocol, crash, and cancellation work, so it belongs after cheaper fixes.

## What Orbis should not copy

- **Full in-memory tree:** PDU duplicates the entire filesystem tree in memory before output. Orbis targets startup-volume scans, where SQLite-backed streaming has a safer memory ceiling.
- **Whole-result JSON:** SquirrelDisk sends one large JSON tree and builds another D3 hierarchy in the UI. Orbis's SQLite index, opaque IDs, 100-item queries, and capped chart are better for large results.
- **Recursive post-scan sorting:** Orbis can order only queried children by size through SQLite. Sorting every directory during traversal is unnecessary unless stable traversal IDs are a requirement.
- **Ratio pruning presented as scan acceleration:** PDU still visits every entry before pruning. Selective Orbis indexing can reduce database and rendering work, but it cannot reduce metadata traversal while exact totals are required.
- **Hard-coded mount exclusions alone:** Keep Orbis's device comparison. Path exclusions are useful for known duplicate startup trees but do not replace mount detection.
- **PDU's default size and identity semantics:** PDU defaults to apparent length and counts hard-linked paths more than once. Orbis's allocated-block accounting and hard-link deduplication better represent physical usage.

## Prioritized Orbis optimization list

### Phase 0: measure before changing behavior

1. Record stage timings for traversal, SQLite finalization, index creation, close/rename, first query, snapshot construction, and render.
2. Record files, directories, errors, database bytes, peak memory, queue depth, and metadata operations per second.
3. Benchmark cold and warm cache runs on the internal SSD, an external volume, deep trees, wide trees, many tiny files, permission failures, symlinks, and hard links.
4. Add repeatable synthetic fixtures and compare all changes against the current scanner.

### Phase 1: fix SQLite costs

1. **Keep finalization inside a transaction.** Traversal inserts currently commit before `finalizeDatabase()`. The subsequent directory `UPDATE`s and metadata inserts can each autocommit under `synchronous=FULL`. Put aggregation, metadata, and index creation in the same transaction, or use one second explicit transaction.
2. **Reuse prepared statements.** `insertNode()` prepares the same SQL for every item. Prepare insert, update, and metadata statements once per scan.
3. **Aggregate bottom-up during traversal.** Return subtree bytes and counts when each directory completes. This removes `finalizeDatabase()`'s full-table read, all-node JavaScript maps, and second recursive pass.
4. **Tune temporary-database durability.** The worker writes an unpublished, disposable `.partial.sqlite` and atomically renames it only after close. Benchmark `synchronous=NORMAL` and an in-memory journal against `FULL/DELETE`. Never expose the partial database to readers.
5. **Store less duplicated data.** Absolute paths repeat every ancestor for every node. Store the root path once plus parent and name, then reconstruct a path for the uncommon Reveal in Finder operation.
6. **Use compact internal keys.** Integer node and parent keys should make the table and parent-size index smaller than text IDs such as `n-123456`. Convert to opaque string IDs only at the IPC boundary if the contract requires strings.

### Phase 2: parallelize metadata reads

1. Add a bounded queue for child metadata and directory work.
2. Start conservatively and tune concurrency by volume. More tasks can reduce performance through SSD queue contention or external-disk seeking.
3. Bound open directory handles and pending records to avoid `EMFILE` and memory spikes.
4. Make cancellation stop queue admission, await or discard in-flight work, and prevent late writes.
5. Preserve deterministic database publication, even if internal node IDs no longer follow lexical traversal order.
6. Remove the numeric, case-insensitive `localeCompare` scan sort unless a measured product requirement depends on it. SQLite already sorts displayed children by size and name.

### Phase 3: reduce indexed detail when the product permits it

Offer an explicit fast index mode that still traverses every entry for exact totals but stores only:

- every directory;
- the largest N files per directory;
- an aggregate row for omitted files.

This cuts SQLite writes, index size, and UI query work. It also means omitted files cannot be individually revealed or listed, so full indexing must remain available and the UI must label aggregated results. A size ratio applied after a complete index, as in PDU, does not improve traversal time.

### Phase 4: improve repeat scans

Persisting the last completed index would make startup appear immediate. Incremental refresh could use directory metadata or FSEvents to revisit changed subtrees. Do this only after full-scan optimization because correctness is much harder:

- directory modification times do not describe every descendant change reliably across all filesystems;
- renamed or deleted subtrees must be reconciled;
- hard links can connect changed subtrees;
- disk capacity and free-space metadata can change independently;
- retained absolute filenames create a privacy and stale-data policy.

Make persistence explicit, document its location and retention, clean crash leftovers, and provide a clear-index action.

### Phase 5: native scanner

Build a native sidecar if profiling shows Node traversal still dominates after Phases 1 and 2. Keep SQLite publication or use a compact batched protocol rather than copying PDU's full JSON tree. Compare the sidecar end to end, including process launch, IPC, index writes, and renderer readiness.

## Recommended implementation order

1. Add stage metrics and a benchmark fixture.
2. Fix the finalization transaction and prepared statements.
3. Compute aggregates during traversal and compact the schema.
4. Add and tune bounded Node concurrency.
5. Decide whether selective indexing fits the product.
6. Prototype a native scanner only if the measured gap remains large.
7. Treat persistent or incremental indexes as a separate privacy-sensitive feature.

## Source notes

SquirrelDisk v0.3.4 release notes mention PDU 0.8.4, while the checked-in lock data at the reviewed SquirrelDisk commit resolves 0.8.3. PDU commit [`43c333c`](https://github.com/KSXGitHub/parallel-disk-usage/commit/43c333cec59c2abbb129c1c66a8fc31dd30f33ff) only changes the package version from 0.8.3 to 0.8.4, so the scanner behavior cited here is equivalent. The exact sidecar binary shipped in SquirrelDisk's release was not inspected.
