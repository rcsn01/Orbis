import { describe, expect, it, vi } from "vitest"
import { IPC } from "../src/shared/contracts"

const handlers = new Map<string, (...args: any[]) => unknown>()
const menuTemplates: Array<Array<{ label: string; click: () => void }>> = []
let owner: { isDestroyed(): boolean } | null = { isDestroyed: () => false }
let popup: (options: { callback(): void }, template: Array<{ label: string; click: () => void }>) => void = (options) => options.callback()

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => owner },
  Menu: {
    buildFromTemplate: (template: Array<{ label: string; click: () => void }>) => {
      menuTemplates.push(template)
      return { popup: (options: { callback(): void }) => popup(options, template) }
    }
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const { registerIpc } = await import("../src/main/ipc")

function controller(overrides: Record<string, unknown> = {}) {
  return {
    snapshot: vi.fn(() => ({ version: 4, committed: true, scan: { status: "idle", generation: 0 } })),
    subscribe: vi.fn(() => () => undefined),
    focusNode: vi.fn(async (id: string) => ({ version: 4, committed: true, id, scan: { status: "completed", generation: 1 } })),
    revealNode: vi.fn(async () => undefined),
    performNodeAction: vi.fn(async () => undefined),
    addLocation: vi.fn(async () => undefined),
    selectLocation: vi.fn(async (id: string) => id),
    removeLocation: vi.fn(async (id: string) => id),
    ...overrides
  }
}

describe("Orbis IPC", () => {
  it("does not propagate a renderer-frame disposal during snapshot delivery", () => {
    let notify: ((snapshot: unknown) => void) | undefined
    const shellContents = {
      isDestroyed: () => false,
      send: vi.fn(() => { throw new Error("Render frame was disposed before WebFrameMain could be accessed") })
    }
    const value = controller({ subscribe: vi.fn((listener: (snapshot: unknown) => void) => { notify = listener; return () => undefined }) })
    const stop = registerIpc({ webContents: shellContents as never, controller: value as never })
    try {
      expect(() => notify?.({ version: 4 })).not.toThrow()
    } finally { stop() }
  })

  it("accepts only opaque node and location ids and authorizes the shell renderer", async () => {
    const shellContents = { isDestroyed: () => false, send: vi.fn() }
    const window = { webContents: shellContents, isDestroyed: () => false }
    const value = controller()
    const stop = registerIpc({ window: window as never, controller: value as never })
    try {
      const focus = handlers.get(IPC.focusNode)!
      expect(() => focus({ sender: shellContents }, "/Users/me/file")).toThrow("Invalid Orbis node id")
      expect(() => focus({ sender: {} }, "n-2")).toThrow("Unauthorized IPC sender")
      await expect(focus({ sender: shellContents }, "n-2")).resolves.toMatchObject({ id: "n-2" })
      expect(value.focusNode).toHaveBeenCalledWith("n-2")

      const select = handlers.get(IPC.selectLocation)!
      expect(() => select({ sender: shellContents }, "loc-not-a-uuid")).toThrow("Invalid Orbis location id")
      expect(() => select({ sender: {} }, "loc-123e4567-e89b-42d3-a456-426614174000")).toThrow("Unauthorized IPC sender")
      await expect(select({ sender: shellContents }, "loc-123e4567-e89b-42d3-a456-426614174000")).resolves.toBe("loc-123e4567-e89b-42d3-a456-426614174000")
    } finally { stop() }
  })

  it("builds the native menu in order and maps each main-owned action", async () => {
    const shellContents = { isDestroyed: () => false, send: vi.fn() }
    const value = controller()
    const stop = registerIpc({ webContents: shellContents as never, controller: value as never })
    try {
      const show = handlers.get(IPC.showNodeContextMenu)!
      const actions = ["quick-look", "show-in-finder", "open-in-terminal"]
      for (let index = 0; index < actions.length; index += 1) {
        popup = (options, template) => { template[index]!.click(); options.callback() }
        await show({ sender: shellContents }, "n-42")
      }
      expect(menuTemplates.at(-1)!.map((item) => item.label)).toEqual(["Preview", "Show in Finder", "Open in Terminal"])
      expect(value.performNodeAction.mock.calls).toEqual(actions.map((action) => ["n-42", action]))
    } finally { stop() }
  })

  it("validates context-menu requests, resolves cancellation, and propagates action failures", async () => {
    const shellContents = { isDestroyed: () => false, send: vi.fn() }
    const failure = new Error("Quick Look failed")
    const value = controller({ performNodeAction: vi.fn(async () => { throw failure }) })
    const stop = registerIpc({ webContents: shellContents as never, controller: value as never })
    try {
      const show = handlers.get(IPC.showNodeContextMenu)!
      expect(() => show({ sender: {} }, "n-42")).toThrow("Unauthorized IPC sender")
      expect(() => show({ sender: shellContents }, "/tmp/file")).toThrow("Invalid Orbis node id")

      popup = (options) => options.callback()
      await expect(show({ sender: shellContents }, "n-42")).resolves.toBeUndefined()
      expect(value.performNodeAction).not.toHaveBeenCalled()

      popup = (options, template) => { template[0]!.click(); options.callback() }
      await expect(show({ sender: shellContents }, "n-42")).rejects.toThrow("Quick Look failed")

      owner = { isDestroyed: () => true }
      await expect(show({ sender: shellContents }, "n-42")).rejects.toThrow("window was closed")
    } finally {
      owner = { isDestroyed: () => false }
      popup = (options) => options.callback()
      stop()
    }
  })
})
