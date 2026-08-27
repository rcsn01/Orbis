# Orbis resume optimization plan

## Purpose

Resume should preserve every durability and correctness guarantee of a fresh scan without making the user wait through avoidable whole-database work. The current path does four expensive things before it emits resumed traversal progress:

1. `FullScanResumeStore.load()` validates the construction database with SQLite integrity and foreign-key checks.
2. `ConstructionDatabase.recoverIncompleteDirectories()` resets interrupted work.
3. Recovery rebuilds hard-link ownership, directory aggregates, and scheduler state across the whole construction database.
4. The scanner writes a `synchronous=FULL` resume checkpoint.

The controller often validated the same saved scan during Pause or application initialization. The worker does not know that, so it validates it again. The UI reports only `scanning`, which makes this preparation look like a stall.

This plan splits the work into five stages. Instrumentation lands first, then visible preparation status, then the two performance changes. The last stage proves the result with matched resume benchmarks and failure tests.

## Non-negotiable guarantees

Every stage must preserve these rules:

- A resume descriptor never authorizes a path outside the private indexes directory.
- The target device and inode, index-directory identity, schema versions, accounting policy, exclusion policy, hard-link ordering policy, and FSEvents volume identity must still match.
- A clean pause is acknowledged only after a durable construction checkpoint closes successfully.
- A timed-out pause, worker error, process restart, file replacement, or mismatched receipt falls back to authoritative validation.
- Completed directory subtrees remain intact. The highest interrupted directory roots restart from their beginning because reopened directory enumeration has no stable cursor.
- Node IDs retain the persisted HMAC seed.
- Hard-link ownership remains the UTF-8 binary-minimum observed path, regardless of scan order, focus order, pause point, or recovery order.
- Recovery either commits as one coherent construction transaction or aborts. A later resume must never observe half-repaired owners, aggregates, observations, or scheduler rows.
- The previous published index remains authoritative until candidate validation and atomic manifest publication finish.
- No filesystem path enters renderer snapshots or the public IPC methods.
- The final resumed candidate must match a fresh scan in nodes, direct observations, hard-link paths, hard-link groups, totals, and metadata semantics.

## Current critical path

The relevant call chain is:

```text
Resume button
  -> OrbisController.rescan()
  -> FullScanResumeStore.peek()
  -> WorkerScanExecution.start()
  -> refreshPersistentIndex()
  -> FullScanResumeStore.load()
       -> descriptor and path checks
       -> target and index-directory identity checks
       -> PRAGMA integrity_check
       -> PRAGMA foreign_key_check
       -> construction or candidate validation
  -> prepareResumableFullScan()
       -> FSEvents history validation
  -> scanFilesystem()
       -> filesystem preflight
       -> ConstructionDatabase.openResumable()
       -> recoverIncompleteDirectories()
       -> semanticTotals()
       -> synchronous=FULL resume checkpoint
       -> initial preview and first progress
       -> traversal
```

`OrbisController.cancelScan()` and startup initialization already call `FullScanResumeStore.load()`. That creates an opportunity to carry forward proof of a validated checkpoint instead of discarding it.

## Delivery rules

- Land each stage with its tests. Do not stack unverified recovery rewrites.
- Keep one authoritative resume-validation module. The controller and worker must not reimplement descriptor, file-stamp, or checkpoint checks.
- Keep `ConstructionDatabase.recoverIncompleteDirectories()` as the recovery interface. Its implementation may use private helpers and temporary tables, but callers should not learn recovery internals.
- Add no construction schema columns unless measurements prove temporary tables and existing indexes insufficient. A schema bump would invalidate current saved scans and needs separate approval.
- Compare optimization runs against a fixed commit and identical fixture. Dirty-tree quick runs are useful for debugging, not release claims.

# Stage 1: measure the resume path

**Status:** Complete. Schema-7 quick lifecycle runs and the clean, commit-pinned five-sample baseline at `80ca1ce` passed report validation.

## Goal

Make every delay between the Resume click and the first newly scanned metadata page attributable to one phase. The benchmark must distinguish preparation from traversal.

