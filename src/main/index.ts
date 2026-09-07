import type { MenuItemConstructorOptions } from 'electron'
import { runStandaloneLaunch } from '@moirasia/desktop-shell/main'
import { application } from './application'

void runStandaloneLaunch({
  appId: 'orbis',
  controlProtocol: 'none',
  productName: 'Orbis',
  appUserModelId: 'com.opense.Orbis',
  userDataEnv: 'ORBIS_USER_DATA',
  contentSecurityPolicy: orbisContentSecurityPolicy,
  menu: orbisMenu,
  register: () => application.start(),
  activate: () => application.activate(),
  dispose: () => application.stop()
})

function orbisContentSecurityPolicy(rendererUrl: string | undefined): string {
  return `default-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; frame-ancestors 'none'; form-action 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; ${rendererUrl ? "script-src 'self' 'unsafe-eval' 'unsafe-inline'; connect-src 'self' http://localhost:* ws://localhost:*" : "script-src 'self'; connect-src 'self'"}`
}

function orbisMenu(): MenuItemConstructorOptions[] {
  return [
    { label: 'Orbis', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [
      { label: 'Choose Folder…', accelerator: 'CommandOrControl+O', click: () => void application.addLocation().catch(reportMenuError) },
      { label: 'Rescan', accelerator: 'CommandOrControl+R', click: () => void application.rescan().catch(reportMenuError) },
      { type: 'separator' },
      { role: 'close' }
    ] },
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }] }
  ]
}

function reportMenuError(error: unknown): void { console.error(error) }
