import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { lstat, statfs } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Breadcrumb, NodeSummary } from '../shared/contracts'
import { buildChart } from './chart'
import type { FullScanResumeLoad } from './full-scan-resume'
import { isFullScanResumeDescriptor } from './full-scan-resume'
import { CONSTRUCTION_NODE_SELECT, NodeReadModel, nodeFromRow, toSummary } from './index-store'
import type { ChartDataSource, DatabaseNode } from './index-store'
import type { ProgressivePreview } from './scanner'

type ConstructionResumeLoad = Extract<FullScanResumeLoad, { readonly kind: 'construction' }>

/**
 * Read the durable part of a construction database without taking ownership of
 * it.  The resume store has already validated the load; this function repeats
 * the identity checks that matter to a path-free preview so a stale or raced
 * file can only result in an absent preview.
 */
export async function readConstructionPreview(
  load: ConstructionResumeLoad,
  generation: number,
  focusId?: string
): Promise<ProgressivePreview | undefined> {
  if (!Number.isSafeInteger(generation) || generation < 0) return undefined
  return withConstructionDatabase(load, async (source, rootId, target, revision) => {
    const focus = source.getNode(focusId ?? rootId)
    if (!focus || focus.kind !== 'directory') return undefined
    const breadcrumbs = source.getBreadcrumbs(focus.id)
    if (breadcrumbs.length === 0 || breadcrumbs[0]?.id !== rootId || breadcrumbs.at(-1)?.id !== focus.id) return undefined
    const root = source.getNode(rootId)
    if (!root || root.kind !== 'directory') return undefined
    const volume = await readVolume(target)
    if (!volume) return undefined
    const scannedBytes = source.semanticScannedBytes()
    const unscannedBytes = target === '/' ? Math.max(0, volume.capacityBytes - volume.freeBytes - scannedBytes) : 0
    const rootTotalBytes = focus.id === rootId && target === '/' ? volume.capacityBytes : 0
    return {
      generation,
      revision,
      committed: false,
      target: { name: displayName(target), isStartup: target === '/' },
      focus: toSummary(focus),
      breadcrumbs,
      chart: buildChart(source, focus, { rootTotalBytes }),
      largestItems: source.getLargestItems(focus.id),
      volume: {
        capacityBytes: volume.capacityBytes,
        freeBytes: volume.freeBytes,
        scannedBytes,
        unscannedBytes,
        sizeAccuracy: unscannedBytes > 0 ? 'estimated' : focus.sizeAccuracy
      }
    }
  })
}

/** Resolve a construction node's private path for a main-process reveal. */
export async function resolveConstructionNodePath(
  load: ConstructionResumeLoad,
  id: string
): Promise<string | undefined> {
  return withConstructionDatabase(load, (source, _rootId, target) => {
    const path = source.resolvePath(id)
    if (!path || !isAbsolute(path) || !isWithinPath(path, target)) return undefined
    return path
  })
}

interface ConstructionDatabase extends ChartDataSource {
  readonly rootId: string
  readonly target: string
  readonly revision: number
  getBreadcrumbs(id: string): readonly Breadcrumb[]
  getLargestItems(id: string): readonly NodeSummary[]
  resolvePath(id: string): string | undefined
  semanticScannedBytes(): number
  close(): void
}

async function withConstructionDatabase<T>(
  load: ConstructionResumeLoad,
  operation: (source: ConstructionDatabase, rootId: string, target: string, revision: number) => Promise<T> | T
): Promise<T | undefined> {
  let source: ConstructionDatabase | undefined
  try {
    const opened = await openConstructionDatabase(load)
    if (!opened) return undefined
    source = opened.source
    return await operation(source, opened.rootId, opened.target, opened.revision)
  } catch {
    return undefined
  } finally {
    try { source?.close() } catch { /* A read-only preview never owns resumable data. */ }
  }
}