## Implementation

### Scan timings

Add these generation-scoped phases in `src/main/diagnostics.ts` and publish them from their owning modules:

- `resume-load-total`
- `resume-descriptor-validation`
- `resume-file-validation`
- `resume-integrity-check`
- `resume-foreign-key-check`
- `resume-history-validation`
- `resume-database-open`
- `resume-incomplete-recovery`
- `resume-hardlink-repair`
- `resume-aggregate-repair`
- `resume-scheduler-repair`
- `resume-semantic-totals`
- `resume-checkpoint`
- `resume-first-metadata-page`

`resume-load-total` is wall-clock time. Nested phases are work timings and may not be summed with wall-clock phases as if they were disjoint. Keep that distinction in benchmark schema and documentation.

Instrument the controller with:

- `resume-click-to-session`
- `resume-click-to-preparation`
- `resume-click-to-first-progress`
- `resume-click-to-first-metadata-preview`

The controller needs a per-generation timestamp recorded before `scanExecution.start()`. Clear it on completion, failure, Pause, discard, and generation replacement.

### Counters

Extend typed scan counters with:

- `resumeFullValidations`
- `resumeReceiptValidations`
- `resumeReceiptFallbacks`
- `resumeRecoveryRoots`
- `resumeDeletedNodes`
- `resumeAffectedHardlinkIdentities`
- `resumeRepairedAncestors`
- `resumeRepairedSchedulerRows`
- `resumeReplayedEntries`

Increment counters at the operation that did the work. Do not infer them later from timings.

### First-page marker

Publish `resume-first-metadata-page` once, when the first page accepted after recovery contains new metadata or a terminal unreadable-directory result. The bootstrap preview and restored saved preview do not count.

### Benchmark schema

Move the scan benchmark report to schema 7. Add a `resume` section per sample:

```ts
interface ResumeBenchmarkSample {
  validation: 'full' | 'receipt' | 'receipt-fallback'
  clickToPreparationMs: number
  clickToFirstProgressMs: number
  clickToFirstMetadataPreviewMs: number
  clickToFirstMetadataPageMs: number
  completionMs: number
  phases: Record<string, number>
  counters: ScanCounterRecord
}
```

Add benchmark scenarios for:

- clean Pause and Resume in one application process
- application restart with a clean construction database
- unacknowledged worker termination using the last durable checkpoint
- wide interrupted directory
- deep pending subtrees
- hard-link owner inside a reset subtree with another path outside it

Capture the unoptimized baseline before changing validation or recovery.

## Tests

- Extend `tests/scanner.test.ts` to require each applicable resume phase exactly once and reject negative durations.
- Extend `tests/scan-execution.test.ts` to assert click-to-event markers remain generation-scoped and stale sessions cannot publish them.
- Add benchmark schema validation for all resume fields and counters.
- Add a deterministic test where validation, recovery, and the first metadata read use injected clocks. Assert phase ordering without asserting real milliseconds.

## Exit criteria

- One report shows where resume time is spent for every resume fixture.
- Work timings and wall-clock timings are labeled separately.
- The first newly accepted metadata page has a direct timing marker.
- No optimization claim is made yet.

# Stage 2: show resume preparation in the UI

**Status:** Complete. Focused tests, type checking, the full unit and native suites, Electron smoke tests, verification build, and unsigned macOS packaging passed.

## Goal

A Resume click must produce visible feedback before database validation or recovery finishes. The saved preview stays on screen while preparation runs.

## Interface change

Extend `ScanStage` in `src/shared/contracts.ts` with `resuming`. Keep the existing IPC methods and snapshot version. A resuming `ProgressSnapshot` uses persisted counts when available and one of these path-free messages in `currentItem`:

- `Validating saved scan`
- `Checking filesystem changes`
- `Preparing interrupted directories`
- `Repairing saved index`
- `Starting filesystem traversal`

This is an additive payload change within the packaged main, preload, and renderer versions. Update `isProgress()` to accept it.

