import { isOrbisSnapshot, type OrbisApi, type OrbisSnapshot } from '../shared/contracts'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

const IPC = {
  getSnapshot: 'orbis:get-snapshot',
  startScan: 'orbis:start-scan',
  chooseFolder: 'orbis:choose-folder',
  cancelScan: 'orbis:cancel-scan',
  discardSavedScan: 'orbis:discard-saved-scan',
  rescan: 'orbis:rescan',
  focusNode: 'orbis:focus-node',
  revealNode: 'orbis:reveal-node',
  openFullDiskAccess: 'orbis:open-full-disk-access',
  snapshot: 'orbis:snapshot'
} as const

export function createOrbisBridge(renderer: IpcRendererLike): OrbisApi {
  return {
    getSnapshot: () => renderer.invoke(IPC.getSnapshot) as Promise<OrbisSnapshot>,
    startScan: () => renderer.invoke(IPC.startScan) as Promise<OrbisSnapshot>,
    chooseFolder: () => renderer.invoke(IPC.chooseFolder) as Promise<OrbisSnapshot>,
    cancelScan: () => renderer.invoke(IPC.cancelScan) as Promise<OrbisSnapshot>,
    discardSavedScan: () => renderer.invoke(IPC.discardSavedScan) as Promise<OrbisSnapshot>,
    rescan: () => renderer.invoke(IPC.rescan) as Promise<OrbisSnapshot>,
    focusNode: (id: string) => renderer.invoke(IPC.focusNode, id) as Promise<OrbisSnapshot>,
    revealNode: (id: string) => renderer.invoke(IPC.revealNode, id) as Promise<void>,
    openFullDiskAccess: () => renderer.invoke(IPC.openFullDiskAccess) as Promise<void>,
    subscribe(listener: (snapshot: OrbisSnapshot) => void) {
      const handler = (_event: unknown, ...args: unknown[]) => {
        const snapshot = args[0]
        if (isOrbisSnapshot(snapshot)) listener(snapshot)
      }
      renderer.on(IPC.snapshot, handler)
      return () => { renderer.removeListener(IPC.snapshot, handler) }
    }
  }
}

export type { OrbisApi }
