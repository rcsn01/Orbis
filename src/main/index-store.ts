import { DatabaseSync } from "node:sqlite"
import type { Breadcrumb, NodeSummary } from "@shared/contracts"
import { readMetadata, type DatabaseNode } from "./database"

export interface ChartDataSource {
  getNode(id: string): DatabaseNode | undefined
  getChildren(id: string, limit: number): readonly DatabaseNode[]
  countChildren(id: string): number
}

export class DiskIndex implements ChartDataSource {
  readonly path: string
  readonly metadata: Record<string, string>
  readonly rootId: string
  readonly target: string
  private readonly database: DatabaseSync

  constructor(path: string) {
    this.path = path
    this.database = new DatabaseSync(path, { readOnly: true })
    this.metadata = readMetadata(this.database)
    this.rootId = this.metadata.rootId ?? ""
    this.target = this.metadata.target ?? "/"
  }

  get root(): DatabaseNode | undefined { return this.getNode(this.rootId) }

  getNode(id: string): DatabaseNode | undefined {
    const row = this.database.prepare(`
      SELECT id, parent_id AS parentId, name, path, kind, size_bytes AS sizeBytes,
        direct_children AS directChildren, descendant_count AS descendantCount,
        unreadable_count AS unreadableCount
      FROM nodes WHERE id = ?
    `).get(id) as unknown as Record<string, unknown> | undefined
    return row ? databaseNode(row) : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    const safeLimit = Math.max(0, Math.min(100, Math.floor(limit)))
    if (safeLimit === 0) return []
    const rows = this.database.prepare(`
      SELECT id, parent_id AS parentId, name, path, kind, size_bytes AS sizeBytes,
        direct_children AS directChildren, descendant_count AS descendantCount,
        unreadable_count AS unreadableCount
      FROM nodes WHERE parent_id = ?
      ORDER BY size_bytes DESC, name COLLATE NOCASE ASC, id ASC LIMIT ?
    `).all(id, safeLimit) as unknown as Array<Record<string, unknown>>
    return rows.map(databaseNode)
  }

  countChildren(id: string): number {
    const row = this.database.prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?").get(id) as unknown as { count?: number }
    return Number(row?.count ?? 0)
  }

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

  resolvePath(id: string): string | undefined { return this.getNode(id)?.path }

  close(): void { this.database.close() }
}

export function toSummary(node: DatabaseNode): NodeSummary {
  return {
    id: node.id,
    parentId: node.parentId,
    name: node.name,
    kind: node.kind,
    sizeBytes: node.sizeBytes,
    directChildren: node.directChildren,
    descendantCount: node.descendantCount,
    unreadableCount: node.unreadableCount
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
    directChildren: numberValue(row.directChildren),
    descendantCount: numberValue(row.descendantCount),
    unreadableCount: numberValue(row.unreadableCount)
  }
}

function numberValue(value: unknown): number { return typeof value === "number" ? value : Number(value) }

export type { DatabaseNode }
