import type { ChartSegment } from "../shared/contracts"

export const SUNBURST_NAVIGATION_DURATION_MS = 1_920
export const SUNBURST_NAVIGATION_STAGE_SPLIT = 0.5

const NORMAL_RING_COUNT = 5
const NORMAL_RING_WIDTH = 42
const THIN_RING_WIDTH = 10
const OTHER_SUFFIX = ":other"

export type SunburstNavigationDirection = "enter" | "exit"
export type SunburstNavigationPhase = "context" | "morph"
export type SunburstTrackOrigin = "context" | "exact" | "aggregate" | "projected" | "residual"

export interface SunburstGeometry {
  readonly inner: number
  readonly outer: number
  readonly startAngle: number
  readonly endAngle: number
}

export interface SunburstVisualBar {
  readonly key: string
  readonly segment: ChartSegment
  readonly geometry: SunburstGeometry
  readonly fill: string
  readonly opacity: number
  readonly strokeOpacity: number
  readonly decorationOpacity: number
  readonly paintRank: number
  readonly origin: SunburstTrackOrigin
}

export interface SunburstNavigationInput {
  readonly parentSegments: readonly ChartSegment[]
  readonly childSegments: readonly ChartSegment[]
  readonly anchor: ChartSegment
  readonly targetFolderId: string
  readonly depthOffset: number
  readonly centerRadius: number
}

interface VisualEndpoint {
  readonly geometry: SunburstGeometry
  readonly fill: string
  readonly opacity: number
  readonly strokeOpacity: number
}

interface NavigationTrack {
  readonly key: string
  readonly segment: ChartSegment
  readonly parent: VisualEndpoint
  readonly child: VisualEndpoint
  readonly paintRank: number
  readonly origin: Exclude<SunburstTrackOrigin, "context">
  readonly depthDelay: number
}

interface ContextTrack {
  readonly key: string
  readonly segment: ChartSegment
  readonly endpoint: VisualEndpoint
  readonly paintRank: number
}

export interface SunburstNavigationPlan {
  readonly morphTracks: readonly NavigationTrack[]
  readonly contextTracks: readonly ContextTrack[]
}

export interface SunburstNavigationFrame {
  readonly phase: SunburstNavigationPhase
  readonly bars: readonly SunburstVisualBar[]
}

export function layoutSunburstSegments(segments: readonly ChartSegment[], centerRadius = 48): readonly SunburstVisualBar[] {
  return segments.map((segment, index) => ({
    key: segmentKey(segment),
    segment,
    geometry: segmentGeometry(segment, centerRadius),
    fill: segmentColor(segment, segments),
    opacity: 1,
    strokeOpacity: 1,
    decorationOpacity: 1,
    paintRank: index,
    origin: "exact"
  }))
}

export function createSunburstNavigationPlan(input: SunburstNavigationInput): SunburstNavigationPlan {
  const { parentSegments, childSegments, anchor, targetFolderId, depthOffset, centerRadius } = input
  const exactAnchor = anchor.id === targetFolderId
  const contextSegments = parentSegments.filter((segment) => (exactAnchor && sameSegment(segment, anchor)) || !isInBranch(segment, anchor))
  const contextKeys = new Set(contextSegments.map(segmentKey))
  const drafts = childSegments.map((childSegment) => {
    const exactParent = matchingSegment(childSegment, parentSegments, depthOffset)
    const aggregateParent = exactParent ? undefined : representingOtherSegment(childSegment, parentSegments, anchor, depthOffset)
    return { childSegment, exactParent, aggregateParent }
  })

  const aggregateGeometries = new Map<string, SunburstGeometry>()
  const aggregateGroups = new Map<string, { readonly aggregate: ChartSegment; readonly children: ChartSegment[] }>()
  for (const draft of drafts) {
    if (!draft.aggregateParent) continue
    const key = segmentKey(draft.aggregateParent)
    const group = aggregateGroups.get(key) ?? { aggregate: draft.aggregateParent, children: [] }
    group.children.push(draft.childSegment)
    aggregateGroups.set(key, group)
  }
  for (const group of aggregateGroups.values()) {
    for (const [key, geometry] of aggregateChildGeometries(group.aggregate, group.children, centerRadius)) aggregateGeometries.set(key, geometry)
  }

  const consumedParentKeys = new Set<string>()
  const childTracks: NavigationTrack[] = drafts.map(({ childSegment, exactParent, aggregateParent }) => {
    const parentSegment = exactParent ?? aggregateParent
    if (parentSegment) consumedParentKeys.add(segmentKey(parentSegment))
    const origin: NavigationTrack["origin"] = exactParent ? "exact" : aggregateParent ? "aggregate" : "projected"
    const parentGeometry = exactParent
      ? segmentGeometry(exactParent, centerRadius)
      : aggregateGeometries.get(segmentKey(childSegment)) ?? projectedIntoAnchorGeometry(childSegment, anchor, centerRadius)
    return {
      key: `child:${segmentKey(childSegment)}`,
      segment: childSegment,
      parent: {
        geometry: parentGeometry,
        fill: segmentColor(parentSegment ?? anchor, parentSegments),
        opacity: 1,
        strokeOpacity: aggregateParent ? 0 : 1
      },
      child: {
        geometry: segmentGeometry(childSegment, centerRadius),
        fill: segmentColor(childSegment, childSegments),
        opacity: 1,
        strokeOpacity: 1
      },
      paintRank: origin === "projected" ? 0 : origin === "aggregate" ? 1 : 3,
      origin,
      depthDelay: Math.min(0.35, Math.max(0, childSegment.depth - 1) * 0.07)
    }
  })

  const residualTracks: NavigationTrack[] = parentSegments
    .filter((segment) => isInBranch(segment, anchor) && !contextKeys.has(segmentKey(segment)) && !consumedParentKeys.has(segmentKey(segment)))
    .map((segment) => {
      const parentGeometry = segmentGeometry(segment, centerRadius)
      const aggregate = segment.kind === "other"
      return {
        key: `residual:${segmentKey(segment)}`,
        segment,
        parent: { geometry: parentGeometry, fill: segmentColor(segment, parentSegments), opacity: 1, strokeOpacity: 1 },
        child: {
          geometry: aggregate ? collapsedAtAnchorEdge(segment, anchor, centerRadius) : parentGeometry,
          fill: segmentColor(segment, parentSegments),
          opacity: 0,
          strokeOpacity: aggregate ? 0 : 1
        },
        paintRank: 2,
        origin: "residual" as const,
        depthDelay: 0
      }
    })

  const contextTracks: ContextTrack[] = contextSegments.map((segment, index) => ({
    key: `context:${segmentKey(segment)}`,
    segment,
    endpoint: {
      geometry: segmentGeometry(segment, centerRadius),
      fill: segmentColor(segment, parentSegments),
      opacity: 1,
      strokeOpacity: 1
    },
    paintRank: 10 + index
  }))

  return {
    morphTracks: [...childTracks, ...residualTracks].sort((left, right) => left.paintRank - right.paintRank),
    contextTracks
  }
}

export function sampleSunburstNavigation(plan: SunburstNavigationPlan, direction: SunburstNavigationDirection, overallProgress: number): SunburstNavigationFrame {
  const progress = clamp(overallProgress)
  if (direction === "enter") {
    if (progress < SUNBURST_NAVIGATION_STAGE_SPLIT) {
      const contextProgress = stageProgress(progress, 0, SUNBURST_NAVIGATION_STAGE_SPLIT)
      return frame("context", plan, 0, 1 - contextProgress)
    }
    return frame("morph", plan, stageProgress(progress, SUNBURST_NAVIGATION_STAGE_SPLIT, 1), 0)
  }
  if (progress < SUNBURST_NAVIGATION_STAGE_SPLIT) {
    return frame("morph", plan, 1 - stageProgress(progress, 0, SUNBURST_NAVIGATION_STAGE_SPLIT), 0)
  }
  return frame("context", plan, 0, stageProgress(progress, SUNBURST_NAVIGATION_STAGE_SPLIT, 1))
}

function frame(phase: SunburstNavigationPhase, plan: SunburstNavigationPlan, canonicalProgress: number, contextOpacity: number): SunburstNavigationFrame {
  const bars: SunburstVisualBar[] = plan.morphTracks.map((track) => sampleTrack(track, canonicalProgress))
  if (contextOpacity > 0) {
    for (const context of plan.contextTracks) {
      bars.push({
        key: context.key,
        segment: context.segment,
        geometry: context.endpoint.geometry,
        fill: context.endpoint.fill,
        opacity: contextOpacity,
        strokeOpacity: context.endpoint.strokeOpacity,
        decorationOpacity: contextOpacity,
        paintRank: context.paintRank,
        origin: "context"
      })
    }
  }
  return { phase, bars: bars.filter((bar) => bar.opacity > 0).sort((left, right) => left.paintRank - right.paintRank) }
}

function sampleTrack(track: NavigationTrack, canonicalProgress: number): SunburstVisualBar {
  const progress = clamp(canonicalProgress)
  const localProgress = track.depthDelay >= 1 ? progress : clamp((progress - track.depthDelay) / (1 - track.depthDelay))
  const eased = 1 - Math.pow(1 - localProgress, 3)
  const opacity = interpolate(track.parent.opacity, track.child.opacity, eased)
  return {
    key: track.key,
    segment: track.segment,
    geometry: interpolateGeometry(track.parent.geometry, track.child.geometry, eased),
    fill: transitionColor(track.parent.fill, track.child.fill, eased),
    opacity,
    strokeOpacity: interpolate(track.parent.strokeOpacity, track.child.strokeOpacity, eased),
    decorationOpacity: opacity,
    paintRank: track.paintRank,
    origin: track.origin
  }
}

function matchingSegment(segment: ChartSegment, candidates: readonly ChartSegment[], depthOffset: number): ChartSegment | undefined {
  if (!segment.id) return undefined
  return candidates.find((candidate) => candidate.id === segment.id && candidate.depth === segment.depth + depthOffset)
}

function representingOtherSegment(child: ChartSegment, parentSegments: readonly ChartSegment[], anchor: ChartSegment, depthOffset: number): ChartSegment | undefined {
  const expectedColorKey = child.colorKey.startsWith("root") ? `${anchor.colorKey}${child.colorKey.slice(4)}` : `${anchor.colorKey}:${child.colorKey}`
  const expectedDepth = child.depth + depthOffset
  return parentSegments
    .filter((candidate) => candidate.kind === "other" && candidate.depth <= expectedDepth && isInBranch(candidate, anchor))
    .filter((candidate) => {
      const representedParentKey = candidate.colorKey.endsWith(OTHER_SUFFIX) ? candidate.colorKey.slice(0, -OTHER_SUFFIX.length) : candidate.colorKey
      return expectedColorKey.startsWith(`${representedParentKey}:`)
    })
    .sort((left, right) => right.depth - left.depth)[0]
}

function aggregateChildGeometries(aggregate: ChartSegment, children: readonly ChartSegment[], centerRadius: number): ReadonlyMap<string, SunburstGeometry> {
  const aggregateGeometry = segmentGeometry(aggregate, centerRadius)
  const firstDepth = Math.min(...children.map((child) => child.depth))
  const roots = children.filter((child) => child.depth === firstDepth).sort((left, right) => left.startAngle - right.startAngle)
  const totalSpan = roots.reduce((sum, root) => sum + Math.max(0, root.endAngle - root.startAngle), 0)
  const sourceSpan = aggregateGeometry.endAngle - aggregateGeometry.startAngle
  const sourceArcs = new Map<string, { readonly start: number; readonly end: number }>()
  let cursor = aggregateGeometry.startAngle
  roots.forEach((root, index) => {
    const childSpan = Math.max(0, root.endAngle - root.startAngle)
    const end = index === roots.length - 1 || totalSpan <= 0 ? aggregateGeometry.endAngle : cursor + childSpan / totalSpan * sourceSpan
    sourceArcs.set(segmentKey(root), { start: cursor, end })
    cursor = end
  })
  const result = new Map<string, SunburstGeometry>()
  for (const child of children) {
    const root = roots.find((candidate) => child.colorKey === candidate.colorKey || child.colorKey.startsWith(`${candidate.colorKey}:`)) ?? roots[0]
    const sourceArc = root ? sourceArcs.get(segmentKey(root)) : undefined
    if (!root || !sourceArc) continue
    const rootSpan = Math.max(0, root.endAngle - root.startAngle)
    const mapAngle = (angle: number): number => sourceArc.start + (rootSpan > 0 ? (angle - root.startAngle) / rootSpan : 0) * (sourceArc.end - sourceArc.start)
    result.set(segmentKey(child), child === root
      ? { ...aggregateGeometry, startAngle: sourceArc.start, endAngle: sourceArc.end }
      : { inner: aggregateGeometry.outer, outer: aggregateGeometry.outer, startAngle: mapAngle(child.startAngle), endAngle: mapAngle(child.endAngle) })
  }
  return result
}

function projectedIntoAnchorGeometry(segment: ChartSegment, anchor: ChartSegment, centerRadius: number): SunburstGeometry {
  const anchorGeometry = segmentGeometry(anchor, centerRadius)
  const anchorSpan = Math.max(0, anchor.endAngle - anchor.startAngle)
  const mapAngle = (angle: number): number => anchor.startAngle + angle / 360 * anchorSpan
  return segment.depth === 1
    ? { ...anchorGeometry, startAngle: mapAngle(segment.startAngle), endAngle: mapAngle(segment.endAngle) }
    : { inner: anchorGeometry.outer, outer: anchorGeometry.outer, startAngle: mapAngle(segment.startAngle), endAngle: mapAngle(segment.endAngle) }
}

function collapsedAtAnchorEdge(segment: ChartSegment, anchor: ChartSegment, centerRadius: number): SunburstGeometry {
  const anchorGeometry = segmentGeometry(anchor, centerRadius)
  const midpoint = (segment.startAngle + segment.endAngle) / 2
  return { inner: anchorGeometry.outer, outer: anchorGeometry.outer, startAngle: midpoint, endAngle: midpoint }
}

function segmentGeometry(segment: ChartSegment, centerRadius: number): SunburstGeometry {
  const inset = segment.depth <= NORMAL_RING_COUNT ? 0 : 1
  return {
    inner: ringInnerRadius(segment.depth, centerRadius) + inset,
    outer: ringOuterRadius(segment.depth, centerRadius) - inset,
    startAngle: segment.startAngle,
    endAngle: segment.endAngle
  }
}

export function ringOuterRadius(depth: number, centerRadius: number): number {
  return ringInnerRadius(depth, centerRadius) + (depth <= NORMAL_RING_COUNT ? NORMAL_RING_WIDTH : THIN_RING_WIDTH)
}

function ringInnerRadius(depth: number, centerRadius: number): number {
  const completedNormalRings = Math.min(Math.max(0, depth - 1), NORMAL_RING_COUNT)
  const completedThinRings = Math.max(0, depth - 1 - NORMAL_RING_COUNT)
  return centerRadius + completedNormalRings * NORMAL_RING_WIDTH + completedThinRings * THIN_RING_WIDTH
}

function isInBranch(segment: ChartSegment, branch: ChartSegment): boolean {
  return segment.colorKey === branch.colorKey || segment.colorKey.startsWith(`${branch.colorKey}:`)
}

function sameSegment(left: ChartSegment, right: ChartSegment): boolean {
  return segmentKey(left) === segmentKey(right)
}

function segmentKey(segment: ChartSegment): string {
  return `${segment.depth}:${segment.id ?? segment.colorKey}`
}

function interpolateGeometry(start: SunburstGeometry, end: SunburstGeometry, progress: number): SunburstGeometry {
  return {
    inner: interpolate(start.inner, end.inner, progress),
    outer: interpolate(start.outer, end.outer, progress),
    startAngle: interpolate(start.startAngle, end.startAngle, progress),
    endAngle: interpolate(start.endAngle, end.endAngle, progress)
  }
}

function transitionColor(start: string, end: string, progress: number): string {
  if (progress <= 0 || start === end) return start
  if (progress >= 1) return end
  return `color-mix(in srgb, ${start} ${(1 - progress) * 100}%, ${end})`
}

function stageProgress(progress: number, start: number, end: number): number {
  return clamp((progress - start) / (end - start))
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

const PREFERRED_COLOR_FAMILIES = [
  { hue: 132, saturation: 64, lightness: 62 },
  { hue: 198, saturation: 72, lightness: 64 },
  { hue: 52, saturation: 78, lightness: 64 },
  { hue: 164, saturation: 62, lightness: 60 },
  { hue: 28, saturation: 76, lightness: 64 },
  { hue: 180, saturation: 64, lightness: 58 },
  { hue: 92, saturation: 62, lightness: 61 },
  { hue: 344, saturation: 68, lightness: 65 },
  { hue: 278, saturation: 58, lightness: 65 },
  { hue: 225, saturation: 62, lightness: 58 }
] as const

export function segmentColor(segment: ChartSegment, chart: readonly ChartSegment[] = [segment]): string {
  if (segment.kind === "other" || segment.kind === "unavailable") return "#89909a"
  const families = chart
    .filter((candidate) => candidate.depth === 1 && candidate.kind !== "other" && candidate.kind !== "unavailable")
    .sort((left, right) => left.startAngle - right.startAngle)
  const family = families.find((candidate) => segment.colorKey === candidate.colorKey || segment.colorKey.startsWith(`${candidate.colorKey}:`)) ?? segment
  const familyIndex = Math.max(0, families.indexOf(family))
  const palette = PREFERRED_COLOR_FAMILIES[familyIndex % PREFERRED_COLOR_FAMILIES.length]!
  const familyMidpoint = (family.startAngle + family.endAngle) / 2
  const segmentMidpoint = (segment.startAngle + segment.endAngle) / 2
  const halfSpan = Math.max(1, (family.endAngle - family.startAngle) / 2)
  const positionInFamily = Math.max(-1, Math.min(1, (segmentMidpoint - familyMidpoint) / halfSpan))
  const depthOffset = Math.max(0, segment.depth - 1)
  const hue = Math.round((palette.hue + depthOffset * 12 + positionInFamily * 40 + 360) % 360)
  const lightness = Math.round(Math.max(46, Math.min(80, palette.lightness + depthOffset * 2 + positionInFamily * 10)))
  return `hsl(${hue} ${palette.saturation}% ${lightness}%)`
}
