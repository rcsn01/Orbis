import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const PUBLICATION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const PUBLICATION_ID_PATTERN = new RegExp(`^${PUBLICATION_ID}$`, 'u')
const DATABASE_BASE_PATTERN = new RegExp(`^index-(${PUBLICATION_ID})(\\.partial)?\\.sqlite$`, 'u')
const DATABASE_ENTRY_PATTERN = new RegExp(`^index-(${PUBLICATION_ID})(?:\\.partial)?\\.sqlite(?:-(?:journal|wal|shm))?$`, 'u')
const STAGING_ENTRY_PATTERN = new RegExp(`^index-(${PUBLICATION_ID})(?:\\.partial)?\\.sqlite\\.staging-[0-9a-f]{16}(?:-(?:journal|wal|shm))?$`, 'u')
const RECONCILIATION_PATTERN = /^\.incremental-[A-Za-z0-9_-]+$/u
const SIDECARS = ['', '-journal', '-wal', '-shm'] as const
const queues = new Map<string, Promise<void>>()

interface RetentionLocator {
  readonly scanId: string
  readonly partialFile: string
  readonly candidateFile: string
}

export function isPublicationId(value: unknown): value is string {
  return typeof value === 'string' && PUBLICATION_ID_PATTERN.test(value)
}

export function publicationDatabaseFiles(publicationId: string): { readonly partialFile: string; readonly candidateFile: string } {
  if (!isPublicationId(publicationId)) throw new Error('Invalid Orbis publication ID')
  return { partialFile: `index-${publicationId}.partial.sqlite`, candidateFile: `index-${publicationId}.sqlite` }
}

export function publicationIdFromDatabaseFile(file: string, partial: boolean): string | undefined {
  const match = DATABASE_BASE_PATTERN.exec(file)
  return match && Boolean(match[2]) === partial ? match[1] : undefined
}

export interface PublicationArtifactOptions {
  /** Internal seam used by deterministic filesystem-failure tests. */
  readonly remove?: (path: string, recursive: boolean) => Promise<void>
}

export interface ArtifactReconcileOptions {
  /** Additional live publications to preserve if disk metadata is not yet durable. */
  readonly retain?: readonly string[]
}

/**
 * Owns classification, retention, and deletion for publication-owned artifacts
 * under one private indexes directory.
 */
export class PublicationArtifacts {
  readonly directory: string
  readonly manifestPath: string
  readonly resumePath: string
  readonly #remove: (path: string, recursive: boolean) => Promise<void>

  constructor(directory: string, options: PublicationArtifactOptions = {}) {
    this.directory = resolve(directory)
    this.#remove = options.remove ?? ((path, recursive) => rm(path, { force: true, ...(recursive ? { recursive: true } : {}) }))
    this.manifestPath = join(this.directory, 'current.json')
    this.resumePath = join(this.directory, 'scan-resume.json')
  }

