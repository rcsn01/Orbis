import { describe, expect, it } from 'vitest'
import {
  FSEVENT_FLAGS, NativeChangeJournal, type NativeChangeJournalAddon
} from '../src/main/change-journal'

function addon(overrides: Partial<NativeChangeJournalAddon> = {}): NativeChangeJournalAddon {
  return {
    captureVolumeCheckpoint: () => ({ device: '1', journalUuid: 'volume-uuid', eventId: '9007199254740993' }),
    readChanges: () => ({
      throughEventId: '9007199254740995',
      events: [{ relativePath: 'folder/file.dat', eventId: '9007199254740994', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }],
      requiresFullScan: false
    }),
    ...overrides
  }
}

describe('Orbis change journal', () => {
  it('preserves unsigned event IDs as decimal strings', () => {
    const journal = new NativeChangeJournal(addon())
    expect(journal.captureCheckpoint('/tmp/root')).toEqual({ device: '1', journalUuid: 'volume-uuid', eventId: '9007199254740993' })
    expect(journal.readChanges('/tmp/root', { uuid: 'volume-uuid', eventId: '9007199254740993' }, 100, 2_000)).toEqual({
      throughEventId: '9007199254740995',
      events: [{ relativePath: 'folder/file.dat', eventId: '9007199254740994', flags: FSEVENT_FLAGS.itemModified | FSEVENT_FLAGS.itemIsFile }],
      requiresFullScan: false
    })
  })

  it.each([
    ['user-dropped', FSEVENT_FLAGS.userDropped],
    ['kernel-dropped', FSEVENT_FLAGS.kernelDropped],
    ['event-ids-wrapped', FSEVENT_FLAGS.eventIdsWrapped],
    ['root-changed', FSEVENT_FLAGS.rootChanged],
    ['mount-changed', FSEVENT_FLAGS.mount],
    ['mount-changed', FSEVENT_FLAGS.unmount]
  ])('forces a full scan for %s events', (reason, flags) => {
    const journal = new NativeChangeJournal(addon({
      readChanges: () => ({ throughEventId: '12', events: [{ relativePath: '', eventId: '11', flags }], requiresFullScan: false })
    }))
    expect(journal.readChanges('/tmp/root', { uuid: 'volume-uuid', eventId: '10' }, 100, 2_000)).toMatchObject({ requiresFullScan: true, reason })
  })

  it('rejects malformed native paths and cursors conservatively', () => {
    const malformed = new NativeChangeJournal(addon({
      readChanges: () => ({ throughEventId: 'not-a-number', events: [{ relativePath: '../escape', eventId: '2', flags: 0 }], requiresFullScan: false })
    }))
    expect(malformed.readChanges('/tmp/root', { uuid: 'volume-uuid', eventId: '1' }, 100, 2_000)).toEqual({ throughEventId: '1', events: [], requiresFullScan: true, reason: 'malformed-history' })
  })
})
