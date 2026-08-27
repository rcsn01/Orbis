import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { chmod, lstat, open, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  EXCLUSION_POLICY_VERSION, HARD_LINK_ORDERING_VERSION, PERSISTENT_ACCOUNTING_VERSION,
  PERSISTENT_INDEX_SCHEMA_VERSION, type JournalCursor
} from './index-manifest'
import {
  createScanTimingAccumulator, publishResumeReceiptFallback, recordScanCounter,
  type ResumeReceiptFallbackReason, type ScanTimingAccumulator
} from './diagnostics'
import { isPublicationId, PublicationArtifacts, publicationDatabaseFiles } from './publication-artifacts'

export const FULL_SCAN_CONSTRUCTION_VERSION = 1
// Version 1 used `traversing`; version 2 owns explicit lifecycle phases.
export const FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION = 3
const SUPPORTED_CONSTRUCTION_SCHEMA_VERSIONS = new Set([FULL_SCAN_CONSTRUCTION_SCHEMA_VERSION])
export const SCAN_RESUME_FILE = 'scan-resume.json'
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const RECEIPT_DIGEST = /^[0-9a-f]{64}$/u
const CONSTRUCTION_TABLES = "'directory_tasks', 'hardlink_owners', 'scan_state', 'scan_run', 'scan_counters', 'dirty_scopes', 'size_estimates', 'estimate_roots'"
const SQLITE_SIDECAR_SUFFIXES = ['-journal', '-wal', '-shm'] as const

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

export interface ResumeValidationReceipt {
  readonly version: 1
  readonly kind: 'construction' | 'candidate'
  readonly scanId: string
  /** SHA-256 of the exact validated descriptor bytes. */
  readonly descriptorDigest: string
  readonly checkpointSequence?: number
  readonly drainedThrough: string
  readonly database: {
    readonly file: string
    readonly device: string
    readonly inode: string
    readonly size: number
    readonly modifiedNs: string
    readonly changedNs: string
    readonly wal?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
    readonly shm?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
  }
  readonly source: 'acknowledged-pause' | 'full-validation'
}

/** Internal seam used only by deterministic receipt race tests. */
export type ResumeValidationStep = 'pre-open' | 'post-query' | 'post-close'

export interface FullScanResumeStoreOptions {
  readonly onReceiptValidationStep?: (step: ResumeValidationStep) => void | Promise<void>
}

export type FullScanResumeLoad =
  | { readonly kind: 'none' }
  | { readonly kind: 'restart'; readonly reason: string; readonly descriptor?: FullScanResumeDescriptor }
  | { readonly kind: 'construction'; readonly descriptor: FullScanResumeDescriptor; readonly partialPath: string; readonly candidatePath: string; readonly checkpointSequence: number; readonly checkpointedAt: string; readonly drainedThrough: string; readonly receipt: ResumeValidationReceipt }
  | { readonly kind: 'candidate'; readonly descriptor: FullScanResumeDescriptor; readonly candidatePath: string; readonly drainedThrough: string; readonly receipt: ResumeValidationReceipt }

export type FullScanResumePeek =
  | { readonly kind: 'none' }
  | { readonly kind: 'restart'; readonly descriptor?: FullScanResumeDescriptor }
  | { readonly kind: 'construction'; readonly descriptor: FullScanResumeDescriptor }
  | { readonly kind: 'candidate'; readonly descriptor: FullScanResumeDescriptor }

interface DescriptorSnapshot {
  readonly descriptor: FullScanResumeDescriptor
  readonly digest: string
}

type DescriptorRead =
  | { readonly kind: 'none' }
  | { readonly kind: 'invalid'; readonly reason: string; readonly descriptor?: FullScanResumeDescriptor }
  | { readonly kind: 'valid'; readonly snapshot: DescriptorSnapshot }

interface FileStamp {
  readonly device: string
  readonly inode: string
  readonly size: number
  readonly modifiedNs: string
  readonly changedNs: string
}

interface DatabaseFamilyStamp {
  readonly file: string
  readonly device: string
  readonly inode: string
  readonly size: number
  readonly modifiedNs: string
  readonly changedNs: string
  readonly wal?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
  readonly shm?: { readonly device: string; readonly inode: string; readonly size: number; readonly modifiedNs: string; readonly changedNs: string }
}

interface DatabaseFamilySnapshot {
  readonly kind: 'ok' | 'missing' | 'invalid-sidecars'
  readonly stamp?: DatabaseFamilyStamp
  readonly journalPresent: boolean
}

interface ConstructionValidation {
  readonly stamp: DatabaseFamilyStamp
  readonly checkpointSequence: number
  readonly checkpointedAt: string
  readonly drainedThrough: string
}

interface CandidateValidation {
  readonly stamp: DatabaseFamilyStamp
  readonly drainedThrough: string
  readonly journalPresent: boolean
}

interface ReceiptAttemptFailure { readonly reason: ResumeReceiptFallbackReason }
interface ReceiptAttemptSuccess { readonly load: FullScanResumeLoad }
type ReceiptAttempt = ReceiptAttemptFailure | ReceiptAttemptSuccess

class ValidationRaceError extends Error {}

export class FullScanResumeStore {
  readonly artifacts: PublicationArtifacts
  readonly descriptorPath: string
  readonly temporaryPath: string
  readonly directory: string
  readonly #onReceiptValidationStep: ((step: ResumeValidationStep) => void | Promise<void>) | undefined