async function openConstructionDatabase(load: ConstructionResumeLoad): Promise<{
  readonly source: ConstructionDatabase
  readonly rootId: string
  readonly target: string
  readonly revision: number
} | undefined> {
  const descriptor = load?.descriptor
  if (!descriptor || !isFullScanResumeDescriptor(descriptor)) return undefined
  if (!Number.isSafeInteger(load.checkpointSequence) || load.checkpointSequence < 0 || !Number.isFinite(Date.parse(load.checkpointedAt))) return undefined
  if (typeof load.partialPath !== 'string' || typeof load.candidatePath !== 'string') return undefined

  const directory = dirname(load.partialPath)
  const expectedPartialPath = join(directory, descriptor.partialFile)
  const expectedCandidatePath = join(directory, descriptor.candidateFile)
  if (resolve(load.partialPath) !== resolve(expectedPartialPath) || resolve(load.candidatePath) !== resolve(expectedCandidatePath)) return undefined

  const [directoryStats, targetStats, partialStats] = await Promise.all([
    lstat(directory, { bigint: true }), lstat(descriptor.target, { bigint: true }), lstat(load.partialPath, { bigint: true })
  ])
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
    || `${String(directoryStats.dev)}:${String(directoryStats.ino)}` !== descriptor.indexDirectoryIdentity
    || !targetStats.isDirectory() || targetStats.isSymbolicLink()
    || String(targetStats.dev) !== descriptor.targetDevice || String(targetStats.ino) !== descriptor.targetInode
    || !partialStats.isFile() || partialStats.isSymbolicLink()) return undefined

  const databaseLocation = await previewDatabaseLocation(load)
  if (!databaseLocation) return undefined
  const database = new DatabaseSync(databaseLocation, { readOnly: true })
  let handedOff = false
  try {
    database.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON;')
    const runRows = database.prepare(`SELECT scan_id AS scanId, node_id_seed AS seed, phase,
      checkpoint_sequence AS checkpointSequence, checkpointed_at AS checkpointedAt, journal_device AS journalDevice,
      journal_uuid AS journalUuid, journal_baseline AS journalBaseline FROM scan_run WHERE singleton = 1`).all() as unknown as Array<Record<string, unknown>>
    if (runRows.length !== 1) return undefined
    const run = runRows[0]!
    if (run.scanId !== descriptor.scanId || run.journalDevice !== descriptor.journalDevice
      || run.journalUuid !== descriptor.journalUuid || run.journalBaseline !== descriptor.journalBaseline
      || run.checkpointSequence !== load.checkpointSequence || run.checkpointedAt !== load.checkpointedAt
      || run.phase !== 'scanning' && run.phase !== 'paused' && run.phase !== 'awaiting-reconciliation' && run.phase !== 'finalizing' && run.phase !== 'traversing'
      || typeof run.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(run.seed)) return undefined

    const revisionRow = database.prepare("SELECT value FROM scan_state WHERE key = 'revision'").get() as { value?: unknown } | undefined
    const revision = Number(revisionRow?.value)
    if (!Number.isSafeInteger(revision) || revision < 0) return undefined

    const roots = database.prepare(`${CONSTRUCTION_NODE_SELECT} WHERE n.parent_id IS NULL`).all() as unknown as Array<Record<string, unknown>>
    if (roots.length !== 1) return undefined
    const rootRow = roots[0]!
    const root = nodeFromRow(rootRow)
    const target = descriptor.target
    const expectedRootId = `n-${createHmac('sha256', Buffer.from(run.seed as string, 'hex')).update('root').update('\0').update(target).digest('hex').slice(0, 32)}`
    if (root.id !== expectedRootId || root.kind !== 'directory' || root.parentId !== null || root.path !== target || root.name !== displayName(target)) return undefined
    if (!isWithinPath(root.path, target)) return undefined

    const invalid = database.prepare(`SELECT COUNT(*) AS count FROM nodes WHERE
      own_bytes < 0 OR size_bytes < 0 OR direct_children < 0 OR descendant_count < 0 OR unreadable_count < 0`).get() as { count?: unknown }
    if (Number(invalid?.count ?? 0) !== 0) return undefined
    const invalidEstimates = database.prepare(`SELECT COUNT(*) AS count FROM size_estimates WHERE
      estimated_bytes < 0 OR indexed_items < 0 OR physical_size_coverage < 0 OR physical_size_coverage > 1`).get() as { count?: unknown }
    if (Number(invalidEstimates?.count ?? 0) !== 0) return undefined

    const source = new ConstructionPreviewDatabase(database, target, root.id, revision)
    handedOff = true
    // Ownership of the SQLite handle moves to the short-lived source.  The
    // caller closes it in its finally block, including all failure paths below.
    return { source, rootId: root.id, target, revision }
  } catch {
    return undefined
  } finally {
    if (!handedOff) {
      try { database.close() } catch { /* Ignore an invalid construction file. */ }
    }
  }
}

