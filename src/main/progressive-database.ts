import { DatabaseSync, type StatementSync } from "node:sqlite"
import { createHmac, randomBytes } from "node:crypto"
import { join } from "node:path"
import type { Breadcrumb, DirectoryScanState, NodeSummary, SizeAccuracy } from "../shared/contracts"
import type { FolderSizeEstimate } from "./scan-metadata"
import type { ChartDataSource } from "./index-store"
import type { DatabaseNode, InsertNode, ScanDatabaseMeta } from "./database"
import { measureScan } from "./diagnostics"
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION
} from "./index-manifest"

export interface DirectoryTask {
  readonly id: string
  readonly path: string
  readonly depth: number
  readonly focused: boolean
  readonly entriesRead: number
}

export interface HardLinkOwner {
  readonly nodeId: string
  readonly pathKey: string
}

type State = "building" | "paused" | "committed" | "rolled-back" | "closed"

interface AncestorDelta {
  bytes: number
  descendants: number
  unreadable: number
}

interface ObservationDelta {
  skipped: number
  unreadable: number
  disappearing: number
  symlinks: number
  nestedMounts: number
  duplicates: number
}

interface PendingFileNode {
  readonly id: string
  readonly parentId: string
  readonly name: string
  readonly path: string
  readonly ownBytes: number
  readonly device: string
  readonly inode: string
  readonly depth: number
}

interface PendingFileAlias {
  readonly parentId: string
  readonly name: string
  readonly pathKey: string
  readonly device: string
  readonly inode: string
  readonly allocatedBytes: number
}

interface PendingHardLinkOwner extends HardLinkOwner {
  readonly device: string
  readonly inode: string
}

interface MetadataBatch {
  readonly ancestorDeltas: Map<string, AncestorDelta>
  readonly directChildDeltas: Map<string, number>
  readonly observationDeltas: Map<string, ObservationDelta>
  readonly fileNodes: Map<string, PendingFileNode>
  readonly fileAliases: PendingFileAlias[]
  readonly hardLinkOwners: Map<string, PendingHardLinkOwner>
  readonly consumedEstimateRoots: Set<string>
}

export interface ProgressiveConstructionOptions {
  readonly scanId: string
  readonly nodeIdSeed?: string
  readonly journalDevice: string
  readonly journalUuid: string
  readonly journalBaseline: string
}

export interface ProgressiveSemanticTotals {
  readonly scannedItems: number
  readonly discoveredBytes: number
  readonly skippedItems: number
  readonly unreadableItems: number
  readonly disappearingItems: number
  readonly symlinks: number
  readonly nestedMounts: number
  readonly duplicateHardLinks: number
  readonly bulkMetadataEntries: number
  readonly fallbackMetadataEntries: number
  readonly activeElapsedMs: number
}

export class ProgressiveScanDatabase implements ChartDataSource {
  readonly #database: DatabaseSync
  readonly #insertNode: StatementSync
  readonly #insertFileNodeBatch: StatementSync
  readonly #insertTask: StatementSync
  readonly #insertMetadata: StatementSync
  readonly #insertDirectoryObservation: StatementSync
  readonly #incrementEnqueue: StatementSync
  readonly #incrementDirectChildren: StatementSync
  readonly #observeSkipped: StatementSync
  readonly #insertFileAlias: StatementSync
  readonly #insertFileAliasBatch: StatementSync
  readonly #getHardLinkOwner: StatementSync
  readonly #setHardLinkOwner: StatementSync
  readonly #setHardLinkOwnerBatch: StatementSync
  readonly #selectOwnedFile: StatementSync
  readonly #deleteNode: StatementSync
  readonly #applyAncestorDeltaStatement: StatementSync
  readonly #attachEstimate: StatementSync
  readonly #deleteEstimateRoot: StatementSync
  readonly #deleteEstimateStatement: StatementSync
  readonly #taskIsFocused: StatementSync
  readonly #getNodeStatement: StatementSync
  readonly #parentIdStatement: StatementSync
  readonly #estimateRootNames = new Set<string>()
  #metadataBatch: MetadataBatch | undefined
  #state: State = "building"
  #rootNodeId: string | undefined

  static create(path: string, options: ProgressiveConstructionOptions): ProgressiveScanDatabase {
    return new ProgressiveScanDatabase(path, options, false)
  }

  static openResumable(path: string): ProgressiveScanDatabase {
    return new ProgressiveScanDatabase(path, undefined, true)
  }

