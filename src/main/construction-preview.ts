import { createHmac } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { lstat, statfs } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import type { Breadcrumb, DirectoryScanState, NodeSummary, SizeAccuracy } from '../shared/contracts'
import { buildChart } from './chart'
import type { FullScanResumeLoad } from './full-scan-resume'
import { isFullScanResumeDescriptor } from './full-scan-resume'
import type { ChartDataSource, DatabaseNode } from './index-store'
import { toSummary } from './index-store'
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
    const scannedBytes = root.confirmedBytes
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
    lstat(directory), lstat(descriptor.target), lstat(load.partialPath)
  ])
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()
    || `${String(directoryStats.dev)}:${String(directoryStats.ino)}` !== descriptor.indexDirectoryIdentity
    || !targetStats.isDirectory() || targetStats.isSymbolicLink()
    || String(targetStats.dev) !== descriptor.targetDevice || String(targetStats.ino) !== descriptor.targetInode
    || !partialStats.isFile() || partialStats.isSymbolicLink()) return undefined

  const database = new DatabaseSync(load.partialPath, { readOnly: true })
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
      || run.phase !== 'traversing' && run.phase !== 'awaiting-reconciliation' && run.phase !== 'finalizing'
      || typeof run.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(run.seed)) return undefined

    const revisionRow = database.prepare("SELECT value FROM scan_state WHERE key = 'revision'").get() as { value?: unknown } | undefined
    const revision = Number(revisionRow?.value)
    if (!Number.isSafeInteger(revision) || revision < 0) return undefined

    const roots = database.prepare(`${NODE_SELECT} WHERE n.parent_id IS NULL`).all() as unknown as Array<Record<string, unknown>>
    if (roots.length !== 1) return undefined
    const rootRow = roots[0]!
    const root = databaseNode(rootRow)
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
  #closed = false

  constructor(private readonly database: DatabaseSync, target: string, rootId: string, revision: number) {
    this.target = target
    this.rootId = rootId
    this.revision = revision
  }

  getNode(id: string): DatabaseNode | undefined {
    const row = this.database.prepare(`${NODE_SELECT} WHERE n.id = ?`).get(id) as unknown as Record<string, unknown> | undefined
    return row ? databaseNode(row) : undefined
  }

  getChildren(id: string, limit: number): readonly DatabaseNode[] {
    const safeLimit = Math.max(0, Math.min(400, Math.floor(limit)))
    if (safeLimit === 0) return []
    const rows = this.database.prepare(`${NODE_SELECT} WHERE n.parent_id = ? ORDER BY display_size DESC, n.name COLLATE NOCASE ASC, n.id ASC LIMIT ?`).all(id, safeLimit) as unknown as Array<Record<string, unknown>>
    return rows.map(databaseNode)
  }

  countChildren(id: string): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id = ?').get(id) as { count?: unknown } | undefined
    return nonnegativeInteger(row?.count)
  }

  getEstimatedRemainder(id: string): number {
    const row = this.database.prepare(`
      SELECT n.scan_state AS scanState, COALESCE(e.estimated_bytes, 0) AS estimatedBytes,
        COALESCE((SELECT SUM(
          CASE WHEN child.scan_state IN ('queued', 'scanning')
            THEN MAX(child.size_bytes, COALESCE(childEstimate.estimated_bytes, 0))
            ELSE child.size_bytes
          END
        ) FROM nodes child LEFT JOIN size_estimates childEstimate ON childEstimate.node_id = child.id WHERE child.parent_id = n.id), 0) AS childBytes
      FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id WHERE n.id = ?
    `).get(id) as unknown as { scanState?: unknown; estimatedBytes?: unknown; childBytes?: unknown } | undefined
    if (!row || (row.scanState !== 'queued' && row.scanState !== 'scanning')) return 0
    return Math.max(0, safeBytes(row.estimatedBytes) - safeBytes(row.childBytes))
  }

  getLargestItems(id: string): readonly NodeSummary[] { return this.getChildren(id, 100).map(toSummary) }

  getBreadcrumbs(id: string): readonly Breadcrumb[] {
    const result: Breadcrumb[] = []
    const seen = new Set<string>()
    let current = this.getNode(id)
    while (current && !seen.has(current.id)) {
      seen.add(current.id)
      result.unshift({ id: current.id, name: current.name })
      if (current.parentId === null) return result
      current = this.getNode(current.parentId)
    }
    return []
  }

  resolvePath(id: string): string | undefined {
    const path = this.getNode(id)?.path
    return path && isAbsolute(path) && isWithinPath(path, this.target) ? path : undefined
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.database.close()
  }
}

const NODE_SELECT = `SELECT n.id, n.parent_id AS parentId, n.name, n.path, n.kind,
  n.size_bytes AS confirmedBytes,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN MAX(n.size_bytes, COALESCE(e.estimated_bytes, 0)) ELSE n.size_bytes END AS display_size,
  CASE WHEN n.scan_state IN ('queued', 'scanning') THEN COALESCE(e.estimated_bytes, 0) ELSE 0 END AS estimatedBytes,
  n.direct_children AS directChildren, n.descendant_count AS descendantCount,
  n.unreadable_count AS unreadableCount, n.own_unreadable AS ownUnreadable, n.scan_state AS scanState
  FROM nodes n LEFT JOIN size_estimates e ON e.node_id = n.id`

function databaseNode(row: Record<string, unknown>): DatabaseNode {
  const state = String(row.scanState)
  const scanState: DirectoryScanState = state === 'queued' || state === 'scanning' || state === 'unreadable' ? state : 'complete'
  const confirmedBytes = safeBytes(row.confirmedBytes)
  const estimatedBytes = scanState === 'queued' || scanState === 'scanning' ? safeBytes(row.estimatedBytes) : 0
  const unreadableCount = Math.max(0, safeNumber(row.unreadableCount))
  const sizeAccuracy: SizeAccuracy = scanState === 'complete' && unreadableCount === 0 && row.ownUnreadable !== 1
    ? 'exact'
    : scanState === 'queued' || scanState === 'scanning'
      ? estimatedBytes > 0 ? 'estimated' : 'partial'
      : 'partial'
  return {
    id: String(row.id), parentId: row.parentId === null ? null : String(row.parentId), name: String(row.name), path: String(row.path),
    kind: row.kind === 'directory' ? 'directory' : 'file', sizeBytes: safeBytes(row.display_size), confirmedBytes,
    estimatedBytes, directChildren: nonnegativeInteger(row.directChildren), descendantCount: nonnegativeInteger(row.descendantCount),
    unreadableCount, scanState, sizeAccuracy
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

function blockBytes(blocks: number | bigint, size: number | bigint): number | undefined {
  const blockCount = Number(blocks)
  const blockSize = Number(size)
  const value = blockCount * blockSize
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

function safeBytes(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function safeNumber(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : Number(value)
  return Number.isFinite(number) ? number : 0
}

function nonnegativeInteger(value: unknown): number {
  const number = safeNumber(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : 0
}

function isWithinPath(path: string, parent: string): boolean {
  const child = normalize(path)
  const root = normalize(parent)
  const remainder = relative(root, child)
  return child === root || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`)
}

function displayName(path: string): string { return path === '/' ? '/' : basename(path) || path }

export type { ConstructionResumeLoad }