Add an internal preparation update to `ScanUpdate` and the worker protocol. Keep the phase vocabulary typed in one module so worker, controller, tests, and renderer cannot drift.

```ts
type ResumePreparationPhase =
  | 'validating'
  | 'history'
  | 'recovering'
  | 'repairing'
  | 'starting'
```

The renderer still receives only `ProgressSnapshot`; the internal phase type does not cross IPC.

## Event ordering

1. The controller emits a `resuming` snapshot immediately after it accepts the Resume request and before worker startup can block.
2. The worker reports phase transitions around resume load, journal validation, and construction recovery.
3. The controller ignores preparation updates from stale generations.
4. The saved construction preview remains the chart source until the worker emits a preview with an equal or newer construction revision.
5. The first real scanner progress changes `stage` from `resuming` to `traversing`.
6. Resume failure restores the last durable saved preview and returns to the paused state when the descriptor remains valid.

Do not show a determinate percentage during preparation. The existing progress module should use its indeterminate or minimum state until traversal resumes.

## Files

- `src/shared/contracts.ts`
- `src/main/scan-execution-protocol.ts`
- `src/main/scan-execution.ts`
- `src/main/scan-worker.ts`
- `src/main/controller.ts`
- `src/main/refresh-engine.ts`
- `src/main/progressive-scanner.ts`
- `src/renderer/App.tsx`

## Tests

- Renderer test: click Resume, retain the saved sunburst, show `Preparing resume...`, then transition to `Scanning...` on the first traversal progress.
- Controller test: preparation appears before the worker result and carries the current generation.
- Execution test: stale preparation messages are ignored.
- Failure test: receipt rejection or recovery failure does not erase the saved preview.
- Electron test: Resume gives visible feedback before a deliberately delayed validation adapter resolves.

## Exit criteria

- The UI changes within one renderer turn after Resume.
- No preparation message contains a filesystem path.
- The chart does not disappear while preparation runs.
- Traversal progress retains its current behavior after the stage transition.

# Stage 3: reuse trusted validation with a resume receipt

**Status:** Complete. Full verification and matched one-sample receipt-classification runs passed; the quick runs are not a performance claim.

## Goal

Skip a second whole-database integrity pass when Orbis already proved that the same durable checkpoint is safe. Any mismatch falls back to the current authoritative load path.

## Module design

Keep validation behind `FullScanResumeStore`. Add a serializable but internal `ResumeValidationReceipt` and return it with successful construction or candidate loads.

```ts
interface ResumeValidationReceipt {
  readonly version: 1
  readonly kind: 'construction' | 'candidate'
  readonly scanId: string
  /** SHA-256 of the exact validated descriptor bytes. */
  readonly descriptorDigest: string
  readonly checkpointSequence?: number
  readonly drainedThrough: string
  readonly database: {
    readonly file: string
    readonly device: string
    readonly inode: string
    readonly size: number
    readonly modifiedNs: string
    readonly changedNs: string
    readonly wal?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
    readonly shm?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
  }
  readonly source: 'acknowledged-pause' | 'full-validation'
}
```

The receipt is not a capability by itself. `FullScanResumeStore` accepts it only after repeating cheap checks:

- parse and validate the current descriptor
- verify expected target and descriptor digest
- verify target and index-directory identities
- require an owned regular database file with no symlink
- compare device, inode, size, modification time, and change time immediately before opening SQLite
- require the WAL to be absent or durably truncated after an acknowledged Pause; otherwise stamp and validate both `-wal` and `-shm`
- for construction, open SQLite and compare scan ID, checkpoint sequence, phase, and drained-through cursor in `scan_run`
- for a finalized candidate, verify the metadata identity, resume cursor, and absence of construction tables; candidates have no `scan_run`
- repeat the database and sidecar stamps after the SQLite queries, rejecting a replacement race
- verify expected partial or candidate presence and reject ambiguous replacements

If any check fails, discard the receipt and run the existing full validation. Return the reason through diagnostics, not through renderer error text.

### Clean Pause proof

