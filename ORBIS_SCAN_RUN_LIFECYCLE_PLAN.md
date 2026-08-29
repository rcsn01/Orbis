# Orbis scan-run lifecycle — deepening plan

Status: implemented; clean benchmark guard unavailable without commits · 2026-08-29
Origin: architecture review 2026-08-29, candidate 1 — *give the scan run one owner*.
Honours ADR-0001 (distributed resume preparation phases; controller-owned immediate
`resuming` acknowledgement; performance guard) and ADR-0002 (`locations.json` stays the
publication commit point; catalog keeps durability).

## 1. Problem

`src/main/controller.ts` (933 lines, most-changed file) implements the scan-run state
machine through ~20 mutable fields. The invariant *“the run is still current”* survives
only as ~15 hand-copied guards (`this.#run !== run || this.#closed || run.completed`) and
the reset ritual (`#preview`/`#savedConstruction`/`#resumeReceipt` + `#rejectPendingReveals`)
is repeated at five sites (controller.ts:251–254, 346–348, 519–521, 655, 693). Every scan
feature re-edits the same scattered invariants, and tests must reassemble the wire
protocol (`FakeScanSession`, `DeferredScanExecution` in tests/controller.test.ts) instead
of driving one interface.

## 2. Settled decisions

1. **Scope** — the new module owns the run-coupled state machine: run record, generation,
   scan status, preview, saved construction, resume receipt (single-use), paused progress,
   resume display state, pending reveal cancellations, the lifecycle command queue, pending tasks,
   sealed state, and the run-coupled target. `#preview` and `#scanStatus` are written only
   at lifecycle transitions (verified: 227–239, 251–259, 514–591, 612–615, 653–659,
   691–695, 725) — they are the observable outputs of the state machine and move with it.
   The controller keeps `#focusId` (also written by location selection — presentation),
   listeners, snapshot assembly, dialog/shell adapters, and the estimate cache instance.
2. **Seam location** — a new module above scan execution. `scan-execution.ts` keeps its
   CONTEXT.md role (worker creation, message ordering, pause acknowledgement,
   termination). Its existing dependency seam has two adapters: production
   `WorkerScanExecution` and deterministic `FakeScanExecution` in lifecycle tests. The
   lifecycle interface itself has one production caller, the controller; tests drive that
   same interface directly rather than acting as a second adapter.
3. **`resuming` acknowledgement.** This stays controller-owned per ADR-0001. After
   preparation resolves, the module creates the deferred session start, registers the run,
   sets `resuming`, and sends one synchronous `started` transition notification. There are
   no awaits between run registration and that notification. The controller listener emits
   the renderer snapshot before the queued `scanExecution.start` callback runs. The command
   promise is not required to resolve before worker startup begins.
4. **Publication is injected through two ordered operations.** The module owns run
   currency and decides when a run becomes terminal. `publishCompleted` preserves the
   current order of catalog installation followed by best-effort Resume retirement. A
   retirement or cleanup failure after installation cannot invalidate an exact committed
   publication. `publishUnchanged` preserves strict Resume verification and retirement
   before catalog advancement. These operations own terminal Resume retirement, catalog
   mutation, focus restoration, estimate persistence, and publication cleanup. The
   lifecycle Resume port does not expose `complete`. Candidate 3 may later deepen these
   operations without changing the lifecycle interface.
5. **Migration is test-first with one production cutover.** The module is built and tested
   in isolation in several green slices. The controller continues using its existing state
   until the module implements every run-coupled command. One later slice moves the state
   and all its guards together. The current 23 controller tests remain green throughout;
   ADR-0001 benchmark evidence is collected at the end.

### Revised design decisions

- **A. Interface shape: guarded choreography.** Controller methods delegate to
  `lifecycle.startScan/pauseScan/discardSavedScan/focusNode/revealNode/seal`. Async
  continuations live inside the module and carry private run tokens. Every continuation
  validates currency internally. The controller never compares run identity. State is an
  immutable query, and observable changes cross a typed transition notification seam.
