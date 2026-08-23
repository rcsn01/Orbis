import { DatabaseSync, type StatementSync } from "node:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import type { NodeKind } from "@shared/contracts"

export interface DatabaseNode {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly path: string
  readonly kind: NodeKind
  readonly sizeBytes: number
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
}

export interface MutableDatabaseNode {
  id: string
  parentId: string | null
  name: string
  path: string
  kind: NodeKind
  ownBytes: number
  sizeBytes: number
  ownUnreadable: number
  directChildren: number
  descendantCount: number
  unreadableCount: number
}

export interface ScanDatabaseMeta {
  readonly target: string
  readonly rootId: string
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  readonly totals: {
    readonly scannedItems: number
    readonly discoveredBytes: number
    readonly elapsedMs: number
    readonly skippedItems: number
    readonly unreadableItems: number
    readonly nestedMounts: number
    readonly symlinks: number
    readonly duplicateHardLinks: number
    readonly disappearingItems: number
  }
}

export function createScanDatabase(path: string): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;")
  database.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES nodes(id),
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
      inode TEXT NOT NULL
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  return database
}

export function insertNode(database: DatabaseSync, node: {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly path: string
  readonly kind: NodeKind
  readonly ownBytes: number
  readonly device: string
  readonly inode: string
  readonly ownUnreadable?: number
}): void {
  const statement = database.prepare(`
    INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, own_unreadable, device, inode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  statement.run(node.id, node.parentId, node.name, node.path, node.kind, node.ownBytes, node.ownBytes, node.ownUnreadable ?? 0, node.device, node.inode)
}

export function finalizeDatabase(database: DatabaseSync, rootId: string): Map<string, MutableDatabaseNode> {
  const rows = database.prepare(`
    SELECT id, parent_id AS parentId, name, path, kind, own_bytes AS ownBytes,
      size_bytes AS sizeBytes, own_unreadable AS ownUnreadable,
      direct_children AS directChildren, descendant_count AS descendantCount,
      unreadable_count AS unreadableCount
    FROM nodes
  `).all() as unknown as Array<Record<string, unknown>>
  const nodes = new Map<string, MutableDatabaseNode>()
  const children = new Map<string, MutableDatabaseNode[]>()
  for (const row of rows) {
    const node: MutableDatabaseNode = {
      id: String(row.id),
      parentId: row.parentId === null ? null : String(row.parentId),
      name: String(row.name),
      path: String(row.path),
      kind: row.kind === "directory" ? "directory" : "file",
      ownBytes: numberValue(row.ownBytes),
      sizeBytes: numberValue(row.sizeBytes),
      ownUnreadable: numberValue(row.ownUnreadable),
      directChildren: numberValue(row.directChildren),
      descendantCount: numberValue(row.descendantCount),
      unreadableCount: numberValue(row.unreadableCount)
    }
    nodes.set(node.id, node)
    if (node.parentId !== null) {
      const siblings = children.get(node.parentId) ?? []
      siblings.push(node)
      children.set(node.parentId, siblings)
    }
  }

  const update = database.prepare(`
    UPDATE nodes SET size_bytes = ?, direct_children = ?, descendant_count = ?, unreadable_count = ? WHERE id = ?
  `)
  const visiting = new Set<string>()
  const visit = (node: MutableDatabaseNode): void => {
    if (node.kind !== "directory" || visiting.has(node.id)) return
    visiting.add(node.id)
    let sizeBytes = node.ownBytes
    let descendantCount = 0
    let unreadableCount = node.ownUnreadable
    const direct = children.get(node.id) ?? []
    for (const child of direct) {
      visit(child)
      sizeBytes += child.sizeBytes
      descendantCount += 1 + child.descendantCount
      unreadableCount += child.unreadableCount
    }
    node.sizeBytes = sizeBytes
    node.directChildren = direct.length
    node.descendantCount = descendantCount
    node.unreadableCount = unreadableCount
    update.run(sizeBytes, direct.length, descendantCount, unreadableCount, node.id)
    visiting.delete(node.id)
  }
  const root = nodes.get(rootId)
  if (root) visit(root)
  database.exec("CREATE INDEX nodes_parent_size ON nodes (parent_id, size_bytes DESC, name COLLATE NOCASE ASC);")
  return nodes
}

export function writeMetadata(database: DatabaseSync, meta: ScanDatabaseMeta): void {
  const statement = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
  statement.run("target", meta.target)
  statement.run("rootId", meta.rootId)
  statement.run("volume", JSON.stringify({ capacityBytes: meta.capacityBytes, freeBytes: meta.freeBytes }))
  statement.run("totals", JSON.stringify(meta.totals))
  statement.run("scannedBytes", String(meta.scannedBytes))
}

export function readMetadata(database: DatabaseSync): Record<string, string> {
  const values = database.prepare("SELECT key, value FROM metadata").all() as unknown as Array<{ key: string; value: string }>
  return Object.fromEntries(values.map((value) => [value.key, value.value]))
}

export async function prepareDatabaseDirectory(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
}

export async function removeDatabaseFiles(path: string): Promise<void> {
  await Promise.all([
    rm(path, { force: true }),
    rm(`${path}-journal`, { force: true }),
    rm(`${path}-wal`, { force: true }),
    rm(`${path}-shm`, { force: true })
  ])
}

function numberValue(value: unknown): number { return typeof value === "number" ? value : Number(value) }

export type { DatabaseSync, StatementSync }
