import { useState } from "react"
import type { ChartSegment, DirectoryScanState } from "../shared/contracts"

interface SunburstProps {
  readonly segments: readonly ChartSegment[]
  readonly onActivate: (segment: ChartSegment) => void
  readonly provisionalState?: DirectoryScanState
  readonly diskUsagePercentage?: number | undefined
}

export function Sunburst({ segments, onActivate, provisionalState = "complete", diskUsagePercentage }: SunburstProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState<{ readonly segment: ChartSegment; readonly x: number; readonly y: number }>()
  const maxDepth = Math.max(1, ...segments.map((segment) => segment.depth))
  const ringWidth = 42
  const innerRadius = 48
  const outerRadius = innerRadius + maxDepth * ringWidth
  const center = 300
  return <div className="orbis-feature-panel__sunburst-wrap">
    <svg className="orbis-feature-panel__sunburst" viewBox="0 0 600 600" role="group" aria-label="Disk usage sunburst">
      <title>Disk usage. Select a segment to inspect it.</title>
      <defs><pattern id="orbis-provisional-hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M -2 2 L 2 -2 M 0 8 L 8 0 M 6 10 L 10 6 M -2 6 L 2 10 M 0 0 L 8 8 M 6 -2 L 10 2" className="orbis-feature-panel__sunburst-hatch-line" /></pattern><pattern id="orbis-estimated-dots" width="8" height="8" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /><circle cx="6" cy="6" r="1.2" className="orbis-feature-panel__sunburst-estimate-dot" /></pattern></defs>
      {segments.map((segment) => {
        const inner = innerRadius + (segment.depth - 1) * ringWidth + 1
        const outer = innerRadius + segment.depth * ringWidth - 1
        const path = ringPath(center, center, inner, outer, segment.startAngle, segment.endAngle)
        const provisional = segment.scanState === "queued" || segment.scanState === "scanning"
        const estimated = segment.sizeAccuracy === "estimated"
        const displayedSize = segmentSizePresentation(segment)
        const state = displayedSize.estimating ? "" : `, ${accuracyLabel(segment.sizeAccuracy, segment.scanState)}`
        const count = segment.itemCount && segment.itemCount > 1 ? `, ${formatItemCount(segment.itemCount)}` : ""
        const selectable = segment.id !== null && (segment.kind === "file" || segment.drillable)
        return <g key={`${segment.depth}-${segment.colorKey}-${segment.startAngle}`}>
          <path d={path} fill={segmentColor(segment)} className="orbis-feature-panel__sunburst-segment"
          role="button"
          tabIndex={0}
          aria-disabled={!selectable ? true : undefined}
          aria-label={`${segment.name}, ${segment.kind === "directory" ? "directory" : segment.kind === "file" ? "file" : "aggregate"}, ${displayedSize.value}, ${segment.percentage.toFixed(1)} percent${count}${state}`}
          onClick={() => onActivate(segment)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return
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

function segmentColor(segment: ChartSegment): string {
  if (segment.kind === "other" || segment.kind === "unavailable") return "#89909a"
  const hue = hash(segment.colorKey) % 360
  const lightness = Math.max(30, 55 - (segment.depth - 1) * 5)
  return `hsl(${hue} 58% ${lightness}%)`
}

function hash(value: string): number {
  let result = 0
  for (let index = 0; index < value.length; index += 1) result = (result * 31 + value.charCodeAt(index)) >>> 0
  return result
}

function formatItemCount(value: number): string {
  return `${value.toLocaleString()} item${value === 1 ? "" : "s"}`
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1 }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}