  constructor(directory: string, options: FullScanResumeStoreOptions = {}) {
    this.directory = resolve(directory)
    this.artifacts = new PublicationArtifacts(this.directory)
    this.descriptorPath = join(this.directory, SCAN_RESUME_FILE)
    this.temporaryPath = `${this.descriptorPath}.tmp`
    this.#onReceiptValidationStep = options.onReceiptValidationStep
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
    const result = await readDescriptorSnapshot(this.descriptorPath)
    return result.kind === 'valid' ? result.snapshot.descriptor : undefined
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

  async load(expectedTarget?: string, receipt?: ResumeValidationReceipt): Promise<FullScanResumeLoad> {
    const timings = resumeValidationTimings()
    let attempted = false
    try {
      return await timings.total.measureAsync(async () => {
        if (receipt !== undefined) {
          const current = await this.#readDescriptor(timings, () => { attempted = true })
          if (current.kind === 'valid') {
            const attempt = await this.#tryReceipt(expectedTarget, current.snapshot, receipt)
            if ('load' in attempt) return attempt.load
            this.#recordReceiptFallback(attempt.reason)
          }
        }
        return this.#loadAuthoritative(expectedTarget, timings, () => { attempted = true })
      })
    } finally {
      if (attempted) for (const timing of Object.values(timings)) timing.publish()
    }
  }

  /** Validate the exact durable checkpoint acknowledged by a clean Pause. */
  async loadAcknowledgedCheckpoint(expectedTarget: string, checkpointSequence: number): Promise<FullScanResumeLoad> {
    const timings = resumeValidationTimings()
    let attempted = false
    try {
      return await timings.total.measureAsync(async () => {
        const current = await this.#readDescriptor(timings, () => { attempted = true })
        if (current.kind === 'valid') {
          const attempt = await this.#tryAcknowledgedCheckpoint(expectedTarget, checkpointSequence, current.snapshot)
          if ('load' in attempt) return attempt.load
          this.#recordReceiptFallback(attempt.reason)
        }
        return this.#loadAuthoritative(expectedTarget, timings, () => { attempted = true })
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

  async #readDescriptor(timings: ResumeValidationTimings, markAttempt: () => void): Promise<DescriptorRead> {
    return timings.descriptor.measureAsync(async () => {
      markAttempt()
      return readDescriptorSnapshot(this.descriptorPath)
    })
  }

  async #loadAuthoritative(expectedTarget: string | undefined, timings: ResumeValidationTimings, markAttempt: () => void, raceAttempt = 0): Promise<FullScanResumeLoad> {
    const current = await this.#readDescriptor(timings, markAttempt)
    if (current.kind === 'none') return { kind: 'none' }
    if (current.kind === 'invalid') return { kind: 'restart', reason: current.reason, ...(current.descriptor ? { descriptor: current.descriptor } : {}) }
    const { descriptor } = current.snapshot
    if (expectedTarget && normalize(resolve(expectedTarget)) !== descriptor.target) return { kind: 'restart', reason: 'saved-scan-target-mismatch', descriptor }

    try {
      return await this.#loadAuthoritativeOnce(expectedTarget, current.snapshot, timings)
    } catch (error) {
      if (!(error instanceof ValidationRaceError)) throw error
      if (raceAttempt >= 1) return { kind: 'restart', reason: 'validation-race', descriptor }
      return this.#loadAuthoritative(expectedTarget, timings, markAttempt, raceAttempt + 1)
    }
  }

  async #loadAuthoritativeOnce(_expectedTarget: string | undefined, snapshot: DescriptorSnapshot, timings: ResumeValidationTimings): Promise<FullScanResumeLoad> {
    const { descriptor, digest } = snapshot
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
      const valid = await timings.candidate.measureAsync(() => validateCandidate(candidatePath, descriptor, digest, this.descriptorPath, timings))
      if (valid) return candidateLoad(descriptor, digest, candidatePath, valid.drainedThrough, valid.stamp, 'full-validation')
      if (!partial) return { kind: 'restart', reason: 'invalid-finalized-candidate', descriptor }
    }
    if (!partial) return { kind: 'restart', reason: 'missing-resume-database', descriptor }

    if (await hasResumeDrainedThrough(partialPath)) {
      const valid = await timings.candidate.measureAsync(() => validateCandidate(partialPath, descriptor, digest, this.descriptorPath, timings))
      if (valid) {
        if (valid.journalPresent || valid.stamp.wal && valid.stamp.wal.size !== 0) {
          if (candidate) await this.artifacts.discardResumeCandidate(descriptor.scanId)
          return { kind: 'restart', reason: 'invalid-finalized-candidate', descriptor }
        }
        if (candidate) await this.artifacts.discardResumeCandidate(descriptor.scanId)
        await durablePromote(partialPath, candidatePath, this.directory)
        const promoted = await captureDatabaseFamily(candidatePath, descriptor.candidateFile)
        const leftoverSidecars = await Promise.all(SQLITE_SIDECAR_SUFFIXES.map((suffix) => fileObservation(`${partialPath}${suffix}`)))
        if (leftoverSidecars.some((observation) => observation.regular || observation.unsafe)
          || promoted.kind !== 'ok' || !promoted.stamp || !sameStampFields(valid.stamp, promoted.stamp)
          || promoted.journalPresent || promoted.stamp.wal && promoted.stamp.wal.size !== 0) {
          throw new ValidationRaceError('Candidate promotion changed the validated database family')
        }
        return candidateLoad(descriptor, digest, candidatePath, valid.drainedThrough, promoted.stamp, 'full-validation')
      }
      if (candidate) await this.artifacts.discardResumeCandidate(descriptor.scanId)
    }

    const valid = await timings.construction.measureAsync(() => validateConstruction(partialPath, descriptor, digest, this.descriptorPath, timings))
    if (!valid) return { kind: 'restart', reason: 'invalid-resume-database', descriptor }
    return {
      kind: 'construction', descriptor, partialPath, candidatePath,
      checkpointSequence: valid.checkpointSequence, checkpointedAt: valid.checkpointedAt,
      drainedThrough: valid.drainedThrough,
      receipt: makeReceipt(descriptor, digest, 'construction', valid.stamp, valid.drainedThrough, valid.checkpointSequence, 'full-validation')
    }
  }

  async #tryReceipt(expectedTarget: string | undefined, snapshot: DescriptorSnapshot, receipt: ResumeValidationReceipt): Promise<ReceiptAttempt> {
    const descriptor = snapshot.descriptor
    const shape = validateReceiptShape(receipt)
    if (!shape) return { reason: 'malformed-receipt' }
    if (receipt.descriptorDigest !== snapshot.digest) return { reason: 'descriptor-mismatch' }
    if (expectedTarget && normalize(resolve(expectedTarget)) !== descriptor.target) return { reason: 'target-mismatch' }

    const identityFailure = await receiptIdentityMismatch(this.directory, descriptor)
    if (identityFailure) return { reason: identityFailure }
    if (receipt.scanId !== descriptor.scanId) return { reason: 'resume-row-mismatch' }
    const expectedDatabaseFile = receipt.kind === 'construction' ? descriptor.partialFile : descriptor.candidateFile
    if (receipt.database.file !== expectedDatabaseFile) return { reason: 'artifact-presence-mismatch' }

    const paths = { partialPath: join(this.directory, descriptor.partialFile), candidatePath: join(this.directory, descriptor.candidateFile) }
    if (await receiptArtifactsMismatch(receipt.kind, paths.partialPath, paths.candidatePath)) return { reason: 'artifact-presence-mismatch' }

    const databasePath = receipt.kind === 'construction' ? paths.partialPath : paths.candidatePath
    const pre = await captureDatabaseFamily(databasePath, receipt.database.file)
    if (pre.kind === 'missing') return { reason: 'artifact-presence-mismatch' }
    if (pre.kind === 'invalid-sidecars') return { reason: pre.journalPresent ? 'unacknowledged-journal-state' : 'sidecar-stamp-mismatch' }
    if (!pre.stamp) return { reason: 'artifact-presence-mismatch' }
    if (!sameStampFields(pre.stamp, receipt.database)) return { reason: 'database-stamp-mismatch' }
    if (!sameSidecarFields(pre.stamp, receipt.database)) return { reason: 'sidecar-stamp-mismatch' }
    if (pre.journalPresent || receipt.source === 'acknowledged-pause' && pre.stamp.wal && pre.stamp.wal.size !== 0) return { reason: 'unacknowledged-journal-state' }

    await this.#receiptStep('pre-open')
    let query: ConstructionValidationQuery | CandidateValidationQuery
    let database: DatabaseSync | undefined
    try {
      database = openReadOnlyDatabase(databasePath, canOpenImmutable(pre))
      query = receipt.kind === 'construction'
        ? readConstructionReceiptQuery(database, descriptor, receipt)
        : readCandidateReceiptQuery(database, descriptor, receipt)
      await this.#receiptStep('post-query')
    } catch (error) {
      try { database?.close() } catch { /* The authoritative fallback owns failure handling. */ }
      return error instanceof ReceiptMismatchError ? { reason: error.reason } : { reason: 'sqlite-validation-failed' }
    }
    try { database.close() } catch { return { reason: 'sqlite-validation-failed' } }
    await this.#receiptStep('post-close')
    const post = await captureDatabaseFamily(databasePath, receipt.database.file)
    if (await receiptArtifactsMismatch(receipt.kind, paths.partialPath, paths.candidatePath)) return { reason: 'artifact-presence-mismatch' }
    if (post.kind === 'missing') return { reason: 'artifact-presence-mismatch' }
    if (post.kind === 'invalid-sidecars') return { reason: post.journalPresent ? 'unacknowledged-journal-state' : 'sidecar-stamp-mismatch' }
    if (!post.stamp) return { reason: 'artifact-presence-mismatch' }
    if (!sameStampFields(pre.stamp, post.stamp) || !sameStampFields(post.stamp, receipt.database)) return { reason: 'database-stamp-mismatch' }
    if (!sameSidecarFields(pre.stamp, post.stamp) || !sameSidecarFields(post.stamp, receipt.database)) return { reason: 'sidecar-stamp-mismatch' }
    if (post.journalPresent || receipt.source === 'acknowledged-pause' && post.stamp.wal && post.stamp.wal.size !== 0) return { reason: 'unacknowledged-journal-state' }
    if (!await descriptorDigestMatches(this.descriptorPath, snapshot)) return { reason: 'descriptor-mismatch' }
    const settledIdentityFailure = await receiptIdentityMismatch(this.directory, descriptor)
    if (settledIdentityFailure) return { reason: settledIdentityFailure }

    recordScanCounter('resumeReceiptValidations')
    if (query.kind === 'construction') return {
      load: {
        kind: 'construction', descriptor, partialPath: paths.partialPath, candidatePath: paths.candidatePath,
        checkpointSequence: query.checkpointSequence, checkpointedAt: query.checkpointedAt, drainedThrough: query.drainedThrough,
        receipt
      }
    }
    return { load: { kind: 'candidate', descriptor, candidatePath: paths.candidatePath, drainedThrough: query.drainedThrough, receipt } }
  }

