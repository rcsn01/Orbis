import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PublicationArtifacts } from '../src/main/publication-artifacts'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

const activeId = '01234567-89ab-4cde-8fab-0123456789ab'
const resumeId = '11234567-89ab-4cde-8fab-0123456789ab'
const extraId = '21234567-89ab-4cde-8fab-0123456789ab'
const orphanId = '31234567-89ab-4cde-8fab-0123456789ab'

async function fixture(name: string): Promise<{ readonly root: string; readonly indexes: string; readonly artifacts: PublicationArtifacts }> {
  const root = await mkdtemp(join(tmpdir(), `orbis-artifacts-${name}-`))
  cleanup.push(root)
  const indexes = join(root, 'indexes')
  await mkdir(indexes, { mode: 0o700 })
  return { root, indexes, artifacts: new PublicationArtifacts(indexes) }
}

function database(indexes: string, id: string, partial = false): string {
  return join(indexes, `index-${id}${partial ? '.partial' : ''}.sqlite`)
}

async function expectMissing(path: string): Promise<void> { await expect(access(path)).rejects.toThrow() }

describe('PublicationArtifacts', () => {
  it('reconciles one grammar while preserving manifest, resume, extra, and unrelated entries', async () => {
    const { indexes, artifacts } = await fixture('reconcile')
    const active = database(indexes, activeId)
    const partial = database(indexes, resumeId, true)
    const candidate = database(indexes, resumeId)
    const extra = database(indexes, extraId)
    const orphan = database(indexes, orphanId)
    for (const path of [active, partial, candidate, extra, orphan, `${orphan}-wal`]) await writeFile(path, 'data')
    await writeFile(join(indexes, 'current.json'), `${JSON.stringify({ publicationId: activeId, indexFile: `index-${activeId}.sqlite` })}\n`)
    await writeFile(join(indexes, 'scan-resume.json'), `${JSON.stringify({ scanId: resumeId, partialFile: `index-${resumeId}.partial.sqlite`, candidateFile: `index-${resumeId}.sqlite` })}\n`)
    const staging = `${partial}.staging-0123456789abcdef`
    await writeFile(staging, 'staging')
    await writeFile(`${staging}-journal`, 'journal')
    await writeFile(join(indexes, 'current.json.tmp'), 'temporary')
    await writeFile(join(indexes, 'scan-resume.json.tmp'), 'temporary')
    const reconciliation = join(indexes, '.incremental-abandoned')
    await mkdir(reconciliation)
    await writeFile(join(reconciliation, 'candidate.sqlite'), 'candidate')
    const unrelated = join(indexes, 'keep.txt')
    await writeFile(unrelated, 'keep')

    await artifacts.reconcile({ retain: [extra] })

    for (const path of [active, partial, candidate, extra, unrelated]) await expect(access(path)).resolves.toBeUndefined()
    for (const path of [orphan, `${orphan}-wal`, staging, `${staging}-journal`, reconciliation, join(indexes, 'current.json.tmp'), join(indexes, 'scan-resume.json.tmp')]) await expectMissing(path)
  })

  it('preserves directories that only resemble database or metadata files', async () => {
    const { indexes, artifacts } = await fixture('lookalike-directories')
    const databaseDirectory = database(indexes, orphanId)
    const metadataDirectory = join(indexes, 'current.json.tmp')
    await mkdir(databaseDirectory)
    await writeFile(join(databaseDirectory, 'unrelated.txt'), 'keep')
    await mkdir(metadataDirectory)
    await writeFile(join(metadataDirectory, 'unrelated.txt'), 'keep')

    await artifacts.reconcile()

    await expect(access(join(databaseDirectory, 'unrelated.txt'))).resolves.toBeUndefined()
    await expect(access(join(metadataDirectory, 'unrelated.txt'))).resolves.toBeUndefined()
    await expect(artifacts.discardUnreferencedDatabase(databaseDirectory)).resolves.toBe(false)
  })

  it('unlinks an eligible symlink without following its target', async () => {
    const { root, indexes, artifacts } = await fixture('symlink')
    const target = join(root, 'outside.sqlite')
    await writeFile(target, 'outside')
    const link = database(indexes, orphanId)
    await symlink(target, link)

    await artifacts.reconcile()

    await expectMissing(link)
    expect(await readFile(target, 'utf8')).toBe('outside')
  })

  it('discards only direct unreferenced database families', async () => {
    const { root, indexes, artifacts } = await fixture('discard')
    const orphan = database(indexes, orphanId)
    for (const suffix of ['', '-journal', '-wal', '-shm']) await writeFile(`${orphan}${suffix}`, suffix)
    await expect(artifacts.discardUnreferencedDatabase(orphan)).resolves.toBe(true)
    for (const suffix of ['', '-journal', '-wal', '-shm']) await expectMissing(`${orphan}${suffix}`)

    const outside = database(root, extraId)
    await writeFile(outside, 'outside')
    await expect(artifacts.discardUnreferencedDatabase(outside)).resolves.toBe(false)
    await expect(access(outside)).resolves.toBeUndefined()

    const unrelated = join(indexes, 'keep.sqlite')
    await writeFile(unrelated, 'keep')
    await expect(artifacts.discardUnreferencedDatabase(unrelated)).resolves.toBe(false)
    await expect(access(unrelated)).resolves.toBeUndefined()
  })

  it('rereads retention before discarding a database', async () => {
    const { indexes, artifacts } = await fixture('retention')
    const active = database(indexes, activeId)
    const partial = database(indexes, resumeId, true)
    await writeFile(active, 'active')
    await writeFile(partial, 'partial')
    await writeFile(join(indexes, 'current.json'), `${JSON.stringify({ publicationId: activeId, indexFile: `index-${activeId}.sqlite` })}\n`)
    await writeFile(join(indexes, 'scan-resume.json'), `${JSON.stringify({ scanId: resumeId, partialFile: `index-${resumeId}.partial.sqlite`, candidateFile: `index-${resumeId}.sqlite` })}\n`)

    await expect(artifacts.discardUnreferencedDatabase(active)).resolves.toBe(false)
    await expect(artifacts.discardUnreferencedDatabase(partial)).resolves.toBe(false)
    await expect(artifacts.discardUnreferencedDatabase(database(indexes, extraId), { retain: [`index-${extraId}.sqlite`] })).resolves.toBe(false)
    await expect(access(active)).resolves.toBeUndefined()
    await expect(access(partial)).resolves.toBeUndefined()
  })

  it('completes resume by removing construction before its descriptor', async () => {
    const { indexes, artifacts } = await fixture('complete')
    const partial = database(indexes, resumeId, true)
    const candidate = database(indexes, resumeId)
    await writeFile(partial, 'partial')
    await writeFile(`${partial}-journal`, 'journal')
    await writeFile(candidate, 'candidate')
    await writeFile(join(indexes, 'scan-resume.json'), `${JSON.stringify({ scanId: resumeId, partialFile: `index-${resumeId}.partial.sqlite`, candidateFile: `index-${resumeId}.sqlite` })}\n`)

    await expect(artifacts.completeResume(resumeId)).resolves.toBe(true)

    await expectMissing(partial)
    await expectMissing(`${partial}-journal`)
    await expectMissing(join(indexes, 'scan-resume.json'))
    await expect(access(candidate)).resolves.toBeUndefined()
  })

  it('discards resume files but preserves a candidate named by the current manifest', async () => {
    const { indexes, artifacts } = await fixture('resume-discard')
    const partial = database(indexes, resumeId, true)
    const candidate = database(indexes, resumeId)
    await writeFile(partial, 'partial')
    await writeFile(candidate, 'candidate')
    await writeFile(join(indexes, 'scan-resume.json'), `${JSON.stringify({ scanId: resumeId, partialFile: `index-${resumeId}.partial.sqlite`, candidateFile: `index-${resumeId}.sqlite` })}\n`)
    await writeFile(join(indexes, 'current.json'), `${JSON.stringify({ publicationId: resumeId, indexFile: `index-${resumeId}.sqlite` })}\n`)

    await expect(artifacts.discardResume(resumeId)).resolves.toBe(true)

    await expectMissing(partial)
    await expect(access(candidate)).resolves.toBeUndefined()
    await expectMissing(join(indexes, 'scan-resume.json'))
  })

  it('attempts the whole family and reports partial deletion failures', async () => {
    const { indexes } = await fixture('failure')
    const candidate = database(indexes, orphanId)
    for (const suffix of ['', '-journal', '-wal', '-shm']) await writeFile(`${candidate}${suffix}`, suffix)
    const attempted: string[] = []
    const artifacts = new PublicationArtifacts(indexes, { remove: async (path, recursive) => {
      attempted.push(path)
      if (path.endsWith('-wal')) throw new Error('injected removal failure')
      await rm(path, { force: true, ...(recursive ? { recursive: true } : {}) })
    } })

    await expect(artifacts.discardUnreferencedDatabase(candidate)).rejects.toBeInstanceOf(AggregateError)

    expect(attempted).toHaveLength(4)
    await expectMissing(candidate)
    await expectMissing(`${candidate}-journal`)
    await expect(access(`${candidate}-wal`)).resolves.toBeUndefined()
    await expectMissing(`${candidate}-shm`)
  })

  it('serializes cleanup mutations for the same canonical directory', async () => {
    const { indexes } = await fixture('serialization')
    const first = database(indexes, orphanId)
    const second = database(indexes, extraId)
    await writeFile(first, 'first')
    await writeFile(second, 'second')
    const attempted: string[] = []
    const artifacts = new PublicationArtifacts(indexes, { remove: async (path, recursive) => {
      attempted.push(path.includes(orphanId) ? 'first' : 'second')
      await new Promise((resolve) => setTimeout(resolve, 2))
      await rm(path, { force: true, ...(recursive ? { recursive: true } : {}) })
    } })

    await Promise.all([
      artifacts.discardUnreferencedDatabase(first),
      artifacts.discardUnreferencedDatabase(second)
    ])

    expect(attempted).toEqual(['first', 'first', 'first', 'first', 'second', 'second', 'second', 'second'])
  })

  it('removes only staging families for the matching saved scan', async () => {
    const { indexes, artifacts } = await fixture('recover')
    const partial = database(indexes, resumeId, true)
    const staging = `${partial}.staging-0123456789abcdef`
    const other = `${database(indexes, orphanId, true)}.staging-0123456789abcdef`
    await writeFile(staging, 'staging')
    await writeFile(`${staging}-shm`, 'sidecar')
    await writeFile(other, 'other')
    await writeFile(join(indexes, 'scan-resume.json'), `${JSON.stringify({ scanId: resumeId, partialFile: `index-${resumeId}.partial.sqlite`, candidateFile: `index-${resumeId}.sqlite` })}\n`)

    await expect(artifacts.recoverResume(resumeId)).resolves.toBe(true)

    await expectMissing(staging)
    await expectMissing(`${staging}-shm`)
    await expect(access(other)).resolves.toBeUndefined()
  })
})
