import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerTransport } from '../src/main/scan-execution'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  class FakeWindow {
    static instances: FakeWindow[] = []
    destroyed = false
    shown = false
    focused = false
    webContents = {
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn()
    }
    constructor(_options: unknown) { FakeWindow.instances.push(this) }
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
    show = vi.fn(() => { this.shown = true })
    focus = vi.fn(() => { this.focused = true })
    destroy = vi.fn(() => { this.destroyed = true })
    isDestroyed = () => this.destroyed
  }
  class FakeWorker implements WorkerTransport {
    static instances: FakeWorker[] = []
    readonly messages: unknown[] = []
    terminated = false
    constructor(_path: string) { FakeWorker.instances.push(this) }
    postMessage(message: unknown): void { this.messages.push(message) }
    on(): this { return this }
    terminate(): Promise<number> { this.terminated = true; return Promise.resolve(0) }
  }
  return {
    handlers,
    FakeWindow,
    FakeWorker,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) },
      removeHandler: (channel: string) => { handlers.delete(channel) }
    },
    app: { isPackaged: false, getAppPath: () => '/tmp/moirasia', getPath: (name: string) => name === 'userData' ? '/tmp/moirasia-user-data' : '/tmp' },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
    appearanceDispose: vi.fn()
  }
})

vi.mock('electron', () => ({ BrowserWindow: mocks.FakeWindow, ipcMain: mocks.ipcMain, app: mocks.app, dialog: mocks.dialog, shell: mocks.shell }))
vi.mock('node:worker_threads', () => ({ Worker: mocks.FakeWorker }))
vi.mock('@moirasia/desktop-shell/main', () => ({
  desktopWindowChromeOptions: () => ({}),
  neutralWindowBackground: () => '#fff',
  registerProductAppearance: vi.fn(async () => mocks.appearanceDispose),
  sendToRenderer: () => false
}))

import { feature } from '../src/main/feature'
import { IPC } from '../src/shared/contracts'

const contents = { isDestroyed: () => false, send: vi.fn(), on: vi.fn(), setWindowOpenHandler: vi.fn() }
const surface = { webContents: contents, state: { active: false, focused: false }, activate: vi.fn(), focus: vi.fn(), subscribe: vi.fn(() => vi.fn()) }
const suiteContext = { id: 'orbis', mode: 'suite', productId: 'orbis', surface, paths: { workers: { scan: '/tmp/scan-worker.mjs' }, dataDirectory: '/tmp/orbis-suite-data' } } as never
const standaloneContext = { id: 'orbis', mode: 'standalone', productId: 'orbis', paths: { preloads: { main: '/tmp/orbis-preload.cjs' }, renderers: { main: '/tmp/orbis-renderer.html' }, workers: { scan: '/tmp/scan-worker.mjs' }, dataDirectory: '/tmp/orbis-standalone-data' } } as never

describe('Orbis feature host', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.FakeWindow.instances.length = 0
    mocks.FakeWorker.instances.length = 0
    vi.clearAllMocks()
  })
  afterEach(async () => { await feature.dispose() })

  it('registers embedded without a window or automatic worker, then scans on demand', async () => {
    await feature.register(suiteContext)
    expect(mocks.FakeWindow.instances).toHaveLength(0)
    expect(mocks.FakeWorker.instances).toHaveLength(0)
    expect(mocks.handlers.has(IPC.getSnapshot)).toBe(true)

    const start = mocks.handlers.get(IPC.startScan)!
    await start({ sender: contents })
    expect(mocks.FakeWorker.instances).toHaveLength(1)
    expect(mocks.FakeWorker.instances[0]!.messages[0]).toMatchObject({ type: 'start' })
  })

  it('loads standalone without scanning until requested', async () => {
    await feature.register(standaloneContext)
    expect(mocks.FakeWindow.instances).toHaveLength(1)
    expect(mocks.FakeWindow.instances[0]!.loadFile).toHaveBeenCalledWith('/tmp/orbis-renderer.html')
    expect(mocks.FakeWorker.instances).toHaveLength(0)
    expect(mocks.appearanceDispose).not.toHaveBeenCalled()

    const start = mocks.handlers.get(IPC.startScan)!
    await start({ sender: mocks.FakeWindow.instances[0]!.webContents })
    expect(mocks.FakeWorker.instances).toHaveLength(1)

    await feature.dispose()
    expect(mocks.FakeWorker.instances[0]!.terminated).toBe(true)
    expect(mocks.handlers.size).toBe(0)
  })
})
