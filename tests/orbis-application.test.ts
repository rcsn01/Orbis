import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkerTransport } from '../src/main/scan-execution'

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  class FakeWindow {
    static instances: FakeWindow[] = []
    static fromWebContents(contents: unknown): FakeWindow | null { return FakeWindow.instances.find((window) => window.webContents === contents) ?? null }
    destroyed = false
    minimized = false
    webContents = {
      isDestroyed: () => this.destroyed,
      send: vi.fn(),
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      getURL: vi.fn(() => '')
    }
    constructor(_options: unknown) { FakeWindow.instances.push(this) }
    on = vi.fn()
    loadURL = vi.fn(async () => undefined)
    loadFile = vi.fn(async () => undefined)
    show = vi.fn()
    focus = vi.fn()
    isMinimized = vi.fn(() => this.minimized)
    restore = vi.fn(() => { this.minimized = false })
    previewFile = vi.fn()
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
    app: { isPackaged: false, getAppPath: () => '/tmp/orbis-app', getPath: (name: string) => name === 'userData' ? '/tmp/orbis-user-data' : '/tmp' },
    dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
    shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
    Menu: { buildFromTemplate: vi.fn(() => ({ popup: vi.fn() })) },
    appearanceDispose: vi.fn()
  }
})

vi.mock('electron', () => ({ BrowserWindow: mocks.FakeWindow, Menu: mocks.Menu, ipcMain: mocks.ipcMain, app: mocks.app, dialog: mocks.dialog, shell: mocks.shell }))
vi.mock('node:worker_threads', () => ({ Worker: mocks.FakeWorker }))
vi.mock('@moirasia/desktop-shell/main', () => ({
  desktopWindowChromeOptions: () => ({}),
  neutralWindowBackground: () => '#fff',
  registerProductAppearance: vi.fn(async () => mocks.appearanceDispose),
  sendToRenderer: () => false
}))

import { application } from '../src/main/application'
import { IPC } from '../src/shared/contracts'

describe('Orbis application', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    mocks.FakeWindow.instances.length = 0
    mocks.FakeWorker.instances.length = 0
    vi.clearAllMocks()
  })
  afterEach(async () => { await application.stop() })

  it('loads without scanning until requested', async () => {
    await application.start()
    expect(mocks.FakeWindow.instances).toHaveLength(1)
    expect(mocks.FakeWindow.instances[0]!.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer\/index\.html$/))
    expect(mocks.FakeWindow.instances[0]!.webContents.setWindowOpenHandler).toHaveBeenCalled()
    expect(mocks.FakeWorker.instances).toHaveLength(0)
    expect(mocks.appearanceDispose).not.toHaveBeenCalled()

    const start = mocks.handlers.get(IPC.startScan)!
    await start({ sender: mocks.FakeWindow.instances[0]!.webContents })
    expect(mocks.FakeWorker.instances).toHaveLength(1)
    expect(mocks.FakeWorker.instances[0]!.messages[0]).toMatchObject({ type: 'start' })

    await application.stop()
    expect(mocks.FakeWorker.instances[0]!.terminated).toBe(true)
    expect(mocks.handlers.size).toBe(0)
    expect(mocks.appearanceDispose).toHaveBeenCalledTimes(1)
  })

  it('restores and focuses its window when activated', async () => {
    await application.start()
    const window = mocks.FakeWindow.instances[0]!
    window.minimized = true
    application.activate()
    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(2)
    expect(window.focus).toHaveBeenCalledTimes(1)

    application.activate()
    expect(window.restore).toHaveBeenCalledTimes(1)
    expect(window.show).toHaveBeenCalledTimes(3)
  })
})
