import { describe, expect, it } from 'vitest'
import {
  createControllerTimingMilestones, createScanTimingMilestones, isResumePreparationPhase, RESUME_PREPARATION_PHASES,
  runWithScanDiagnostics, subscribeControllerDiagnostics, subscribeScanDiagnostics, type OrbisTimingEvent
} from '../src/main/diagnostics'

describe('resume preparation phases', () => {
  it('accepts exactly the fixed preparation vocabulary', () => {
    for (const phase of RESUME_PREPARATION_PHASES) expect(isResumePreparationPhase(phase)).toBe(true)
    for (const value of ['unknown', '', 1, null, undefined, {}, ['validating']]) expect(isResumePreparationPhase(value)).toBe(false)
  })
})

describe('resume diagnostic milestones', () => {
  it('shares one scan epoch, publishes once, and preserves generation', () => {
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeScanDiagnostics((event) => events.push(event))
    let now = 10
    try {
      runWithScanDiagnostics(7, () => {
        const timing = createScanTimingMilestones(() => now)
        now = 15
        timing.mark('first')
        now = 18
        timing.mark('first')
        timing.mark('second')
      })
      expect(events).toEqual([
        { scope: 'scan', phase: 'first', durationMs: 5, generation: 7 },
        { scope: 'scan', phase: 'second', durationMs: 8, generation: 7 }
      ])
    } finally { unsubscribe() }
  })

  it('shares one controller epoch and clamps a backwards clock to zero', () => {
    const events: OrbisTimingEvent[] = []
    const unsubscribe = subscribeControllerDiagnostics((event) => events.push(event))
    let now = 20
    try {
      const timing = createControllerTimingMilestones(() => now)
      now = 19
      timing.mark(4, 'zero')
      now = 24
      timing.mark(4, 'later')
      timing.mark(4, 'later')
      expect(events).toEqual([
        { scope: 'controller', phase: 'zero', durationMs: 0, generation: 4 },
        { scope: 'controller', phase: 'later', durationMs: 4, generation: 4 }
      ])
    } finally { unsubscribe() }
  })

  it('is inert without subscribers', () => {
    expect(() => {
      createScanTimingMilestones(() => { throw new Error('clock should not run') }).mark('ignored')
      createControllerTimingMilestones(() => { throw new Error('clock should not run') }).mark(1, 'ignored')
    }).not.toThrow()
  })
})
