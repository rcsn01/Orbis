import { contextBridge, ipcRenderer } from 'electron'
import type { Appearance, AppearanceApi } from '@moirasia/desktop-shell'
import { createOrbisBridge } from './bridge'

export { createOrbisBridge } from './bridge'
export type { IpcRendererLike } from './bridge'

contextBridge.exposeInMainWorld('orbis', Object.freeze(createOrbisBridge(ipcRenderer)))

const appearanceApi: AppearanceApi = {
  getAppearance: () => ipcRenderer.invoke('desktop-shell:orbis:appearance:get'),
  setAppearance: (value: Appearance) => ipcRenderer.invoke('desktop-shell:orbis:appearance:set', value),
  onAppearance(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: Appearance) => listener(value)
    ipcRenderer.on('desktop-shell:orbis:appearance:changed', handler)
    return () => ipcRenderer.removeListener('desktop-shell:orbis:appearance:changed', handler)
  }
}
contextBridge.exposeInMainWorld('desktopShell', Object.freeze(appearanceApi))