  async #tryAcknowledgedCheckpoint(expectedTarget: string, checkpointSequence: number, snapshot: DescriptorSnapshot): Promise<ReceiptAttempt> {
    const descriptor = snapshot.descriptor
    if (!Number.isSafeInteger(checkpointSequence) || checkpointSequence < 0) return { reason: 'resume-row-mismatch' }
    if (normalize(resolve(expectedTarget)) !== descriptor.target) return { reason: 'target-mismatch' }
    const identityFailure = await receiptIdentityMismatch(this.directory, descriptor)
    if (identityFailure) return { reason: identityFailure }

    const partialPath = join(this.directory, descriptor.partialFile)
    const candidatePath = join(this.directory, descriptor.candidateFile)
    if (await receiptArtifactsMismatch('construction', partialPath, candidatePath)) return { reason: 'artifact-presence-mismatch' }
    const pre = await captureDatabaseFamily(partialPath, descriptor.partialFile)
    if (pre.kind === 'missing') return { reason: 'artifact-presence-mismatch' }
    if (pre.kind === 'invalid-sidecars') return { reason: pre.journalPresent ? 'unacknowledged-journal-state' : 'sidecar-stamp-mismatch' }
    if (!pre.stamp) return { reason: 'artifact-presence-mismatch' }
    if (pre.journalPresent || pre.stamp.wal && pre.stamp.wal.size !== 0) return { reason: 'unacknowledged-journal-state' }

