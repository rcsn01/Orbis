import { DatabaseSync } from 'node:sqlite'
import { chmod, link, mkdir, mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanFilesystem, type ScanTotals } from '../src/main/scanner'

const addonPath = resolve(import.meta.dirname, '../native', `orbis-metadata.darwin-${process.arch === 'arm64' ? 'arm64' : 'x64'}.node`)
const available = process.platform === 'darwin' && existsSync(addonPath)

interface NodeRow {
  path: string
  kind: string
  size_bytes: number
  device: string
  inode: string
}

function readNodes(databasePath: string): NodeRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    return database.prepare('SELECT path, kind, size_bytes, device, inode FROM nodes ORDER BY path').all() as unknown as NodeRow[]
  } finally { database.close() }
}

function comparableTotals(totals: ScanTotals): Record<string, unknown> {
  return {
    scannedItems: totals.scannedItems,
    discoveredBytes: totals.discoveredBytes,
    skippedItems: totals.skippedItems,
    unreadableItems: totals.unreadableItems,
    nestedMounts: totals.nestedMounts,
    symlinks: totals.symlinks,
    duplicateHardLinks: totals.duplicateHardLinks,
    disappearingItems: totals.disappearingItems
  }
}

describe.skipIf(!available)('bulk metadata parity with the Node fallback', () => {
  it('produces identical nodes and totals', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'orbis-bulk-parity-'))
    const root = join(directory, 'root')
    const indexes = join(directory, 'indexes')
    const denied = join(root, 'nested', 'denied')
    try {
      await mkdir(join(root, 'nested', 'deeper'), { recursive: true })
      await mkdir(join(root, 'empty'), { recursive: true })
      await writeFile(join(root, 'sized.dat'), Buffer.alloc(4096, 7))
      await writeFile(join(root, 'empty.dat'), Buffer.alloc(0))
      await writeFile(join(root, 'sparse.dat'), Buffer.alloc(0))
      await truncate(join(root, 'sparse.dat'), 8 * 1024 * 1024)
      await writeFile(join(root, 'nested', 'deep.dat'), Buffer.alloc(8192, 3))
      await symlink(join(root, 'sized.dat'), join(root, 'link.dat'))
      await writeFile(join(root, 'hard-a.dat'), Buffer.alloc(1024, 1))
      await link(join(root, 'hard-a.dat'), join(root, 'hard-b.dat'))
      await mkdir(denied)
      await writeFile(join(denied, 'secret.dat'), Buffer.alloc(64, 9))
      await chmod(denied, 0o000)

      const bulk = await scanFilesystem({
        generation: 1, target: root, indexDirectory: indexes,
        partialPath: join(indexes, 'bulk.partial.sqlite'), publishedPath: join(indexes, 'bulk.sqlite'),
        nativeAddonPath: addonPath
      })
      const fallback = await scanFilesystem({
        generation: 1, target: root, indexDirectory: indexes,
        partialPath: join(indexes, 'node.partial.sqlite'), publishedPath: join(indexes, 'node.sqlite')
      })

      expect(readNodes(bulk.publishedPath)).toEqual(readNodes(fallback.publishedPath))
      expect(comparableTotals(bulk.totals)).toEqual(comparableTotals(fallback.totals))
      expect(bulk.scannedBytes).toBe(fallback.scannedBytes)
      expect(bulk.metadata?.bulkMetadataEntries).toBeGreaterThan(0)
      expect(fallback.metadata?.bulkMetadataEntries).toBe(0)
    } finally {
      await chmod(denied, 0o755).catch(() => undefined)
      await rm(directory, { recursive: true, force: true })
    }
  })
})