  constructor(path: string, options?: ProgressiveConstructionOptions, openExisting = false) {
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
      if (!openExisting) this.#database.exec(`
        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,
          parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          path TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('directory', 'file')),
          own_bytes INTEGER NOT NULL,
          size_bytes INTEGER NOT NULL,
          own_unreadable INTEGER NOT NULL DEFAULT 0,
          direct_children INTEGER NOT NULL DEFAULT 0,
          descendant_count INTEGER NOT NULL DEFAULT 0,
          unreadable_count INTEGER NOT NULL DEFAULT 0,
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          scan_state TEXT NOT NULL CHECK (scan_state IN ('queued', 'scanning', 'complete', 'unreadable')),
          enumeration_complete INTEGER NOT NULL DEFAULT 0,
          depth INTEGER NOT NULL
        );
        CREATE INDEX nodes_parent_preview ON nodes (parent_id);
        CREATE TABLE directory_tasks (
          node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          depth INTEGER NOT NULL,
          enqueue_order INTEGER NOT NULL,
          focused INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN ('queued', 'scanning', 'complete', 'unreadable')),
          entries_read INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX tasks_schedule ON directory_tasks (focused DESC, status, depth, enqueue_order);
        CREATE TABLE hardlink_owners (
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          path_key TEXT NOT NULL,
          PRIMARY KEY (device, inode)
        );
        CREATE TABLE file_aliases (
          parent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          path_key TEXT PRIMARY KEY,
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          allocated_bytes INTEGER NOT NULL CHECK (allocated_bytes >= 0),
          UNIQUE (parent_id, name)
        );
        CREATE INDEX file_aliases_parent ON file_aliases (parent_id);
        CREATE INDEX file_aliases_identity_path ON file_aliases (device, inode, path_key);
        CREATE TABLE hardlink_groups (
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          owner_path_key TEXT NOT NULL REFERENCES file_aliases(path_key),
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          allocated_bytes INTEGER NOT NULL CHECK (allocated_bytes >= 0),
          PRIMARY KEY (device, inode)
        );
        CREATE INDEX hardlink_groups_node ON hardlink_groups (node_id);
        CREATE TABLE directory_observations (
          node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          direct_skipped_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_skipped_count >= 0),
          direct_unreadable_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_unreadable_count >= 0),
          direct_disappearing_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_disappearing_count >= 0),
          direct_symlink_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_symlink_count >= 0),
          direct_nested_mount_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_nested_mount_count >= 0),
          direct_duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (direct_duplicate_count >= 0),
          enumeration_status TEXT NOT NULL CHECK (enumeration_status IN ('queued', 'scanning', 'complete', 'unreadable'))
        );
        CREATE TABLE scan_state (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
        INSERT INTO scan_state VALUES ('revision', 0), ('enqueue', 0);
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE size_estimates (
          node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
          estimated_bytes INTEGER NOT NULL,
          indexed_items INTEGER NOT NULL,
          physical_size_coverage REAL NOT NULL
        );
        CREATE TABLE estimate_roots (
          name TEXT PRIMARY KEY,
          estimated_bytes INTEGER NOT NULL,
          indexed_items INTEGER NOT NULL,
          physical_size_coverage REAL NOT NULL
        );
        CREATE TABLE scan_run (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          scan_id TEXT NOT NULL UNIQUE,
          node_id_seed TEXT NOT NULL,
          phase TEXT NOT NULL CHECK (phase IN ('traversing', 'awaiting-reconciliation', 'finalizing')),
          checkpoint_sequence INTEGER NOT NULL DEFAULT 0,
          active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
          journal_device TEXT NOT NULL,
          journal_uuid TEXT NOT NULL,
          journal_baseline TEXT NOT NULL,
          drained_through TEXT NOT NULL,
          checkpointed_at TEXT NOT NULL
        );
        CREATE TABLE scan_counters (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          bulk_metadata_entries INTEGER NOT NULL DEFAULT 0,
          fallback_metadata_entries INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE dirty_scopes (path TEXT PRIMARY KEY);
      `)
      if (!openExisting && options) {
        const seed = options.nodeIdSeed ?? randomBytes(32).toString('hex')
        if (!/^[0-9a-f]{64}$/u.test(seed)) throw new Error('Invalid progressive scan node ID seed')
        this.#database.prepare(`INSERT INTO scan_run (singleton, scan_id, node_id_seed, phase, journal_device, journal_uuid,
          journal_baseline, drained_through, checkpointed_at) VALUES (1, ?, ?, 'traversing', ?, ?, ?, ?, ?)`)
          .run(options.scanId, seed, options.journalDevice, options.journalUuid, options.journalBaseline, options.journalBaseline, new Date().toISOString())
        this.#database.exec('INSERT INTO scan_counters (singleton) VALUES (1)')
      }
      if (openExisting) {
        const root = this.#database.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').get() as { id?: string } | undefined
        this.#rootNodeId = root?.id
        const run = this.#database.prepare('SELECT 1 AS found FROM scan_run WHERE singleton = 1').get() as { found?: number } | undefined
        if (!run?.found) throw new Error('Construction database has no scan run')
      }
      this.#insertNode = this.#database.prepare(`
        INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.#insertFileNodeBatch = this.#database.prepare(`
        INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, depth)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.parentId'), json_extract(value, '$.name'),
          json_extract(value, '$.path'), 'file', json_extract(value, '$.ownBytes'), json_extract(value, '$.ownBytes'),
          json_extract(value, '$.device'), json_extract(value, '$.inode'), 'complete', 1, json_extract(value, '$.depth')
        FROM json_each(?)
      `)
      this.#insertTask = this.#database.prepare(`
        INSERT INTO directory_tasks (node_id, path, depth, enqueue_order, focused, status)
        VALUES (?, ?, ?, (SELECT value FROM scan_state WHERE key = 'enqueue'), ?, 'queued')
      `)
      this.#insertMetadata = this.#database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      this.#insertDirectoryObservation = this.#database.prepare("INSERT INTO directory_observations (node_id, enumeration_status) VALUES (?, ?)")
      this.#incrementEnqueue = this.#database.prepare("UPDATE scan_state SET value = value + 1 WHERE key = 'enqueue'")
      this.#incrementDirectChildren = this.#database.prepare("UPDATE nodes SET direct_children = direct_children + ? WHERE id = ?")
      this.#observeSkipped = this.#database.prepare(`
        UPDATE directory_observations SET direct_skipped_count = direct_skipped_count + ?,
          direct_unreadable_count = direct_unreadable_count + ?, direct_disappearing_count = direct_disappearing_count + ?,
          direct_symlink_count = direct_symlink_count + ?, direct_nested_mount_count = direct_nested_mount_count + ?,
          direct_duplicate_count = direct_duplicate_count + ? WHERE node_id = ?
      `)
      this.#insertFileAlias = this.#database.prepare(`
        INSERT INTO file_aliases (parent_id, name, path_key, device, inode, allocated_bytes) VALUES (?, ?, ?, ?, ?, ?)
      `)
      this.#insertFileAliasBatch = this.#database.prepare(`
        INSERT INTO file_aliases (parent_id, name, path_key, device, inode, allocated_bytes)
        SELECT json_extract(value, '$.parentId'), json_extract(value, '$.name'), json_extract(value, '$.pathKey'),
          json_extract(value, '$.device'), json_extract(value, '$.inode'), json_extract(value, '$.allocatedBytes')
        FROM json_each(?)
      `)
      this.#getHardLinkOwner = this.#database.prepare("SELECT node_id AS nodeId, path_key AS pathKey FROM hardlink_owners WHERE device = ? AND inode = ?")
      this.#setHardLinkOwner = this.#database.prepare(`
        INSERT INTO hardlink_owners (device, inode, node_id, path_key) VALUES (?, ?, ?, ?)
        ON CONFLICT(device, inode) DO UPDATE SET node_id = excluded.node_id, path_key = excluded.path_key
      `)
      this.#setHardLinkOwnerBatch = this.#database.prepare(`
        INSERT INTO hardlink_owners (device, inode, node_id, path_key)
        SELECT json_extract(value, '$.device'), json_extract(value, '$.inode'), json_extract(value, '$.nodeId'), json_extract(value, '$.pathKey')
        FROM json_each(?) WHERE true
        ON CONFLICT(device, inode) DO UPDATE SET node_id = excluded.node_id, path_key = excluded.path_key
      `)
      this.#selectOwnedFile = this.#database.prepare("SELECT parent_id AS parentId, size_bytes AS sizeBytes FROM nodes WHERE id = ? AND kind = 'file'")
      this.#deleteNode = this.#database.prepare("DELETE FROM nodes WHERE id = ?")
      this.#applyAncestorDeltaStatement = this.#database.prepare(`
        WITH RECURSIVE ancestors(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL SELECT nodes.parent_id FROM nodes JOIN ancestors ON nodes.id = ancestors.id WHERE nodes.parent_id IS NOT NULL
        )
        UPDATE nodes SET size_bytes = size_bytes + ?, descendant_count = descendant_count + ?, unreadable_count = unreadable_count + ?
        WHERE id IN (SELECT id FROM ancestors)
      `)
      this.#attachEstimate = this.#database.prepare(`
        INSERT INTO size_estimates (node_id, estimated_bytes, indexed_items, physical_size_coverage)
        SELECT ?, estimated_bytes, indexed_items, physical_size_coverage FROM estimate_roots WHERE name = ?
      `)
      this.#deleteEstimateRoot = this.#database.prepare("DELETE FROM estimate_roots WHERE name = ?")
      this.#deleteEstimateStatement = this.#database.prepare("DELETE FROM size_estimates WHERE node_id = ?")
      this.#taskIsFocused = this.#database.prepare("SELECT focused FROM directory_tasks WHERE node_id = ?")
      this.#getNodeStatement = this.#database.prepare(`${NODE_SELECT} WHERE n.id = ?`)
      this.#parentIdStatement = this.#database.prepare("SELECT parent_id AS parentId FROM nodes WHERE id = ?")
      const estimateRoots = this.#database.prepare("SELECT name FROM estimate_roots").all() as unknown as Array<{ name: string }>
      for (const estimate of estimateRoots) this.#estimateRootNames.add(estimate.name)
      this.#database.exec("BEGIN")
    } catch (error) {
      try { this.#database.close() } catch { /* Preserve construction error. */ }
      throw error
    }
  }

  insertRoot(node: InsertNode): void {
    this.#assertBuilding()
    this.#rootNodeId = node.id
    this.#insert(node, 0, "queued")
    this.#queue(node.id, node.path, 0, false)
  }

  insertChild(node: InsertNode, depth: number, focused: boolean): void {
    const state: DirectoryScanState = node.kind === "directory" ? "queued" : "complete"
    this.#insert(node, depth, state)
    this.#attachPendingEstimate(node)
    this.#applyAncestorDelta(node.parentId, node.ownBytes, 1, 0)
    if (node.parentId) this.#applyDirectChildDelta(node.parentId, 1)
    if (node.kind === "directory") this.#queue(node.id, node.path, depth, focused)
  }

  applyEstimates(result: FolderSizeEstimate): void {
    this.#assertBuilding()
    const rootId = this.#rootNodeId
    if (!rootId) return
    const indexedItems = result.items.length
    const coverage = 1
    const estimatedFileBytes = result.items.reduce((sum, item) => sum + safeBytes(item.estimatedBytes), 0)
    if (estimatedFileBytes > 0) {
      // Keep the aggregate as a construction-only overlay so the root can
      // show the estimate before traversal discovers every child.
      const root = this.#database.prepare("SELECT own_bytes AS ownBytes FROM nodes WHERE id = ?").get(rootId) as unknown as { ownBytes?: number } | undefined
      this.#upsertEstimate(rootId, safeBytes(root?.ownBytes) + estimatedFileBytes, indexedItems, coverage)
    }
    for (const item of result.items) {
      const name = String(item.name)
      const estimatedBytes = safeBytes(item.estimatedBytes)
      const child = this.#database.prepare("SELECT id, kind, scan_state AS scanState FROM nodes WHERE parent_id = ? AND name = ?").get(rootId, name) as unknown as { id?: string; kind?: string; scanState?: string } | undefined
      if (child?.id && child.kind === "directory" && child.scanState !== "complete" && child.scanState !== "unreadable") {
        this.#upsertEstimate(child.id, estimatedBytes, indexedItems, coverage)
        this.#consumeEstimateRoot(name)
      } else if (!child) {
        this.#database.prepare(`
          INSERT INTO estimate_roots (name, estimated_bytes, indexed_items, physical_size_coverage)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(name) DO UPDATE SET estimated_bytes = excluded.estimated_bytes,
            indexed_items = excluded.indexed_items, physical_size_coverage = excluded.physical_size_coverage
        `).run(name, estimatedBytes, indexedItems, coverage)
        this.#estimateRootNames.add(name)
      } else {
        this.#consumeEstimateRoot(name)
      }
    }
  }

  #attachPendingEstimate(node: InsertNode): void {
    if (!this.#rootNodeId || node.parentId !== this.#rootNodeId || !this.#estimateRootNames.has(node.name)) return
    if (node.kind === "directory") this.#attachEstimate.run(node.id, node.name)
    // Files do not receive provisional rows, but a stale cached entry must
    // still be consumed once exact traversal discovers them.
    this.#consumeEstimateRoot(node.name)
  }

  #consumeEstimateRoot(name: string): void {
    if (!this.#estimateRootNames.delete(name)) return
    this.#metadataBatch?.consumedEstimateRoots.add(name)
    this.#deleteEstimateRoot.run(name)
  }

  #upsertEstimate(id: string, estimatedBytes: number, indexedItems: number, coverage: number): void {
    this.#database.prepare(`
      INSERT INTO size_estimates (node_id, estimated_bytes, indexed_items, physical_size_coverage)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET estimated_bytes = excluded.estimated_bytes,
        indexed_items = excluded.indexed_items, physical_size_coverage = excluded.physical_size_coverage
    `).run(id, estimatedBytes, indexedItems, coverage)
  }

  #deleteEstimate(id: string): void {
    this.#deleteEstimateStatement.run(id)
  }

  #insert(node: InsertNode, depth: number, state: DirectoryScanState): void {
    this.#assertBuilding()
    const ownBytes = safeBytes(node.ownBytes)
    const batch = this.#metadataBatch
    if (batch && node.kind === "file" && node.parentId) {
      batch.fileNodes.set(node.id, { id: node.id, parentId: node.parentId, name: node.name, path: node.path, ownBytes, device: node.device, inode: node.inode, depth })
      return
    }
    this.#insertNode.run(node.id, node.parentId, node.name, node.path, node.kind, ownBytes, ownBytes, node.device, node.inode, state, node.kind === "file" ? 1 : 0, depth)
    if (node.kind === "directory") this.#insertDirectoryObservation.run(node.id, state)
  }

  #queue(id: string, path: string, depth: number, focused: boolean): void {
    this.#incrementEnqueue.run()
    this.#insertTask.run(id, path, depth, focused ? 1 : 0)
  }

  nextTask(focused: boolean, excludedIds: ReadonlySet<string> = new Set()): DirectoryTask | undefined {
    this.#assertBuilding()
    const exclusions = [...excludedIds]
    const excludedClause = exclusions.length > 0 ? `AND task.node_id NOT IN (${exclusions.map(() => "?").join(",")})` : ""
    const row = this.#database.prepare(`
      SELECT task.node_id AS id, task.path, task.depth, task.focused, task.entries_read AS entriesRead
      FROM directory_tasks task
      WHERE task.focused = ? AND task.status IN ('queued', 'scanning')
        ${excludedClause}
        AND NOT EXISTS (
          WITH RECURSIVE ancestors(id, parent_id, enumeration_complete) AS (
            SELECT parent.id, parent.parent_id, parent.enumeration_complete
            FROM nodes child JOIN nodes parent ON parent.id = child.parent_id WHERE child.id = task.node_id
            UNION ALL SELECT parent.id, parent.parent_id, parent.enumeration_complete
            FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
          ) SELECT 1 FROM ancestors WHERE enumeration_complete = 0
        )
      ORDER BY CASE WHEN task.depth <= 6 THEN 0 ELSE 1 END, task.depth, task.enqueue_order
      LIMIT 1
    `).get(focused ? 1 : 0, ...exclusions) as unknown as { id: string; path: string; depth: number; focused: number; entriesRead: number } | undefined
    return row ? { id: row.id, path: row.path, depth: Number(row.depth), focused: Boolean(row.focused), entriesRead: Number(row.entriesRead) } : undefined
  }

  hasPendingTasks(focused?: boolean): boolean {
    const predicate = focused === undefined ? "status IN ('queued', 'scanning')" : "focused = ? AND status IN ('queued', 'scanning')"
    const row = this.#database.prepare(`SELECT 1 AS found FROM directory_tasks WHERE ${predicate} LIMIT 1`).get(...(focused === undefined ? [] : [focused ? 1 : 0])) as { found?: number } | undefined
    return row?.found === 1
  }

  startTask(id: string): void {
    this.#database.prepare("UPDATE directory_tasks SET status = 'scanning' WHERE node_id = ? AND status = 'queued'").run(id)
    this.#database.prepare("UPDATE nodes SET scan_state = 'scanning' WHERE id = ? AND scan_state = 'queued'").run(id)
    this.#database.prepare("UPDATE directory_observations SET enumeration_status = 'scanning' WHERE node_id = ? AND enumeration_status = 'queued'").run(id)
  }

  applyMetadataBatch<T>(operation: () => T): T {
    this.#assertBuilding()
    if (this.#metadataBatch) throw new Error('Nested metadata batches are not supported')
    // Metadata pages contain siblings from one directory. Keep aggregate work
    // in memory until the page is complete so one page does not run the same
    // ancestor walk and direct-child update once per sibling.
    const parentBatch = this.#metadataBatch
    this.#database.exec('SAVEPOINT metadata_batch')
    const batch: MetadataBatch = {
      ancestorDeltas: new Map(), directChildDeltas: new Map(), observationDeltas: new Map(),
      fileNodes: new Map(), fileAliases: [], hardLinkOwners: new Map(), consumedEstimateRoots: new Set()
    }
    this.#metadataBatch = batch
    try {
      const result = operation()
      this.#flushMetadataBatch(batch)
      this.#metadataBatch = parentBatch
      this.#database.exec('RELEASE metadata_batch')
      return result
    } catch (error) {
      this.#metadataBatch = parentBatch
      for (const name of batch.consumedEstimateRoots) this.#estimateRootNames.add(name)
      this.#database.exec('ROLLBACK TO metadata_batch')
      this.#database.exec('RELEASE metadata_batch')
      throw error
    }
  }

  #flushMetadataBatch(batch: MetadataBatch): void {
    if (batch.fileNodes.size > 0) this.#insertFileNodeBatch.run(JSON.stringify([...batch.fileNodes.values()]))
    if (batch.fileAliases.length > 0) this.#insertFileAliasBatch.run(JSON.stringify(batch.fileAliases))
    if (batch.hardLinkOwners.size > 0) this.#setHardLinkOwnerBatch.run(JSON.stringify([...batch.hardLinkOwners.values()]))
    for (const [parentId, delta] of batch.ancestorDeltas) {
      if (delta.bytes === 0 && delta.descendants === 0 && delta.unreadable === 0) continue
      this.#applyAncestorDeltaStatement.run(parentId, delta.bytes, delta.descendants, delta.unreadable)
    }
    for (const [parentId, delta] of batch.directChildDeltas) {
      if (delta !== 0) this.#incrementDirectChildren.run(delta, parentId)
    }
    for (const [id, delta] of batch.observationDeltas) {
      if (delta.skipped === 0 && delta.unreadable === 0 && delta.disappearing === 0 && delta.symlinks === 0 && delta.nestedMounts === 0 && delta.duplicates === 0) continue
      this.#observeSkipped.run(delta.skipped, delta.unreadable, delta.disappearing, delta.symlinks, delta.nestedMounts, delta.duplicates, id)
    }
    batch.fileNodes.clear()
    batch.fileAliases.length = 0
    batch.hardLinkOwners.clear()
    batch.ancestorDeltas.clear()
    batch.directChildDeltas.clear()
    batch.observationDeltas.clear()
  }

  #flushPendingMetadataBatch(): void {
    const batch = this.#metadataBatch
    if (batch) this.#flushMetadataBatch(batch)
  }

  #applyDirectChildDelta(parentId: string, delta: number): void {
    const batch = this.#metadataBatch
    if (!batch) {
      this.#incrementDirectChildren.run(delta, parentId)
      return
    }
    batch.directChildDeltas.set(parentId, (batch.directChildDeltas.get(parentId) ?? 0) + delta)
  }

  advanceTask(id: string, count: number): void {
    this.#database.prepare("UPDATE directory_tasks SET entries_read = entries_read + ? WHERE node_id = ?").run(Math.max(0, Math.floor(count)), id)
  }

  yieldTask(id: string): void {
    this.#database.prepare("UPDATE scan_state SET value = value + 1 WHERE key = 'enqueue'").run()
    this.#database.prepare("UPDATE directory_tasks SET enqueue_order = (SELECT value FROM scan_state WHERE key = 'enqueue') WHERE node_id = ? AND status = 'scanning'").run(id)
  }

  finishEnumeration(id: string): void {
    this.#database.prepare("UPDATE nodes SET enumeration_complete = 1 WHERE id = ?").run(id)
    this.#database.prepare("UPDATE directory_tasks SET status = 'complete' WHERE node_id = ?").run(id)
    this.#database.prepare("UPDATE directory_observations SET enumeration_status = 'complete' WHERE node_id = ?").run(id)
    this.#completeReady(id)
  }

  markUnreadable(id: string, disappearing = false): void {
    this.#database.prepare("UPDATE nodes SET own_unreadable = 1, enumeration_complete = 1, scan_state = 'unreadable' WHERE id = ?").run(id)
    this.#database.prepare("UPDATE directory_tasks SET status = 'unreadable' WHERE node_id = ?").run(id)
    this.#database.prepare(`
      UPDATE directory_observations SET enumeration_status = 'unreadable', direct_skipped_count = direct_skipped_count + 1,
        direct_unreadable_count = direct_unreadable_count + ?, direct_disappearing_count = direct_disappearing_count + ? WHERE node_id = ?
    `).run(disappearing ? 0 : 1, disappearing ? 1 : 0, id)
    this.#deleteEstimate(id)
    this.#applyUnreadableDelta(id, 1)
    const parent = this.#parentId(id)
    if (parent) this.#completeReady(parent)
  }

  observeSkipped(id: string, observation: { readonly unreadable?: boolean; readonly disappearing?: boolean; readonly symlink?: boolean; readonly nestedMount?: boolean; readonly duplicate?: boolean } = {}): void {
    const unreadable = observation.unreadable ? 1 : 0
    const disappearing = observation.disappearing ? 1 : 0
    const symlinks = observation.symlink ? 1 : 0
    const nestedMounts = observation.nestedMount ? 1 : 0
    const duplicates = observation.duplicate ? 1 : 0
    const batch = this.#metadataBatch
    if (!batch) {
      this.#observeSkipped.run(1, unreadable, disappearing, symlinks, nestedMounts, duplicates, id)
      return
    }
    const current = batch.observationDeltas.get(id) ?? { skipped: 0, unreadable: 0, disappearing: 0, symlinks: 0, nestedMounts: 0, duplicates: 0 }
    current.skipped += 1
    current.unreadable += unreadable
    current.disappearing += disappearing
    current.symlinks += symlinks
    current.nestedMounts += nestedMounts
    current.duplicates += duplicates
    batch.observationDeltas.set(id, current)
  }

  insertFileAlias(parentId: string, name: string, pathKey: string, device: string, inode: string, allocatedBytes: number): void {
    const bytes = safeBytes(allocatedBytes)
    const batch = this.#metadataBatch
    if (batch) batch.fileAliases.push({ parentId, name, pathKey, device, inode, allocatedBytes: bytes })
    else this.#insertFileAlias.run(parentId, name, pathKey, device, inode, bytes)
  }

  #completeReady(startId: string): void {
    let id: string | null = startId
    while (id) {
      const row = this.#database.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL SELECT child.id FROM nodes child JOIN subtree parent ON child.parent_id = parent.id WHERE child.kind = 'directory'
        )
        SELECT nodes.enumeration_complete AS enumerationComplete, nodes.scan_state AS scanState,
          EXISTS(SELECT 1 FROM directory_tasks task JOIN subtree ON subtree.id = task.node_id WHERE task.status IN ('queued', 'scanning')) AS pending
        FROM nodes WHERE nodes.id = ?
      `).get(id, id) as unknown as { enumerationComplete: number; scanState: string; pending: number } | undefined
      if (!row || !row.enumerationComplete || row.pending) break
      this.#deleteEstimate(id)
      if (row.scanState !== "unreadable") this.#database.prepare("UPDATE nodes SET scan_state = 'complete' WHERE id = ?").run(id)
      id = this.#parentId(id)
    }
  }

  getEstimatedRemainder(id: string): number {
    this.#flushPendingMetadataBatch()
    const row = this.#database.prepare(`
      SELECT n.scan_state AS scanState, COALESCE(e.estimated_bytes, 0) AS estimatedBytes,
        COALESCE((SELECT SUM(
          CASE WHEN child.scan_state IN ('queued', 'scanning')
            THEN MAX(child.size_bytes, COALESCE(childEstimate.estimated_bytes, 0))
            ELSE child.size_bytes
          END
        ) FROM nodes child LEFT JOIN size_estimates childEstimate ON childEstimate.node_id = child.id WHERE child.parent_id = n.id), 0) AS childBytes
      FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id WHERE n.id = ?
    `).get(id) as unknown as { scanState?: string; estimatedBytes?: number; childBytes?: number } | undefined
    if (!row || (row.scanState !== "queued" && row.scanState !== "scanning")) return 0
    return Math.max(0, Number(row.estimatedBytes ?? 0) - Number(row.childBytes ?? 0))
  }

  promoteSubtree(id: string): boolean {
    const node = this.getNode(id)
    if (!node || node.kind !== "directory" || node.scanState === "complete" || node.scanState === "unreadable") return false
    this.#database.prepare(`
      WITH RECURSIVE subtree(id) AS (
        SELECT id FROM nodes WHERE id = ?
        UNION ALL SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
      )
      UPDATE directory_tasks SET focused = 1
      WHERE node_id IN (SELECT id FROM subtree) AND status IN ('queued', 'scanning')
    `).run(id)
    return true
  }

  taskIsFocused(id: string): boolean {
    const row = this.#taskIsFocused.get(id) as { focused?: number } | undefined
    return Boolean(row?.focused)
  }

  getHardLinkOwner(device: string, inode: string): HardLinkOwner | undefined {
    const pending = this.#metadataBatch?.hardLinkOwners.get(hardLinkIdentity(device, inode))
    if (pending) return { nodeId: pending.nodeId, pathKey: pending.pathKey }
    return this.#getHardLinkOwner.get(device, inode) as unknown as HardLinkOwner | undefined
  }

  setHardLinkOwner(device: string, inode: string, nodeId: string, pathKey: string): void {
    const batch = this.#metadataBatch
    if (batch) batch.hardLinkOwners.set(hardLinkIdentity(device, inode), { device, inode, nodeId, pathKey })
    else this.#setHardLinkOwner.run(device, inode, nodeId, pathKey)
  }

  removeOwnedFile(id: string): void {
    const pending = this.#metadataBatch?.fileNodes.get(id)
    if (pending) {
      this.#metadataBatch?.fileNodes.delete(id)
      this.#applyAncestorDelta(pending.parentId, -pending.ownBytes, -1, 0)
      this.#applyDirectChildDelta(pending.parentId, -1)
      return
    }
    const row = this.#selectOwnedFile.get(id) as unknown as { parentId: string | null; sizeBytes: number } | undefined
    if (!row) return
    this.#applyAncestorDelta(row.parentId, -Number(row.sizeBytes), -1, 0)
    if (row.parentId) this.#applyDirectChildDelta(row.parentId, -1)
    this.#deleteNode.run(id)
  }

  get scanId(): string | undefined {
    const row = this.#database.prepare('SELECT scan_id AS scanId FROM scan_run WHERE singleton = 1').get() as { scanId?: string } | undefined
    return row?.scanId
  }

  get nodeIdSeed(): string {
    const row = this.#database.prepare('SELECT node_id_seed AS seed FROM scan_run WHERE singleton = 1').get() as { seed?: string } | undefined
    if (!row?.seed) throw new Error('Construction database has no node ID seed')
    return row.seed
  }

  get checkpointSequence(): number {
    const row = this.#database.prepare('SELECT checkpoint_sequence AS sequence FROM scan_run WHERE singleton = 1').get() as { sequence?: number } | undefined
    return Number(row?.sequence ?? 0)
  }

  checkpoint(activeElapsedDeltaMs = 0): number {
    this.#assertBuilding()
    const started = Date.now()
    this.#database.prepare(`UPDATE scan_run SET checkpoint_sequence = checkpoint_sequence + 1,
      active_elapsed_ms = active_elapsed_ms + ?, checkpointed_at = ? WHERE singleton = 1`)
      .run(Math.max(0, Math.floor(activeElapsedDeltaMs)), new Date().toISOString())
    measureScan('database-checkpoint', () => this.#database.exec('COMMIT'))
    this.#database.exec('BEGIN')
    void started
    return this.checkpointSequence
  }

  pause(activeElapsedDeltaMs = 0): number {
    const sequence = this.checkpoint(activeElapsedDeltaMs)
    this.#database.exec('ROLLBACK')
    this.#state = 'paused'
    this.#close()
    return sequence
  }

  setPhase(phase: 'traversing' | 'awaiting-reconciliation' | 'finalizing'): void {
    this.#database.prepare('UPDATE scan_run SET phase = ? WHERE singleton = 1').run(phase)
  }

  addMetadataCounters(bulk: number, fallback: number): void {
    this.#database.prepare(`UPDATE scan_counters SET bulk_metadata_entries = bulk_metadata_entries + ?,
      fallback_metadata_entries = fallback_metadata_entries + ? WHERE singleton = 1`)
      .run(Math.max(0, Math.floor(bulk)), Math.max(0, Math.floor(fallback)))
  }

  get drainedThrough(): string {
    const row = this.#database.prepare('SELECT drained_through AS cursor FROM scan_run WHERE singleton = 1').get() as { cursor?: string } | undefined
    return row?.cursor ?? '0'
  }

  get dirtyScopes(): readonly string[] {
    return (this.#database.prepare('SELECT path FROM dirty_scopes ORDER BY path').all() as unknown as Array<{ path: string }>).map((row) => row.path)
  }

  setJournalDrain(scopes: readonly string[], throughEventId: string): void {
    this.#assertBuilding()
    if (scopes.length > 1024) throw new Error('resume-dirty-scopes-unbounded')
    const insert = this.#database.prepare('INSERT OR IGNORE INTO dirty_scopes (path) VALUES (?)')
    for (const path of scopes) insert.run(path)
    const count = this.#database.prepare('SELECT COUNT(*) AS count FROM dirty_scopes').get() as { count: number }
    if (Number(count.count) > 1024) throw new Error('resume-dirty-scopes-unbounded')
    this.#database.prepare('UPDATE scan_run SET drained_through = ? WHERE singleton = 1').run(throughEventId)
  }

  semanticTotals(): ProgressiveSemanticTotals {
    this.#flushPendingMetadataBatch()
    const nodes = this.#database.prepare(`SELECT COUNT(*) AS scannedItems,
      COALESCE((SELECT size_bytes FROM nodes WHERE parent_id IS NULL), 0) AS discoveredBytes FROM nodes`).get() as { scannedItems: number; discoveredBytes: number }
    const observations = this.#database.prepare(`SELECT COALESCE(SUM(direct_skipped_count), 0) AS skipped,
      COALESCE(SUM(direct_unreadable_count), 0) AS unreadable, COALESCE(SUM(direct_disappearing_count), 0) AS disappearing,
      COALESCE(SUM(direct_symlink_count), 0) AS symlinks, COALESCE(SUM(direct_nested_mount_count), 0) AS mounts,
      COALESCE(SUM(direct_duplicate_count), 0) AS duplicates FROM directory_observations`).get() as Record<string, number>
    const counters = this.#database.prepare(`SELECT bulk_metadata_entries AS bulk, fallback_metadata_entries AS fallback
      FROM scan_counters WHERE singleton = 1`).get() as { bulk?: number; fallback?: number } | undefined
    const run = this.#database.prepare('SELECT active_elapsed_ms AS elapsed FROM scan_run WHERE singleton = 1').get() as { elapsed?: number } | undefined
    return {
      scannedItems: Number(nodes.scannedItems), discoveredBytes: Number(nodes.discoveredBytes), skippedItems: Number(observations.skipped),
      unreadableItems: Number(observations.unreadable), disappearingItems: Number(observations.disappearing), symlinks: Number(observations.symlinks),
      nestedMounts: Number(observations.mounts), duplicateHardLinks: Number(observations.duplicates),
      bulkMetadataEntries: Number(counters?.bulk ?? 0), fallbackMetadataEntries: Number(counters?.fallback ?? 0), activeElapsedMs: Number(run?.elapsed ?? 0)
    }
  }

  recoverIncompleteDirectories(): { readonly retained: number; readonly reset: number } {
    this.#assertBuilding()
    this.#database.exec(`
      CREATE TEMP TABLE recovery_roots (id TEXT PRIMARY KEY);
      INSERT INTO recovery_roots SELECT task.node_id FROM directory_tasks task
      WHERE task.status IN ('queued', 'scanning') AND NOT EXISTS (
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT parent.id, parent.parent_id FROM nodes child JOIN nodes parent ON parent.id = child.parent_id WHERE child.id = task.node_id
          UNION ALL SELECT parent.id, parent.parent_id FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
        ) SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
          WHERE ancestor_task.status IN ('queued', 'scanning')
      );
      DELETE FROM file_aliases WHERE parent_id IN (SELECT id FROM recovery_roots);
      DELETE FROM nodes WHERE parent_id IN (SELECT id FROM recovery_roots);
      DELETE FROM hardlink_owners;
      UPDATE nodes SET size_bytes = own_bytes, direct_children = 0, descendant_count = 0,
        unreadable_count = own_unreadable, scan_state = 'queued', enumeration_complete = 0 WHERE id IN (SELECT id FROM recovery_roots);
      UPDATE directory_tasks SET status = 'queued', entries_read = 0 WHERE node_id IN (SELECT id FROM recovery_roots);
      UPDATE directory_observations SET direct_skipped_count = 0, direct_unreadable_count = 0,
        direct_disappearing_count = 0, direct_symlink_count = 0, direct_nested_mount_count = 0,
        direct_duplicate_count = 0, enumeration_status = 'queued' WHERE node_id IN (SELECT id FROM recovery_roots);
    `)
    this.#rebuildConstructionState()
    const counts = this.#database.prepare(`SELECT (SELECT COUNT(*) FROM directory_tasks WHERE status IN ('complete', 'unreadable')) AS retained,
      (SELECT COUNT(*) FROM recovery_roots) AS reset`).get() as { retained: number; reset: number }
    this.#database.exec('DROP TABLE recovery_roots')
    return { retained: Number(counts.retained), reset: Number(counts.reset) }
  }

  bumpRevision(): number {
    this.#database.prepare("UPDATE scan_state SET value = value + 1 WHERE key = 'revision'").run()
    return this.revision
  }

  get revision(): number {
    const row = this.#database.prepare("SELECT value FROM scan_state WHERE key = 'revision'").get() as { value?: number }
    return Number(row.value ?? 0)
  }

  getNode(id: string): DatabaseNode | undefined {
    this.#flushPendingMetadataBatch()
    const row = this.#getNodeStatement.get(id) as unknown as Record<string, unknown> | undefined
    return row ? databaseNode(row) : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    this.#flushPendingMetadataBatch()
    const safeLimit = Math.max(0, Math.min(400, Math.floor(limit)))
    if (safeLimit === 0) return []
    const rows = this.#database.prepare(`${NODE_SELECT} WHERE n.parent_id = ? ORDER BY display_size DESC, n.name COLLATE NOCASE ASC, n.id ASC LIMIT ?`).all(id, safeLimit) as unknown as Array<Record<string, unknown>>
    return rows.map(databaseNode)
  }

  countChildren(id: string): number {
    this.#flushPendingMetadataBatch()
    const row = this.#database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?").get(id) as { count?: number }
    return Number(row.count ?? 0)
  }

  getLargestItems(id: string): readonly NodeSummary[] {
    return this.getChildren(id, 100).map((node) => ({ id: node.id, parentId: node.parentId, name: node.name, kind: node.kind, sizeBytes: node.sizeBytes, ...(node.estimatedBytes > 0 ? { estimatedSizeBytes: node.estimatedBytes } : {}), directChildren: node.directChildren, descendantCount: node.descendantCount, unreadableCount: node.unreadableCount, scanState: node.scanState, sizeAccuracy: node.sizeAccuracy }))
  }

  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    const rows = this.#database.prepare(`
      WITH RECURSIVE trail(id, parent_id, name, depth) AS (
        SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
        UNION ALL SELECT nodes.id, nodes.parent_id, nodes.name, trail.depth + 1 FROM nodes JOIN trail ON nodes.id = trail.parent_id
      ) SELECT id, name FROM trail ORDER BY depth DESC
    `).all(id) as unknown as Breadcrumb[]
    return rows.map((row) => ({ id: String(row.id), name: String(row.name) }))
  }

  resolvePath(id: string): string | undefined {
    const row = this.#database.prepare("SELECT path FROM nodes WHERE id = ?").get(id) as { path?: string } | undefined
    return row?.path
  }

  writeMetadata(meta: ScanDatabaseMeta): void {
    this.#insertMetadata.run("target", meta.target)
    this.#insertMetadata.run("rootId", meta.rootId)
    this.#insertMetadata.run("volume", JSON.stringify({ capacityBytes: meta.capacityBytes, freeBytes: meta.freeBytes }))
    this.#insertMetadata.run("totals", JSON.stringify(meta.totals))
    this.#insertMetadata.run("scannedBytes", String(meta.scannedBytes))
    this.#insertMetadata.run("schemaVersion", String(PERSISTENT_INDEX_SCHEMA_VERSION))
    this.#insertMetadata.run("accountingVersion", PERSISTENT_ACCOUNTING_VERSION)
    this.#insertMetadata.run("targetDevice", meta.targetDevice ?? "")
    this.#insertMetadata.run("targetInode", meta.targetInode ?? "")
    this.#insertMetadata.run("indexDirectoryIdentity", meta.indexDirectoryIdentity ?? "")
    this.#insertMetadata.run("exclusionPolicyVersion", EXCLUSION_POLICY_VERSION)
    this.#insertMetadata.run("hardLinkOrderingVersion", HARD_LINK_ORDERING_VERSION)
    this.#insertMetadata.run("indexRevision", String(meta.indexRevision ?? 1))
    this.#insertMetadata.run("capturedAt", meta.capturedAt ?? new Date().toISOString())
    this.#insertMetadata.run("refreshedAt", meta.refreshedAt ?? meta.capturedAt ?? new Date().toISOString())
    if (meta.resume) {
      this.#insertMetadata.run('resumeDrainedThrough', meta.resume.drainedThrough)
      this.#insertMetadata.run('resumeDirtyScopes', JSON.stringify(meta.resume.dirtyScopes))
    }
  }

  finalize(): void {
    this.#assertBuilding()
    const pending = this.#database.prepare("SELECT COUNT(*) AS count FROM directory_tasks WHERE status IN ('queued', 'scanning')").get() as { count: number }
    if (Number(pending.count) !== 0) throw new Error("Cannot publish an index with queued directory work")
    this.#database.exec(`
      CREATE INDEX nodes_parent_size ON nodes (parent_id, size_bytes DESC, name COLLATE NOCASE ASC, id ASC);
      INSERT INTO hardlink_groups (device, inode, owner_path_key, node_id, allocated_bytes)
        SELECT nodes.device, nodes.inode, aliases.path_key, nodes.id, nodes.own_bytes
        FROM nodes JOIN file_aliases aliases
          ON aliases.parent_id = nodes.parent_id AND aliases.name = nodes.name
            AND aliases.device = nodes.device AND aliases.inode = nodes.inode
        WHERE nodes.kind = 'file' AND nodes.device <> '' AND nodes.inode <> '';
      DROP INDEX nodes_parent_preview;
      DROP TABLE directory_tasks;
      DROP TABLE hardlink_owners;
      DROP TABLE scan_state;
      DROP TABLE size_estimates;
      DROP TABLE estimate_roots;
      DROP TABLE dirty_scopes;
      DROP TABLE scan_counters;
      DROP TABLE scan_run;
    `)
  }

  complete(): void {
    this.#assertBuilding()
    measureScan("database-commit", () => this.#database.exec("COMMIT"))
    this.#state = "committed"
    try { measureScan("database-optimize", () => this.#database.exec("PRAGMA optimize")) }
    finally { this.#close() }
  }

  discard(): void { this.abort() }

  abort(): void {
    if (this.#state === "closed" || this.#state === "rolled-back") return
    if (this.#state === "building") {
      try { this.#database.exec("ROLLBACK") } catch { /* Preserve scan error. */ }
      this.#state = "rolled-back"
    }
    try { this.#close() } catch { /* Preserve scan error. */ }
  }

  #rebuildConstructionState(): void {
    this.#database.prepare(`UPDATE directory_observations SET direct_skipped_count = MAX(0, direct_skipped_count - direct_duplicate_count),
      direct_duplicate_count = 0`).run()
    const aliases = this.#database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode,
      allocated_bytes AS allocatedBytes FROM file_aliases`).all() as unknown as Array<{ parentId: string; name: string; pathKey: string; device: string; inode: string; allocatedBytes: number }>
    const groups = new Map<string, typeof aliases>()
    for (const alias of aliases) {
      if (alias.device === '' || alias.inode === '') continue
      const key = `${alias.device}\0${alias.inode}`
      const group = groups.get(key) ?? []
      group.push(alias)
      groups.set(key, group)
    }
    const seed = Buffer.from(this.nodeIdSeed, 'hex')
    for (const group of groups.values()) {
      group.sort((left, right) => Buffer.compare(Buffer.from(left.pathKey, 'utf8'), Buffer.from(right.pathKey, 'utf8')))
      const owner = group[0]!
      const existing = this.#database.prepare("SELECT id FROM nodes WHERE kind = 'file' AND device = ? AND inode = ?").all(owner.device, owner.inode) as unknown as Array<{ id: string }>
      for (const row of existing) this.#database.prepare('DELETE FROM nodes WHERE id = ?').run(row.id)
      const parent = this.#database.prepare('SELECT path, depth FROM nodes WHERE id = ?').get(owner.parentId) as { path?: string; depth?: number } | undefined
      if (!parent?.path) continue
      const id = `n-${createHmac('sha256', seed).update(owner.parentId).update('\0').update(owner.name).digest('hex').slice(0, 32)}`
      this.#insertNode.run(id, owner.parentId, owner.name, join(parent.path, owner.name), 'file', owner.allocatedBytes, owner.allocatedBytes, owner.device, owner.inode, 'complete', 1, Number(parent.depth ?? 0) + 1)
      this.setHardLinkOwner(owner.device, owner.inode, id, owner.pathKey)
      for (const duplicate of group.slice(1)) this.#database.prepare(`UPDATE directory_observations SET direct_skipped_count = direct_skipped_count + 1,
        direct_duplicate_count = direct_duplicate_count + 1 WHERE node_id = ?`).run(duplicate.parentId)
    }
    this.#database.exec(`
      UPDATE nodes SET direct_children = (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id);
      UPDATE nodes SET size_bytes = own_bytes, descendant_count = 0, unreadable_count = own_unreadable;
      WITH RECURSIVE closure(ancestor, descendant) AS (
        SELECT parent_id, id FROM nodes WHERE parent_id IS NOT NULL
        UNION ALL SELECT nodes.parent_id, closure.descendant FROM nodes JOIN closure ON nodes.id = closure.ancestor WHERE nodes.parent_id IS NOT NULL
      ), totals AS (
        SELECT ancestor, SUM(nodes.own_bytes) AS bytes, COUNT(*) AS descendants, SUM(nodes.own_unreadable) AS unreadable
        FROM closure JOIN nodes ON nodes.id = closure.descendant GROUP BY ancestor
      ) UPDATE nodes SET size_bytes = own_bytes + COALESCE((SELECT bytes FROM totals WHERE ancestor = nodes.id), 0),
        descendant_count = COALESCE((SELECT descendants FROM totals WHERE ancestor = nodes.id), 0),
        unreadable_count = own_unreadable + COALESCE((SELECT unreadable FROM totals WHERE ancestor = nodes.id), 0);
    `)
  }

  #applyAncestorDelta(parentId: string | null, bytes: number, descendants: number, unreadable: number): void {
    if (!parentId) return
    const batch = this.#metadataBatch
    if (!batch) {
      this.#applyAncestorDeltaStatement.run(parentId, bytes, descendants, unreadable)
      return
    }
    const delta = batch.ancestorDeltas.get(parentId) ?? { bytes: 0, descendants: 0, unreadable: 0 }
    delta.bytes += bytes
    delta.descendants += descendants
    delta.unreadable += unreadable
    batch.ancestorDeltas.set(parentId, delta)
  }

  #applyUnreadableDelta(id: string, delta: number): void {
    this.#applyAncestorDelta(id, 0, 0, delta)
  }

  #parentId(id: string): string | null {
    const row = this.#parentIdStatement.get(id) as unknown as { parentId: string | null } | undefined
    return row?.parentId ?? null
  }

  #assertBuilding(): void { if (this.#state !== "building") throw new Error(`Scan database is ${this.#state}`) }
  #close(): void {
    if (this.#state === "closed") return
    try { measureScan("database-close", () => this.#database.close()) }
    finally { this.#state = "closed" }
  }
}

const NODE_SELECT = `SELECT n.id, n.parent_id AS parentId, n.name, n.path, n.kind,
  n.size_bytes AS confirmedBytes,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN MAX(n.size_bytes, COALESCE(e.estimated_bytes, 0)) ELSE n.size_bytes END AS display_size,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN COALESCE(e.estimated_bytes, 0) ELSE 0 END AS estimatedBytes,
  n.direct_children AS directChildren, n.descendant_count AS descendantCount,
  n.unreadable_count AS unreadableCount, n.own_unreadable AS ownUnreadable, n.scan_state AS scanState
  FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id`

function databaseNode(row: Record<string, unknown>): DatabaseNode {
  const state = String(row.scanState)
  const scanState: DirectoryScanState = state === "queued" || state === "scanning" || state === "unreadable" ? state : "complete"
  const confirmedBytes = safeBytes(row.confirmedBytes)
  const estimatedBytes = scanState === "queued" || scanState === "scanning" ? safeBytes(row.estimatedBytes) : 0
  const unreadableCount = Math.max(0, Number(row.unreadableCount ?? 0))
  const sizeAccuracy: SizeAccuracy = scanState === "complete" && unreadableCount === 0 && row.ownUnreadable !== 1
    ? "exact"
    : scanState === "queued" || scanState === "scanning"
      ? estimatedBytes > 0 ? "estimated" : "partial"
      : "partial"
  return {
    id: String(row.id), parentId: row.parentId === null ? null : String(row.parentId), name: String(row.name), path: String(row.path),
    kind: row.kind === "directory" ? "directory" : "file", sizeBytes: safeBytes(row.display_size), confirmedBytes, estimatedBytes,
    directChildren: Math.max(0, Number(row.directChildren ?? 0)), descendantCount: Math.max(0, Number(row.descendantCount ?? 0)),
    unreadableCount, scanState, sizeAccuracy
  }
}

function hardLinkIdentity(device: string, inode: string): string { return `${device}\0${inode}` }
function safeBytes(value: unknown): number { const number = typeof value === "bigint" ? Number(value) : Number(value); return Number.isFinite(number) && number > 0 ? number : 0 }