- **B. Start serialization and dependencies.** The command queue covers initialization,
  run-policy checks, stopping a previous run, Resume inspection, artifact cleanup,
  start-context preparation, `beginScan`, and run registration. The controller may choose
  a requested target before calling the module, but it performs no run-currency or
  catalog-ownership checks outside the queue. Injected `prepareStartContext(target)`
  resolves target identity, selected-location ownership, active coverage, and the initial
  estimate, and returns catalog revision guards. `beginScan` validates those guards at its
  catalog commit. Narrow injected ports cover Resume access, publication ID creation, run
  paths, catalog operations, construction-preview reads, reveal-path validation, and
  artifact cleanup. `ScanExecution` and diagnostics remain direct module dependencies.
- **C. Focus/reveal branches.** The module owns the run and saved-construction branches,
  including live resolution, construction-path resolution, filesystem path validation,
  final token validation, and pending reveal cancellations. It returns only a validated
  path. The controller retains `shell.showItemInFolder`. The published-index branch stays
  controller-side because `coverageAccess.current() !== active` is coverage-view
  staleness, which location selection can change without touching the run. The module
  returns `'not-running'` so the controller can fall through.
- **D. Migration order.** Build the complete module behind tests before integrating it.
  The production cutover moves start, consume, publication dispatch, pause, discard,
  failure, focus/reveal, startup adoption, seal, all run-coupled state, and all guards in
  one slice. There is no production state where the controller reads lifecycle state but
  still guards the same operation itself.
- **E. Split `#target`.** Today one field serves selected-location target during
  initialization and active or saved-run target during lifecycle operations. The
  lifecycle owns the latter. The controller owns selected-location target resolution.
  Startup adoption receives the selected target explicitly. Successful publication
  returns the post-publication active target computed from the selected location.
- **F. Notification contract.** Each observable lifecycle transition sends exactly one
  immutable event containing `kind`, `generation`, and `state`. Commands do not emit a
  second event for their reply. The controller listener rebuilds and pushes one snapshot.
  No-op commands, live-focus requests that do not yet change a preview, diagnostic-only
  milestones, and sealing do not notify renderer subscribers. Publication events carry
  enough metadata for the controller to preserve `snapshot-total` and `listener-notify`
  measurements without comparing old and new lifecycle states.
- **G. Transition-specific reset.** One internal helper owns volatile-state cleanup, but
  callers must choose an explicit policy for preview, saved construction, receipt, paused
  progress, Resume display, and reveal-cancellation reason. Start, pause, failure,
  publication, discard, and seal do not all clear the same fields.
- **H. Command arbitration.** Start, pause, and discard share the serialized command queue.
  A pause or discard requested during start preparation runs after registration and cannot
  return while that new run remains active. Seal marks the module sealed immediately, then
  drains the queue. Focus and reveal do not join the command queue; their private tokens and
  cancellation set make their async continuations stale when a queued command transitions
  the run. Together with guarded start-context commit, this is one of two intentional
  concurrency tightenings in the extraction.

## 3. Target architecture

```
                         renderer (IPC)
                              │
                    ┌─────────▼──────────┐
                    │  OrbisController    │  façade: snapshot assembly, focus (presentation),
                    │  (thin)             │  dialog/shell adapters, estimate cache instance,
                    └─────────┬──────────┘  catalog/coverage composition, initialize()
                              │  small interface (start/pause/discard/focus/reveal/seal
                              │  + state query + transition notifications)
                    ┌─────────▼──────────┐
                    │ ScanRunLifecycle    │  DEEP: run identity, generation, staleness, reset
                    │ (new module)        │  ritual, receipt single-use, preview/status, queue,
                    └──┬──────┬───────┬──┘  pending tasks, seal
            injected   │      │       │ direct deps
   ┌───────────────────────┐ ┌───────────────┐ ┌────────────────────┐
   │ publishCompleted /    │ │ ScanExecution │ │ Resume port +      │
   │ publishUnchanged,     │ │ (unchanged    │ │ deterministic test │
   │ begin/clear/cleanup   │ │  seam)        │ │ adapter            │
   └───────────┬───────────┘ └───┬───────────┘ └────────────────────┘
               │                  │ worker
   ┌───────────▼─────────┐  ┌────▼──────────┐
   │ candidate 3's home  │  │ scan worker    │
   │ (later)             │  │ + scanner     │
   └─────────────────────┘  └───────────────┘
```

