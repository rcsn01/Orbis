// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/renderer/App"
import type { LocationId, OrbisSnapshot } from "../src/shared/contracts"

const file = { id: "n-3", parentId: "n-1", name: "notes.txt", kind: "file" as const, sizeBytes: 2048, directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
const folder = { id: "n-2", parentId: "n-1", name: "Documents", kind: "directory" as const, sizeBytes: 8192, directChildren: 1, descendantCount: 1, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
const root = { id: "n-1", parentId: null, name: "fixture", kind: "directory" as const, sizeBytes: 10240, directChildren: 2, descendantCount: 2, unreadableCount: 0, scanState: "complete" as const, sizeAccuracy: "exact" as const }
const locationId = "loc-11234567-89ab-4cde-8fab-0123456789ab" as LocationId
const otherLocationId = "loc-21234567-89ab-4cde-8fab-0123456789ab" as LocationId
const scanning: OrbisSnapshot = { version: 4, committed: false, selectedLocationId: locationId, locations: [{ id: locationId, name: "fixture", coverage: "direct" }], target: { name: "fixture", isStartup: false }, focus: root, breadcrumbs: [{ id: root.id, name: root.name }], chart: [
  { id: folder.id, name: folder.name, kind: "directory", depth: 1, startAngle: 0, endAngle: 288, sizeBytes: folder.sizeBytes, percentage: 80, drillable: true, colorKey: "root:n-2", scanState: "complete", sizeAccuracy: "exact" },
  { id: file.id, name: file.name, kind: "file", depth: 1, startAngle: 288, endAngle: 360, sizeBytes: file.sizeBytes, percentage: 20, drillable: false, colorKey: "root:n-3", scanState: "complete", sizeAccuracy: "exact" }
], largestItems: [folder, file], volume: { capacityBytes: 20_480, freeBytes: 10_240, scannedBytes: 10_240, unscannedBytes: 0, sizeAccuracy: "exact" }, scan: { locationId, status: "scanning", generation: 1, progress: { stage: "traversing", scannedItems: 2, discoveredBytes: 10_240, elapsedMs: 200, currentItem: "notes.txt" }, totals: null, error: null } }
const completed: OrbisSnapshot = { ...scanning, committed: true, scan: { locationId, status: "completed", generation: 1, progress: null, totals: { scannedItems: 3, discoveredBytes: 10_240, elapsedMs: 300, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }, error: null } }

let publish: ((snapshot: OrbisSnapshot) => void) | undefined

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
  const testWindow = window as unknown as { desktopShell: Window["desktopShell"]; orbis: Window["orbis"] }
  testWindow.desktopShell = { getAppearance: vi.fn(async () => "system" as const), setAppearance: vi.fn(async (value) => value), onAppearance: vi.fn(() => vi.fn()) }
  testWindow.orbis = {
    getSnapshot: vi.fn(async () => scanning),
    startScan: vi.fn(async () => scanning),
    addLocation: vi.fn(async () => scanning),
    selectLocation: vi.fn(async () => scanning),
    removeLocation: vi.fn(async () => scanning),
    cancelScan: vi.fn(async () => ({ ...scanning, scan: { ...scanning.scan, status: "canceled" as const, progress: null } } as OrbisSnapshot)),
    discardSavedScan: vi.fn(async () => scanning),
    rescan: vi.fn(async () => scanning),
    focusNode: vi.fn(async () => completed),
    revealNode: vi.fn(async () => undefined),
    openFullDiskAccess: vi.fn(async () => undefined),
    subscribe: vi.fn((listener) => { publish = listener; return vi.fn() })
  }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); publish = undefined })

