import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { ChartSegment, DirectoryScanState } from "../shared/contracts"
import { formatBytes } from "./format-bytes"
import {
  createSunburstNavigationPlan,
  layoutSunburstSegments,
  ringOuterRadius,
  sampleSunburstNavigation,
  SUNBURST_NAVIGATION_DURATION_MS
} from "./sunburst-navigation"
import type {
  SunburstGeometry,
  SunburstNavigationDirection,
  SunburstNavigationInput,
  SunburstVisualBar
} from "./sunburst-navigation"

export interface SunburstTransition extends SunburstNavigationInput {
  readonly direction: SunburstNavigationDirection
  readonly navigationToken: number
}

interface SunburstProps {
  readonly segments: readonly ChartSegment[]
  readonly onActivate: (segment: ChartSegment) => void
  readonly onContextMenu?: (segment: ChartSegment) => void
  readonly provisionalState?: DirectoryScanState
  readonly folderSizeBytes?: number | undefined
  readonly transition?: SunburstTransition | undefined
  readonly onTransitionComplete?: () => void
}

interface TransitionClock {
  readonly transition?: SunburstTransition | undefined
  readonly progress: number
}

const CENTER = 320
const INNER_RADIUS = 48

export function Sunburst({ segments, onActivate, onContextMenu, provisionalState = "complete", folderSizeBytes = 0, transition, onTransitionComplete }: SunburstProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState<{ readonly segment: ChartSegment; readonly x: number; readonly y: number }>()
  const [clock, setClock] = useState<TransitionClock>({ transition, progress: transition ? 0 : 1 })
  const onTransitionCompleteRef = useRef(onTransitionComplete)
  onTransitionCompleteRef.current = onTransitionComplete
  const transitionToken = transition?.navigationToken
  const activeTransition = clock.transition?.navigationToken === transitionToken ? clock.transition : transition
  const progress = clock.transition?.navigationToken === transitionToken ? clock.progress : transition ? 0 : 1
  const transitioning = Boolean(activeTransition) && progress < 1
  const staticBars = useMemo(() => layoutSunburstSegments(segments, INNER_RADIUS), [segments])
  const navigationPlan = useMemo(() => activeTransition ? createSunburstNavigationPlan(activeTransition) : undefined, [activeTransition])
  const transitionFrame = activeTransition && navigationPlan && transitioning
    ? sampleSunburstNavigation(navigationPlan, activeTransition.direction, progress)
    : undefined
  const maxDepth = Math.max(1, ...segments.map((segment) => segment.depth))
  const outerRadius = ringOuterRadius(maxDepth, INNER_RADIUS)

  useLayoutEffect(() => {
    if (!transition) {
      setClock({ transition: undefined, progress: 1 })
      return
    }
    setTooltip(undefined)
    setClock({ transition, progress: 0 })
    const startedAt = performance.now()
    let frame = 0
    const advance = (now: number): void => {
      const nextProgress = Math.min(1, Math.max(0, (now - startedAt) / SUNBURST_NAVIGATION_DURATION_MS))
      setClock({ transition, progress: nextProgress })
      if (nextProgress < 1) frame = window.requestAnimationFrame(advance)
      else onTransitionCompleteRef.current?.()
    }
    frame = window.requestAnimationFrame(advance)
    return () => window.cancelAnimationFrame(frame)
  // A navigation token owns one immutable plan and clock; live snapshots with the same token must not restart it.
  }, [transitionToken])

  return <div className="orbis-feature-panel__sunburst-wrap">
    <svg className="orbis-feature-panel__sunburst orbis-feature-panel__sunburst-current" viewBox="0 0 640 640" role="group" aria-label="Disk usage sunburst" aria-busy={transitioning} data-transitioning={transitioning} data-interactive={!transitioning}>
      <title>Disk usage. Open a folder or reveal a file from its segment.</title>
      <SunburstPatterns prefix="orbis" />
      <g className={transitioning ? "orbis-feature-panel__sunburst-semantic-bars--hidden" : undefined}>
        {staticBars.map((bar) => <SemanticSegment key={bar.key} bar={bar} interactive={!transitioning} onActivate={onActivate} onContextMenu={onContextMenu} onTooltip={setTooltip} />)}
      </g>
      <circle cx={CENTER} cy={CENTER} r={INNER_RADIUS - 2} className="orbis-feature-panel__sunburst-center" />
      <text x={CENTER} y={CENTER + 6} textAnchor="middle" className="orbis-feature-panel__sunburst-center-label">{formatBytes(folderSizeBytes)}</text>
    </svg>
    {transitionFrame && <SunburstTransitionLayer frame={transitionFrame} direction={activeTransition!.direction} />}
    {tooltip && <div className="orbis-feature-panel__sunburst-tooltip" role="tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
      <strong>{tooltip.segment.name}</strong>
      <span>{segmentSizePresentation(tooltip.segment).value} · {tooltip.segment.percentage.toFixed(1)}%{segmentSizePresentation(tooltip.segment).estimating ? "" : ` · ${accuracyLabel(tooltip.segment.sizeAccuracy, tooltip.segment.scanState)}`}{tooltip.segment.itemCount && tooltip.segment.itemCount > 1 ? ` · ${formatItemCount(tooltip.segment.itemCount)}` : ""}</span>
    </div>}
    {segments.length === 0 && !transitioning && <div className="orbis-feature-panel__sunburst-empty">{provisionalState === "queued" ? "Queued for scanning" : provisionalState === "scanning" ? "Scanning this folder" : "No readable contents"}</div>}
    <span className="orbis-feature-panel__sunburst-geometry" aria-hidden="true" data-outer-radius={outerRadius} />
  </div>
}

function SemanticSegment({ bar, interactive, onActivate, onContextMenu, onTooltip }: {
  readonly bar: SunburstVisualBar
  readonly interactive: boolean
  readonly onActivate: (segment: ChartSegment) => void
  readonly onContextMenu?: ((segment: ChartSegment) => void) | undefined
  readonly onTooltip: (tooltip: { readonly segment: ChartSegment; readonly x: number; readonly y: number } | undefined) => void
}): React.JSX.Element {
  const { segment, geometry } = bar
  const path = ringPath(CENTER, CENTER, geometry)
  const provisional = segment.scanState === "queued" || segment.scanState === "scanning"
  const estimated = segment.sizeAccuracy === "estimated"
  const displayedSize = segmentSizePresentation(segment)
  const state = displayedSize.estimating ? "" : `, ${accuracyLabel(segment.sizeAccuracy, segment.scanState)}`
  const count = segment.itemCount && segment.itemCount > 1 ? `, ${formatItemCount(segment.itemCount)}` : ""
  const selectable = segment.id !== null && (segment.kind === "file" || segment.drillable)
  return <g>
    <path d={path} fill={bar.fill} className="orbis-feature-panel__sunburst-segment"
      role="button"
      tabIndex={interactive && selectable ? 0 : -1}
      aria-disabled={!selectable || !interactive ? true : undefined}
      aria-label={`${segment.name}, ${segment.kind === "directory" ? "directory" : segment.kind === "file" ? "file" : "aggregate"}, ${displayedSize.value}, ${segment.percentage.toFixed(1)} percent${count}${state}`}
      data-depth={segment.depth}
      data-inner-radius={geometry.inner}
      data-outer-radius={geometry.outer}
      data-start-angle={geometry.startAngle}
      data-end-angle={geometry.endAngle}
      onClick={() => { if (interactive && selectable) onActivate(segment) }}
      onContextMenu={(event) => {
        if (!interactive || !segment.id || segment.kind !== "directory" && segment.kind !== "file" || !onContextMenu) return
        event.preventDefault()
        onContextMenu(segment)
      }}
      onKeyDown={(event) => {
        if (!interactive || !selectable || event.key !== "Enter" && event.key !== " ") return
        event.preventDefault()
        onActivate(segment)
      }}
      onMouseMove={(event) => onTooltip({ segment, x: event.clientX, y: event.clientY })}
      onMouseEnter={(event) => onTooltip({ segment, x: event.clientX, y: event.clientY })}
      onMouseLeave={() => onTooltip(undefined)}
      onFocus={(event) => {
        const bounds = event.currentTarget.getBoundingClientRect()
        onTooltip({ segment, x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 })
      }}
      onBlur={() => onTooltip(undefined)}
    />
    {provisional && <path d={path} fill="url(#orbis-provisional-hatch)" className="orbis-feature-panel__sunburst-hatch" aria-hidden="true" />}
    {estimated && <path d={path} fill="url(#orbis-estimated-dots)" className="orbis-feature-panel__sunburst-estimate" aria-hidden="true" />}
  </g>
}

function SunburstTransitionLayer({ frame, direction }: { readonly frame: { readonly phase: "context" | "morph"; readonly bars: readonly SunburstVisualBar[] }; readonly direction: SunburstNavigationDirection }): React.JSX.Element {
  return <svg className="orbis-feature-panel__sunburst orbis-feature-panel__sunburst-transition" viewBox="0 0 640 640" aria-hidden="true" focusable="false" data-navigation-phase={frame.phase} data-navigation-direction={direction}>
    <SunburstPatterns prefix="orbis-transition" />
    {frame.bars.map((bar) => {
      const path = ringPath(CENTER, CENTER, bar.geometry)
      const provisional = bar.segment.scanState === "queued" || bar.segment.scanState === "scanning"
      const estimated = bar.segment.sizeAccuracy === "estimated"
      return <g key={bar.key} data-track-origin={bar.origin}>
        <path d={path} fill={bar.fill} opacity={bar.opacity} strokeOpacity={bar.strokeOpacity} className="orbis-feature-panel__sunburst-segment" data-depth={bar.segment.depth} data-inner-radius={bar.geometry.inner} data-outer-radius={bar.geometry.outer} data-start-angle={bar.geometry.startAngle} data-end-angle={bar.geometry.endAngle} />
        {provisional && <path d={path} fill="url(#orbis-transition-provisional-hatch)" opacity={bar.decorationOpacity} className="orbis-feature-panel__sunburst-hatch" />}
        {estimated && <path d={path} fill="url(#orbis-transition-estimated-dots)" opacity={bar.decorationOpacity} className="orbis-feature-panel__sunburst-estimate" />}
      </g>
    })}
  </svg>
}

function SunburstPatterns({ prefix }: { readonly prefix: "orbis" | "orbis-transition" }): React.JSX.Element {
  return <defs>
    <pattern id={`${prefix}-provisional-hatch`} width="8" height="8" patternUnits="userSpaceOnUse"><path d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6 M -2 6 L 2 10 M 0 0 L 8 8 M 6 -2 L 10 2" className="orbis-feature-panel__sunburst-hatch-line" /></pattern>
    <pattern id={`${prefix}-estimated-dots`} width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /><circle cx="6" cy="6" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /></pattern>
  </defs>
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

function ringPath(cx: number, cy: number, geometry: SunburstGeometry): string {
  const { inner, outer, startAngle: start, endAngle: end } = geometry
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

function formatItemCount(value: number): string {
  return `${value.toLocaleString()} item${value === 1 ? "" : "s"}`
}
