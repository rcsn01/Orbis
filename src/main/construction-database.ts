import { closeSync, copyFileSync, fsyncSync, linkSync, openSync, renameSync, rmSync } from "node:fs"
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { createHmac, randomBytes } from "node:crypto"
import { dirname, join, relative, resolve } from "node:path"
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
  readonly enumerationEpoch: number
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
  readonly enumerationEpoch: number
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
  readonly enumerationEpoch: number
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
  readonly seenEpoch: number
}

interface PendingHardLinkPath {
  readonly parentId: string
  readonly name: string
  readonly pathKey: string
  readonly device: string
  readonly inode: string
  readonly allocatedBytes: number
  readonly seenEpoch: number
}

interface PendingHardLinkOwner extends HardLinkOwner {
  readonly device: string
  readonly inode: string
}

interface ReplayNodeRow {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly ownBytes: number
  readonly sizeBytes: number
  readonly ownUnreadable: number
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

export interface ConstructionCheckpointNotice {
  readonly sequence: number
  readonly reason: ConstructionCheckpointReason
  readonly phase: ConstructionPhase
  readonly count: number
}

export type ConstructionCheckpointHandler =
  | ((notice: ConstructionCheckpointNotice) => void)
  | ((reason: ConstructionCheckpointReason, sequence: number) => void)

export interface ProgressiveConstructionOptions {
  readonly scanId: string
  readonly nodeIdSeed?: string
  readonly journalDevice: string
  readonly journalUuid: string
  readonly journalBaseline: string
  readonly candidatePath?: string
  readonly clock?: () => number
  readonly onCheckpoint?: ConstructionCheckpointHandler
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
  readonly #onCheckpoint: ConstructionCheckpointHandler | undefined
  readonly #database: DatabaseSync
  readonly #insertNode: StatementSync
  readonly #findNodeIdentity: StatementSync
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
  #replayMode = false
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
  #checkpointCount = 0

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
          seen_epoch INTEGER NOT NULL DEFAULT 0,
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
          enumeration_epoch INTEGER NOT NULL DEFAULT 1,
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
          seen_epoch INTEGER NOT NULL DEFAULT 0,
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
          checkpointed_at TEXT NOT NULL,
          resume_replay_pending INTEGER NOT NULL DEFAULT 0 CHECK (resume_replay_pending IN (0,1))
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
        const run = this.#database.prepare('SELECT resume_replay_pending AS replayPending FROM scan_run WHERE singleton = 1').get() as { replayPending?: number } | undefined
        if (!run) throw new Error('Construction database has no scan run')
        this.#replayMode = Number(run.replayPending ?? 0) === 1
      }
      this.#readModel = new NodeReadModel(this.#database, "construction")
      this.#insertNode = this.#database.prepare(`
        INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, seen_epoch, depth)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.#findNodeIdentity = this.#database.prepare('SELECT parent_id AS parentId, name, path, kind FROM nodes WHERE id = ?')
      this.#insertFileNodeBatch = this.#database.prepare(`
        INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, seen_epoch, depth)
        SELECT json_extract(value, '$.id'), json_extract(value, '$.parentId'), json_extract(value, '$.name'),
          json_extract(value, '$.path'), 'file', json_extract(value, '$.ownBytes'), json_extract(value, '$.ownBytes'),
          json_extract(value, '$.device'), json_extract(value, '$.inode'), 'complete', 1, COALESCE(json_extract(value, '$.seenEpoch'), 0), json_extract(value, '$.depth')
        FROM json_each(?)
      `)
      this.#insertTask = this.#database.prepare(`
        INSERT INTO directory_tasks (node_id, path, depth, enqueue_order, focused, status, entries_read, enumeration_epoch, ready, shallow_band)
        VALUES (?, ?, ?, (SELECT value FROM scan_state WHERE key = 'enqueue'), ?, 'queued', 0, ?, ?, ?)
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
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes, seen_epoch) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      this.#insertHardLinkPathBatch = this.#database.prepare(`
        INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes, seen_epoch)
        SELECT json_extract(value, '$.parentId'), json_extract(value, '$.name'), json_extract(value, '$.pathKey'),
          json_extract(value, '$.device'), json_extract(value, '$.inode'), json_extract(value, '$.allocatedBytes'),
          COALESCE(json_extract(value, '$.seenEpoch'), 0)
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
      const readySelect = `SELECT node_id AS id, path, depth, focused, entries_read AS entriesRead,
        enumeration_epoch AS enumerationEpoch
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

  isDuplicateChild(node: InsertNode): boolean {
    this.#assertBuilding()
    const pending = this.#metadataBatch.fileNodes.get(node.id)
    const existing = pending
      ? { parentId: pending.parentId, name: pending.name, path: pending.path, kind: 'file' as const }
      : this.#findNodeIdentity.get(node.id) as unknown as { parentId: string | null; name: string; path: string; kind: InsertNode['kind'] } | undefined
    if (!existing) return false
    // Metadata can repeat across pages, so keep the first observation's
    // accounting. A changed kind is not a repeat: it would create a row with
    // incompatible traversal/accounting semantics under the same node ID.
    if (existing.parentId === node.parentId && existing.name === node.name && existing.path === node.path && existing.kind === node.kind) return true
    throw new Error(`Construction node ID collision for ${node.id}`)
  }

  insertChild(node: InsertNode, depth: number, focused: boolean, seenEpoch = 0): void {
    const state: DirectoryScanState = node.kind === "directory" ? "queued" : "complete"
    this.#insert(node, depth, state, seenEpoch)
    this.#attachPendingEstimate(node)
    this.#applyAncestorDelta(node.parentId, node.ownBytes, 1, 0)
    if (node.parentId) this.#applyDirectChildDelta(node.parentId, 1)
    if (node.kind === "directory") this.#queue(node.id, node.path, depth, focused, seenEpoch > 0 ? seenEpoch : 1)
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

  #insert(node: InsertNode, depth: number, state: DirectoryScanState, seenEpoch = 0): void {
    this.#assertBuilding()
    const ownBytes = safeBytes(node.ownBytes)
    const batch = this.#metadataBatch
    if (batch && node.kind === "file" && node.parentId) {
      batch.fileNodes.set(node.id, { id: node.id, parentId: node.parentId, name: node.name, path: node.path, ownBytes, device: node.device, inode: node.inode, depth, seenEpoch })
      return
    }
    this.#insertNode.run(node.id, node.parentId, node.name, node.path, node.kind, ownBytes, ownBytes, node.device, node.inode, state, node.kind === "file" ? 1 : 0, seenEpoch, depth)
    if (node.kind === "directory") this.#insertDirectoryObservation.run(node.id, state)
  }

  #queue(id: string, path: string, depth: number, focused: boolean, enumerationEpoch = 1): void {
    this.#incrementEnqueue.run()
    const parentId = this.#parentId(id)
    this.#insertTask.run(id, path, depth, focused ? 1 : 0, enumerationEpoch, parentId ? 0 : 1, depth <= 6 ? 0 : 1)
    if (parentId) this.#database.prepare('UPDATE directory_tasks SET pending_children = pending_children + 1 WHERE node_id = ?').run(parentId)
    this.#pendingSubtrees += 1
  }

  takeWork(request: ConstructionWorkRequest): ConstructionWorkBatch {
    this.#assertBuilding()
    if (this.#leasedTaskIds.length > 0) throw new ConstructionError("illegal-transition", "Construction work is already leased")
    const limit = Math.max(1, Math.floor(request.limit))
    let focusTurns = Math.max(0, Math.floor(request.focusTurns))
    type ReadyRow = { id: string; path: string; depth: number; focused: number; entriesRead: number; enumerationEpoch: number }
    const focused = this.#selectReadyFocused.all(1, limit) as unknown as ReadyRow[]
    const normal = this.#selectReadyNormal.all(0, limit) as unknown as ReadyRow[]
    recordScanCounter('schedulerSelects', 2)
    let focusedIndex = 0
    let normalIndex = 0
    const work: DirectoryTask[] = []
    while (work.length < limit && (focusedIndex < focused.length || normalIndex < normal.length)) {
      const takeFocused = focusedIndex < focused.length && (focusTurns < 3 || normalIndex >= normal.length)
      const row = takeFocused ? focused[focusedIndex++]! : normal[normalIndex++]!
      work.push({ id: row.id, path: row.path, depth: Number(row.depth), focused: Boolean(row.focused), entriesRead: Number(row.entriesRead), enumerationEpoch: Number(row.enumerationEpoch) })
      if (row.focused) focusTurns += 1
      else focusTurns = 0
      if (row.focused && focusTurns >= 3 && normalIndex < normal.length) focusTurns = 3
    }
    this.#leasedTaskIds.push(...work.map((task) => task.id))
    if (work.length === 0 && this.#pendingSubtrees > 0) throw new ConstructionError('pending-work', 'Construction has pending subtrees but no ready work')
    if (work.length === 0 && this.#pendingSubtrees === 0 && this.#replayMode) this.#reconcileReplayState()
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
        this.#assertTaskEpoch(input.taskId, input.enumerationEpoch)
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
    if (!Number.isSafeInteger(page.entriesRead) || page.entriesRead < 0 || !Number.isSafeInteger(page.enumerationEpoch) || page.enumerationEpoch < 1) throw new Error('Invalid construction page cursor')
    const result = this.applyMetadataBatch(() => {
      this.#assertPageCursor(page)
      const totals = emptyConstructionPageResult()
      if (!page.done) this.startTask(page.taskId)
      for (const entry of page.entries) this.#applyPageEntry(entry, page, totals)
      if (this.#resumable) this.addMetadataCounters(page.bulkMetadataEntries, page.fallbackMetadataEntries)
      this.bumpRevision()
      this.#advanceTask(page.taskId, page.entriesRead, page.entries.length)
      if (this.#replayMode) this.#flushPendingMetadataBatch()
      if (page.done) this.finishEnumeration(page.taskId, page.enumerationEpoch)
      else this.yieldTask(page.taskId)
      totals.bulkMetadataEntries = Math.max(0, Math.floor(page.bulkMetadataEntries))
      totals.fallbackMetadataEntries = Math.max(0, Math.floor(page.fallbackMetadataEntries))
      return totals
    })
    if (page.checkpointAfter) this.checkpoint(page.checkpointAfter)
    return result
  }

  #assertPageCursor(page: ConstructionPage): void {
    const row = this.#database.prepare('SELECT entries_read AS entriesRead, depth, status, enumeration_epoch AS enumerationEpoch FROM directory_tasks WHERE node_id = ?').get(page.taskId) as { entriesRead?: number; depth?: number; status?: string; enumerationEpoch?: number } | undefined
    if (!row || Number(row.entriesRead) !== page.entriesRead || Number(row.depth) !== page.depth || row.status !== 'queued' && row.status !== 'scanning'
      || Number(row.enumerationEpoch) !== page.enumerationEpoch) {
      throw new Error(`Stale construction page for ${page.taskId}`)
    }
  }

  #assertTaskEpoch(id: string, epoch: number | undefined): void {
    if (epoch === undefined) throw new Error(`Missing construction task epoch for ${id}`)
    const row = this.#database.prepare('SELECT enumeration_epoch AS enumerationEpoch FROM directory_tasks WHERE node_id = ?').get(id) as { enumerationEpoch?: number } | undefined
    if (!row || Number(row.enumerationEpoch) !== epoch) throw new Error(`Stale construction task for ${id}`)
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
    if (this.#replayMode) {
      this.#applyReplayNodeEntry(node, pathKey, linkCount, page, totals)
      return
    }
    if (this.isDuplicateChild(node)) return
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

  #applyReplayNodeEntry(node: InsertNode, pathKey: string, linkCount: number | undefined, page: ConstructionPage,
    totals: MutableConstructionPageResult): void {
    this.#flushPendingMetadataBatch()
    const epoch = this.#taskEpoch(page.taskId)
    const bytes = safeBytes(node.ownBytes)
    const existing = this.#replayNode(node.id)
    const sameIdentity = existing !== undefined && existing.parentId === node.parentId && existing.name === node.name
      && existing.kind === node.kind && (node.kind !== 'file' || existing.device === node.device && existing.inode === node.inode)
    const tracked = node.kind === 'file' && node.device !== '' && node.inode !== '' && linkCount !== 1
    const knownSingleton = node.kind === 'file' && node.device !== '' && node.inode !== '' && linkCount === 1
    if (sameIdentity) {
      const oldBytes = existing.ownBytes
      this.#updateReplayNode(existing, node, bytes, epoch, page.depth + 1)
      if (tracked && node.parentId) this.#upsertReplayHardLinkPath(node.parentId, node.name, pathKey, node.device, node.inode, bytes, epoch)
      else if (knownSingleton) this.#deleteReplayHardLinkPathsForIdentity(node.device, node.inode)
      else this.#deleteReplayHardLinkPath(node.parentId, node.name, pathKey)
      if (oldBytes !== bytes && node.parentId) this.#applyAncestorDelta(node.parentId, bytes - oldBytes, 0, 0)
      return
    }

    if (knownSingleton) this.#deleteReplayHardLinkPathsForIdentity(node.device, node.inode)

    if (existing) this.#deleteReplayNode(existing)
    this.#deleteReplayHardLinkPath(node.parentId, node.name, pathKey)
    if (tracked && node.parentId) this.#upsertReplayHardLinkPath(node.parentId, node.name, pathKey, node.device, node.inode, bytes, epoch)
    this.insertChild(node, page.depth + 1, page.focused, epoch)
    totals.scannedItems += 1
    totals.discoveredBytes += bytes
  }

  #replayNode(id: string): ReplayNodeRow | undefined {
    const row = this.#database.prepare(`SELECT id, parent_id AS parentId, name, path, kind, own_bytes AS ownBytes,
      size_bytes AS sizeBytes, own_unreadable AS ownUnreadable, device, inode FROM nodes WHERE id = ?`).get(id) as unknown as ReplayNodeRow | undefined
    return row
  }

  #taskEpoch(id: string): number {
    const row = this.#database.prepare('SELECT enumeration_epoch AS enumerationEpoch FROM directory_tasks WHERE node_id = ?').get(id) as { enumerationEpoch?: number } | undefined
    if (row?.enumerationEpoch === undefined) throw new Error(`Missing construction task ${id}`)
    return Number(row.enumerationEpoch)
  }

  #updateReplayNode(existing: ReplayNodeRow, node: InsertNode, bytes: number, epoch: number, depth: number): void {
    const size = node.kind === 'file' ? bytes : existing.sizeBytes + bytes - existing.ownBytes
    this.#database.prepare(`UPDATE nodes SET parent_id = ?, name = ?, path = ?, own_bytes = ?, size_bytes = ?,
      own_unreadable = ?, device = ?, inode = ?, seen_epoch = ?, depth = ? WHERE id = ?`).run(
      node.parentId, node.name, node.path, bytes, size, Math.max(0, Math.floor(node.ownUnreadable ?? 0)),
      node.device, node.inode, epoch, depth, node.id)
    if (node.kind === 'directory') this.#refreshReplaySubtreePaths(node.id, node.path, depth)
  }

  #refreshReplaySubtreePaths(rootId: string, rootPath: string, rootDepth: number): void {
    const rows = this.#database.prepare(`WITH RECURSIVE subtree(id, parent_id, name, level) AS (
      SELECT id, parent_id, name, 0 FROM nodes WHERE id = ?
      UNION ALL
      SELECT child.id, child.parent_id, child.name, subtree.level + 1
      FROM nodes child JOIN subtree ON child.parent_id = subtree.id
    ) SELECT id, parent_id AS parentId, name, level FROM subtree ORDER BY level, id COLLATE BINARY`).all(rootId) as unknown as Array<{
      id: string; parentId: string | null; name: string; level: number
    }>
    const scanRoot = this.#database.prepare('SELECT path FROM nodes WHERE parent_id IS NULL').get() as { path?: string } | undefined
    if (!scanRoot?.path) throw new ConstructionError('invalid-resume', 'Missing replay scan root path')
    const paths = new Map<string, string>([[rootId, rootPath]])
    const updateNode = this.#database.prepare('UPDATE nodes SET path = ?, depth = ? WHERE id = ?')
    const updateTask = this.#database.prepare('UPDATE directory_tasks SET path = ?, depth = ? WHERE node_id = ?')
    const aliases = this.#database.prepare(`WITH RECURSIVE subtree(id) AS (
      SELECT id FROM nodes WHERE id = ?
      UNION ALL SELECT child.id FROM nodes child JOIN subtree parent ON child.parent_id = parent.id
    ) SELECT rowid AS rowId, parent_id AS parentId, name
      FROM hardlink_paths WHERE parent_id IN (SELECT id FROM subtree)`).all(rootId) as unknown as Array<{
        rowId: number; parentId: string; name: string
      }>
    const temporaryPathKey = this.#database.prepare('UPDATE hardlink_paths SET path_key = ? WHERE rowid = ?')
    const updatePathKey = this.#database.prepare('UPDATE hardlink_paths SET path_key = ? WHERE rowid = ?')
    // Path keys are the primary key. Move every affected alias through a
    // filesystem-impossible value first so a subtree rename cannot collide
    // with another alias while the prefixes are being rewritten.
    for (const alias of aliases) temporaryPathKey.run(`\u0000orbis-replay-${alias.rowId}`, alias.rowId)
    for (const row of rows) {
      const parentPath = row.id === rootId ? rootPath : paths.get(row.parentId ?? '')
      if (!parentPath) throw new ConstructionError('invalid-resume', `Missing replay parent path ${row.parentId}`)
      const path = row.id === rootId ? rootPath : join(parentPath, row.name)
      const depth = rootDepth + Number(row.level)
      paths.set(row.id, path)
      updateNode.run(path, depth, row.id)
      updateTask.run(path, depth, row.id)
    }
    for (const alias of aliases) {
      const parentPath = paths.get(alias.parentId)
      if (!parentPath) throw new ConstructionError('invalid-resume', `Missing replay alias parent path ${alias.parentId}`)
      updatePathKey.run(relative(scanRoot.path, join(parentPath, alias.name)), alias.rowId)
    }
  }

  #deleteReplayNode(node: ReplayNodeRow): void {
    this.#deleteReplayHardLinkPath(node.parentId, node.name, undefined)
    this.#database.prepare('DELETE FROM nodes WHERE id = ?').run(node.id)
  }

  #deleteReplayHardLinkPath(parentId: string | null, name: string, pathKey: string | undefined): void {
    if (pathKey !== undefined) this.#database.prepare('DELETE FROM hardlink_paths WHERE path_key = ?').run(pathKey)
    if (parentId !== null) this.#database.prepare('DELETE FROM hardlink_paths WHERE parent_id = ? AND name = ?').run(parentId, name)
  }

  #deleteReplayHardLinkPathsForIdentity(device: string, inode: string): void {
    // Keep the old owner row until reconciliation captures the identity. If
    // the singleton is a new node ID, that row is the durable evidence needed
    // to remove the old representative after its aliases have disappeared.
    this.#database.prepare('DELETE FROM hardlink_paths WHERE device = ? AND inode = ?').run(device, inode)
  }

  #upsertReplayHardLinkPath(parentId: string, name: string, pathKey: string, device: string, inode: string,
    allocatedBytes: number, seenEpoch: number): void {
    this.#deleteReplayHardLinkPath(parentId, name, pathKey)
    this.#database.prepare(`INSERT INTO hardlink_paths (parent_id, name, path_key, device, inode, allocated_bytes, seen_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(parentId, name, pathKey, device, inode, safeBytes(allocatedBytes), seenEpoch)
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

  finishEnumeration(id: string, enumerationEpoch?: number): void {
    if (this.#replayMode) {
      this.#finishReplayEnumeration(id, enumerationEpoch)
      return
    }
    this.#database.prepare("UPDATE nodes SET enumeration_complete = 1 WHERE id = ?").run(id)
    this.#database.prepare("UPDATE directory_tasks SET status = 'complete' WHERE node_id = ?").run(id)
    this.#database.prepare("UPDATE directory_observations SET enumeration_status = 'complete' WHERE node_id = ?").run(id)
    this.#database.prepare(`UPDATE directory_tasks SET ready = 1 WHERE node_id IN
      (SELECT id FROM nodes WHERE parent_id = ?) AND status IN ('queued', 'scanning')`).run(id)
    this.#settleReadyTasks(id)
  }

  #finishReplayEnumeration(id: string, enumerationEpoch: number | undefined): void {
    this.#assertTaskEpoch(id, enumerationEpoch)
    const epoch = enumerationEpoch ?? this.#taskEpoch(id)
    this.#flushPendingMetadataBatch()
    this.#database.prepare('DELETE FROM hardlink_paths WHERE parent_id = ? AND seen_epoch <> ?').run(id, epoch)
    this.#database.prepare('DELETE FROM nodes WHERE parent_id = ? AND seen_epoch <> ?').run(id, epoch)
    this.#database.prepare(`UPDATE directory_tasks SET pending_children = (
      SELECT COUNT(*) FROM nodes child JOIN directory_tasks child_task ON child_task.node_id = child.id
      WHERE child.parent_id = ? AND child_task.subtree_complete = 0
    ) WHERE node_id = ?`).run(id, id)
    this.#recomputeDirectoryAggregate(id)
    this.#database.prepare("UPDATE nodes SET enumeration_complete = 1, scan_state = 'scanning' WHERE id = ?").run(id)
    this.#database.prepare("UPDATE directory_tasks SET status = 'complete' WHERE node_id = ?").run(id)
    this.#database.prepare("UPDATE directory_observations SET enumeration_status = 'complete' WHERE node_id = ?").run(id)
    this.#database.prepare(`UPDATE directory_tasks SET ready = 1 WHERE node_id IN
      (SELECT id FROM nodes WHERE parent_id = ?) AND status IN ('queued', 'scanning')`).run(id)
    this.#settleReadyTasks(id)
    this.#pendingSubtrees = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM directory_tasks WHERE subtree_complete = 0').get() as { count: number }).count)
  }

  #recomputeDirectoryAggregate(id: string): void {
    this.#database.prepare(`UPDATE nodes SET
      size_bytes = own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = nodes.id), 0),
      direct_children = (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id),
      descendant_count = COALESCE((SELECT SUM(1 + child.descendant_count) FROM nodes child WHERE child.parent_id = nodes.id), 0),
      unreadable_count = own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = nodes.id), 0)
      WHERE id = ? AND kind = 'directory'`).run(id)
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
    if (!this.#replayMode) this.#propagateToParent(id)
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

  insertHardLinkPath(parentId: string, name: string, pathKey: string, device: string, inode: string, allocatedBytes: number, seenEpoch = 0): void {
    recordScanCounter('hardlinkPathRows')
    const bytes = safeBytes(allocatedBytes)
    const batch = this.#metadataBatch
    if (batch) batch.hardlinkPaths.push({ parentId, name, pathKey, device, inode, allocatedBytes: bytes, seenEpoch })
    else this.#insertHardLinkPath.run(parentId, name, pathKey, device, inode, bytes, seenEpoch)
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
      if (row.scanState === 'unreadable') {
        if (!this.#replayMode) this.#propagateToParent(id)
      } else if (row.scanState !== 'complete') {
        this.#database.prepare("UPDATE nodes SET scan_state = 'complete' WHERE id = ?").run(id)
        if (!this.#replayMode) this.#propagateToParent(id)
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
    const notice: ConstructionCheckpointNotice = {
      sequence, reason: normalized.reason ?? 'scheduled', phase: this.phase, count: ++this.#checkpointCount
    }
    this.#emitCheckpoint(notice)
    return sequence
  }

  #emitCheckpoint(notice: ConstructionCheckpointNotice): void {
    const callback = this.#onCheckpoint
    if (!callback) return
    if (callback.length >= 2) (callback as (reason: ConstructionCheckpointReason, sequence: number) => void)(notice.reason, notice.sequence)
    else (callback as (notice: ConstructionCheckpointNotice) => void)(notice)
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
      COALESCE((SELECT SUM(own_bytes) FROM nodes), 0) AS discoveredBytes FROM nodes`).get() as { scannedItems: number; discoveredBytes: number }
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
    const propagatedSnapshot = new Map([...this.#propagatedToParent].map(([key, delta]) => [key, { ...delta }]))
    const previousReplayMode = this.#replayMode
    this.#flushPendingMetadataBatch()
    this.#database.exec('SAVEPOINT resume_recovery')
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
      if (phase === 'awaiting-reconciliation' || phase === 'finalizing') {
        this.#database.exec('RELEASE resume_recovery')
        return emptyResumeRecoveryReport()
      }

      const replayPending = this.#database.prepare('SELECT resume_replay_pending AS pending FROM scan_run WHERE singleton = 1').get() as { pending?: number } | undefined
      const alreadyReplaying = Number(replayPending?.pending ?? 0) === 1
      if (pendingTasks === 0) {
        if (alreadyReplaying) this.#reconcileReplayState()
        this.#database.exec('RELEASE resume_recovery')
        return emptyResumeRecoveryReport()
      }

      const roots = Number((this.#database.prepare(`SELECT COUNT(*) AS count FROM directory_tasks task
        WHERE task.status IN ('queued', 'scanning') AND NOT EXISTS (
          WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT parent.id, parent.parent_id FROM nodes child JOIN nodes parent ON parent.id = child.parent_id
              WHERE child.id = task.node_id
            UNION ALL SELECT parent.id, parent.parent_id FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
          ) SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
            WHERE ancestor_task.status IN ('queued', 'scanning')
        )`).get() as { count: number }).count)
      if (roots === 0) throw new ConstructionError('invalid-resume', 'Construction contains pending work without a replay root')

      const affectedHardlinkIdentities = Number((this.#database.prepare(`WITH RECURSIVE roots(id) AS (
        SELECT task.node_id FROM directory_tasks task
        WHERE task.status IN ('queued', 'scanning') AND NOT EXISTS (
          WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT node.id, node.parent_id FROM nodes node WHERE node.id = task.node_id
            UNION ALL SELECT parent.id, parent.parent_id FROM nodes parent JOIN ancestors child ON child.parent_id = parent.id
          ) SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
            WHERE ancestors.id <> task.node_id AND ancestor_task.status IN ('queued', 'scanning')
        )
      ), subtree(id) AS (
        SELECT id FROM roots UNION ALL SELECT child.id FROM nodes child JOIN subtree parent ON child.parent_id = parent.id
      ) SELECT COUNT(DISTINCT device || char(0) || inode) AS count FROM hardlink_paths
        WHERE device <> '' AND inode <> '' AND parent_id IN (SELECT id FROM subtree)`).get() as { count: number }).count)

      this.#database.exec(`
        UPDATE directory_tasks SET enumeration_epoch = enumeration_epoch + 1, entries_read = 0, status = 'queued', ready = 0
          WHERE status IN ('queued', 'scanning');
        UPDATE nodes SET scan_state = 'queued', enumeration_complete = 0, seen_epoch = 0
          WHERE id IN (SELECT node_id FROM directory_tasks WHERE status = 'queued' AND enumeration_epoch > 1);
        UPDATE directory_observations SET direct_skipped_count = 0, direct_unreadable_count = 0,
          direct_disappearing_count = 0, direct_symlink_count = 0, direct_nested_mount_count = 0,
          direct_duplicate_count = 0, enumeration_status = 'queued'
          WHERE node_id IN (SELECT node_id FROM directory_tasks WHERE status = 'queued' AND enumeration_epoch > 1);
        UPDATE scan_run SET resume_replay_pending = 1 WHERE singleton = 1;
      `)
      this.#replayMode = true
      this.#database.exec(`WITH RECURSIVE roots(id) AS (
        SELECT task.node_id FROM directory_tasks task
        WHERE task.status = 'queued' AND NOT EXISTS (
          WITH RECURSIVE ancestors(id, parent_id) AS (
            SELECT node.id, node.parent_id FROM nodes node WHERE node.id = task.node_id
            UNION ALL SELECT parent.id, parent.parent_id FROM nodes parent JOIN ancestors child ON child.parent_id = parent.id
          ) SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
            WHERE ancestors.id <> task.node_id AND ancestor_task.status = 'queued'
        )
      )
      UPDATE directory_tasks SET focused = 1
        WHERE node_id IN (SELECT id FROM roots) AND EXISTS (
          WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = directory_tasks.node_id
            UNION ALL SELECT child.id FROM nodes child JOIN subtree parent ON child.parent_id = parent.id
          ) SELECT 1 FROM directory_tasks descendant WHERE descendant.node_id IN (SELECT id FROM subtree) AND descendant.focused = 1
        );`)
      this.#rebuildScheduler()
      this.#rebuildPropagationBookkeeping()
      this.#pendingSubtrees = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM directory_tasks WHERE subtree_complete = 0').get() as { count: number }).count)
      const repairedAncestors = Number((this.#database.prepare(`WITH RECURSIVE roots(id) AS (
        SELECT task.node_id FROM directory_tasks task WHERE task.enumeration_epoch > 1
      ), ancestors(id) AS (
        SELECT id FROM roots UNION SELECT parent.id FROM nodes parent JOIN ancestors child ON child.id = parent.parent_id
      ) SELECT COUNT(*) AS count FROM ancestors`).get() as { count: number }).count)
      const repairedSchedulerRows = Number((this.#database.prepare('SELECT COUNT(*) AS count FROM directory_tasks').get() as { count: number }).count)
      this.#database.exec('RELEASE resume_recovery')
      return { roots, deletedNodes: 0, affectedHardlinkIdentities, repairedAncestors, repairedSchedulerRows }
    } catch (error) {
      try { this.#database.exec('ROLLBACK TO resume_recovery') } catch { /* Preserve the recovery error. */ }
      try { this.#database.exec('RELEASE resume_recovery') } catch { /* Preserve the recovery error. */ }
      this.#replayMode = previousReplayMode
      this.#propagatedToParent.clear()
      for (const [key, delta] of propagatedSnapshot) this.#propagatedToParent.set(key, delta)
      throw error
    }
  }

  #reconcileReplayState(): void {
    this.#assertBuilding()
    this.#flushPendingMetadataBatch()
    this.#database.exec('SAVEPOINT replay_reconciliation')
    const hardlinkTiming = createScanTimingAccumulator('resume-hardlink-repair')
    const aggregateTiming = createScanTimingAccumulator('resume-aggregate-repair')
    const schedulerTiming = createScanTimingAccumulator('resume-scheduler-repair')
    try {
      try { hardlinkTiming.measure(() => this.#rebuildHardLinkState()) } finally { hardlinkTiming.publish() }
      try { aggregateTiming.measure(() => this.#recomputeAllDirectoryAggregates()) } finally { aggregateTiming.publish() }
      this.#database.exec('DELETE FROM size_estimates; DELETE FROM estimate_roots;')
      try { schedulerTiming.measure(() => this.#rebuildScheduler()) } finally { schedulerTiming.publish() }
      this.#validateReconciledState()
      this.#database.prepare('UPDATE scan_run SET resume_replay_pending = 0 WHERE singleton = 1').run()
      this.#replayMode = false
      this.#rebuildPropagationBookkeeping()
      this.#pendingSubtrees = 0
      this.#database.exec('RELEASE replay_reconciliation')
    } catch (error) {
      try { this.#database.exec('ROLLBACK TO replay_reconciliation') } catch { /* Preserve the reconciliation error. */ }
      try { this.#database.exec('RELEASE replay_reconciliation') } catch { /* Preserve the reconciliation error. */ }
      this.#replayMode = true
      throw error
    }
  }

  #recomputeAllDirectoryAggregates(): void {
    const rows = this.#database.prepare(`SELECT id FROM nodes WHERE kind = 'directory' ORDER BY depth DESC, id COLLATE BINARY`).all() as unknown as Array<{ id: string }>
    for (const row of rows) this.#recomputeDirectoryAggregate(row.id)
  }

  #rebuildScheduler(): void {
    const rows = this.#database.prepare(`SELECT task.node_id AS id, task.status, node.parent_id AS parentId,
      node.depth AS depth, parent.enumeration_complete AS parentEnumerationComplete
      FROM directory_tasks task JOIN nodes node ON node.id = task.node_id
      LEFT JOIN nodes parent ON parent.id = node.parent_id ORDER BY node.depth DESC, task.node_id COLLATE BINARY`).all() as unknown as Array<{
        id: string; status: string; parentId: string | null; depth: number; parentEnumerationComplete?: number
      }>
    const pendingChildren = this.#database.prepare(`SELECT COUNT(*) AS count FROM nodes child
      JOIN directory_tasks childTask ON childTask.node_id = child.id
      WHERE child.parent_id = ? AND childTask.subtree_complete = 0`)
    const update = this.#database.prepare('UPDATE directory_tasks SET pending_children = ?, subtree_complete = ?, ready = ? WHERE node_id = ?')
    for (const row of rows) {
      const pending = Number((pendingChildren.get(row.id) as { count: number }).count)
      const terminal = row.status === 'complete' || row.status === 'unreadable'
      const subtreeComplete = terminal && pending === 0
      const ready = terminal || subtreeComplete ? 0 : row.parentId === null || Number(row.parentEnumerationComplete ?? 0) === 1 ? 1 : 0
      update.run(pending, subtreeComplete ? 1 : 0, ready, row.id)
    }
  }

  #rebuildPropagationBookkeeping(): void {
    this.#propagatedToParent.clear()
    const rows = this.#database.prepare(`SELECT id, size_bytes AS sizeBytes, own_bytes AS ownBytes,
        descendant_count AS descendantCount, unreadable_count AS unreadableCount
      FROM nodes WHERE parent_id IS NOT NULL AND scan_state IN ('complete', 'unreadable')`).all() as unknown as Array<{
        id: string; sizeBytes: number; ownBytes: number; descendantCount: number; unreadableCount: number
      }>
    for (const row of rows) this.#propagatedToParent.set(row.id, {
      bytes: Number(row.sizeBytes) - Number(row.ownBytes), descendants: Number(row.descendantCount), unreadable: Number(row.unreadableCount)
    })
  }

  #validateReconciledState(): void {
    const mismatch = this.#database.prepare(`SELECT node.id FROM nodes node
      WHERE node.kind = 'directory' AND (
        node.size_bytes <> node.own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = node.id), 0)
        OR node.direct_children <> (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = node.id)
        OR node.descendant_count <> COALESCE((SELECT SUM(1 + child.descendant_count) FROM nodes child WHERE child.parent_id = node.id), 0)
        OR node.unreadable_count <> node.own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = node.id), 0)
      ) ORDER BY node.id COLLATE BINARY LIMIT 1`).get() as { id?: string } | undefined
    if (mismatch?.id) throw new ConstructionError('invalid-resume', `Directory aggregate mismatch for ${mismatch.id}`)
    const foreignKey = this.#database.prepare('PRAGMA foreign_key_check').all()
    if (foreignKey.length > 0) throw new ConstructionError('invalid-resume', 'Construction foreign-key validation failed')
    const pending = this.#database.prepare("SELECT COUNT(*) AS count FROM directory_tasks WHERE status IN ('queued', 'scanning')").get() as { count: number }
    if (Number(pending.count) !== 0) throw new ConstructionError('pending-work', 'Replay reconciliation still has pending directory work')
    const invalidTask = this.#database.prepare(`SELECT node_id AS id FROM directory_tasks
      WHERE pending_children < 0 OR ready NOT IN (0,1) OR subtree_complete NOT IN (0,1)
        OR subtree_complete <> CASE WHEN status IN ('complete', 'unreadable') AND pending_children = 0 THEN 1 ELSE 0 END
      LIMIT 1`).get() as { id?: string } | undefined
    if (invalidTask?.id) throw new ConstructionError('invalid-resume', `Invalid scheduler state for ${invalidTask.id}`)
    const invalidReady = this.#database.prepare(`SELECT task.node_id AS id FROM directory_tasks task
      JOIN nodes node ON node.id = task.node_id LEFT JOIN nodes parent ON parent.id = node.parent_id
      WHERE task.ready <> CASE WHEN task.status IN ('complete', 'unreadable') OR task.subtree_complete = 1 THEN 0
        WHEN node.parent_id IS NULL OR parent.enumeration_complete = 1 THEN 1 ELSE 0 END LIMIT 1`).get() as { id?: string } | undefined
    if (invalidReady?.id) throw new ConstructionError('invalid-resume', `Invalid task readiness for ${invalidReady.id}`)
  }

  #rebuildHardLinkState(): void {
    const oldIdentityRows = this.#database.prepare(`SELECT DISTINCT device, inode FROM hardlink_owners
      WHERE device <> '' AND inode <> '' UNION SELECT DISTINCT device, inode FROM hardlink_paths
      WHERE device <> '' AND inode <> ''`).all() as unknown as Array<{ device: string; inode: string }>
    const oldIdentities = new Map(oldIdentityRows.map((identity) => [hardLinkIdentity(identity.device, identity.inode), identity]))
    const aliases = this.#database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode,
      allocated_bytes AS allocatedBytes FROM hardlink_paths WHERE device <> '' AND inode <> ''
      ORDER BY device COLLATE BINARY, inode COLLATE BINARY, path_key COLLATE BINARY`).all() as unknown as Array<{
        parentId: string; name: string; pathKey: string; device: string; inode: string; allocatedBytes: number
      }>
    const groups = new Map<string, typeof aliases>()
    for (const alias of aliases) {
      const key = hardLinkIdentity(alias.device, alias.inode)
      const group = groups.get(key) ?? []
      group.push(alias)
      groups.set(key, group)
    }
    const invalidObservation = this.#database.prepare(`SELECT node_id AS nodeId FROM directory_observations
      WHERE direct_duplicate_count > direct_skipped_count LIMIT 1`).get() as { nodeId?: string } | undefined
    if (invalidObservation?.nodeId) throw new ConstructionError('invalid-resume', `Inconsistent duplicate observation for directory ${invalidObservation.nodeId}`)
    this.#database.exec('DELETE FROM hardlink_owners')
    this.#database.prepare('UPDATE directory_observations SET direct_skipped_count = direct_skipped_count - direct_duplicate_count, direct_duplicate_count = 0 WHERE direct_duplicate_count > 0').run()
    const seed = Buffer.from(this.nodeIdSeed, 'hex')
    const findNodes = this.#database.prepare(`SELECT id, parent_id AS parentId, name, path, kind, own_bytes AS ownBytes,
      size_bytes AS sizeBytes, device, inode FROM nodes WHERE kind = 'file' AND device = ? AND inode = ? ORDER BY id COLLATE BINARY`)
    const updateNode = this.#database.prepare(`UPDATE nodes SET parent_id = ?, name = ?, path = ?, own_bytes = ?, size_bytes = ?,
      own_unreadable = 0, direct_children = 0, descendant_count = 0, unreadable_count = 0, device = ?, inode = ?,
      scan_state = 'complete', enumeration_complete = 1 WHERE id = ?`)
    const insertAliasOwner = this.#database.prepare('INSERT INTO hardlink_owners (device, inode, node_id, path_key) VALUES (?, ?, ?, ?)')
    const collision = this.#database.prepare('SELECT kind, device, inode FROM nodes WHERE id = ?')
    const bumpDuplicate = this.#database.prepare(`UPDATE directory_observations SET direct_skipped_count = direct_skipped_count + 1,
      direct_duplicate_count = direct_duplicate_count + 1 WHERE node_id = ?`)
    const deleteNode = this.#database.prepare('DELETE FROM nodes WHERE id = ?')
    for (const group of groups.values()) {
      group.sort((left, right) => comparePathKeys(left.pathKey, right.pathKey))
      const owner = group[0]!
      const ownerParent = this.#database.prepare("SELECT path, depth FROM nodes WHERE id = ? AND kind = 'directory'").get(owner.parentId) as { path?: string; depth?: number } | undefined
      if (!ownerParent?.path || ownerParent.depth === undefined) throw new ConstructionError('invalid-resume', `Missing hard-link parent ${owner.parentId}`)
      const nodeId = `n-${createHmac('sha256', seed).update(owner.parentId).update('\0').update(owner.name).digest('hex').slice(0, 32)}`
      const idCollision = collision.get(nodeId) as { kind?: string; device?: string; inode?: string } | undefined
      if (idCollision && (idCollision.kind !== 'file' || idCollision.device !== owner.device || idCollision.inode !== owner.inode)) {
        throw new ConstructionError('invalid-resume', `Node identity collision for ${nodeId}`)
      }
      const expectedPath = join(ownerParent.path, owner.name)
      const current = findNodes.all(owner.device, owner.inode) as unknown as Array<{ id: string; parentId: string | null; name: string; path: string; ownBytes: number; sizeBytes: number }>
      for (const node of current) if (node.id !== nodeId) deleteNode.run(node.id)
      const representative = current.find((node) => node.id === nodeId)
      if (representative) updateNode.run(owner.parentId, owner.name, expectedPath, safeBytes(owner.allocatedBytes), safeBytes(owner.allocatedBytes), owner.device, owner.inode, nodeId)
      else this.#insertNode.run(nodeId, owner.parentId, owner.name, expectedPath, 'file', safeBytes(owner.allocatedBytes), safeBytes(owner.allocatedBytes), owner.device, owner.inode, 'complete', 1, 0, Number(ownerParent.depth) + 1)
      insertAliasOwner.run(owner.device, owner.inode, nodeId, owner.pathKey)
      for (const duplicate of group.slice(1)) bumpDuplicate.run(duplicate.parentId)
    }
    for (const identity of oldIdentities.values()) {
      const key = hardLinkIdentity(identity.device, identity.inode)
      if (groups.has(key)) continue
      this.#database.prepare(`DELETE FROM nodes WHERE kind = 'file' AND device = ? AND inode = ?
        AND NOT EXISTS (SELECT 1 FROM directory_tasks task WHERE task.node_id = nodes.parent_id AND task.enumeration_epoch = nodes.seen_epoch)`).run(identity.device, identity.inode)
    }
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
    if (this.#replayMode) this.#reconcileReplayState()

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
        drained_through TEXT NOT NULL, checkpointed_at TEXT NOT NULL,
        resume_replay_pending INTEGER NOT NULL DEFAULT 0 CHECK (resume_replay_pending IN (0,1))
      );
      INSERT INTO scan_run (singleton, scan_id, node_id_seed, phase, checkpoint_sequence, active_elapsed_ms,
        journal_device, journal_uuid, journal_baseline, drained_through, checkpointed_at)
      SELECT singleton, scan_id, node_id_seed, CASE phase WHEN 'traversing' THEN 'scanning' ELSE phase END,
        checkpoint_sequence, active_elapsed_ms, journal_device, journal_uuid, journal_baseline, drained_through, checkpointed_at FROM scan_run_legacy;
      DROP TABLE scan_run_legacy;
    `)
    const nodeColumns = new Set((database.prepare('PRAGMA table_info(nodes)').all() as unknown as Array<{ name: string }>).map((column) => column.name))
    if (!nodeColumns.has('seen_epoch')) database.exec('ALTER TABLE nodes ADD COLUMN seen_epoch INTEGER NOT NULL DEFAULT 0')
    const hardlinkPathColumns = new Set((database.prepare('PRAGMA table_info(hardlink_paths)').all() as unknown as Array<{ name: string }>).map((column) => column.name))
    if (!hardlinkPathColumns.has('seen_epoch')) database.exec('ALTER TABLE hardlink_paths ADD COLUMN seen_epoch INTEGER NOT NULL DEFAULT 0')
    const runColumns = new Set((database.prepare('PRAGMA table_info(scan_run)').all() as unknown as Array<{ name: string }>).map((column) => column.name))
    if (!runColumns.has('resume_replay_pending')) database.exec("ALTER TABLE scan_run ADD COLUMN resume_replay_pending INTEGER NOT NULL DEFAULT 0 CHECK (resume_replay_pending IN (0,1))")
    const taskColumns = new Set((database.prepare('PRAGMA table_info(directory_tasks)').all() as unknown as Array<{ name: string }>).map((column) => column.name))
    if (!taskColumns.has('enumeration_epoch')) database.exec('ALTER TABLE directory_tasks ADD COLUMN enumeration_epoch INTEGER NOT NULL DEFAULT 1')
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
    ALTER TABLE nodes DROP COLUMN seen_epoch;
    ALTER TABLE hardlink_paths DROP COLUMN seen_epoch;
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
