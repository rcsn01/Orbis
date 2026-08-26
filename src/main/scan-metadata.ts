import { createRequire } from "node:module"
import { normalize, relative, resolve, sep } from "node:path"
import type { ScanFileSystem, ScanStats } from "./legacy-scanner"
import { createOrderedConcurrentMapper, type OrderedConcurrentMapper } from "./ordered-concurrent-map"

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

export interface NativeMetadataEntry {
  readonly name: string
  readonly kind: DirectoryMetadataKind | string
  readonly device: string
  readonly inode: string
  readonly allocatedBytes: number
  readonly linkCount?: number
  readonly mountPoint: boolean
  readonly errorCode?: number | null
}

export interface NativeMetadataPage {
  readonly entries: readonly NativeMetadataEntry[]
  readonly done: boolean
  readonly bulkEntries?: number
  readonly fallbackEntries?: number
}

export interface NativeDirectoryCursor {
  readPage(limit: number): NativeMetadataPage
  close(): void
}

export interface NativeMetadataAddon {
  openDirectory(path: string): NativeDirectoryCursor
}

export interface MetadataCursorDiagnostics {
  readonly nativeReadPageCalls: number
  readonly nodeReadPageCalls: number
}

const metadataCursorDiagnostics = { nativeReadPageCalls: 0, nodeReadPageCalls: 0 }

export function resetMetadataCursorDiagnostics(): void {
  metadataCursorDiagnostics.nativeReadPageCalls = 0
  metadataCursorDiagnostics.nodeReadPageCalls = 0
}

export function readMetadataCursorDiagnostics(): MetadataCursorDiagnostics {
  return { ...metadataCursorDiagnostics }
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
    metadataCursorDiagnostics.nodeReadPageCalls += 1
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
    return { entries, done: this.#done && entries.length === names.length, bulkEntries: 0, fallbackEntries: entries.length }
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.handle.close()
  }
}

export class BulkExactMetadataSource implements DirectoryMetadataSource {
  readonly #addon: NativeMetadataAddon
  readonly #fileSystem: ScanFileSystem

  constructor(addon: NativeMetadataAddon, fileSystem: ScanFileSystem) {
    this.#addon = addon
    this.#fileSystem = fileSystem
  }

  async open(path: string, targetRealpath: string): Promise<DirectoryMetadataCursor> {
    const openedRealpath = await this.#fileSystem.realpath(path)
    if (!isWithin(openedRealpath, targetRealpath)) throw new Error("Directory escaped the scan target")
    return new NativeDirectoryMetadataCursor(this.#addon.openDirectory(path))
  }
}

class NativeDirectoryMetadataCursor implements DirectoryMetadataCursor {
  #closed = false

  constructor(private readonly cursor: NativeDirectoryCursor) {}

  async readPage(limit: number, signal: AbortSignal): Promise<DirectoryMetadataPage> {
    throwIfAborted(signal)
    if (this.#closed) return { entries: [], done: true, bulkEntries: 0, fallbackEntries: 0 }
    metadataCursorDiagnostics.nativeReadPageCalls += 1
    const page = this.cursor.readPage(clampPageLimit(limit))
    throwIfAborted(signal)
    return nativePage(page)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.cursor.close()
  }
}

function nativePage(page: NativeMetadataPage): DirectoryMetadataPage {
  return {
    entries: page.entries.map((entry) => ({
      name: entry.name,
      kind: normalizeKind(entry.kind),
      device: String(entry.device ?? ""),
      inode: String(entry.inode ?? ""),
      allocatedBytes: finiteBytes(entry.allocatedBytes),
      ...(entry.linkCount === undefined ? {} : { linkCount: finiteCount(entry.linkCount) }),
      mountPoint: Boolean(entry.mountPoint),
      ...(entry.errorCode == null ? {} : { error: nativeError(entry.errorCode) })
    })),
    done: Boolean(page.done),
    bulkEntries: finiteCount(page.bulkEntries ?? page.entries.length),
    fallbackEntries: finiteCount(page.fallbackEntries ?? 0)
  }
}

export function createDirectoryMetadataSource(addon: NativeMetadataAddon | undefined, fileSystem: ScanFileSystem, _metadataConcurrency: number): DirectoryMetadataSource | undefined {
  if (!addon || process.env.ORBIS_DISABLE_BULK_METADATA === "1") return undefined
  return new BulkExactMetadataSource(addon, fileSystem)
}

export async function loadNativeMetadataAddon(path: string | undefined): Promise<NativeMetadataAddon | undefined> {
  if (process.env.ORBIS_DISABLE_BULK_METADATA === "1") return undefined
  const addon = await loadNativeOrbisAddon(path)
  return addon && typeof addon.openDirectory === "function" ? addon as NativeMetadataAddon : undefined
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
function normalizeKind(value: string): DirectoryMetadataKind { return value === "directory" || value === "file" || value === "symlink" ? value : "other" }
function nativeError(code: number): Error & { code: string } { const error = new Error(`Bulk metadata failed (${code})`) as Error & { code: string }; error.code = String(code); return error }
function finiteBytes(value: unknown): number { const result = number(value); return Number.isFinite(result) && result > 0 ? result : 0 }
function finiteCount(value: unknown): number { const result = Math.floor(number(value)); return Number.isFinite(result) && result > 0 ? result : 0 }
function number(value: number | bigint | unknown): number { const result = typeof value === "bigint" ? Number(value) : Number(value); return Number.isFinite(result) ? result : 0 }
function throwIfAborted(signal: AbortSignal): void { if (signal.aborted) throw new Error("Scan canceled") }
function compareNames(left: string, right: string): number { const value = left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" }); return value || (left < right ? -1 : left > right ? 1 : 0) }
function isWithin(path: string, parent: string): boolean { const child = normalize(resolve(path)); const root = normalize(resolve(parent)); const remainder = relative(root, child); return child === root || remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) }


export type { ScanStats }
