import { closeSync, copyFileSync, fsyncSync, linkSync, openSync, renameSync, rmSync } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { createHmac, randomBytes } from "node:crypto"
import { dirname, join, resolve } from "node:path"
import type { Breadcrumb, DirectoryScanState, NodeSummary } from "../shared/contracts"
import type { FolderSizeEstimate } from "./scan-metadata"
import { NodeReadModel, toSummary } from "./index-store"
import type { ChartDataSource } from "./index-store"
import type { DatabaseNode, InsertNode, ScanDatabaseMeta } from "./database"
import { createScanTimingAccumulator, measureScan, measureScanWork, recordScanCounter } from "./diagnostics"
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

export interface ConstructionWorkRequest {
  readonly limit: number
  readonly focusTurns: number
}

export interface ConstructionWorkBatch {
  readonly work: readonly DirectoryTask[]
  readonly focusTurns: number
  readonly done: boolean
}

export interface ResumeRecoveryReport {
  readonly roots: number
  readonly deletedNodes: number
  readonly affectedHardlinkIdentities: number
  readonly repairedAncestors: number
  readonly repairedSchedulerRows: number
}

export type ConstructionErrorCode =
  | "stale-work"
  | "invalid-resume"
  | "illegal-transition"
  | "pending-work"
  | "candidate-failure"

export class ConstructionError extends Error {
  constructor(readonly code: ConstructionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ConstructionError"
  }
}

class ScopedAggregateMismatch extends Error {
  constructor(readonly nodeId: string) {
    super(`Scoped aggregate repair did not converge for directory ${nodeId}`)
    this.name = "ScopedAggregateMismatch"
  }
}

export interface ConstructionStatus {
  readonly phase: ConstructionPhase
  readonly revision: number
  readonly checkpointSequence: number
  readonly totals: ProgressiveSemanticTotals
  readonly drainedThrough: string
  readonly dirtyScopes: readonly string[]
}

export interface HardLinkOwner {
  readonly nodeId: string
  readonly pathKey: string
}

export type ConstructionPhase = "scanning" | "paused" | "awaiting-reconciliation" | "finalizing"

export type ConstructionCheckpointReason = "startup" | "resume" | "scheduled" | "journal-drain" | "pause" | "finalize"

export interface ConstructionJournalDrain {
  readonly scopes: readonly string[]
  readonly throughEventId: string
}

export interface ConstructionCheckpointRequest {
  readonly reason?: ConstructionCheckpointReason
  readonly activeElapsedDeltaMs?: number
  readonly journalDrain?: ConstructionJournalDrain
}

export interface ConstructionNodeEntry {
  readonly node: InsertNode
  readonly pathKey: string
  readonly linkCount?: number
}

export interface ConstructionSkippedEntry {
  readonly kind: "skipped"
  readonly observation?: {
    readonly unreadable?: boolean
    readonly disappearing?: boolean
    readonly symlink?: boolean
    readonly nestedMount?: boolean
  }
}

export interface ConstructionNodePageEntry {
  readonly kind: "node"
  readonly node: ConstructionNodeEntry
}

export type ConstructionPageEntry = ConstructionSkippedEntry | ConstructionNodePageEntry

export interface ConstructionPage {
  readonly taskId: string
  readonly depth: number
  readonly focused: boolean
  readonly entriesRead: number
  readonly done: boolean
  readonly entries: readonly ConstructionPageEntry[]
  readonly bulkMetadataEntries: number
  readonly fallbackMetadataEntries: number
  readonly checkpointAfter?: ConstructionCheckpointRequest
}

export interface ConstructionUnreadableInput {
  readonly kind: "unreadable"
  readonly taskId: string
  readonly disappearing: boolean
  readonly checkpointAfter?: ConstructionCheckpointRequest
}

export type ConstructionInput = { readonly kind: "page"; readonly page: ConstructionPage } | ConstructionUnreadableInput

export interface ConstructionPageResult {
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
}

type MutableConstructionPageResult = { -readonly [Key in keyof ConstructionPageResult]: ConstructionPageResult[Key] }

export type ConstructionFinishCommand =
  | { readonly kind: "pause"; readonly activeElapsedDeltaMs?: number; readonly journalDrain?: ConstructionJournalDrain }
  | { readonly kind: "unexpected-failure"; readonly cause?: unknown }
  | { readonly kind: "finalize"; readonly metadata?: ScanDatabaseMeta; readonly checkpoint?: ConstructionCheckpointRequest }

export type ConstructionFinishResult =
  | { readonly kind: "paused"; readonly checkpointSequence: number }
  | { readonly kind: "failed"; readonly checkpointSequence: number }
  | { readonly kind: "candidate"; readonly candidatePath: string; readonly metadata: ScanDatabaseMeta }

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

interface PendingHardLinkPath {
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
  readonly hardlinkPaths: PendingHardLinkPath[]
  readonly hardLinkOwners: Map<string, PendingHardLinkOwner>
}

export interface ProgressiveConstructionOptions {
  readonly scanId: string
  readonly nodeIdSeed?: string
  readonly journalDevice: string
  readonly journalUuid: string
  readonly journalBaseline: string
  readonly candidatePath?: string
  readonly clock?: () => number
  readonly onCheckpoint?: (reason: ConstructionCheckpointReason, sequence: number) => void
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

export class ConstructionDatabase implements ChartDataSource {
  readonly #path: string
  readonly #candidatePath: string | undefined
  readonly #clock: () => number
  readonly #resumable: boolean
  readonly #onCheckpoint: ((reason: ConstructionCheckpointReason, sequence: number) => void) | undefined
  readonly #database: DatabaseSync
  readonly #insertNode: StatementSync
  readonly #insertFileNodeBatch: StatementSync
  readonly #insertTask: StatementSync
  readonly #insertMetadata: StatementSync
  readonly #insertDirectoryObservation: StatementSync
  readonly #incrementEnqueue: StatementSync
  readonly #incrementDirectChildren: StatementSync
  readonly #observeSkipped: StatementSync
  readonly #insertHardLinkPath: StatementSync
  readonly #insertHardLinkPathBatch: StatementSync
  readonly #getHardLinkOwner: StatementSync
  readonly #setHardLinkOwner: StatementSync
  readonly #setHardLinkOwnerBatch: StatementSync
  readonly #selectOwnedFile: StatementSync
  readonly #deleteNode: StatementSync
  readonly #applyAncestorDeltaStatement: StatementSync
  readonly #applyNodeDeltaStatement: StatementSync
  readonly #nodeTotalsStatement: StatementSync
  readonly #nodeScanStateStatement: StatementSync
  readonly #attachEstimate: StatementSync
  readonly #deleteEstimateRoot: StatementSync
  readonly #deleteEstimateStatement: StatementSync
  readonly #taskIsFocused: StatementSync
  readonly #parentIdStatement: StatementSync
  readonly #selectReadyFocused: StatementSync
  readonly #selectReadyNormal: StatementSync
  readonly #readModel: NodeReadModel
  readonly #estimateRootNames = new Set<string>()
  // The metadata batch is a long-lived accumulator: it survives across
  // applyMetadataBatch calls and is flushed on a size/time threshold, on any
  // read, and before every checkpoint/finalize/complete. Task-queue state is
  // never batched, so scheduling stays immediate.
  #metadataBatch: MetadataBatch = {
    ancestorDeltas: new Map(), directChildDeltas: new Map(), observationDeltas: new Map(),
    fileNodes: new Map(), hardlinkPaths: [], hardLinkOwners: new Map()
  }
  #inMetadataOperation = false
  #consumedEstimateRoots = new Set<string>()
  #lastBatchFlushAt = 0
  // Per-node record of the totals already propagated to the parent. Only
  // unreadable nodes propagate more than once (at mark time and again when
  // their subtree finishes), so the record lets the second propagation send
  // exactly the delta since the first.
  readonly #propagatedToParent = new Map<string, { readonly bytes: number; readonly descendants: number; readonly unreadable: number }>()
  #state: State = "building"
  #rootNodeId: string | undefined
  readonly #leasedTaskIds: string[] = []
  #pendingSubtrees = 0

  static create(path: string, options: ProgressiveConstructionOptions): ConstructionDatabase {
    return new ConstructionDatabase(path, options, false)
  }

  static openResumable(path: string, options?: Pick<ProgressiveConstructionOptions, "candidatePath" | "clock" | "onCheckpoint">): ConstructionDatabase {
    return new ConstructionDatabase(path, options, true)
  }

