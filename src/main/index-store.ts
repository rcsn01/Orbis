import { lstatSync } from 'node:fs'
import { DatabaseSync, type StatementSync } from "node:sqlite"
import { isAbsolute, normalize, relative, sep } from "node:path"
import type { Breadcrumb, DirectoryScanState, NodeSummary, SizeAccuracy } from "../shared/contracts"
import { readMetadata, type DatabaseNode } from "./database"
import { PERSISTENT_INDEX_SCHEMA_VERSION } from "./index-manifest"

export interface ChartDataSource {
  getNode(id: string): DatabaseNode | undefined
  getChildren(id: string, limit: number): readonly DatabaseNode[]
  countChildren(id: string): number
  getEstimatedRemainder?(id: string): number
}

/**
 * The committed node SELECT.  Emits the same aliases as
 * CONSTRUCTION_NODE_SELECT so one row mapping serves both schema families.
 */
export const COMMITTED_NODE_SELECT = `SELECT n.id, n.parent_id AS parentId, n.name, n.path, n.kind, n.size_bytes AS confirmedBytes, n.size_bytes AS display_size, 0 AS estimatedBytes, n.direct_children AS directChildren, n.descendant_count AS descendantCount, n.unreadable_count AS unreadableCount, n.own_unreadable AS ownUnreadable, n.scan_state AS scanState FROM nodes n`

/** The construction node SELECT: display size and estimate overlay while pending. */
export const CONSTRUCTION_NODE_SELECT = `SELECT n.id, n.parent_id AS parentId, n.name, n.path, n.kind,
  n.size_bytes AS confirmedBytes,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN MAX(n.size_bytes, COALESCE(e.estimated_bytes, 0)) ELSE n.size_bytes END AS display_size,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN COALESCE(e.estimated_bytes, 0) ELSE 0 END AS estimatedBytes,
  n.direct_children AS directChildren, n.descendant_count AS descendantCount,
  n.unreadable_count AS unreadableCount, n.own_unreadable AS ownUnreadable, n.scan_state AS scanState
  FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id`

const ESTIMATE_REMAINDER_SQL = `
  SELECT n.scan_state AS scanState, COALESCE(e.estimated_bytes, 0) AS estimatedBytes,
    COALESCE((SELECT SUM(
      CASE WHEN child.scan_state IN ('queued', 'scanning')
        THEN MAX(child.size_bytes, COALESCE(childEstimate.estimated_bytes, 0))
        ELSE child.size_bytes
      END
    ) FROM nodes child LEFT JOIN size_estimates childEstimate ON childEstimate.node_id = child.id WHERE child.parent_id = n.id), 0) AS childBytes
  FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id WHERE n.id = ?
`

/**
 * The shared node read-model: one row→DatabaseNode mapping and one set of
 * navigation queries for both the committed index and the construction
 * database.  Never closes the DatabaseSync it is given.
 */
export class NodeReadModel {
  readonly #variant: "committed" | "construction"
  readonly #getNodeStatement: StatementSync
  readonly #getNodeByPathStatement: StatementSync
  readonly #getChildrenStatement: StatementSync
  readonly #countChildrenStatement: StatementSync
  readonly #breadcrumbStatement: StatementSync
  readonly #estimateRemainderStatement: StatementSync | undefined

  constructor(database: DatabaseSync, variant: "committed" | "construction") {
    this.#variant = variant
    const select = variant === "committed" ? COMMITTED_NODE_SELECT : CONSTRUCTION_NODE_SELECT
    this.#getNodeStatement = database.prepare(`${select} WHERE n.id = ?`)
    this.#getNodeByPathStatement = database.prepare(`${select} WHERE n.path = ?`)
    this.#getChildrenStatement = database.prepare(`${select} WHERE n.parent_id = ? ORDER BY display_size DESC, n.name COLLATE NOCASE ASC, n.id ASC LIMIT ?`)
    this.#countChildrenStatement = database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?")
    this.#breadcrumbStatement = database.prepare("SELECT id, parent_id AS parentId, name FROM nodes WHERE id = ?")
    // The committed schema has no size_estimates table, so the remainder
    // statement is only prepared for the construction variant.
    this.#estimateRemainderStatement = variant === "construction" ? database.prepare(ESTIMATE_REMAINDER_SQL) : undefined
  }

  getNode(id: string): DatabaseNode | undefined {
    const row = this.#getNodeStatement.get(id) as unknown as Record<string, unknown> | undefined
    return row ? nodeFromRow(row) : undefined
  }

