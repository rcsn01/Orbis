import { useState } from "react"
import type { ChartSegment } from "@shared/contracts"

interface SunburstProps {
  readonly segments: readonly ChartSegment[]
  readonly onActivate: (segment: ChartSegment) => void
}

export function Sunburst({ segments, onActivate }: SunburstProps): React.JSX.Element {
  const [tooltip, setTooltip] = useState<{ readonly segment: ChartSegment; readonly x: number; readonly y: number }>()
  const maxDepth = Math.max(1, ...segments.map((segment) => segment.depth))
  const ringWidth = 42
  const innerRadius = 48
  const outerRadius = innerRadius + maxDepth * ringWidth
  const center = 300
  return <div className="sunburst-wrap">
    <svg className="sunburst" viewBox="0 0 600 600" role="group" aria-label="Disk usage sunburst">
      <title>Disk usage. Select a segment to inspect it.</title>
      {segments.map((segment) => {
        const inner = innerRadius + (segment.depth - 1) * ringWidth + 1
        const outer = innerRadius + segment.depth * ringWidth - 1
        return <path
          key={`${segment.depth}-${segment.id ?? segment.name}-${segment.startAngle}`}
          d={ringPath(center, center, inner, outer, segment.startAngle, segment.endAngle)}
          fill={segmentColor(segment)}
          className="sunburst-segment"
          role="button"
          tabIndex={0}
          aria-disabled={!segment.drillable && segment.id === null ? true : undefined}
          aria-label={`${segment.name}, ${segment.kind === "directory" ? "directory" : segment.kind === "file" ? "file" : "aggregate"}, ${formatBytes(segment.sizeBytes)}, ${segment.percentage.toFixed(1)} percent`}
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
      })}
      <circle cx={center} cy={center} r={innerRadius - 2} className="sunburst-center" />
      <text x={center} y={center - 4} textAnchor="middle" className="sunburst-center-label">100%</text>
      <text x={center} y={center + 17} textAnchor="middle" className="sunburst-center-caption">selected folder</text>
    </svg>
    {tooltip && <div className="sunburst-tooltip" role="tooltip" style={{ left: tooltip.x + 12, top: tooltip.y + 12 }}>
      <strong>{tooltip.segment.name}</strong>
      <span>{formatBytes(tooltip.segment.sizeBytes)} · {tooltip.segment.percentage.toFixed(1)}%</span>
    </div>}
    {segments.length === 0 && <div className="sunburst-empty">No readable contents</div>}
    <span className="sunburst-geometry" aria-hidden="true" data-outer-radius={outerRadius} />
  </div>
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

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KB", "MB", "GB", "TB", "PB"]
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1 }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`
}