    await this.#receiptStep('pre-open')
    let query: ConstructionValidationQuery
    let database: DatabaseSync | undefined
    try {
      database = openReadOnlyDatabase(partialPath, canOpenImmutable(pre))
      query = readConstructionReceiptQuery(database, descriptor, {
        version: 1, kind: 'construction', scanId: descriptor.scanId, descriptorDigest: snapshot.digest,
        checkpointSequence, drainedThrough: descriptor.journalBaseline, database: pre.stamp, source: 'acknowledged-pause'
      }, true)
      if (query.checkpointSequence !== checkpointSequence || query.phase !== 'paused') throw new ReceiptMismatchError('resume-row-mismatch')
      await this.#receiptStep('post-query')
    } catch (error) {
      try { database?.close() } catch { /* Authoritative fallback below. */ }
      return error instanceof ReceiptMismatchError ? { reason: error.reason } : { reason: 'sqlite-validation-failed' }
    }
    try { database.close() } catch { return { reason: 'sqlite-validation-failed' } }
    await this.#receiptStep('post-close')
    const post = await captureDatabaseFamily(partialPath, descriptor.partialFile)
    if (await receiptArtifactsMismatch('construction', partialPath, candidatePath)) return { reason: 'artifact-presence-mismatch' }
    if (post.kind === 'missing') return { reason: 'artifact-presence-mismatch' }
    if (post.kind === 'invalid-sidecars') return { reason: post.journalPresent ? 'unacknowledged-journal-state' : 'sidecar-stamp-mismatch' }
    if (!post.stamp) return { reason: 'artifact-presence-mismatch' }
    if (!sameStampFields(pre.stamp, post.stamp)) return { reason: 'database-stamp-mismatch' }
    if (!sameSidecarFields(pre.stamp, post.stamp)) return { reason: 'sidecar-stamp-mismatch' }
    if (post.journalPresent || post.stamp.wal && post.stamp.wal.size !== 0) return { reason: 'unacknowledged-journal-state' }
    if (!await descriptorDigestMatches(this.descriptorPath, snapshot)) return { reason: 'descriptor-mismatch' }
    const settledIdentityFailure = await receiptIdentityMismatch(this.directory, descriptor)
    if (settledIdentityFailure) return { reason: settledIdentityFailure }

    recordScanCounter('resumeReceiptValidations')
    return {
      load: {
        kind: 'construction', descriptor, partialPath, candidatePath,
        checkpointSequence: query.checkpointSequence, checkpointedAt: query.checkpointedAt,
        drainedThrough: query.drainedThrough,
        receipt: makeReceipt(descriptor, snapshot.digest, 'construction', post.stamp, query.drainedThrough, query.checkpointSequence, 'acknowledged-pause')
      }
    }
  }

  async #receiptStep(step: ResumeValidationStep): Promise<void> {
    await this.#onReceiptValidationStep?.(step)
  }

  #recordReceiptFallback(reason: ResumeReceiptFallbackReason): void {
    recordScanCounter('resumeReceiptFallbacks')
    publishResumeReceiptFallback(reason)
  }
}

class ReceiptMismatchError extends Error {
  constructor(readonly reason: ResumeReceiptFallbackReason) { super(reason) }
}

type ConstructionValidationQuery = {
  readonly kind: 'construction'
  readonly scanId: string
  readonly seed: string
  readonly phase: string
  readonly checkpointSequence: number
  readonly checkpointedAt: string
  readonly journalDevice: string
  readonly journalUuid: string
  readonly journalBaseline: string
  readonly drainedThrough: string
}

type CandidateValidationQuery = { readonly kind: 'candidate'; readonly drainedThrough: string }

function readConstructionReceiptQuery(database: DatabaseSync, descriptor: FullScanResumeDescriptor, receipt: ResumeValidationReceipt, acknowledged = false): ConstructionValidationQuery {
  const rows = database.prepare(`SELECT scan_id AS scanId, node_id_seed AS seed, phase, checkpoint_sequence AS checkpointSequence,
    checkpointed_at AS checkpointedAt, journal_device AS journalDevice, journal_uuid AS journalUuid,
    journal_baseline AS journalBaseline, drained_through AS drainedThrough FROM scan_run WHERE singleton = 1`).all() as unknown as Array<Record<string, unknown>>
  if (rows.length !== 1) throw new ReceiptMismatchError('resume-row-mismatch')
  const row = rows[0]!
  const checkpoint = safeInteger(row.checkpointSequence)
  if (row.scanId !== descriptor.scanId || typeof row.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(row.seed)
    || !isConstructionPhase(row.phase) || acknowledged && row.phase !== 'paused'
    || checkpoint === undefined || typeof row.checkpointedAt !== 'string' || !Number.isFinite(Date.parse(row.checkpointedAt))
    || row.journalDevice !== descriptor.journalDevice || row.journalUuid !== descriptor.journalUuid
    || row.journalBaseline !== descriptor.journalBaseline || !decimal(row.drainedThrough)
    || BigInt(row.drainedThrough) < BigInt(descriptor.journalBaseline)
    || !acknowledged && receipt.drainedThrough !== String(row.drainedThrough)
    || receipt.checkpointSequence !== undefined && receipt.checkpointSequence !== checkpoint
    || acknowledged && checkpoint !== receipt.checkpointSequence) throw new ReceiptMismatchError('resume-row-mismatch')
  return {
    kind: 'construction', scanId: String(row.scanId), seed: String(row.seed), phase: String(row.phase), checkpointSequence: checkpoint,
    checkpointedAt: String(row.checkpointedAt), journalDevice: String(row.journalDevice), journalUuid: String(row.journalUuid),
    journalBaseline: String(row.journalBaseline), drainedThrough: String(row.drainedThrough)
  }
}

