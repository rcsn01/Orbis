import { DatabaseSync } from 'node:sqlite'
import { link, mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus, release, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { spawnSync } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import { OrbisController, type OrbisWorker, type OrbisWorkerFactory } from '../src/main/controller'
import { subscribeControllerDiagnostics, type OrbisTimingEvent } from '../src/main/diagnostics'
import { DEFAULT_METADATA_CONCURRENCY, type ScanResult } from '../src/main/scanner'
import { createScanFixture, type ScanFixtureManifest, type ScanFixtureName, type ScanFixtureProfile } from './lib/scan-fixtures'

interface BenchmarkOptions {
  readonly workerPath: string
  readonly nativeAddonPath?: string
  readonly profile: ScanFixtureProfile
  readonly samples: number
  readonly warmup: number
  readonly fixtures: readonly PerformanceFixture[]
  readonly outputPath: string
  readonly target?: string
  readonly allowLiveTarget: boolean
  readonly cacheState: string
  readonly timeoutMs: number
  readonly metadataConcurrency: number
  readonly batchSize: number
  readonly scanner: 'progressive' | 'legacy'
  readonly scenario: RefreshScenario
}

type RefreshScenario = 'initial-full' | 'warm-no-change' | 'one-file-allocation' | 'directory-rename' | 'hardlink-owner-change' | 'dropped-history-fallback'

type PerformanceFixture = ScanFixtureName
type LiveManifest = { readonly name: 'live'; readonly profile: 'live'; readonly isStartup: boolean }

interface TimingSummary { readonly min: number; readonly median: number; readonly p95: number; readonly max: number; readonly medianAbsoluteDeviation: number }

interface SampleReport {
  readonly sample: number
  readonly scenario: RefreshScenario
  readonly outcomeKind: 'candidate' | 'unchanged'
  readonly strategy: 'full' | 'incremental'
  readonly fallbackReason: string | null
  readonly workerStartupMs: number
  readonly workerRunMs: number
  readonly scanTotalMs: number
  readonly scanTimings: Readonly<Record<string, number>>
  readonly scanUnattributedMs: number
  readonly controllerTimings: Readonly<Record<string, number>>
  readonly databaseBytes: number
  readonly baselineRssBytes: number
  readonly sampledPeakRssBytes: number
  readonly rssIncreaseBytes: number
  readonly scannedItems: number
  readonly scannedBytes: number
  readonly discoveredBytes: number
  readonly files: number
  readonly directories: number
  readonly itemsPerSecond: number
  readonly skippedItems: number
  readonly unreadableItems: number
  readonly nestedMounts: number
  readonly symlinks: number
  readonly duplicateHardLinks: number
  readonly disappearingItems: number
  readonly diagnosticMessageBeforeComplete: boolean
  readonly firstPreviewMs: number
  readonly maxPreviewPayloadBytes: number
  readonly bulkMetadataEntries: number
  readonly fallbackMetadataEntries: number
  readonly nativeCursorReadPageCalls: number
  readonly nodeCursorReadPageCalls: number
  readonly checkpointCount: number
  readonly journalReplayMs: number
  readonly candidateCloneMs: number
  readonly incrementalTraversalMs: number
  readonly hardlinkRepairMs: number
  readonly aggregateRepairMs: number
  readonly validationMs: number
  readonly candidatePublicationMs: number
  readonly aliasRows: number
  readonly persistentTableBytes: number
}

interface FixtureReport {
  readonly fixture: string
  readonly manifest: ScanFixtureManifest | LiveManifest
  readonly samples: readonly SampleReport[]
  readonly summary: {
    readonly workerStartupMs: TimingSummary
    readonly workerRunMs: TimingSummary
    readonly scanTotalMs: TimingSummary
    readonly traversalMs: TimingSummary
    readonly aggregationMs: TimingSummary
    readonly publicationMs: TimingSummary
    readonly databaseBytes: TimingSummary
    readonly sampledPeakRssBytes: TimingSummary
    readonly rssIncreaseBytes: TimingSummary
    readonly itemsPerSecond: TimingSummary
    readonly firstPreviewMs: TimingSummary
    readonly maxPreviewPayloadBytes: TimingSummary
  }
}

const options = parseArguments(process.argv.slice(2))
process.env.ORBIS_SCAN_CONCURRENCY = String(options.metadataConcurrency)
process.env.ORBIS_METADATA_BATCH_SIZE = String(options.batchSize)
const rootDirectory = resolve(process.cwd(), '../..')
const appDirectory = process.cwd()
async function runBenchmark(): Promise<void> {
  const reports: FixtureReport[] = []
  for (const fixtureName of options.fixtures) reports.push(await runFixture(fixtureName))
  if (options.target) reports.push(await runLiveTarget(options.target))

  const report = {
    schemaVersion: 5,
    capturedAt: new Date().toISOString(),
    environment: {
      moirasia: gitState(rootDirectory),
      orbis: gitState(appDirectory),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: release(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
      cacheState: options.cacheState,
      scanner: options.scanner,
      scenario: options.scenario,
      profile: options.profile,
      warmupRuns: options.warmup,
      measuredRuns: options.samples,
      metadataConcurrency: options.metadataConcurrency,
      batchSize: options.batchSize,
      nativeAddon: options.nativeAddonPath ?? null,
      artifacts: {
        scanWorkerSha256: fileHash(options.workerPath),
        benchmarkRunnerSha256: fileHash(process.argv[1]!),
        ...(options.nativeAddonPath ? { nativeAddonSha256: fileHash(options.nativeAddonPath) } : {})
      }
    },
    fixtures: reports
  }
  await mkdir(dirname(options.outputPath), { recursive: true })
  await writeFile(options.outputPath, `${JSON.stringify(report, null, 2)}\n`)
  printSummary(reports, options.outputPath)
}

async function runFixture(name: PerformanceFixture): Promise<FixtureReport> {
  const fixture = await createScanFixture(name, options.profile)
  try {
    const fileSystem = await statfs(fixture.root)
    const samples = await runSamples(fixture.root, fixture.manifest)
    return makeFixtureReport(name, { ...fixture.manifest, filesystemType: String(fileSystem.type) }, samples)
  } finally { await fixture.cleanup() }
}

async function runLiveTarget(target: string): Promise<FixtureReport> {
  if (!options.allowLiveTarget) throw new Error('--target requires --allow-live-target')
  const normalized = resolve(target)
  const manifest: LiveManifest = { name: 'live', profile: 'live', isStartup: normalized === '/' }
  const samples = await runSamples(normalized, manifest)
  return makeFixtureReport('live', manifest, samples)
}

async function runSamples(target: string, manifest: ScanFixtureManifest | LiveManifest): Promise<SampleReport[]> {
  for (let index = 0; index < options.warmup; index += 1) await runSample(target, manifest, -(index + 1))
  const samples: SampleReport[] = []
  for (let index = 0; index < options.samples; index += 1) samples.push(await runSample(target, manifest, index + 1))
  return samples
}

async function runSample(target: string, manifest: ScanFixtureManifest | LiveManifest, sample: number): Promise<SampleReport> {
  const indexDirectory = resolve(dirname(options.outputPath), `.run-${process.pid}-${manifest.name}-${sample}`)
  await rm(indexDirectory, { recursive: true, force: true })
  if (options.scenario !== 'initial-full') {
    if (options.scanner !== 'progressive') throw new Error('Refresh scenarios require --scanner progressive')
    if (options.scenario === 'hardlink-owner-change') await ensureBenchmarkHardLinks(target)
    await preparePersistentBaseline(target, indexDirectory)
    await applyRefreshScenario(target, indexDirectory, options.scenario, sample)
  }
  const controllerTimings: OrbisTimingEvent[] = []
  const unsubscribeDiagnostics = subscribeControllerDiagnostics((event) => controllerTimings.push(event))
  let worker: MeasuredWorker | undefined
  const workers: OrbisWorkerFactory = { create: () => { worker = new MeasuredWorker(options.workerPath, options.scanner, options.nativeAddonPath); return worker } }
  const controller = new OrbisController(workers, { indexDirectory, initialTarget: target })
  const baselineRssBytes = process.memoryUsage.rss()
  let sampledPeakRssBytes = baselineRssBytes
  const memorySampler = setInterval(() => { sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage.rss()) }, 20)
  const completion = waitForCompletion(controller, options.timeoutMs)
  try {
    await controller.startScan()
    await completion.promise
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate))
    const measuredWorker = worker
    if (!measuredWorker?.outcomeKind || !measuredWorker.refresh) throw new Error('The benchmark worker completed without a refresh outcome')
    const result = measuredWorker.result ?? readActiveResult(indexDirectory, sample)
    const databaseBytes = (await stat(result.publishedPath)).size
    const counts = readCounts(result.publishedPath)
    validateResult(result, counts, manifest)
    const workerStartupMs = await measuredWorker.workerStartupMs
    validateDiagnostics(measuredWorker, controllerTimings)
    const scanTimings = timingMap(measuredWorker.scanTimings)
    const scanTotal = scanTimings['refresh-total'] ?? scanTimings['scan-total'] ?? 0
    const measuredPhases = Object.entries(scanTimings).filter(([phase]) => isScanLeafPhase(phase)).reduce((sum, [, duration]) => sum + duration, 0)
    const persistent = readPersistentStats(result.publishedPath)
    return {
      sample,
      scenario: options.scenario,
      outcomeKind: measuredWorker.outcomeKind,
      strategy: measuredWorker.refresh.strategy,
      fallbackReason: measuredWorker.refresh.fallbackReason ?? null,
      workerStartupMs,
      workerRunMs: measuredWorker.workerRunMs,
      scanTotalMs: scanTotal,
      scanTimings,
      scanUnattributedMs: Math.max(0, scanTotal - measuredPhases),
      controllerTimings: timingMap(controllerTimings),
      databaseBytes,
      baselineRssBytes,
      sampledPeakRssBytes,
      rssIncreaseBytes: Math.max(0, sampledPeakRssBytes - baselineRssBytes),
      scannedItems: result.totals.scannedItems,
      scannedBytes: result.scannedBytes,
      discoveredBytes: result.totals.discoveredBytes,
      files: counts.files,
      directories: counts.directories,
      itemsPerSecond: scanTotal > 0 ? result.totals.scannedItems / (scanTotal / 1_000) : 0,
      skippedItems: result.totals.skippedItems,
      unreadableItems: result.totals.unreadableItems,
      nestedMounts: result.totals.nestedMounts,
      symlinks: result.totals.symlinks,
      duplicateHardLinks: result.totals.duplicateHardLinks,
      disappearingItems: result.totals.disappearingItems,
      diagnosticMessageBeforeComplete: measuredWorker.diagnosticMessageBeforeComplete,
      firstPreviewMs: measuredWorker.firstPreviewMs,
      maxPreviewPayloadBytes: measuredWorker.maxPreviewPayloadBytes,
      bulkMetadataEntries: result.metadata?.bulkMetadataEntries ?? 0,
      fallbackMetadataEntries: result.metadata?.fallbackMetadataEntries ?? 0,
      nativeCursorReadPageCalls: measuredWorker.nativeCursorReadPageCalls,
      nodeCursorReadPageCalls: measuredWorker.nodeCursorReadPageCalls,
      checkpointCount: measuredWorker.checkpointCount,
      journalReplayMs: scanTimings['journal-replay'] ?? 0,
      candidateCloneMs: scanTimings['candidate-clone'] ?? 0,
      incrementalTraversalMs: scanTimings['incremental-traversal'] ?? 0,
      hardlinkRepairMs: scanTimings['hardlink-repair'] ?? 0,
      aggregateRepairMs: scanTimings['incremental-aggregate-repair'] ?? 0,
      validationMs: scanTimings['incremental-validation'] ?? 0,
      candidatePublicationMs: scanTimings['candidate-publication'] ?? 0,
      aliasRows: persistent.aliasRows,
      persistentTableBytes: persistent.tableBytes
    }
  } finally {
    completion.cancel()
    clearInterval(memorySampler)
    unsubscribeDiagnostics()
    await controller.close()
    await rm(indexDirectory, { recursive: true, force: true })
  }
}

