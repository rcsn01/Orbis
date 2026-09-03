/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Sunburst } from '../src/renderer/Sunburst'
import type { SunburstTransition } from '../src/renderer/Sunburst'
import type { ChartSegment } from '../src/shared/contracts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const base: ChartSegment = {
  id: 'n-folder', name: 'Folder', kind: 'directory', depth: 1, startAngle: 0, endAngle: 90,
  sizeBytes: 0, percentage: 0, drillable: true, colorKey: 'root:n-folder', scanState: 'queued', sizeAccuracy: 'estimated'
}

function transition(direction: 'enter' | 'exit', parentSegments: readonly ChartSegment[], childSegments: readonly ChartSegment[], anchor: ChartSegment, navigationToken = 1): SunburstTransition {
  return { direction, navigationToken, parentSegments, childSegments, anchor, targetFolderId: anchor.id ?? 'aggregated-folder', depthOffset: anchor.depth, centerRadius: 48 }
}

describe('progressive Orbis renderer', () => {
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

  it('uses one decorative transition layer while hiding and disabling semantic destination bars', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const child = { ...base, id: 'child', name: 'Child', startAngle: 0, endAngle: 360, colorKey: 'root:child' }
    const { container } = render(<Sunburst segments={[child]} transition={transition('enter', [base], [child], base)} onActivate={vi.fn()} />)

    expect(container.querySelectorAll('.orbis-feature-panel__sunburst-transition')).toHaveLength(1)
    expect(container.querySelector('.orbis-feature-panel__sunburst-semantic-bars--hidden')).not.toBeNull()
    expect(container.querySelector('.orbis-feature-panel__sunburst-current')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: /Child/ })).toHaveAttribute('tabindex', '-1')
    const layer = container.querySelector('.orbis-feature-panel__sunburst-transition')
    expect(layer).toHaveAttribute('aria-hidden', 'true')
    expect(layer).toHaveAttribute('focusable', 'false')
    expect(layer?.querySelector('[role], [tabindex]')).toBeNull()
  })

  it('cancels an interrupted navigation and keeps interaction disabled until completion', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    const cancelAnimationFrame = vi.fn()
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { const id = ++nextFrame; callbacks.set(id, callback); return id }))
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    const child = { ...base, id: 'child', name: 'Child', colorKey: 'root:child' }
    const first = transition('enter', [base], [child], base, 1)
    const secondAnchor = { ...base, id: 'second', startAngle: 90, endAngle: 180, colorKey: 'root:second' }
    const second = transition('enter', [secondAnchor], [child], secondAnchor, 2)
    const onTransitionComplete = vi.fn()
    const { container, rerender } = render(<Sunburst segments={[child]} transition={first} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)

    rerender(<Sunburst segments={[child]} transition={{ ...first, childSegments: [{ ...child }] }} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)
    expect(cancelAnimationFrame).not.toHaveBeenCalled()
    rerender(<Sunburst segments={[child]} transition={second} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1)
    act(() => callbacks.get(2)?.(400))
    expect(container.querySelector('.orbis-feature-panel__sunburst-current')).toHaveAttribute('data-interactive', 'false')
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '-1')
    act(() => callbacks.get(3)?.(640))
    expect(container.querySelector('.orbis-feature-panel__sunburst-transition')).toBeNull()
    expect(container.querySelector('.orbis-feature-panel__sunburst-current')).toHaveAttribute('data-interactive', 'true')
    expect(screen.getByRole('button')).toHaveAttribute('tabindex', '0')
    expect(onTransitionComplete).toHaveBeenCalledOnce()
  })

  it('clears an open tooltip when navigation starts', () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const child = { ...base, id: 'child', name: 'Child', colorKey: 'root:child' }
    const { rerender } = render(<Sunburst segments={[base]} onActivate={vi.fn()} />)
    fireEvent.mouseEnter(screen.getByRole('button', { name: /Folder/ }), { clientX: 10, clientY: 20 })
    expect(screen.getByRole('tooltip')).toBeInTheDocument()

    rerender(<Sunburst segments={[child]} transition={transition('enter', [base], [child], base)} onActivate={vi.fn()} />)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })

  it('runs navigation with reduced motion enabled', () => {
    let animationFrame: FrameRequestCallback | undefined
    vi.spyOn(performance, 'now').mockReturnValue(0)
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { animationFrame = callback; return 1 }))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })))
    const child = { ...base, id: 'child', colorKey: 'root:child' }
    const onTransitionComplete = vi.fn()
    const { container } = render(<Sunburst segments={[child]} transition={transition('enter', [base], [child], base)} onTransitionComplete={onTransitionComplete} onActivate={vi.fn()} />)

    expect(container.querySelector('.orbis-feature-panel__sunburst-transition')).not.toBeNull()
    act(() => animationFrame?.(640))
    expect(container.querySelector('.orbis-feature-panel__sunburst-transition')).toBeNull()
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

  it('shows the current folder size in the center', () => {
    render(<Sunburst segments={[{ ...base, sizeBytes: 4096, percentage: 2.8, endAngle: 10.08 }]} folderSizeBytes={4096} onActivate={vi.fn()} />)
    expect(screen.getByText('4.0 KB')).toHaveClass('orbis-feature-panel__sunburst-center-label')
    expect(screen.queryByText('disk capacity')).toBeNull()
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