The controller stops comparing run identity entirely; policy checks that read run
presence (e.g. *“Pause the current scan before adding another location”*) use the
read-only state projection, which is legitimate interface use — not staleness guarding.

## 4. Module charter

**`src/main/scan-run-lifecycle.ts` — `ScanRunLifecycle`**

Owns (and is the only writer of):

- the run record (today’s `ScanRun` interface), generation counter, sealed state;
- renderer-visible scan status, current preview, paused progress;
- saved construction load, resume receipt (issue → single-use consumption), resume
  display state;
- pending reveal cancellations;
- the serialized start/pause/discard command queue and the pending-task set;
- the run-coupled target;
- transition-specific volatile-state cleanup through one policy-driven helper;
- consumption of `ScanSession` events (progress/preview revision gating, resume
  milestones, resume-preparation phase → status text);
- outcome dispatch: `completed`/`unchanged` → the matching injected publication
  operation (with run-currency checks on both sides); `paused`/`canceled` → pause choreography;
  `failed` → fail choreography (durable preview/construction restore, stop, resume
  refresh, pending-scan clear, artifact removal).

Does **not** own (injection points, candidate 3’s future territory):

- catalog transactions (`beginScan`, `advancePublication`/`publishAndInstall`,
  `clearPendingScan`), terminal Resume retirement, artifact retention decisions
  (`discardUnreferencedDatabase`);
- worker transport (scan execution remains the seam);
- snapshot assembly, focus restoration policy, estimate-cache persistence;
- renderer navigation policy (`#focusId`), dialog/shell adapters;
- resume preparation phases themselves (ADR-0001 keeps them distributed beside
  `refresh-engine` / `progressive-scanner`; the module only maps phase → status text,
  exactly as the controller does today).

### Interface sketch (settles during TDD; shapes, not signatures)

```ts
type ScanLifecycleTransitionKind =
  | 'started' | 'progress' | 'preview' | 'paused' | 'discarded'
  | 'failed' | 'completed'

interface ScanLifecycleTransition {
  readonly kind: ScanLifecycleTransitionKind
  readonly generation: number
  readonly state: ScanLifecycleState
}

interface ScanRunLifecycle {
  readonly state: ScanLifecycleState
    // { sealed, run?: { locationId, target, completed }, scanStatus, preview?,
    //   resume?: { available, checkpointedAt }, activeTarget }
  subscribe(listener: (transition: ScanLifecycleTransition) => void): () => void

  startScan(request: { target: string }): Promise<ScanLifecycleState>   // fully serialized
  pauseScan(): Promise<ScanLifecycleState>
  discardSavedScan(): Promise<ScanLifecycleState>
  focusNode(id: string): Promise<'applied' | 'not-running'>
  revealNode(id: string): Promise<
    { kind: 'live' | 'saved'; validatedPath: string } | { kind: 'not-running' }
  >
  seal(initialization?: Promise<unknown>): Promise<void>
    // sealed=true → drain command queue → await initialization → stop run →
    // scanExecution.close() → settle pending tasks → policy-driven reset
  adoptStartupState(input: { saved: FullScanResumeLoad; selectedTarget: string }): Promise<void>
    // Initialization-only, generation 0, and not enqueued behind ensureInitialized.
    // It may run while seal waits for initialization; seal's final reset wins.
}

interface ScanLifecycleResumePort {
  peek(): Promise<FullScanResumePeek>
  load(expectedTarget?: string): Promise<FullScanResumeLoad>
  loadAcknowledgedCheckpoint(target: string, sequence: number): Promise<FullScanResumeLoad>
  discard(expectedScanId?: string): Promise<boolean>
  removeDescriptor(): Promise<void>
  // Terminal complete/readDescriptor operations belong to publication adapters.
}

interface ScanLifecycleDependencies {
  readonly indexDirectory: string
  readonly scanExecution: ScanExecution
  readonly resume: ScanLifecycleResumePort
  readonly ensureInitialized: () => Promise<void>
  readonly prepareStartContext: (target: string) => Promise<ScanStartContext>
    // resolved target identity, selected owner, active coverage, estimate, catalog guards
  readonly createPublicationId: () => string
  readonly runPaths: (publicationId: string) => { partialPath: string; publishedPath: string }
  readonly beginScan: (
    record: BeginScanRecord,
    previousScanId: string | undefined,
    guards: { expectedRevision: number; selectedLocationId: LocationId }
  ) => Promise<void>
  readonly publishCompleted: (
    run: RunContext, outcome: CompletedOutcome
  ) => Promise<CompletedPublicationResult>
    // install publication → retire Resume → restore focus/cache/cleanup
  readonly publishUnchanged: (
    run: RunContext, outcome: UnchangedOutcome
  ) => Promise<UnchangedPublicationResult>
    // verify/retire Resume → advance catalog → cleanup
  readonly clearPendingScan: (scanId: string) => Promise<void>
  readonly discardUnreferencedDatabase: (path: string) => Promise<void>
  readonly readConstructionPreview: ReadConstructionPreview
  readonly resolveConstructionNodePath: ResolveConstructionNodePath
  readonly validateRevealPath: (path: string, target: string) => Promise<string>
  readonly createMilestones: () => ControllerTimingMilestones
}
```

