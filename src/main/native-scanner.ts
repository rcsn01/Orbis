import { randomBytes } from 'node:crypto'
import { open, rename, statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { measureScanAsync, recordScanCounter, recordScanTiming } from './diagnostics'
import { prepareDatabaseDirectory, readMetadata, removeDatabaseFiles } from './database'
import { loadNativeOrbisAddon } from './scan-metadata'
import { ScanCanceledError, type ScanResult, type ScanTotals } from './legacy-scanner'
import type { ScanOptions } from './scanner'

interface NativeDatabaseScanSummary {
  readonly elapsedMs: number
  readonly traversalMs: number
  readonly indexMs: number
  readonly scannedItems: number
  readonly files: number
  readonly directories: number
  readonly allocatedBytes: number
  readonly skippedItems: number
  readonly unreadableItems: number
  readonly nestedMounts: number
  readonly symlinks: number
  readonly duplicateHardLinks: number
}

interface NativeDatabaseScanProgress {
  readonly scannedItems: number
  readonly allocatedBytes: number
  readonly indexing: boolean
}

interface NativeDatabaseScanner {
  scanTreeToDatabase(target: string, databasePath: string): Promise<NativeDatabaseScanSummary>
  progress(): NativeDatabaseScanProgress
  cancel(): void
}

interface NativeDatabaseScannerAddon {
  NativeDatabaseScanner: new () => NativeDatabaseScanner
}

export async function canUseNativeScanner(options: ScanOptions): Promise<boolean> {
  if (resolve(options.target) !== '/' || options.startupRoot === false) return false
  if (!options.nativeAddonPath || options.fileSystem || options.resumable?.resume) return false
  const addon = await loadNativeOrbisAddon(options.nativeAddonPath, options.onNativeAddonStatus)
  return typeof (addon as Partial<NativeDatabaseScannerAddon> | undefined)?.NativeDatabaseScanner === 'function'
}

export function scanFilesystemNative(options: ScanOptions): Promise<ScanResult> {
  return measureScanAsync('scan-total', async () => {
    if (options.signal?.aborted) throw new ScanCanceledError()
    await prepareDatabaseDirectory(options.publishedPath)
    await removeDatabaseFiles(options.publishedPath)
    const stagingPath = `${options.publishedPath}.staging-${randomBytes(8).toString('hex')}`
    await removeDatabaseFiles(stagingPath)
    const addon = await loadNativeOrbisAddon(options.nativeAddonPath, options.onNativeAddonStatus) as NativeDatabaseScannerAddon | undefined
    if (!addon || typeof addon.NativeDatabaseScanner !== 'function') throw new Error('Native database scanner is unavailable')
    const scanner = new addon.NativeDatabaseScanner()
    const cancel = (): void => scanner.cancel()
    options.signal?.addEventListener('abort', cancel, { once: true })
    const startedAt = performance.now()
    let lastProgress = ''
    const publishProgress = (): void => {
      const progress = scanner.progress()
      const key = `${progress.indexing}:${progress.scannedItems}:${progress.allocatedBytes}`
      if (key === lastProgress) return
      lastProgress = key
      options.onProgress?.({
        stage: progress.indexing ? 'indexing' : 'traversing',
        scannedItems: progress.scannedItems,
        discoveredBytes: progress.allocatedBytes,
        elapsedMs: performance.now() - startedAt,
        currentItem: options.target
      })
    }
    publishProgress()
    const progressTimer = setInterval(publishProgress, 250)
    progressTimer.unref()
    let summary: NativeDatabaseScanSummary
    try {
      summary = await scanner.scanTreeToDatabase(options.target, stagingPath)
      clearInterval(progressTimer)
      publishProgress()
      if (options.signal?.aborted) throw new ScanCanceledError()
      await syncFile(stagingPath)
      await rename(stagingPath, options.publishedPath)
      await syncFile(dirname(options.publishedPath))
    } catch (error) {
      await removeDatabaseFiles(stagingPath)
      if (options.signal?.aborted) throw new ScanCanceledError()
      throw error
    } finally {
      clearInterval(progressTimer)
      options.signal?.removeEventListener('abort', cancel)
    }
    publishNativeTimings(summary)
    recordScanCounter('nativePageReads', summary.directories)
    recordScanCounter('metadataEntries', summary.scannedItems + summary.skippedItems - 1)
    recordScanCounter('hardlinkPathRows', summary.duplicateHardLinks)
    const volume = await statfs(options.target)
    const metadata = readNativeMetadata(options.publishedPath)
    const totals = JSON.parse(metadata.totals ?? '{}') as ScanTotals
    options.onProgress?.({
      stage: 'indexing', scannedItems: summary.scannedItems, discoveredBytes: summary.allocatedBytes,
      elapsedMs: summary.elapsedMs, currentItem: options.target
    })
    return {
      generation: options.generation,
      target: options.target,
      rootId: metadata.rootId ?? 'n-root',
      publishedPath: options.publishedPath,
      capacityBytes: Number(volume.blocks) * Number(volume.bsize),
      freeBytes: Number(volume.bfree) * Number(volume.bsize),
      scannedBytes: summary.allocatedBytes,
      totals,
      metadata: { bulkMetadataEntries: summary.scannedItems + summary.skippedItems - 1, fallbackMetadataEntries: 0, nativeFullScan: true }
    }
  })
}

function readNativeMetadata(path: string): Record<string, string> {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return readMetadata(database) }
  finally { database.close() }
}

async function syncFile(path: string): Promise<void> {
  const file = await open(path, 'r')
  try { await file.sync() }
  finally { await file.close() }
}

function publishNativeTimings(summary: NativeDatabaseScanSummary): void {
  recordScanTiming('preflight', 0)
  recordScanTiming('database-create', 0)
  recordScanTiming('traversal', summary.traversalMs)
  recordScanTiming('index-create', summary.indexMs)
  recordScanTiming('database-close', Math.max(0, summary.elapsedMs - summary.traversalMs - summary.indexMs))
  for (const phase of ['scheduler', 'metadata-open', 'metadata-read', 'page-normalize', 'aggregation', 'metadata-batch-flush', 'preview-build', 'database-checkpoint']) {
    recordScanTiming(phase, 0)
  }
  recordScanTiming('candidate-finalize', summary.indexMs)
}
