import { DatabaseSync } from 'node:sqlite'
import { chmod, lstat, open, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION, type JournalCursor
} from './index-manifest'
import { createScanTimingAccumulator, recordScanCounter, type ScanTimingAccumulator } from './diagnostics'
import { isPublicationId, PublicationArtifacts, publicationDatabaseFiles } from './publication-artifacts'

export const FULL_SCAN_CONSTRUCTION_VERSION = 1
// Version 1 used `traversing`; version 2 owns explicit lifecycle phases.
export const FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION = 3
const SUPPORTED_CONSTRUCTION_SCHEMA_VERSIONS = new Set([FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION])
export const SCAN_RESUME_FILE = 'scan-resume.json'

export interface FullScanResumeDescriptor {
  readonly version: 1
  readonly scanId: string
  readonly partialFile: string
  readonly candidateFile: string
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly indexDirectoryIdentity: string
  readonly startupRoot: boolean
  readonly schemaVersion: number
  readonly constructionSchemaVersion: number
  readonly accountingVersion: string
  readonly exclusionPolicyVersion: string
  readonly hardLinkOrderingVersion: string
  readonly journalDevice: string
  readonly journalUuid: string
  readonly journalBaseline: string
  readonly createdAt: string
}

export type FullScanResumeLoad =
  | { readonly kind: 'none' }
  | { readonly kind: 'restart'; readonly reason: string; readonly descriptor?: FullScanResumeDescriptor }
  | { readonly kind: 'construction'; readonly descriptor: FullScanResumeDescriptor; readonly partialPath: string; readonly candidatePath: string; readonly checkpointSequence: number; readonly checkpointedAt: string; readonly drainedThrough: string }
  | { readonly kind: 'candidate'; readonly descriptor: FullScanResumeDescriptor; readonly candidatePath: string; readonly drainedThrough: string }

export type FullScanResumePeek =
  | { readonly kind: 'none' }
  | { readonly kind: 'restart'; readonly descriptor?: FullScanResumeDescriptor }
  | { readonly kind: 'construction'; readonly descriptor: FullScanResumeDescriptor }
  | { readonly kind: 'candidate'; readonly descriptor: FullScanResumeDescriptor }

export class FullScanResumeStore {
  readonly artifacts: PublicationArtifacts
  readonly descriptorPath: string
  readonly temporaryPath: string

  constructor(readonly directory: string) {
    this.artifacts = new PublicationArtifacts(directory)
    this.descriptorPath = join(directory, SCAN_RESUME_FILE)
    this.temporaryPath = `${this.descriptorPath}.tmp`
  }

  descriptor(input: {
    readonly scanId: string
    readonly target: string
    readonly targetDevice: string
    readonly targetInode: string
    readonly indexDirectoryIdentity: string
    readonly startupRoot: boolean
    readonly checkpoint: { readonly device: string; readonly journalUuid: string; readonly eventId: string }
  }): FullScanResumeDescriptor {
    const target = normalize(resolve(input.target))
    const { partialFile, candidateFile } = publicationDatabaseFiles(input.scanId)
    return {
      version: FULL_SCAN_CONSTRUCTION_VERSION,
      scanId: input.scanId,
      partialFile,
      candidateFile,
      target,
      targetDevice: input.targetDevice,
      targetInode: input.targetInode,
      indexDirectoryIdentity: input.indexDirectoryIdentity,
      startupRoot: input.startupRoot,
      schemaVersion: PERSISTENT_INDEX_SCHEMA_VERSION,
      constructionSchemaVersion: FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION,
      accountingVersion: PERSISTENT_ACCOUNTING_VERSION,
      exclusionPolicyVersion: EXCLUSION_POLICY_VERSION,
      hardLinkOrderingVersion: HARD_LINK_ORDERING_VERSION,
      journalDevice: input.checkpoint.device,
      journalUuid: input.checkpoint.journalUuid,
      journalBaseline: input.checkpoint.eventId,
      createdAt: new Date().toISOString()
    }
  }