`publishCompleted` and `publishUnchanged` return a discriminated result. Success includes
status totals, the post-publication active target, and any post-commit cleanup warnings.
Stale publication returns a stable failure reason and the candidate disposition. Errors
before the operation's commit point reject. Once an operation crosses its commit point,
it resolves committed success even if best-effort cleanup fails. The lifecycle checks run
currency before calling either operation and again before applying its result. If a run
becomes stale after a durable commit, the operation's result remains authoritative and
startup reconciliation owns any remaining cleanup; the stale continuation does not
overwrite newer renderer state.

## 5. Guard-site migration map

| Today (controller.ts) | New home |
|---|---|
| :571 `#consumeRun` session-catch guard | module consumption loop (internal token) |
| :576 update-loop supersession check | module consumption loop |
| :596 outcome guard + :599 stale-candidate removal | module outcome dispatch |
| :625 `#publish` entry staleness / :652 post-install currency | module around injected `publishCompleted` |
| :676 `#publishUnchanged` entry / :690 post-advance currency | module around injected `publishUnchanged` |
| :608/:615 paused/canceled reset ritual + `#refreshResumeState` | module pause choreography |
| :231–233 `cancelScan` pause-sequence guards | module `pauseScan` |
| :717 `#refreshResumeState` guard, :734 `#restoreConstructionPreview` guard | module (internal) |
| :758 `#fail` guard + durable restore + settle task | module fail choreography |
| :760 `close` sequence | module `seal` (exact ordering preserved, below) |
| :272 / :304 focus/reveal live-run guards | module `focusNode`/`revealNode` |
| :313–315 saved-branch guard | module `focusNode`/`revealNode` |
| :320–321 published-branch `current() !== active` check | **stays controller-side** (coverage-view staleness) |
| :470–560 start closed/generation/receipt/reset checks | module `startScan` |
| :781 `#resolveLiveNode` guard + cancellation set | module reveal sequencing |
| :166/:197/:209/:497 policy checks reading `#run` | state query (read-only projection) |

The five listed cleanup sites call one helper, but each call supplies a typed reset policy.
Tests pin the exact fields preserved and cleared at every transition.

## 6. Migration slices

Every landed slice runs `pnpm typecheck` and `pnpm test`. Module work remains disconnected
from production until it implements the complete interface, so the controller never shares
ownership of run state or guards.

