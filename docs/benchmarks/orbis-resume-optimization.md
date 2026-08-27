# Orbis resume optimization benchmarks

## Stage 1 instrumentation

Stage 1 records the current resume path before validation and recovery are optimized. Report schema 7 separates enclosing phases, nested work, and elapsed milestones.

### Timing interpretation

Enclosing and sequential phases are attributable parts of resume wall time:

- `resume-load-total`
- `resume-history-validation`
- `resume-database-open`
- `resume-incomplete-recovery`
- `resume-semantic-totals`
- `resume-checkpoint`

Nested work phases describe work inside validation or recovery. Do not add them to their enclosing phase:

- Descriptor, file, candidate, construction, integrity, and foreign-key validation
- Hard-link, aggregate, and scheduler repair

`resume-first-metadata-page` is an elapsed milestone from worker refresh entry. Controller milestones measure from the Resume invocation to worker preparation, progress, accepted metadata, and the first preview containing that metadata.

### Counter interpretation

- `resumeFullValidations` counts SQLite files subjected to authoritative integrity validation.
- `resumeReceiptValidations` counts loads accepted by a process-local receipt.
- `resumeReceiptFallbacks` counts receipt mismatches that then entered authoritative validation. A fallback never authorizes a resume by itself.
- `resumeRecoveryRoots` counts highest interrupted roots reset to entry zero.
- `resumeDeletedNodes` counts descendants removed before replay.
- `resumeAffectedHardlinkIdentities` counts identities captured from reset roots and their deleted descendants.
- `resumeRepairedAncestors` counts directory aggregate rows rebuilt by the Stage 4 global aggregate pass; Stage 5 will narrow this set.
- `resumeRepairedSchedulerRows` counts task rows in reset-root and affected owner-parent ancestor chains.
- `resumeReplayedEntries` counts metadata entries accepted after recovery.

`databaseCheckpoints` counts durable construction checkpoints. The terminal transaction commit is measured as work but is not counted as another checkpoint.

## Clean Stage 1 baseline

The fixed pre-optimization baseline was captured from commit `80ca1ce381d4b3e7bd0bea35edc26577045b511d` with a clean tree. Every report used one warmup and five measured samples, progressive scanning, a warm cache, metadata concurrency 4, and batch size 256. The host was macOS 26.4 on an Apple M5 Pro with 18 logical CPUs and 64 GiB RAM, running Node 22.22.3 on arm64.

Artifact hashes matched across all five reports:

- Worker: `2ee8aa54729a200ce715f5a87ad115fdf606e9fc9ff008dc3accb730b16c8bbe`
- Benchmark runner: `68a0f8d766f56b0e8326152760587eabad5abcb2233a33bb852176a08866bdbe`
- Native addon: `456514e154fa33bdf22538f11099e6edcdf47613c015c6de9e82658cf9b49d1f`

Selected resume timings are median / p95 / MAD in milliseconds:

| Scenario | Fixture | Click to preparation | Click to first page | Click to first preview | Completion |
|---|---|---:|---:|---:|---:|
| Clean Pause | wide | 18.28 / 18.39 / 0.11 | 188.05 / 191.27 / 0.64 | 188.87 / 192.05 / 0.68 | 418.22 / 422.96 / 3.32 |
| Clean Pause | deep | 19.03 / 19.34 / 0.29 | 174.91 / 176.40 / 1.49 | 175.50 / 176.88 / 1.38 | 473.03 / 629.53 / 5.83 |
| Clean Pause | hardlinks | 17.90 / 19.66 / 0.37 | 279.29 / 295.45 / 16.17 | 281.45 / 297.10 / 15.65 | 744.87 / 862.86 / 113.53 |
| Process restart, all fixtures | range | 20.48 to 22.61 median | 158.77 to 269.46 median | 159.07 to 271.06 median | 329.47 to 2416.87 median |
| Unacknowledged Pause, all fixtures | range | 18.98 to 20.22 median | 160.54 to 274.73 median | 160.94 to 275.04 median | 393.46 to 2176.46 median |

For the three clean-Pause fixtures, median `resume-load-total` was 2.69 to 3.66 ms, FSEvents history validation was 119.87 to 162.61 ms, incomplete recovery was 0.63 to 4.87 ms, and the durable resume checkpoint was 0.22 to 0.27 ms. Median recovery counters were one reset root and 32 deleted nodes for wide, one root and no deleted nodes for deep, and 96 reset roots with 100 affected hard-link identities for hardlinks. Restart and unacknowledged-Pause reports retained the expected fixture-specific rows and final counters.

All 85 measured resume samples loaded through `validateScanBenchmarkReport()`. Every sample recorded exactly one full validation, zero receipt validations, and zero receipt fallbacks. These reports are the fixed Stage 1 baseline for Stages 3 through 5:

- `benchmark-results/orbis-resume-stage1-clean-wide-baseline.json`
- `benchmark-results/orbis-resume-stage1-clean-deep-baseline.json`
- `benchmark-results/orbis-resume-stage1-clean-hardlinks-baseline.json`
- `benchmark-results/orbis-resume-stage1-restart-all-baseline.json`
- `benchmark-results/orbis-resume-stage1-unacknowledged-all-baseline.json`

Stage 2 changes when feedback appears. It does not reduce validation or recovery cost, and Stage 2 diagnostics must not replace these reports.

## Stage 2 diagnostic runs

