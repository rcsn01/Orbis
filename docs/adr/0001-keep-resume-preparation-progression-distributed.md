# ADR-0001: Keep Resume preparation progression with its owning operations

- Status: Accepted
- Date: 2026-08-28

## Context

Resume preparation reports five ordered, path-free phases:

1. `validating`
2. `history`
3. `recovering`
4. `repairing`
5. `starting`

The work behind those phases belongs to existing deep modules:

- `refresh-engine.ts` reports `validating` beside resume validation and `history` beside change-journal validation.
- `progressive-scanner.ts` reports `recovering`, `repairing`, and `starting` beside construction database recovery, repair, checkpointing, and traversal startup.
- `diagnostics.ts` owns the canonical phase vocabulary, ordering, and renderer-safe messages.
- `scan-worker.ts` is the protocol adapter.
- `scan-execution.ts` enforces ordering and rejects stale worker messages at the transport seam.
- The controller publishes an immediate `resuming` acknowledgement before worker startup so the renderer responds within one turn.

An architecture review proposed a Resume preparation module that would own the progression. Comparing several interfaces exposed two outcomes:

1. A module that only coordinates five notifications would be shallow. Its interface would closely match its implementation, and deleting it would merely return the notification calls to their current locations.
2. A genuinely deep module would need to absorb resume validation, change-journal handling, construction recovery, repair, checkpointing, and traversal startup. That move would reduce locality in modules that already own and test those operations.

## Decision

Keep each Resume preparation phase beside the operation it describes.

Do not introduce a separate Resume preparation progression module or event stream. Preserve:

- the exact five-phase vocabulary and order;
- the controller-owned immediate `resuming` acknowledgement;
- the worker protocol adapter;
- generation, request, and phase-order checks in scan execution;
- path-free messages across the worker and renderer seams.

The distributed phase notifications are an observational interface, not an independent domain workflow. A future proposal may reopen this decision only if preparation gains behavior that must be shared across multiple callers or if measurement shows that the current seam blocks a required change.

## Consequences

- Locality remains with validation, journal, construction database, and traversal implementations.
- Tests continue to assert phase order through refresh integration and protocol behavior through scan execution.
- Some understanding still requires following the refresh call path across `refresh-engine.ts` and `progressive-scanner.ts`. This is accepted because the code follows ownership of the underlying work.
- Architecture reviews should not re-suggest a phase-only coordinator unless the deletion test changes.

## Performance guard

Any future change that touches scanning or Resume preparation must compare a clean parent-commit baseline with the changed commit. Both runs must use the same machine, fixture, cache state, native addon, metadata concurrency, and batch size.

The standard full-scan comparison uses one warm-up, five measured samples, a warm cache, metadata concurrency 4, and batch size 256:

```bash
pnpm benchmark:scan -- \
  --profile baseline \
  --samples 5 \
  --warmup 1 \
  --scenario initial-full \
  --fixture all \
  --concurrency 4 \
  --batch-size 256
```

Compare median items per second, traversal time, first-preview latency, checkpoint count, and final database size. Reject a regression greater than 5 percent in throughput, first-preview latency, checkpoint count, or final database size unless a separate decision records the tradeoff.

If Resume behavior changes, also run the clean-pause, process-restart, and unacknowledged-pause scenarios documented in `docs/benchmarks/orbis-resume-optimization.md`. Dirty-tree one-sample runs are diagnostic only and cannot support a performance claim.
