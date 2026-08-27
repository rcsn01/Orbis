import { describe, expect, it } from 'vitest'
import { emptyScanCounters, RESUME_SCAN_PHASES } from '../src/main/diagnostics'
import {
  SCAN_BENCHMARK_SCHEMA_VERSION, validateScanBenchmarkReport, type ResumeBenchmarkSample
} from '../scripts/lib/scan-benchmark-report'

function resume(): ResumeBenchmarkSample {
  return {
    validation: 'full', clickToPreparationMs: 1, clickToFirstProgressMs: 2,
    clickToFirstMetadataPageMs: 3, clickToFirstMetadataPreviewMs: 4,
    workerToFirstMetadataPageMs: 2, completionMs: 10,
    phases: Object.fromEntries(RESUME_SCAN_PHASES.map((phase) => [phase, 1])),
    counters: emptyScanCounters()
  }
}

function report(scenario = 'initial-full', value?: ResumeBenchmarkSample) {
  return {
    schemaVersion: SCAN_BENCHMARK_SCHEMA_VERSION,
    environment: {},
    fixtures: [{ samples: [{ scenario, counters: emptyScanCounters(), ...(value ? { resume: value } : {}) }] }]
  }
}

describe('scan benchmark report schema', () => {
  it('accepts non-resume and complete resume reports', () => {
    expect(() => validateScanBenchmarkReport(report())).not.toThrow()
    expect(() => validateScanBenchmarkReport(report('resume-clean-pause', resume()))).not.toThrow()
  })

  it('rejects the wrong schema and missing resume metrics', () => {
    expect(() => validateScanBenchmarkReport({ ...report(), schemaVersion: 7 })).toThrow(/schema/)
    expect(() => validateScanBenchmarkReport(report('resume-process-restart'))).toThrow(/no resume metrics/)
  })

  it('accepts an optional aggregate fallback work phase', () => {
    const value = resume()
    ;(value.phases as Record<string, number>)['resume-aggregate-fallback'] = 1
    expect(() => validateScanBenchmarkReport(report('resume-clean-pause', value))).not.toThrow()
  })

  it('rejects missing counters and invalid durations', () => {
    const missing = report()
    delete (missing.fixtures[0]!.samples[0]!.counters as Partial<Record<'fullScanAttempts', number>>).fullScanAttempts
    expect(() => validateScanBenchmarkReport(missing)).toThrow(/counters/)
    const missingPhase = resume()
    delete (missingPhase.phases as Record<string, number>)['resume-load-total']
    expect(() => validateScanBenchmarkReport(report('resume-clean-pause', missingPhase))).toThrow(/phases/)
    expect(() => validateScanBenchmarkReport(report('resume-clean-pause', { ...resume(), clickToFirstProgressMs: -1 }))).toThrow(/timing/)
  })
})