An acknowledged Pause already means the worker completed `finish({kind:'pause'})`, committed with `synchronous=FULL`, truncated the journal, and closed the database. Use that acknowledgement to create a receipt without running `PRAGMA integrity_check` again:

1. Propagate the existing `WorkerPausedMessage.checkpointSequence` through `ScanSession.pause()` and `OrbisController.#stopRun()` instead of discarding the outcome.
2. Add `FullScanResumeStore.loadAcknowledgedCheckpoint(target, checkpointSequence)`.
3. This method performs the cheap receipt checks and reads the `scan_run` row. It does not run full integrity or foreign-key checks.
4. It also proves that the acknowledged pause left no live WAL content outside the stamped checkpoint.
5. If acknowledgement times out, the sequence is missing, a sidecar is live, or the row does not match, call the full loader.

### Startup and crash behavior

- Application startup has no in-memory clean-pause proof. Run full validation once and create a receipt from the result.
- Unexpected worker exit and unacknowledged Pause use full validation.
- A receipt never persists as trusted state across a process restart. The descriptor remains data, not proof.
- A clean receipt lives only in the main process and crosses only the main-to-worker thread message.

### Worker use

Add an optional receipt to `ScanExecutionRequest` and the worker start message. The controller keeps the latest receipt beside `#savedConstruction` and clears it when:

- the target changes
- the saved scan is discarded
- publication completes
- the generation fails without a valid saved checkpoint
- any file-stamp comparison fails

`prepareResumableFullScan()` asks the store to load with the receipt. The store either returns a receipt-validated load or performs full validation. Refresh and scanner modules do not inspect receipt fields.

### Implementation notes

The receipt is single-use. The controller clears it as soon as it hands it to the worker, and also clears it when the saved checkpoint is discarded, published, or no longer valid. Receipt fallback reasons stay on the internal diagnostics channel. Renderer snapshots and IPC payloads do not contain receipt data.

Read-only SQLite checks use an immutable URI when the validated database has no live WAL or rollback journal. A normal read-only connection can update shared-memory sidecar timestamps even when it changes no rows, which would make a clean receipt fail its post-query stamp check. Live WAL or journal state still uses normal SQLite access and authoritative validation.

Benchmark classification uses counters from the measured worker. Fallback takes precedence over receipt validation, and receipt validation takes precedence over full validation. Startup or crash validation that occurs before the measured worker is therefore not counted in that worker's `validation` field.

## Threat and race model

The indexes directory is app-private and artifact mutations are serialized by `PublicationArtifacts`. A matching inode, main-file and sidecar stamps, matching checkpoint row, and unchanged post-query stamps are enough to reuse validation within the same process. The before-and-after stamp checks close the pathname replacement window around SQLite validation. Tests must include rename replacement, same-name replacement, and WAL or shared-memory sidecar appearance.

Do not add a persisted trust flag to `scan-resume.json`. It would survive crashes and could turn stale metadata into proof.

## Tests

- Clean acknowledged Pause produces one receipt validation and zero full validations on Resume.
- Pause timeout produces no receipt and performs full validation.
- Application restart performs full validation before creating a receipt.
- Changed descriptor, target identity, index-directory identity, inode, size, modification time, change time, checkpoint sequence, phase, or cursor rejects the receipt.
- Receipt rejection falls back to full validation instead of discarding a valid construction.
- A corrupt SQLite file with a stale receipt cannot resume.
- Candidate receipt validation still runs candidate semantic validation when the file stamp differs.
- Existing unsafe-path and artifact-retention tests remain green.

## Exit criteria

- Clean same-process Resume does not execute `PRAGMA integrity_check` or a global foreign-key check.
- Crash and restart paths retain current full validation.
- Receipt mismatch has one behavior: full validation, then either safe resume or existing restart handling.
- No renderer or preload interface exposes the receipt.

# Stage 4: recover only interrupted scopes

**Status:** Complete. Scoped hard-link and scheduler recovery, structural invalidation, the legacy full-rebuild oracle, focused parity coverage, full verification, packaging, and schema-7 quick benchmark checks passed.

