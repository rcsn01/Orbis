# Orbis persistent FSEvents incremental scanning plan

## Recommended design

Use a persistent immutable index with bounded FSEvents history replay on startup and rescan.

Do not add a long-lived native watcher yet. A one-shot history reader fits the current worker model, avoids N-API callback lifetime problems, and still catches changes made while Orbis was closed. Live monitoring can use the same journal interface later.

FSEvents only identifies dirty paths. Orbis still obtains every byte count by exact filesystem traversal.

## Core invariants

1. The active SQLite file is never modified.
2. Incremental work clones the active index into a private candidate.
3. The FSEvents cursor never advances beyond the published index.
4. Candidate failure or cancellation leaves the active index and cursor unchanged.
5. Missing or ambiguous history triggers a full progressive scan.
6. `ORBIS_LEGACY_SCAN=1` bypasses persistence and FSEvents entirely.
7. Previous exact sizes and the folder estimate cache remain display-only. They never enter refreshed exact totals or suppress required traversal.
8. Allocated bytes remain `blocks * 512`, with one counted allocation per device/inode hard-link group.
9. Construction databases and event paths remain private to the worker and main process. Renderer snapshots remain path-free.

## Refresh lifecycle

### Startup

Add an idempotent `controller.initialize()`:

1. Create the index directory with mode `0700`.
2. Read `current.json`.
3. Validate its filename, target, index format, revision, target identity, and SQLite structure.
4. Open the referenced index read-only.
5. Remove recognized orphan candidates and partial files.
6. Restore the persisted target unless `ORBIS_SCAN_ROOT` or `initialTarget` explicitly overrides it.
7. Do not start a worker in suite mode.

A missing or corrupt manifest causes a full scan on the next `startScan()`. Never guess that the newest orphan is authoritative.

If the target is temporarily disconnected, retain the last index and report the refresh failure. Do not delete or replace the stored index. When the path returns, validate its target identity and FSEvents UUID before replay.

### Existing compatible index

The worker receives the active publication ID, index path, target, and stored journal cursor.

1. Call the native history reader from the stored cursor.
2. If no relevant events occurred, return `unchanged`.
3. Otherwise clone the immutable database using `COPYFILE_FICLONE`, with ordinary copying as fallback.
4. Reconcile dirty directories in the clone.
5. Commit, close, fsync, and validate the candidate.
6. Return its new cursor and base publication ID.

Changes occurring during reconciliation receive IDs beyond the captured fence and remain pending for the next refresh. This preserves the cursor invariant even though FSEvents cannot provide a transactional filesystem snapshot.

### Initial or fallback full scan

1. Capture a volume UUID and event baseline immediately before traversal.
2. Run the current exact progressive scan into a persistent-format candidate.
3. Read events from that baseline through a fixed post-scan fence.
4. Reconcile those dirty paths into the candidate.
5. Publish the candidate with the applied fence.

If FSEvents is unavailable, publish the full exact index without a cursor. The next rescan remains full.

### Publication

Use versioned files:

```text
indexes/
  current.json
  index-<uuid>.sqlite
  index-<uuid>.partial.sqlite
  folder-estimates.json
```

`current.json` contains the active filename, publication ID, target identity, schema revision, FSEvents database UUID, and decimal-string event ID.

Publication order:

1. Close and fsync the candidate.
2. Rename the partial file to an immutable candidate.
3. Open and validate it with `DiskIndex`.
4. Write and fsync `current.json.tmp` with mode `0600`.
5. Rename it over `current.json`.
6. Fsync the index directory.
7. Swap the controller's active `DiskIndex`.
8. Close and delete the previous index and its sidecars.

For a clean FSEvents batch, atomically update only the manifest cursor while retaining the same index file.

The manifest rename is the crash-recovery commit point. A crash before it leaves the old manifest authoritative. A crash after it makes the new validated index authoritative. Startup cleanup removes only candidates not referenced by the manifest.

### Shutdown

`close()` should stop workers, await publication tasks, close `DiskIndex`, and delete only partial or orphan files. It must preserve `current.json`, the active index, and the estimate cache.

## Native FSEvents interface

Extend `native/src/lib.rs` with synchronous, bounded calls intended for the scan worker:

```ts
captureVolumeCheckpoint(target): {
  device: string
  journalUuid: string | null
  eventId: string
}

readChanges(target, expectedUuid, sinceId, maxEvents, timeoutMs): {
  throughEventId: string
  events: Array<{ relativePath: string; eventId: string; flags: number }>
  requiresFullScan: boolean
  reason?: string
}
```

Implementation details:

- Use `FSEventStreamCreateRelativeToDevice`.
- Request `FileEvents`, `WatchRoot`, and `FullHistory`.
- Capture the upper event fence before starting replay.
- Wait for `HistoryDone`.
- Ignore overlap at or below the stored cursor.
- Return IDs as decimal strings, never JavaScript numbers.
- Run the synchronous call only inside the worker.
- Bound it by time and event count.
- Link CoreServices and CoreFoundation through `build.rs`.
- Non-macOS builds return an unavailable error.

Full-scan conditions include:

- Missing or changed FSEvents UUID
- `UserDropped` or `KernelDropped`
- Wrapped event IDs
- `RootChanged`
- Mount or unmount events
- Replay timeout or event limit
- Malformed paths
- Target device/inode replacement
- Unmatched rename events
- Candidate validation failure

`MustScanSubDirs` without a dropped-event flag causes recursive reconciliation of that subtree.

`ORBIS_DISABLE_BULK_METADATA=1` must not disable FSEvents. Split native-addon loading from bulk-metadata selection in `scan-metadata.ts`.

## Persistent schema

The current published schema is insufficient because it discards duplicate hard-link paths.

Retain `nodes`, then add:

### `file_aliases`

- Parent node ID
- Name and relative path key
- Device and inode
- Allocated bytes

### `hardlink_groups`

- Device and inode
- Current lexical owner
- Visible node ID
- Allocated bytes

### `directory_observations`

- Direct skipped count
- Direct unreadable count
- Direct disappearing count
- Direct symlink count
- Direct nested-mount count
- Enumeration status

### Persistent metadata

- Schema and accounting versions
- Canonical target and target device/inode
- Index-directory identity
- Exclusion-policy version
- Hard-link ordering version
- Index revision
- Capture and refresh timestamps

Every accepted regular-file path enters `file_aliases`, including hidden duplicate aliases. Exactly one visible node represents each hard-link group.

When an alias disappears, recompute the lexical owner from all remaining aliases. This handles an owner deletion even when the replacement lies outside the dirty subtree.

Freeze and version the hard-link path comparator. A comparator or accounting-policy change invalidates incremental reuse and triggers a full rebuild.

## Dirty-directory reconciliation

For each event:

- File changes re-enumerate the parent directory.
- Directory changes re-enumerate the directory and its parent.
- Create, remove, and rename events re-enumerate the affected parent.
- New or replaced directories are scanned recursively.
- `MustScanSubDirs` scans the reported subtree recursively.
- Descendant scopes are folded into an already-recursive ancestor.
- Unmatched rename ambiguity triggers a full scan.

Within one SQLite transaction:

1. Record the old affected subtrees and aliases.
2. Enumerate using the existing native bulk source with Node fallback.
3. Apply the same containment, symlink, mount, startup-exclusion, and index-directory rules as a full scan.
4. Insert, replace, or remove nodes and aliases.
5. Reassign affected hard-link owners.
6. Recompute changed directories and all ancestors bottom-up.
7. Rebuild global totals from persisted local observations.
8. Validate aggregate equations and hard-link ownership.
9. Commit or roll back completely.

The aggregate equations remain:

```text
size_bytes = own_bytes + SUM(child.size_bytes)
direct_children = COUNT(children)
descendant_count = SUM(1 + child.descendant_count)
unreadable_count = own_unreadable + SUM(child.unreadable_count)
```

The previous published index remains visible throughout this work. Incremental refreshes do not emit provisional candidate geometry. If an incremental attempt falls back to a full scan, the existing estimate cache may provide pinned provisional geometry exactly as it does today.

Unreadable directory handling should match a fresh full scan. Remove stale descendants, retain the directory's own allocated bytes, mark it unreadable, and publish partial accuracy. Unexpected I/O or reconciliation ambiguity aborts the candidate and triggers a full scan.

## Worker and controller protocol

Extend the worker start request with:

- Refresh mode
- Base publication ID
- Active index path and revision
- Candidate and partial paths
- Journal cursor
- Existing full-scan estimate

The worker-facing entry point should hide strategy selection:

```ts
refreshIndex(request): Promise<
  | { kind: 'unchanged'; cursor: JournalCursor }
  | {
      kind: 'candidate'
      strategy: 'incremental' | 'full'
      path: string
      cursor: JournalCursor | null
      basePublicationId: string | null
    }
>
```

Keep generation and request-ID checks. The controller also verifies that `basePublicationId` still matches the active manifest before publication. A stale result may delete only its candidate, never the active index.

`startScan()` and `rescan()` both invoke the refresh engine. Choosing a different target always starts a full scan unless its active manifest already identifies the same canonical directory.

No always-on polling or native callback stream is part of the first implementation. Standalone startup performs catch-up automatically through its existing `startScan()` call. Suite mode remains on-demand. A later live monitor can implement the same `ChangeJournal` interface without changing database or publication rules.

## File-level work

### Phase 1: persistent full indexes

Modify:

- `src/main/controller.ts`
- `src/main/index-store.ts`
- `src/main/database.ts`
- `src/main/progressive-database.ts`
- `src/main/progressive-scanner.ts`
- `src/main/feature.ts`

Add `src/main/index-manifest.ts` for loading, atomic publication, recovery, permissions, and orphan cleanup.

At this stage rescans may remain full. This gives persistence and crash recovery a testable foundation before FSEvents affects scan selection.

### Phase 2: bounded FSEvents replay

Modify:

- `native/src/lib.rs`
- `native/build.rs`
- `native/Cargo.toml`
- `src/main/scan-metadata.ts`
- `src/main/scan-worker.ts`

Add `src/main/change-journal.ts` with a small interface that supports a fake journal in tests.

Keep the existing worker and native resource paths. No new executable or packaged worker is required.

### Phase 3: incremental reconciliation

Add:

- `src/main/persistent-index-database.ts`
- `src/main/incremental-scanner.ts`
- `src/main/refresh-engine.ts`

Refactor shared traversal and entry-classification logic out of `progressive-scanner.ts` so full and incremental scans cannot drift on allocated-byte accounting, exclusions, mounts, symlinks, unreadable entries, or metadata fallback.

### Phase 4: controller integration and rollout

Complete controller startup loading, strategy dispatch, unchanged-cursor publication, candidate publication, focus restoration, persistent cleanup, and restart behavior.

Add `ORBIS_DISABLE_INCREMENTAL_SCAN=1` as a rollout fallback to persistent full scans. Preserve `ORBIS_LEGACY_SCAN=1` unchanged as the independent legacy path.

Update:

- `../architecture/orbis-progressive-scanning.md`
- `README.md`
- `scripts/benchmark-scan.ts`
- Native API and packaged-artifact checks

The standalone and suite Electron builder files already package the scan worker and native addon. Verify those paths rather than introducing another resource.

## Validation and fallback matrix

| Condition | Action |
| --- | --- |
| No active persistent index | Full progressive scan |
| Persistent format or policy mismatch | Full progressive scan |
| Native addon or FSEvents UUID unavailable | Full progressive scan without cursor |
| Valid cursor and no relevant events | Advance manifest cursor, keep index file |
| Valid bounded event batch | Incremental candidate |
| Dropped, wrapped, expired, root, mount, or malformed history | Full progressive scan |
| Unmatched rename or identity ambiguity | Full progressive scan |
| Target missing or disconnected | Keep old index, report refresh failure |
| Incremental cancellation or validation failure | Delete candidate, keep old index and cursor |
| Full-scan failure | Keep old index and cursor |
| Stale worker completion | Delete only that worker's candidate |
| `ORBIS_DISABLE_INCREMENTAL_SCAN=1` | Persistent full progressive scan |
| `ORBIS_LEGACY_SCAN=1` | Existing temporary legacy full scan |

## Verification

### Manifest and controller tests

- Restart loads a valid index without an initial full traversal.
- Explicit `ORBIS_SCAN_ROOT` rejects a manifest for another target.
- Corrupt or unsafe manifests trigger a full scan.
- Crashes before and after manifest replacement recover the correct publication.
- Normal shutdown preserves the active index and estimate cache.
- Orphan cleanup never deletes unrelated files.
- A stale worker cannot delete or replace the active database.
- The previous index remains visible during refresh, cancellation, and failure.
- Focus survives when its node ID remains and resets to a surviving ancestor or root when it does not.
- Suite registration creates no automatic scan worker.
- Standalone startup loads and refreshes the persisted target.

### Incremental equivalence tests

Compare each incremental result with a fresh full scan after normalizing opaque IDs:

- File create, delete, allocation change, and rename
- Directory create, delete, rename, and cross-parent move
- Directory trees moved while focused
- Hard-link owner deletion and promotion outside the dirty subtree
- Lexically earlier alias insertion
- Non-owner and last-alias deletion
- Allocation change through a non-owner alias
- Symlink creation and replacement
- Nested mount insertion and removal
- Unreadable and disappearing paths
- Startup exclusions and index-directory exclusion
- Cancellation during enumeration and before commit
- Revision and base-publication mismatch

Assert byte conservation, aggregate equations, totals, and cursor rollback in every failure case.

### Native tests

- Decimal parsing and formatting for the full unsigned 64-bit event-ID range
- FSEvents UUID capture
- History overlap filtering
- `HistoryDone` completion
- `MustScanSubDirs`, dropped, wrapped, root, mount, and unmount classification
- Timeout and event-limit fallback
- Temporary-directory create, modify, rename, and delete integration test on macOS
- Non-macOS unavailable behavior

### Build and packaging checks

- Root and standalone unit tests
- Root and standalone typechecks
- Rust native tests
- Root and standalone app builds
- Native API source and staged-artifact checks
- Suite and standalone packaged resource resolution
- `git diff --check` in both repositories
- Production-source and built-artifact checks for forbidden Spotlight references

### Benchmarks

Add matched samples for:

- Initial full scan
- Warm rescan with no changes
- One-file allocation change
- Directory rename
- Hard-link owner change
- Dropped-history full fallback

Record journal replay, candidate clone, incremental traversal, aggregate repair, validation, publication time, index size, and alias-table overhead separately.

## Delivery estimate

The reliable implementation remains approximately 16 to 30 active hours across four substantial phases. Each phase should leave the full-scan fallback working and independently tested before the next phase begins.
