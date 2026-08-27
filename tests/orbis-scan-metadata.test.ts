import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from "vitest"
import {
  BulkExactMetadataSource,
  decodeNativePage,
  NodeDirectoryMetadataSource,
  loadNativeMetadataAddon,
  loadNativeOrbisAddon,
  type NativeMetadataAddon,
  type NativeDirectoryCursor,
  type NativeMetadataPage,
  type NativeMetadataTree,
  type ScanStats
} from "../src/main/scan-metadata"
import type { ScanFileSystem } from "../src/main/legacy-scanner"
import { emptyScanCounters, runWithScanDiagnostics, subscribeScanCounters } from '../src/main/diagnostics'

interface PackedEntry { name: string; kind: 0 | 1 | 2 | 3; device?: bigint; inode?: bigint; allocatedBytes?: bigint; linkCount?: bigint; mountPoint?: boolean; errno?: number }
function packed(entries: readonly PackedEntry[], done = true): NativeMetadataPage {
  const names = entries.map((entry) => Buffer.from(entry.name))
  const namesLength = names.reduce((sum, name) => sum + name.length, 0)
  const payload = Buffer.alloc(16 + entries.length * 48 + namesLength)
  payload.write('ORB1', 0, 'ascii'); payload.writeUInt16LE(1, 4); payload.writeUInt16LE(48, 6)
  payload.writeUInt32LE(entries.length, 8); payload.writeUInt32LE(namesLength, 12)
  let nameOffset = 0
  entries.forEach((entry, index) => {
    const offset = 16 + index * 48; const name = names[index]!
    payload.writeUInt32LE(nameOffset, offset); payload.writeUInt32LE(name.length, offset + 4); payload[offset + 8] = entry.kind
    payload[offset + 9] = (entry.mountPoint ? 1 : 0) | (entry.device === undefined ? 0 : 2) | (entry.inode === undefined ? 0 : 4) | (entry.linkCount === undefined ? 0 : 8) | (entry.errno === undefined ? 0 : 16)
    payload.writeInt32LE(entry.errno ?? 0, offset + 12); payload.writeBigUInt64LE(entry.device ?? 0n, offset + 16)
    payload.writeBigUInt64LE(entry.inode ?? 0n, offset + 24); payload.writeBigUInt64LE(entry.allocatedBytes ?? 0n, offset + 32); payload.writeBigUInt64LE(entry.linkCount ?? 0n, offset + 40)
    name.copy(payload, 16 + entries.length * 48 + nameOffset); nameOffset += name.length
  })
  return { payload, count: entries.length, done, bulkEntries: entries.length, fallbackEntries: 0 }
}
function tree(cursor: NativeDirectoryCursor): NativeMetadataTree { return { openDirectory: () => cursor, close: () => undefined } }

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
      readPage: vi.fn(async () => packed([
        { name: 'folder', kind: 2, device: 7n, inode: 2n, allocatedBytes: 512n },
        { name: 'unreadable', kind: 0, errno: 13 }
      ])),
      close: vi.fn()
    }
    const addon: NativeMetadataAddon = { openMetadataTree: vi.fn(() => tree(cursor)) }
    const counters = emptyScanCounters()
    const unsubscribe = subscribeScanCounters((event) => { counters[event.counter] += event.value })
    const source = new BulkExactMetadataSource(addon.openMetadataTree('/target'), '/target')
    const page = await runWithScanDiagnostics(1, async () => (await source.open("/target", "/target")).readPage(32, new AbortController().signal))
    unsubscribe()

    expect(page.bulkEntries).toBe(2)
    expect(page.fallbackEntries).toBe(0)
    expect(page.entries[0]).toMatchObject({ name: "folder", kind: "directory", allocatedBytes: 512 })
    expect(page.entries[1]?.error).toBeInstanceOf(Error)
    expect((page.entries[1]?.error as Error & { code?: string }).code).toBe("EACCES")
    expect(counters).toMatchObject({ nativePageReads: 1, nodePageReads: 0, metadataEntries: 2 })
  })

  it('rejects malformed packed pages', () => {
    const page = packed([{ name: 'file', kind: 1, device: 1n, inode: 2n }])
    expect(() => decodeNativePage({ ...page, payload: page.payload.subarray(0, -1) })).toThrow('bounds')
    const unsupported = Buffer.from(page.payload); unsupported.writeUInt16LE(2, 4)
    expect(() => decodeNativePage({ ...page, payload: unsupported })).toThrow('header')
  })

  it('passes 256 and 512 entry requests to native cursors and caps larger requests', async () => {
    const requested: number[] = []
    const cursor: NativeDirectoryCursor = {
      readPage: async (limit) => { requested.push(limit); return packed([], false) },
      close: () => undefined
    }
    const source = new BulkExactMetadataSource(tree(cursor), '/target')
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
      readPage: vi.fn(async () => packed([
        { name: 'missing', kind: 0, errno: 2 }, { name: 'denied', kind: 0, errno: 13 }, { name: 'unknown', kind: 0, errno: 99 }
      ])),
      close: vi.fn()
    }
    const source = new BulkExactMetadataSource(tree(cursor), '/target')
    const page = await (await source.open('/target', '/target')).readPage(32, new AbortController().signal)
    const codes = page.entries.map((entry) => (entry.error as Error & { code?: string }).code)
    expect(codes).toEqual(["ENOENT", "EACCES", "99"])
  })

  it('clamps bulk page concurrency to the supported range', () => {
    const nativeTree = tree({ readPage: async () => packed([]), close: () => undefined })
    expect(new BulkExactMetadataSource(nativeTree, '/target', 0).pageConcurrency).toBe(1)
    expect(new BulkExactMetadataSource(nativeTree, '/target', 8).pageConcurrency).toBe(8)
    expect(new BulkExactMetadataSource(nativeTree, '/target', 128).pageConcurrency).toBe(64)
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