  constructor(path: string, options?: ProgressiveConstructionOptions | Pick<ProgressiveConstructionOptions, "candidatePath" | "clock" | "onCheckpoint">, openExisting = false) {
    this.#path = path
    this.#candidatePath = options?.candidatePath
    this.#clock = options?.clock ?? Date.now
    this.#onCheckpoint = options?.onCheckpoint
    this.#lastBatchFlushAt = this.#clock()
    this.#resumable = openExisting || Boolean(options && 'scanId' in options)
    this.#database = new DatabaseSync(path)
    try {
      this.#database.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;")
      if (openExisting) migrateConstructionSchema(this.#database)
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
          entries_read INTEGER NOT NULL DEFAULT 0,
          ready INTEGER NOT NULL CHECK (ready IN (0,1)),
          pending_children INTEGER NOT NULL DEFAULT 0 CHECK (pending_children >= 0),
          subtree_complete INTEGER NOT NULL DEFAULT 0 CHECK (subtree_complete IN (0,1)),
          shallow_band INTEGER NOT NULL CHECK (shallow_band IN (0,1))
        );
        CREATE INDEX tasks_ready_schedule ON directory_tasks (ready, focused, status, shallow_band, depth, enqueue_order);
        CREATE TABLE hardlink_owners (
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          path_key TEXT NOT NULL,
          PRIMARY KEY (device, inode)
        );
        CREATE TABLE hardlink_paths (
          parent_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          path_key TEXT PRIMARY KEY,
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          allocated_bytes INTEGER NOT NULL CHECK (allocated_bytes >= 0),
          UNIQUE (parent_id, name)
        );
        CREATE INDEX hardlink_paths_parent ON hardlink_paths (parent_id);
        CREATE INDEX hardlink_paths_identity_path ON hardlink_paths (device, inode, path_key);
        CREATE TABLE hardlink_groups (
          device TEXT NOT NULL,
          inode TEXT NOT NULL,
          owner_path_key TEXT NOT NULL REFERENCES hardlink_paths(path_key),
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
          phase TEXT NOT NULL CHECK (phase IN ('scanning', 'paused', 'awaiting-reconciliation', 'finalizing')),
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
      // Recovery and the construction-state rebuild resolve file identities
      // by (device, inode); without this index each lookup scans the whole
      // nodes table (O(n^2) on large saved scans, stalling resume).
      this.#database.exec('CREATE INDEX IF NOT EXISTS nodes_identity_idx ON nodes (device, inode)')
      if (!openExisting && options && 'scanId' in options) {
        const seed = options.nodeIdSeed ?? randomBytes(32).toString('hex')
        if (!/^[0-9a-f]{64}$/u.test(seed)) throw new Error('Invalid progressive scan node ID seed')
        this.#database.prepare(`INSERT INTO scan_run (singleton, scan_id, node_id_seed, phase, journal_device, journal_uuid,
          journal_baseline, drained_through, checkpointed_at) VALUES (1, ?, ?, 'scanning', ?, ?, ?, ?, ?)`)
          .run(options.scanId, seed, options.journalDevice, options.journalUuid, options.journalBaseline, options.journalBaseline, new Date(this.#clock()).toISOString())
        this.#database.exec('INSERT INTO scan_counters (singleton) VALUES (1)')
      }
      if (openExisting) {
        const root = this.#database.prepare('SELECT id FROM nodes WHERE parent_id IS NULL').get() as { id?: string } | undefined
        this.#rootNodeId = root?.id
        const run = this.#database.prepare('SELECT 1 AS found FROM scan_run WHERE singleton = 1').get() as { found?: number } | undefined
        if (!run?.found) throw new Error('Construction database has no scan run')
      }
      this.#readModel = new NodeReadModel(this.#database, "construction")
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
        INSERT INTO directory_tasks (node_id, path, depth, enqueue_order, focused, status, ready, shallow_band)
        VALUES (?, ?, ?, (SELECT value FROM scan_state WHERE key = 'enqueue'), ?, 'queued', ?, ?)
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
      this.#insertHardLinkPath = this.#database.prepare(`
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes) VALUES (?, ?, ?, ?, ?, ?)
      `)
      this.#insertHardLinkPathBatch = this.#database.prepare(`
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes)
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
      // Post-order accounting: deltas land on the node itself and are pushed
      // to the parent when the node's subtree completes, so the recursive
      // ancestor walk runs once per completed directory instead of once per
      // page. The recursive statement above remains for the rare hardlink
      // owner replacement, which can target an already-propagated subtree.
      this.#applyNodeDeltaStatement = this.#database.prepare(`
        UPDATE nodes SET size_bytes = size_bytes + ?, descendant_count = descendant_count + ?, unreadable_count = unreadable_count + ?
        WHERE id = ?
      `)
      this.#nodeTotalsStatement = this.#database.prepare("SELECT size_bytes AS sizeBytes, own_bytes AS ownBytes, descendant_count AS descendantCount, unreadable_count AS unreadableCount FROM nodes WHERE id = ?")
      this.#nodeScanStateStatement = this.#database.prepare("SELECT scan_state AS scanState FROM nodes WHERE id = ?")
      this.#attachEstimate = this.#database.prepare(`
        INSERT INTO size_estimates (node_id, estimated_bytes, indexed_items, physical_size_coverage)
        SELECT ?, estimated_bytes, indexed_items, physical_size_coverage FROM estimate_roots WHERE name = ?
      `)
      this.#deleteEstimateRoot = this.#database.prepare("DELETE FROM estimate_roots WHERE name = ?")
      this.#deleteEstimateStatement = this.#database.prepare("DELETE FROM size_estimates WHERE node_id = ?")
      this.#taskIsFocused = this.#database.prepare("SELECT focused FROM directory_tasks WHERE node_id = ?")
      this.#parentIdStatement = this.#database.prepare("SELECT parent_id AS parentId FROM nodes WHERE id = ?")
      const readySelect = `SELECT node_id AS id, path, depth, focused, entries_read AS entriesRead
        FROM directory_tasks WHERE ready = 1 AND focused = ? AND status IN ('queued', 'scanning')
        ORDER BY shallow_band, depth, enqueue_order LIMIT ?`
      this.#selectReadyFocused = this.#database.prepare(readySelect)
      this.#selectReadyNormal = this.#database.prepare(readySelect)
      this.#pendingSubtrees = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM directory_tasks WHERE subtree_complete = 0').get() as { count: number }).count)
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
    this.#consumedEstimateRoots.add(name)
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
    const parentId = this.#parentId(id)
    this.#insertTask.run(id, path, depth, focused ? 1 : 0, parentId ? 0 : 1, depth <= 6 ? 0 : 1)
    if (parentId) this.#database.prepare('UPDATE directory_tasks SET pending_children = pending_children + 1 WHERE node_id = ?').run(parentId)
    this.#pendingSubtrees += 1
  }

  takeWork(request: ConstructionWorkRequest): ConstructionWorkBatch {
    this.#assertBuilding()
    if (this.#leasedTaskIds.length > 0) throw new ConstructionError("illegal-transition", "Construction work is already leased")
    const limit = Math.max(1, Math.floor(request.limit))
    let focusTurns = Math.max(0, Math.floor(request.focusTurns))
    type ReadyRow = { id: string; path: string; depth: number; focused: number; entriesRead: number }
    const focused = this.#selectReadyFocused.all(1, limit) as unknown as ReadyRow[]
    const normal = this.#selectReadyNormal.all(0, limit) as unknown as ReadyRow[]
    recordScanCounter('schedulerSelects', 2)
    let focusedIndex = 0
    let normalIndex = 0
    const work: DirectoryTask[] = []
    while (work.length < limit && (focusedIndex < focused.length || normalIndex < normal.length)) {
      const takeFocused = focusedIndex < focused.length && (focusTurns < 3 || normalIndex >= normal.length)
      const row = takeFocused ? focused[focusedIndex++]! : normal[normalIndex++]!
      work.push({ id: row.id, path: row.path, depth: Number(row.depth), focused: Boolean(row.focused), entriesRead: Number(row.entriesRead) })
      if (row.focused) focusTurns += 1
      else focusTurns = 0
      if (row.focused && focusTurns >= 3 && normalIndex < normal.length) focusTurns = 3
    }
    this.#leasedTaskIds.push(...work.map((task) => task.id))
    if (work.length === 0 && this.#pendingSubtrees > 0) throw new ConstructionError('pending-work', 'Construction has pending subtrees but no ready work')
    return { work, focusTurns, done: work.length === 0 && this.#pendingSubtrees === 0 }
  }

  startTask(id: string): void {
    this.#database.prepare("UPDATE directory_tasks SET status = 'scanning' WHERE node_id = ? AND status = 'queued'").run(id)
    this.#database.prepare("UPDATE nodes SET scan_state = 'scanning' WHERE id = ? AND scan_state = 'queued'").run(id)
    this.#database.prepare("UPDATE directory_observations SET enumeration_status = 'scanning' WHERE node_id = ? AND enumeration_status = 'queued'").run(id)
  }

  accept(input: ConstructionInput): ConstructionPageResult {
    this.#assertBuilding()
    const taskId = input.kind === "unreadable" ? input.taskId : input.page.taskId
    if (this.#leasedTaskIds.length > 0) {
      const expected = this.#leasedTaskIds[0]
      if (taskId !== expected) throw new ConstructionError("stale-work", `Expected construction work ${expected}, received ${taskId}`)
      this.#leasedTaskIds.shift()
    }
    if (input.kind === "unreadable") {
      const result = this.applyMetadataBatch(() => {
        this.#assertOpenTask(input.taskId)
        this.startTask(input.taskId)
        this.markUnreadable(input.taskId, input.disappearing)
        this.bumpRevision()
        return {
          scannedItems: 0, discoveredBytes: 0, skippedItems: 1, unreadableItems: 1,
          disappearingItems: input.disappearing ? 1 : 0, symlinks: 0, nestedMounts: 0,
          duplicateHardLinks: 0, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
        } satisfies ConstructionPageResult
      })
      if (input.checkpointAfter) this.checkpoint(input.checkpointAfter)
      return result
    }

    const page = input.page
    if (!Number.isSafeInteger(page.entriesRead) || page.entriesRead < 0) throw new Error('Invalid construction page cursor')
    const result = this.applyMetadataBatch(() => {
      this.#assertPageCursor(page)
      const totals = emptyConstructionPageResult()
      if (!page.done) this.startTask(page.taskId)
      for (const entry of page.entries) this.#applyPageEntry(entry, page, totals)
      if (this.#resumable) this.addMetadataCounters(page.bulkMetadataEntries, page.fallbackMetadataEntries)
      this.bumpRevision()
      this.#advanceTask(page.taskId, page.entriesRead, page.entries.length)
      if (page.done) this.finishEnumeration(page.taskId)
      else this.yieldTask(page.taskId)
      totals.bulkMetadataEntries = Math.max(0, Math.floor(page.bulkMetadataEntries))
      totals.fallbackMetadataEntries = Math.max(0, Math.floor(page.fallbackMetadataEntries))
      return totals
    })
    if (page.checkpointAfter) this.checkpoint(page.checkpointAfter)
    return result
  }

  #assertPageCursor(page: ConstructionPage): void {
    const row = this.#database.prepare('SELECT entries_read AS entriesRead, depth, status FROM directory_tasks WHERE node_id = ?').get(page.taskId) as { entriesRead?: number; depth?: number; status?: string } | undefined
    if (!row || Number(row.entriesRead) !== page.entriesRead || Number(row.depth) !== page.depth || row.status !== 'queued' && row.status !== 'scanning') {
      throw new Error(`Stale construction page for ${page.taskId}`)
    }
  }

  #assertOpenTask(id: string): void {
    const row = this.#database.prepare('SELECT status FROM directory_tasks WHERE node_id = ?').get(id) as { status?: string } | undefined
    if (!row || row.status !== 'queued' && row.status !== 'scanning') throw new Error(`Closed construction task for ${id}`)
  }

  #advanceTask(id: string, entriesRead: number, count: number): void {
    const result = this.#database.prepare('UPDATE directory_tasks SET entries_read = entries_read + ? WHERE node_id = ? AND entries_read = ?')
      .run(Math.max(0, Math.floor(count)), id, entriesRead)
    if (Number(result.changes) !== 1) throw new Error(`Construction page cursor changed for ${id}`)
  }

  #applyPageEntry(entry: ConstructionPageEntry, page: ConstructionPage, totals: MutableConstructionPageResult): void {
    if (entry.kind === "skipped") {
      const observation = entry.observation
      this.observeSkipped(page.taskId, observation)
      totals.skippedItems += 1
      if (observation?.unreadable) totals.unreadableItems += 1
      if (observation?.disappearing) totals.disappearingItems += 1
      if (observation?.symlink) totals.symlinks += 1
      if (observation?.nestedMount) totals.nestedMounts += 1
      return
    }

    const { node, pathKey, linkCount } = entry.node
    const bytes = safeBytes(node.ownBytes)
    const needsHardLinkOwnership = node.kind === "file" && node.device !== "" && node.inode !== "" && linkCount !== 1
    if (needsHardLinkOwnership && node.parentId) this.insertHardLinkPath(node.parentId, node.name, pathKey, node.device, node.inode, bytes)
    let replacingOwner = false
    if (needsHardLinkOwnership) {
      const owner = this.getHardLinkOwner(node.device, node.inode)
      if (owner) {
        totals.skippedItems += 1
        totals.duplicateHardLinks += 1
        if (comparePathKeys(pathKey, owner.pathKey) >= 0) {
          this.observeSkipped(page.taskId, { duplicate: true })
          return
        }
        const previousParentId = this.#parentId(owner.nodeId)
        if (previousParentId) this.observeSkipped(previousParentId, { duplicate: true })
        this.removeOwnedFile(owner.nodeId)
        replacingOwner = true
      }
    }
    this.insertChild(node, page.depth + 1, page.focused)
    if (needsHardLinkOwnership) this.setHardLinkOwner(node.device, node.inode, node.id, pathKey)
    if (!replacingOwner) {
      totals.scannedItems += 1
      totals.discoveredBytes += bytes
    }
  }

  applyMetadataBatch<T>(operation: () => T): T {
    this.#assertBuilding()
    if (this.#inMetadataOperation) throw new Error('Nested metadata batches are not supported')
    // The savepoint keeps one page's immediate statements atomic; the
    // accumulator maps survive across pages and are flushed on a threshold.
    this.#database.exec('SAVEPOINT metadata_batch')
    this.#consumedEstimateRoots = new Set()
    this.#inMetadataOperation = true
    const batch = this.#metadataBatch
    // Snapshot the accumulator so an error discards exactly this page's
    // additions while preserving earlier pages' unflushed data: a canceled
    // scan checkpoints before aborting, and the checkpoint must not commit
    // entries the task queue never counted.
    const snapshot = {
      fileNodes: new Map(batch.fileNodes),
      hardlinkPaths: batch.hardlinkPaths.slice(),
      hardLinkOwners: new Map(batch.hardLinkOwners),
      ancestorDeltas: new Map([...batch.ancestorDeltas].map(([key, delta]) => [key, { ...delta }])),
      directChildDeltas: new Map(batch.directChildDeltas),
      observationDeltas: new Map([...batch.observationDeltas].map(([key, delta]) => [key, { ...delta }])),
      propagatedToParent: new Map([...this.#propagatedToParent].map(([key, delta]) => [key, { ...delta }])),
      lastBatchFlushAt: this.#lastBatchFlushAt
    }
    try {
      const result = operation()
      this.#maybeFlushMetadataBatch()
      this.#database.exec('RELEASE metadata_batch')
      return result
    } catch (error) {
      for (const name of this.#consumedEstimateRoots) this.#estimateRootNames.add(name)
      this.#restoreBatchSnapshot(batch, snapshot)
      try { this.#database.exec('ROLLBACK TO metadata_batch') } catch { /* The savepoint may already be released. */ }
      try { this.#database.exec('RELEASE metadata_batch') } catch { /* The savepoint may already be released. */ }
      throw error
    } finally {
      this.#inMetadataOperation = false
    }
  }

  #restoreBatchSnapshot(batch: MetadataBatch, snapshot: {
    readonly fileNodes: Map<string, PendingFileNode>
    readonly hardlinkPaths: PendingHardLinkPath[]
    readonly hardLinkOwners: Map<string, PendingHardLinkOwner>
    readonly ancestorDeltas: Map<string, AncestorDelta>
    readonly directChildDeltas: Map<string, number>
    readonly observationDeltas: Map<string, ObservationDelta>
    readonly propagatedToParent: Map<string, { readonly bytes: number; readonly descendants: number; readonly unreadable: number }>
    readonly lastBatchFlushAt: number
  }): void {
    batch.fileNodes.clear()
    for (const [key, node] of snapshot.fileNodes) batch.fileNodes.set(key, node)
    batch.hardlinkPaths.length = 0
    batch.hardlinkPaths.push(...snapshot.hardlinkPaths)
    batch.hardLinkOwners.clear()
    for (const [key, owner] of snapshot.hardLinkOwners) batch.hardLinkOwners.set(key, owner)
    batch.ancestorDeltas.clear()
    for (const [key, delta] of snapshot.ancestorDeltas) batch.ancestorDeltas.set(key, delta)
    batch.directChildDeltas.clear()
    for (const [key, delta] of snapshot.directChildDeltas) batch.directChildDeltas.set(key, delta)
    batch.observationDeltas.clear()
    for (const [key, delta] of snapshot.observationDeltas) batch.observationDeltas.set(key, delta)
    this.#propagatedToParent.clear()
    for (const [key, delta] of snapshot.propagatedToParent) this.#propagatedToParent.set(key, delta)
    this.#lastBatchFlushAt = snapshot.lastBatchFlushAt
  }

  #maybeFlushMetadataBatch(): void {
    const batch = this.#metadataBatch
    const now = this.#clock()
    if (batch.fileNodes.size < 4_096 && batch.ancestorDeltas.size < 1_024 && now - this.#lastBatchFlushAt < 250) return
    this.#flushMetadataBatch(batch)
  }

  #flushMetadataBatch(batch: MetadataBatch): void {
    const rows = batch.fileNodes.size + batch.hardlinkPaths.length + batch.hardLinkOwners.size
      + batch.ancestorDeltas.size + batch.directChildDeltas.size + batch.observationDeltas.size
    if (rows === 0) return
    measureScanWork('metadata-batch-flush', () => {
    if (batch.fileNodes.size > 0) this.#insertFileNodeBatch.run(JSON.stringify([...batch.fileNodes.values()]))
    if (batch.hardlinkPaths.length > 0) this.#insertHardLinkPathBatch.run(JSON.stringify(batch.hardlinkPaths))
    if (batch.hardLinkOwners.size > 0) this.#setHardLinkOwnerBatch.run(JSON.stringify([...batch.hardLinkOwners.values()]))
    for (const [nodeId, delta] of batch.ancestorDeltas) {
      if (delta.bytes === 0 && delta.descendants === 0 && delta.unreadable === 0) continue
      this.#applyNodeDeltaStatement.run(delta.bytes, delta.descendants, delta.unreadable, nodeId)
    }
    for (const [parentId, delta] of batch.directChildDeltas) {
      if (delta !== 0) this.#incrementDirectChildren.run(delta, parentId)
    }
    for (const [id, delta] of batch.observationDeltas) {
      if (delta.skipped === 0 && delta.unreadable === 0 && delta.disappearing === 0 && delta.symlinks === 0 && delta.nestedMounts === 0 && delta.duplicates === 0) continue
      this.#observeSkipped.run(delta.skipped, delta.unreadable, delta.disappearing, delta.symlinks, delta.nestedMounts, delta.duplicates, id)
    }
    batch.fileNodes.clear()
    batch.hardlinkPaths.length = 0
    batch.hardLinkOwners.clear()
    batch.ancestorDeltas.clear()
    batch.directChildDeltas.clear()
    batch.observationDeltas.clear()
    this.#lastBatchFlushAt = this.#clock()
    })
    recordScanCounter('metadataBatchFlushes')
    recordScanCounter('metadataRowsFlushed', rows)
  }

  #flushPendingMetadataBatch(): void {
    this.#flushMetadataBatch(this.#metadataBatch)
  }

  preparePreviewReadModel(): void {
    this.#assertBuilding()
    this.#flushPendingMetadataBatch()
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
    this.#database.prepare(`UPDATE directory_tasks SET ready = 1 WHERE node_id IN
      (SELECT id FROM nodes WHERE parent_id = ?) AND status IN ('queued', 'scanning')`).run(id)
    this.#settleReadyTasks(id)
  }

  markUnreadable(id: string, disappearing = false): void {
    this.#database.prepare("UPDATE nodes SET own_unreadable = 1, enumeration_complete = 1, scan_state = 'unreadable' WHERE id = ?").run(id)
    this.#database.prepare("UPDATE directory_tasks SET status = 'unreadable' WHERE node_id = ?").run(id)
    this.#database.prepare(`
      UPDATE directory_observations SET enumeration_status = 'unreadable', direct_skipped_count = direct_skipped_count + 1,
        direct_unreadable_count = direct_unreadable_count + ?, direct_disappearing_count = direct_disappearing_count + ? WHERE node_id = ?
    `).run(1, disappearing ? 1 : 0, id)
    this.#deleteEstimate(id)
    // The unreadable node never completes, so push its accumulated state to
    // the parent now: its own unreadable flag counts on itself and every
    // ancestor, and children that completed before the failure must reach the
    // ancestors even though the subtree will not propagate on completion.
    // Children that complete after the mark are propagated when the
    // completion walk reaches this node.
    this.#applyNodeDeltaStatement.run(0, 0, 1, id)
    this.#propagateToParent(id)
    this.#database.prepare(`UPDATE directory_tasks SET ready = 1 WHERE node_id IN
      (SELECT id FROM nodes WHERE parent_id = ?) AND status IN ('queued', 'scanning')`).run(id)
    this.#settleReadyTasks(id)
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

  insertHardLinkPath(parentId: string, name: string, pathKey: string, device: string, inode: string, allocatedBytes: number): void {
    recordScanCounter('hardlinkPathRows')
    const bytes = safeBytes(allocatedBytes)
    const batch = this.#metadataBatch
    if (batch) batch.hardlinkPaths.push({ parentId, name, pathKey, device, inode, allocatedBytes: bytes })
    else this.#insertHardLinkPath.run(parentId, name, pathKey, device, inode, bytes)
  }

  #settleReadyTasks(startId: string): void {
    let id: string | null = startId
    while (id) {
      const row = this.#database.prepare(`SELECT task.pending_children AS pendingChildren,
        task.subtree_complete AS subtreeComplete, task.status, nodes.scan_state AS scanState
        FROM directory_tasks task JOIN nodes ON nodes.id = task.node_id WHERE task.node_id = ?`).get(id) as unknown as
        { pendingChildren: number; subtreeComplete: number; status: string; scanState: string } | undefined
      if (!row || row.subtreeComplete || row.pendingChildren !== 0 || row.status !== 'complete' && row.status !== 'unreadable') break
      this.#deleteEstimate(id)
      if (row.scanState === 'unreadable') this.#propagateToParent(id)
      else if (row.scanState !== 'complete') {
        this.#database.prepare("UPDATE nodes SET scan_state = 'complete' WHERE id = ?").run(id)
        this.#propagateToParent(id)
      }
      this.#database.prepare('UPDATE directory_tasks SET subtree_complete = 1, ready = 0 WHERE node_id = ?').run(id)
      recordScanCounter('completionTransitions')
      this.#pendingSubtrees -= 1
      const parent = this.#parentId(id)
      if (!parent) break
      const changed = this.#database.prepare('UPDATE directory_tasks SET pending_children = pending_children - 1 WHERE node_id = ? AND pending_children > 0').run(parent)
      if (Number(changed.changes) !== 1) throw new ConstructionError('pending-work', `Invalid pending child count for ${parent}`)
      id = parent
    }
  }

  // Pushes a node's accumulated subtree totals (everything above its own
  // bytes) to its parent. The node's own bytes and count reached the parent
  // at insert time, so only the delta above own_bytes is propagated. The
  // pending batch may hold unflushed contributions to the node, so the
  // virtual state (row + pending) is what gets propagated and recorded.
  #propagateToParent(id: string): void {
    const parentId = this.#parentId(id)
    if (!parentId) return
    const row = this.#nodeTotalsStatement.get(id) as unknown as { sizeBytes: number; ownBytes: number; descendantCount: number; unreadableCount: number } | undefined
    if (!row) return
    const pending = this.#metadataBatch.ancestorDeltas.get(id)
    const bytes = Number(row.sizeBytes) - Number(row.ownBytes) + (pending?.bytes ?? 0)
    const descendants = Number(row.descendantCount) + (pending?.descendants ?? 0)
    const unreadable = Number(row.unreadableCount) + (pending?.unreadable ?? 0)
    const propagated = this.#propagatedToParent.get(id)
    const deltaBytes = bytes - (propagated?.bytes ?? 0)
    const deltaDescendants = descendants - (propagated?.descendants ?? 0)
    const deltaUnreadable = unreadable - (propagated?.unreadable ?? 0)
    if (deltaBytes === 0 && deltaDescendants === 0 && deltaUnreadable === 0) return
    this.#applyAncestorDelta(parentId, deltaBytes, deltaDescendants, deltaUnreadable)
    this.#propagatedToParent.set(id, { bytes, descendants, unreadable })
  }

  getEstimatedRemainder(id: string): number {
    this.#flushPendingMetadataBatch()
    return this.#readModel.getEstimatedRemainder(id)
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
    const pending = this.#metadataBatch.fileNodes.get(id)
    if (pending) {
      this.#metadataBatch.fileNodes.delete(id)
      this.#removeFileFromAccounting(pending.parentId, -pending.ownBytes)
      this.#applyDirectChildDelta(pending.parentId, -1)
      return
    }
    const row = this.#selectOwnedFile.get(id) as unknown as { parentId: string | null; sizeBytes: number } | undefined
    if (!row) return
    this.#removeFileFromAccounting(row.parentId, -Number(row.sizeBytes))
    if (row.parentId) this.#applyDirectChildDelta(row.parentId, -1)
    this.#deleteNode.run(id)
  }

  // The file's bytes live on its parent and, once the parent's subtree
  // completed, on every ancestor that propagated them upward. Subtract from
  // exactly the nodes that received them: the parent, then each completed
  // ancestor in turn. The walk is required because the parent may have
  // completed (and propagated) before the replacement is discovered; it works
  // against both the committed rows and the pending batch deltas.
  #removeFileFromAccounting(parentId: string | null, bytes: number): void {
    let id: string | null = parentId
    while (id) {
      this.#applyAncestorDelta(id, bytes, -1, 0)
      const state = this.#nodeScanStateStatement.get(id) as { scanState?: string } | undefined
      if (!state || state.scanState !== "complete" && state.scanState !== "unreadable") break
      id = this.#parentId(id)
    }
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

  get phase(): ConstructionPhase {
    const row = this.#database.prepare('SELECT phase FROM scan_run WHERE singleton = 1').get() as { phase?: ConstructionPhase } | undefined
    if (!row?.phase) throw new Error('Construction database has no scan phase')
    return row.phase
  }

  checkpoint(request: ConstructionCheckpointRequest | number = {}): number {
    this.#assertBuilding()
    const normalized = typeof request === 'number' ? { activeElapsedDeltaMs: request } : request
    if (this.#resumable && normalized.reason === 'resume' && this.phase === 'paused') this.#setPhase('scanning')
    if (normalized.journalDrain) this.#setJournalDrain(normalized.journalDrain.scopes, normalized.journalDrain.throughEventId)
    // The task queue commits entries_read immediately, so a checkpoint must
    // never outrun unflushed file rows: a resume would skip re-reading
    // entries whose rows were never committed.
    this.#flushPendingMetadataBatch()
    this.#database.prepare(`UPDATE scan_run SET checkpoint_sequence = checkpoint_sequence + 1,
      active_elapsed_ms = active_elapsed_ms + ?, checkpointed_at = ? WHERE singleton = 1`)
      .run(Math.max(0, Math.floor(normalized.activeElapsedDeltaMs ?? 0)), new Date(this.#clock()).toISOString())
    measureScanWork('database-checkpoint', () => this.#database.exec('COMMIT'))
    recordScanCounter('databaseCheckpoints')
    this.#database.exec('BEGIN')
    const sequence = this.checkpointSequence
    this.#onCheckpoint?.(normalized.reason ?? 'scheduled', sequence)
    return sequence
  }

  finish(command: ConstructionFinishCommand): ConstructionFinishResult {
    if (command.kind === 'unexpected-failure') {
      this.#assertBuilding()
      const sequence = this.checkpointSequence
      this.abort()
      return { kind: 'failed', checkpointSequence: sequence }
    }
    if (command.kind === 'pause') {
      this.#assertBuilding()
      this.#setPhase('paused')
      const request: ConstructionCheckpointRequest = {
        reason: 'pause',
        ...(command.activeElapsedDeltaMs === undefined ? {} : { activeElapsedDeltaMs: command.activeElapsedDeltaMs }),
        ...(command.journalDrain === undefined ? {} : { journalDrain: command.journalDrain })
      }
      const sequence = this.checkpoint(request)
      this.#database.exec('ROLLBACK')
      this.#database.exec('PRAGMA synchronous=FULL; PRAGMA wal_checkpoint(TRUNCATE)')
      this.#state = 'paused'
      this.#close()
      return { kind: 'paused', checkpointSequence: sequence }
    }

    return this.#finishCandidate(command)
  }

  pause(activeElapsedDeltaMs = 0): number {
    const result = this.finish({ kind: 'pause', activeElapsedDeltaMs })
    if (result.kind !== 'paused') throw new Error(`Unexpected construction finish result: ${result.kind}`)
    return result.checkpointSequence
  }

  setPhase(phase: ConstructionPhase | 'traversing'): void {
    this.#setPhase(phase === 'traversing' ? 'scanning' : phase)
  }

  #setPhase(phase: ConstructionPhase): void {
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
    this.#setJournalDrain(scopes, throughEventId)
  }

  #setJournalDrain(scopes: readonly string[], throughEventId: string): void {
    if (scopes.length > 1024 || !isDecimalEventId(throughEventId)) throw new Error('resume-dirty-scopes-unbounded')
    const current = this.drainedThrough
    if (isDecimalEventId(current) && BigInt(throughEventId) < BigInt(current)) throw new Error('resume-watermark-regressed')
    const insert = this.#database.prepare('INSERT OR IGNORE INTO dirty_scopes (path) VALUES (?)')
    for (const path of scopes) insert.run(path)
    const count = this.#database.prepare('SELECT COUNT(*) AS count FROM dirty_scopes').get() as { count: number }
    if (Number(count.count) > 1024) throw new Error('resume-dirty-scopes-unbounded')
    this.#database.prepare('UPDATE scan_run SET drained_through = ? WHERE singleton = 1').run(throughEventId)
  }

  status(): ConstructionStatus {
    return {
      phase: this.phase,
      revision: this.revision,
      checkpointSequence: this.checkpointSequence,
      totals: this.semanticTotals(),
      drainedThrough: this.drainedThrough,
      dirtyScopes: this.dirtyScopes
    }
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

  recoverIncompleteDirectories(): ResumeRecoveryReport {
    this.#assertBuilding()
    const schedulerTiming = createScanTimingAccumulator('resume-scheduler-repair')
    let recoveryTablesCreated = false
    let recoveryFailed = false
    const propagatedSnapshot = new Map([...this.#propagatedToParent].map(([key, delta]) => [key, { ...delta }]))
    try {
      const phase = this.phase
      const pendingTasks = Number((this.#database.prepare("SELECT COUNT(*) AS count FROM directory_tasks WHERE status IN ('queued', 'scanning')").get() as { count: number }).count)
      const hardlinkGroups = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM hardlink_groups').get() as { count: number }).count)
      if ((phase === 'scanning' || phase === 'paused') && hardlinkGroups !== 0) {
        throw new ConstructionError('invalid-resume', 'Traversal construction contains finalized hard-link groups')
      }
      if ((phase === 'awaiting-reconciliation' || phase === 'finalizing') && pendingTasks !== 0) {
        throw new ConstructionError('invalid-resume', 'Finalization construction contains queued directory work')
      }
      // A construction in the finalization-only part of its lifecycle has no
      // directory cursor to recover. Leave it intact so finish() can retry
      // candidate creation.
      if (phase === 'awaiting-reconciliation' || phase === 'finalizing') return emptyResumeRecoveryReport()

      // A caller may resume from a database opened by this same process after a
      // page was accepted but before its metadata batch was flushed. Recovery
      // must capture the durable SQL view, not the half-visible accumulator.
      this.#flushPendingMetadataBatch()
      recoveryTablesCreated = true
      this.#dropRecoveryTables()
      this.#prepareRecoverySet()
      const roots = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM recovery_roots').get() as { count: number }).count)
      if (roots === 0) return emptyResumeRecoveryReport()
      const deletedNodes = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM recovery_subtree').get() as { count: number }).count)
      const invalidObservation = this.#database.prepare(`SELECT observations.node_id AS nodeId
        FROM recovery_observation_parents affected
        JOIN directory_observations observations ON observations.node_id = affected.id
        WHERE affected.old_duplicate_count > observations.direct_duplicate_count
           OR affected.old_duplicate_count > observations.direct_skipped_count
        LIMIT 1`).get() as { nodeId?: string } | undefined
      if (invalidObservation?.nodeId) throw new Error(`Inconsistent duplicate observation for directory ${invalidObservation.nodeId}`)
      const multipleRepresentatives = this.#database.prepare(`SELECT paths.device, paths.inode
        FROM recovery_identities paths
        JOIN nodes representatives ON representatives.device = paths.device AND representatives.inode = paths.inode
          AND representatives.kind = 'file'
        WHERE representatives.id NOT IN (SELECT id FROM recovery_subtree)
        GROUP BY paths.device, paths.inode HAVING COUNT(*) > 1 LIMIT 1`).get() as { device?: string; inode?: string } | undefined
      if (multipleRepresentatives?.device !== undefined) {
        throw new Error(`Multiple representative nodes for hard-link identity ${multipleRepresentatives.device}:${multipleRepresentatives.inode}`)
      }

      // Only duplicate observations belonging to surviving parents need a
      // delta. Root observations are reset below, and observations in the
      // deleted subtree disappear with their nodes.
      this.#database.exec(`
        UPDATE directory_observations
        SET direct_skipped_count = direct_skipped_count - (SELECT old_duplicate_count FROM recovery_observation_parents WHERE id = directory_observations.node_id),
            direct_duplicate_count = direct_duplicate_count - (SELECT old_duplicate_count FROM recovery_observation_parents WHERE id = directory_observations.node_id)
        WHERE node_id IN (SELECT id FROM recovery_observation_parents);

        UPDATE directory_tasks SET focused = 1
        WHERE node_id IN (SELECT id FROM recovery_roots)
          AND EXISTS (
            SELECT 1 FROM directory_tasks focused
            JOIN recovery_subtree deleted ON deleted.id = focused.node_id
            WHERE deleted.root_id = directory_tasks.node_id AND focused.focused = 1
          );

        DELETE FROM hardlink_owners
        WHERE EXISTS (
          SELECT 1 FROM recovery_identities affected
          WHERE affected.device = hardlink_owners.device AND affected.inode = hardlink_owners.inode
        );
        DELETE FROM hardlink_paths
        WHERE parent_id IN (
          SELECT id FROM recovery_roots
          UNION ALL SELECT id FROM recovery_subtree
        );
        DELETE FROM nodes WHERE id IN (SELECT id FROM recovery_subtree);

        UPDATE nodes SET size_bytes = own_bytes, direct_children = 0, descendant_count = 0,
          unreadable_count = own_unreadable, scan_state = 'queued', enumeration_complete = 0
        WHERE id IN (SELECT id FROM recovery_roots);
        UPDATE directory_tasks SET status = 'queued', entries_read = 0
        WHERE node_id IN (SELECT id FROM recovery_roots);
        UPDATE directory_observations SET direct_skipped_count = 0, direct_unreadable_count = 0,
          direct_disappearing_count = 0, direct_symlink_count = 0, direct_nested_mount_count = 0,
          direct_duplicate_count = 0, enumeration_status = 'queued'
        WHERE node_id IN (SELECT id FROM recovery_roots);
      `)

      const affectedHardlinkIdentities = this.#repairAffectedHardLinks()
      this.#expandRecoveryAncestors()
      const repairedAncestors = this.#repairAffectedDirectoryAggregates()
      this.#rebuildAffectedPropagationBookkeeping()
      const repairedSchedulerRows = schedulerTiming.measure(() => this.#repairAffectedScheduler())
      this.#pendingSubtrees = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM directory_tasks WHERE subtree_complete = 0').get() as { count: number }).count)
      return { roots, deletedNodes, affectedHardlinkIdentities, repairedAncestors, repairedSchedulerRows }
    } catch (error) {
      recoveryFailed = true
      this.#propagatedToParent.clear()
      for (const [key, delta] of propagatedSnapshot) this.#propagatedToParent.set(key, delta)
      throw error
    } finally {
      let cleanupError: unknown
      if (recoveryTablesCreated) {
        try { this.#dropRecoveryTables() } catch (error) { cleanupError = error }
      }
      schedulerTiming.publish()
      if (cleanupError !== undefined && !recoveryFailed) throw cleanupError
    }
  }

  #prepareRecoverySet(): void {
    this.#database.exec(`
      CREATE TEMP TABLE recovery_roots (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        depth INTEGER NOT NULL
      );
      CREATE TEMP TABLE recovery_subtree (
        root_id TEXT NOT NULL,
        id TEXT NOT NULL,
        parent_id TEXT,
        depth INTEGER NOT NULL,
        PRIMARY KEY (root_id, id)
      );
      CREATE TEMP TABLE recovery_ancestors (
        id TEXT PRIMARY KEY,
        depth INTEGER NOT NULL
      );
      CREATE TEMP TABLE recovery_identities (
        device TEXT NOT NULL,
        inode TEXT NOT NULL,
        PRIMARY KEY (device, inode)
      );
      CREATE TEMP TABLE recovery_owner_parents (id TEXT PRIMARY KEY);
      CREATE TEMP TABLE recovery_observation_parents (
        id TEXT PRIMARY KEY,
        old_duplicate_count INTEGER NOT NULL
      );

      INSERT INTO recovery_roots (id, parent_id, depth)
      SELECT task.node_id, node.parent_id, node.depth
      FROM directory_tasks task JOIN nodes node ON node.id = task.node_id
      WHERE task.status IN ('queued', 'scanning') AND NOT EXISTS (
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT parent.id, parent.parent_id
          FROM nodes child JOIN nodes parent ON parent.id = child.parent_id
          WHERE child.id = task.node_id
          UNION ALL
          SELECT parent.id, parent.parent_id
          FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
        )
        SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
        WHERE ancestor_task.status IN ('queued', 'scanning')
      );

