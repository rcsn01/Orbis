import { contextBridge, ipcRenderer } from "electron"
import type { Appearance, AppearanceApi } from "@moirasia/desktop-shell"
import { IPC, type OrbisApi, type OrbisSnapshot } from "@shared/contracts"

const api: OrbisApi = Object.freeze({
  getSnapshot: () => ipcRenderer.invoke(IPC.getSnapshot),
  startScan: () => ipcRenderer.invoke(IPC.startScan),
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder),
  cancelScan: () => ipcRenderer.invoke(IPC.cancelScan),
  rescan: () => ipcRenderer.invoke(IPC.rescan),
  focusNode: (id: string) => ipcRenderer.invoke(IPC.focusNode, id),
  revealNode: (id: string) => ipcRenderer.invoke(IPC.revealNode, id),
  openFullDiskAccess: () => ipcRenderer.invoke(IPC.openFullDiskAccess),
  subscribe(listener: (snapshot: OrbisSnapshot) => void) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: OrbisSnapshot): void => listener(snapshot)
    ipcRenderer.on(IPC.snapshot, handler)
    return () => ipcRenderer.removeListener(IPC.snapshot, handler)
  }
})

contextBridge.exposeInMainWorld("orbis", api)

const appearanceApi: AppearanceApi = {
  getAppearance: () => ipcRenderer.invoke("desktop-shell:orbis:appearance:get"),
  setAppearance: (value: Appearance) => ipcRenderer.invoke("desktop-shell:orbis:appearance:set", value),
  onAppearance(listener) {
    const handler = (_event: Electron.IpcRendererEvent, value: Appearance): void => listener(value)
    ipcRenderer.on("desktop-shell:orbis:appearance:changed", handler)
    return () => ipcRenderer.removeListener("desktop-shell:orbis:appearance:changed", handler)
  }
}
contextBridge.exposeInMainWorld("desktopShell", Object.freeze(appearanceApi))
