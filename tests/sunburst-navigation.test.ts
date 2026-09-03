import { describe, expect, it } from 'vitest'
import type { ChartSegment } from '../src/shared/contracts'
import {
  createSunburstNavigationPlan,
  layoutSunburstSegments,
  sampleSunburstNavigation,
  segmentColor,
  SUNBURST_NAVIGATION_DURATION_MS,
  SUNBURST_NAVIGATION_STAGE_SPLIT
} from '../src/renderer/sunburst-navigation'

const branch: ChartSegment = {
  id: 'folder', name: 'Folder', kind: 'directory', depth: 1, startAngle: 0, endAngle: 240,
  sizeBytes: 100, percentage: 80, drillable: true, colorKey: 'root:folder', scanState: 'complete', sizeAccuracy: 'exact'
}

function segment(id: string | null, depth: number, startAngle: number, endAngle: number, colorKey: string, kind: ChartSegment['kind'] = 'directory'): ChartSegment {
  return { ...branch, id, name: id ?? 'Other', kind, depth, startAngle, endAngle, colorKey, drillable: id !== null && kind === 'directory' }
}

function plan(parentSegments: readonly ChartSegment[], childSegments: readonly ChartSegment[], anchor = branch, depthOffset = anchor.depth) {
  return createSunburstNavigationPlan({ parentSegments, childSegments, anchor, targetFolderId: anchor.id ?? 'aggregated', depthOffset, centerRadius: 48 })
}