  async publish(descriptor: FullScanResumeDescriptor): Promise<void> {
    if (!isFullScanResumeDescriptor(descriptor)) throw new Error('Invalid Orbis scan resume descriptor')
    await writeFile(this.temporaryPath, `${JSON.stringify(descriptor)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.temporaryPath, 0o600)
    const file = await open(this.temporaryPath, 'r')
    try { await file.sync() } finally { await file.close() }
    await rename(this.temporaryPath, this.descriptorPath)
    const directory = await open(this.directory, 'r')
    try { await directory.sync() } finally { await directory.close() }
  }

  async readDescriptor(): Promise<FullScanResumeDescriptor | undefined> {
    try {
      const stats = await lstat(this.descriptorPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined
      const parsed = JSON.parse(await readFile(this.descriptorPath, 'utf8')) as unknown
      return isFullScanResumeDescriptor(parsed) ? parsed : undefined
    } catch { return undefined }
  }

  async peek(): Promise<FullScanResumePeek> {
    // Cheap controller-side lookahead: descriptor plus file existence only.
    // The worker performs the authoritative validation before resuming.
    const descriptor = await this.readDescriptor()
    if (!descriptor) return { kind: 'none' }
    const [partial, candidate] = await Promise.all([
      regularFile(join(this.directory, descriptor.partialFile)),
      regularFile(join(this.directory, descriptor.candidateFile))
    ])
    if (candidate) return { kind: 'candidate', descriptor }
    if (partial) return { kind: 'construction', descriptor }
    return { kind: 'restart', descriptor }
  }

  async load(expectedTarget?: string): Promise<FullScanResumeLoad> {
    const timings = resumeValidationTimings()
    let attempted = false
    try {
      return await timings.total.measureAsync(async () => {
        let raw: unknown
        const descriptorFailure = await timings.descriptor.measureAsync(async (): Promise<FullScanResumeLoad | undefined> => {
          try {
            const stats = await lstat(this.descriptorPath)
            attempted = true
            if (!stats.isFile() || stats.isSymbolicLink()) return { kind: 'restart', reason: 'unsafe-resume-descriptor' }
            raw = JSON.parse(await readFile(this.descriptorPath, 'utf8')) as unknown
          } catch (error) {
            if (errorCode(error) === 'ENOENT') return { kind: 'none' }
            attempted = true
            return { kind: 'restart', reason: 'unreadable-resume-descriptor' }
          }
          if (!isFullScanResumeDescriptor(raw)) return { kind: 'restart', reason: 'incompatible-resume-descriptor' }
          if (expectedTarget && normalize(resolve(expectedTarget)) !== raw.target) return { kind: 'restart', reason: 'saved-scan-target-mismatch', descriptor: raw }
          return undefined
        })
        if (descriptorFailure) return descriptorFailure
        const descriptor = raw as FullScanResumeDescriptor

        const files = await timings.files.measureAsync(async (): Promise<FullScanResumeLoad | { partialPath: string; candidatePath: string; partial: boolean; candidate: boolean }> => {
          const directoryIdentity = await regularDirectoryIdentity(this.directory)
          if (!directoryIdentity || directoryIdentity !== descriptor.indexDirectoryIdentity) return { kind: 'restart', reason: 'index-directory-replaced', descriptor }
          const targetIdentity = await regularDirectoryIdentity(descriptor.target)
          if (!targetIdentity) return { kind: 'restart', reason: 'target-unavailable', descriptor }
          if (targetIdentity !== `${descriptor.targetDevice}:${descriptor.targetInode}`) return { kind: 'restart', reason: 'target-replaced', descriptor }
          await this.artifacts.recoverResume(descriptor.scanId).catch(() => false)
          const partialPath = join(this.directory, descriptor.partialFile)
          const candidatePath = join(this.directory, descriptor.candidateFile)
          const [partial, candidate] = await Promise.all([regularFile(partialPath), regularFile(candidatePath)])
          return { partialPath, candidatePath, partial, candidate }
        })
        if ('kind' in files) return files
        const { partialPath, candidatePath, partial, candidate } = files
        if (candidate) {
          const valid = timings.candidate.measure(() => validateCandidate(candidatePath, descriptor, timings))
          if (valid) return { kind: 'candidate', descriptor, candidatePath, drainedThrough: readCandidateDrainedThrough(candidatePath) ?? descriptor.journalBaseline }
          if (!partial) return { kind: 'restart', reason: 'invalid-finalized-candidate', descriptor }
        }
        if (!partial) return { kind: 'restart', reason: 'missing-resume-database', descriptor }
        if (hasResumeDrainedThrough(partialPath) && timings.candidate.measure(() => validateCandidate(partialPath, descriptor, timings))) {
          if (candidate) await this.artifacts.discardResumeCandidate(descriptor.scanId)
          await durablePromote(partialPath, candidatePath, this.directory)
          return { kind: 'candidate', descriptor, candidatePath, drainedThrough: readCandidateDrainedThrough(candidatePath) ?? descriptor.journalBaseline }
        }
        try {
          recordScanCounter('resumeFullValidations')
          const database = new DatabaseSync(partialPath)
          try {
            const integrity = timings.integrity.measure(() => database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string })
            const foreignKeys = timings.foreignKeys.measure(() => {
              database.exec('PRAGMA foreign_keys=ON')
              return database.prepare('PRAGMA foreign_key_check').all()
            })
            const row = timings.construction.measure(() => database.prepare(`SELECT scan_id AS scanId, node_id_seed AS seed, phase, checkpoint_sequence AS checkpointSequence,
              checkpointed_at AS checkpointedAt, journal_device AS journalDevice, journal_uuid AS journalUuid,
              journal_baseline AS journalBaseline, drained_through AS drainedThrough FROM scan_run WHERE singleton = 1`).get() as Record<string, unknown> | undefined)
            if (integrity.integrity_check !== 'ok' || foreignKeys.length > 0 || !row || row.scanId !== descriptor.scanId
              || typeof row.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(row.seed)
              || row.journalDevice !== descriptor.journalDevice || row.journalUuid !== descriptor.journalUuid
              || row.journalBaseline !== descriptor.journalBaseline
              || !Number.isSafeInteger(Number(row.checkpointSequence)) || Number(row.checkpointSequence) < 0
              || typeof row.checkpointedAt !== 'string' || !Number.isFinite(Date.parse(row.checkpointedAt))
              || row.phase !== 'traversing' && row.phase !== 'scanning' && row.phase !== 'paused' && row.phase !== 'awaiting-reconciliation' && row.phase !== 'finalizing'
              || !decimal(row.drainedThrough) || BigInt(row.drainedThrough) < BigInt(descriptor.journalBaseline)) return { kind: 'restart', reason: 'invalid-resume-database', descriptor }
            if (candidate) await this.artifacts.discardResumeCandidate(descriptor.scanId)
            return {
              kind: 'construction', descriptor, partialPath, candidatePath,
              checkpointSequence: Number(row.checkpointSequence ?? 0), checkpointedAt: String(row.checkpointedAt ?? descriptor.createdAt),
              drainedThrough: String(row.drainedThrough)
            }
          } finally { database.close() }
        } catch { return { kind: 'restart', reason: 'invalid-resume-database', descriptor } }
      })
    } finally {
      if (attempted) for (const timing of Object.values(timings)) timing.publish()
    }
  }

  async removeDescriptor(): Promise<void> {
    await this.artifacts.removeResumeMetadata()
  }

  async complete(expectedScanId: string): Promise<boolean> {
    return this.artifacts.completeResume(expectedScanId)
  }

  async discard(expectedScanId?: string): Promise<boolean> {
    return this.artifacts.discardResume(expectedScanId)
  }

  cursor(descriptor: FullScanResumeDescriptor, eventId = descriptor.journalBaseline): JournalCursor {
    return { uuid: descriptor.journalUuid, eventId }
  }
}

export function isFullScanResumeDescriptor(value: unknown): value is FullScanResumeDescriptor {
  if (!value || typeof value !== 'object') return false
  const descriptor = value as Partial<FullScanResumeDescriptor>
  return descriptor.version === FULL_SCAN_CONSTRUCTION_VERSION && isPublicationId(descriptor.scanId)
    && descriptor.partialFile === `index-${descriptor.scanId}.partial.sqlite`
    && descriptor.candidateFile === `index-${descriptor.scanId}.sqlite`
    && typeof descriptor.target === 'string' && isAbsolute(descriptor.target) && normalize(descriptor.target) === descriptor.target && !descriptor.target.includes('\u0000')
    && decimal(descriptor.targetDevice) && decimal(descriptor.targetInode) && identity(descriptor.indexDirectoryIdentity)
    && typeof descriptor.startupRoot === 'boolean' && descriptor.schemaVersion === PERSISTENT_INDEX_SCHEMA_VERSION
    && typeof descriptor.constructionSchemaVersion === 'number' && SUPPORTED_CONSTRUCTION_SCHEMA_VERSIONS.has(descriptor.constructionSchemaVersion)
    && descriptor.accountingVersion === PERSISTENT_ACCOUNTING_VERSION && descriptor.exclusionPolicyVersion === EXCLUSION_POLICY_VERSION
    && descriptor.hardLinkOrderingVersion === HARD_LINK_ORDERING_VERSION && decimal(descriptor.journalDevice)
    && typeof descriptor.journalUuid === 'string' && descriptor.journalUuid.length > 0 && decimal(descriptor.journalBaseline)
    && typeof descriptor.createdAt === 'string' && Number.isFinite(Date.parse(descriptor.createdAt))
}

export function descriptorOwnedFiles(descriptor: FullScanResumeDescriptor | undefined): readonly string[] {
  return descriptor ? [descriptor.partialFile, descriptor.candidateFile] : []
}

async function regularDirectoryIdentity(path: string): Promise<string | undefined> {
  try {
    const stats = await lstat(path)
    return stats.isDirectory() && !stats.isSymbolicLink() ? `${String(stats.dev)}:${String(stats.ino)}` : undefined
  } catch { return undefined }
}
async function regularFile(path: string): Promise<boolean> {
  try { const stats = await lstat(path); return stats.isFile() && !stats.isSymbolicLink() }
  catch { return false }
}
interface ResumeValidationTimings {
  readonly total: ScanTimingAccumulator
  readonly descriptor: ScanTimingAccumulator
  readonly files: ScanTimingAccumulator
  readonly candidate: ScanTimingAccumulator
  readonly construction: ScanTimingAccumulator
  readonly integrity: ScanTimingAccumulator
  readonly foreignKeys: ScanTimingAccumulator
}

function resumeValidationTimings(): ResumeValidationTimings {
  return {
    total: createScanTimingAccumulator('resume-load-total'),
    descriptor: createScanTimingAccumulator('resume-descriptor-validation'),
    files: createScanTimingAccumulator('resume-file-validation'),
    candidate: createScanTimingAccumulator('resume-candidate-validation'),
    construction: createScanTimingAccumulator('resume-construction-validation'),
    integrity: createScanTimingAccumulator('resume-integrity-check'),
    foreignKeys: createScanTimingAccumulator('resume-foreign-key-check')
  }
}

function validateCandidate(path: string, descriptor: FullScanResumeDescriptor, timings: ResumeValidationTimings): boolean {
  try {
    recordScanCounter('resumeFullValidations')
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const constructionTables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
        WHERE type = 'table' AND name IN ('directory_tasks', 'hardlink_owners', 'scan_state', 'scan_run', 'scan_counters', 'dirty_scopes', 'size_estimates', 'estimate_roots')`).get() as { count?: number }
      if (Number(constructionTables.count ?? 0) !== 0) return false
      const integrity = timings.integrity.measure(() => database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string })
      const foreignKeys = timings.foreignKeys.measure(() => {
        database.exec('PRAGMA foreign_keys=ON')
        return database.prepare('PRAGMA foreign_key_check').all()
      })
      if (integrity.integrity_check !== 'ok' || foreignKeys.length > 0) return false
      const values = Object.fromEntries((database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
      if (values.target !== descriptor.target || values.targetDevice !== descriptor.targetDevice || values.targetInode !== descriptor.targetInode
        || values.indexDirectoryIdentity !== descriptor.indexDirectoryIdentity || values.schemaVersion !== String(descriptor.schemaVersion)
        || values.accountingVersion !== descriptor.accountingVersion || values.exclusionPolicyVersion !== descriptor.exclusionPolicyVersion
        || values.hardLinkOrderingVersion !== descriptor.hardLinkOrderingVersion) return false
      const dirtyScopes = JSON.parse(values.resumeDirtyScopes ?? '[]') as unknown
      if (!decimal(values.resumeDrainedThrough) || BigInt(values.resumeDrainedThrough) < BigInt(descriptor.journalBaseline)
        || !Array.isArray(dirtyScopes) || dirtyScopes.length > 1024
        || dirtyScopes.some((scope) => typeof scope !== 'string' || !isAbsolute(scope) || normalize(scope) !== scope || !withinTarget(scope, descriptor.target) || scope === descriptor.target)) return false
      const invalidNodes = database.prepare(`SELECT COUNT(*) AS count FROM nodes node WHERE
        node.own_bytes < 0 OR node.size_bytes < 0 OR node.direct_children < 0 OR node.descendant_count < 0 OR node.unreadable_count < 0
        OR node.kind = 'file' AND (node.size_bytes <> node.own_bytes OR node.direct_children <> 0 OR node.descendant_count <> 0)
        OR node.scan_state IN ('queued', 'scanning') OR node.kind = 'directory' AND (
          node.direct_children <> (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = node.id)
          OR node.size_bytes <> node.own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = node.id), 0)
          OR node.descendant_count <> COALESCE((SELECT SUM(child.descendant_count + 1) FROM nodes child WHERE child.parent_id = node.id), 0)
          OR node.unreadable_count <> node.own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = node.id), 0)
        )`).get() as { count: number }
      const roots = database.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id IS NULL').get() as { count: number }
      if (Number(invalidNodes.count) !== 0 || Number(roots.count) !== 1) return false
      const aliases = database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode, allocated_bytes AS bytes
        FROM hardlink_paths WHERE device <> '' AND inode <> ''`).all() as unknown as Array<{ parentId: string; name: string; pathKey: string; device: string; inode: string; bytes: number }>
      const owners = database.prepare(`SELECT groups.device, groups.inode, groups.owner_path_key AS pathKey, groups.allocated_bytes AS bytes,
        nodes.parent_id AS parentId, nodes.name FROM hardlink_groups groups JOIN nodes ON nodes.id = groups.node_id`).all() as unknown as Array<{ device: string; inode: string; pathKey: string; bytes: number; parentId: string; name: string }>
      const ownerByIdentity = new Map(owners.map((owner) => [`${owner.device}\0${owner.inode}`, owner]))
      const groups = new Map<string, typeof aliases>()
      for (const alias of aliases) { const key = `${alias.device}\0${alias.inode}`; const group = groups.get(key) ?? []; group.push(alias); groups.set(key, group) }
      if (ownerByIdentity.size !== groups.size) return false
      for (const [identity, group] of groups) {
        group.sort((left, right) => Buffer.compare(Buffer.from(left.pathKey, 'utf8'), Buffer.from(right.pathKey, 'utf8')))
        const alias = group[0]!
        const owner = ownerByIdentity.get(identity)
        if (!owner || owner.pathKey !== alias.pathKey || owner.parentId !== alias.parentId || owner.name !== alias.name || Number(owner.bytes) !== Number(alias.bytes)) return false
      }
      const totals = JSON.parse(values.totals ?? '{}') as Record<string, unknown>
      const semantic = database.prepare(`SELECT COUNT(*) AS items,
        (SELECT id FROM nodes WHERE parent_id IS NULL) AS rootId,
        (SELECT size_bytes FROM nodes WHERE parent_id IS NULL) AS bytes,
        (SELECT COALESCE(SUM(direct_skipped_count), 0) FROM directory_observations) AS skipped,
        (SELECT COALESCE(SUM(direct_unreadable_count), 0) FROM directory_observations) AS unreadable,
        (SELECT COALESCE(SUM(direct_disappearing_count), 0) FROM directory_observations) AS disappearing,
        (SELECT COALESCE(SUM(direct_symlink_count), 0) FROM directory_observations) AS symlinks,
        (SELECT COALESCE(SUM(direct_nested_mount_count), 0) FROM directory_observations) AS mounts,
        (SELECT COALESCE(SUM(direct_duplicate_count), 0) FROM directory_observations) AS duplicates FROM nodes`).get() as Record<string, unknown>
      const elapsed = Number(totals.elapsedMs)
      return values.rootId === semantic.rootId && Number(values.scannedBytes) === Number(semantic.bytes)
        && Number(totals.scannedItems) === Number(semantic.items) && Number(totals.discoveredBytes) === Number(semantic.bytes)
        && Number(totals.skippedItems) === Number(semantic.skipped) && Number(totals.unreadableItems) === Number(semantic.unreadable)
        && Number(totals.disappearingItems) === Number(semantic.disappearing) && Number(totals.symlinks) === Number(semantic.symlinks)
        && Number(totals.nestedMounts) === Number(semantic.mounts) && Number(totals.duplicateHardLinks) === Number(semantic.duplicates)
        && Number.isFinite(elapsed) && elapsed >= 0
    } finally { database.close() }
  } catch { return false }
}
function readCandidateDrainedThrough(path: string): string | undefined {
  try {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const row = database.prepare(`SELECT value FROM metadata WHERE key = 'resumeDrainedThrough'`).get() as { value?: string } | undefined
      return typeof row?.value === 'string' && decimal(row.value) ? row.value : undefined
    } finally { database.close() }
  } catch { return undefined }
}
function hasResumeDrainedThrough(path: string): boolean {
  try {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      return database.prepare(`SELECT 1 AS found FROM metadata WHERE key = 'resumeDrainedThrough'`).get() !== undefined
    } finally { database.close() }
  } catch { return false }
}
async function durablePromote(partialPath: string, candidatePath: string, directoryPath: string): Promise<void> {
  const partial = await open(partialPath, 'r')
  try { await partial.sync() } finally { await partial.close() }
  await rename(partialPath, candidatePath)
  const directory = await open(directoryPath, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
function withinTarget(path: string, target: string): boolean { const remainder = relative(target, path); return path === target || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) }
function identity(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u.test(value) }
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined }
