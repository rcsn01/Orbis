import type { ChartSegment } from "@shared/contracts"
import type { ChartDataSource } from "./index-store"
import { toSummary, type DatabaseNode } from "./index-store"

export interface ChartOptions {
  readonly maxRings?: number
  readonly maxSegments?: number
  readonly childrenPerDirectory?: number
  readonly minimumArcDegrees?: number
  readonly extraRootBytes?: number
  readonly extraRootName?: string
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
  readonly kind: "directory" | "file" | "other"
  readonly colorKey: string
}

const DEFAULT_OPTIONS: Required<ChartOptions> = {
  maxRings: 5,
  maxSegments: 400,
  childrenPerDirectory: 32,
  minimumArcDegrees: 1,
  extraRootBytes: 0,
  extraRootName: "Unscanned or system data"
}

export function buildChart(source: ChartDataSource, root: DatabaseNode, options: ChartOptions = {}): readonly ChartSegment[] {
  const settings = { ...DEFAULT_OPTIONS, ...options }
  const extraRootBytes = Math.max(0, settings.extraRootBytes)
  const totalBytes = Math.max(0, root.sizeBytes + extraRootBytes)
  if (totalBytes <= 0) return []
  const segments: ChartSegment[] = []
  let frontier: ParentArc[] = [{ node: root, startAngle: 0, endAngle: 360, depth: 0, colorKey: "root" }]

  for (let depth = 1; depth <= settings.maxRings && frontier.length > 0 && segments.length < settings.maxSegments; depth += 1) {
    const next: ParentArc[] = []
    for (const parent of frontier) {
      if (parent.endAngle - parent.startAngle < settings.minimumArcDegrees) continue
      const candidates = candidatesFor(source, parent, settings, depth === 1, extraRootBytes, settings.extraRootName)
      if (candidates.length === 0) continue
      const available = settings.maxSegments - segments.length
      const selected = candidates.slice(0, available)
      if (selected.length === 0) break
      const needsOther = selected.length < candidates.length
      const retained = needsOther ? selected.slice(0, Math.max(0, available - 1)) : selected
      const parentBytes = Math.max(0, parent.node.sizeBytes + (depth === 1 ? extraRootBytes : 0))
      const retainedBytes = retained.reduce((sum, candidate) => sum + candidate.bytes, 0)
      const omittedBytes = Math.max(0, parentBytes - retainedBytes)
      const finalCandidates = needsOther && omittedBytes > 0
        ? [...retained, { node: null, name: depth === 1 && extraRootBytes > 0 ? settings.extraRootName : "Other", bytes: omittedBytes, kind: "other" as const, colorKey: `${parent.colorKey}:other` }]
        : retained
      let cursor = parent.startAngle
      for (let index = 0; index < finalCandidates.length; index += 1) {
        const candidate = finalCandidates[index]
        if (!candidate) continue
        const isLast = index === finalCandidates.length - 1
        const span = isLast ? parent.endAngle - cursor : parentBytes > 0 ? (candidate.bytes / parentBytes) * (parent.endAngle - parent.startAngle) : 0
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
          percentage: totalBytes > 0 ? (candidate.bytes / totalBytes) * 100 : 0,
          drillable: candidate.node?.kind === "directory" && candidate.node.directChildren > 0,
          colorKey: candidate.colorKey
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

function candidatesFor(source: ChartDataSource, parent: ParentArc, settings: Required<ChartOptions>, rootRing: boolean, extraRootBytes: number, extraRootName: string): Candidate[] {
  const children = source.getChildren(parent.node.id, settings.childrenPerDirectory)
  const childLimit = settings.childrenPerDirectory
  const tooMany = source.countChildren(parent.node.id) > children.length
  const retainedChildren = tooMany ? children.slice(0, Math.max(0, childLimit - 1)) : children
  const result: Candidate[] = retainedChildren.map((node) => ({ node, name: node.name, bytes: Math.max(0, node.sizeBytes), kind: node.kind, colorKey: `${parent.colorKey}:${node.id}` }))
  const retainedBytes = result.reduce((sum, candidate) => sum + candidate.bytes, 0)
  const parentBytes = parent.node.sizeBytes + (rootRing ? extraRootBytes : 0)
  const omittedBytes = Math.max(0, parentBytes - retainedBytes)
  if (omittedBytes > 0) result.push({ node: null, name: rootRing && extraRootBytes > 0 ? extraRootName : "Other", bytes: omittedBytes, kind: "other", colorKey: `${parent.colorKey}:other` })
  return result
}

export function chartNodePercentage(segment: ChartSegment): string { return `${segment.percentage.toFixed(1)}%` }
export { toSummary }
