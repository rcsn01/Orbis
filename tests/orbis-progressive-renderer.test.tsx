/** @vitest-environment jsdom */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { segmentColor, Sunburst } from '../src/renderer/Sunburst'
import type { ChartSegment } from '../src/shared/contracts'

afterEach(cleanup)

const base: ChartSegment = {
  id: 'n-folder', name: 'Folder', kind: 'directory', depth: 1, startAngle: 0, endAngle: 90,
  sizeBytes: 0, percentage: 0, drillable: true, colorKey: 'root:n-folder', scanState: 'queued', sizeAccuracy: 'estimated'
}

describe('progressive Orbis renderer', () => {
  it('keeps nearby nested segments in the same color family', () => {
    const parent = { ...base, startAngle: 0, endAngle: 80 }
    const firstChild = { ...base, depth: 2, startAngle: 0, endAngle: 40, colorKey: 'root:n-folder:first' }
    const secondChild = { ...base, depth: 2, startAngle: 40, endAngle: 80, colorKey: 'root:n-folder:second' }
    const distantBranch = { ...base, startAngle: 180, endAngle: 260, colorKey: 'root:n-distant' }

    expect(segmentColor(parent)).toBe('hsl(260 68% 54%)')
    expect(segmentColor(firstChild)).toBe('hsl(240 68% 56%)')
    expect(segmentColor(secondChild)).toBe('hsl(280 68% 56%)')
    expect(segmentColor(distantBranch)).toBe('hsl(80 68% 54%)')
  })

  it('uses five normal rings followed by five thin rings', () => {
    const fifth = { ...base, id: 'level-5', depth: 5, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five' }
    const sixth = { ...base, id: 'level-6', depth: 6, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five:six' }
    const tenth = { ...base, id: 'level-10', depth: 10, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five:six:seven:eight:nine:ten' }
    const { container } = render(<Sunburst segments={[fifth, sixth, tenth]} onActivate={vi.fn()} />)

    expect(container.querySelector('[data-depth="5"]')).toHaveAttribute('data-inner-radius', '217')
    expect(container.querySelector('[data-depth="5"]')).toHaveAttribute('data-outer-radius', '257')
    expect(container.querySelector('[data-depth="6"]')).toHaveAttribute('data-inner-radius', '259')
    expect(container.querySelector('[data-depth="6"]')).toHaveAttribute('data-outer-radius', '267')
    expect(container.querySelector('[data-depth="10"]')).toHaveAttribute('data-outer-radius', '307')
    expect(container.querySelector('.orbis-feature-panel__sunburst-geometry')).toHaveAttribute('data-outer-radius', '308')
  })

  it('hatches provisional segments and identifies their state accessibly', () => {
    const { container } = render(<Sunburst segments={[base]} onActivate={vi.fn()} />)
    expect(container.querySelector('pattern#orbis-provisional-hatch')).not.toBeNull()
    expect(container.querySelector('.orbis-feature-panel__sunburst-hatch')).not.toBeNull()
    expect(screen.getByRole('button', { name: /Folder, directory, 0 B, 0.0 percent, Estimated/ })).toBeInTheDocument()
  })

  it('shows the currently known size for an unfinished folder without an estimate', () => {
    render(<Sunburst segments={[{ ...base, sizeBytes: 4096, sizeAccuracy: 'partial' }]} onActivate={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Folder, directory, 4\.0 KB, 0.0 percent, Scanning/ })).toBeInTheDocument()
  })

  it('labels the partial root circle as a share of disk capacity', () => {
    render(<Sunburst segments={[{ ...base, sizeBytes: 4096, percentage: 2.8, endAngle: 10.08 }]} diskUsagePercentage={2.8} onActivate={vi.fn()} />)
    expect(screen.getByText('2.8%')).toBeInTheDocument()
    expect(screen.getByText('disk capacity')).toBeInTheDocument()
  })

  it('removes hatching when a segment becomes complete', () => {
    const { container, rerender } = render(<Sunburst segments={[base]} onActivate={vi.fn()} />)
    rerender(<Sunburst segments={[{ ...base, scanState: 'complete' }]} onActivate={vi.fn()} />)
    expect(container.querySelector('.orbis-feature-panel__sunburst-hatch')).toBeNull()
  })

  it('describes an aggregate segment with its represented item count', () => {
    render(<Sunburst segments={[{ ...base, id: null, name: 'Other', kind: 'other', sizeBytes: 4096, percentage: 40, drillable: false, itemCount: 42, scanState: 'complete', sizeAccuracy: 'exact' }]} onActivate={vi.fn()} />)
    expect(screen.getByRole('button', { name: /Other, aggregate, 4\.0 KB, 40\.0 percent, 42 items, Exact/ })).toBeInTheDocument()
  })

  it('does not describe an unfinished zero-child folder as empty', () => {
    render(<Sunburst segments={[]} provisionalState="scanning" onActivate={vi.fn()} />)
    expect(screen.getByText('Scanning this folder')).toBeInTheDocument()
    expect(screen.queryByText('No readable contents')).toBeNull()
  })
})