**Slice 0: characterization and test adapters.** Define the narrow dependency ports and
create deterministic adapters for scan execution, Resume operations, start-context
preparation, publication, construction preview reads, and path validation. Add a controller
characterization test for immediate `resuming` notification order. Add contract tests for
the two production publication adapters and guarded start-context adapter. These tests
exercise existing behavior or disconnected adapters and land green.

**Slice 1: isolated start, consume, and publication dispatch.** Implement the module's
run record, generation, serialized command queue, complete start preparation, receipt
handoff, status and preview updates, event consumption, pending-task bookkeeping, and the
two terminal publication operations. The controller is unchanged. Module tests drive only
the lifecycle interface and injected adapters.
*Exit criteria: start and terminal outcome tests pass; production behavior is unchanged.*

**Slice 2: isolated pause, discard, and failure.** Implement pause acknowledgement loading,
authoritative fallback, saved-construction adoption, discard, failure recovery, pending
scan cleanup, artifact cleanup, and transition-specific reset policies. The controller is
still unchanged.
*Exit criteria: all pause, discard, receipt, failure, and reset-policy tests pass.*

**Slice 3: isolated focus, reveal, startup adoption, and seal.** Implement run and saved
focus/reveal branches, path validation with a final token check, reveal cancellation,
startup adoption, and sealing. Preserve close order: mark sealed, drain the command queue,
await any existing initialization, stop the run, close scan execution, settle pending
tasks, then reset without renderer notification.
*Exit criteria: the module implements its full interface and all module tests pass.*

**Slice 4: atomic controller cutover.** Construct the lifecycle and its production
adapters. Move every run-coupled field and operation in one change: start/consume,
publication dispatch, pause/discard/failure, focus/reveal branches, startup adoption,
sealed state, command queue, pending tasks, notifications, and reset policies. Keep the
published-index focus/reveal branches in the controller. Controller command methods await
the lifecycle command and return a newly assembled `OrbisSnapshot`; they do not emit a
second lifecycle snapshot.
*Exit criteria: the controller has no `#closed`, `#startQueue`, `#pendingTasks`, `#run`,
`#generation`, `#savedConstruction`, `#resumeReceipt`, `#pausedProgress`, lifecycle-owned
`#preview`/`#scanStatus`, run-identity comparisons, or reset copies. All existing 23
controller cases and the new integration cases pass.*

**Slice 5: slim and prove.** Delete dead controller code, run `pnpm verify`, update
`CONTEXT.md`, `docs/architecture/`, and this file's status, then run the benchmark plan in
§8.

## 7. Test plan

New `tests/orbis-scan-run-lifecycle.test.ts` uses the module interface and deterministic
adapters. It does not recreate the worker wire protocol.

1. after preparation, `started` notification exposes `resuming` before
   `scanExecution.start` is invoked; the command need not resolve first;
2. the command queue covers initialization, current-run policy, stop/load,
   `prepareStartContext`, guarded `beginScan`, and registration in that order;
3. failures from Resume peek, start-context preparation, guarded `beginScan`, and
   `scanExecution.start` release the queue and leave a defined state;
4. start A then start B discards A's later updates and outcomes, settles A's tasks, and
   discards an uncommitted stale candidate;
5. the receipt is single-use across generations, and
   `ORBIS_DISABLE_INCREMENTAL_SCAN` discards it and its saved artifacts;
6. generation monotonicity and status transitions cover idle, scanning, completed,
   canceled, and fatal-error states, including failed starts that consume a generation;
7. preview updates require the current generation and a nondecreasing revision;
8. pause uses acknowledged-checkpoint load when proved, otherwise authoritative load,
   and adopts a saved construction preview;
9. pause and discard requested during start preparation serialize behind that start, so a
   resolved command cannot leave the just-started run active;
10. failure restores durable preview and construction, clears the pending scan, and
    removes run files when no Resume state survives;
11. completed publication installs the catalog commit before terminal Resume retirement;
    retirement or cleanup failure after commit returns warnings and remains completed;
12. unchanged publication verifies and retires Resume before catalog advancement;
    retirement failure prevents advancement, while post-advance cleanup cannot roll it back;
