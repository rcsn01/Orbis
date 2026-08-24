import { describe, expect, it } from "vitest"
import { createOrderedConcurrentMapper } from "../../../packages/feature-orbis/src/main/ordered-concurrent-map"

describe("orderedConcurrentMap", () => {
  it("keeps a bounded sliding window and yields in input order", async () => {
    const mapper = createOrderedConcurrentMapper(3)
    let releaseFirst: (() => void) | undefined
    const firstReleased = new Promise<void>((resolveFirst) => { releaseFirst = resolveFirst })
    let started = 0
    let maximumActive = 0
    let active = 0
    const consume = async (): Promise<number[]> => {
      const output: number[] = []
      for await (const value of mapper.map([0, 1, 2, 3, 4, 5], {}, async (item) => {
        started += 1
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try { if (item === 0) await firstReleased; return item * 2 }
        finally { active -= 1 }
      })) output.push(value)
      return output
    }
    const result = consume()
    await waitUntil(() => started === 3)
    expect(started).toBe(3)
    releaseFirst?.()
    await expect(result).resolves.toEqual([0, 2, 4, 6, 8, 10])
    expect(maximumActive).toBeLessThanOrEqual(3)
    expect(maximumActive).toBeGreaterThan(1)
  })

  it("reserves admission capacity for deeply nested consumers", async () => {
    const mapper = createOrderedConcurrentMapper(4)
    let visited = 0
    const visit = async (depth: number): Promise<void> => {
      for await (const item of mapper.map([0, 1, 2, 3], {}, async (value) => value)) {
        visited += 1
        if (item === 0 && depth > 0) await visit(depth - 1)
      }
    }
    await visit(20)
    expect(visited).toBe(84)
  })

  it("drains admitted work when the consumer stops early", async () => {
    const mapper = createOrderedConcurrentMapper(3)
    let active = 0
    let completed = 0
    for await (const _value of mapper.map([0, 1, 2, 3, 4], {}, async (item) => {
      active += 1
      try { await new Promise((resolveDelay) => setTimeout(resolveDelay, 5)); return item }
      finally { active -= 1; completed += 1 }
    })) break
    expect(active).toBe(0)
    expect(completed).toBeGreaterThanOrEqual(3)
    expect(completed).toBeLessThanOrEqual(4)
  })

  it("drains admitted work without admitting more after an error", async () => {
    const mapper = createOrderedConcurrentMapper(3)
    let started = 0
    const consume = async (): Promise<void> => {
      for await (const _value of mapper.map([0, 1, 2, 3, 4], {}, async (item) => {
        started += 1
        if (item === 0) throw new Error("failed")
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5))
        return item
      })) { /* Consume all output. */ }
    }
    await expect(consume()).rejects.toThrow("failed")
    expect(started).toBe(3)
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
  }
  throw new Error("Condition was not reached")
}