      WITH RECURSIVE descendants(root_id, id, parent_id, depth) AS (
        SELECT roots.id, child.id, child.parent_id, child.depth
        FROM recovery_roots roots JOIN nodes child ON child.parent_id = roots.id
        UNION ALL
        SELECT descendants.root_id, child.id, child.parent_id, child.depth
        FROM descendants JOIN nodes child ON child.parent_id = descendants.id
      )
      INSERT INTO recovery_subtree (root_id, id, parent_id, depth)
      SELECT root_id, id, parent_id, depth FROM descendants;

      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT id, depth FROM recovery_roots
        UNION
        SELECT parent.id, parent.depth
        FROM nodes child JOIN ancestors current ON current.id = child.id
        JOIN nodes parent ON parent.id = child.parent_id
      )
      INSERT OR IGNORE INTO recovery_ancestors (id, depth)
      SELECT id, depth FROM ancestors;

      INSERT INTO recovery_identities (device, inode)
      SELECT DISTINCT paths.device, paths.inode
      FROM hardlink_paths paths
      WHERE paths.device <> '' AND paths.inode <> ''
        AND paths.parent_id IN (
          SELECT id FROM recovery_roots
          UNION ALL SELECT id FROM recovery_subtree
        );

      INSERT OR IGNORE INTO recovery_owner_parents (id)
      SELECT DISTINCT representatives.parent_id
      FROM nodes representatives
      JOIN recovery_identities affected ON affected.device = representatives.device AND affected.inode = representatives.inode
      WHERE representatives.kind = 'file'
        AND representatives.parent_id IS NOT NULL
        AND representatives.parent_id NOT IN (SELECT id FROM recovery_subtree);

      INSERT OR IGNORE INTO recovery_owner_parents (id)
      SELECT DISTINCT owner_node.parent_id
      FROM hardlink_owners owners
      JOIN recovery_identities affected ON affected.device = owners.device AND affected.inode = owners.inode
      JOIN nodes owner_node ON owner_node.id = owners.node_id
      WHERE owner_node.parent_id IS NOT NULL
        AND owner_node.parent_id NOT IN (SELECT id FROM recovery_subtree);

      INSERT INTO recovery_observation_parents (id, old_duplicate_count)
      SELECT paths.parent_id,
        SUM(CASE WHEN owners.path_key = paths.path_key THEN 0 ELSE 1 END)
      FROM hardlink_paths paths
      JOIN recovery_identities affected ON affected.device = paths.device AND affected.inode = paths.inode
      LEFT JOIN hardlink_owners owners ON owners.device = paths.device AND owners.inode = paths.inode
      WHERE paths.parent_id NOT IN (
        SELECT id FROM recovery_roots
        UNION ALL SELECT id FROM recovery_subtree
      )
      GROUP BY paths.parent_id;
    `)
  }

  #dropRecoveryTables(): void {
    this.#database.exec(`
      DROP TABLE IF EXISTS temp.recovery_observation_parents;
      DROP TABLE IF EXISTS temp.recovery_owner_parents;
      DROP TABLE IF EXISTS temp.recovery_identities;
      DROP TABLE IF EXISTS temp.recovery_ancestors;
      DROP TABLE IF EXISTS temp.recovery_subtree;
      DROP TABLE IF EXISTS temp.recovery_roots;
    `)
  }

  #repairAffectedHardLinks(): number {
    const hardlinks = createScanTimingAccumulator('resume-hardlink-repair')
    try {
      return hardlinks.measure(() => {
        const identities = this.#database.prepare('SELECT device, inode FROM recovery_identities ORDER BY device COLLATE BINARY, inode COLLATE BINARY').all() as unknown as Array<{ device: string; inode: string }>
        const paths = this.#database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode,
          allocated_bytes AS allocatedBytes FROM hardlink_paths WHERE device = ? AND inode = ? ORDER BY path_key COLLATE BINARY`)
        const representatives = this.#database.prepare(`SELECT id, parent_id AS parentId, name, path, kind,
          own_bytes AS ownBytes, size_bytes AS sizeBytes, own_unreadable AS ownUnreadable,
          direct_children AS directChildren, descendant_count AS descendantCount,
          unreadable_count AS unreadableCount, device, inode, scan_state AS scanState,
          enumeration_complete AS enumerationComplete, depth FROM nodes
          WHERE kind = 'file' AND device = ? AND inode = ? ORDER BY id COLLATE BINARY`)
        const parentNode = this.#database.prepare("SELECT path, depth FROM nodes WHERE id = ? AND kind = 'directory'")
        const insertOwnerParent = this.#database.prepare('INSERT OR IGNORE INTO recovery_owner_parents (id) SELECT ? WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)')
        const deleteNode = this.#database.prepare('DELETE FROM nodes WHERE id = ?')
        const bumpDuplicate = this.#database.prepare(`UPDATE directory_observations SET direct_skipped_count = direct_skipped_count + 1,
          direct_duplicate_count = direct_duplicate_count + 1 WHERE node_id = ?`)
        const seed = Buffer.from(this.nodeIdSeed, 'hex')

        for (const identity of identities) {
          const aliases = paths.all(identity.device, identity.inode) as unknown as Array<{
            parentId: string; name: string; pathKey: string; device: string; inode: string; allocatedBytes: number
          }>
          aliases.sort((left, right) => comparePathKeys(left.pathKey, right.pathKey))
          const stale = representatives.all(identity.device, identity.inode) as unknown as Array<{
            id: string; parentId: string; name: string; path: string; kind: string; ownBytes: number; sizeBytes: number;
            ownUnreadable: number; directChildren: number; descendantCount: number; unreadableCount: number;
            device: string; inode: string; scanState: string; enumerationComplete: number; depth: number
          }>
          if (stale.length > 1) throw new Error(`Multiple representative nodes for hard-link identity ${identity.device}:${identity.inode}`)

          if (aliases.length === 0) {
            for (const node of stale) deleteNode.run(node.id)
            continue
          }

          const owner = aliases[0]!
          const parent = parentNode.get(owner.parentId) as { path?: string; depth?: number } | undefined
          if (!parent?.path || parent.depth === undefined) throw new Error(`Missing owner parent for hard-link identity ${identity.device}:${identity.inode}`)
          const nodeId = `n-${createHmac('sha256', seed).update(owner.parentId).update('\0').update(owner.name).digest('hex').slice(0, 32)}`
          const expectedPath = join(parent.path, owner.name)
          const existing = stale[0]
          const reusable = existing !== undefined
            && existing.id === nodeId && existing.parentId === owner.parentId && existing.name === owner.name
            && existing.path === expectedPath && existing.kind === 'file'
            && existing.device === owner.device && existing.inode === owner.inode
            && Number(existing.ownBytes) === Number(owner.allocatedBytes) && Number(existing.sizeBytes) === Number(owner.allocatedBytes)
            && Number(existing.ownUnreadable) === 0 && Number(existing.directChildren) === 0
            && Number(existing.descendantCount) === 0 && Number(existing.unreadableCount) === 0
            && existing.scanState === 'complete' && Number(existing.enumerationComplete) === 1
            && Number(existing.depth) === Number(parent.depth) + 1
          if (!reusable) {
            if (existing) deleteNode.run(existing.id)
            this.#insertNode.run(nodeId, owner.parentId, owner.name, expectedPath, 'file', owner.allocatedBytes, owner.allocatedBytes,
              owner.device, owner.inode, 'complete', 1, Number(parent.depth) + 1)
          }
          insertOwnerParent.run(owner.parentId, owner.parentId)
          this.#setHardLinkOwner.run(owner.device, owner.inode, nodeId, owner.pathKey)
          for (const duplicate of aliases.slice(1)) bumpDuplicate.run(duplicate.parentId)
        }
        return identities.length
      })
    } finally { hardlinks.publish() }
  }

  #expandRecoveryAncestors(): void {
    this.#database.exec(`
      WITH RECURSIVE ancestors(id, depth) AS (
        SELECT nodes.id, nodes.depth
        FROM nodes JOIN recovery_owner_parents parents ON parents.id = nodes.id
        UNION
        SELECT parent.id, parent.depth
        FROM nodes child JOIN ancestors current ON current.id = child.id
        JOIN nodes parent ON parent.id = child.parent_id
      )
      INSERT OR IGNORE INTO recovery_ancestors (id, depth)
      SELECT id, depth FROM ancestors;
    `)
  }

  #repairAffectedDirectoryAggregates(): number {
    const aggregates = createScanTimingAccumulator("resume-aggregate-repair")
    try {
      return aggregates.measure(() => {
        const rows = this.#database.prepare(`SELECT affected.id, affected.depth
          FROM recovery_ancestors affected JOIN nodes ON nodes.id = affected.id
          WHERE nodes.kind = 'directory'
          ORDER BY affected.depth DESC, affected.id COLLATE BINARY`).all() as unknown as Array<{ id: string; depth: number }>
        const update = this.#database.prepare(`UPDATE nodes SET
          size_bytes = own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = nodes.id), 0),
          direct_children = (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id),
          descendant_count = COALESCE((SELECT SUM(1 + child.descendant_count) FROM nodes child WHERE child.parent_id = nodes.id), 0),
          unreadable_count = own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = nodes.id), 0)
          WHERE id = ? AND kind = 'directory'`)
        for (const row of rows) update.run(row.id)
        const mismatch = this.#findDirectoryAggregateMismatch()
        if (mismatch) throw new ScopedAggregateMismatch(mismatch)
        return rows.length
      })
    } finally { aggregates.publish() }
  }

  #findDirectoryAggregateMismatch(): string | undefined {
    const row = this.#database.prepare(`SELECT node.id
      FROM nodes node JOIN recovery_ancestors affected ON affected.id = node.id
      WHERE node.kind = 'directory'
        AND (node.size_bytes <> node.own_bytes + COALESCE((SELECT SUM(child.size_bytes)
              FROM nodes child WHERE child.parent_id = node.id), 0)
          OR node.direct_children <> (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = node.id)
          OR node.descendant_count <> COALESCE((SELECT SUM(1 + child.descendant_count)
              FROM nodes child WHERE child.parent_id = node.id), 0)
          OR node.unreadable_count <> node.own_unreadable + COALESCE((SELECT SUM(child.unreadable_count)
              FROM nodes child WHERE child.parent_id = node.id), 0))
      ORDER BY node.id COLLATE BINARY LIMIT 1`).get() as { id?: string } | undefined
    return row?.id
  }

  #rebuildAffectedPropagationBookkeeping(): void {
    this.#propagatedToParent.clear()
    const rows = this.#database.prepare(`SELECT node.id, node.size_bytes AS sizeBytes, node.own_bytes AS ownBytes,
        node.descendant_count AS descendantCount, node.unreadable_count AS unreadableCount
      FROM nodes node
      WHERE node.scan_state = 'unreadable' AND (
        EXISTS (SELECT 1 FROM recovery_ancestors parent WHERE parent.id = node.parent_id)
        OR EXISTS (SELECT 1 FROM recovery_roots root WHERE root.id = node.id)
      )`).all() as unknown as Array<{
        id: string; sizeBytes: number; ownBytes: number; descendantCount: number; unreadableCount: number
      }>
    for (const row of rows) {
      this.#propagatedToParent.set(row.id, {
        bytes: Number(row.sizeBytes) - Number(row.ownBytes),
        descendants: Number(row.descendantCount),
        unreadable: Number(row.unreadableCount)
      })
    }
  }

  #repairAffectedScheduler(): number {
    const rows = this.#database.prepare(`SELECT task.node_id AS id, task.status, nodes.scan_state AS scanState,
      parent.enumeration_complete AS parentEnumerationComplete, recovery.depth
      FROM directory_tasks task JOIN nodes ON nodes.id = task.node_id
      LEFT JOIN nodes parent ON parent.id = nodes.parent_id
      JOIN recovery_ancestors recovery ON recovery.id = task.node_id
      ORDER BY recovery.depth DESC, task.node_id COLLATE BINARY`).all() as unknown as Array<{
        id: string; status: string; scanState: string; parentEnumerationComplete?: number; depth: number
      }>
    const roots = new Set((this.#database.prepare('SELECT id FROM recovery_roots').all() as unknown as Array<{ id: string }>).map((row) => row.id))
    const pendingChildren = this.#database.prepare(`SELECT COUNT(*) AS count FROM nodes child
      JOIN directory_tasks child_task ON child_task.node_id = child.id
      WHERE child.parent_id = ? AND child_task.subtree_complete = 0`)
    const update = this.#database.prepare('UPDATE directory_tasks SET pending_children = ?, subtree_complete = ?, ready = ? WHERE node_id = ?')
    for (const row of rows) {
      const pending = Number((pendingChildren.get(row.id) as { count: number }).count)
      const subtreeComplete = (row.scanState === 'complete' || row.scanState === 'unreadable') && pending === 0
      const terminal = row.status === 'complete' || row.status === 'unreadable'
      const ready = terminal || subtreeComplete ? 0 : roots.has(row.id) || Number(row.parentEnumerationComplete ?? 0) === 1 ? 1 : 0
      update.run(pending, subtreeComplete ? 1 : 0, ready, row.id)
    }
    return rows.length
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
    return this.#readModel.getNode(id)
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    this.#flushPendingMetadataBatch()
    return this.#readModel.getChildren(id, limit)
  }

  countChildren(id: string): number {
    this.#flushPendingMetadataBatch()
    return this.#readModel.countChildren(id)
  }

  getLargestItems(id: string): readonly NodeSummary[] {
    return this.getChildren(id, 100).map(toSummary)
  }

  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    return this.#readModel.getBreadcrumbs(id)
  }

  resolvePath(id: string): string | undefined {
    const row = this.#database.prepare("SELECT path FROM nodes WHERE id = ?").get(id) as { path?: string } | undefined
    return row?.path
  }

  writeMetadata(meta: ScanDatabaseMeta): void {
    this.#assertBuilding()
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
    const capturedAt = meta.capturedAt ?? new Date(this.#clock()).toISOString()
    this.#insertMetadata.run("capturedAt", capturedAt)
    this.#insertMetadata.run("refreshedAt", meta.refreshedAt ?? capturedAt)
    if (meta.resume) {
      this.#insertMetadata.run('resumeDrainedThrough', meta.resume.drainedThrough)
      this.#insertMetadata.run('resumeDirtyScopes', JSON.stringify(meta.resume.dirtyScopes))
    }
  }

  #finishCandidate(command: Extract<ConstructionFinishCommand, { readonly kind: "finalize" }>): ConstructionFinishResult {
    this.#assertBuilding()
    const candidatePath = this.#candidatePath
    if (!candidatePath) throw new Error('Construction database has no candidate path')
    if (resolve(candidatePath) === resolve(this.#path)) throw new Error('Construction and candidate paths must differ')
    const metadata = command.metadata ?? this.#readMetadata()
    if (!metadata) throw new Error('Construction database has no final metadata')

    if (this.phase !== 'finalizing') {
      this.#assertNoPendingTasks()
      this.#setPhase('awaiting-reconciliation')
      this.checkpoint({ ...command.checkpoint, reason: 'finalize' })
      this.#setPhase('finalizing')
      if (command.metadata) this.writeMetadata(metadata)
      this.checkpoint({ reason: 'finalize' })
    } else {
      this.#flushPendingMetadataBatch()
      this.#assertNoPendingTasks()
    }

    // End the fresh transaction opened by checkpoint(). The source remains a
    // valid construction database until the candidate is fully built.
    this.#database.exec('ROLLBACK')
    this.#database.exec('PRAGMA synchronous=FULL; PRAGMA wal_checkpoint(TRUNCATE)')
    this.#close()
    const candidateStagingPath = `${candidatePath}.staging-${randomBytes(8).toString('hex')}`
    const constructionStagingPath = `${this.#path}.staging-${randomBytes(8).toString('hex')}`
    let published = false
    try {
      removeDatabaseArtifacts(candidatePath)
      removeDatabaseArtifacts(candidateStagingPath)
      removeDatabaseArtifacts(constructionStagingPath)
      // Keep the original partial inode for the candidate (publication
      // identity is stable), then break the link before either side is
      // mutated so an interrupted finalization still has an independent,
      // resumable construction database.
      linkSync(this.#path, candidateStagingPath)
      copyFileSync(this.#path, constructionStagingPath)
      syncFile(constructionStagingPath)
      renameSync(constructionStagingPath, this.#path)
      syncDirectory(dirname(this.#path))
      finalizeCandidateFile(candidateStagingPath)
      validateFinalCandidateFile(candidateStagingPath, metadata)
      syncFile(candidateStagingPath)
      renameSync(candidateStagingPath, candidatePath)
      syncDirectory(dirname(candidatePath))
      published = true
    } catch (error) {
      if (!published) removeDatabaseArtifacts(candidatePath)
      throw error
    } finally {
      removeDatabaseArtifacts(candidateStagingPath)
      removeDatabaseArtifacts(constructionStagingPath)
    }
    return { kind: 'candidate', candidatePath, metadata }
  }

  #readMetadata(): ScanDatabaseMeta | undefined {
    const values = Object.fromEntries((this.#database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
    if (!values.target || !values.rootId || !values.volume || !values.totals || values.scannedBytes === undefined) return undefined
    try {
      const volume = JSON.parse(values.volume) as { capacityBytes?: unknown; freeBytes?: unknown }
      const totals = JSON.parse(values.totals) as ScanDatabaseMeta['totals']
      const dirtyScopes = JSON.parse(values.resumeDirtyScopes ?? '[]') as unknown
      const resume = typeof values.resumeDrainedThrough === 'string' && Array.isArray(dirtyScopes) && dirtyScopes.every((scope) => typeof scope === 'string')
        ? { drainedThrough: values.resumeDrainedThrough, dirtyScopes: dirtyScopes as string[] }
        : undefined
      return {
        target: values.target, rootId: values.rootId, capacityBytes: Number(volume.capacityBytes ?? 0), freeBytes: Number(volume.freeBytes ?? 0),
        scannedBytes: Number(values.scannedBytes), totals,
        ...(values.targetDevice ? { targetDevice: values.targetDevice } : {}),
        ...(values.targetInode ? { targetInode: values.targetInode } : {}),
        ...(values.indexDirectoryIdentity ? { indexDirectoryIdentity: values.indexDirectoryIdentity } : {}),
        ...(values.indexRevision ? { indexRevision: Number(values.indexRevision) } : {}),
        ...(values.capturedAt ? { capturedAt: values.capturedAt } : {}),
        ...(values.refreshedAt ? { refreshedAt: values.refreshedAt } : {}),
        ...(resume ? { resume } : {})
      }
    } catch { return undefined }
  }

  #assertNoPendingTasks(): void {
    const pending = this.#database.prepare("SELECT COUNT(*) AS count FROM directory_tasks WHERE status IN ('queued', 'scanning')").get() as { count: number }
    if (Number(pending.count) !== 0) throw new Error("Cannot publish an index with queued directory work")
  }

  finalize(): void {
    this.#assertBuilding()
    this.#flushPendingMetadataBatch()
    this.#assertNoPendingTasks()
    finalizeConstructionSchema(this.#database)
  }

  complete(): void {
    this.#assertBuilding()
    this.#flushPendingMetadataBatch()
    measureScan("database-commit", () => this.#database.exec("COMMIT"))
    this.#state = "committed"
    try {
      this.#database.exec('PRAGMA synchronous=FULL')
      measureScanWork("database-checkpoint", () => this.#database.exec("PRAGMA wal_checkpoint(TRUNCATE)"))
      measureScan("database-optimize", () => this.#database.exec("PRAGMA optimize"))
    }
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

  #parentId(id: string): string | null {
    const pending = this.#metadataBatch.fileNodes.get(id)
    if (pending) return pending.parentId
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

function migrateConstructionSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'scan_run'").get() as { sql?: string } | undefined
  const schema = row?.sql ?? ''
  if (!schema.includes("'traversing'") && !schema.includes("'scanning'")) throw new Error('Unsupported construction database schema')
  database.exec('BEGIN IMMEDIATE')
  try {
    if (!schema.includes("'paused'")) database.exec(`
      ALTER TABLE scan_run RENAME TO scan_run_legacy;
      CREATE TABLE scan_run (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1), scan_id TEXT NOT NULL UNIQUE, node_id_seed TEXT NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('scanning', 'paused', 'awaiting-reconciliation', 'finalizing')),
        checkpoint_sequence INTEGER NOT NULL DEFAULT 0, active_elapsed_ms INTEGER NOT NULL DEFAULT 0,
        journal_device TEXT NOT NULL, journal_uuid TEXT NOT NULL, journal_baseline TEXT NOT NULL,
        drained_through TEXT NOT NULL, checkpointed_at TEXT NOT NULL
      );
      INSERT INTO scan_run SELECT singleton, scan_id, node_id_seed, CASE phase WHEN 'traversing' THEN 'scanning' ELSE phase END,
        checkpoint_sequence, active_elapsed_ms, journal_device, journal_uuid, journal_baseline, drained_through, checkpointed_at FROM scan_run_legacy;
      DROP TABLE scan_run_legacy;
    `)
    const taskColumns = new Set((database.prepare('PRAGMA table_info(directory_tasks)').all() as unknown as Array<{ name: string }>).map((column) => column.name))
    if (!taskColumns.has('ready')) database.exec('ALTER TABLE directory_tasks ADD COLUMN ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1))')
    if (!taskColumns.has('pending_children')) database.exec('ALTER TABLE directory_tasks ADD COLUMN pending_children INTEGER NOT NULL DEFAULT 0 CHECK (pending_children >= 0)')
    if (!taskColumns.has('subtree_complete')) database.exec('ALTER TABLE directory_tasks ADD COLUMN subtree_complete INTEGER NOT NULL DEFAULT 0 CHECK (subtree_complete IN (0,1))')
    if (!taskColumns.has('shallow_band')) database.exec('ALTER TABLE directory_tasks ADD COLUMN shallow_band INTEGER NOT NULL DEFAULT 0 CHECK (shallow_band IN (0,1))')
    database.exec(`
      UPDATE directory_tasks SET shallow_band = CASE WHEN depth <= 6 THEN 0 ELSE 1 END;
      UPDATE directory_tasks SET subtree_complete = CASE WHEN node_id IN
        (SELECT id FROM nodes WHERE scan_state IN ('complete', 'unreadable')) THEN 1 ELSE 0 END;
      UPDATE directory_tasks SET pending_children = (SELECT COUNT(*) FROM nodes child JOIN directory_tasks child_task ON child_task.node_id = child.id
        WHERE child.parent_id = directory_tasks.node_id AND child_task.subtree_complete = 0);
      UPDATE directory_tasks SET ready = CASE WHEN subtree_complete = 1 THEN 0 WHEN node_id IN (SELECT id FROM nodes WHERE parent_id IS NULL) THEN 1
        WHEN node_id IN (SELECT child.id FROM nodes child JOIN nodes parent ON parent.id = child.parent_id WHERE parent.enumeration_complete = 1) THEN 1 ELSE 0 END;
      DROP INDEX IF EXISTS tasks_schedule;
      CREATE INDEX IF NOT EXISTS tasks_ready_schedule ON directory_tasks (ready, focused, status, shallow_band, depth, enqueue_order);
      COMMIT;
    `)
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* Preserve the migration error. */ }
    throw error
  }
}

function emptyResumeRecoveryReport(): ResumeRecoveryReport {
  return { roots: 0, deletedNodes: 0, affectedHardlinkIdentities: 0, repairedAncestors: 0, repairedSchedulerRows: 0 }
}

function emptyConstructionPageResult(): MutableConstructionPageResult {
  return {
    scannedItems: 0, discoveredBytes: 0, skippedItems: 0, unreadableItems: 0, disappearingItems: 0,
    symlinks: 0, nestedMounts: 0, duplicateHardLinks: 0, bulkMetadataEntries: 0, fallbackMetadataEntries: 0
  }
}

function comparePathKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function isDecimalEventId(value: string): boolean { return /^(?:0|[1-9]\d*)$/u.test(value) }

function validateFinalCandidateFile(path: string, metadata: ScanDatabaseMeta): void {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
    database.exec('PRAGMA foreign_keys=ON')
    if (integrity.integrity_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length > 0) throw new Error('Final candidate failed SQLite validation')
    const constructionTables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN ('directory_tasks', 'hardlink_owners', 'scan_state', 'scan_run', 'scan_counters', 'dirty_scopes', 'size_estimates', 'estimate_roots')`).get() as { count?: number }
    if (Number(constructionTables.count ?? 0) !== 0) throw new Error('Final candidate still contains construction tables')
    const values = Object.fromEntries((database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
    const pending = database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE scan_state IN ('queued', 'scanning')").get() as { count?: number }
    const roots = database.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id IS NULL').get() as { count?: number }
    const root = database.prepare('SELECT id, size_bytes AS sizeBytes FROM nodes WHERE parent_id IS NULL').get() as { id?: string; sizeBytes?: number } | undefined
    if (values.target !== metadata.target || values.rootId !== metadata.rootId || Number(values.scannedBytes) !== metadata.scannedBytes
      || Number(pending.count ?? 0) !== 0 || Number(roots.count ?? 0) !== 1 || root?.id !== metadata.rootId || Number(root.sizeBytes) !== metadata.scannedBytes) {
      throw new Error('Final candidate metadata does not match construction state')
    }
  } finally { database.close() }
}

function finalizeConstructionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX nodes_parent_size ON nodes (parent_id, size_bytes DESC, name COLLATE NOCASE ASC, id ASC);
    INSERT INTO hardlink_groups (device, inode, owner_path_key, node_id, allocated_bytes)
      SELECT nodes.device, nodes.inode, aliases.path_key, nodes.id, nodes.own_bytes
      FROM nodes JOIN hardlink_paths aliases
        ON aliases.parent_id = nodes.parent_id AND aliases.name = nodes.name
          AND aliases.device = nodes.device AND aliases.inode = nodes.inode
      WHERE nodes.kind = 'file' AND nodes.device <> '' AND nodes.inode <> '';
    DROP INDEX nodes_parent_preview;
    DROP INDEX nodes_identity_idx;
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

function removeDatabaseArtifacts(path: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try { rmSync(`${path}${suffix}`, { force: true }) } catch { /* Cleanup is best effort. */ }
  }
}

function syncFile(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, 'r')
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function finalizeCandidateFile(path: string): void {
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; BEGIN')
    finalizeConstructionSchema(database)
    database.exec('COMMIT')
    database.exec('PRAGMA optimize')
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* Preserve the candidate error. */ }
    throw error
  } finally { database.close() }
}

function hardLinkIdentity(device: string, inode: string): string { return `${device}\0${inode}` }
function safeBytes(value: unknown): number { const number = typeof value === "bigint" ? Number(value) : Number(value); return Number.isFinite(number) && number > 0 ? number : 0 }