13. stale publication results never overwrite a newer run, and cleanup follows the
    returned candidate disposition;
14. each transition-specific reset policy preserves and clears the intended fields and
    rejects pending reveals with the intended message;
15. live and saved reveal validate the path, then perform a final token check; focus
    changes, supersession, discard, and seal reject pending reveals;
16. one renderer-observable state change sends one immutable transition event; no-op
    commands, milestones, startup adoption, live-focus requests without a preview change,
    and seal send none;
17. seal preserves queue drain, initialization, run stop, `scanExecution.close`, and task
    settlement order; startup adoption racing seal cannot survive the final reset.

`tests/controller.test.ts` keeps its existing 23 expectations. Add integration cases that
prove one lifecycle event becomes one renderer snapshot, the returned IPC snapshot matches
the applied lifecycle state, and publication diagnostics fire exactly once. Also pin the
existing shutdown contract: repeated seal is idempotent, subscription after seal is a
no-op, and start after seal rejects with the shutdown error. Rewriting existing cases is
not part of this extraction.

## 8. Benchmark plan (ADR-0001 guard)

Record two clean, immutable commit IDs before running anything:

```bash
BASE_REF=main-before-lifecycle
CHANGED_REF=final-lifecycle-commit
BASE_SHA=$(git rev-parse "$BASE_REF^{commit}")
CHANGED_SHA=$(git rev-parse "$CHANGED_REF^{commit}")
git show --no-patch --format='%H %s' "$BASE_SHA" "$CHANGED_SHA"
```

Use separate worktrees pinned to those exact SHAs and require `git status --porcelain` to
be empty in each. Run the same command in each worktree on
the same machine with the same fixture data, warm cache, native addon, metadata
concurrency, and batch size:

```bash
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 \
  --scenario initial-full --fixture all --concurrency 4 --batch-size 256
```

Then run every release-baseline Resume command listed in
`docs/benchmarks/orbis-resume-optimization.md` for both commits: clean pause on `wide`,
`deep`, and `hardlinks`; process restart on `all`; and unacknowledged pause on `all`.
Preserve both reports with their commit and artifact hashes. Compare median items/s,
traversal time, first-preview latency, checkpoint count, and final database size. Reject a
regression greater than 5 percent in the ADR-0001 guarded metrics. Dirty-tree or
one-sample runs are diagnostic only.

### Execution note

The lifecycle extraction was verified in the existing working tree with `pnpm verify`.
The prescribed two-commit comparison was not run: the user required no commits, and this
tree contains unrelated pre-existing modifications and deletions, so clean immutable
baseline/final refs and worktrees cannot be created without violating that constraint.
A one-sample all-fixture diagnostic was run on 2026-08-29 with the command above's
configuration (`--samples 1 --warmup 0`) and native metadata addon. Its raw report is
`benchmark-results/orbis-scan-run-lifecycle-diagnostic.json` (ignored). It recorded
`HEAD=e93c32490dd43d6750c0bd0a4423b24c8634d6d6`, `dirty=true`, working-tree hash
`d9ed94714ebb921fa44dee97fcf6140dc56597111cce8db41437231628cec032`, worker hash
`62baff59ec81cd3485948f954685c3f480939b8b0922ba75f17e05a95c3d3aa1`, and native addon
hash `456514e154fa33bdf22538f11099e6edcdf47613c015c6de9e82658cf9b49d1f`.

| Fixture | Items/s | Scan ms | Traversal ms | First preview ms | Publication ms | Database MiB |
|---|---:|---:|---:|---:|---:|---:|
| wide | 3,180 | 629.26 | 27.90 | 429.74 | 11.71 | 1.02 |
| deep | 737 | 348.81 | 165.65 | 44.32 | 9.77 | 0.43 |
| tiny | 20,336 | 496.70 | 150.14 | 106.36 | 9.76 | 4.83 |
| mixed | 7,537 | 268.14 | 29.49 | 72.29 | 9.72 | 1.08 |
| semantics | 24 | 288.45 | 3.10 | 35.27 | 10.03 | 0.14 |
| directories | 4,752 | 2,125.41 | 1,754.23 | 110.34 | 9.91 | 8.18 |
| hardlinks | 338 | 600.33 | 148.16 | 167.84 | 9.86 | 3.80 |

