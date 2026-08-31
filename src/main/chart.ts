import type { ChartSegment, DirectoryScanState, SizeAccuracy } from "../shared/contracts"
import type { ChartDataSource, DatabaseNode } from "./index-store"

export interface ChartOptions {
  readonly maxRings?: number
  readonly maxSegments?: number
  /** Query cap per ring; keeps construction work bounded before aggregation. */
  readonly childrenPerDirectory?: number
  /** Maximum concrete siblings rendered in one ring. */
  readonly maxVisibleChildren?: number
  /** Maximum individual files retained before the tail is batched as Other. */
  readonly maxVisibleFiles?: number
  /** Minimum share of a parent directory's bytes for a file to remain visible. */
  readonly minimumFilePercentage?: number
  readonly minimumArcDegrees?: number
  /** Scale the root ring against this total while leaving unrepresented bytes blank. */
  readonly rootTotalBytes?: number
}

interface ParentArc {
  readonly node: DatabaseNode
  readonly startAngle: number
  readonly endAngle: number
  readonly depth: number
  readonly colorKey: string
}

interface Candidate {
  readonly node: DatabaseNode | null
  readonly name: string
  readonly bytes: number
  readonly estimatedSizeBytes?: number
  readonly weight: number
  readonly kind: "directory" | "file" | "other" | "unavailable"
  readonly colorKey: string
  readonly scanState: DirectoryScanState
  readonly sizeAccuracy: SizeAccuracy
  readonly itemCount?: number
}

const DEFAULT_OPTIONS: Required<ChartOptions> = {
  maxRings: 10,
  maxSegments: 400,
  childrenPerDirectory: 64,
  maxVisibleChildren: 16,
  maxVisibleFiles: 8,
  minimumFilePercentage: 1,
  minimumArcDegrees: 3,
  rootTotalBytes: 0
}

export function buildChart(source: ChartDataSource, root: DatabaseNode, options: ChartOptions = {}): readonly ChartSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const representedRootBytes = Math.max(0, chartBytes(root))
  const totalBytes = Math.max(representedRootBytes, settings.rootTotalBytes)
  if (totalBytes <= 0 && root.scanState === "complete") return []
  const rootEndAngle = totalBytes > 0 ? Math.min(360, representedRootBytes / totalBytes * 360) : 360
  const segments: ChartSegment[] = []
  let frontier: ParentArc[] = [{ node: root, startAngle: 0, endAngle: rootEndAngle, depth: 0, colorKey: "root" }]

  for (let depth = 1; depth <= settings.maxRings && frontier.length > 0 && segments.length < settings.maxSegments; depth += 1) {
    const next: ParentArc[] = []
    for (const parent of frontier) {
      if (parent.endAngle - parent.startAngle < settings.minimumArcDegrees) continue
      const candidates = collapseSmallSections(
        candidatesFor(source, parent, settings, depth === 1),
        parent.endAngle - parent.startAngle,
        settings.minimumArcDegrees,
        parent
      )
      if (candidates.length === 0) continue
      const available = settings.maxSegments - segments.length
      const selected = candidates.slice(0, available)
      if (selected.length === 0) break
      const needsOther = selected.length < candidates.length
      const retained = needsOther ? selected.slice(0, Math.max(0, available - 1)) : selected
      const parentBytes = Math.max(0, chartBytes(parent.node))
      const retainedBytes = retained.reduce((sum, candidate) => sum + candidate.bytes, 0)
      const omittedBytes = Math.max(0, parentBytes - retainedBytes)
      const omittedItemCount = sumItemCount(candidates.slice(retained.length))
      const finalCandidates = needsOther && omittedBytes > 0
        ? [...retained, {
            node: null,
            name: "Other",
            bytes: omittedBytes,
            weight: omittedBytes,
            kind: "other" as const,
            colorKey: `${parent.colorKey}:other`,
            scanState: parent.node.scanState,
            sizeAccuracy: parent.node.sizeAccuracy,
            ...(omittedItemCount > 0 ? { itemCount: omittedItemCount } : {})
          }]
        : retained
      const totalWeight = finalCandidates.reduce((sum, candidate) => sum + candidate.weight, 0)
      let cursor = parent.startAngle
      for (let index = 0; index < finalCandidates.length; index += 1) {
        const candidate = finalCandidates[index]
        if (!candidate) continue
        const isLast = index === finalCandidates.length - 1
        const span = isLast ? parent.endAngle - cursor : totalWeight > 0 ? (candidate.weight / totalWeight) * (parent.endAngle - parent.startAngle) : 0
        const endAngle = isLast ? parent.endAngle : Math.min(parent.endAngle, cursor + span)
        if (endAngle <= cursor) continue
        const segment: ChartSegment = {
          id: candidate.node?.id ?? null,
          name: candidate.name,
          kind: candidate.kind,
          depth,
          startAngle: cursor,
          endAngle,
          sizeBytes: candidate.bytes,
          ...(candidate.estimatedSizeBytes && candidate.estimatedSizeBytes > 0 ? { estimatedSizeBytes: candidate.estimatedSizeBytes } : {}),
          percentage: totalBytes > 0 ? (candidate.bytes / totalBytes) * 100 : 0,
          ...(candidate.itemCount === undefined || candidate.itemCount <= 1 ? {} : { itemCount: candidate.itemCount }),
          drillable: candidate.node?.kind === "directory" && (candidate.node.directChildren > 0 || candidate.node.scanState !== "complete"),
          colorKey: candidate.colorKey,
          scanState: candidate.scanState,
          sizeAccuracy: candidate.sizeAccuracy
        }
        segments.push(segment)
        if (candidate.node?.kind === "directory" && segment.drillable && endAngle - cursor >= settings.minimumArcDegrees && segments.length < settings.maxSegments) {
          next.push({ node: candidate.node, startAngle: cursor, endAngle, depth, colorKey: candidate.colorKey })
        }
        cursor = endAngle
      }
      if (segments.length >= settings.maxSegments) break
    }
    frontier = next
  }
  return segments.slice(0, settings.maxSegments)
}

