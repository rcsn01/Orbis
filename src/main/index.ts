import { app, Menu, session } from 'electron'
import { runLoginItemControl } from '@moirasia/desktop-shell/main'
import { feature } from './feature'
import { standaloneContext } from './standalone'

app.setName('Orbis')
app.setAppUserModelId('com.opense.Orbis')

void runLoginItemControl('orbis').then((controlled) => {
  if (controlled) return
  if (process.env.ORBIS_USER_DATA) app.setPath('userData', process.env.ORBIS_USER_DATA)
  if (!app.requestSingleInstanceLock()) { app.quit(); return }
  app.on('second-instance', () => feature.activate())
  app.whenReady().then(async () => {
    installContentSecurityPolicy()
    installApplicationMenu()
    await feature.register(standaloneContext())
  }).catch((error) => { console.error(error); app.quit() })
}).catch((error) => { console.error(error); app.exit(1) })

app.on('activate', () => feature.activate())
app.on('window-all-closed', () => app.quit())

let shuttingDown = false
app.on('before-quit', (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  void feature.dispose().finally(() => app.quit())
})

function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Orbis', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'Choose Folder…', accelerator: 'CommandOrControl+O', click: () => void feature.chooseFolder().catch(reportMenuError) },
      { label: 'Rescan', accelerator: 'CommandOrControl+R', click: () => void feature.rescan().catch(reportMenuError) },
      { type: 'separator' },
      { role: 'close' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]))
}

function installContentSecurityPolicy(): void {
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => callback({
    responseHeaders: {
      ...details.responseHeaders,
      'Content-Security-Policy': [`default-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${rendererUrl ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' http://localhost:* ws://localhost:*" : "script-src 'self'; connect-src 'self'"}`]
    }
  }))
}

function reportMenuError(error: unknown): void { console.error(error) }