After Stage 2, one-sample quick runs passed for clean Pause on wide, process restart on deep, and unacknowledged Pause on hardlinks. Schema, final rows, and resume counters remained valid. The reports are `orbis-resume-stage2-clean-quick.json`, `orbis-resume-stage2-restart-quick.json`, and `orbis-resume-stage2-unacknowledged-quick.json` under `benchmark-results/`. These dirty-tree, one-sample diagnostics do not support a speed claim and do not replace the Stage 1 baseline.

## Stage 3 receipt checks

Stage 3 keeps receipts in the main process and passes one receipt to the worker for a single resume attempt. The store repeats descriptor, identity, file-stamp, sidecar, and checkpoint checks. A mismatch falls through to the existing authoritative validation path. Clean acknowledged Pause uses a separate checkpoint proof and skips the integrity and foreign-key scans. Startup, crash, timeout, and unacknowledged paths still perform authoritative validation before any later worker resume.

The benchmark's `resume.validation` field describes the measured worker. It uses the measured counters with this precedence: `receipt-fallback`, then `receipt`, then `full`. This matters for restart and unacknowledged scenarios. Startup validation happens before the measured worker starts, so those workers can report `receipt` even though startup did the authoritative validation.

One-sample quick checks on the tiny fixture produced a `receipt` classification for clean Pause, process restart, and unacknowledged Pause. Each measured worker recorded `resumeFullValidations: 0`, `resumeReceiptValidations: 1`, and `resumeReceiptFallbacks: 0`. These checks validate the handoff and classification logic, not a speed claim.

## Stage 4 scoped recovery checks

Stage 4 captures interrupted roots, their deleted descendants, affected hard-link identities, owner parents, and ancestor rows in connection-local temporary tables before mutation. Hard-link and scheduler repair are scoped to that set. Directory aggregates remain a global rebuild until Stage 5; the `resumeRepairedAncestors` counter makes that boundary explicit.

Focused lifecycle coverage verifies two interrupted roots, focus transfer, external owner reuse and recreation, unaffected identities, exact single-link files, last-path removal, binary path ordering, scheduler readiness, and structural `hardlink_groups` rejection. The recovery transaction preserves the durable checkpoint for ordinary SQL or representative errors; only the explicit invalid-resume construction check enters restart handling.

The requested one-sample schema-7 checks also passed on the dirty tree. They classified Resume as `receipt` and recorded nonzero recovery roots and replayed entries:

| Scenario / fixture | Recovery roots | Affected identities | Repaired ancestors | Repaired scheduler rows | Replayed entries |
|---|---:|---:|---:|---:|---:|
| Clean Pause / wide | 1 | 0 | 1 | 1 | 200 |
| Process restart / deep | 1 | 0 | 17 | 17 | 33 |
| Unacknowledged Pause / hardlinks | 6 | 0 | 13 | 8 | 114 |

These small runs validate report shape and lifecycle counters, not performance.

## Quick validation report

These one-sample Stage 1 runs validate schema 7 and the three lifecycle harnesses. The restart fixture creates and pauses construction in a separate process before the measured process loads it, so no controller or worker state carries across the boundary. The runs were captured from a dirty working tree and are not the release baseline.

| Scenario | Fixture | Click to preparation | Click to first page | Click to first preview | Completion |
|---|---:|---:|---:|---:|---:|
| Clean Pause and Resume | wide | 17.88 ms | 152.88 ms | 153.56 ms | 311.44 ms |
| Process restart | deep | 26.19 ms | 167.97 ms | 168.42 ms | 339.23 ms |
| Unacknowledged Pause | hardlinks | 23.49 ms | 165.26 ms | 166.12 ms | 330.68 ms |

The quick samples all performed one full validation. The dominant pre-traversal phase was FSEvents history validation at 114.91 to 117.50 ms. Raw ignored reports are:

- `benchmark-results/orbis-resume-stage1-clean-quick.json`
- `benchmark-results/orbis-resume-stage1-restart-quick.json`
- `benchmark-results/orbis-resume-stage1-unacknowledged-quick.json`

The hard-link scenario exposed a recovery defect: deleting `hardlink_owners` and then skipping an unchanged singleton representative failed to restore its owner row. Replay could create a second representative and finalization failed the hard-link group uniqueness constraint. Recovery now reinstates that owner before replay; a construction lifecycle regression covers it.

## Commands

Quick lifecycle checks:

```bash
pnpm benchmark:scan -- --profile quick --samples 1 --warmup 0 --scenario resume-clean-pause --fixture wide
pnpm benchmark:scan -- --profile quick --samples 1 --warmup 0 --scenario resume-process-restart --fixture deep
pnpm benchmark:scan -- --profile quick --samples 1 --warmup 0 --scenario resume-unacknowledged-pause --fixture hardlinks
```

The release baseline requires a fixed commit and clean tree:

```bash
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 --scenario resume-clean-pause --fixture wide
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 --scenario resume-clean-pause --fixture deep
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 --scenario resume-clean-pause --fixture hardlinks
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 --scenario resume-process-restart --fixture all
pnpm benchmark:scan -- --profile baseline --samples 5 --warmup 1 --scenario resume-unacknowledged-pause --fixture all
```

Each report records the application commit, dirty state, working-tree hash, worker hash, benchmark-runner hash, native-addon hash, cache state, concurrency, and batch size. Use the clean reports above for percentage release gates. Dirty-tree quick reports remain diagnostic only.