function collapseSmallSections(
  candidates: readonly Candidate[], parentArcDegrees: number, minimumArcDegrees: number, parent: ParentArc
): Candidate[] {
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0)
  if (totalWeight <= 0 || parentArcDegrees <= 0 || minimumArcDegrees <= 0) return [...candidates]
  const small = candidates.filter((candidate) => candidate.kind !== "other"
    && candidate.weight / totalWeight * parentArcDegrees < minimumArcDegrees)
  if (small.length === 0) return [...candidates]

  const collapsed = candidates.filter((candidate) => candidate.kind === "other" || small.includes(candidate))
  const retained = candidates.filter((candidate) => !collapsed.includes(candidate))
  const bytes = collapsed.reduce((sum, candidate) => sum + candidate.bytes, 0)
  const weight = collapsed.reduce((sum, candidate) => sum + candidate.weight, 0)
  const itemCount = sumItemCount(collapsed)
  return [...retained, {
    node: null,
    name: "Other",
    bytes,
    weight,
    kind: "other",
    colorKey: `${parent.colorKey}:other`,
    scanState: parent.node.scanState,
    sizeAccuracy: parent.node.sizeAccuracy,
    ...(itemCount > 0 ? { itemCount } : {})
  }]
}

function candidatesFor(source: ChartDataSource, parent: ParentArc, settings: Required<ChartOptions>, rootRing: boolean): Candidate[] {
  const children = source.getChildren(parent.node.id, settings.childrenPerDirectory)
  const childCount = source.countChildren(parent.node.id)
  const parentBytes = Math.max(0, chartBytes(parent.node))
  const parentArc = Math.max(settings.minimumArcDegrees, parent.endAngle - parent.startAngle)
  const minimumFileFraction = Math.max(settings.minimumFilePercentage / 100, settings.minimumArcDegrees / parentArc)
  const minimumFileBytes = parentBytes * minimumFileFraction
  const retainedChildren = selectChildren(children, childCount, parentBytes, minimumFileBytes, settings)
  const result: Candidate[] = retainedChildren.map((node) => ({
    node,
    name: node.name,
    bytes: chartBytes(node),
    ...(node.estimatedBytes > 0 ? { estimatedSizeBytes: node.estimatedBytes } : {}),
    weight: chartBytes(node) > 0 ? chartBytes(node) : node.kind === "directory" && node.scanState !== "complete" ? 1 : 0,
    kind: node.kind,
    colorKey: `${parent.colorKey}:${node.id}`,
    scanState: node.scanState,
    sizeAccuracy: node.sizeAccuracy,
    itemCount: 1
  }))
  const estimatedRemainder = rootRing ? 0 : Math.max(0, source.getEstimatedRemainder?.(parent.node.id) ?? 0)
  if (estimatedRemainder > 0) {
    result.push({
      node: null,
      name: "Estimated remainder",
      bytes: estimatedRemainder,
      weight: estimatedRemainder,
      kind: "unavailable",
      colorKey: `${parent.colorKey}:estimated-remainder`,
      scanState: parent.node.scanState,
      sizeAccuracy: "estimated"
    })
  }
  const retainedBytes = result.reduce((sum, candidate) => sum + candidate.bytes, 0)
  const childBytes = chartBytes(parent.node)
  const omittedBytes = Math.max(0, childBytes - retainedBytes)
  const omittedChildCount = Math.max(0, childCount - retainedChildren.length)
  if (omittedBytes > 0) result.push({
    node: null,
    name: "Other",
    bytes: omittedBytes,
    weight: omittedBytes,
    kind: "other",
    colorKey: `${parent.colorKey}:other`,
    scanState: parent.node.scanState,
    sizeAccuracy: parent.node.sizeAccuracy,
    ...(omittedChildCount > 0 ? { itemCount: omittedChildCount } : {})
  })
  return result
}

function selectChildren(children: readonly DatabaseNode[], childCount: number, parentBytes: number, minimumFileBytes: number, settings: Required<ChartOptions>): readonly DatabaseNode[] {
  const visibleLimit = Math.max(0, Math.floor(settings.maxVisibleChildren))
  const fileLimit = Math.max(0, Math.min(visibleLimit, Math.floor(settings.maxVisibleFiles)))
  const collapseSmallFiles = childCount > visibleLimit || children.filter((node) => node.kind === "file").length > fileLimit
  const selected: DatabaseNode[] = []
  let files = 0
  for (const child of children) {
    if (selected.length >= visibleLimit) break
    if (child.kind === "file") {
      if (files >= fileLimit) continue
      if (collapseSmallFiles && parentBytes > 0 && child.sizeBytes < minimumFileBytes) continue
      files += 1
    }
    selected.push(child)
  }
  return selected
}

function chartBytes(node: DatabaseNode): number {
  const pending = node.scanState === "queued" || node.scanState === "scanning"
  return Math.max(0, pending && node.estimatedBytes > 0 ? node.estimatedBytes : node.sizeBytes)
}

function sumItemCount(candidates: readonly Candidate[]): number {
  return candidates.reduce((sum, candidate) => sum + (candidate.itemCount ?? 0), 0)
}
