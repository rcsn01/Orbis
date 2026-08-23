// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/renderer/App"
import type { OrbisSnapshot } from "../src/shared/contracts"

const file = { id: "n-3", parentId: "n-1", name: "notes.txt", kind: "file" as const, sizeBytes: 2048, directChildren: 0, descendantCount: 0, unreadableCount: 0 }
const folder = { id: "n-2", parentId: "n-1", name: "Documents", kind: "directory" as const, sizeBytes: 8192, directChildren: 1, descendantCount: 1, unreadableCount: 0 }
const root = { id: "n-1", parentId: null, name: "fixture", kind: "directory" as const, sizeBytes: 10240, directChildren: 2, descendantCount: 2, unreadableCount: 0 }
const scanning: OrbisSnapshot = { version: 1, target: { name: "fixture", isStartup: false }, focus: root, breadcrumbs: [{ id: root.id, name: root.name }], chart: [
  { id: folder.id, name: folder.name, kind: "directory", depth: 1, startAngle: 0, endAngle: 288, sizeBytes: folder.sizeBytes, percentage: 80, drillable: true, colorKey: "root:n-2" },
  { id: file.id, name: file.name, kind: "file", depth: 1, startAngle: 288, endAngle: 360, sizeBytes: file.sizeBytes, percentage: 20, drillable: false, colorKey: "root:n-3" }
], largestItems: [folder, file], volume: { capacityBytes: 20_480, freeBytes: 10_240, scannedBytes: 10_240, unscannedBytes: 0 }, scan: { status: "scanning", generation: 1, progress: { stage: "traversing", scannedItems: 2, discoveredBytes: 10_240, elapsedMs: 200, currentItem: "notes.txt" }, totals: null, error: null } }
const completed: OrbisSnapshot = { ...scanning, scan: { status: "completed", generation: 1, progress: null, totals: { scannedItems: 3, discoveredBytes: 10_240, elapsedMs: 300, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }, error: null } }

let publish: ((snapshot: OrbisSnapshot) => void) | undefined

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const testWindow = window as unknown as { desktopShell: Window["desktopShell"]; orbis: Window["orbis"] }
  testWindow.desktopShell = { getAppearance: vi.fn(async () => "system" as const), setAppearance: vi.fn(async (value) => value), onAppearance: vi.fn(() => vi.fn()) }
  testWindow.orbis = {
    getSnapshot: vi.fn(async () => scanning),
    startScan: vi.fn(async () => scanning),
    chooseFolder: vi.fn(async () => scanning),
    cancelScan: vi.fn(async () => ({ ...scanning, scan: { ...scanning.scan, status: "canceled" as const, progress: null } } as OrbisSnapshot)),
    rescan: vi.fn(async () => scanning),
    focusNode: vi.fn(async () => completed),
    revealNode: vi.fn(async () => undefined),
    openFullDiskAccess: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => { publish = listener; return vi.fn() })
  }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); publish = undefined })

describe("Orbis renderer", () => {
  it("shows scan progress, supports keyboard segment activation, drill-down, file selection, and Finder reveal", async () => {
    const user = userEvent.setup()
    render(<App />)
    expect(await screen.findByText("Scanning…")).toBeVisible()
    expect(screen.getByText("notes.txt")).toBeVisible()
    publish?.(completed)
    expect(await screen.findByText("Scan complete")).toBeVisible()
    const folderSegment = screen.getByRole("button", { name: /Documents, directory, 8\.0 KB, 80\.0 percent/ })
    folderSegment.focus()
    await user.keyboard("{Enter}")
    expect(window.orbis.focusNode).toHaveBeenCalledWith("n-2")
    const fileRow = screen.getByRole("button", { name: /notes\.txt, file, 2\.0 KB$/ })
    await user.click(fileRow)
    expect(await screen.findByText("SELECTED ITEM")).toBeVisible()
    await user.click(screen.getByRole("button", { name: "Reveal in Finder" }))
    expect(window.orbis.revealNode).toHaveBeenCalledWith("n-3")
  })
})