describe('sunburst navigation planner', () => {
  it('keeps duration and stage split explicit', () => {
    expect(SUNBURST_NAVIGATION_DURATION_MS).toBe(1_920)
    expect(SUNBURST_NAVIGATION_STAGE_SPLIT).toBe(0.5)
  })

  it('lays out five normal rings followed by thin rings', () => {
    const bars = layoutSunburstSegments([
      segment('five', 5, 0, 40, 'root:a:b:c:d:five'),
      segment('six', 6, 0, 40, 'root:a:b:c:d:e:six'),
      segment('ten', 10, 0, 40, 'root:a:b:c:d:e:f:g:h:i:ten')
    ])
    expect(bars[0]?.geometry).toMatchObject({ inner: 216, outer: 258 })
    expect(bars[1]?.geometry).toMatchObject({ inner: 259, outer: 267 })
    expect(bars[2]?.geometry).toMatchObject({ inner: 299, outer: 307 })
  })

  it('holds all geometry fixed while parent context fades during entry stage one', () => {
    const sibling = segment('sibling', 1, 240, 360, 'root:sibling')
    const parentChild = segment('shared', 2, 30, 100, 'root:folder:shared')
    const child = segment('shared', 1, 0, 180, 'root:shared')
    const navigation = plan([branch, sibling, parentChild], [child])
    const start = sampleSunburstNavigation(navigation, 'enter', 0)
    const middle = sampleSunburstNavigation(navigation, 'enter', 0.25)

    expect(start.phase).toBe('context')
    expect(middle.phase).toBe('context')
    expect(middle.bars.find((bar) => bar.origin === 'exact')?.geometry).toEqual(start.bars.find((bar) => bar.origin === 'exact')?.geometry)
    expect(middle.bars.filter((bar) => bar.origin === 'context').map((bar) => bar.opacity)).toEqual([0.5, 0.5])
  })

  it('runs one canonical morph in exactly opposite directions', () => {
    const parentChild = segment('shared', 2, 30, 100, 'root:folder:shared')
    const child = segment('shared', 1, 0, 180, 'root:shared')
    const navigation = plan([branch, parentChild], [child])

    for (const canonicalProgress of [0, 0.2, 0.5, 0.8, 1]) {
      const entering = sampleSunburstNavigation(navigation, 'enter', 0.5 + canonicalProgress * 0.5)
      const exiting = sampleSunburstNavigation(navigation, 'exit', (1 - canonicalProgress) * 0.5)
      expect(exiting.bars).toEqual(entering.bars)
    }
  })

  it('keeps parent context absent until exit morphing has finished and then freezes morph geometry', () => {
    const sibling = segment('sibling', 1, 240, 360, 'root:sibling')
    const child = segment('child', 1, 0, 360, 'root:child')
    const navigation = plan([branch, sibling], [child])
    const duringMorph = sampleSunburstNavigation(navigation, 'exit', 0.25)
    const morphEnd = sampleSunburstNavigation(navigation, 'exit', 0.5)
    const duringReveal = sampleSunburstNavigation(navigation, 'exit', 0.75)

    expect(duringMorph.bars.some((bar) => bar.origin === 'context')).toBe(false)
    expect(morphEnd.bars.some((bar) => bar.origin === 'context')).toBe(false)
    expect(duringReveal.bars.filter((bar) => bar.origin === 'context').map((bar) => bar.opacity)).toEqual([0.5, 0.5])
    expect(duringReveal.bars.find((bar) => bar.origin !== 'context')?.geometry).toEqual(morphEnd.bars.find((bar) => bar.origin !== 'context')?.geometry)
  })

  it('matches exact nodes at their parent geometry across nested and ancestor depth offsets', () => {
    const parentDescendant = segment('shared', 3, 70, 110, 'root:folder:middle:shared')
    const child = segment('shared', 1, 0, 80, 'root:shared')
    const navigation = plan([branch, parentDescendant], [child], branch, 2)
    const parentFrame = sampleSunburstNavigation(navigation, 'enter', 0.5)

    expect(parentFrame.bars.find((bar) => bar.origin === 'exact')?.geometry).toEqual({ inner: 132, outer: 174, startAngle: 70, endAngle: 110 })
  })

  it('splits Other into weighted child roots and collapses nested descendants at its outer edge', () => {
    const other = segment(null, 2, 120, 180, 'root:folder:other', 'other')
    const first = segment('first', 1, 0, 120, 'root:first')
    const second = segment('second', 1, 120, 360, 'root:second')
    const nested = segment('nested', 2, 0, 60, 'root:first:nested')
    const navigation = plan([branch, other], [first, second, nested])
    const parentFrame = sampleSunburstNavigation(navigation, 'enter', 0.5)
    const aggregateBars = parentFrame.bars.filter((bar) => bar.origin === 'aggregate')

    expect(aggregateBars.map((bar) => bar.fill)).toEqual(['#89909a', '#89909a', '#89909a'])
    expect(aggregateBars.map((bar) => bar.strokeOpacity)).toEqual([0, 0, 0])
    expect(aggregateBars[0]?.geometry).toEqual({ inner: 90, outer: 132, startAngle: 120, endAngle: 140 })
    expect(aggregateBars[1]?.geometry).toEqual({ inner: 90, outer: 132, startAngle: 140, endAngle: 180 })
    expect(aggregateBars[2]?.geometry).toEqual({ inner: 132, outer: 132, startAngle: 120, endAngle: 130 })
  })

  it('maps children to the deepest of multiple independent Other wedges', () => {
    const parent = segment('parent', 2, 0, 120, 'root:folder:parent')
    const shallowOther = segment(null, 2, 120, 180, 'root:folder:other', 'other')
    const deepOther = segment(null, 3, 40, 80, 'root:folder:parent:other', 'other')
    const deepChild = segment('deep', 2, 0, 180, 'root:parent:deep')
    const shallowChild = segment('shallow', 1, 180, 360, 'root:shallow')
    const navigation = plan([branch, parent, shallowOther, deepOther], [deepChild, shallowChild])
    const frame = sampleSunburstNavigation(navigation, 'enter', 0.5)

    expect(frame.bars.find((bar) => bar.segment.id === 'deep')?.geometry.startAngle).toBe(40)
    expect(frame.bars.find((bar) => bar.segment.id === 'shallow')?.geometry.startAngle).toBe(120)
  })

  it('maps a child Other back to its corresponding parent Other', () => {
    const parentOther = segment(null, 2, 120, 180, 'root:folder:other', 'other')
    const childOther = segment(null, 1, 200, 360, 'root:other', 'other')
    const navigation = plan([branch, parentOther], [childOther])
    const parentFrame = sampleSunburstNavigation(navigation, 'enter', 0.5)

    expect(parentFrame.bars).toHaveLength(1)
    expect(parentFrame.bars[0]).toMatchObject({ origin: 'aggregate', fill: '#89909a', strokeOpacity: 0 })
    expect(parentFrame.bars[0]?.geometry).toEqual({ inner: 90, outer: 132, startAngle: 120, endAngle: 180 })
  })

  it('uses aggregate and projected tracks behind exact existing tracks', () => {
    const other = segment(null, 2, 120, 180, 'root:folder:other', 'other')
    const parentChild = segment('existing', 2, 0, 120, 'root:folder:existing')
    const exactChild = segment('existing', 1, 0, 120, 'root:existing')
    const aggregateChild = segment('aggregate-child', 1, 120, 240, 'root:aggregate-child')
    const navigation = plan([branch, parentChild, other], [exactChild, aggregateChild])
    const frame = sampleSunburstNavigation(navigation, 'enter', 0.75)

    expect(frame.bars.map((bar) => bar.origin)).toEqual(['aggregate', 'exact'])
  })

  it('geometrically collapses an unconsumed source Other instead of fading it in place', () => {
    const other = segment(null, 2, 120, 180, 'root:folder:other', 'other')
    const exactParent = segment('shared', 2, 0, 120, 'root:folder:shared')
    const child = segment('shared', 1, 0, 360, 'root:shared')
    const navigation = plan([branch, exactParent, other], [child])
    const parentFrame = sampleSunburstNavigation(navigation, 'enter', 0.5)
    const middleFrame = sampleSunburstNavigation(navigation, 'enter', 0.75)
    const childFrame = sampleSunburstNavigation(navigation, 'enter', 1)
    const residual = parentFrame.bars.find((bar) => bar.origin === 'residual')
    const middleResidual = middleFrame.bars.find((bar) => bar.origin === 'residual')

    expect(residual?.geometry).toMatchObject({ inner: 90, outer: 132, startAngle: 120, endAngle: 180 })
    expect(middleResidual?.geometry).not.toEqual(residual?.geometry)
    expect(childFrame.bars.some((bar) => bar.origin === 'residual')).toBe(false)
  })

  it('supports an aggregated anchor and empty chart endpoints', () => {
    const otherAnchor = segment(null, 1, 100, 180, 'root:other', 'other')
    const empty = createSunburstNavigationPlan({ parentSegments: [otherAnchor], childSegments: [], anchor: otherAnchor, targetFolderId: 'hidden-folder', depthOffset: 1, centerRadius: 48 })
    const child = segment('inside', 1, 0, 360, 'root:inside')
    const aggregated = createSunburstNavigationPlan({ parentSegments: [otherAnchor], childSegments: [child], anchor: otherAnchor, targetFolderId: 'hidden-folder', depthOffset: 1, centerRadius: 48 })

    expect(sampleSunburstNavigation(empty, 'enter', 1).bars).toEqual([])
    expect(sampleSunburstNavigation(aggregated, 'enter', 0.5).bars[0]).toMatchObject({ origin: 'aggregate', fill: '#89909a' })
  })

  it('retains the established color palette', () => {
    const colorBranch = { ...branch, endAngle: 80 }
    const child = segment('child', 2, 0, 80, 'root:folder:child')
    const sibling = segment('sibling', 1, 80, 180, 'root:sibling')
    expect(segmentColor(colorBranch, [colorBranch, child, sibling])).toBe('hsl(132 64% 62%)')
    expect(segmentColor(child, [colorBranch, child, sibling])).toBe('hsl(144 64% 64%)')
    expect(segmentColor(sibling, [colorBranch, child, sibling])).toBe('hsl(198 72% 64%)')
  })
})