  getNodeByPath(path: string): DatabaseNode | undefined {
    const row = this.#getNodeByPathStatement.get(path) as unknown as Record<string, unknown> | undefined
    return row ? nodeFromRow(row) : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    const safeLimit = Math.max(0, Math.min(400, Math.floor(limit)))
    if (safeLimit === 0) return []
    const rows = this.#getChildrenStatement.all(id, safeLimit) as unknown as Array<Record<string, unknown>>
    return rows.map(nodeFromRow)
  }

  countChildren(id: string): number {
    const row = this.#countChildrenStatement.get(id) as unknown as { count?: number } | undefined
    return Number(row?.count ?? 0)
  }

  getLargestItems(id: string): readonly NodeSummary[] {
    return this.getChildren(id, 100).map(toSummary)
  }

  getEstimatedRemainder(id: string): number {
    if (this.#variant === "committed") return 0
    const row = this.#estimateRemainderStatement!.get(id) as unknown as { scanState?: string; estimatedBytes?: number; childBytes?: number } | undefined
    if (!row || (row.scanState !== "queued" && row.scanState !== "scanning")) return 0
    return Math.max(0, Number(row.estimatedBytes ?? 0) - Number(row.childBytes ?? 0))
  }

  /** All-or-nothing breadcrumbs: [] unless the parent chain terminates at null. */
  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    const result: Breadcrumb[] = []
    const seen = new Set<string>()
    let current = this.#breadcrumbStatement.get(id) as unknown as { id: string; parentId: string | null; name: string } | undefined
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      result.unshift({ id: current.id, name: current.name })
      if (current.parentId === null) return result
      current = this.#breadcrumbStatement.get(current.parentId) as unknown as { id: string; parentId: string | null; name: string } | undefined
    }
    return []
  }
}

export class DiskIndex implements ChartDataSource {
  readonly path: string
  readonly metadata: Record<string, string>
  readonly rootId: string
  readonly target: string
  private readonly database: DatabaseSync
  private readonly readModel: NodeReadModel
  private readonly locationNodeStatement: StatementSync
  #closed = false

  constructor(path: string) {
    this.path = path
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid Orbis index file')
    const database = new DatabaseSync(path, { readOnly: true })
    this.database = database
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;")
      this.readModel = new NodeReadModel(database, "committed")
      this.locationNodeStatement = database.prepare(`${COMMITTED_NODE_SELECT.replace(" FROM nodes n", ", n.device, n.inode FROM nodes n")} WHERE n.path = ? AND n.kind = 'directory' AND n.device = ? AND n.inode = ?`)
      this.metadata = readMetadata(database)
      this.rootId = this.metadata.rootId ?? ""
      this.target = this.metadata.target ?? "/"
      const root = this.rootId ? this.getNode(this.rootId) : undefined
      if (!this.rootId || !isAbsolute(this.target) || !root || root.kind !== "directory" || root.parentId !== null || normalize(root.path) !== normalize(this.target)) throw new Error("Invalid Orbis index")
      if (this.metadata.schemaVersion !== undefined) validatePersistentSchema(database, this.metadata.schemaVersion)
    } catch (error) {
      try { database.close() } catch { /* Preserve the validation error. */ }
      throw error
    }
  }

  get root(): DatabaseNode | undefined { return this.getNode(this.rootId) }

  openLocationView(target: string, expected: { readonly device: string; readonly inode: string }): LocationIndexView | undefined {
    if (!isAbsolute(target)) return undefined
    const logicalTarget = normalize(target)
    const row = this.locationNodeStatement.get(logicalTarget, expected.device, expected.inode) as unknown as Record<string, unknown> | undefined
    if (!row || normalize(String(row.path)) !== logicalTarget) return undefined
    return new LocationIndexView(logicalTarget, nodeFromRow(row), this.readModel)
  }

  getNodeByPath(path: string): DatabaseNode | undefined { return this.readModel.getNodeByPath(path) }

  getNode(id: string): DatabaseNode | undefined { return this.readModel.getNode(id) }

  getChildren(id: string, limit: number): readonly DatabaseNode[] { return this.readModel.getChildren(id, limit) }

  countChildren(id: string): number { return this.readModel.countChildren(id) }

  getEstimatedRemainder(id: string): number { return this.readModel.getEstimatedRemainder(id) }

  getLargestItems(id: string): readonly NodeSummary[] { return this.readModel.getLargestItems(id) }

  getBreadcrumbs(id: string): readonly Breadcrumb[] { return this.readModel.getBreadcrumbs(id) }

  resolvePath(id: string): string | undefined {
    const path = this.getNode(id)?.path
    return path && isWithin(path, this.target) ? path : undefined
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
  }
}