describe("Orbis renderer", () => {
  it("does not let a stale scan command result overwrite a completion notification", async () => {
    const user = userEvent.setup()
    const idle: OrbisSnapshot = { ...scanning, scan: { locationId, status: "idle", generation: 0, progress: null, totals: null, error: null } }
    let resolveStart!: (snapshot: OrbisSnapshot) => void
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(idle)
    vi.mocked(window.orbis.startScan).mockReturnValueOnce(new Promise((resolve) => { resolveStart = resolve }))

    render(<App />)
    await user.click(await screen.findByRole("button", { name: "Scan" }))
    act(() => publish?.(completed))
    resolveStart(scanning)

    expect(await screen.findByText("Scan complete", { exact: true })).toBeVisible()
    act(() => publish?.(scanning))
    expect(screen.getByText("Scan complete", { exact: true })).toBeVisible()
    expect(screen.queryByText("Scanning…", { exact: true })).toBeNull()
  })

  it("switches and removes saved locations through opaque ids", async () => {
    const user = userEvent.setup()
    const multiple = { ...completed, locations: [
      { id: locationId, name: "fixture", coverage: "direct" as const },
      { id: otherLocationId, name: "Archive", coverage: "ancestor" as const }
    ] } as OrbisSnapshot
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(multiple)
    vi.mocked(window.orbis.selectLocation).mockResolvedValueOnce({ ...multiple, selectedLocationId: otherLocationId, target: { name: "Archive", isStartup: false } })
    render(<App />)
    await user.selectOptions(await screen.findByRole("combobox", { name: "Saved location" }), otherLocationId)
    expect(window.orbis.selectLocation).toHaveBeenCalledWith(otherLocationId)
    await user.click(screen.getByRole("button", { name: "Remove location" }))
    expect(window.orbis.removeLocation).toHaveBeenCalledWith(otherLocationId)
  })

  it("shows the estimated folder size until an exact snapshot replaces it", async () => {
    const provisional: OrbisSnapshot = {
      ...scanning,
      focus: { ...root, sizeBytes: 12 * 1024 * 1024, estimatedSizeBytes: 8 * 1024 * 1024, scanState: "scanning", sizeAccuracy: "estimated" }
    }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(provisional)

    render(<App />)
    expect(await screen.findByLabelText("Estimated folder size, 8.0 MB")).toBeVisible()

    publish?.(completed)
    expect(await screen.findByLabelText("Folder size, 10 KB")).toBeVisible()
    expect(screen.queryByLabelText(/Estimated folder size/)).toBeNull()
  })

  it("shows the currently known folder size while scanning", async () => {
    const withoutEstimate: OrbisSnapshot = {
      ...scanning,
      focus: { ...root, sizeBytes: 4096, scanState: "scanning", sizeAccuracy: "partial" },
      largestItems: [{ ...folder, sizeBytes: 4096, scanState: "queued", sizeAccuracy: "partial" }]
    }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(withoutEstimate)

    render(<App />)
    expect(await screen.findByLabelText("Known folder size, 4.0 KB")).toBeVisible()
    expect(screen.getByRole("button", { name: "Documents, directory, 4.0 KB, Scanning" })).toBeVisible()
  })

  it("presents the startup root as a share of total disk capacity", async () => {
    const diskSnapshot: OrbisSnapshot = {
      ...completed,
      target: { name: "Macintosh HD", isStartup: true },
      chart: [
        { ...completed.chart[0]!, endAngle: 144, percentage: 40 },
        { ...completed.chart[1]!, startAngle: 144, endAngle: 180, percentage: 10 }
      ]
    }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(diskSnapshot)

    render(<App />)
    expect(await screen.findByText("50.0%")).toBeVisible()
    expect(screen.getByText("disk capacity")).toBeVisible()
    expect(screen.queryByText("selected folder")).toBeNull()
  })

  it("keeps saved results visible during resume preparation", async () => {
    const user = userEvent.setup()
    const paused: OrbisSnapshot = { ...scanning, scan: { locationId, status: "canceled", generation: 1, progress: null, totals: null, error: null, resume: { available: true, checkpointedAt: "2026-01-01T00:00:00.000Z" } } }
    const preparing: OrbisSnapshot = { ...paused, scan: { locationId, status: "scanning", generation: 2, progress: { stage: "resuming", scannedItems: 2, discoveredBytes: 10_240, elapsedMs: 200, currentItem: "Validating saved scan" }, totals: null, error: null } }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(paused)
    vi.mocked(window.orbis.rescan).mockResolvedValueOnce(preparing)
    render(<App />)
    const savedSegment = await screen.findByRole("button", { name: /Documents, directory, 8\.0 KB, 80\.0 percent/ })
    await user.click(screen.getAllByRole("button", { name: "Resume" })[0]!)
    expect(await screen.findByText("Preparing resume...")).toBeVisible()
    expect(screen.getByText("Validating saved scan", { exact: false })).toBeVisible()
    const progress = screen.getByRole("progressbar", { name: "Resume preparation" })
    expect(progress).toHaveAttribute("aria-valuenow", "4")
    expect(progress).toHaveAttribute("aria-valuetext", "Validating saved scan")
    expect(savedSegment).toBeVisible()
    publish?.({ ...preparing, scan: { ...preparing.scan, progress: { ...preparing.scan.progress!, currentItem: "Repairing saved index" } } })
    expect(await screen.findByText("Repairing saved index", { exact: false })).toBeVisible()
    expect(savedSegment).toBeVisible()
    publish?.({ ...scanning, scan: { ...scanning.scan, generation: 2 } })
    expect(await screen.findByText("Scanning…")).toBeVisible()
  })

  it("keeps scan status bytes and progress tied to the live preview", async () => {
    const mismatched: OrbisSnapshot = {
      ...scanning,
      volume: { ...scanning.volume, scannedBytes: 128 * 1024 },
      scan: { ...scanning.scan, progress: { ...scanning.scan.progress!, scannedItems: 400, discoveredBytes: 1_638_400 } }
    }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(mismatched)

    render(<App />)
    expect(await screen.findByText(/400 items · 1\.6 MB · notes\.txt/)).toBeVisible()
    const progress = screen.getByRole("progressbar", { name: "Scan progress" })
    const progressValue = progress.getAttribute("aria-valuenow")
    expect(progress).toHaveAttribute("aria-valuetext", "400 items · 1.6 MB")

    const progressOnly: OrbisSnapshot = {
      ...mismatched,
      scan: { ...mismatched.scan, progress: { ...mismatched.scan.progress!, discoveredBytes: 2_097_152 } }
    }
    act(() => publish?.(progressOnly))
    expect(screen.getByText(/400 items · 2\.0 MB · notes\.txt/)).toBeVisible()
    expect(progress).toHaveAttribute("aria-valuenow", progressValue)

    const matchingPreview: OrbisSnapshot = {
      ...progressOnly,
      volume: { ...progressOnly.volume, scannedBytes: 2_097_152 }
    }
    act(() => publish?.(matchingPreview))
    expect(screen.getByText(/400 items · 2\.0 MB · notes\.txt/)).toBeVisible()
    expect(progress).toHaveAttribute("aria-valuenow", progressValue)
    expect(progress).toHaveAttribute("aria-valuetext", "400 items · 2.0 MB")

    act(() => publish?.({ ...matchingPreview, scan: { ...matchingPreview.scan, progress: { ...matchingPreview.scan.progress!, stage: "indexing" } } }))
    expect(screen.getByRole("progressbar", { name: "Scan progress" })).toHaveAttribute("aria-valuenow", "95")
  })

  it("places the skipped-path warning beside the completed scan status", async () => {
    const user = userEvent.setup()
    const withSkippedPaths: OrbisSnapshot = {
      ...completed,
      scan: { ...completed.scan, totals: { ...completed.scan.totals!, skippedItems: 3, unreadableItems: 2 } }
    }
    vi.mocked(window.orbis.getSnapshot).mockResolvedValueOnce(withSkippedPaths)

    render(<App />)
    const warning = await screen.findByText("Some paths were skipped", { exact: true })
    const status = warning.closest(".orbis-feature-panel__scan-status")
    expect(status).not.toBeNull()
    expect(status).toHaveTextContent("Scan complete")
    expect(status).toHaveTextContent("3 paths could not be included")
    await user.click(screen.getByRole("button", { name: "Open Full Disk Access" }))
    expect(window.orbis.openFullDiskAccess).toHaveBeenCalledOnce()
  })

  it("shows current-folder contents and supports drill-down and Finder reveal", async () => {
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
    const contents = screen.getByRole("complementary", { name: "fixture contents" })
    expect(contents).toHaveTextContent("Documents")
    expect(contents).toHaveTextContent("notes.txt")
    expect(contents).toHaveTextContent("10 KB")
    expect(screen.queryByText("Select an item", { exact: true })).toBeNull()
    expect(screen.queryByText("Largest items", { exact: true })).toBeNull()
    const chartFile = screen.getByRole("button", { name: /notes\.txt, file, 2\.0 KB, 20\.0 percent/ })
    await user.click(chartFile)
    const fileRow = screen.getByRole("button", { name: /notes\.txt, file, 2\.0 KB, Exact$/ })
    await user.click(fileRow)
    expect(window.orbis.revealNode).toHaveBeenCalledTimes(2)
    expect(window.orbis.revealNode).toHaveBeenLastCalledWith("n-3")
  })
})
