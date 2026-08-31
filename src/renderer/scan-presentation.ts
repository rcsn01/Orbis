import type { OrbisSnapshot } from "../shared/contracts"
import { formatBytes } from "./format-bytes"

export interface ScanStatusPresentation {
  readonly heading: string
  readonly detail: string
  readonly progress: {
    readonly value: number
    readonly label: string
    readonly valueText?: string
  } | null
}

export function scanStatusPresentation(snapshot: OrbisSnapshot): ScanStatusPresentation {
  const progress = snapshot.scan.progress
  const preparing = progress?.stage === "resuming"
  const activityText = progress
    ? `${progress.scannedItems.toLocaleString()} items · ${formatBytes(scanStatusBytes(snapshot))}`
    : undefined

  return {
    heading: scanStatusHeading(snapshot),
    detail: progress
      ? `${activityText} · ${progress.currentItem}`
      : snapshot.scan.totals
        ? `${snapshot.scan.totals.scannedItems.toLocaleString()} items · ${formatBytes(snapshot.scan.totals.discoveredBytes)} in ${(snapshot.scan.totals.elapsedMs / 1000).toFixed(1)}s`
        : snapshot.committed ? "Committed index" : "Live preview",
    progress: snapshot.scan.status === "scanning" ? {
      value: scanProgressValue(snapshot),
      label: preparing ? "Resume preparation" : "Scan progress",
      ...(preparing && progress ? { valueText: progress.currentItem } : activityText ? { valueText: activityText } : {})
    } : null
  }
}

function scanStatusHeading(snapshot: OrbisSnapshot): string {
  if (snapshot.scan.status === "scanning") {
    if (snapshot.scan.progress?.stage === "resuming") return "Preparing resume..."
    if (snapshot.scan.progress?.stage === "indexing") return "Building index…"
    return "Scanning…"
  }
  if (snapshot.scan.status === "completed") return "Scan complete"
  if (snapshot.scan.status === "canceled") return snapshot.scan.resume?.available ? "Scan paused — progress saved" : "Scan canceled"
  if (snapshot.scan.status === "fatal-error") return "Scan unavailable"
  return "Waiting to scan"
}

export function scanStatusBytes(snapshot: OrbisSnapshot): number {
  const progress = snapshot.scan.progress
  const liveProgress = !snapshot.committed && progress !== null
    && (progress.stage === "traversing" || progress.stage === "indexing")
  return liveProgress ? Math.max(snapshot.volume.scannedBytes, progress.discoveredBytes) : snapshot.volume.scannedBytes
}

function scanProgressValue(snapshot: OrbisSnapshot): number {
  const progress = snapshot.scan.progress
  if (!progress) return 0
  if (progress.stage === "resuming") return 4
  if (progress.stage === "indexing") return 95
  if (progress.scannedItems === 0) return 4
  return Math.min(92, 8 + Math.log10(progress.scannedItems + 1) * 12)
}
