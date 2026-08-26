import { BrowserWindow, dialog, shell, type WebContents } from 'electron'
import { Worker } from 'node:worker_threads'
import { validateFeatureResources, type EmbeddedFeatureSurface, type FeatureContext, type MoirasiaFeature } from '@moirasia/desktop-shell/feature'
import { desktopWindowChromeOptions, neutralWindowBackground, registerProductAppearance } from '@moirasia/desktop-shell/main'
import { OrbisController, type OrbisWorkerFactory } from './controller'
import { registerIpc } from './ipc'

export class OrbisFeature implements MoirasiaFeature {
  readonly id = 'orbis'
  #controller: OrbisController | undefined
  #window: BrowserWindow | undefined
  #disposeIpc: (() => void) | undefined
  #disposeAppearance: (() => void) | undefined
  #surface: EmbeddedFeatureSurface | undefined

  async register(ctx: FeatureContext): Promise<void> {
    if (this.#controller) return
    if (ctx.id !== this.id || ctx.productId !== 'orbis') throw new Error('Invalid Orbis feature context')
    validateFeatureResources(ctx, ctx.mode === 'standalone'
      ? { preloads: ['main'], renderers: ['main'], workers: ['scan'], dataDirectory: true }
      : { workers: ['scan'], dataDirectory: true })
    const workerPath = ctx.paths.workers?.scan
    const nativeAddonPath = ctx.paths.native?.metadata
    const dataDirectory = ctx.paths.dataDirectory
    if (!workerPath || !dataDirectory) throw new Error('Orbis feature resources are incomplete')

    const controller = new OrbisController(createWorkerFactory(workerPath, nativeAddonPath), {
      dataDirectory,
      ...(process.env.ORBIS_SCAN_ROOT ? { initialTarget: process.env.ORBIS_SCAN_ROOT } : {}),
      ...(ctx.mode === 'standalone'
        ? {
            dialog: { showOpenDialog: (options) => dialog.showOpenDialog(this.#window!, options) },
            shell: { showItemInFolder: (path) => shell.showItemInFolder(path), openExternal: (url) => shell.openExternal(url) }
          }
        : {
            shell: { showItemInFolder: (path) => shell.showItemInFolder(path), openExternal: (url) => shell.openExternal(url) }
          })
    })
    let window: BrowserWindow | undefined
    let disposeIpc: (() => void) | undefined
    let disposeAppearance: (() => void) | undefined
    try {
      // Publish the controller before initialization so dispose() can close an
      // index that is loading while the host is shutting down.
      this.#controller = controller
      await controller.initialize()
      const surface = ctx.mode === 'suite' ? ctx.surface : undefined
      let target: WebContents
      if (surface) target = surface.webContents
      else {
        window = createWindow(ctx)
        target = window.webContents
      }
      if (ctx.mode === 'standalone') {
        const standaloneWindow = window
        if (!standaloneWindow) throw new Error('Orbis standalone window is missing')
        this.#window = standaloneWindow
        disposeAppearance = await registerProductAppearance('orbis', standaloneWindow, undefined, { applyNativeTheme: true })
        installWindowGuards(standaloneWindow)
      }
      disposeIpc = registerIpc({ webContents: target, controller })
      this.#window = window
      this.#surface = surface
      this.#disposeIpc = disposeIpc
      this.#disposeAppearance = disposeAppearance
      if (ctx.mode === 'standalone') {
        const standaloneWindow = window
        if (!standaloneWindow) throw new Error('Orbis standalone window is missing')
        const renderer = ctx.paths.renderers?.main ?? ctx.paths.rendererUrl ?? ctx.paths.rendererFile
        if (!renderer) throw new Error('Orbis standalone renderer is missing')
        await loadRenderer(standaloneWindow, renderer)
        standaloneWindow.show()
        await controller.startScan()
      }
    } catch (error) {
      disposeIpc?.()
      disposeAppearance?.()
      await controller.close().catch(() => undefined)
      if (window && !window.isDestroyed()) window.destroy()
      if (this.#controller === controller) this.#controller = undefined
      this.#window = undefined
      this.#surface = undefined
      this.#disposeIpc = undefined
      this.#disposeAppearance = undefined
      throw error
    }
  }

  async dispose(): Promise<void> {
    const controller = this.#controller
    const window = this.#window
    this.#controller = undefined
    this.#window = undefined
    this.#surface = undefined
    this.#disposeIpc?.()
    this.#disposeIpc = undefined
    this.#disposeAppearance?.()
    this.#disposeAppearance = undefined
    await controller?.close()
    if (window && !window.isDestroyed()) window.destroy()
  }

  activate(): void {
    if (this.#window && !this.#window.isDestroyed()) {
      this.#window.show()
      this.#window.focus()
    } else {
      // The suite owns showing and focusing its single BrowserWindow.
      this.#surface?.activate()
    }
  }

  setActive(_active: boolean): void { /* The shell surface owns tab state. */ }

  async chooseFolder(): Promise<void> { await this.#controller?.chooseFolder() }
  async rescan(): Promise<void> { await this.#controller?.rescan() }
}

export const feature = new OrbisFeature()

function createWorkerFactory(workerPath: string, nativeAddonPath: string | undefined): OrbisWorkerFactory {
  return { create: () => nativeAddonPath ? new Worker(workerPath, { workerData: { nativeAddonPath } }) : new Worker(workerPath) }
}

function createWindow(ctx: FeatureContext): BrowserWindow {
  const preload = ctx.paths.preloads?.main ?? ctx.paths.preload
  if (!preload) throw new Error('Orbis standalone preload is missing')
  return new BrowserWindow({
    title: 'Orbis',
    width: 1_280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    ...desktopWindowChromeOptions(),
    backgroundColor: neutralWindowBackground('system'),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
}

async function loadRenderer(window: BrowserWindow, renderer: string): Promise<void> {
  if (renderer.startsWith('http://') || renderer.startsWith('https://')) await window.loadURL(renderer)
  else await window.loadFile(renderer)
}

function installWindowGuards(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
}
