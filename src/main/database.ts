import { DatabaseSync, type StatementSync } from "node:sqlite"
import { mkdir, rm } from "node:fs/promises"
import { dirname } from "node:path"
import type { DirectoryScanState, NodeKind, SizeAccuracy } from "../shared/contracts"
import { measureScan } from "./diagnostics"

export interface DatabaseNode {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly path: string
  readonly kind: NodeKind
  readonly sizeBytes: number
  readonly confirmedBytes: number
  readonly estimatedBytes: number
  readonly sizeAccuracy: SizeAccuracy
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
  readonly scanState: DirectoryScanState
}

export interface DirectoryAggregate {
  readonly sizeBytes: number
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
}

export interface InsertNode {
  readonly id: string
  readonly parentId: string | null
  readonly name: string
  readonly path: string
  readonly kind: NodeKind
  readonly ownBytes: number
  readonly device: string
  readonly inode: string
  readonly ownUnreadable?: number
}

export interface ScanDatabaseMeta {
  readonly target: string
  readonly rootId: string
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  readonly targetDevice?: string
  readonly targetInode?: string
  readonly indexDirectoryIdentity?: string
  readonly indexRevision?: number
  readonly capturedAt?: string
  readonly refreshedAt?: string
  readonly resume?: { readonly drainedThrough: string; readonly dirtyScopes: readonly string[] }
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

type DatabaseState = "building" | "committed" | "rolled-back" | "closed"

export class ScanDatabase {
  readonly #database: DatabaseSync
  readonly #insertNode: StatementSync
  readonly #markUnreadable: StatementSync
  readonly #updateDirectory: StatementSync
  readonly #insertMetadata: StatementSync
  #state: DatabaseState = "building"

  constructor(path: string) {
    const database = new DatabaseSync(path)
    this.#database = database
    try {
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
          inode TEXT NOT NULL,
          scan_state TEXT NOT NULL DEFAULT 'complete' CHECK (scan_state IN ('queued', 'scanning', 'complete', 'unreadable')),
          enumeration_complete INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      `)
      this.#insertNode = database.prepare(`
        INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, own_unreadable, device, inode)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      this.#markUnreadable = database.prepare("UPDATE nodes SET own_unreadable = 1, unreadable_count = 1 WHERE id = ?")
      this.#updateDirectory = database.prepare(`
        UPDATE nodes SET size_bytes = ?, direct_children = ?, descendant_count = ?, unreadable_count = ? WHERE id = ?
      `)
      this.#insertMetadata = database.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)")
      database.exec("BEGIN")
    } catch (error) {
      try { database.close() } catch { /* Preserve the construction error. */ }
      throw error
    }
  }

  insertNode(node: InsertNode): void {
    this.#assertBuilding()
    this.#insertNode.run(node.id, node.parentId, node.name, node.path, node.kind, node.ownBytes, node.ownBytes, node.ownUnreadable ?? 0, node.device, node.inode)
  }

  markUnreadable(id: string): void {
    this.#assertBuilding()
    this.#markUnreadable.run(id)
  }

  updateDirectory(id: string, aggregate: DirectoryAggregate): void {
    this.#assertBuilding()
    this.#updateDirectory.run(aggregate.sizeBytes, aggregate.directChildren, aggregate.descendantCount, aggregate.unreadableCount, id)
  }

  finalize(): void {
    this.#assertBuilding()
    measureScan("index-create", () => this.#database.exec("CREATE INDEX nodes_parent_size ON nodes (parent_id, size_bytes DESC, name COLLATE NOCASE ASC, id ASC);"))
  }

  writeMetadata(meta: ScanDatabaseMeta): void {
    this.#assertBuilding()
    this.#insertMetadata.run("target", meta.target)
    this.#insertMetadata.run("rootId", meta.rootId)
    this.#insertMetadata.run("volume", JSON.stringify({ capacityBytes: meta.capacityBytes, freeBytes: meta.freeBytes }))
    this.#insertMetadata.run("totals", JSON.stringify(meta.totals))
    this.#insertMetadata.run("scannedBytes", String(meta.scannedBytes))
  }

  complete(): void {
    this.#assertBuilding()
    measureScan("database-commit", () => this.#database.exec("COMMIT"))
    this.#state = "committed"
    try { measureScan("database-optimize", () => this.#database.exec("PRAGMA optimize")) }
    finally { this.#close() }
  }

  abort(): void {
    if (this.#state === "closed" || this.#state === "rolled-back") return
    if (this.#state === "building") {
      try { this.#database.exec("ROLLBACK") } catch { /* Best effort while preserving the scan error. */ }
      this.#state = "rolled-back"
    }
    try { this.#close() } catch { /* Best effort while preserving the scan error. */ }
  }

  #assertBuilding(): void {
    if (this.#state !== "building") throw new Error(`Scan database is ${this.#state}`)
  }

  #close(): void {
    if (this.#state === "closed") return
    try { measureScan("database-close", () => this.#database.close()) }
    finally { this.#state = "closed" }
  }
}

export function createScanDatabase(path: string): ScanDatabase { return new ScanDatabase(path) }

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

export type { DatabaseSync, StatementSync }
