import { describe, expect, it } from "vitest"
import { scanStatusPresentation } from "../src/renderer/scan-presentation"
import type { LocationId, OrbisSnapshot, ProgressSnapshot, ScanStatus } from "../src/shared/contracts"

const locationId = "loc-11234567-89ab-4cde-8fab-0123456789ab" as LocationId

function snapshot(input: {
  readonly status?: ScanStatus
  readonly committed?: boolean
  readonly focus?: OrbisSnapshot["focus"]
  readonly progress?: ProgressSnapshot | null
  readonly previewBytes?: number
  readonly totals?: OrbisSnapshot["scan"]["totals"]
  readonly resumable?: boolean
} = {}): OrbisSnapshot {
  return {
    version: 4,
    committed: input.committed ?? false,
    selectedLocationId: locationId,
    locations: [{ id: locationId, name: "fixture", coverage: "none" }],
    target: { name: "fixture", isStartup: false },
    focus: input.focus === undefined ? {
      id: "root", parentId: null, name: "fixture", kind: "directory", sizeBytes: 0,
      directChildren: 0, descendantCount: 0, unreadableCount: 0, scanState: "scanning", sizeAccuracy: "partial"
    } : input.focus,
    breadcrumbs: [], chart: [], largestItems: [],
    volume: { capacityBytes: 0, freeBytes: 0, scannedBytes: input.previewBytes ?? 0, unscannedBytes: 0, sizeAccuracy: "partial" },
    scan: {
      locationId,
      status: input.status ?? "scanning", generation: 1,
      progress: input.progress === undefined ? {
        stage: "traversing", scannedItems: 400, discoveredBytes: 1_638_400, elapsedMs: 200, currentItem: "notes.txt"
      } : input.progress,
      totals: input.totals ?? null, error: null,
      ...(input.resumable ? { resume: { available: true, checkpointedAt: "2026-01-01T00:00:00.000Z" } } : {})
    }
  }
}

describe("scan status presentation", () => {
  it("uses live traversal bytes for visible and accessible activity while a preview exists", () => {
    expect(scanStatusPresentation(snapshot({ previewBytes: 128 * 1024 }))).toEqual({
      heading: "Scanning…",
      detail: "400 items · 1.6 MB · notes.txt",
      progress: { value: 8 + Math.log10(401) * 12, label: "Scan progress", valueText: "400 items · 1.6 MB" }
    })
  })

  it("uses traversal bytes when there is no live preview", () => {
    expect(scanStatusPresentation(snapshot({ focus: null, previewBytes: 128 * 1024 })).detail)
      .toBe("400 items · 1.6 MB · notes.txt")
  })

  it("presents Resume preparation without exposing its saved counts as progress", () => {
    const presentation = scanStatusPresentation(snapshot({ progress: {
      stage: "resuming", scannedItems: 400, discoveredBytes: 1_638_400, elapsedMs: 200, currentItem: "Validating saved scan"
    } }))
    expect(presentation).toEqual({
      heading: "Preparing resume...",
      detail: "400 items · 0 B · Validating saved scan",
      progress: { value: 4, label: "Resume preparation", valueText: "Validating saved scan" }
    })
  })

  it("bounds traversal progress and keeps indexing below completion", () => {
    expect(scanStatusPresentation(snapshot({ progress: {
      stage: "traversing", scannedItems: 0, discoveredBytes: 0, elapsedMs: 0, currentItem: "fixture"
    } })).progress?.value).toBe(4)
    expect(scanStatusPresentation(snapshot({ progress: {
      stage: "traversing", scannedItems: Number.MAX_SAFE_INTEGER, discoveredBytes: 0, elapsedMs: 200, currentItem: "fixture"
    } })).progress?.value).toBe(92)

    const presentation = scanStatusPresentation(snapshot({ progress: {
      stage: "indexing", scannedItems: 10_000_000, discoveredBytes: 2_097_152, elapsedMs: 200, currentItem: "fixture"
    }, previewBytes: 2_097_152 }))
    expect(presentation.heading).toBe("Building index…")
    expect(presentation.progress).toEqual({ value: 95, label: "Scan progress", valueText: "10,000,000 items · 2.0 MB" })
  })

  it("presents scanning before its first progress update", () => {
    expect(scanStatusPresentation(snapshot({ progress: null }))).toEqual({
      heading: "Scanning…", detail: "Live preview", progress: { value: 0, label: "Scan progress" }
    })
  })

  it("presents terminal and idle states without progress", () => {
    const totals = { scannedItems: 3, discoveredBytes: 10_240, elapsedMs: 300, skippedItems: 0, unreadableItems: 0, nestedMounts: 0, symlinks: 0, duplicateHardLinks: 0, disappearingItems: 0 }
    expect(scanStatusPresentation(snapshot({ status: "completed", committed: true, progress: null, totals }))).toEqual({
      heading: "Scan complete", detail: "3 items · 10 KB in 0.3s", progress: null
    })
    expect(scanStatusPresentation(snapshot({ status: "canceled", progress: null, resumable: true })).heading).toBe("Scan paused — progress saved")
    expect(scanStatusPresentation(snapshot({ status: "canceled", progress: null })).heading).toBe("Scan canceled")
    expect(scanStatusPresentation(snapshot({ status: "fatal-error", progress: null })).heading).toBe("Scan unavailable")
    expect(scanStatusPresentation(snapshot({ status: "idle", committed: true, progress: null })).detail).toBe("Committed index")
    expect(scanStatusPresentation(snapshot({ status: "idle", progress: null })).detail).toBe("Live preview")
  })
})
