/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { animatedSegmentGeometry, segmentColor, Sunburst } from '../src/renderer/Sunburst'
import type { ChartSegment } from '../src/shared/contracts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const base: ChartSegment = {
  id: 'n-folder', name: 'Folder', kind: 'directory', depth: 1, startAngle: 0, endAngle: 90,
  sizeBytes: 0, percentage: 0, drillable: true, colorKey: 'root:n-folder', scanState: 'queued', sizeAccuracy: 'estimated'
}

describe('progressive Orbis renderer', () => {
  it('uses pleasant colors first and keeps nested segments in their parent color family', () => {
    const parent = { ...base, startAngle: 0, endAngle: 80 }
    const onlyChild = { ...base, depth: 2, startAngle: 0, endAngle: 80, colorKey: 'root:n-folder:only' }
    const firstChild = { ...base, depth: 2, startAngle: 0, endAngle: 40, colorKey: 'root:n-folder:first' }
    const secondChild = { ...base, depth: 2, startAngle: 40, endAngle: 80, colorKey: 'root:n-folder:second' }
    const blueBranch = { ...base, startAngle: 80, endAngle: 180, colorKey: 'root:n-blue' }
    const yellowBranch = { ...base, startAngle: 180, endAngle: 260, colorKey: 'root:n-yellow' }
    const chart = [parent, firstChild, secondChild, blueBranch, yellowBranch]

    expect(segmentColor(parent, chart)).toBe('hsl(132 64% 62%)')
    expect(segmentColor(onlyChild, chart)).toBe('hsl(144 64% 64%)')
    expect(segmentColor(firstChild, chart)).toBe('hsl(124 64% 59%)')
    expect(segmentColor(secondChild, chart)).toBe('hsl(164 64% 69%)')
    expect(segmentColor(blueBranch, chart)).toBe('hsl(198 72% 64%)')
    expect(segmentColor(yellowBranch, chart)).toBe('hsl(52 78% 64%)')
  })

  it('uses five normal rings followed by five thin rings', () => {
    const fifth = { ...base, id: 'level-5', depth: 5, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five' }
    const sixth = { ...base, id: 'level-6', depth: 6, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five:six' }
    const tenth = { ...base, id: 'level-10', depth: 10, startAngle: 0, endAngle: 45, colorKey: 'root:one:two:three:four:five:six:seven:eight:nine:ten' }
    const { container } = render(<Sunburst segments={[fifth, sixth, tenth]} onActivate={vi.fn()} />)

    expect(container.querySelector('[data-depth="5"]')).toHaveAttribute('data-inner-radius', '216')
    expect(container.querySelector('[data-depth="5"]')).toHaveAttribute('data-outer-radius', '258')
    expect(container.querySelector('[data-depth="6"]')).toHaveAttribute('data-inner-radius', '259')
    expect(container.querySelector('[data-depth="6"]')).toHaveAttribute('data-outer-radius', '267')
    expect(container.querySelector('[data-depth="10"]')).toHaveAttribute('data-outer-radius', '307')
    expect(container.querySelector('.orbis-feature-panel__sunburst-geometry')).toHaveAttribute('data-outer-radius', '308')
  })

  it('expands proportional slices of a focused folder into the new chart geometry', () => {
    const nextSegment = { ...base, depth: 1, startAngle: 0, endAngle: 120 }
    const origin = { depth: 3, startAngle: 90, endAngle: 150 }

    expect(animatedSegmentGeometry(nextSegment, origin, 0)).toEqual({ inner: 132, outer: 174, startAngle: 90, endAngle: 110 })
    expect(animatedSegmentGeometry(nextSegment, origin, 1)).toEqual({ inner: 48, outer: 90, startAngle: 0, endAngle: 120 })
    expect(animatedSegmentGeometry(nextSegment, origin, 0.5)).toEqual({ inner: 58.5, outer: 100.5, startAngle: 11.25, endAngle: 118.75 })
  })

  it('keeps deeper contents collapsed at the folder edge until their stagger begins', () => {
    const nestedSegment = { ...base, depth: 3, startAngle: 120, endAngle: 240 }
    const immediateSegment = { ...nestedSegment, depth: 1 }
    const origin = { depth: 2, startAngle: 90, endAngle: 180 }

    expect(animatedSegmentGeometry(nestedSegment, origin, 0.1)).toEqual({ inner: 132, outer: 132, startAngle: 120, endAngle: 150 })
    expect(animatedSegmentGeometry(immediateSegment, origin, 0.1)).not.toEqual(animatedSegmentGeometry(immediateSegment, origin, 0))
    expect(animatedSegmentGeometry(nestedSegment, origin, 1)).toEqual({ inner: 132, outer: 174, startAngle: 120, endAngle: 240 })
  })

  it('cancels an interrupted expansion and restores interaction near its end', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const cancelAnimationFrame = vi.fn()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      const frame = ++nextFrame
      callbacks.set(frame, callback)
      return frame
    }))
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const onTransitionComplete = vi.fn()
    const firstOrigin = { depth: 2, startAngle: 0, endAngle: 90 }
    const secondOrigin = { depth: 2, startAngle: 90, endAngle: 180 }
    const { container, rerender } = render(<Sunburst segments={[base]} transitionOrigin={firstOrigin} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)

    expect(container.querySelector('svg')).toHaveAttribute('data-interactive', 'false')
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1')
    rerender(<Sunburst segments={[base]} transitionOrigin={secondOrigin} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)

    act(() => callbacks.get(2)?.(336))
    expect(container.querySelector('svg')).toHaveAttribute('data-interactive', 'true')
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0')
    act(() => callbacks.get(3)?.(480))
    expect(container.querySelector('svg')).toHaveAttribute('aria-busy', 'false')
    expect(onTransitionComplete).toHaveBeenCalledOnce()
  })

  it('runs folder expansion even when reduced motion is requested', () => {
    let animationFrame: FrameRequestCallback | undefined
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { animationFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const onTransitionComplete = vi.fn()
    const { container } = render(<Sunburst segments={[base]} transitionOrigin={{ depth: 2, startAngle: 90, endAngle: 180 }} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)

    expect(container.querySelector('svg')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button')).toHaveAttribute('data-start-angle', '90')
    expect(screen.getByRole('button')).toHaveAttribute('data-end-angle', '112.5')
    act(() => animationFrame?.(480))
    expect(container.querySelector('svg')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('button')).toHaveAttribute('data-start-angle', '0')
    expect(screen.getByRole('button')).toHaveAttribute('data-end-angle', '90')
    expect(onTransitionComplete).toHaveBeenCalledOnce()
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

  it('opens context menus only for concrete segments', () => {
    const onContextMenu = vi.fn()
    render(<Sunburst segments={[base, { ...base, id: null, name: 'Other', kind: 'other', drillable: false, colorKey: 'other' }]} onActivate={vi.fn()} onContextMenu={onContextMenu} />)
    const concrete = screen.getByRole('button', { name: /Folder, directory/ })
    const aggregate = screen.getByRole('button', { name: /Other, aggregate/ })

    expect(fireEvent.contextMenu(concrete)).toBe(false)
    expect(onContextMenu).toHaveBeenCalledWith(base)
    expect(fireEvent.contextMenu(aggregate)).toBe(true)
    expect(onContextMenu).toHaveBeenCalledOnce()
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
