import { lstatSync } from 'node:fs'
import { DatabaseSync } from "node:sqlite"
import { isAbsolute, normalize, relative, sep } from "node:path"
import type { Breadcrumb, NodeSummary } from "../shared/contracts"
import { readMetadata, type DatabaseNode } from "./database"
import { PERSISTENT_INDEX_SCHEMA_VERSION } from "./index-manifest"

export interface ChartDataSource {
  getNode(id: string): DatabaseNode | undefined
  getChildren(id: string, limit: number): readonly DatabaseNode[]
  countChildren(id: string): number
  getEstimatedRemainder?(id: string): number
}

export class DiskIndex implements ChartDataSource {
  readonly path: string
  readonly metadata: Record<string, string>
  readonly rootId: string
  readonly target: string
  private readonly database: DatabaseSync
  #closed = false

  constructor(path: string) {
    this.path = path
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('Invalid Orbis index file')
    const database = new DatabaseSync(path, { readOnly: true })
    this.database = database
    try {
      database.exec("PRAGMA query_only=ON; PRAGMA busy_timeout=1000;")
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

  getNodeByPath(path: string): DatabaseNode | undefined {
    const row = this.database.prepare(`
      SELECT id, parent_id AS parentId, name, path, kind, size_bytes AS sizeBytes,
        size_bytes AS confirmedBytes, 0 AS estimatedBytes,
        direct_children AS directChildren, descendant_count AS descendantCount,
        unreadable_count AS unreadableCount, own_unreadable AS ownUnreadable, scan_state AS scanState
      FROM nodes WHERE path = ?
    `).get(path) as unknown as Record<string, unknown> | undefined
    return row ? databaseNode(row) : undefined
  }

  getNode(id: string): DatabaseNode | undefined {
    const row = this.database.prepare(`
      SELECT id, parent_id AS parentId, name, path, kind, size_bytes AS sizeBytes,
        size_bytes AS confirmedBytes, 0 AS estimatedBytes,
        direct_children AS directChildren, descendant_count AS descendantCount,
        unreadable_count AS unreadableCount, own_unreadable AS ownUnreadable, scan_state AS scanState
      FROM nodes WHERE id = ?
    `).get(id) as unknown as Record<string, unknown> | undefined
    return row ? databaseNode(row) : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    const safeLimit = Math.max(0, Math.min(400, Math.floor(limit)))
    if (safeLimit === 0) return []
    const rows = this.database.prepare(`
      SELECT id, parent_id AS parentId, name, path, kind, size_bytes AS sizeBytes,
        size_bytes AS confirmedBytes, 0 AS estimatedBytes,
        direct_children AS directChildren, descendant_count AS descendantCount,
        unreadable_count AS unreadableCount, own_unreadable AS ownUnreadable, scan_state AS scanState
      FROM nodes WHERE parent_id = ?
      ORDER BY size_bytes DESC, name COLLATE NOCASE ASC, id ASC LIMIT ?
    `).all(id, safeLimit) as unknown as Array<Record<string, unknown>>
    return rows.map(databaseNode)
  }

  countChildren(id: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?").get(id) as unknown as { count?: number }
    return Number(row?.count ?? 0)
  }

  getEstimatedRemainder(_id: string): number { return 0 }

  getLargestItems(id: string): readonly NodeSummary[] {
    return this.getChildren(id, 100).map(toSummary)
  }

  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    const result: Breadcrumb[] = []
    const seen = new Set<string>()
    let current = this.getNode(id)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      result.unshift({ id: current.id, name: current.name })
      if (current.parentId === null) break
      current = this.getNode(current.parentId)
    }
    return result
  }

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

function databaseNode(row: Record<string, unknown>): DatabaseNode {
  return {
    id: String(row.id),
    parentId: row.parentId === null ? null : String(row.parentId),
    name: String(row.name),
    path: String(row.path),
    kind: row.kind === "directory" ? "directory" : "file",
    sizeBytes: numberValue(row.sizeBytes),
    confirmedBytes: numberValue(row.confirmedBytes ?? row.sizeBytes),
    estimatedBytes: numberValue(row.estimatedBytes),
    directChildren: numberValue(row.directChildren),
    descendantCount: numberValue(row.descendantCount),
    unreadableCount: numberValue(row.unreadableCount),
    scanState: row.scanState === "queued" || row.scanState === "scanning" || row.scanState === "unreadable" ? row.scanState : "complete",
    sizeAccuracy: row.scanState === "unreadable" || numberValue(row.unreadableCount) > 0 ? "partial" : "exact"
  }
}

function validatePersistentSchema(database: DatabaseSync, version: string): void {
  if (version !== String(PERSISTENT_INDEX_SCHEMA_VERSION)) throw new Error("Unsupported Orbis index schema")
  const required = new Set(["nodes", "metadata", "file_aliases", "hardlink_groups", "directory_observations"])
  const rows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>
  for (const row of rows) required.delete(row.name)
  if (required.size > 0) throw new Error("Invalid persistent Orbis index")
  const observationColumns = new Set((database.prepare("PRAGMA table_info(directory_observations)").all() as unknown as Array<{ name: string }>).map((row) => row.name))
  const nodeColumns = new Set((database.prepare("PRAGMA table_info(nodes)").all() as unknown as Array<{ name: string }>).map((row) => row.name))
  if (!observationColumns.has("direct_duplicate_count") || !nodeColumns.has("depth")) throw new Error("Invalid persistent Orbis index")
}

function numberValue(value: unknown): number { return typeof value === "number" ? value : Number(value) }
function isWithin(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`)
}

export type { DatabaseNode }
