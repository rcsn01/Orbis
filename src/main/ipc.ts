import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { sendToRenderer } from '@moirasia/desktop-shell/main'
import { IPC, isNodeId } from '../shared/contracts'
import type { OrbisController } from './controller'

export interface OrbisIpcRegistrationOptions {
  readonly webContents?: WebContents
  /** Kept for standalone callers migrating from the original Orbis host. */
  readonly window?: Pick<BrowserWindow, 'webContents'>
  readonly controller: OrbisController
}

export function registerIpc(options: OrbisIpcRegistrationOptions): () => void {
  const target = options.webContents ?? options.window?.webContents
  if (!target) throw new Error('Orbis IPC requires a renderer webContents')
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (event.sender !== target || event.sender.isDestroyed()) throw new Error('Unauthorized IPC sender')
  }
  const nodeId = (value: unknown): string => {
    if (!isNodeId(value)) throw new TypeError('Invalid Orbis node id')
    return value
  }
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
  const handlers: Array<[string, Handler]> = [
    [IPC.getSnapshot, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.snapshot() }],
    [IPC.startScan, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.startScan() }],
    [IPC.chooseFolder, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.chooseFolder() }],
    [IPC.cancelScan, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.cancelScan() }],
    [IPC.discardSavedScan, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.discardSavedScan() }],
    [IPC.rescan, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.rescan() }],
    [IPC.focusNode, (event, id) => { authorize(event as IpcMainInvokeEvent); return options.controller.focusNode(nodeId(id)) }],
    [IPC.revealNode, (event, id) => { authorize(event as IpcMainInvokeEvent); return options.controller.revealNode(nodeId(id)) }],
    [IPC.openFullDiskAccess, (event) => { authorize(event as IpcMainInvokeEvent); return options.controller.openFullDiskAccess() }]
  ]
  const registered: string[] = []
  try {
    for (const [channel, handler] of handlers) {
      ipcMain.handle(channel, handler)
      registered.push(channel)
    }
  } catch (error) {
    for (const channel of registered) ipcMain.removeHandler(channel)
    throw error
  }
  let disposed = false
  const sendSnapshot = (snapshot: unknown): void => {
    if (disposed) return
    sendToRenderer(target, IPC.snapshot, snapshot)
  }
  let unsubscribe: (() => void) | undefined
  try {
    unsubscribe = options.controller.subscribe((snapshot) => { sendSnapshot(snapshot) })
  } catch (error) {
    for (const channel of registered) ipcMain.removeHandler(channel)
    throw error
  }
  return () => {
    if (disposed) return
    disposed = true
    unsubscribe?.()
    for (const channel of registered) ipcMain.removeHandler(channel)
  }
}
