import { createRequire } from "node:module"
import { isAbsolute, normalize, relative, resolve, sep } from "node:path"
import type { ScanFileSystem, ScanStats } from "./legacy-scanner"
import { createOrderedConcurrentMapper, type OrderedConcurrentMapper } from "./ordered-concurrent-map"
import { recordScanCounter } from './diagnostics'

export interface FolderEstimateItem {
  readonly name: string
  readonly estimatedBytes: number
}

export interface FolderSizeEstimate {
  readonly items: readonly FolderEstimateItem[]
}

export type DirectoryMetadataKind = "directory" | "file" | "symlink" | "other"

export interface DirectoryMetadataEntry {
  readonly name: string
  readonly kind: DirectoryMetadataKind
  readonly device: string
  readonly inode: string
  readonly allocatedBytes: number
  /** Exact filesystem link count when supplied by the metadata backend. */
  readonly linkCount?: number
  readonly mountPoint: boolean
  readonly error?: unknown
}

export interface DirectoryMetadataPage {
  readonly entries: readonly DirectoryMetadataEntry[]
  readonly done: boolean
  readonly bulkEntries: number
  readonly fallbackEntries: number
}

export interface DirectoryMetadataCursor {
  readPage(limit: number, signal: AbortSignal): Promise<DirectoryMetadataPage>
  close(): Promise<void>
}

export interface DirectoryMetadataSource {
  /** Number of directory pages this source can read concurrently. */
  readonly pageConcurrency?: number
  open(path: string, targetRealpath: string): Promise<DirectoryMetadataCursor>
  close?(): Promise<void>
}

export interface NativeMetadataPage {
  readonly payload: Buffer
  readonly count: number
  readonly done: boolean
  readonly bulkEntries?: number
  readonly fallbackEntries?: number
}

export interface NativeDirectoryCursor {
  readPage(limit: number): Promise<NativeMetadataPage>
  close(): void
}

export interface NativeMetadataTree {
  openDirectory(relativePath: string): NativeDirectoryCursor
  close(): void
}

export interface NativeMetadataAddon {
  openMetadataTree(target: string): NativeMetadataTree
}

export type NativeOrbisAddon = Partial<NativeMetadataAddon> & Record<string, unknown>

export class NodeDirectoryMetadataSource implements DirectoryMetadataSource {
  readonly #fileSystem: ScanFileSystem & { opendir?: (path: string) => Promise<NodeDirectoryHandle> }
  readonly #metadataMapper: OrderedConcurrentMapper
  readonly pageConcurrency: number

  constructor(fileSystem: ScanFileSystem, metadataConcurrency = 4) {
    this.#fileSystem = fileSystem as ScanFileSystem & { opendir?: (path: string) => Promise<NodeDirectoryHandle> }
    this.pageConcurrency = Math.max(1, Math.min(64, Math.floor(metadataConcurrency)))
    this.#metadataMapper = createOrderedConcurrentMapper(this.pageConcurrency)
  }

  async open(path: string, targetRealpath: string): Promise<DirectoryMetadataCursor> {
    const openedRealpath = await this.#fileSystem.realpath(path)
    if (!isWithin(openedRealpath, targetRealpath)) throw new Error("Directory escaped the scan target")
    const handle = this.#fileSystem.opendir
      ? await this.#fileSystem.opendir(path)
      : await createReaddirHandle(this.#fileSystem, path)
    return new NodeDirectoryMetadataCursor(path, handle, this.#fileSystem.lstat.bind(this.#fileSystem), this.#metadataMapper)
  }
}

class NodeDirectoryMetadataCursor implements DirectoryMetadataCursor {
  #closed = false
  #done = false

  constructor(
    private readonly directory: string,
    private readonly handle: NodeDirectoryHandle,
    private readonly lstat: (path: string) => Promise<ScanStats>,
    private readonly metadataMapper: OrderedConcurrentMapper
  ) {}

  async readPage(limit: number, signal: AbortSignal): Promise<DirectoryMetadataPage> {
    if (this.#closed || this.#done) return { entries: [], done: true, bulkEntries: 0, fallbackEntries: 0 }
    recordScanCounter('nodePageReads')
    const names: string[] = []
    const size = clampPageLimit(limit)
    for (let index = 0; index < size; index += 1) {
      throwIfAborted(signal)
      const entry = await this.handle.read()
      if (!entry) {
        this.#done = true
        break
      }
      names.push(entry.name)
    }
    names.sort(compareNames)
    const entries: DirectoryMetadataEntry[] = []
    const metadata = this.metadataMapper.map(names, { signal }, async (name): Promise<DirectoryMetadataEntry> => {
      throwIfAborted(signal)
      const path = normalize(resolve(this.directory, name))
      try {
        const stats = await this.lstat(path)
        return fromStats(name, stats)
      } catch (error) {
        return { name, kind: "other", device: "", inode: "", allocatedBytes: 0, mountPoint: false, error }
      }
    })
    for await (const entry of metadata) entries.push(entry)
    recordScanCounter('metadataEntries', entries.length)
    return { entries, done: this.#done && entries.length === names.length, bulkEntries: 0, fallbackEntries: entries.length }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.handle.close()
  }
}

export class BulkExactMetadataSource implements DirectoryMetadataSource {
  readonly pageConcurrency: number

  constructor(private readonly tree: NativeMetadataTree, private readonly target: string, metadataConcurrency = 4) {
    this.pageConcurrency = Math.max(1, Math.min(64, Math.floor(metadataConcurrency)))
  }

  async open(path: string, _targetRealpath: string): Promise<DirectoryMetadataCursor> {
    const relativePath = relative(this.target, normalize(resolve(path)))
    if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error("Directory escaped the scan target")
    return new NativeDirectoryMetadataCursor(this.tree.openDirectory(relativePath))
  }

  async close(): Promise<void> { this.tree.close() }
}

class NativeDirectoryMetadataCursor implements DirectoryMetadataCursor {
  #closed = false

  constructor(private readonly cursor: NativeDirectoryCursor) {}

  async readPage(limit: number, signal: AbortSignal): Promise<DirectoryMetadataPage> {
    throwIfAborted(signal)
    if (this.#closed) return { entries: [], done: true, bulkEntries: 0, fallbackEntries: 0 }
    recordScanCounter('nativePageReads')
    const page = await this.cursor.readPage(clampPageLimit(limit))
    throwIfAborted(signal)
    recordScanCounter('nativePayloadBytes', page.payload.byteLength)
    const decoded = decodeNativePage(page)
    recordScanCounter('metadataEntries', decoded.entries.length)
    return decoded
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.cursor.close()
  }
}

export function decodeNativePage(page: NativeMetadataPage): DirectoryMetadataPage {
  const payload = Buffer.from(page.payload)
  if (payload.length < 16 || payload.toString('ascii', 0, 4) !== 'ORB1' || payload.readUInt16LE(4) !== 1 || payload.readUInt16LE(6) !== 48) throw new Error('Malformed native metadata page header')
  const count = payload.readUInt32LE(8)
  const namesLength = payload.readUInt32LE(12)
  const bulkEntries = finiteCount(page.bulkEntries ?? count)
  const fallbackEntries = finiteCount(page.fallbackEntries ?? 0)
  if (count !== finiteCount(page.count) || bulkEntries + fallbackEntries !== count || 16 + count * 48 + namesLength !== payload.length) throw new Error('Malformed native metadata page bounds')
  const namesStart = 16 + count * 48
  const entries: DirectoryMetadataEntry[] = []
  const nameRanges: Array<readonly [number, number]> = []
  for (let index = 0; index < count; index += 1) {
    const offset = 16 + index * 48
    const nameOffset = payload.readUInt32LE(offset)
    const nameLength = payload.readUInt32LE(offset + 4)
    if (nameLength === 0 || nameOffset + nameLength > namesLength) throw new Error('Malformed native metadata name range')
    nameRanges.push([nameOffset, nameOffset + nameLength])
    const kindValue = payload[offset + 8]!
    const flags = payload[offset + 9]!
    if (kindValue > 3 || flags & ~0x1f || payload.readUInt16LE(offset + 10) !== 0) throw new Error('Malformed native metadata record')
    const errno = payload.readInt32LE(offset + 12)
    const u64 = (at: number): bigint => payload.readBigUInt64LE(offset + at)
    const name = payload.toString('utf8', namesStart + nameOffset, namesStart + nameOffset + nameLength)
    if (name === '.' || name === '..' || name.includes('/') || name.includes('\u0000')) throw new Error('Malformed native metadata name')
    const entry: DirectoryMetadataEntry = {
      name,
      kind: kindValue === 1 ? 'file' : kindValue === 2 ? 'directory' : kindValue === 3 ? 'symlink' : 'other',
      device: flags & 2 ? u64(16).toString(10) : '', inode: flags & 4 ? u64(24).toString(10) : '',
      allocatedBytes: finiteBytes(u64(32)), ...(flags & 8 ? { linkCount: finiteCount(u64(40)) } : {}),
      mountPoint: Boolean(flags & 1), ...(flags & 16 ? { error: nativeError(errno) } : {})
    }
    entries.push(entry)
  }
  nameRanges.sort((left, right) => left[0] - right[0])
  let covered = 0
  for (const [start, end] of nameRanges) {
    if (start !== covered) throw new Error('Malformed native metadata name layout')
    covered = end
  }
  if (covered !== namesLength) throw new Error('Malformed native metadata name layout')
  return { entries, done: Boolean(page.done), bulkEntries, fallbackEntries }
}

export function createDirectoryMetadataSource(addon: NativeMetadataAddon | undefined, _fileSystem: ScanFileSystem, metadataConcurrency: number, target: string): DirectoryMetadataSource | undefined {
  if (!addon || process.env.ORBIS_DISABLE_BULK_METADATA === "1") return undefined
  return new BulkExactMetadataSource(addon.openMetadataTree(target), target, metadataConcurrency)
}

export async function loadNativeMetadataAddon(path: string | undefined): Promise<NativeMetadataAddon | undefined> {
  if (process.env.ORBIS_DISABLE_BULK_METADATA === "1") return undefined
  const addon = await loadNativeOrbisAddon(path)
  return addon && typeof addon.openMetadataTree === "function" ? addon as NativeMetadataAddon : undefined
}

export async function loadNativeOrbisAddon(path: string | undefined): Promise<NativeOrbisAddon | undefined> {
  if (!path) return undefined
  try {
    const require = createRequire(import.meta.url)
    const loaded = require(path) as NativeOrbisAddon & { default?: NativeOrbisAddon }
    return loaded.default ?? loaded
  } catch {
    return undefined
  }
}

interface NodeDirectoryHandle {
  read(): Promise<{ name: string } | null>
  close(): Promise<void>
}

async function createReaddirHandle(fileSystem: ScanFileSystem, path: string): Promise<NodeDirectoryHandle> {
  const names = [...await fileSystem.readdir(path)].sort(compareNames)
  let index = 0
  return {
    read: async () => index < names.length ? { name: names[index++]! } : null,
    close: async () => undefined
  }
}

function fromStats(name: string, stats: ScanStats): DirectoryMetadataEntry {
  return {
    name,
    kind: stats.isSymbolicLink() ? "symlink" : stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other",
    device: String(stats.dev),
    inode: String(stats.ino),
    allocatedBytes: finiteBytes(stats.blocks === undefined ? 0 : number(stats.blocks) * 512),
    ...(stats.nlink === undefined ? {} : { linkCount: finiteCount(stats.nlink) }),
    mountPoint: false
  }
}

function clampPageLimit(value: number): number { return Math.max(1, Math.min(1_024, Math.floor(value))) }
const errnoCodeNames: Readonly<Record<number, string>> = {
  1: "EPERM",
  2: "ENOENT",
  5: "EIO",
  13: "EACCES",
  20: "ENOTDIR",
  23: "ENFILE",
  24: "EMFILE",
  62: "ELOOP",
  63: "ENAMETOOLONG"
}
function nativeError(code: number): Error & { code: string } {
  const error = new Error(`Bulk metadata failed (${code})`) as Error & { code: string }
  error.code = errnoCodeNames[code] ?? String(code)
  return error
}
function finiteBytes(value: unknown): number { const result = number(value); return Number.isFinite(result) && result > 0 ? result : 0 }
function finiteCount(value: unknown): number { const result = Math.floor(number(value)); return Number.isFinite(result) && result > 0 ? result : 0 }
function number(value: number | bigint | unknown): number { const result = typeof value === "bigint" ? Number(value) : Number(value); return Number.isFinite(result) ? result : 0 }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("Scan canceled") }
function compareNames(left: string, right: string): number { const value = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }); return value || (left < right ? -1 : left > right ? 1 : 0) }
function isWithin(path: string, parent: string): boolean { const child = normalize(resolve(path)); const root = normalize(resolve(parent)); const remainder = relative(root, child); return child === root || remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) }


export type { ScanStats }