class ConstructionPreviewDatabase implements ConstructionDatabase {
  readonly rootId: string
  readonly target: string
  readonly revision: number
  readonly #readModel: NodeReadModel
  #closed = false

  constructor(private readonly database: DatabaseSync, target: string, rootId: string, revision: number) {
    this.target = target
    this.rootId = rootId
    this.revision = revision
    this.#readModel = new NodeReadModel(this.database, "construction")
  }

  getNode(id: string): DatabaseNode | undefined { return this.#readModel.getNode(id) }

  getChildren(id: string, limit: number): readonly DatabaseNode[] { return this.#readModel.getChildren(id, limit) }

  countChildren(id: string): number { return this.#readModel.countChildren(id) }

  getEstimatedRemainder(id: string): number { return this.#readModel.getEstimatedRemainder(id) }

  getLargestItems(id: string): readonly NodeSummary[] { return this.#readModel.getLargestItems(id) }

  getBreadcrumbs(id: string): readonly Breadcrumb[] { return this.#readModel.getBreadcrumbs(id) }

  resolvePath(id: string): string | undefined {
    const path = this.getNode(id)?.path
    return path && isAbsolute(path) && isWithinPath(path, this.target) ? path : undefined
  }

  semanticScannedBytes(): number {
    const row = this.database.prepare('SELECT COALESCE(SUM(own_bytes), 0) AS bytes FROM nodes').get() as { bytes?: unknown } | undefined
    const bytes = Number(row?.bytes ?? 0)
    return Number.isFinite(bytes) && bytes >= 0 ? bytes : 0
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
  }
}

async function previewDatabaseLocation(load: ConstructionResumeLoad): Promise<string | undefined> {
  const [journal, wal, shm] = await Promise.all([
    previewSidecar(`${load.partialPath}-journal`), previewSidecar(`${load.partialPath}-wal`), previewSidecar(`${load.partialPath}-shm`)
  ])
  if (journal.kind !== 'absent' || wal.kind === 'unsafe' || shm.kind === 'unsafe'
    || (wal.kind === 'regular') !== (shm.kind === 'regular')
    || wal.kind === 'regular' && wal.size > 0n) return load.partialPath
  return `${pathToFileURL(load.partialPath).href}?immutable=1`
}

type PreviewSidecar = { readonly kind: 'absent' | 'regular' | 'unsafe'; readonly size: bigint }

async function previewSidecar(path: string): Promise<PreviewSidecar> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink()) return { kind: 'unsafe', size: 0n }
    return { kind: 'regular', size: stats.size }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'absent', size: 0n } : { kind: 'unsafe', size: 0n }
  }
}

async function readVolume(target: string): Promise<{ readonly capacityBytes: number; readonly freeBytes: number } | undefined> {
  try {
    const value = await statfs(target)
    const capacityBytes = blockBytes(value.blocks, value.bsize)
    const freeBytes = blockBytes(value.bfree, value.bsize)
    return capacityBytes !== undefined && freeBytes !== undefined ? { capacityBytes, freeBytes } : undefined
  } catch {
    return undefined
  }
}

function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined }

function blockBytes(blocks: number | bigint, size: number | bigint): number | undefined {
  const blockCount = Number(blocks)
  const blockSize = Number(size)
  const value = blockCount * blockSize
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

function displayName(path: string): string { return path === '/' ? '/' : basename(path) || path }

export type { ConstructionResumeLoad }
