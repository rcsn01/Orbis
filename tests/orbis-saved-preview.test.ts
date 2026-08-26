import { DatabaseSync } from 'node:sqlite'
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrbisController, type OrbisShell, type OrbisWorker } from '../src/main/controller'
import { FullScanResumeStore, type FullScanResumeDescriptor } from '../src/main/full-scan-resume'
import { ProgressiveScanControl, ScanCanceledError, scanFilesystem, type ProgressivePreview } from '../src/main/scanner'

const cleanup: string[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

let fixtureSequence = 0

interface SavedFixture {
  readonly directory: string
  readonly target: string
  readonly indexDirectory: string
  readonly descriptor: FullScanResumeDescriptor
  readonly preview: ProgressivePreview
  readonly resumeStore: FullScanResumeStore
}

class TestWorker implements OrbisWorker {
  readonly messages: unknown[] = []
  readonly #listeners = new Map<'message' | 'error' | 'exit', Array<(value: unknown) => void>>()

  postMessage(message: unknown): void {
    this.messages.push(message)
    const paused = message as { type?: unknown; generation?: unknown; requestId?: unknown }
    if (paused.type === 'pause') queueMicrotask(() => this.emit('message', { type: 'paused', generation: paused.generation, requestId: paused.requestId, checkpointSequence: 1 }))
  }

  on(event: 'message' | 'error' | 'exit', listener: (value: never) => void): OrbisWorker {
    const listeners = this.#listeners.get(event) ?? []
    listeners.push(listener as (value: unknown) => void)
    this.#listeners.set(event, listeners)
    return this
  }

  terminate(): Promise<number> { return Promise.resolve(0) }

  emit(event: 'message' | 'error' | 'exit', value: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(value)
  }
}

class TestShell implements OrbisShell {
  readonly revealed: string[] = []
  showItemInFolder(path: string): void { this.revealed.push(path) }
  openExternal(_url: string): Promise<void> { return Promise.resolve() }
}

describe('saved Orbis previews', () => {
  it('restores the saved root preview before resume without creating a worker', async () => {
    const fixture = await createSavedFixture()
    let createdWorkers = 0
    const restarted = new OrbisController({
      create: () => { createdWorkers += 1; return new TestWorker() }
    }, { indexDirectory: fixture.indexDirectory })
    try {
      await restarted.initialize()
      const snapshot = restarted.snapshot()
      expect(createdWorkers).toBe(0)
      expect(snapshot).toMatchObject({
        committed: false,
        target: fixture.preview.target,
        focus: fixture.preview.focus,
        breadcrumbs: fixture.preview.breadcrumbs,
        scan: { status: 'canceled', resume: { available: true } }
      })
      expect(snapshot.largestItems.find((item) => item.name === 'folder')).toMatchObject({ kind: 'directory' })
      expect(JSON.stringify(snapshot)).not.toContain(fixture.target)
    } finally { await restarted.close() }
  })

  it('restores the durable preview immediately after Pause', async () => {
    const fixture = await createSavedFixture()
    const workers: TestWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new TestWorker(); workers.push(worker); return worker } }, { indexDirectory: fixture.indexDirectory })
    try {
      await controller.initialize()
      await controller.startScan()
      expect(controller.snapshot().scan.status).toBe('scanning')
      expect(controller.snapshot().focus).toBeNull()

      const paused = await controller.cancelScan()
      expect(workers).toHaveLength(1)
      expect(paused).toMatchObject({ committed: false, focus: fixture.preview.focus, scan: { status: 'canceled', resume: { available: true } } })
    } finally { await controller.close() }
  })

  it('reopens the saved construction read-only when focusing a folder', async () => {
    const fixture = await createSavedFixture()
    const controller = new OrbisController({ create: () => new TestWorker() }, { indexDirectory: fixture.indexDirectory })
    try {
      await controller.initialize()
      const folder = controller.snapshot().largestItems.find((item) => item.name === 'folder')
      expect(folder).toBeDefined()
      const focused = await controller.focusNode(folder!.id)
      expect(focused.focus).toMatchObject({ id: folder!.id, name: 'folder', kind: 'directory' })
      expect(focused.breadcrumbs.map((item) => item.name)).toEqual(['target', 'folder'])
      expect(focused.scan).toMatchObject({ status: 'canceled', resume: { available: true } })
    } finally { await controller.close() }
  })

  it('uses the private construction path and existing Finder safety checks', async () => {
    const fixture = await createSavedFixture()
    const shell = new TestShell()
    const controller = new OrbisController({ create: () => new TestWorker() }, { indexDirectory: fixture.indexDirectory, shell })
    try {
      await controller.initialize()
      const file = controller.snapshot().largestItems.find((item) => item.name === 'file-00')
      expect(file).toBeDefined()
      await controller.revealNode(file!.id)
      expect(shell.revealed).toEqual([await realpath(join(fixture.target, 'file-00'))])

      await unlink(join(fixture.target, 'file-00'))
      await symlink(join(fixture.target, 'file-01'), join(fixture.target, 'file-00'))
      await expect(controller.revealNode(file!.id)).rejects.toThrow('no longer a scanned item')
      expect(shell.revealed).toHaveLength(1)
    } finally { await controller.close() }
  })

  it('falls back to the empty Resume state when the preview cannot be read without deleting it', async () => {
    const fixture = await createSavedFixture()
    const database = new DatabaseSync(join(fixture.indexDirectory, fixture.descriptor.partialFile))
    try { database.exec('DROP TABLE size_estimates') } finally { database.close() }

    const controller = new OrbisController({ create: () => new TestWorker() }, { indexDirectory: fixture.indexDirectory })
    try {
      await controller.initialize()
      expect(controller.snapshot()).toMatchObject({ committed: false, focus: null, chart: [], scan: { status: 'canceled', resume: { available: true } } })
      expect((await lstat(join(fixture.indexDirectory, fixture.descriptor.partialFile))).isFile()).toBe(true)
      expect(await fixture.resumeStore.load(fixture.target)).toMatchObject({ kind: 'construction', descriptor: { scanId: fixture.descriptor.scanId } })
    } finally { await controller.close() }
  })

  it('resumes with the saved publication only after the user clicks Resume', async () => {
    const fixture = await createSavedFixture()
    const workers: TestWorker[] = []
    const controller = new OrbisController({ create: () => { const worker = new TestWorker(); workers.push(worker); return worker } }, { indexDirectory: fixture.indexDirectory })
    try {
      await controller.initialize()
      expect(workers).toHaveLength(0)

      const scanning = await controller.rescan()
      expect(scanning.scan.status).toBe('scanning')
      expect(workers).toHaveLength(1)
      expect(workers[0]!.messages[0]).toMatchObject({
        type: 'start',
        target: fixture.target,
        partialPath: join(fixture.indexDirectory, fixture.descriptor.partialFile),
        publishedPath: join(fixture.indexDirectory, fixture.descriptor.candidateFile)
      })
      expect(await fixture.resumeStore.load(fixture.target)).toMatchObject({ kind: 'construction', descriptor: { scanId: fixture.descriptor.scanId } })
    } finally { await controller.close() }
  })

  it('restores a checkpoint after a worker failure and leaves the scan paused', async () => {
    const fixture = await createSavedFixture()
    let worker: TestWorker | undefined
    const controller = new OrbisController({ create: () => (worker = new TestWorker()) }, { indexDirectory: fixture.indexDirectory })
    try {
      await controller.initialize()
      await controller.rescan()
      worker!.emit('error', new Error('worker failed'))
      await waitFor(() => controller.snapshot().scan.status === 'canceled')
      expect(controller.snapshot()).toMatchObject({ committed: false, focus: fixture.preview.focus, scan: { status: 'canceled', resume: { available: true } } })
    } finally { await controller.close() }
  })
})

