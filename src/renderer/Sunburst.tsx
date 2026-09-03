import { useLayoutEffect, useRef, useState } from "react"
import type { ChartSegment, DirectoryScanState } from "../shared/contracts"
import { formatBytes } from "./format-bytes"

export interface SunburstTransitionOrigin {
  readonly depth: number
  readonly startAngle: number
  readonly endAngle: number
}

interface SunburstProps {
  readonly segments: readonly ChartSegment[]
  readonly onActivate: (segment: ChartSegment) => void
  readonly onContextMenu?: (segment: ChartSegment) => void
  readonly provisionalState?: DirectoryScanState
  readonly diskUsagePercentage?: number | undefined
  readonly transitionOrigin?: SunburstTransitionOrigin | undefined
  readonly onTransitionComplete?: () => void
}

const TRANSITION_DURATION_MS = 480
const TRANSITION_INTERACTION_THRESHOLD = 0.7

export function Sunburst({ segments, onActivate, onContextMenu, provisionalState = "complete", diskUsagePercentage, transitionOrigin, onTransitionComplete }: SunburstProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState<{ readonly segment: ChartSegment; readonly x: number; readonly y: number }>()
  const [transitionProgress, setTransitionProgress] = useState(1)
  const onTransitionCompleteRef = useRef(onTransitionComplete)
  onTransitionCompleteRef.current = onTransitionComplete
  const maxDepth = Math.max(1, ...segments.map((segment) => segment.depth))
  const innerRadius = 48
  const outerRadius = ringOuterRadius(maxDepth, innerRadius)
  const center = 320
  const transitioning = Boolean(transitionOrigin) && transitionProgress < 1
  const interactive = !transitioning || transitionProgress >= TRANSITION_INTERACTION_THRESHOLD

  useLayoutEffect(() => {
    if (!transitionOrigin) {
      setTransitionProgress(1)
      return
    }
    setTooltip(undefined)
    setTransitionProgress(0)
    const startedAt = performance.now()
    let frame = 0
    const advance = (now: number): void => {
      const progress = Math.min(1, Math.max(0, (now - startedAt) / TRANSITION_DURATION_MS))
      setTransitionProgress(progress)
      if (progress < 1) {
        frame = window.requestAnimationFrame(advance)
      } else {
        onTransitionCompleteRef.current?.()
      }
    }
    frame = window.requestAnimationFrame(advance)
    return () => window.cancelAnimationFrame(frame)
  }, [transitionOrigin])

  return <div className="orbis-feature-panel__sunburst-wrap">
    <svg className="orbis-feature-panel__sunburst" viewBox="0 0 640 640" role="group" aria-label="Disk usage sunburst" aria-busy={transitioning} data-transitioning={transitioning} data-interactive={interactive}>
      <title>Disk usage. Open a folder or reveal a file from its segment.</title>
      <defs><pattern id="orbis-provisional-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6 M -2 6 L 2 10 M 0 0 L 8 8 M 6 -2 L 10 2" className="orbis-feature-panel__sunburst-hatch-line" /></pattern><pattern id="orbis-estimated-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /><circle cx="6" cy="6" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /></pattern></defs>
      {segments.map((segment) => {
        const geometry = animatedSegmentGeometry(segment, transitionOrigin, transitionProgress, innerRadius)
        const { inner, outer } = geometry
        const path = ringPath(center, center, inner, outer, geometry.startAngle, geometry.endAngle)
        const provisional = segment.scanState === "queued" || segment.scanState === "scanning"
        const estimated = segment.sizeAccuracy === "estimated"
        const displayedSize = segmentSizePresentation(segment)
        const state = displayedSize.estimating ? "" : `, ${accuracyLabel(segment.sizeAccuracy, segment.scanState)}`
        const count = segment.itemCount && segment.itemCount > 1 ? `, ${formatItemCount(segment.itemCount)}` : ""
        const selectable = segment.id !== null && (segment.kind === "file" || segment.drillable)
        return <g key={`${segment.depth}-${segment.colorKey}-${segment.startAngle}`}>
          <path d={path} fill={segmentColor(segment, segments)} className="orbis-feature-panel__sunburst-segment"
          role="button"
          tabIndex={interactive ? 0 : -1}
          aria-disabled={!selectable || !interactive ? true : undefined}
          aria-label={`${segment.name}, ${segment.kind === "directory" ? "directory" : segment.kind === "file" ? "file" : "aggregate"}, ${displayedSize.value}, ${segment.percentage.toFixed(1)} percent${count}${state}`}
          data-depth={segment.depth}
          data-inner-radius={inner}
          data-outer-radius={outer}
          data-start-angle={geometry.startAngle}
          data-end-angle={geometry.endAngle}
          onClick={() => { if (interactive) onActivate(segment) }}
          onContextMenu={(event) => {
            if (!interactive || !segment.id || segment.kind !== "directory" && segment.kind !== "file" || !onContextMenu) return
            event.preventDefault()
            onContextMenu(segment)
          }}
          onKeyDown={(event) => {
            if (!interactive || event.key !== "Enter" && event.key !== " ") return
            event.preventDefault()
            onActivate(segment)
          }}
          onMouseMove={(event) => setTooltip({ segment, x: event.clientX, y: event.clientY })}
          onMouseEnter={(event) => setTooltip({ segment, x: event.clientX, y: event.clientY })}
          onMouseLeave={() => setTooltip(undefined)}
          onFocus={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            setTooltip({ segment, x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
          }}
          onBlur={() => setTooltip(undefined)}
        />
        {provisional && <path d={path} fill="url(#orbis-provisional-hatch)" className="orbis-feature-panel__sunburst-hatch" aria-hidden="true" />}
        {estimated && <path d={path} fill="url(#orbis-estimated-dots)" className="orbis-feature-panel__sunburst-estimate" aria-hidden="true" />}
        </g>
      })}
      <circle cx={center} cy={center} r={innerRadius - 2} className="orbis-feature-panel__sunburst-center" />
      <text x={center} y={center - 4} textAnchor="middle" className="orbis-feature-panel__sunburst-center-label">{diskUsagePercentage === undefined ? "100%" : `${Math.max(0, Math.min(100, diskUsagePercentage)).toFixed(1)}%`}</text>
      <text x={center} y={center + 17} textAnchor="middle" className="orbis-feature-panel__sunburst-center-caption">{diskUsagePercentage === undefined ? "selected folder" : "disk capacity"}</text>
    </svg>
    {tooltip && <div className="orbis-feature-panel__sunburst-tooltip" role="tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
      <strong>{tooltip.segment.name}</strong>
      <span>{segmentSizePresentation(tooltip.segment).value} · {tooltip.segment.percentage.toFixed(1)}%{segmentSizePresentation(tooltip.segment).estimating ? "" : ` · ${accuracyLabel(tooltip.segment.sizeAccuracy, tooltip.segment.scanState)}`}{tooltip.segment.itemCount && tooltip.segment.itemCount > 1 ? ` · ${formatItemCount(tooltip.segment.itemCount)}` : ""}</span>
    </div>}
    {segments.length === 0 && <div className="orbis-feature-panel__sunburst-empty">{provisionalState === "queued" ? "Queued for scanning" : provisionalState === "scanning" ? "Scanning this folder" : "No readable contents"}</div>}
    <span className="orbis-feature-panel__sunburst-geometry" aria-hidden="true" data-outer-radius={outerRadius} />
  </div>
}

function segmentSizePresentation(segment: ChartSegment): { readonly value: string; readonly estimating: boolean } {
  const pending = segment.scanState === "queued" || segment.scanState === "scanning"
  return { value: formatBytes(pending ? segment.estimatedSizeBytes ?? segment.sizeBytes : segment.sizeBytes), estimating: false }
}

function accuracyLabel(accuracy: ChartSegment["sizeAccuracy"] | undefined, state: DirectoryScanState): string {
  if (accuracy === undefined) return state === "queued" ? "Queued" : state === "scanning" ? "Scanning" : state === "unreadable" ? "Unreadable" : "Complete"
  if (accuracy === "estimated") return "Estimated"
  if (accuracy === "exact") return "Exact"
  if (state === "queued" || state === "scanning") return "Scanning"
  return "Partial"
}

const NORMAL_RING_COUNT = 5
const NORMAL_RING_WIDTH = 42
const THIN_RING_WIDTH = 10

function ringInnerRadius(depth: number, centerRadius: number): number {
  const completedNormalRings = Math.min(Math.max(0, depth - 1), NORMAL_RING_COUNT)
  const completedThinRings = Math.max(0, depth - 1 - NORMAL_RING_COUNT)
  return centerRadius + completedNormalRings * NORMAL_RING_WIDTH + completedThinRings * THIN_RING_WIDTH
}

function ringOuterRadius(depth: number, centerRadius: number): number {
  return ringInnerRadius(depth, centerRadius) + (depth <= NORMAL_RING_COUNT ? NORMAL_RING_WIDTH : THIN_RING_WIDTH)
}

interface SegmentGeometry {
  readonly inner: number
  readonly outer: number
  readonly startAngle: number
  readonly endAngle: number
}

export function animatedSegmentGeometry(segment: ChartSegment, origin: SunburstTransitionOrigin | undefined, progress: number, centerRadius = 48): SegmentGeometry {
  const ringInset = segment.depth <= NORMAL_RING_COUNT ? 0 : 1
  const target = {
    inner: ringInnerRadius(segment.depth, centerRadius) + ringInset,
    outer: ringOuterRadius(segment.depth, centerRadius) - ringInset,
    startAngle: segment.startAngle,
    endAngle: segment.endAngle
  }
  if (!origin || progress >= 1) return target

  const originInset = origin.depth <= NORMAL_RING_COUNT ? 0 : 1
  const originInner = ringInnerRadius(origin.depth, centerRadius) + originInset
  const originOuter = ringOuterRadius(origin.depth, centerRadius) - originInset
  const originSpan = Math.max(0, origin.endAngle - origin.startAngle)
  const mapIntoOrigin = (angle: number): number => origin.startAngle + angle / 360 * originSpan
  const start = segment.depth === 1
    ? { inner: originInner, outer: originOuter, startAngle: mapIntoOrigin(segment.startAngle), endAngle: mapIntoOrigin(segment.endAngle) }
    : { inner: originOuter, outer: originOuter, startAngle: mapIntoOrigin(segment.startAngle), endAngle: mapIntoOrigin(segment.endAngle) }
  const depthDelay = Math.min(0.35, Math.max(0, segment.depth - 1) * 0.07)
  const localProgress = Math.max(0, Math.min(1, (progress - depthDelay) / (1 - depthDelay)))
  const eased = 1 - Math.pow(1 - localProgress, 3)
  return {
    inner: interpolate(start.inner, target.inner, eased),
    outer: interpolate(start.outer, target.outer, eased),
    startAngle: interpolate(start.startAngle, target.startAngle, eased),
    endAngle: interpolate(start.endAngle, target.endAngle, eased)
  }
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress
}

function ringPath(cx: number, cy: number, inner: number, outer: number, start: number, end: number): string {
  const span = Math.max(0, end - start)
  if (span >= 359.99) return `M ${cx} ${cy - outer} A ${outer} ${outer} 0 1 1 ${cx} ${cy + outer} A ${outer} ${outer} 0 1 1 ${cx} ${cy - outer} M ${cx} ${cy - inner} A ${inner} ${inner} 0 1 0 ${cx} ${cy + inner} A ${inner} ${inner} 0 1 0 ${cx} ${cy - inner}`
  const outerStart = point(cx, cy, outer, start)
  const outerEnd = point(cx, cy, outer, end)
  const innerEnd = point(cx, cy, inner, end)
  const innerStart = point(cx, cy, inner, start)
  const large = span > 180 ? 1 : 0
  return `M ${outerStart.x} ${outerStart.y} A ${outer} ${outer} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y} L ${innerEnd.x} ${innerEnd.y} A ${inner} ${inner} 0 ${large} 0 ${innerStart.x} ${innerStart.y} Z`
}

function point(cx: number, cy: number, radius: number, angle: number): { readonly x: number; readonly y: number } {
  const radians = (angle - 90) * Math.PI / 180
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) }
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
  const depthLightness = depthOffset * 2
  const positionLightness = positionInFamily * 10
  const lightness = Math.round(Math.max(46, Math.min(80, palette.lightness + depthLightness + positionLightness)))
  return `hsl(${hue} ${palette.saturation}% ${lightness}%)`
}

function formatItemCount(value: number): string {
  return `${value.toLocaleString()} item${value === 1 ? "" : "s"}`
}