## Goal

Replace global hard-link and scheduler reconstruction with recovery proportional to interrupted directory roots and the identities they touched.

## Recovery data set

Build temporary tables at the start of `recoverIncompleteDirectories()`:

- `recovery_roots(id, parent_id, depth)` for the highest queued or scanning tasks
- `recovery_subtree(id, parent_id, depth)` for descendants that will be deleted
- `recovery_ancestors(id, depth)` for every ancestor whose aggregate or scheduler state can change
- `recovery_identities(device, inode)` for tracked hard-link identities observed under the reset subtree
- `recovery_owner_parents(id)` for surviving parents affected by owner movement

Populate all tables before deleting rows. This preserves the evidence needed for hard-link repair.

## Mutation order

Run recovery inside the existing construction transaction:

1. Validate the construction phase and, before any recovery mutation, assert that traversal-phase `hardlink_groups` is empty. It is a finalization artifact and its foreign keys would otherwise constrain owner-path deletion. A `finalizing` construction follows candidate validation or finalization retry instead of traversal recovery. Treat nonempty groups in a traversal-phase construction as invalid resumable state and fall back to authoritative restart handling.
2. Capture recovery roots, descendants, ancestors, affected identities, and observation parents.
3. Delete `hardlink_owners` only for affected identities.
4. Delete affected `hardlink_paths` before node cascades can invalidate owner references.
5. Delete children of recovery roots. Existing foreign-key cascades remove descendant tasks and observations.
6. Reset only recovery-root nodes, tasks, and direct observations.
7. Repair affected hard-link identities in UTF-8 binary path order.
8. Add old and new owner parents to the affected ancestor set.
9. Recompute affected directory aggregates in Stage 5.
10. Repair scheduler fields for reset roots and affected ancestors.
11. Drop temporary tables only after the recovery report has been read.

Any error aborts the transaction. The caller follows the existing restart or failure path.

## Scoped hard-link repair

Extract one private hard-link repair implementation shared in concept with incremental publication repair, but keep construction and persistent SQL adapters separate because their schemas differ.

For each affected `(device, inode)`:

- Read surviving `hardlink_paths` ordered by `path_key` using binary UTF-8 ordering.
- If no path survives, leave no owner or group state.
- Choose the first path as owner.
- Reuse a surviving matching file node when possible.
- Otherwise recreate the canonical file node under the surviving owner parent using the persisted node-ID seed.
- Remove any stale representative node for that identity.
- Recompute duplicate observations for parents represented in that identity only.
- Insert one `hardlink_owners` row.

Do not scan unrelated hard-link paths or all file nodes. Existing indexes on `hardlink_paths(device, inode, path_key)` and `nodes(device, inode)` support these queries.

## Scoped scheduler repair

For tasks in the affected set:

- `subtree_complete` reflects the node terminal state.
- `pending_children` counts direct child tasks whose subtrees are not complete.
- A recovery root is queued with `entries_read = 0` and `subtree_complete = 0`.
- `ready = 1` only for the root task or a task whose parent enumeration is terminal.
- Completed unaffected descendants and their enqueue order remain unchanged.
- Focus state remains on retained nodes. If the focused node was deleted, fall back to the nearest retained ancestor or root through the existing focus rules.

Compute the process-local `#pendingSubtrees` with one `COUNT` after repair. That linear count is acceptable initially. It is much cheaper than rebuilding every task row and recursive aggregate. Optimize it only if Stage 1 measurements show it matters.

## Recovery report

Return a typed report from the existing recovery interface:

```ts
interface ResumeRecoveryReport {
  readonly roots: number
  readonly deletedNodes: number
  readonly affectedHardlinkIdentities: number
  readonly repairedAncestors: number
  readonly repairedSchedulerRows: number
}
```

The scanner uses it only for diagnostics. Correctness must not depend on the report.

## Tests

Add resume parity fixtures for:

- two interrupted roots under different completed parents
- queued, scanning, complete, and unreadable direct children
- focused node inside a reset subtree
- hard-link owner deleted with a surviving path outside the reset subtree
- surviving owner replaced by a binary-smaller path after replay
- tracked hard-link identity with no surviving path
- exact single-link files, which must not gain `hardlink_paths`
- nested reset roots, where only the highest interrupted root is selected
- path isolation and symlink rejection during replay

Assert that unrelated node IDs, task rows, owners, and observation rows do not change. Compare the final candidate to a fresh scan.

## Exit criteria

- Recovery no longer executes `DELETE FROM hardlink_owners` without an identity predicate.
- Hard-link repair touches only identities captured before reset plus identities replayed later.
- Scheduler repair updates only reset roots and their affected ancestor chain.
- Final rows and totals match a fresh scan for every pause point and focus order.

# Stage 5: replace the global recursive aggregate rebuild

## Goal

Remove the whole-database recursive closure from normal resume recovery. Recompute only reset roots, owner-movement parents, and their ancestors.

## Algorithm

After Stage 4 mutations, `recovery_ancestors` contains every directory whose totals may differ. Process those rows by descending depth so children are exact before parents:

```sql
UPDATE nodes
SET size_bytes = own_bytes + COALESCE((
      SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = nodes.id
    ), 0),
    direct_children = (
      SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id
    ),
    descendant_count = COALESCE((
      SELECT SUM(child.descendant_count + 1) FROM nodes child WHERE child.parent_id = nodes.id
    ), 0),
    unreadable_count = own_unreadable + COALESCE((
      SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = nodes.id
    ), 0)
WHERE id = ?
```

Use one prepared statement and the temporary depth ordering. The affected set is normally a small number of ancestor chains. Do not build an ancestor-by-descendant closure.

### Propagation bookkeeping

Rebuild `#propagatedToParent` for every unreadable recovery root and every retained unreadable node whose parent lies in `recovery_ancestors`. Record the contribution already present in that parent's recomputed aggregate. An unreadable node outside those relationships cannot participate in a later affected settlement and needs no process-local entry. Add an invariant test that settles each affected ancestor after recovery and proves no retained unreadable contribution is applied twice.

### Semantic totals

`semanticTotals()` still performs global `COUNT` and `SUM` queries after recovery. Keep those simple linear aggregates in the first version because they reconstruct scan counters safely. Stage 1 timings will show whether they matter. Do not mix their optimization with aggregate repair.

If semantic totals dominate after the closure removal, add persisted counters in a separate schema change with a migration and independent parity tests.

### Fallback

Keep a private full-rebuild implementation for one release as a diagnostic fallback, guarded by an explicit recovery error and counter. It must not silently repair arbitrary corruption. Receipt or structural validation failure still follows the authoritative full-validation or restart path.

Remove the fallback after benchmark coverage and production diagnostics show no scoped-recovery mismatches.

## Tests

- Unit-level construction test compares scoped aggregate repair with a SQL recomputation oracle.
- Property test generates bounded directory trees, chooses interruption roots, applies deletion and replay, and compares every aggregate field.
- Deep-tree test proves work scales with affected ancestors rather than ancestor-by-descendant pairs.
- Hard-link owner movement test verifies both old and new parent chains.
- Unreadable subtree test verifies `own_unreadable` and descendant unreadable totals.
- Resume integration tests compare candidate rows, metadata totals, and saved preview totals with a fresh scan.

## Performance acceptance

Use matched five-sample runs on the same commit, machine, cache state, fixture, and batch settings.

Required results:

- Clean same-process Resume performs zero full validations.
- Receipt validation time is at most 25% of the previous full-validation median on standard fixtures.
- Recovery SQL row updates scale with reported recovery roots, affected identities, scheduler rows, and ancestor rows. They must not equal total construction rows unless the root itself was interrupted.
- Deep fixture recovery removes the global recursive-closure phase.
- Time from Resume click to first new metadata page improves by at least 50% on the wide and deep resume fixtures, or is below 500 ms warm, whichever condition is met first.
- Uninterrupted traversal throughput, first-preview latency, checkpoint count, and final database size do not regress by more than 5% in matched five-sample medians.
- Every optimized result passes fresh-scan row parity, schema validation, foreign-key checks, and hard-link ownership checks.

