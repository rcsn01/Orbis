import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from "vitest"
import {
  BulkExactMetadataSource,
  NodeDirectoryMetadataSource,
  loadNativeMetadataAddon,
  loadNativeOrbisAddon,
  readMetadataCursorDiagnostics,
  resetMetadataCursorDiagnostics,
  type NativeMetadataAddon,
  type NativeDirectoryCursor,
  type ScanStats
} from "../src/main/scan-metadata"
import type { ScanFileSystem } from "../src/main/legacy-scanner"

function stats(kind: "directory" | "file", blocks: number, inode: number): ScanStats {
  return {
    blocks,
    dev: 7,
    ino: inode,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false
  }
}

describe("Orbis scan metadata adapters", () => {
  it("maps native bulk pages and preserves native counters", async () => {
    const cursor: NativeDirectoryCursor = {
      readPage: vi.fn(async () => ({
        entries: [
          { name: "folder", kind: "directory", device: "7", inode: "2", allocatedBytes: 512, mountPoint: false, errorCode: null },
          { name: "unreadable", kind: "other", device: "", inode: "", allocatedBytes: 0, mountPoint: false, errorCode: 13 }
        ],
        done: true,
        bulkEntries: 2,
        fallbackEntries: 0
      })),
      close: vi.fn()
    }
    const addon: NativeMetadataAddon = { openDirectory: vi.fn(() => cursor) }
    const fileSystem = minimalFileSystem()
    resetMetadataCursorDiagnostics()
    const source = new BulkExactMetadataSource(addon, fileSystem)
    const page = await (await source.open("/target", "/target")).readPage(32, new AbortController().signal)

    expect(page.bulkEntries).toBe(2)
    expect(page.fallbackEntries).toBe(0)
    expect(page.entries[0]).toMatchObject({ name: "folder", kind: "directory", allocatedBytes: 512 })
    expect(page.entries[1]?.error).toBeInstanceOf(Error)
    expect((page.entries[1]?.error as Error & { code?: string }).code).toBe("EACCES")
    expect(readMetadataCursorDiagnostics()).toMatchObject({ nativeReadPageCalls: 1, nodeReadPageCalls: 0 })
  })

  it('passes 256 and 512 entry requests to native cursors and caps larger requests', async () => {
    const requested: number[] = []
    const cursor: NativeDirectoryCursor = {
      readPage: async (limit) => { requested.push(limit); return { entries: [], done: false } },
      close: () => undefined
    }
    const source = new BulkExactMetadataSource({ openDirectory: () => cursor }, minimalFileSystem())
    const opened = await source.open('/target', '/target')
    const signal = new AbortController().signal
    await opened.readPage(256, signal)
    await opened.readPage(512, signal)
    await opened.readPage(2_048, signal)
    expect(requested).toEqual([256, 512, 1_024])
  })

  it('caps Node cursor pages at 1,024 entries', async () => {
    let reads = 0
    const fileSystem: ScanFileSystem & { opendir(path: string): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }> } = {
      ...minimalFileSystem(),
      opendir: async () => ({
        read: async () => reads++ < 1_100 ? { name: `file-${reads}` } : null,
        close: async () => undefined
      })
    }
    const source = new NodeDirectoryMetadataSource(fileSystem)
    const page = await (await source.open('/target', '/target')).readPage(2_048, new AbortController().signal)
    expect(page.entries).toHaveLength(1_024)
    expect(reads).toBe(1_024)
  })

  it('shares the Stage 5 ordered metadata admission limit across cursors', async () => {
    let active = 0
    let maximum = 0
    const fileSystem: ScanFileSystem & { opendir(path: string): Promise<{ read(): Promise<{ name: string } | null>; close(): Promise<void> }> } = {
      ...minimalFileSystem(),
      lstat: async (path) => {
        active += 1
        maximum = Math.max(maximum, active)
        try { await new Promise((resolve) => setTimeout(resolve, 5)); return stats('file', 1, path.charCodeAt(path.length - 1)) }
        finally { active -= 1 }
      },
      opendir: async (path) => {
        const names = [`${path.at(-1)}-a`, `${path.at(-1)}-b`, `${path.at(-1)}-c`, `${path.at(-1)}-d`]
        let offset = 0
        return { read: async () => offset < names.length ? { name: names[offset++]! } : null, close: async () => undefined }
      }
    }
    const source = new NodeDirectoryMetadataSource(fileSystem, 3)
    const [left, right] = await Promise.all([source.open('/target/a', '/target'), source.open('/target/b', '/target')])
    const signal = new AbortController().signal
    const [leftPage, rightPage] = await Promise.all([left.readPage(4, signal), right.readPage(4, signal)])
    expect(maximum).toBe(3)
    expect(leftPage.entries.map((entry) => entry.name)).toEqual(['a-a', 'a-b', 'a-c', 'a-d'])
    expect(rightPage.entries.map((entry) => entry.name)).toEqual(['b-a', 'b-b', 'b-c', 'b-d'])
  })

  it('maps bulk errno values to code names', async () => {
    const cursor: NativeDirectoryCursor = {
      readPage: vi.fn(async () => ({
        entries: [
          { name: "missing", kind: "other", device: "", inode: "", allocatedBytes: 0, mountPoint: false, errorCode: 2 },
          { name: "denied", kind: "other", device: "", inode: "", allocatedBytes: 0, mountPoint: false, errorCode: 13 },
          { name: "unknown", kind: "other", device: "", inode: "", allocatedBytes: 0, mountPoint: false, errorCode: 99 }
        ],
        done: true,
        bulkEntries: 3,
        fallbackEntries: 0
      })),
      close: vi.fn()
    }
    const source = new BulkExactMetadataSource({ openDirectory: () => cursor }, minimalFileSystem())
    const page = await (await source.open('/target', '/target')).readPage(32, new AbortController().signal)
    const codes = page.entries.map((entry) => (entry.error as Error & { code?: string }).code)
    expect(codes).toEqual(["ENOENT", "EACCES", "99"])
  })

  it('clamps bulk page concurrency to the supported range', () => {
    const addon: NativeMetadataAddon = { openDirectory: () => ({ readPage: async () => ({ entries: [], done: true }), close: () => undefined }) }
    expect(new BulkExactMetadataSource(addon, minimalFileSystem(), 0).pageConcurrency).toBe(1)
    expect(new BulkExactMetadataSource(addon, minimalFileSystem(), 8).pageConcurrency).toBe(8)
    expect(new BulkExactMetadataSource(addon, minimalFileSystem(), 128).pageConcurrency).toBe(64)
  })

  it('can disable bulk metadata without disabling the FSEvents addon API', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-native-loader-'))
    const addonPath = join(directory, 'addon.cjs')
    await writeFile(addonPath, `module.exports = {
      openDirectory() {}, captureVolumeCheckpoint() {}, readChanges() {}
    }\n`)
    const previous = process.env.ORBIS_DISABLE_BULK_METADATA
    process.env.ORBIS_DISABLE_BULK_METADATA = '1'
    try {
      expect(await loadNativeMetadataAddon(addonPath)).toBeUndefined()
      expect(await loadNativeOrbisAddon(addonPath)).toMatchObject({
        openDirectory: expect.any(Function), captureVolumeCheckpoint: expect.any(Function), readChanges: expect.any(Function)
      })
    } finally {
      if (previous === undefined) delete process.env.ORBIS_DISABLE_BULK_METADATA
      else process.env.ORBIS_DISABLE_BULK_METADATA = previous
      await rm(directory, { recursive: true, force: true })
    }
  })

})

function minimalFileSystem(): ScanFileSystem {
  return {
    lstat: async () => stats("directory", 1, 1),
    readdir: async () => [],
    statfs: async () => ({ blocks: 1, bfree: 1, bsize: 512 }),
    realpath: async (path) => path
  }
}