async function createSavedFixture(): Promise<SavedFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'orbis-saved-preview-'))
  cleanup.push(directory)
  const target = join(directory, 'target')
  const indexDirectory = join(directory, 'indexes')
  await mkdir(join(target, 'folder'), { recursive: true })
  await mkdir(indexDirectory)
  for (let index = 0; index < 12; index += 1) await writeFile(join(target, `file-${String(index).padStart(2, '0')}`), Buffer.alloc(512, index))

  const targetStats = await lstat(target)
  const indexStats = await lstat(indexDirectory)
  const resumeStore = new FullScanResumeStore(indexDirectory)
  const suffix = String(++fixtureSequence).padStart(12, '0')
  const scanId = `41234567-89ab-4cde-8fab-${suffix}`
  const descriptor = resumeStore.descriptor({
    scanId, target, targetDevice: String(targetStats.dev), targetInode: String(targetStats.ino),
    indexDirectoryIdentity: `${String(indexStats.dev)}:${String(indexStats.ino)}`, startupRoot: false,
    checkpoint: { device: String(targetStats.dev), journalUuid: `saved-preview-journal-${suffix}`, eventId: '0' }
  })
  const abort = new AbortController()
  let preview: ProgressivePreview | undefined
  const partialScan = scanFilesystem({
    generation: 1, target, indexDirectory, partialPath: join(indexDirectory, descriptor.partialFile),
    publishedPath: join(indexDirectory, descriptor.candidateFile), signal: abort.signal,
    control: new ProgressiveScanControl(), resumable: { descriptor, store: resumeStore, resume: false },
    onPreview: (nextPreview) => {
      if (!preview) {
        preview = nextPreview
        abort.abort()
      }
    }
  })
  await expect(partialScan).rejects.toBeInstanceOf(ScanCanceledError)
  expect(preview).toBeDefined()
  expect(await resumeStore.load(target)).toMatchObject({ kind: 'construction', descriptor: { scanId } })
  return { directory, target, indexDirectory, descriptor, preview: preview!, resumeStore }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const timeout = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error('Timed out waiting for saved preview state')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