  async reconcile(options: ArtifactReconcileOptions = {}): Promise<void> {
    await this.#serialized(async () => {
      if (!await safeDirectory(this.directory)) return
      const retention = await this.#retention(options.retain)
      const entries = await readdir(this.directory, { withFileTypes: true })
      const entriesToUnlink: string[] = []
      const directoriesToRemove: string[] = []
      for (const entry of entries) {
        const unlinkable = entry.isFile() || entry.isSymbolicLink()
        if ((entry.name === 'current.json.tmp' || entry.name === 'scan-resume.json.tmp' || entry.name === 'locations.json.tmp' || entry.name === 'scan-diagnostics.json.tmp') && unlinkable) {
          entriesToUnlink.push(join(this.directory, entry.name))
          continue
        }
        if (DATABASE_ENTRY_PATTERN.test(entry.name) && unlinkable) {
          const base = databaseBase(entry.name)
          if (base && !retention.has(base)) entriesToUnlink.push(join(this.directory, entry.name))
          continue
        }
        if (STAGING_ENTRY_PATTERN.test(entry.name) && unlinkable) {
          entriesToUnlink.push(join(this.directory, entry.name))
          continue
        }
        if (RECONCILIATION_PATTERN.test(entry.name)) {
          if (entry.isSymbolicLink()) entriesToUnlink.push(join(this.directory, entry.name))
          else if (entry.isDirectory()) directoriesToRemove.push(join(this.directory, entry.name))
        }
      }
      const results = await Promise.allSettled([
        this.#removeEntries(entriesToUnlink),
        this.#removeEntries(directoriesToRemove, true)
      ])
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, 'Failed to reconcile publication-owned artifacts')
    })
  }

  async discardUnreferencedDatabase(path: string, options: ArtifactReconcileOptions = {}): Promise<boolean> {
    return this.#serialized(async () => {
      const owned = this.#ownedDatabase(path)
      if (!owned || !await safeDirectory(this.directory)) return false
      const retention = await this.#retention(options.retain)
      if (retention.has(owned.name) || !await eligibleDatabaseBase(owned.path)) return false
      await this.#removeDatabaseFamily(owned.path)
      return true
    })
  }

  async recoverResume(scanId: string): Promise<boolean> {
    return this.#serialized(async () => {
      if (!isPublicationId(scanId) || !await safeDirectory(this.directory)) return false
      const locator = await readResumeLocator(this.resumePath)
      if (!locator || locator.scanId !== scanId) return false
      const entries = await readdir(this.directory)
      const prefixes = [`${locator.partialFile}.staging-`, `${locator.candidateFile}.staging-`]
      const paths = entries
        .filter((name) => STAGING_ENTRY_PATTERN.test(name) && prefixes.some((prefix) => name.startsWith(prefix)))
        .map((name) => join(this.directory, name))
      await this.#removeEntries(paths)
      return true
    })
  }

  async discardResumeCandidate(scanId: string): Promise<boolean> {
    return this.#serialized(async () => {
      if (!isPublicationId(scanId) || !await safeDirectory(this.directory)) return false
      const locator = await readResumeLocator(this.resumePath)
      if (!locator || locator.scanId !== scanId) return false
      const retention = await this.#publishedRetention()
      if (retention.has(locator.candidateFile)) return false
      await this.#removeDatabaseFamily(join(this.directory, locator.candidateFile))
      return true
    })
  }

  async removeManifestMetadata(): Promise<void> {
    await this.#serialized(() => this.#removeEntries([this.manifestPath, `${this.manifestPath}.tmp`]))
  }

  async removeResumeMetadata(): Promise<void> {
    await this.#serialized(() => this.#removeEntries([this.resumePath, `${this.resumePath}.tmp`]))
  }

  async completeResume(scanId: string): Promise<boolean> {
    return this.#serialized(async () => {
      if (!isPublicationId(scanId) || !await safeDirectory(this.directory)) return false
      const locator = await readResumeLocator(this.resumePath)
      if (!locator || locator.scanId !== scanId) return false
      await this.#removeDatabaseFamily(join(this.directory, locator.partialFile))
      const current = await readResumeLocator(this.resumePath)
      if (current?.scanId === scanId) await this.#removeEntries([this.resumePath])
      await this.#removeEntries([`${this.resumePath}.tmp`])
      return true
    })
  }

  async discardResume(expectedScanId?: string): Promise<boolean> {
    return this.#serialized(async () => {
      if (!await safeDirectory(this.directory) || expectedScanId !== undefined && !isPublicationId(expectedScanId)) return false
      const locator = await readResumeLocator(this.resumePath)
      if (!locator || expectedScanId !== undefined && locator.scanId !== expectedScanId) return false
      const retention = await this.#publishedRetention()
      await this.#removeDatabaseFamily(join(this.directory, locator.partialFile))
      if (!retention.has(locator.candidateFile)) await this.#removeDatabaseFamily(join(this.directory, locator.candidateFile))
      const current = await readResumeLocator(this.resumePath)
      if (current?.scanId === locator.scanId) await this.#removeEntries([this.resumePath])
      await this.#removeEntries([`${this.resumePath}.tmp`])
      return true
    })
  }

  async #publishedRetention(): Promise<Set<string>> {
    const [current, catalog] = await Promise.all([
      readCurrentIndexLocator(this.manifestPath),
      readCatalogIndexLocators(join(this.directory, 'locations.json'), false)
    ])
    const retained = new Set<string>(catalog)
    if (current) retained.add(current)
    return retained
  }

  async #retention(extra: readonly string[] | undefined): Promise<Set<string>> {
    const [published, resume, pending] = await Promise.all([
      this.#publishedRetention(),
      readResumeLocator(this.resumePath),
      readCatalogIndexLocators(join(this.directory, 'locations.json'), true)
    ])
    for (const file of pending) published.add(file)
    if (resume) { published.add(resume.partialFile); published.add(resume.candidateFile) }
    for (const value of extra ?? []) {
      const name = retainedDatabaseName(value, this.directory)
      if (name) published.add(name)
    }
    return published
  }

  #ownedDatabase(path: string): { readonly name: string; readonly path: string } | undefined {
    if (typeof path !== 'string' || path.includes('\0')) return undefined
    const absolute = resolve(path)
    const name = basename(absolute)
    if (!DATABASE_BASE_PATTERN.test(name) || relative(this.directory, absolute) !== name) return undefined
    return { name, path: absolute }
  }

  async #removeDatabaseFamily(path: string): Promise<void> {
    if (!await eligibleDatabaseBase(path)) throw new Error(`Refusing to remove unsafe publication artifact: ${path}`)
    await this.#removeEntries(SIDECARS.map((suffix) => `${path}${suffix}`))
  }

  async #removeEntries(paths: readonly string[], recursive = false): Promise<void> {
    const unique = [...new Set(paths)]
    const results = await Promise.allSettled(unique.map((path) => this.#remove(path, recursive)))
    const failures = results.flatMap((result, index) => result.status === 'rejected' ? [{ path: unique[index]!, reason: result.reason }] : [])
    if (failures.length > 0) throw new AggregateError(failures.map((failure) => failure.reason), `Failed to remove publication-owned artifacts: ${failures.map((failure) => failure.path).join(', ')}`)
  }

  #serialized<T>(operation: () => Promise<T>): Promise<T> {
    return serialize(this.directory, operation)
  }
}

