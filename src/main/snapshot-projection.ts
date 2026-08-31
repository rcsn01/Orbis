import type { Breadcrumb, NodeSummary, OrbisSnapshot, SizeAccuracy } from '../shared/contracts'
import { buildChart } from './chart'
import { toSummary, type ChartDataSource, type DatabaseNode } from './index-store'

export interface SnapshotProjectionSource extends ChartDataSource {
  getNode(id: string): DatabaseNode | undefined
  getBreadcrumbs(id: string): readonly Breadcrumb[]
  getLargestItems(id: string): readonly NodeSummary[]
}

export interface SnapshotVolumeFacts {
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly scannedBytes: number
  /** Defaults to the focused directory's accuracy for construction previews. */
  readonly sizeAccuracy?: SizeAccuracy
}

export interface SnapshotProjectionRequest {
  readonly source: SnapshotProjectionSource
  readonly rootId: string
  readonly focusId: string
  readonly target: OrbisSnapshot['target']
  readonly volume: SnapshotVolumeFacts
}

export interface SnapshotView {
  readonly target: OrbisSnapshot['target']
  readonly focus: NodeSummary
  readonly breadcrumbs: readonly Breadcrumb[]
  readonly chart: OrbisSnapshot['chart']
  readonly largestItems: readonly NodeSummary[]
  readonly volume: OrbisSnapshot['volume']
}

/** Build the common path-free view shared by committed and construction snapshots. */
export function projectSnapshotView(request: SnapshotProjectionRequest): SnapshotView | undefined {
  const { source, rootId, focusId, target } = request
  const focus = source.getNode(focusId)
  if (!focus || focus.kind !== 'directory') return undefined

  const breadcrumbs = source.getBreadcrumbs(focus.id)
  if (breadcrumbs.length === 0 || breadcrumbs[0]?.id !== rootId || breadcrumbs.at(-1)?.id !== focus.id) return undefined

  const rootTotalBytes = focus.id === rootId && target.isStartup ? request.volume.capacityBytes : 0
  const chart = buildChart(source, focus, { rootTotalBytes })
  const largestItems = source.getLargestItems(focus.id)
  const unscannedBytes = target.isStartup
    ? Math.max(0, request.volume.capacityBytes - request.volume.freeBytes - request.volume.scannedBytes)
    : 0

  return {
    target,
    focus: focus.id === rootId ? { ...toSummary(focus), parentId: null } : toSummary(focus),
    breadcrumbs,
    chart,
    largestItems,
    volume: {
      capacityBytes: request.volume.capacityBytes,
      freeBytes: request.volume.freeBytes,
      scannedBytes: request.volume.scannedBytes,
      unscannedBytes,
      sizeAccuracy: unscannedBytes > 0 ? 'estimated' : request.volume.sizeAccuracy ?? focus.sizeAccuracy
    }
  }
}
