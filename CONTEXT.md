# Orbis domain vocabulary

- **Resume preparation**: the path-free, indeterminate UI state between accepting Resume and the first resumed traversal update. It keeps the last durable construction preview visible while the worker validates history, recovers interrupted work, repairs the index, and starts traversal.
- **Resume validation receipt**: an in-memory proof tied to one validated descriptor, checkpoint row, database file, and SQLite sidecar set. It crosses from the main process to one worker attempt; it never authorizes a path and any mismatch returns to authoritative validation.
- **Affected recovery set**: the interrupted roots, deleted descendants, hard-link identities, owner parents, and ancestor rows captured before construction recovery mutates the database. It bounds hard-link and scheduler repair without changing the saved schema; Stage 4 still rebuilds directory aggregates globally.

Settled terms used across the codebase. Keep these meanings stable when naming
new symbols or writing docs.

- **published index** — the immutable `index-<uuid>.sqlite` file named by
  `indexes/current.json`. It is the committed read-model source behind
  `DiskIndex`; it never contains pending nodes (`finalize()` throws on queued
  work, and the resume store's `validateCandidate` rejects them).

- **construction database** — the private worker-side SQLite file behind
  `ProgressiveScanDatabase`. It holds the in-progress scan (nodes, tasks,
  estimates, journal state) and is the source for `ProgressivePreview`
  snapshots while a scan runs. It is never published as-is; `finalize()` drops
  its construction-only tables before the file becomes a published index.

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

- **hard-link path** — one row in schema-3 `hardlink_paths`. Orbis stores these rows only for file identities whose observed link count is not exactly one. A tracked identity has all observed paths, one visible `nodes` row at the UTF-8 binary-minimum path, and one `hardlink_groups` row. Exact single-link files have no hard-link path row.

- **ready task** — a construction directory task whose parent enumeration is terminal. `pending_children` counts unsettled direct child subtrees, while `subtree_complete` records whether the task and every descendant are terminal. Enumeration status and subtree completion are separate states.

- **scan execution** — one active worker-backed scan session. It owns worker
  creation, private message ordering, ordered progress and previews, focus and
  live-node resolution, pause acknowledgement, termination, and stale-result
  cleanup. It ends by handing a finalized candidate or unchanged result to the
  controller; published index validation and publication remain controller
  responsibilities.

- **publication-owned artifact** — a recognized direct child of the private
  indexes directory that Orbis may remove: a published index, construction
  database, finalized candidate, SQLite journal family, database or metadata
  staging file, or incremental reconciliation directory. A matching filename
  proves only that an entry is eligible for policy evaluation; current manifest
  and resume references still decide retention. Unrecognized entries are never
  removed.
