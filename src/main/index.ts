import { app, BrowserWindow, dialog, Menu, session, shell } from "electron"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { Worker } from "node:worker_threads"
import { registerProductAppearance, runLoginItemControl, desktopWindowChromeOptions, neutralWindowBackground } from "@moirasia/desktop-shell/main"
import { OrbisController } from "./controller"
import { registerIpc } from "./ipc"

app.setName("Orbis")
app.setAppUserModelId("com.opense.Orbis")

void runLoginItemControl("orbis").then((controlled) => {
  if (controlled) return
  if (process.env.ORBIS_USER_DATA) app.setPath("userData", process.env.ORBIS_USER_DATA)
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on("second-instance", () => {
    if (mainWindow?.isMinimized()) mainWindow.restore()
    mainWindow?.show()
    mainWindow?.focus()
  })
  app.whenReady().then(createApplication).catch((error) => { console.error(error); app.quit() })
}).catch((error) => { console.error(error); app.exit(1) })

let mainWindow: BrowserWindow | undefined

async function createApplication(): Promise<void> {
  const window = new BrowserWindow({
    title: "Orbis",
    width: 1_280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    show: false,
    ...desktopWindowChromeOptions(),
    backgroundColor: neutralWindowBackground("system"),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  mainWindow = window
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: {
      ...details.responseHeaders,
      "Content-Security-Policy": [`default-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${rendererUrl ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' http://localhost:* ws://localhost:*" : "script-src 'self'; connect-src 'self'"}`]
    }
  }))
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Orbis", submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }] },
    { label: "File", submenu: [{ label: "Choose Folder…", accelerator: "CommandOrControl+O", click: () => void controller?.chooseFolder() }, { label: "Rescan", accelerator: "CommandOrControl+R", click: () => void controller?.rescan() }, { type: "separator" }, { role: "close" }] },
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }] },
    { label: "View", submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "togglefullscreen" }] },
    { role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] }
  ]))

  const controller = new OrbisController({ create: () => new Worker(scanWorkerPath()) }, {
    indexDirectory: join(app.getPath("temp"), "orbis-indexes"),
    initialTarget: process.env.ORBIS_SCAN_ROOT ?? "/",
    dialog: { showOpenDialog: (options) => dialog.showOpenDialog(window, options) },
    shell: { showItemInFolder: (path) => shell.showItemInFolder(path), openExternal: (url) => shell.openExternal(url) }
  })
  const stopIpc = registerIpc({ window, controller })
  const stopAppearance = await registerProductAppearance("orbis", window)
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  window.webContents.on("will-navigate", (event) => event.preventDefault())
  if (rendererUrl) await window.loadURL(`${rendererUrl}/index.html`)
  else await window.loadURL(pathToFileURL(join(import.meta.dirname, "../renderer/index.html")).toString())
  window.show()
  void controller.startScan().catch((error) => console.error(error))

  let shuttingDown = false
  app.on("activate", () => { window.show(); window.focus() })
  app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit() })
  app.on("before-quit", (event) => {
    if (shuttingDown) return
    event.preventDefault()
    shuttingDown = true
    stopIpc()
    stopAppearance()
    void controller.close().finally(() => app.quit())
  })
}

function scanWorkerPath(): string {
  const bundled = fileURLToPath(new URL("./scan-worker.js", import.meta.url))
  if (!app.isPackaged) return bundled
  const unpacked = join(process.resourcesPath, "app.asar.unpacked", "out", "main", "scan-worker.js")
  if (!existsSync(unpacked)) throw new Error("Orbis scan worker is missing from the packaged application")
  return unpacked
}
