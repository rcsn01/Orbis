import { chmod, lstat, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join, normalize } from 'node:path'
import { isPublicationId, PublicationArtifacts, publicationDatabaseFiles } from './publication-artifacts'

export const PERSISTENT_INDEX_SCHEMA_VERSION = 3
export const PERSISTENT_ACCOUNTING_VERSION = 'allocated-blocks-512-v1'
export const HARD_LINK_ORDERING_VERSION = 'binary-relative-path-v1'
export const EXCLUSION_POLICY_VERSION = 'startup-and-index-root-v1'

export interface JournalCursor {
  readonly uuid: string
  readonly eventId: string
}

export interface IndexManifest {
  readonly version: 1
  readonly publicationId: string
  readonly indexFile: string
  readonly target: string
  readonly targetDevice: string
  readonly targetInode: string
  readonly schemaVersion: number
  readonly indexRevision: number
  readonly journal: JournalCursor | null
}

export interface IndexCandidatePaths {
  readonly partialPath: string
  readonly indexPath: string
}

export class IndexManifestStore {
  readonly artifacts: PublicationArtifacts
  readonly manifestPath: string
  lastPublicationDurable = true
  readonly temporaryManifestPath: string

  constructor(readonly directory: string) {
    this.artifacts = new PublicationArtifacts(directory)
    this.manifestPath = join(directory, 'current.json')
    this.temporaryManifestPath = join(directory, 'current.json.tmp')
  }

  async initialize(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    await this.artifacts.reconcile()
  }

  paths(publicationId: string): IndexCandidatePaths {
    const { partialFile, candidateFile } = publicationDatabaseFiles(publicationId)
    return { partialPath: join(this.directory, partialFile), indexPath: join(this.directory, candidateFile) }
  }

  async load(): Promise<IndexManifest | undefined> {
    try {
      const stats = await lstat(this.manifestPath)
      if (!stats.isFile() || stats.isSymbolicLink()) return undefined
      const parsed = JSON.parse(await readFile(this.manifestPath, 'utf8')) as unknown
      return isIndexManifest(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  async publish(manifest: IndexManifest): Promise<void> {
    if (!isIndexManifest(manifest)) throw new Error('Invalid Orbis index manifest')
    await writeFile(this.temporaryManifestPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', mode: 0o600 })
    await chmod(this.temporaryManifestPath, 0o600)
    const file = await open(this.temporaryManifestPath, 'r')
    try { await file.sync() } finally { await file.close() }
    this.lastPublicationDurable = false
    await rename(this.temporaryManifestPath, this.manifestPath)
    // The rename is the commit point. A later directory-sync error must not
    // make callers delete the candidate now referenced by current.json. Keep
    // the previous index as a recovery artifact until a directory sync succeeds.
    try {
      await syncDirectory(this.directory)
      this.lastPublicationDurable = true
    } catch { /* The controller preserves both possible recovery publications. */ }
  }

  async cleanup(activeIndexFile?: string): Promise<void> {
    await this.artifacts.reconcile(activeIndexFile ? { retain: [activeIndexFile] } : undefined)
  }
}

export function isIndexManifest(value: unknown): value is IndexManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<IndexManifest>
  if (manifest.version !== 1 || !isPublicationId(manifest.publicationId)) return false
  if (manifest.indexFile !== `index-${manifest.publicationId}.sqlite`) return false
  if (typeof manifest.target !== 'string' || !isAbsolute(manifest.target) || normalize(manifest.target) !== manifest.target || manifest.target.includes('\u0000')) return false
  if (!decimal(manifest.targetDevice) || !decimal(manifest.targetInode)) return false
  if (manifest.schemaVersion !== PERSISTENT_INDEX_SCHEMA_VERSION || !positiveInteger(manifest.indexRevision)) return false
  if (manifest.journal === null) return true
  return !!manifest.journal && typeof manifest.journal === 'object' && typeof manifest.journal.uuid === 'string' && manifest.journal.uuid.length > 0 && decimal(manifest.journal.eventId)
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
