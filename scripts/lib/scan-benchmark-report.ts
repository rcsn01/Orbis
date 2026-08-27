import { RESUME_SCAN_PHASES, SCAN_COUNTER_NAMES, type ScanCounterRecord } from '../../src/main/diagnostics'

export const SCAN_BENCHMARK_SCHEMA_VERSION = 8
export const RESUME_BENCHMARK_SCENARIOS = ['resume-clean-pause', 'resume-process-restart', 'resume-unacknowledged-pause'] as const
export type ResumeBenchmarkScenario = typeof RESUME_BENCHMARK_SCENARIOS[number]

export interface ResumeBenchmarkSample {
  readonly validation: 'full' | 'receipt' | 'receipt-fallback'
  readonly clickToPreparationMs: number
  readonly clickToFirstProgressMs: number
  readonly clickToFirstMetadataPageMs: number
  readonly clickToFirstMetadataPreviewMs: number
  readonly workerToFirstMetadataPageMs: number
  readonly completionMs: number
  readonly phases: Readonly<Record<string, number>>
  readonly counters: ScanCounterRecord
}

export interface ScanBenchmarkReport {
  readonly schemaVersion: number
  readonly environment: unknown
  readonly fixtures: readonly {
    readonly samples: readonly {
      readonly scenario: string
      readonly counters: ScanCounterRecord
      readonly resume?: ResumeBenchmarkSample
    }[]
  }[]
}

export function isResumeBenchmarkScenario(value: string): value is ResumeBenchmarkScenario {
  return (RESUME_BENCHMARK_SCENARIOS as readonly string[]).includes(value)
}

export function validateScanBenchmarkReport(value: unknown): asserts value is ScanBenchmarkReport {
  if (!value || typeof value !== 'object') throw new Error('Benchmark report must be an object')
  const report = value as Partial<ScanBenchmarkReport>
  if (report.schemaVersion !== SCAN_BENCHMARK_SCHEMA_VERSION) throw new Error(`Benchmark report schema must be ${SCAN_BENCHMARK_SCHEMA_VERSION}`)
  if (!Array.isArray(report.fixtures)) throw new Error('Benchmark report fixtures must be an array')
  for (const fixture of report.fixtures) {
    if (!fixture || !Array.isArray(fixture.samples)) throw new Error('Benchmark fixture samples must be an array')
    for (const sample of fixture.samples) {
      if (!sample || typeof sample.scenario !== 'string') throw new Error('Benchmark sample scenario is invalid')
      validateCounters(sample.counters)
      if (isResumeBenchmarkScenario(sample.scenario)) {
        if (!sample.resume) throw new Error(`Resume benchmark sample ${sample.scenario} has no resume metrics`)
        validateResume(sample.resume)
      } else if (sample.resume !== undefined) throw new Error(`Non-resume benchmark sample ${sample.scenario} has resume metrics`)
    }
  }
}

function validateResume(resume: ResumeBenchmarkSample): void {
  if (resume.validation !== 'full' && resume.validation !== 'receipt' && resume.validation !== 'receipt-fallback') throw new Error('Resume validation classification is invalid')
  for (const [name, duration] of Object.entries({
    clickToPreparationMs: resume.clickToPreparationMs,
    clickToFirstProgressMs: resume.clickToFirstProgressMs,
    clickToFirstMetadataPageMs: resume.clickToFirstMetadataPageMs,
    clickToFirstMetadataPreviewMs: resume.clickToFirstMetadataPreviewMs,
    workerToFirstMetadataPageMs: resume.workerToFirstMetadataPageMs,
    completionMs: resume.completionMs
  })) assertDuration(duration, name)
  if (!resume.phases || typeof resume.phases !== 'object' || Array.isArray(resume.phases)) throw new Error('Resume phases are invalid')
  const actualPhases = Object.keys(resume.phases).sort()
  const expectedPhases: string[] = [...RESUME_SCAN_PHASES].sort()
  const legacyOptionalPhases = ['resume-aggregate-fallback']
  const missingRequired = expectedPhases.some((phase) => !actualPhases.includes(phase))
  const unknown = actualPhases.some((phase) => !expectedPhases.includes(phase) && !legacyOptionalPhases.includes(phase))
  if (missingRequired || unknown) throw new Error('Resume phases do not match the diagnostic schema')
  for (const phase of RESUME_SCAN_PHASES) assertDuration(resume.phases[phase], phase)
  for (const phase of legacyOptionalPhases) if (actualPhases.includes(phase)) assertDuration(resume.phases[phase], phase)
  validateCounters(resume.counters)
}

function validateCounters(value: unknown): asserts value is ScanCounterRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Benchmark counters are invalid')
  const counters = value as Record<string, unknown>
  const actual = Object.keys(counters).sort()
  const expected = [...SCAN_COUNTER_NAMES].sort()
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) throw new Error('Benchmark counters do not match the diagnostic schema')
  for (const name of SCAN_COUNTER_NAMES) {
    const count = counters[name]
    if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) throw new Error(`Benchmark counter ${name} is invalid`)
  }
}

function assertDuration(value: unknown, name: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Benchmark timing ${name} is invalid`)
}
