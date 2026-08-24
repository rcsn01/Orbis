import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import { createScanDatabase } from "../src/main/database"
import { DiskIndex } from "../src/main/index-store"

const totals = { scannedItems: 3, discoveredBytes: 350, elapsedMs: 12, skippedItems: 1, unreadableItems: 1, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }

describe("ScanDatabase", () => {
  it("commits one complete readable index", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-database-commit-"))
    const path = join(directory, "scan.sqlite")
    try {
      const database = createScanDatabase(path)
      database.insertNode({ id: "n-1", parentId: null, name: "root", path: "/root", kind: "directory", ownBytes: 100, device: "1", inode: "1" })
      database.insertNode({ id: "n-2", parentId: "n-1", name: "folder", path: "/root/folder", kind: "directory", ownBytes: 50, device: "1", inode: "2" })
      database.insertNode({ id: "n-3", parentId: "n-1", name: "file", path: "/root/file", kind: "file", ownBytes: 200, device: "1", inode: "3" })
      database.markUnreadable("n-2")
      const nodes = database.finalize("n-1")
      expect(nodes.get("n-1")).toMatchObject({ sizeBytes: 350, directChildren: 2, descendantCount: 2, unreadableCount: 1 })
      database.writeMetadata({ target: "/root", rootId: "n-1", capacityBytes: 1_000, freeBytes: 500, scannedBytes: 350, totals })
      database.complete()

      const index = new DiskIndex(path)
      expect(index.root).toMatchObject({ name: "root", sizeBytes: 350, directChildren: 2, descendantCount: 2, unreadableCount: 1 })
      expect(index.metadata.scannedBytes).toBe("350")
      index.close()
      await expectDatabaseSidecarsAbsent(path)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("rolls back every scan-data write when aborted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-database-abort-"))
    const path = join(directory, "scan.sqlite")
    try {
      const database = createScanDatabase(path)
      database.insertNode({ id: "n-1", parentId: null, name: "root", path: "/root", kind: "directory", ownBytes: 100, device: "1", inode: "1" })
      database.finalize("n-1")
      database.writeMetadata({ target: "/root", rootId: "n-1", capacityBytes: 1_000, freeBytes: 500, scannedBytes: 100, totals: { ...totals, scannedItems: 1, discoveredBytes: 100 } })
      database.abort()
      database.abort()

      const raw = new DatabaseSync(path, { readOnly: true })
      expect(raw.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toMatchObject({ count: 0 })
      expect(raw.prepare("SELECT COUNT(*) AS count FROM metadata").get()).toMatchObject({ count: 0 })
      expect(raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'nodes_parent_size'").get()).toMatchObject({ count: 0 })
      raw.close()
      await expectDatabaseSidecarsAbsent(path)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("rolls back inserts and aggregate updates after finalization fails", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-database-finalize-failure-"))
    const path = join(directory, "scan.sqlite")
    try {
      const database = createScanDatabase(path)
      database.insertNode({ id: "n-1", parentId: null, name: "root", path: "/root", kind: "directory", ownBytes: 100, device: "1", inode: "1" })
      database.finalize("n-1")
      expect(() => database.finalize("n-1")).toThrow()
      database.abort()

      const raw = new DatabaseSync(path, { readOnly: true })
      expect(raw.prepare("SELECT COUNT(*) AS count FROM nodes").get()).toMatchObject({ count: 0 })
      expect(raw.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'index' AND name = 'nodes_parent_size'").get()).toMatchObject({ count: 0 })
      raw.close()
      await expectDatabaseSidecarsAbsent(path)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it("rejects writes and repeated completion after the writer closes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orbis-database-lifecycle-"))
    const path = join(directory, "scan.sqlite")
    try {
      const database = createScanDatabase(path)
      database.insertNode({ id: "n-1", parentId: null, name: "root", path: "/root", kind: "directory", ownBytes: 100, device: "1", inode: "1" })
      database.finalize("n-1")
      database.writeMetadata({ target: "/root", rootId: "n-1", capacityBytes: 1_000, freeBytes: 500, scannedBytes: 100, totals: { ...totals, scannedItems: 1, discoveredBytes: 100 } })
      database.complete()
      expect(() => database.insertNode({ id: "n-2", parentId: "n-1", name: "late", path: "/root/late", kind: "file", ownBytes: 1, device: "1", inode: "2" })).toThrow("Scan database is closed")
      expect(() => database.complete()).toThrow("Scan database is closed")
      expect(() => database.abort()).not.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

async function expectDatabaseSidecarsAbsent(path: string): Promise<void> {
  for (const suffix of ["-journal", "-wal", "-shm"]) await expect(access(`${path}${suffix}`)).rejects.toThrow()
}