# Cross-stage verification matrix

| Scenario | Expected validation | Expected recovery | Expected result |
|---|---|---|---|
| Clean acknowledged Pause, same process | Receipt | Scoped | Resume |
| Pause acknowledgement timeout | Full | Scoped if valid | Resume or existing restart behavior |
| Worker crash with durable checkpoint | Full | Scoped if valid | Resume |
| Application restart | Full once | Scoped | Resume |
| Receipt file stamp changed | Receipt fallback to full | Scoped if full validation passes | Resume |
| Construction SQLite corruption | Full rejects | None | Restart or retain previous publication |
| Target device or inode changed | Reject | None | Restart required |
| Index directory identity changed | Reject | None | Restart required |
| FSEvents UUID changed or history unavailable | Validation rejects resumability | None | Existing bounded full-scan fallback |
| Candidate already finalized | Receipt or full candidate validation | None | Publish validated candidate |
| Interrupted wide directory | Receipt or full | Reset that directory from entry zero | Fresh-scan parity |
| Interrupted deep subtree | Receipt or full | Highest incomplete root plus ancestors | Fresh-scan parity |
| Hard-link owner in reset subtree | Receipt or full | Affected identity and both parent chains | Deterministic owner |

# Documentation changes

Update these files as implementation lands:

- `CONTEXT.md` with `resume validation receipt`, `recovery root`, and `affected recovery set`.
- `docs/architecture/orbis-progressive-scanning.md` with preparation stages, receipt trust lifetime, scoped recovery, and the remaining mid-directory replay cost.
- `README.md` with visible Pause and Resume behavior only. Keep implementation details in architecture docs.
- `docs/benchmarks/orbis-resume-optimization.md` with commit-pinned baseline and final matched reports.
- `docs/plans/ORBIS_SCAN_OPTIMIZATION_PLAN.md` with links to this plan and measured completion status.

Also correct stale startup wording while touching the architecture document. Standalone now waits for an explicit Scan or Resume action.

# Implementation sequence and review points

1. Capture the baseline and land Stage 1 diagnostics.
2. Review timing names and benchmark schema before collecting long runs.
3. Land Stage 2 UI preparation updates without changing validation or recovery.
4. Review the renderer and worker event ordering with stale-generation tests.
5. Land Stage 3 receipt support with full fallback enabled for every mismatch.
6. Review the trust model, timeout path, path ownership, and process-restart behavior.
7. Land Stage 4 scoped hard-link and scheduler recovery behind a temporary comparison mode in tests.
8. Compare scoped recovery output with the current full rebuild across generated fixtures.
9. Land Stage 5 aggregate repair and remove the normal global closure.
10. Run the full verification and matched benchmark matrix.
11. Keep the diagnostic full-rebuild fallback for one release, then remove it after evidence supports removal.

# Final verification commands

Run the narrow checks after each stage, then the full set at completion:

```bash
pnpm typecheck
pnpm test
pnpm native:test
pnpm test:smoke
pnpm verify
pnpm package:mac:unsigned
```

Run the new resume benchmark in quick mode during development and five-sample standard mode for acceptance. Store both raw schema-7 reports and the Markdown comparison. The final review must cover standards and this plan separately.

# Definition of done

The work is complete when:

- Resume preparation is visible immediately.
- Clean same-process Resume reuses a verified checkpoint without a second full integrity pass.
- Crash, restart, timeout, and tamper paths still perform authoritative validation.
- Recovery touches interrupted scopes, affected hard-link identities, and affected ancestors instead of rebuilding the whole construction database.
- The global recursive aggregate closure is absent from normal resume.
- The first newly scanned metadata page arrives within the acceptance target.
- Final candidates remain row-for-row semantically equivalent to fresh scans under the repository's parity checks.
- Tests, native builds, packaging, and matched benchmarks pass.
