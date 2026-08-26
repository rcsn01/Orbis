import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FSEVENT_FLAGS, type ChangeEvent } from '../src/main/change-journal'
import { planDirtyScopes } from '../src/main/incremental-scanner'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('Orbis dirty-scope planning', () => {
  it('coalesces nested file changes into exact parent subtrees', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    await mkdir(join(target, 'a', 'nested'), { recursive: true })
    await writeFile(join(target, 'a', 'one'), 'one')
    await writeFile(join(target, 'a', 'nested', 'two'), 'two')
    const plan = await planDirtyScopes({
      target,
      indexDirectory: join(directory, 'indexes'),
      events: [event('a/one', FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile), event('a/nested/two', FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile)]
    })
    expect(plan).toEqual({ kind: 'incremental', scopes: [join(target, 'a')] })
  })

  it('treats a created flag on an unchanged indexed directory as recursive coalescing', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    const child = join(target, 'a')
    await mkdir(join(child, 'nested'), { recursive: true })
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(child))
    const plan = await planDirtyScopes({
      target,
      indexDirectory: join(directory, 'indexes'),
      events: [event('a', FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemIsDir), event('a/nested/file', FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile)],
      lookupIdentity: (path) => path === child ? { device: String(stats.dev), inode: String(stats.ino) } : undefined
    })
    expect(plan).toEqual({ kind: 'incremental', scopes: [child] })
  })

  it('ignores stable ancestor noise caused only by the excluded index directory', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    const state = join(target, 'state')
    const indexDirectory = join(state, 'indexes')
    await mkdir(indexDirectory, { recursive: true })
    await writeFile(join(indexDirectory, 'candidate.sqlite'), 'index')
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(state))
    const plan = await planDirtyScopes({
      target,
      indexDirectory,
      events: [
        event('', FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemIsDir),
        event('state', FSEVENT_FLAGS.itemCreated | FSEVENT_FLAGS.itemIsDir),
        event('state/indexes/candidate.sqlite', FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile)
      ],
      lookupIdentity: (path) => path === state ? { device: String(stats.dev), inode: String(stats.ino) } : undefined
    })
    expect(plan).toEqual({ kind: 'incremental', scopes: [] })
  })

  it('does not ignore a recursive root event alongside excluded index noise', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    const indexDirectory = join(target, 'indexes')
    await mkdir(indexDirectory, { recursive: true })
    expect(await planDirtyScopes({
      target, indexDirectory,
      events: [
        event('', FSEVENT_FLAGS.mustScanSubDirs | FSEVENT_FLAGS.itemIsDir),
        event('indexes/candidate.sqlite', FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile)
      ]
    })).toEqual({ kind: 'full', reason: 'target-root-recursive' })
  })

  it('falls back for a target-root mutation', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    await mkdir(target)
    expect(await planDirtyScopes({ target, indexDirectory: join(directory, 'indexes'), events: [event('', FSEVENT_FLAGS.itemIsDir)] }))
      .toEqual({ kind: 'full', reason: 'target-root-dirty' })
  })

  it('accepts an identity-matched rename and scans both parents', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    await mkdir(join(target, 'old'), { recursive: true })
    await mkdir(join(target, 'new'), { recursive: true })
    const oldPath = join(target, 'old', 'file')
    const newPath = join(target, 'new', 'file')
    await writeFile(oldPath, 'value')
    const stats = await import('node:fs/promises').then(({ lstat }) => lstat(oldPath))
    await rename(oldPath, newPath)
    const plan = await planDirtyScopes({
      target,
      indexDirectory: join(directory, 'indexes'),
      events: [event('old/file', FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile), event('new/file', FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile)],
      lookupIdentity: (path) => path === oldPath ? { device: String(stats.dev), inode: String(stats.ino) } : undefined
    })
    expect(plan).toEqual({ kind: 'incremental', scopes: [join(target, 'new'), join(target, 'old')].sort() })
  })

  it('falls back before exceeding the bounded replacement-database count', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    const events: ChangeEvent[] = []
    for (let index = 0; index < 9; index += 1) {
      await mkdir(join(target, `scope-${index}`), { recursive: true })
      await writeFile(join(target, `scope-${index}`, 'file'), 'value')
      events.push(event(`scope-${index}/file`, FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile))
    }
    expect(await planDirtyScopes({ target, indexDirectory: join(directory, 'indexes'), events }))
      .toEqual({ kind: 'full', reason: 'too-many-dirty-scopes' })
  })

  it('scopes an unmatched rename to its parent directory', async () => {
    const directory = await fixture()
    const target = join(directory, 'target')
    await mkdir(join(target, 'a'), { recursive: true })
    const plan = await planDirtyScopes({
      target,
      indexDirectory: join(directory, 'indexes'),
      events: [event('a/missing', FSEVENT_FLAGS.itemRenamed | FSEVENT_FLAGS.itemIsFile)],
      lookupIdentity: () => ({ device: '1', inode: '2' })
    })
    expect(plan).toEqual({ kind: 'incremental', scopes: [join(target, 'a')] })
  })
})

function event(relativePath: string, flags: number): ChangeEvent { return { relativePath, flags, eventId: '2' } }
async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'orbis-dirty-scopes-'))
  cleanup.push(directory)
  return directory
}
