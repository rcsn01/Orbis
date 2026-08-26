import { describe, expect, it } from 'vitest'
import { buildChart } from '../src/main/chart'
import type { DatabaseNode } from '../src/main/index-store'

const children = [
  { id: 'users', parentId: 'root', name: 'Users', path: '/Users', kind: 'directory' as const, sizeBytes: 26, confirmedBytes: 26, estimatedBytes: 0, directChildren: 1, descendantCount: 1, unreadableCount: 0, scanState: 'complete' as const, sizeAccuracy: 'exact' as const },
  { id: 'system', parentId: 'root', name: 'System', path: '/System', kind: 'directory' as const, sizeBytes: 74, confirmedBytes: 74, estimatedBytes: 0, directChildren: 1, descendantCount: 1, unreadableCount: 0, scanState: 'complete' as const, sizeAccuracy: 'exact' as const }
]
const root = { id: 'root', parentId: null, name: 'Disk', path: '/', kind: 'directory' as const, sizeBytes: 100, confirmedBytes: 100, estimatedBytes: 0, directChildren: 2, descendantCount: 2, unreadableCount: 0, scanState: 'complete' as const, sizeAccuracy: 'exact' as const }
const source = {
  getNode: (id: string) => id === root.id ? root : children.find((child) => child.id === id),
  getChildren: (id: string) => id === root.id ? children : [],
  countChildren: (id: string) => id === root.id ? children.length : 0
}

describe('Orbis chart disk-capacity scale', () => {
  it('leaves capacity outside the scanned root as a blank arc', () => {
    const chart = buildChart(source, root, { maxRings: 1, rootTotalBytes: 926 })
    const users = chart.find((segment) => segment.name === 'Users')

    expect(users?.percentage).toBeCloseTo(26 / 926 * 100)
    expect((users?.endAngle ?? 0) - (users?.startAngle ?? 0)).toBeCloseTo(26 / 926 * 360)
    expect(chart.at(-1)?.endAngle).toBeCloseTo(100 / 926 * 360)
    expect(chart.some((segment) => segment.name === 'Unscanned or system data')).toBe(false)
  })

  it('continues to fill the circle for a selected folder', () => {
    const chart = buildChart(source, root, { maxRings: 1 })

    expect(chart.at(-1)?.endAngle).toBe(360)
    expect(chart.reduce((sum, segment) => sum + segment.percentage, 0)).toBe(100)
  })

  it('combines root-ring sections smaller than three degrees into Other', () => {
    const chartRoot = directory('chart-root', null, 1_000, 3)
    const chartChildren = [file('large', chartRoot.id, 990), file('small-a', chartRoot.id, 5), file('small-b', chartRoot.id, 5)]
    const chart = buildChart(chartSource(chartRoot, new Map([[chartRoot.id, chartChildren]])), chartRoot, { maxRings: 1 })

    expect(chart.map((segment) => segment.name)).toEqual(['large', 'Other'])
    const other = chart[1]!
    expect(other.sizeBytes).toBe(10)
    expect(other.itemCount).toBe(2)
    expect(other.endAngle - other.startAngle).toBeCloseTo(3.6)
  })

  it('applies the three-degree minimum relative to each parent arc', () => {
    const chartRoot = directory('chart-root', null, 1_000, 2)
    const branch = directory('branch', chartRoot.id, 500, 3)
    const sibling = file('sibling', chartRoot.id, 500)
    const branchChildren = [file('large', branch.id, 490), file('small-a', branch.id, 5), file('small-b', branch.id, 5)]
    const chart = buildChart(chartSource(chartRoot, new Map([
      [chartRoot.id, [branch, sibling]],
      [branch.id, branchChildren]
    ])), chartRoot, { maxRings: 2 })

    const nested = chart.filter((segment) => segment.depth === 2)
    expect(nested.map((segment) => segment.name)).toEqual(['large', 'Other'])
    expect(nested[1]!.endAngle - nested[1]!.startAngle).toBeCloseTo(3.6)
  })

  it('keeps a section that occupies exactly three degrees', () => {
    const chartRoot = directory('chart-root', null, 120, 2)
    const chartChildren = [file('large', chartRoot.id, 119), file('three-degrees', chartRoot.id, 1)]
    const chart = buildChart(chartSource(chartRoot, new Map([[chartRoot.id, chartChildren]])), chartRoot, { maxRings: 1 })

    expect(chart.map((segment) => segment.name)).toEqual(['large', 'three-degrees'])
    expect(chart[1]!.endAngle - chart[1]!.startAngle).toBeCloseTo(3)
  })
})

type TestNode = DatabaseNode

function directory(id: string, parentId: string | null, sizeBytes: number, directChildren: number): TestNode {
  return { ...root, id, parentId, name: id, path: `/${id}`, sizeBytes, confirmedBytes: sizeBytes, directChildren }
}

function file(id: string, parentId: string, sizeBytes: number): TestNode {
  return { ...root, id, parentId, name: id, path: `/${id}`, kind: 'file', sizeBytes, confirmedBytes: sizeBytes, directChildren: 0 }
}

function chartSource(chartRoot: TestNode, byParent: ReadonlyMap<string, readonly TestNode[]>) {
  const nodes = [chartRoot, ...byParent.values()].flat()
  return {
    getNode: (id: string) => nodes.find((node) => node.id === id),
    getChildren: (id: string) => byParent.get(id) ?? [],
    countChildren: (id: string) => byParent.get(id)?.length ?? 0
  }
}