function retainedDatabaseName(value: string, directory: string): string | undefined {
  if (typeof value !== 'string' || value.includes('\0')) return undefined
  if (!isAbsolute(value)) return !value.includes(sep) && DATABASE_BASE_PATTERN.test(value) ? value : undefined
  const absolute = resolve(value)
  const name = basename(absolute)
  return relative(directory, absolute) === name && DATABASE_BASE_PATTERN.test(name) ? name : undefined
}

function databaseBase(name: string): string | undefined {
  const base = name.replace(/-(?:journal|wal|shm)$/u, '')
  return DATABASE_BASE_PATTERN.test(base) ? base : undefined
}

async function readCurrentIndexLocator(path: string): Promise<string | undefined> {
  const value = await readRegularJson(path)
  if (!value || !isPublicationId(value.publicationId)) return undefined
  const expected = `index-${value.publicationId}.sqlite`
  return value.indexFile === expected ? expected : undefined
}

async function readCatalogIndexLocators(path: string, includePending: boolean): Promise<readonly string[]> {
  const value = await readRegularJson(path)
  if (!value || value.version !== 1 || !Array.isArray(value.publications)) return []
  const retained = new Set<string>()
  for (const candidate of value.publications) {
    if (!candidate || typeof candidate !== 'object') continue
    const record = candidate as Record<string, unknown>
    if (!isPublicationId(record.publicationId)) continue
    const expected = `index-${record.publicationId}.sqlite`
    if (record.indexFile === expected) retained.add(expected)
  }
  if (includePending && value.pendingScan && typeof value.pendingScan === 'object') {
    const scanId = (value.pendingScan as Record<string, unknown>).scanId
    if (isPublicationId(scanId)) {
      const files = publicationDatabaseFiles(scanId)
      retained.add(files.partialFile)
      retained.add(files.candidateFile)
    }
  }
  return [...retained]
}

async function readResumeLocator(path: string): Promise<RetentionLocator | undefined> {
  const value = await readRegularJson(path)
  if (!value || !isPublicationId(value.scanId)) return undefined
  const { partialFile, candidateFile } = publicationDatabaseFiles(value.scanId)
  return value.partialFile === partialFile && value.candidateFile === candidateFile
    ? { scanId: value.scanId, partialFile, candidateFile }
    : undefined
}

async function readRegularJson(path: string): Promise<Record<string, unknown> | undefined> {
  let stats
  try { stats = await lstat(path) }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error }
  if (!stats.isFile() || stats.isSymbolicLink()) return undefined
  const source = await readFile(path, 'utf8')
  try {
    const value = JSON.parse(source) as unknown
    return value && typeof value === 'object' ? value as Record<string, unknown> : undefined
  } catch { return undefined }
}

async function eligibleDatabaseBase(path: string): Promise<boolean> {
  try { const stats = await lstat(path); return stats.isFile() || stats.isSymbolicLink() }
  catch (error) { if (errorCode(error) === 'ENOENT') return true; throw error }
}

async function safeDirectory(path: string): Promise<boolean> {
  try { const stats = await lstat(path); return stats.isDirectory() && !stats.isSymbolicLink() }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error }
}

async function serialize<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve()
  let resolveTail!: () => void
  const tail = new Promise<void>((resolvePromise) => { resolveTail = resolvePromise })
  const queued = previous.catch(() => undefined).then(() => tail)
  queues.set(directory, queued)
  await previous.catch(() => undefined)
  try { return await operation() }
  finally {
    resolveTail()
    if (queues.get(directory) === queued) queues.delete(directory)
  }
}

function errorCode(error: unknown): unknown {
  return error && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined
}