function readCandidateReceiptQuery(database: DatabaseSync, descriptor: FullScanResumeDescriptor, receipt: ResumeValidationReceipt): CandidateValidationQuery {
  const constructionTables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name IN (${CONSTRUCTION_TABLES})`).get() as { count?: unknown }
  if (Number(constructionTables.count ?? 0) !== 0) throw new ReceiptMismatchError('candidate-metadata-mismatch')
  const values = metadataValues(database)
  const drainedThrough = validateCandidateMetadata(values, descriptor)
  if (!drainedThrough || drainedThrough !== receipt.drainedThrough) throw new ReceiptMismatchError('candidate-metadata-mismatch')
  return { kind: 'candidate', drainedThrough }
}

async function validateConstruction(path: string, descriptor: FullScanResumeDescriptor, digest: string, descriptorPath: string, timings: ResumeValidationTimings): Promise<ConstructionValidation | undefined> {
  const pre = await captureDatabaseFamily(path, descriptor.partialFile)
  if (pre.kind !== 'ok' || !pre.stamp) return undefined
  recordScanCounter('resumeFullValidations')
  let database: DatabaseSync | undefined
  let result: ConstructionValidation | undefined
  try {
    database = openReadOnlyDatabase(path, canOpenImmutable(pre))
    const integrity = timings.integrity.measure(() => database!.prepare('PRAGMA integrity_check').get() as { integrity_check?: string })
    const foreignKeys = timings.foreignKeys.measure(() => {
      database!.exec('PRAGMA foreign_keys=ON')
      return database!.prepare('PRAGMA foreign_key_check').all()
    })
    if (integrity.integrity_check !== 'ok' || foreignKeys.length > 0) return undefined
    const rows = database.prepare(`SELECT scan_id AS scanId, node_id_seed AS seed, phase, checkpoint_sequence AS checkpointSequence,
      checkpointed_at AS checkpointedAt, journal_device AS journalDevice, journal_uuid AS journalUuid,
      journal_baseline AS journalBaseline, drained_through AS drainedThrough FROM scan_run WHERE singleton = 1`).all() as unknown as Array<Record<string, unknown>>
    if (rows.length !== 1) return undefined
    const row = rows[0]!
    const checkpoint = safeInteger(row.checkpointSequence)
    if (row.scanId !== descriptor.scanId || typeof row.seed !== 'string' || !/^[0-9a-f]{64}$/u.test(row.seed)
      || row.journalDevice !== descriptor.journalDevice || row.journalUuid !== descriptor.journalUuid
      || row.journalBaseline !== descriptor.journalBaseline || checkpoint === undefined
      || typeof row.checkpointedAt !== 'string' || !Number.isFinite(Date.parse(row.checkpointedAt))
      || !isConstructionPhase(row.phase) || !decimal(row.drainedThrough) || BigInt(row.drainedThrough) < BigInt(descriptor.journalBaseline)) return undefined
    result = { stamp: pre.stamp, checkpointSequence: checkpoint, checkpointedAt: String(row.checkpointedAt), drainedThrough: String(row.drainedThrough) }
    return result
  } catch { return undefined }
  finally {
    try { database?.close() } catch { /* The settled stamp check below rejects a close race. */ }
    const post = await captureDatabaseFamily(path, descriptor.partialFile)
    if (result && (post.kind !== 'ok' || !post.stamp || !sameStampFields(pre.stamp, post.stamp) || !sameSidecarFields(pre.stamp, post.stamp) || pre.journalPresent !== post.journalPresent
      || !await descriptorDigestMatches(descriptorPath, { descriptor, digest }))) {
      throw new ValidationRaceError('Construction database or descriptor changed during validation')
    }
  }
}

async function validateCandidate(path: string, descriptor: FullScanResumeDescriptor, digest: string, descriptorPath: string, timings: ResumeValidationTimings): Promise<CandidateValidation | undefined> {
  const pre = await captureDatabaseFamily(path, basenameForKind(path, descriptor))
  if (pre.kind !== 'ok' || !pre.stamp) return undefined
  recordScanCounter('resumeFullValidations')
  let database: DatabaseSync | undefined
  let result: CandidateValidation | undefined
  try {
    database = openReadOnlyDatabase(path, canOpenImmutable(pre))
    const constructionTables = database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name IN (${CONSTRUCTION_TABLES})`).get() as { count?: number }
    if (Number(constructionTables.count ?? 0) !== 0) return undefined
    const integrity = timings.integrity.measure(() => database!.prepare('PRAGMA integrity_check').get() as { integrity_check?: string })
    const foreignKeys = timings.foreignKeys.measure(() => {
      database!.exec('PRAGMA foreign_keys=ON')
      return database!.prepare('PRAGMA foreign_key_check').all()
    })
    if (integrity.integrity_check !== 'ok' || foreignKeys.length > 0) return undefined
    const values = metadataValues(database)
    const drainedThrough = validateCandidateMetadata(values, descriptor)
    if (!drainedThrough) return undefined

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
    if (Number(invalidNodes.count) !== 0 || Number(roots.count) !== 1) return undefined
    const aliases = database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode, allocated_bytes AS bytes
      FROM hardlink_paths WHERE device <> '' AND inode <> ''`).all() as unknown as Array<{ parentId: string; name: string; pathKey: string; device: string; inode: string; bytes: number }>
    const owners = database.prepare(`SELECT groups.device, groups.inode, groups.owner_path_key AS pathKey, groups.allocated_bytes AS bytes,
      nodes.parent_id AS parentId, nodes.name FROM hardlink_groups groups JOIN nodes ON nodes.id = groups.node_id`).all() as unknown as Array<{ device: string; inode: string; pathKey: string; bytes: number; parentId: string; name: string }>
    const ownerByIdentity = new Map(owners.map((owner) => [`${owner.device}\0${owner.inode}`, owner]))
    const groups = new Map<string, typeof aliases>()
    for (const alias of aliases) { const key = `${alias.device}\0${alias.inode}`; const group = groups.get(key) ?? []; group.push(alias); groups.set(key, group) }
    if (ownerByIdentity.size !== groups.size) return undefined
    for (const [identity, group] of groups) {
      group.sort((left, right) => Buffer.compare(Buffer.from(left.pathKey, 'utf8'), Buffer.from(right.pathKey, 'utf8')))
      const alias = group[0]!
      const owner = ownerByIdentity.get(identity)
      if (!owner || owner.pathKey !== alias.pathKey || owner.parentId !== alias.parentId || owner.name !== alias.name || Number(owner.bytes) !== Number(alias.bytes)) return undefined
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
    if (values.rootId !== semantic.rootId || Number(values.scannedBytes) !== Number(semantic.bytes)
      || Number(totals.scannedItems) !== Number(semantic.items) || Number(totals.discoveredBytes) !== Number(semantic.bytes)
      || Number(totals.skippedItems) !== Number(semantic.skipped) || Number(totals.unreadableItems) !== Number(semantic.unreadable)
      || Number(totals.disappearingItems) !== Number(semantic.disappearing) || Number(totals.symlinks) !== Number(semantic.symlinks)
      || Number(totals.nestedMounts) !== Number(semantic.mounts) || Number(totals.duplicateHardLinks) !== Number(semantic.duplicates)
      || !Number.isFinite(elapsed) || elapsed < 0) return undefined
    result = { stamp: pre.stamp, drainedThrough, journalPresent: pre.journalPresent }
    return result
  } catch { return undefined }
  finally {
    try { database?.close() } catch { /* The caller's settled stamp check handles it. */ }
    const post = await captureDatabaseFamily(path, basenameForKind(path, descriptor))
    if (post.kind !== 'ok' || !post.stamp || !sameStampFields(pre.stamp, post.stamp) || !sameSidecarFields(pre.stamp, post.stamp) || pre.journalPresent !== post.journalPresent
      || !await descriptorDigestMatches(descriptorPath, { descriptor, digest })) {
      if (result) throw new ValidationRaceError('Candidate database or descriptor changed during validation')
    }
  }
}

function validateCandidateMetadata(values: Record<string, string>, descriptor: FullScanResumeDescriptor): string | undefined {
  if (values.target !== descriptor.target || values.targetDevice !== descriptor.targetDevice || values.targetInode !== descriptor.targetInode
    || values.indexDirectoryIdentity !== descriptor.indexDirectoryIdentity || values.schemaVersion !== String(descriptor.schemaVersion)
    || values.accountingVersion !== descriptor.accountingVersion || values.exclusionPolicyVersion !== descriptor.exclusionPolicyVersion
    || values.hardLinkOrderingVersion !== descriptor.hardLinkOrderingVersion) return undefined
  let dirtyScopes: unknown
  try { dirtyScopes = JSON.parse(values.resumeDirtyScopes ?? '[]') as unknown } catch { return undefined }
  if (!decimal(values.resumeDrainedThrough) || BigInt(values.resumeDrainedThrough) < BigInt(descriptor.journalBaseline)
    || !Array.isArray(dirtyScopes) || dirtyScopes.length > 1024
    || dirtyScopes.some((scope) => typeof scope !== 'string' || !isAbsolute(scope) || normalize(scope) !== scope || !withinTarget(scope, descriptor.target) || scope === descriptor.target)) return undefined
  return values.resumeDrainedThrough
}

function metadataValues(database: DatabaseSync): Record<string, string> {
  return Object.fromEntries((database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
}

function candidateLoad(descriptor: FullScanResumeDescriptor, digest: string, candidatePath: string, drainedThrough: string, stamp: DatabaseFamilyStamp, source: ResumeValidationReceipt['source']): FullScanResumeLoad {
  return { kind: 'candidate', descriptor, candidatePath, drainedThrough, receipt: makeReceipt(descriptor, digest, 'candidate', stamp, drainedThrough, undefined, source) }
}

function makeReceipt(
  descriptor: FullScanResumeDescriptor, digest: string, kind: ResumeValidationReceipt['kind'], stamp: DatabaseFamilyStamp,
  drainedThrough: string, checkpointSequence: number | undefined, source: ResumeValidationReceipt['source']
): ResumeValidationReceipt {
  return {
    version: 1, kind, scanId: descriptor.scanId, descriptorDigest: digest,
    ...(checkpointSequence === undefined ? {} : { checkpointSequence }), drainedThrough,
    database: stamp,
    source
  }
}

function validateReceiptShape(value: unknown): value is ResumeValidationReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const receipt = value as Partial<ResumeValidationReceipt>
  if (receipt.version !== 1 || receipt.kind !== 'construction' && receipt.kind !== 'candidate' || !isPublicationId(receipt.scanId)
    || typeof receipt.descriptorDigest !== 'string' || !RECEIPT_DIGEST.test(receipt.descriptorDigest)
    || !decimal(receipt.drainedThrough) || receipt.source !== 'acknowledged-pause' && receipt.source !== 'full-validation') return false
  if (receipt.source === 'acknowledged-pause' && (receipt.kind !== 'construction' || !safeInteger(receipt.checkpointSequence))) return false
  if (receipt.kind === 'candidate' && receipt.checkpointSequence !== undefined) return false
  const database = receipt.database
  if (!database || typeof database !== 'object' || Array.isArray(database) || typeof database.file !== 'string'
    || !isSafeStamp(database)) return false
  if (receipt.kind === 'construction' && !safeInteger(receipt.checkpointSequence)) return false
  if (receipt.kind === 'candidate' && receipt.checkpointSequence !== undefined) return false
  return Boolean((database.wal === undefined) === (database.shm === undefined))
}

function isSafeStamp(value: ResumeValidationReceipt['database']): boolean {
  if (!value || typeof value.file !== 'string' || value.file.includes('\0') || !isSafeStampFields(value)) return false
  if (value.wal !== undefined && !isSafeSidecar(value.wal) || value.shm !== undefined && !isSafeSidecar(value.shm)) return false
  return true
}

function isSafeStampFields(value: { readonly device: unknown; readonly inode: unknown; readonly size: unknown; readonly modifiedNs: unknown; readonly changedNs: unknown }): boolean {
  return decimal(value.device) && decimal(value.inode) && typeof value.size === 'number' && Number.isSafeInteger(value.size) && value.size >= 0
    && decimal(value.modifiedNs) && decimal(value.changedNs)
}

function isSafeSidecar(value: { readonly device: unknown; readonly inode: unknown; readonly size: unknown; readonly modifiedNs: unknown; readonly changedNs: unknown }): boolean {
  return isSafeStampFields(value)
}

function sameStampFields(left: FileStamp | ResumeValidationReceipt['database'], right: FileStamp | ResumeValidationReceipt['database']): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs
}

function sameSidecarFields(left: DatabaseFamilyStamp | ResumeValidationReceipt['database'], right: DatabaseFamilyStamp | ResumeValidationReceipt['database']): boolean {
  return sameOptionalStamp(left.wal, right.wal) && sameOptionalStamp(left.shm, right.shm)
}

function sameOptionalStamp(left: ResumeValidationReceipt['database']['wal'] | undefined, right: ResumeValidationReceipt['database']['wal'] | undefined): boolean {
  if (!left || !right) return left === right
  return sameStampFields(left, right)
}

function canOpenImmutable(snapshot: DatabaseFamilySnapshot): boolean {
  const stamp = snapshot.stamp
  return !snapshot.journalPresent && stamp !== undefined && (stamp.wal === undefined || stamp.wal.size === 0)
}

function openReadOnlyDatabase(path: string, immutable: boolean): DatabaseSync {
  const location = immutable ? `${pathToFileURL(path).href}?immutable=1` : path
  return new DatabaseSync(location, { readOnly: true })
}

async function captureDatabaseFamily(path: string, file: string): Promise<DatabaseFamilySnapshot> {
  const main = await inspectFile(path)
  if (main.kind !== 'regular' || !main.stamp) return { kind: 'missing', journalPresent: main.kind === 'unsafe' }
  const [journal, wal, shm] = await Promise.all([inspectFile(`${path}-journal`), inspectFile(`${path}-wal`), inspectFile(`${path}-shm`)]);
  const journalPresent = journal.kind !== 'absent'
  if (journal.kind === 'unsafe' || wal.kind === 'unsafe' || shm.kind === 'unsafe') return { kind: 'invalid-sidecars', journalPresent }
  if (wal.kind === 'regular' !== (shm.kind === 'regular')) return { kind: 'invalid-sidecars', journalPresent }
  return {
    kind: 'ok', journalPresent,
    stamp: {
      file, ...main.stamp,
      ...(wal.kind === 'regular' && wal.stamp ? { wal: wal.stamp } : {}),
      ...(shm.kind === 'regular' && shm.stamp ? { shm: shm.stamp } : {})
    }
  }
}

type FileObservation = { readonly kind: 'absent' | 'regular' | 'unsafe'; readonly regular: boolean; readonly unsafe: boolean; readonly stamp?: FileStamp }

async function fileObservation(path: string): Promise<FileObservation> { return inspectFile(path) }

async function receiptArtifactsMismatch(kind: ResumeValidationReceipt['kind'], partialPath: string, candidatePath: string): Promise<boolean> {
  const [partial, candidate, partialSidecars, candidateSidecars] = await Promise.all([
    fileObservation(partialPath), fileObservation(candidatePath),
    Promise.all(SQLITE_SIDECAR_SUFFIXES.map((suffix) => fileObservation(`${partialPath}${suffix}`))),
    Promise.all(SQLITE_SIDECAR_SUFFIXES.map((suffix) => fileObservation(`${candidatePath}${suffix}`)))
  ])
  const unexpectedSidecars = (kind === 'construction' ? candidateSidecars : partialSidecars).some((observation) => observation.regular || observation.unsafe)
  return unexpectedSidecars || (kind === 'construction'
    ? !partial.regular || candidate.regular || partial.unsafe || candidate.unsafe
    : !candidate.regular || partial.unsafe || candidate.unsafe)
}

async function inspectFile(path: string): Promise<FileObservation> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink()) return { kind: 'unsafe', regular: false, unsafe: true }
    const stamp = fileStamp(stats)
    return stamp ? { kind: 'regular', regular: true, unsafe: false, stamp } : { kind: 'unsafe', regular: false, unsafe: true }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'absent', regular: false, unsafe: false } : { kind: 'unsafe', regular: false, unsafe: true }
  }
}

function fileStamp(stats: { readonly dev: bigint; readonly ino: bigint; readonly size: bigint; readonly mtimeNs: bigint; readonly ctimeNs: bigint }): FileStamp | undefined {
  if (stats.size > MAX_SAFE_BIGINT) return undefined
  const fields = [stats.dev, stats.ino, stats.mtimeNs, stats.ctimeNs]
  if (fields.some((field) => typeof field !== 'bigint' || field < 0n)) return undefined
  return { device: String(stats.dev), inode: String(stats.ino), size: Number(stats.size), modifiedNs: String(stats.mtimeNs), changedNs: String(stats.ctimeNs) }
}

function basenameForKind(path: string, descriptor: FullScanResumeDescriptor): string {
  return path.endsWith(descriptor.candidateFile) ? descriptor.candidateFile : descriptor.partialFile
}

async function hasResumeDrainedThrough(path: string): Promise<boolean> {
  const snapshot = await captureDatabaseFamily(path, basename(path))
  if (snapshot.kind !== 'ok') return false
  let database: DatabaseSync | undefined
  try {
    database = openReadOnlyDatabase(path, canOpenImmutable(snapshot))
    return database.prepare(`SELECT 1 AS found FROM metadata WHERE key = 'resumeDrainedThrough'`).get() !== undefined
  } catch { return false }
  finally { try { database?.close() } catch { /* The authoritative validator performs the settled check. */ } }
}

async function durablePromote(partialPath: string, candidatePath: string, directoryPath: string): Promise<void> {
  const source = await captureDatabaseFamily(partialPath, basename(partialPath))
  if (source.kind !== 'ok' || !source.stamp || source.journalPresent || source.stamp.wal && source.stamp.wal.size !== 0) {
    throw new ValidationRaceError('Candidate promotion found live SQLite sidecars')
  }
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    await removeOptionalFile(`${candidatePath}${suffix}`)
    await removeOptionalFile(`${partialPath}${suffix}`)
  }
  const settledSource = await captureDatabaseFamily(partialPath, basename(partialPath))
  if (settledSource.kind !== 'ok' || !settledSource.stamp || settledSource.journalPresent || settledSource.stamp.wal && settledSource.stamp.wal.size !== 0
    || !sameStampFields(source.stamp, settledSource.stamp)) throw new ValidationRaceError('Candidate promotion changed before rename')
  const partial = await open(partialPath, 'r')
  try { await partial.sync() } finally { await partial.close() }
  await rename(partialPath, candidatePath)
  const directory = await open(directoryPath, 'r')
  try { await directory.sync() } finally { await directory.close() }
}

async function removeOptionalFile(path: string): Promise<void> {
  try { await unlink(path) } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
}

async function receiptIdentityMismatch(indexDirectory: string, descriptor: FullScanResumeDescriptor): Promise<ResumeReceiptFallbackReason | undefined> {
  const indexIdentity = await regularDirectoryIdentity(indexDirectory)
  if (!indexIdentity || indexIdentity !== descriptor.indexDirectoryIdentity) return 'index-directory-identity-mismatch'
  const targetIdentity = await regularDirectoryIdentity(descriptor.target)
  if (!targetIdentity || targetIdentity !== `${descriptor.targetDevice}:${descriptor.targetInode}`) return 'target-identity-mismatch'
  return undefined
}

async function descriptorDigestMatches(path: string, snapshot: DescriptorSnapshot): Promise<boolean> {
  const current = await readDescriptorSnapshot(path)
  return current.kind === 'valid' && current.snapshot.digest === snapshot.digest
}

async function readDescriptorSnapshot(path: string): Promise<DescriptorRead> {
  try {
    const stats = await lstat(path, { bigint: true })
    if (!stats.isFile() || stats.isSymbolicLink()) return { kind: 'invalid', reason: 'unsafe-resume-descriptor' }
    const bytes = await readFile(path)
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown } catch { return { kind: 'invalid', reason: 'unreadable-resume-descriptor' } }
    if (!isFullScanResumeDescriptor(raw)) return { kind: 'invalid', reason: 'incompatible-resume-descriptor' }
    return { kind: 'valid', snapshot: { descriptor: raw, digest: createHash('sha256').update(bytes).digest('hex') } }
  } catch (error) {
    return errorCode(error) === 'ENOENT' ? { kind: 'none' } : { kind: 'invalid', reason: 'unreadable-resume-descriptor' }
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
    const stats = await lstat(path, { bigint: true })
    return stats.isDirectory() && !stats.isSymbolicLink() ? `${String(stats.dev)}:${String(stats.ino)}` : undefined
  } catch { return undefined }
}

async function regularFile(path: string): Promise<boolean> {
  const observed = await inspectFile(path)
  return observed.regular
}

function isConstructionPhase(value: unknown): boolean {
  return value === 'scanning' || value === 'paused' || value === 'awaiting-reconciliation' || value === 'finalizing' || value === 'traversing'
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

function withinTarget(path: string, target: string): boolean { const remainder = relative(target, path); return path === target || remainder !== '' && remainder !== '..' && !remainder.startsWith(`..${sep}`) }
function decimal(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) }
function identity(value: unknown): value is string { return typeof value === 'string' && /^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u.test(value) }
function safeInteger(value: unknown): number | undefined {
  const number = typeof value === 'bigint' ? Number(value) : typeof value === 'number' ? value : typeof value === 'string' && decimal(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined
}
function errorCode(error: unknown): unknown { return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined }
