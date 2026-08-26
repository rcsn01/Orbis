# Orbis domain vocabulary

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
