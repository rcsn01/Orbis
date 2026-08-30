# Orbis domain vocabulary

- **Resume preparation**: the path-free, indeterminate UI state between accepting Resume and the first resumed traversal update. It keeps the last durable construction preview visible while the worker validates history, marks replay epochs, recovers interrupted work, and starts traversal.
- **Resume validation receipt**: an in-memory proof tied to one validated descriptor, checkpoint row, database file, and SQLite sidecar set. It crosses from the main process to one worker attempt; it never authorizes a path and any mismatch returns to authoritative validation.
- **Resume replay**: schema-4 recovery of each interrupted directory from offset zero. Existing rows remain visible while epoch-marked pages refresh them; completion removes unseen direct children, then a final reconciliation rebuilds hard-link ownership, aggregates, and scheduler state. The replay-pending marker remains durable until reconciliation succeeds.
- **Scan-failure diagnostics**: a bounded, path-free, mode-0600 record in `indexes/scan-diagnostics.json`. It stores only lifecycle stages, typed checkpoint/native capability evidence, and sanitized failure codes; atomic writes are best effort and never block settlement.

Settled terms used across the codebase. Keep these meanings stable when naming
new symbols or writing docs.

- **saved location** — a user-visible logical root retained in the private
  `indexes/locations.json` catalog. Main owns its canonical path and filesystem
  identity; renderer payloads receive only its opaque ID and path-free display
  name.

- **coverage publication** — an immutable `index-<uuid>.sqlite` file named by a
  publication record in `indexes/locations.json`. One publication can cover
  several saved locations and owns their shared scan revision, exclusion
  semantics, hard-link accounting domain, and FSEvents cursor.

- **coverage publication access** — the process-local module that proves a
  coverage publication can serve a saved location, owns the active published
  index handle and location view, installs committed candidates, and owns
  transient reference artifacts. It does not own catalog durability, scan
  execution, Resume validation, or renderer navigation policy.

- **published index** — a coverage publication used as a committed read-model
  source behind `DiskIndex`; it never contains pending nodes (`finalize()`
  throws on queued work, and the resume store's `validateCandidate` rejects
  them). `current.json` is legacy migration input, not an active manifest.

- **location view** — a boundary-restricted read adapter over one coverage
  publication. It presents a saved descendant as the logical root, clips
  breadcrumbs there, and rejects focus or reveal operations outside it. It
  preserves publication-domain aggregates; it never slices or reassigns
  hard-link ownership to claim a standalone subtree total.

- **construction database** — the private worker-side SQLite file behind
  `ProgressiveScanDatabase`. It holds the in-progress scan (nodes, tasks,
  estimates, journal state, and schema-4 replay epochs) and is the source for
  `ProgressivePreview` snapshots while a scan runs. It is never published as-is;
  `finalize()` drops its construction-only tables before the file becomes a
  published index.

- **preview** — a path-free `ProgressivePreview` snapshot of the construction
  database, emitted during a scan and rebuilt from a saved construction file
  after a pause. It carries summaries, breadcrumbs, a chart, and volume
  numbers, but never filesystem paths.

- **estimate cache** — the app-private `folder-estimates.json` (mode 0600)
  holding root direct-child totals from the previous scan. It is reused as
  provisional `size_estimates` rows when a rescan starts, so the UI can show
  sizes before traversal rediscovers every child.

- **sizeAccuracy** — one of `estimated` | `partial` | `exact`. A pending node
  with a pinned estimate is `estimated`; a pending node without one is
  `partial`; a complete node with no unreadable descendants is `exact`. Never
  present a partial node as exact.

- **node read-model** — the shared row→`DatabaseNode` mapping and navigation
  queries (node by id/path, children, counts, largest items, estimated
  remainder, breadcrumbs) behind every chart data source. It is homed in
  `index-store.ts` as `NodeReadModel` with the two exported SELECT constants
  (`COMMITTED_NODE_SELECT`, `CONSTRUCTION_NODE_SELECT`) and the single
  `nodeFromRow` mapping. Breadcrumbs are all-or-nothing: a corrupt parent
  chain yields `[]`, never a partial trail.

- **hard-link path** — one row in construction schema-4 `hardlink_paths` (and in published schema 3 before finalization drops construction tables). Orbis stores these rows only for file identities whose observed link count is not exactly one. A tracked identity has all observed paths, one visible `nodes` row at the UTF-8 binary-minimum path, and one `hardlink_groups` row after reconciliation/publication. Exact single-link files have no hard-link path row.

- **ready task** — a construction directory task whose parent enumeration is terminal. `pending_children` counts unsettled direct child subtrees, while `subtree_complete` records whether the task and every descendant are terminal. Enumeration status and subtree completion are separate states.

- **scan execution** — one active worker-backed scan session. It owns worker
  creation, private message ordering, ordered progress and previews, focus and
  live-node resolution, pause acknowledgement, termination, and stale-result
  cleanup. It ends by handing a finalized candidate or unchanged result to the
  scan-run lifecycle. `CoveragePublicationAccess` validates and installs
  completed publication candidates.

- **scan run lifecycle** — the controller-side state machine above scan execution.
  It owns run identity, the generation counter, staleness discipline, the reset
  ritual (preview, saved construction, single-use resume receipt, pending
  reveals), the renderer-visible scan status, the serialized start queue, and
  sealed state. It decides when a run is terminal and hands publication outcomes
  to injected catalog-side operations. It does not own the worker session,
  catalog transactions, snapshot assembly, or renderer navigation policy. See
  `ORBIS_SCAN_RUN_LIFECYCLE_PLAN.md`.

- **publication settlement** — the catalog-side conversion of a terminal scan run's outcome into an immutable publication. It owns stale-base checks, coverage publication candidate installation, the post-commit best-effort ritual (Resume retirement, focus restore, estimate-cache store, run-file discard), and the single disposition vocabulary for stale candidates. It does not own the scan run lifecycle's run identity, worker session, renderer navigation policy, or catalog record creation.

- **publication-owned artifact** — a recognized direct child of the private
  indexes directory that Orbis may remove: a published index, construction
  database, finalized candidate, SQLite journal family, database or metadata
  staging file, or incremental reconciliation directory. A matching filename
  proves only that an entry is eligible for policy evaluation; current manifest
  and resume references still decide retention. Unrecognized entries are never
  removed.
