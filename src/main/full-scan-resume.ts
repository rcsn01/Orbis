import { DatabaseSync } from 'node:sqlite'
import { chmod, lstat, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION, type JournalCursor
} from './index-manifest'

export const FULL_SCAN_CONSTRUCTION_VERSION = 1
export const FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION = 1
export const SCAN_RESUME_FILE = 'scan-resume.json'

const SCAN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const OWNED_PARTIAL = /^index-([0-9a-f-]{36})\.partial\.sqlite$/u
const OWNED_CANDIDATE = /^index-([0-9a-f-]{36})\.sqlite$/u

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
  | { readonly kind: 'construction'; readonly descriptor: FullScanResumeDescriptor; readonly partialPath: string; readonly candidatePath: string; readonly checkpointSequence: number; readonly checkpointedAt: string }
  | { readonly kind: 'candidate'; readonly descriptor: FullScanResumeDescriptor; readonly candidatePath: string }

export class FullScanResumeStore {
  readonly descriptorPath: string
  readonly temporaryPath: string

  constructor(readonly directory: string) {
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
    return {
      version: FULL_SCAN_CONSTRUCTION_VERSION,
      scanId: input.scanId,
      partialFile: `index-${input.scanId}.partial.sqlite`,
      candidateFile: `index-${input.scanId}.sqlite`,
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

  async load(expectedTarget?: string): Promise<FullScanResumeLoad> {
    let raw: unknown
    try {
      const stats = await lstat(this.descriptorPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return { kind: 'restart', reason: 'unsafe-resume-descriptor' }
      raw = JSON.parse(await readFile(this.descriptorPath, 'utf8')) as unknown
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? { kind: 'none' } : { kind: 'restart', reason: 'unreadable-resume-descriptor' }
    }
    if (!isFullScanResumeDescriptor(raw)) return { kind: 'restart', reason: 'incompatible-resume-descriptor' }
    const descriptor = raw
    if (expectedTarget && normalize(resolve(expectedTarget)) !== descriptor.target) return { kind: 'restart', reason: 'saved-scan-target-mismatch', descriptor }
    const directoryIdentity = await regularDirectoryIdentity(this.directory)
    if (!directoryIdentity || directoryIdentity !== descriptor.indexDirectoryIdentity) return { kind: 'restart', reason: 'index-directory-replaced', descriptor }
    const targetIdentity = await regularDirectoryIdentity(descriptor.target)
    if (!targetIdentity) return { kind: 'restart', reason: 'target-unavailable', descriptor }
    if (targetIdentity !== `${descriptor.targetDevice}:${descriptor.targetInode}`) return { kind: 'restart', reason: 'target-replaced', descriptor }

    const partialPath = join(this.directory, descriptor.partialFile)
    const candidatePath = join(this.directory, descriptor.candidateFile)
    const [partial, candidate] = await Promise.all([regularFile(partialPath), regularFile(candidatePath)])
    if (candidate) {
      const valid = validateCandidate(candidatePath, descriptor)
      return valid ? { kind: 'candidate', descriptor, candidatePath } : { kind: 'restart', reason: 'invalid-finalized-candidate', descriptor }
    }
    if (!partial) return { kind: 'restart', reason: 'missing-resume-database', descriptor }
    if (validateCandidate(partialPath, descriptor)) {
      await durablePromote(partialPath, candidatePath, this.directory)
      return { kind: 'candidate', descriptor, candidatePath }
    }
    try {
      const database = new DatabaseSync(partialPath)
      try {
        const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
        database.exec('PRAGMA foreign_keys=ON')
        const foreignKeys = database.prepare('PRAGMA foreign_key_check').all()
        const row = database.prepare(`SELECT scan_id AS scanId, node_id_seed AS seed, checkpoint_sequence AS checkpointSequence,
          checkpointed_at AS checkpointedAt, journal_device AS journalDevice, journal_uuid AS journalUuid,
          journal_baseline AS journalBaseline FROM scan_run WHERE singleton = 1`).get() as Record<string, unknown> | undefined
        if (integrity.integrity_check !== 'ok' || foreignKeys.length > 0 || !row || row.scanId !== descriptor.scanId
          || typeof row.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(row.seed)
          || row.journalDevice !== descriptor.journalDevice || row.journalUuid !== descriptor.journalUuid
          || row.journalBaseline !== descriptor.journalBaseline) return { kind: 'restart', reason: 'invalid-resume-database', descriptor }
        return {
          kind: 'construction', descriptor, partialPath, candidatePath,
          checkpointSequence: Number(row.checkpointSequence ?? 0), checkpointedAt: String(row.checkpointedAt ?? descriptor.createdAt)
        }
      } finally { database.close() }
    } catch { return { kind: 'restart', reason: 'invalid-resume-database', descriptor } }
  }

  async removeDescriptor(): Promise<void> {
    await Promise.all([rm(this.descriptorPath, { force: true }), rm(this.temporaryPath, { force: true })])
  }

  async complete(expectedScanId: string): Promise<boolean> {
    const descriptor = await this.readDescriptor()
    if (!descriptor || descriptor.scanId !== expectedScanId) return false
    await removeOwnedArtifact(join(this.directory, descriptor.partialFile), this.directory)
    const current = await this.readDescriptor()
    if (current?.scanId === descriptor.scanId) await rm(this.descriptorPath, { force: true })
    await rm(this.temporaryPath, { force: true })
    return true
  }

  async discard(expectedScanId?: string): Promise<boolean> {
    const descriptor = await this.readDescriptor()
    if (!descriptor || expectedScanId && descriptor.scanId !== expectedScanId) return false
    const authoritative = await currentIndexFile(this.directory)
    await Promise.all([
      removeOwnedArtifact(join(this.directory, descriptor.partialFile), this.directory),
      ...(authoritative === descriptor.candidateFile ? [] : [removeOwnedArtifact(join(this.directory, descriptor.candidateFile), this.directory)])
    ])
    const current = await this.readDescriptor()
    if (current?.scanId === descriptor.scanId) await rm(this.descriptorPath, { force: true })
    await rm(this.temporaryPath, { force: true })
    return true
  }

  cursor(descriptor: FullScanResumeDescriptor, eventId = descriptor.journalBaseline): JournalCursor {
    return { uuid: descriptor.journalUuid, eventId }
  }
}

export function isFullScanResumeDescriptor(value: unknown): value is FullScanResumeDescriptor {
  if (!value || typeof value !== 'object') return false
  const descriptor = value as Partial<FullScanResumeDescriptor>
  return descriptor.version === FULL_SCAN_CONSTRUCTION_VERSION && typeof descriptor.scanId === 'string' && SCAN_ID.test(descriptor.scanId)
    && descriptor.partialFile === `index-${descriptor.scanId}.partial.sqlite`
    && descriptor.candidateFile === `index-${descriptor.scanId}.sqlite`
    && typeof descriptor.target === 'string' && isAbsolute(descriptor.target) && normalize(descriptor.target) === descriptor.target && !descriptor.target.includes('\u0000')
    && decimal(descriptor.targetDevice) && decimal(descriptor.targetInode) && identity(descriptor.indexDirectoryIdentity)
    && typeof descriptor.startupRoot === 'boolean' && descriptor.schemaVersion === PERSISTENT_INDEX_SCHEMA_VERSION
    && descriptor.constructionSchemaVersion === FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION
    && descriptor.accountingVersion === PERSISTENT_ACCOUNTING_VERSION && descriptor.exclusionPolicyVersion === EXCLUSION_POLICY_VERSION
    && descriptor.hardLinkOrderingVersion === HARD_LINK_ORDERING_VERSION && decimal(descriptor.journalDevice)
    && typeof descriptor.journalUuid === 'string' && descriptor.journalUuid.length > 0 && decimal(descriptor.journalBaseline)
    && typeof descriptor.createdAt === 'string' && Number.isFinite(Date.parse(descriptor.createdAt))
    && OWNED_PARTIAL.test(descriptor.partialFile) && OWNED_CANDIDATE.test(descriptor.candidateFile)
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
function validateCandidate(path: string, descriptor: FullScanResumeDescriptor): boolean {
  try {
    const database = new DatabaseSync(path, { readOnly: true })
    try {
      const integrity = database.prepare('PRAGMA integrity_check').get() as { integrity_check?: string }
      database.exec('PRAGMA foreign_keys=ON')
      if (integrity.integrity_check !== 'ok' || database.prepare('PRAGMA foreign_key_check').all().length > 0) return false
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
        FROM file_aliases WHERE device <> '' AND inode <> ''`).all() as unknown as Array<{ parentId: string; name: string; pathKey: string; device: string; inode: string; bytes: number }>
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
async function durablePromote(partialPath: string, candidatePath: string, directoryPath: string): Promise<void> {
  const partial = await open(partialPath, 'r')
  try { await partial.sync() } finally { await partial.close() }
  await rename(partialPath, candidatePath)
  const directory = await open(directoryPath, 'r')
  try { await directory.sync() } finally { await directory.close() }
}
async function currentIndexFile(directory: string): Promise<string | undefined> {
  try {
    const path = join(directory, 'current.json')
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink()) return undefined
    const value = JSON.parse(await readFile(path, 'utf8')) as { publicationId?: unknown; indexFile?: unknown }
    return typeof value.publicationId === 'string' && SCAN_ID.test(value.publicationId)
      && value.indexFile === `index-${value.publicationId}.sqlite` ? value.indexFile : undefined
  } catch { return undefined }
}
async function removeOwnedArtifact(path: string, directory: string): Promise<void> {
  if (resolve(join(directory, basename(path))) !== resolve(path)) return
  const name = basename(path)
  if (!OWNED_PARTIAL.test(name) && !OWNED_CANDIDATE.test(name)) return
  await Promise.all([rm(path, { force: true }), rm(`${path}-journal`, { force: true }), rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })])
}
function withinTarget(path: string, target: string): boolean { const remainder = relative(target, path); return path === target || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) }
function identity(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u.test(value) }
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined }
