import { IPC, isOrbisSnapshot, type LocationId, type OrbisApi, type OrbisSnapshot } from '../shared/contracts'

export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown
}

export function createOrbisBridge(renderer: IpcRendererLike): OrbisApi {
  return {
    getSnapshot: () => renderer.invoke(IPC.getSnapshot) as Promise<OrbisSnapshot>,
    startScan: () => renderer.invoke(IPC.startScan) as Promise<OrbisSnapshot>,
    addLocation: () => renderer.invoke(IPC.addLocation) as Promise<OrbisSnapshot>,
    selectLocation: (id: LocationId) => renderer.invoke(IPC.selectLocation, id) as Promise<OrbisSnapshot>,
    removeLocation: (id: LocationId) => renderer.invoke(IPC.removeLocation, id) as Promise<OrbisSnapshot>,
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
