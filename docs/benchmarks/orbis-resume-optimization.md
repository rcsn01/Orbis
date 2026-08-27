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
- `resumeReceiptValidations` and `resumeReceiptFallbacks` remain zero until validation receipts are implemented.
- `resumeRecoveryRoots` counts highest interrupted roots reset to entry zero.
- `resumeDeletedNodes` counts descendants removed before replay.
- `resumeAffectedHardlinkIdentities` counts identities examined by the current global repair.
- `resumeRepairedAncestors` counts directory aggregate rows rebuilt.
- `resumeRepairedSchedulerRows` counts task rows rebuilt.
- `resumeReplayedEntries` counts metadata entries accepted after recovery.

`databaseCheckpoints` counts durable construction checkpoints. The terminal transaction commit is measured as work but is not counted as another checkpoint.

## Quick validation report

These one-sample runs validate schema 7 and the three lifecycle harnesses. The restart fixture creates and pauses construction in a separate process before the measured process loads it, so no controller or worker state carries across the boundary. The runs were captured from a dirty working tree and are not the release baseline.

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

Each report records the application commit, dirty state, working-tree hash, worker hash, benchmark-runner hash, native-addon hash, cache state, concurrency, and batch size. Percentage release gates remain blocked until the clean five-sample baseline exists.
