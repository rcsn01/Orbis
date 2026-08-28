import { describe, expect, it, vi } from "vitest"
import { IPC } from "../src/shared/contracts"

const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel)
  }
}))

const { registerIpc } = await import("../src/main/ipc")

describe("Orbis IPC", () => {
  it("does not propagate a renderer-frame disposal during snapshot delivery", () => {
    let notify: ((snapshot: unknown) => void) | undefined
    const shellContents = {
      isDestroyed: () => false,
      send: vi.fn(() => { throw new Error("Render frame was disposed before WebFrameMain could be accessed") })
    }
    const controller = {
      snapshot: vi.fn(() => ({ version: 3, committed: true, scan: { status: "idle", generation: 0 } })),
      subscribe: vi.fn((listener: (snapshot: unknown) => void) => { notify = listener; return () => undefined }),
      focusNode: vi.fn(),
      revealNode: vi.fn()
    }
    const stop = registerIpc({ webContents: shellContents as never, controller: controller as never })
    try {
      expect(() => notify?.({ version: 3 })).not.toThrow()
    } finally { stop() }
  })

  it("accepts only opaque node and location ids and authorizes the shell renderer", async () => {
    const shellContents = { isDestroyed: () => false, send: vi.fn() }
    const window = { webContents: shellContents, isDestroyed: () => false }
    const controller = {
      snapshot: vi.fn(() => ({ version: 3, committed: true, scan: { status: "idle", generation: 0 } })),
      subscribe: vi.fn(() => () => undefined),
      focusNode: vi.fn(async (id: string) => ({ version: 3, committed: true, id, scan: { status: "completed", generation: 1 } })),
      revealNode: vi.fn(async () => undefined),
      addLocation: vi.fn(async () => undefined),
      selectLocation: vi.fn(async (id: string) => id),
      removeLocation: vi.fn(async (id: string) => id)
    }
    const stop = registerIpc({ window: window as never, controller: controller as never })
    try {
      const focus = handlers.get(IPC.focusNode)!
      expect(() => focus({ sender: shellContents }, "/Users/me/file")).toThrow("Invalid Orbis node id")
      expect(() => focus({ sender: {} }, "n-2")).toThrow("Unauthorized IPC sender")
      await expect(focus({ sender: shellContents }, "n-2")).resolves.toEqual({ version: 3, committed: true, id: "n-2", scan: { status: "completed", generation: 1 } })
      expect(controller.focusNode).toHaveBeenCalledWith("n-2")

      const select = handlers.get(IPC.selectLocation)!
      expect(() => select({ sender: shellContents }, "loc-not-a-uuid")).toThrow("Invalid Orbis location id")
      expect(() => select({ sender: {} }, "loc-123e4567-e89b-42d3-a456-426614174000")).toThrow("Unauthorized IPC sender")
      await expect(select({ sender: shellContents }, "loc-123e4567-e89b-42d3-a456-426614174000")).resolves.toBe("loc-123e4567-e89b-42d3-a456-426614174000")
      expect(controller.selectLocation).toHaveBeenCalledWith("loc-123e4567-e89b-42d3-a456-426614174000")
    } finally { stop() }
  })
})
