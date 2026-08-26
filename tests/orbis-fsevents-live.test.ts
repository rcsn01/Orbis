import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { NativeChangeJournalAddon } from '../src/main/change-journal'

const addonPath = resolve(import.meta.dirname, '../native', `orbis-metadata.darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.node`)
const available = process.platform === 'darwin' && existsSync(addonPath)

describe.skipIf(!available)('live Orbis FSEvents addon', () => {
  it('captures and replays create, modify, rename, and delete activity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-fsevents-live-'))
    const folder = join(directory, 'folder')
    await mkdir(folder)
    const addon = createRequire(import.meta.url)(addonPath) as NativeChangeJournalAddon
    try {
      const initial = addon.captureVolumeCheckpoint(directory)
      expect(initial.journalUuid).toEqual(expect.any(String))
      const drained = addon.readChanges(directory, initial.journalUuid!, initial.eventId, 10_000, 5_000)
      const cursor = drained.throughEventId
      const created = join(folder, 'created.dat')
      const renamed = join(folder, 'renamed.dat')
      await writeFile(created, Buffer.alloc(4096, 1))
      await writeFile(created, Buffer.alloc(8192, 2))
      await rename(created, renamed)
      await rm(renamed)

      const batch = addon.readChanges(directory, initial.journalUuid!, cursor, 10_000, 5_000)
      expect(batch.requiresFullScan).toBe(false)
      expect(BigInt(batch.throughEventId)).toBeGreaterThan(BigInt(cursor))
      expect(batch.events.some((event) => event.relativePath === 'folder' || event.relativePath.startsWith('folder/'))).toBe(true)
      expect(batch.events.every((event) => /^\d+$/u.test(event.eventId))).toBe(true)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('captures a flushed checkpoint that includes just-written activity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-fsevents-fence-'))
    const addon = createRequire(import.meta.url)(addonPath) as NativeChangeJournalAddon
    try {
      const before = addon.captureVolumeCheckpoint(directory)
      await writeFile(join(directory, 'fresh.dat'), Buffer.alloc(4096, 1))
      // The checkpoint must observe the write even though the daemon may not
      // have flushed its per-device journal when the file was created.
      const after = addon.captureVolumeCheckpoint(directory)
      expect(BigInt(after.eventId)).toBeGreaterThan(BigInt(before.eventId))
      // Replaying from the checkpoint must not re-report the write.
      const batch = addon.readChanges(directory, after.journalUuid!, after.eventId, 10_000, 5_000)
      expect(batch.requiresFullScan).toBe(false)
      expect(batch.events).toEqual([])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
