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
  it("accepts only opaque node ids and authorizes the shell renderer", async () => {
    const shellContents = { isDestroyed: () => false, send: vi.fn() }
    const window = { webContents: shellContents, isDestroyed: () => false }
    const controller = {
      snapshot: vi.fn(() => ({ version: 1 })),
      subscribe: vi.fn(() => () => undefined),
      focusNode: vi.fn(async (id: string) => ({ version: 1, id })),
      revealNode: vi.fn(async () => undefined)
    }
    const stop = registerIpc({ window: window as never, controller: controller as never })
    try {
      const focus = handlers.get(IPC.focusNode)!
      expect(() => focus({ sender: shellContents }, "/Users/me/file")).toThrow("Invalid Orbis node id")
      expect(() => focus({ sender: {} }, "n-2")).toThrow("Unauthorized IPC sender")
      await expect(focus({ sender: shellContents }, "n-2")).resolves.toEqual({ version: 1, id: "n-2" })
      expect(controller.focusNode).toHaveBeenCalledWith("n-2")
    } finally { stop() }
  })
})
