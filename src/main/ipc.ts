import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron"
import { IPC, isNodeId } from "@shared/contracts"
import type { OrbisController } from "./controller"

export function registerIpc(options: { readonly window: BrowserWindow; readonly controller: OrbisController }): () => void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== options.window.webContents || event.sender.isDestroyed()) throw new Error("Unauthorized IPC sender")
  }
  const nodeId = (value: unknown): string => {
    if (!isNodeId(value)) throw new TypeError("Invalid Orbis node id")
    return value
  }
  ipcMain.handle(IPC.getSnapshot, (event) => { authorize(event); return options.controller.snapshot() })
  ipcMain.handle(IPC.startScan, (event) => { authorize(event); return options.controller.startScan() })
  ipcMain.handle(IPC.chooseFolder, (event) => { authorize(event); return options.controller.chooseFolder() })
  ipcMain.handle(IPC.cancelScan, (event) => { authorize(event); return options.controller.cancelScan() })
  ipcMain.handle(IPC.rescan, (event) => { authorize(event); return options.controller.rescan() })
  ipcMain.handle(IPC.focusNode, (event, id) => { authorize(event); return options.controller.focusNode(nodeId(id)) })
  ipcMain.handle(IPC.revealNode, (event, id) => { authorize(event); return options.controller.revealNode(nodeId(id)) })
  ipcMain.handle(IPC.openFullDiskAccess, (event) => { authorize(event); return options.controller.openFullDiskAccess() })
  const unsubscribe = options.controller.subscribe((snapshot) => {
    if (!options.window.isDestroyed()) options.window.webContents.send(IPC.snapshot, snapshot)
  })
  const channels = Object.values(IPC).filter((channel) => channel !== IPC.snapshot)
  return () => { unsubscribe(); channels.forEach((channel) => ipcMain.removeHandler(channel)) }
}