The three documented quick Resume diagnostics were also run with one measured sample,
zero warmups, concurrency 4, batch size 256, and the native addon. Their raw reports are
`benchmark-results/orbis-scan-run-lifecycle-resume-clean-wide-diagnostic.json`,
`benchmark-results/orbis-scan-run-lifecycle-resume-restart-deep-diagnostic.json`, and
`benchmark-results/orbis-scan-run-lifecycle-resume-unacknowledged-hardlinks-diagnostic.json`.

| Scenario / fixture | Items/s | First page ms | First preview ms | Completion ms | Database MiB |
|---|---:|---:|---:|---:|---:|
| clean pause / wide | 678 | 158.05 | 158.87 | 337.48 | 0.24 |
| process restart / deep | 218 | 157.87 | 158.40 | 338.40 | 0.18 |
| unacknowledged pause / hardlinks | 55 | 157.94 | 158.67 | 460.71 | 0.22 |

These diagnostics are not baseline/final regression results and must not be used to claim
compliance with the five-percent ADR-0001 guard. The clean comparison remains a follow-up
that requires permission to create the two immutable commits.

## 9. Risks

- **Module balloons into the new controller.** Mitigation: the charter's does-not-own
  list, narrow dependency ports, and two explicit publication operations. Candidate 3
  later absorbs those publication operations.
- **Atomic cutover is large.** Mitigation: the complete module and adapters land behind
  tests first. The cutover moves ownership once instead of maintaining a half-state across
  production modules. Review that slice separately and do not combine unrelated cleanup.
- **Hidden ordering bugs during extraction.** Notification timing, receipt consumption,
  publication commit order, command arbitration, and queue drain all have explicit event-
  log tests. The existing 23 controller cases remain the regression net.
- **Concurrency behavior is tightened in two places.** A completed pause or discard
  command cannot leave a concurrently prepared run active. Guarded `beginScan` rejects a
  selected-location or catalog revision change during preparation. Tests pin both cases.
  No other behavior improvement belongs in the extraction.
- **`#target` split introduces divergence.** Both publication adapters return the
  post-publication target computed exactly as today. A controller integration test pins
  publication followed by target reset.
- **Notification metadata drifts from diagnostics.** Typed transition events carry kind
  and generation. Integration tests require exactly one `snapshot-total` and
  `listener-notify` measurement for publication.
- **ADR drift.** The five Resume preparation phases stay in `refresh-engine` and
  `progressive-scanner`. The module relays phase text only. The immediate `resuming`
  snapshot remains controller-owned and same-turn.

## 10. Success criteria

- Deletion test: deleting `ScanRunLifecycle` would return the whole state machine to the
  controller.
- The controller contains no run-identity comparisons or reset-policy copies. It shrinks
  by roughly the state machine's share, with a target well under 500 lines.
- Lifecycle invariants are tested through `ScanRunLifecycle` with deterministic adapters.
  Controller tests cover only façade composition and the lifecycle notification adapter.
- Each observable lifecycle transition produces one typed event and one controller
  snapshot. Documented no-op and seal cases produce none.
- `pnpm verify` passes on the final commit. ADR-0001 benchmark reports for both recorded
  commits remain within the guardrails.

## 11. Explicitly deferred

- Candidate 3 (publication transaction module) lands in the injected
  `publishCompleted` / `publishUnchanged` / `beginScan` seam created here.
- Candidate 5 (typed resume restart protocol) — the module isolates the receipt/restart
  plumbing it will later curate.
- Candidate 6 (renderer seam derivation).
- Removing the `ORBIS_DISABLE_INCREMENTAL_SCAN` / `ORBIS_E2E_RESUME_VALIDATION_DELAY_MS`
  env hooks (preserved as-is; flagged in the review).