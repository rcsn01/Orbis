import { isAbsolute, normalize, sep } from 'node:path'
import type { JournalCursor } from './index-manifest'

export const FSEVENT_FLAGS = {
  mustScanSubDirs: 0x00000001,
  userDropped: 0x00000002,
  kernelDropped: 0x00000004,
  eventIdsWrapped: 0x00000008,
  historyDone: 0x00000010,
  rootChanged: 0x00000020,
  mount: 0x00000040,
  unmount: 0x00000080,
  itemCreated: 0x00000100,
  itemRemoved: 0x00000200,
  itemInodeMetaMod: 0x00000400,
  itemRenamed: 0x00000800,
  itemModified: 0x00001000,
  itemFinderInfoMod: 0x00002000,
  itemChangeOwner: 0x00004000,
  itemXattrMod: 0x00008000,
  itemIsFile: 0x00010000,
  itemIsDir: 0x00020000
} as const

export interface VolumeCheckpoint {
  readonly device: string
  readonly journalUuid: string | null
  readonly eventId: string
}

export interface ChangeEvent {
  readonly relativePath: string
  readonly eventId: string
  readonly flags: number
}

export interface ChangeBatch {
  readonly throughEventId: string
  readonly events: readonly ChangeEvent[]
  readonly requiresFullScan: boolean
  readonly reason?: string
}

export interface ChangeJournal {
  captureCheckpoint(target: string): VolumeCheckpoint
  readChanges(target: string, cursor: JournalCursor, maxEvents: number, timeoutMs: number): ChangeBatch
}

export interface NativeChangeJournalAddon {
  captureVolumeCheckpoint(target: string): VolumeCheckpoint
  readChanges(target: string, expectedUuid: string, sinceId: string, maxEvents: number, timeoutMs: number): ChangeBatch
}

export class NativeChangeJournal implements ChangeJournal {
  constructor(private readonly addon: NativeChangeJournalAddon) {}

  captureCheckpoint(target: string): VolumeCheckpoint {
    const value = this.addon.captureVolumeCheckpoint(target)
    if (!decimal(value.device) || !decimal(value.eventId) || value.journalUuid !== null && !nonempty(value.journalUuid)) {
      throw new Error('FSEvents returned an invalid volume checkpoint')
    }
    return { device: value.device, journalUuid: value.journalUuid, eventId: value.eventId }
  }

  readChanges(target: string, cursor: JournalCursor, maxEvents: number, timeoutMs: number): ChangeBatch {
    if (!nonempty(cursor.uuid) || !decimal(cursor.eventId)) return malformed(cursor.eventId)
    let raw: ChangeBatch
    try {
      raw = this.addon.readChanges(target, cursor.uuid, cursor.eventId, boundedInteger(maxEvents, 1, 100_000), boundedInteger(timeoutMs, 1, 30_000))
    } catch {
      return { throughEventId: cursor.eventId, events: [], requiresFullScan: true, reason: 'history-unavailable' }
    }
    if (!decimal(raw.throughEventId) || BigInt(raw.throughEventId) < BigInt(cursor.eventId) || !Array.isArray(raw.events)) return malformed(cursor.eventId)
    const events: ChangeEvent[] = []
    for (const event of raw.events) {
      if (!event || !validRelativePath(event.relativePath) || !decimal(event.eventId) || !validFlags(event.flags)) return malformed(cursor.eventId)
      const eventId = BigInt(event.eventId)
      if (eventId <= BigInt(cursor.eventId) || eventId > BigInt(raw.throughEventId)) continue
      events.push({ relativePath: event.relativePath, eventId: event.eventId, flags: event.flags })
    }
    const forcedReason = events.map((event) => fallbackReason(event.flags)).find((reason) => reason !== undefined)
    if (forcedReason) return { throughEventId: raw.throughEventId, events, requiresFullScan: true, reason: forcedReason }
    return {
      throughEventId: raw.throughEventId,
      events,
      requiresFullScan: Boolean(raw.requiresFullScan),
      ...(raw.reason ? { reason: raw.reason } : {})
    }
  }
}

export function createChangeJournal(addon: NativeChangeJournalAddon | undefined): ChangeJournal | undefined {
  return addon ? new NativeChangeJournal(addon) : undefined
}

export function nativeChangeJournalAddon(value: unknown): NativeChangeJournalAddon | undefined {
  if (!value || typeof value !== 'object') return undefined
  const addon = value as Partial<NativeChangeJournalAddon>
  return typeof addon.captureVolumeCheckpoint === 'function' && typeof addon.readChanges === 'function' ? addon as NativeChangeJournalAddon : undefined
}

function fallbackReason(flags: number): string | undefined {
  if (flags & FSEVENT_FLAGS.userDropped) return 'user-dropped'
  if (flags & FSEVENT_FLAGS.kernelDropped) return 'kernel-dropped'
  if (flags & FSEVENT_FLAGS.eventIdsWrapped) return 'event-ids-wrapped'
  if (flags & FSEVENT_FLAGS.rootChanged) return 'root-changed'
  if (flags & (FSEVENT_FLAGS.mount | FSEVENT_FLAGS.unmount)) return 'mount-changed'
  return undefined
}

function malformed(cursor: string): ChangeBatch {
  return { throughEventId: decimal(cursor) ? cursor : '0', events: [], requiresFullScan: true, reason: 'malformed-history' }
}

function validRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.includes('\u0000') || isAbsolute(value)) return false
  if (value === '') return true
  return normalize(value) === value && value !== '..' && !value.startsWith(`..${sep}`)
}

function validFlags(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff
}

function decimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn
}

function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0 }
function boundedInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, Math.floor(value))) : minimum
}