async function preparePersistentBaseline(target: string, indexDirectory: string): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...process.env }
  const factory: OrbisWorkerFactory = {
    create: () => new Worker(options.workerPath, { env: environment, ...(options.nativeAddonPath ? { workerData: { nativeAddonPath: options.nativeAddonPath } } : {}) }) as unknown as OrbisWorker
  }
  // A freshly generated fixture can still have pre-baseline events waiting for
  // IDs. A second unmeasured refresh drains those events before mutation.
  for (let pass = 0; pass < 2; pass += 1) {
    const controller = new OrbisController(factory, { indexDirectory, initialTarget: target })
    const completion = waitForCompletion(controller, options.timeoutMs)
    try { await controller.startScan(); await completion.promise }
    finally { completion.cancel(); await controller.close() }
  }
}

async function applyRefreshScenario(target: string, indexDirectory: string, scenario: RefreshScenario, sample: number): Promise<void> {
  if (scenario === 'warm-no-change') return
  if (scenario === 'dropped-history-fallback') {
    const manifestPath = resolve(indexDirectory, 'current.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { journal?: { uuid: string; eventId: string } | null }
    if (!manifest.journal) throw new Error('The benchmark baseline has no FSEvents cursor')
    manifest.journal.uuid = `benchmark-invalid-${sample}`
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`)
    return
  }
  if (scenario === 'one-file-allocation') {
    const file = await findFirstEntry(target, 'file')
    if (!file) throw new Error('The allocation scenario requires a regular file')
    await writeFile(file, Buffer.alloc(128 * 1024 + Math.max(0, sample), 0x62))
    return
  }
  if (scenario === 'directory-rename') {
    const directory = await findNestedDirectory(target)
    if (!directory) throw new Error('The directory-rename scenario requires a child directory')
    await rename(directory, `${directory}-renamed-${Math.abs(sample)}`)
    return
  }
  const owner = resolve(target, 'Z-hardlink-source', 'original.dat')
  const alias = resolve(target, 'A-hardlink-owner', 'alias.dat')
  if (!existsSync(owner) || !existsSync(alias)) throw new Error('The hard-link benchmark fixture is incomplete')
  await rm(alias)
}

async function ensureBenchmarkHardLinks(target: string): Promise<void> {
  const sourceDirectory = resolve(target, 'Z-hardlink-source')
  const ownerDirectory = resolve(target, 'A-hardlink-owner')
  const source = resolve(sourceDirectory, 'original.dat')
  const alias = resolve(ownerDirectory, 'alias.dat')
  await mkdir(sourceDirectory, { recursive: true })
  await mkdir(ownerDirectory, { recursive: true })
  if (!existsSync(source)) await writeFile(source, Buffer.alloc(64 * 1024, 0x68))
  if (!existsSync(alias)) await link(source, alias)
}

async function findNestedDirectory(root: string): Promise<string | undefined> {
  const first = await findFirstEntry(root, 'directory')
  return first ? findFirstEntry(first, 'directory') : undefined
}

async function findFirstEntry(root: string, kind: 'file' | 'directory'): Promise<string | undefined> {
  const queue = [root]
  while (queue.length > 0) {
    const directory = queue.shift()!
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = resolve(directory, entry.name)
      if (kind === 'directory' && entry.isDirectory()) return path
      if (kind === 'file' && entry.isFile()) return path
      if (entry.isDirectory()) queue.push(path)
    }
  }
  return undefined
}

function readActiveResult(indexDirectory: string, generation: number): ScanResult {
  const manifest = JSON.parse(readFileSync(resolve(indexDirectory, 'current.json'), 'utf8')) as { indexFile: string }
  const publishedPath = resolve(indexDirectory, manifest.indexFile)
  const database = new DatabaseSync(publishedPath, { readOnly: true })
  try {
    const metadata = Object.fromEntries((database.prepare('SELECT key, value FROM metadata').all() as unknown as Array<{ key: string; value: string }>).map((row) => [row.key, row.value]))
    const volume = JSON.parse(metadata.volume ?? '{}') as { capacityBytes?: number; freeBytes?: number }
    return {
      generation, target: metadata.target!, rootId: metadata.rootId!, publishedPath,
      capacityBytes: Number(volume.capacityBytes ?? 0), freeBytes: Number(volume.freeBytes ?? 0),
      scannedBytes: Number(metadata.scannedBytes ?? 0), totals: JSON.parse(metadata.totals ?? '{}') as ScanResult['totals']
    }
  } finally { database.close() }
}

function readPersistentStats(path: string): { aliasRows: number; tableBytes: number } {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const hasAliases = database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'file_aliases'").get() as { found?: number } | undefined
    if (!hasAliases?.found) return { aliasRows: 0, tableBytes: 0 }
    const aliases = database.prepare('SELECT COUNT(*) AS count FROM file_aliases').get() as { count: number }
    let tableBytes = 0
    try {
      const row = database.prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name IN ('file_aliases', 'hardlink_groups', 'directory_observations')").get() as { bytes: number }
      tableBytes = Number(row.bytes)
    } catch { /* dbstat can be omitted from custom SQLite builds. */ }
    return { aliasRows: Number(aliases.count), tableBytes }
  } finally { database.close() }
}

function waitForCompletion(controller: OrbisController, timeoutMs: number): { readonly promise: Promise<void>; cancel(): void } {
  let settled = false
  let unsubscribe = (): void => undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<void>((resolveCompleted, rejectCompleted) => {
    const settle = (operation: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      unsubscribe()
      operation()
    }
    unsubscribe = controller.subscribe((snapshot) => {
      if (snapshot.scan.status === 'completed') settle(resolveCompleted)
      else if (snapshot.scan.status === 'fatal-error') settle(() => rejectCompleted(new Error(snapshot.scan.error ?? 'The benchmark scan failed')))
      else if (snapshot.scan.status === 'canceled') settle(() => rejectCompleted(new Error('The benchmark scan was canceled')))
    })
    timer = setTimeout(() => settle(() => rejectCompleted(new Error(`The benchmark scan timed out after ${timeoutMs} ms`))), timeoutMs)
  })
  return { promise, cancel: () => { if (!settled) { settled = true; if (timer) clearTimeout(timer); unsubscribe() } } }
}

class MeasuredWorker implements OrbisWorker {
  readonly #worker: Worker
  readonly #createdAt = performance.now()
  readonly #messageListeners: Array<(message: unknown) => void> = []
  readonly #errorListeners: Array<(error: unknown) => void> = []
  readonly #exitListeners: Array<(code: number) => void> = []
  readonly workerStartupMs: Promise<number>
  scanTimings: readonly OrbisTimingEvent[] = []
  result: ScanResult | undefined
  outcomeKind: 'candidate' | 'unchanged' | undefined
  refresh: { readonly strategy: 'full' | 'incremental'; readonly fallbackReason?: string } | undefined
  workerRunMs = 0
  diagnosticMessageBeforeComplete = false
  firstPreviewMs = 0
  maxPreviewPayloadBytes = 0
  nativeCursorReadPageCalls = 0
  nodeCursorReadPageCalls = 0
  checkpointCount = 0
  #startedAt = 0
  #receivedComplete = false

  constructor(path: string, scanner: 'progressive' | 'legacy', nativeAddonPath: string | undefined) {
    const environment: NodeJS.ProcessEnv = { ...process.env, ORBIS_SCAN_DIAGNOSTICS: '1' }
    const workerData = { ...(nativeAddonPath ? { nativeAddonPath } : {}), ...(scanner === 'legacy' ? { referenceScan: true } : {}) }
    this.#worker = new Worker(path, { env: environment, workerData })
    this.workerStartupMs = new Promise((resolveOnline) => this.#worker.once('online', () => resolveOnline(performance.now() - this.#createdAt)))
    this.#worker.on('message', (message: unknown) => {
      const value = message as {
        readonly type?: string
        readonly timings?: readonly OrbisTimingEvent[]
        readonly counters?: { readonly nativeReadPageCalls?: number; readonly nodeReadPageCalls?: number }
        readonly checkpointCount?: number
        readonly result?: ScanResult
        readonly refresh?: { readonly strategy: 'full' | 'incremental'; readonly fallbackReason?: string }
      }
      if (value.type === 'diagnostics') {
        this.scanTimings = value.timings ?? []
        this.nativeCursorReadPageCalls = Number(value.counters?.nativeReadPageCalls ?? 0)
        this.nodeCursorReadPageCalls = Number(value.counters?.nodeReadPageCalls ?? 0)
        this.checkpointCount = Number(value.checkpointCount ?? 0)
        this.diagnosticMessageBeforeComplete = !this.#receivedComplete
        return
      }
      if (value.type === 'preview') {
        if (this.firstPreviewMs === 0) this.firstPreviewMs = performance.now() - this.#startedAt
        this.maxPreviewPayloadBytes = Math.max(this.maxPreviewPayloadBytes, Buffer.byteLength(JSON.stringify(message)))
      }
      if (value.type === 'complete' && value.result) {
        this.#receivedComplete = true
        this.workerRunMs = performance.now() - this.#startedAt
        this.result = value.result
        this.outcomeKind = 'candidate'
        this.refresh = value.refresh ?? { strategy: 'full' }
      } else if (value.type === 'unchanged') {
        this.#receivedComplete = true
        this.workerRunMs = performance.now() - this.#startedAt
        this.outcomeKind = 'unchanged'
        this.refresh = { strategy: 'incremental' }
      }
      for (const listener of this.#messageListeners) listener(message)
    })
    this.#worker.on('error', (error) => { for (const listener of this.#errorListeners) listener(error) })
    this.#worker.on('exit', (code) => { for (const listener of this.#exitListeners) listener(code) })
  }

  postMessage(message: unknown): void {
    if ((message as { readonly type?: string }).type === 'start') this.#startedAt = performance.now()
    this.#worker.postMessage(message)
  }

  on(event: 'message', listener: (message: unknown) => void): OrbisWorker
  on(event: 'error', listener: (error: unknown) => void): OrbisWorker
  on(event: 'exit', listener: (code: number) => void): OrbisWorker
  on(event: 'message' | 'error' | 'exit', listener: ((value: unknown) => void) | ((code: number) => void)): OrbisWorker {
    if (event === 'message') this.#messageListeners.push(listener as (message: unknown) => void)
    else if (event === 'error') this.#errorListeners.push(listener as (error: unknown) => void)
    else this.#exitListeners.push(listener as (code: number) => void)
    return this
  }

  terminate(): Promise<number> { return this.#worker.terminate() }
}

function readCounts(path: string): { readonly files: number; readonly directories: number; readonly total: number; readonly rootSize: number; readonly metadataScannedBytes: number; readonly metadataTotals: ScanResult['totals'] } {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = database.prepare('SELECT kind, COUNT(*) AS count FROM nodes GROUP BY kind').all() as unknown as Array<{ readonly kind: string; readonly count: number }>
    const root = database.prepare("SELECT size_bytes AS size FROM nodes WHERE parent_id IS NULL").get() as unknown as { readonly size: number }
    const metadata = database.prepare("SELECT value FROM metadata WHERE key = 'scannedBytes'").get() as unknown as { readonly value: string }
    const totals = database.prepare("SELECT value FROM metadata WHERE key = 'totals'").get() as unknown as { readonly value: string }
    const files = Number(rows.find((row) => row.kind === 'file')?.count ?? 0)
    const directories = Number(rows.find((row) => row.kind === 'directory')?.count ?? 0)
    return { files, directories, total: files + directories, rootSize: Number(root.size), metadataScannedBytes: Number(metadata.value), metadataTotals: JSON.parse(totals.value) as ScanResult['totals'] }
  } finally { database.close() }
}

function validateResult(result: ScanResult, counts: ReturnType<typeof readCounts>, manifest: ScanFixtureManifest | LiveManifest): void {
  if (counts.total !== result.totals.scannedItems) throw new Error(`Node count ${counts.total} does not match scannedItems ${result.totals.scannedItems}`)
  if (counts.rootSize !== result.scannedBytes || counts.metadataScannedBytes !== result.scannedBytes) throw new Error('Root and metadata sizes do not match ScanResult.scannedBytes')
  if (result.totals.discoveredBytes !== result.scannedBytes) throw new Error('discoveredBytes does not match ScanResult.scannedBytes')
  if (JSON.stringify(counts.metadataTotals) !== JSON.stringify(result.totals)) throw new Error('Stored metadata totals do not match ScanResult.totals')
  if (manifest.profile !== 'live' && options.scenario !== 'hardlink-owner-change') {
    if (counts.files !== manifest.files) throw new Error(`Indexed ${counts.files} files, expected ${manifest.files}`)
    if (counts.directories !== manifest.directories) throw new Error(`Indexed ${counts.directories} directories, expected ${manifest.directories}`)
    if (result.totals.symlinks !== manifest.symlinks) throw new Error(`Skipped ${result.totals.symlinks} symlinks, expected ${manifest.symlinks}`)
    if (result.totals.duplicateHardLinks !== manifest.hardLinkAliases) throw new Error(`Skipped ${result.totals.duplicateHardLinks} hard-link aliases, expected ${manifest.hardLinkAliases}`)
    const expectedSkipped = manifest.symlinks + manifest.hardLinkAliases
    if (result.totals.skippedItems !== expectedSkipped) throw new Error(`Skipped ${result.totals.skippedItems} items, expected ${expectedSkipped}`)
    if (result.totals.unreadableItems !== 0 || result.totals.nestedMounts !== 0 || result.totals.disappearingItems !== 0) throw new Error('Deterministic fixture reported unexpected unreadable, nested-mount, or disappearing items')
  }
}

function makeFixtureReport(fixture: string, manifest: FixtureReport['manifest'], samples: readonly SampleReport[]): FixtureReport {
  const values = (select: (sample: SampleReport) => number): TimingSummary => summarize(samples.map(select))
  return {
    fixture,
    manifest,
    samples,
    summary: {
      workerStartupMs: values((sample) => sample.workerStartupMs),
      workerRunMs: values((sample) => sample.workerRunMs),
      scanTotalMs: values((sample) => sample.scanTotalMs),
      traversalMs: values((sample) => sample.scanTimings.traversal ?? 0),
      aggregationMs: values((sample) => sample.scanTimings.aggregation ?? 0),
      publicationMs: values((sample) => sample.controllerTimings['publication-total'] ?? 0),
      databaseBytes: values((sample) => sample.databaseBytes),
      sampledPeakRssBytes: values((sample) => sample.sampledPeakRssBytes),
      rssIncreaseBytes: values((sample) => sample.rssIncreaseBytes),
      itemsPerSecond: values((sample) => sample.itemsPerSecond),
      firstPreviewMs: values((sample) => sample.firstPreviewMs),
      maxPreviewPayloadBytes: values((sample) => sample.maxPreviewPayloadBytes)
    }
  }
}

function validateDiagnostics(worker: MeasuredWorker, controllerEvents: readonly OrbisTimingEvent[]): void {
  if (options.scenario !== 'initial-full') {
    if (!worker.scanTimings.some((event) => event.phase === 'refresh-total')) throw new Error('Refresh diagnostics did not include refresh-total')
    if (!worker.scanTimings.some((event) => event.phase === 'journal-replay')) throw new Error('Refresh diagnostics did not include journal-replay')
    if (!worker.diagnosticMessageBeforeComplete) throw new Error('The worker diagnostics message did not arrive before completion')
    return
  }
  const requiredScanPhases = ['preflight', 'database-create', 'traversal', 'aggregation', 'index-create', 'metadata-write', 'database-commit', 'database-optimize', 'database-close', 'publish-rename', 'scan-total']
  const requiredControllerPhases = ['index-open', 'partial-index-cleanup', 'snapshot-focus-query', 'snapshot-root-query', 'snapshot-breadcrumbs-query', 'snapshot-chart-query', 'snapshot-largest-items-query', 'snapshot-total', 'listener-notify', 'publication-total']
  validateTimingSet(worker.scanTimings, requiredScanPhases, 'worker', false)
  validateTimingSet(controllerEvents, requiredControllerPhases, 'controller')
  if (!worker.diagnosticMessageBeforeComplete) throw new Error('The worker diagnostics message did not arrive before completion')
  const scan = timingMap(worker.scanTimings)
  const leafTotal = Object.entries(scan).filter(([phase]) => isScanLeafPhase(phase)).reduce((sum, [, duration]) => sum + duration, 0)
  const enclosingTotal = scan['refresh-total'] ?? scan['scan-total'] ?? 0
  if (leafTotal > enclosingTotal + 0.1) throw new Error('Worker phase durations exceed the enclosing refresh total')
}

function isScanLeafPhase(phase: string): boolean { return phase !== 'scan-total' && phase !== 'refresh-total' && phase !== 'aggregation' }

function validateTimingSet(events: readonly OrbisTimingEvent[], required: readonly string[], label: string, exact = true): void {
  for (const phase of required) {
    const matches = events.filter((event) => event.phase === phase)
    if (matches.length === 0 || exact && matches.length !== 1) throw new Error(`Expected ${exact ? 'one' : 'at least one'} ${label} ${phase} timing, received ${matches.length}`)
    if (!Number.isFinite(matches[0]!.durationMs) || matches[0]!.durationMs < 0) throw new Error(`${label} ${phase} timing is invalid`)
  }
}

function timingMap(events: readonly OrbisTimingEvent[]): Readonly<Record<string, number>> {
  const timings: Record<string, number> = {}
  for (const event of events) timings[event.phase] = (timings[event.phase] ?? 0) + event.durationMs
  return timings
}

function summarize(values: readonly number[]): TimingSummary {
  if (values.length === 0) return { min: 0, median: 0, p95: 0, max: 0, medianAbsoluteDeviation: 0 }
  const sorted = [...values].sort((left, right) => left - right)
  const median = percentile50(sorted)
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((left, right) => left - right)
  return { min: sorted[0]!, median, p95: percentile(sorted, 0.95), max: sorted.at(-1)!, medianAbsoluteDeviation: percentile50(deviations) }
}

function percentile50(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]!
  return sorted[Math.min(sorted.length - 1, Math.ceil((sorted.length - 1) * fraction))]!
}

function parseArguments(arguments_: readonly string[]): BenchmarkOptions {
  const value = (name: string): string | undefined => { const index = arguments_.indexOf(name); return index >= 0 ? arguments_[index + 1] : undefined }
  const profile = value('--profile') ?? 'baseline'
  if (profile !== 'quick' && profile !== 'baseline') throw new Error('--profile must be quick or baseline')
  const scanner = value('--scanner') ?? 'progressive'
  if (scanner !== 'progressive' && scanner !== 'legacy') throw new Error('--scanner must be progressive or legacy')
  const scenario = value('--scenario') ?? 'initial-full'
  const scenarios: readonly RefreshScenario[] = ['initial-full', 'warm-no-change', 'one-file-allocation', 'directory-rename', 'hardlink-owner-change', 'dropped-history-fallback']
  if (!scenarios.includes(scenario as RefreshScenario)) throw new Error(`--scenario must be one of ${scenarios.join(', ')}`)
  const samples = positiveInteger(value('--samples') ?? (profile === 'quick' ? '1' : '5'), '--samples')
  const warmup = nonnegativeInteger(value('--warmup') ?? '1', '--warmup')
  const defaultFixture = scenario === 'initial-full' ? 'all' : scenario === 'hardlink-owner-change' || scenario === 'directory-rename' ? 'deep' : 'mixed'
  const fixture = value('--fixture') ?? defaultFixture
  const allowed: readonly PerformanceFixture[] = ['wide', 'deep', 'tiny', 'mixed', 'semantics']
  const fixtures = fixture === 'all' ? allowed : allowed.includes(fixture as PerformanceFixture) ? [fixture as PerformanceFixture] : []
  const target = value('--target')
  if (fixtures.length === 0 && !target) throw new Error('--fixture must be wide, deep, tiny, mixed, semantics, or all')
  const workerPath = resolve(value('--worker') ?? resolve(process.cwd(), 'worker-dist/scan-worker.mjs'))
  const requestedNativeAddon = value('--native-addon')
  const defaultNativeAddon = resolve(process.cwd(), 'native', `orbis-metadata.darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.node`)
  const nativeAddonPath = requestedNativeAddon ? resolve(requestedNativeAddon) : existsSync(defaultNativeAddon) ? defaultNativeAddon : undefined
  const outputPath = resolve(value('--output') ?? resolve(process.cwd(), 'benchmark-results', `orbis-scan-${new Date().toISOString().replaceAll(':', '-')}.json`))
  const timeoutMs = positiveInteger(value('--timeout-ms') ?? '1800000', '--timeout-ms')
  const metadataConcurrency = positiveInteger(value('--concurrency') ?? String(DEFAULT_METADATA_CONCURRENCY), '--concurrency')
  if (metadataConcurrency > 64) throw new Error('--concurrency must be at most 64')
  const batchSize = positiveInteger(value('--batch-size') ?? '256', '--batch-size')
  if (batchSize > 1_024) throw new Error('--batch-size must be at most 1024')
  return { workerPath, ...(nativeAddonPath ? { nativeAddonPath } : {}), profile, samples, warmup, fixtures: target ? [] : fixtures, outputPath, ...(target ? { target: resolve(target) } : {}), allowLiveTarget: arguments_.includes('--allow-live-target'), cacheState: value('--cache-state') ?? (target ? 'uncontrolled' : 'warm'), timeoutMs, metadataConcurrency, batchSize, scanner, scenario: scenario as RefreshScenario }
}

function positiveInteger(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`); return parsed }
function nonnegativeInteger(value: string, name: string): number { const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a nonnegative integer`); return parsed }

function fileHash(path: string): string { return createHash('sha256').update(readFileSync(path)).digest('hex') }

function gitState(directory: string): { readonly sha: string; readonly dirty: boolean; readonly status: readonly string[]; readonly workingTreeHash: string } {
  const sha = spawnSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const statusText = spawnSync('git', ['-C', directory, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
  const status = statusText ? statusText.split('\n') : []
  const hash = createHash('sha256')
  hash.update(spawnSync('git', ['-C', directory, 'diff', '--binary', 'HEAD'], { encoding: 'buffer' }).stdout)
  const untracked = spawnSync('git', ['-C', directory, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean).sort()
  for (const path of untracked) { hash.update(path); hash.update(readFileSync(resolve(directory, path))) }
  return { sha, dirty: status.length > 0, status, workingTreeHash: hash.digest('hex') }
}

function printSummary(reports: readonly FixtureReport[], outputPath: string): void {
  console.log('\nOrbis scan benchmark')
  console.log(`Report: ${outputPath}`)
  console.table(reports.map((report) => ({
    fixture: report.fixture,
    batch: options.batchSize,
    scenario: report.samples[0]?.scenario ?? options.scenario,
    strategy: report.samples[0]?.strategy ?? 'unknown',
    items: report.samples[0]?.scannedItems ?? 0,
    'scan median ms': round(report.summary.scanTotalMs.median),
    'traversal median ms': round(report.summary.traversalMs.median),
    'aggregation median ms': round(report.summary.aggregationMs.median),
    'publication median ms': round(report.summary.publicationMs.median),
    'items/sec': Math.round(report.summary.itemsPerSecond.median),
    'first preview ms': round(report.summary.firstPreviewMs.median),
    'first preview p95 ms': round(report.summary.firstPreviewMs.p95),
    'max preview KiB': round(report.summary.maxPreviewPayloadBytes.median / 1024),
    'bulk entries': report.samples[0]?.bulkMetadataEntries ?? 0,
    'fallback entries': report.samples[0]?.fallbackMetadataEntries ?? 0,
    'native read calls': report.samples[0]?.nativeCursorReadPageCalls ?? 0,
    'Node read calls': report.samples[0]?.nodeCursorReadPageCalls ?? 0,
    checkpoints: report.samples[0]?.checkpointCount ?? 0,
    'journal ms': round(report.samples[0]?.journalReplayMs ?? 0),
    'clone ms': round(report.samples[0]?.candidateCloneMs ?? 0),
    'incremental traversal ms': round(report.samples[0]?.incrementalTraversalMs ?? 0),
    'alias rows': report.samples[0]?.aliasRows ?? 0,
    'persistent tables MiB': round((report.samples[0]?.persistentTableBytes ?? 0) / 1024 / 1024),
    'DB MiB': round(report.summary.databaseBytes.median / 1024 / 1024)
  })))
}

function round(value: number): number { return Math.round(value * 100) / 100 }

await runBenchmark()
