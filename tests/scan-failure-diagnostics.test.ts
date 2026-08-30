import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ScanFailureDiagnosticsStore } from '../src/main/scan-failure-diagnostics'

describe('scan failure diagnostics', () => {
  it('writes bounded path-free records atomically with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-diagnostics-store-'))
    try {
      const store = new ScanFailureDiagnosticsStore(join(directory, 'indexes'), { clock: () => '2026-01-01T00:00:00.000Z' })
      await store.startRun({ generation: 1, resumeExpected: true, startedAt: '/private/start' as never })
      await store.setStage(1, '/private/target')
      await store.setCheckpoint(1, { sequence: 7, reason: 'scheduled', phase: 'scanning', count: 3 })
      await store.setNativeAddonStatus(1, { loadStatus: 'bogus' as never, journalCapability: 'bogus' as never, metadataCapability: 'missing', errorCode: '/private/native' })
      await store.recordFailure({ generation: 1, kind: '/private/worker', code: '/private/error', exitCode: 2 })

      const raw = await readFile(store.filePath, 'utf8')
      expect(raw).not.toContain('/private')
      expect(raw.length).toBeLessThan(2_000)
      expect(JSON.parse(raw)).toMatchObject({ version: 1, lastFailure: {
        generation: 1, kind: 'unknown', lifecycleStage: 'unknown', latestCheckpoint: { sequence: 7 }, nativeAddon: { loadStatus: 'unknown', journalCapability: 'unknown' }, exitCode: 2
      } })
      expect((await stat(store.filePath)).mode & 0o777).toBe(0o600)
      await expect(stat(store.temporaryPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('does not let an old generation overwrite the active run', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-diagnostics-generation-'))
    try {
      const store = new ScanFailureDiagnosticsStore(directory, { clock: () => '2026-01-01T00:00:00.000Z' })
      await store.startRun({ generation: 1, resumeExpected: false })
      await store.startRun({ generation: 2, resumeExpected: true })
      await store.recordFailure({ generation: 1, kind: 'old-worker' })
      const document = await store.read()
      expect(document.activeRun).toMatchObject({ generation: 2, resumeExpected: true })
      expect(document.lastFailure).toMatchObject({ generation: 1, kind: 'host-process-ended' })
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