export class LocationIndexView implements ChartDataSource {
  readonly target: string
  readonly rootId: string
  readonly root: DatabaseNode
  readonly #readModel: NodeReadModel

  constructor(target: string, root: DatabaseNode, readModel: NodeReadModel) {
    this.target = target
    this.root = root
    this.rootId = root.id
    this.#readModel = readModel
  }

  #inside(node: DatabaseNode | undefined): node is DatabaseNode {
    return node !== undefined && isWithin(node.path, this.target)
  }

  getNode(id: string): DatabaseNode | undefined {
    const node = this.#readModel.getNode(id)
    return this.#inside(node) ? node : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    if (!this.getNode(id)) return []
    return this.#readModel.getChildren(id, limit).filter((node) => this.#inside(node))
  }

  countChildren(id: string): number {
    return this.getNode(id) ? this.#readModel.countChildren(id) : 0
  }

  getEstimatedRemainder(id: string): number {
    return this.getNode(id) ? this.#readModel.getEstimatedRemainder(id) : 0
  }

  getLargestItems(id: string): readonly NodeSummary[] {
    return this.getChildren(id, 100).map(toSummary)
  }

  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    if (!this.getNode(id)) return []
    const breadcrumbs = this.#readModel.getBreadcrumbs(id)
    const rootIndex = breadcrumbs.findIndex((item) => item.id === this.rootId)
    return rootIndex < 0 ? [] : breadcrumbs.slice(rootIndex)
  }

  resolvePath(id: string): string | undefined {
    return this.getNode(id)?.path
  }
}

export function toSummary(node: DatabaseNode): NodeSummary {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    kind: node.kind,
    sizeBytes: node.sizeBytes,
    ...(node.estimatedBytes > 0 ? { estimatedSizeBytes: node.estimatedBytes } : {}),
    directChildren: node.directChildren,
    descendantCount: node.descendantCount,
    unreadableCount: node.unreadableCount,
    scanState: node.scanState,
    sizeAccuracy: node.sizeAccuracy
  }
}

export function nodeFromRow(row: Record<string, unknown>): DatabaseNode {
  const scanState: DirectoryScanState = row.scanState === "queued" || row.scanState === "scanning" || row.scanState === "unreadable" ? row.scanState : "complete"
  const pending = scanState === "queued" || scanState === "scanning"
  const confirmedBytes = safeBytes(row.confirmedBytes)
  const estimatedBytes = pending ? safeBytes(row.estimatedBytes) : 0
  const unreadableCount = nonnegativeInteger(row.unreadableCount)
  const sizeAccuracy: SizeAccuracy = scanState === "complete" && unreadableCount === 0 && row.ownUnreadable !== 1
    ? "exact"
    : pending
      ? estimatedBytes > 0 ? "estimated" : "partial"
      : "partial"
  return {
    id: String(row.id),
    parentId: row.parentId === null ? null : String(row.parentId),
    name: String(row.name),
    path: String(row.path),
    kind: row.kind === "directory" ? "directory" : "file",
    sizeBytes: safeBytes(row.display_size),
    confirmedBytes,
    estimatedBytes,
    directChildren: nonnegativeInteger(row.directChildren),
    descendantCount: nonnegativeInteger(row.descendantCount),
    unreadableCount,
    scanState,
    sizeAccuracy
  }
}

function validatePersistentSchema(database: DatabaseSync, version: string): void {
  if (version !== String(PERSISTENT_INDEX_SCHEMA_VERSION)) throw new Error("Unsupported Orbis index schema")
  const required = new Set(["nodes", "metadata", "hardlink_paths", "hardlink_groups", "directory_observations"])
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>
  for (const row of rows) required.delete(row.name)
  if (required.size > 0) throw new Error("Invalid persistent Orbis index")
  const observationColumns = new Set((database.prepare("PRAGMA table_info(directory_observations)").all() as unknown as Array<{ name: string }>).map((row) => row.name))
  const nodeColumns = new Set((database.prepare("PRAGMA table_info(nodes)").all() as unknown as Array<{ name: string }>).map((row) => row.name))
  if (!observationColumns.has("direct_duplicate_count") || !nodeColumns.has("depth")) throw new Error("Invalid persistent Orbis index")
}

function safeBytes(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function nonnegativeInteger(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function isWithin(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`)
}

export type { DatabaseNode }
