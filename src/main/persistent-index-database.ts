import { DatabaseSync } from 'node:sqlite'
import { relative } from 'node:path'
import { measureScan } from './diagnostics'
import type { ScanTotals } from './scanner'

export interface SubtreeReplacement {
  readonly path: string
  readonly indexPath: string
}

export interface PersistentIndexUpdate {
  readonly candidatePath: string
  readonly target: string
  readonly replacements: readonly SubtreeReplacement[]
  readonly indexRevision: number
  readonly capacityBytes: number
  readonly freeBytes: number
  readonly elapsedMs: number
  readonly targetAllocatedBytes?: number
}

export interface PersistentIndexUpdateResult {
  readonly rootId: string
  readonly scannedBytes: number
  readonly totals: ScanTotals
}

export class IncrementalFallbackError extends Error {
  constructor(message: string) { super(message); this.name = 'IncrementalFallbackError' }
}

export function replaceIndexSubtrees(update: PersistentIndexUpdate): PersistentIndexUpdateResult {
  if (update.replacements.length === 0) throw new IncrementalFallbackError('Incremental update has no replacement scopes')
  const database = new DatabaseSync(update.candidatePath)
  const schemas = update.replacements.map((_, index) => `incoming_${index}`)
  let transaction = false
  try {
    database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;')
    for (let index = 0; index < update.replacements.length; index += 1) {
      database.prepare(`ATTACH DATABASE ? AS ${schemas[index]}`).run(update.replacements[index]!.indexPath)
    }
    database.exec('BEGIN IMMEDIATE')
    transaction = true
    createTemporaryTables(database, update.target)
    database.exec('DELETE FROM hardlink_groups; DELETE FROM nodes WHERE kind = \'file\';')

    for (let index = 0; index < update.replacements.length; index += 1) {
      replaceOneSubtree(database, schemas[index]!, update.target, update.replacements[index]!.path)
    }

    measureScan('hardlink-repair', () => rebuildFileOwners(database))
    if (update.targetAllocatedBytes !== undefined) {
      database.prepare("UPDATE nodes SET own_bytes = ? WHERE parent_id IS NULL AND kind = 'directory'").run(update.targetAllocatedBytes)
    }
    measureScan('incremental-aggregate-repair', () => rebuildAggregates(database))
    const result = updateMetadata(database, update)
    measureScan('incremental-validation', () => validateCandidate(database, result.rootId))
    database.exec('COMMIT')
    transaction = false
    return result
  } catch (error) {
    if (transaction) {
      try { database.exec('ROLLBACK') } catch { /* Preserve the reconciliation error. */ }
    }
    throw error
  } finally {
    for (const schema of schemas) {
      try { database.exec(`DETACH DATABASE ${schema}`) } catch { /* Closing the database releases attachments. */ }
    }
    database.close()
  }
}

function createTemporaryTables(database: DatabaseSync, target: string): void {
  database.exec(`
    DROP TABLE IF EXISTS temp.old_file_ids;
    CREATE TEMP TABLE old_file_ids (path_key TEXT PRIMARY KEY, node_id TEXT NOT NULL);
    DROP TABLE IF EXISTS temp.refreshed_aliases;
    CREATE TEMP TABLE refreshed_aliases (
      path_key TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL, allocated_bytes INTEGER NOT NULL
    );
  `)
  database.prepare(`
    INSERT INTO old_file_ids (path_key, node_id)
    SELECT CASE WHEN ? = '/' THEN substr(path, 2) ELSE substr(path, length(?) + 2) END, id
    FROM nodes WHERE kind = 'file'
  `).run(target, target)
}

function replaceOneSubtree(database: DatabaseSync, schema: string, target: string, scope: string): void {
  if (scope === target) throw new IncrementalFallbackError('The dirty scope requires a full target scan')
  const incomingRoot = database.prepare(`SELECT id, path FROM ${schema}.nodes WHERE parent_id IS NULL AND kind = 'directory'`).get() as { id?: string; path?: string } | undefined
  if (!incomingRoot?.id || incomingRoot.path !== scope) throw new IncrementalFallbackError('Replacement index has the wrong root')

  const existing = database.prepare("SELECT id, parent_id AS parentId, depth FROM nodes WHERE path = ? AND kind = 'directory'").get(scope) as unknown as { id: string; parentId: string | null; depth: number } | undefined
  const parentPath = scope.slice(0, scope.lastIndexOf('/')) || '/'
  const parent = existing?.parentId
    ? { id: existing.parentId, depth: Number(existing.depth) - 1 }
    : database.prepare("SELECT id, depth FROM nodes WHERE path = ? AND kind = 'directory'").get(parentPath) as unknown as { id: string; depth: number } | undefined
  if (!parent?.id) throw new IncrementalFallbackError('Replacement parent is not indexed')

  if (existing) database.prepare('DELETE FROM nodes WHERE id = ?').run(existing.id)
  const collision = database.prepare(`SELECT 1 AS found FROM ${schema}.nodes incoming JOIN nodes current ON current.id = incoming.id WHERE incoming.kind = 'directory' LIMIT 1`).get() as { found?: number } | undefined
  if (collision?.found) throw new IncrementalFallbackError('Replacement node ID collision')

  const incomingDepth = database.prepare(`SELECT depth FROM ${schema}.nodes WHERE id = ?`).get(incomingRoot.id) as { depth: number }
  const depthOffset = parent.depth + 1 - Number(incomingDepth.depth)
  database.prepare(`
    INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, own_unreadable, direct_children,
      descendant_count, unreadable_count, device, inode, scan_state, enumeration_complete, depth)
    SELECT id, CASE WHEN parent_id IS NULL THEN ? ELSE parent_id END, name, path, kind, own_bytes, size_bytes,
      own_unreadable, direct_children, descendant_count, unreadable_count, device, inode, scan_state,
      enumeration_complete, depth + ? FROM ${schema}.nodes WHERE kind = 'directory' ORDER BY depth
  `).run(parent.id, depthOffset)
  const prefix = relative(target, scope)
  database.prepare(`
    INSERT INTO file_aliases (parent_id, name, path_key, device, inode, allocated_bytes)
    SELECT parent_id, name, CASE WHEN ? = '' THEN path_key ELSE ? || '/' || path_key END,
      device, inode, allocated_bytes FROM ${schema}.file_aliases
  `).run(prefix, prefix)
  database.prepare(`
    INSERT INTO refreshed_aliases (path_key, device, inode, allocated_bytes)
    SELECT CASE WHEN ? = '' THEN path_key ELSE ? || '/' || path_key END, device, inode, allocated_bytes
    FROM ${schema}.file_aliases
  `).run(prefix, prefix)
  database.exec(`
    INSERT INTO directory_observations (node_id, direct_skipped_count, direct_unreadable_count,
      direct_disappearing_count, direct_symlink_count, direct_nested_mount_count, direct_duplicate_count, enumeration_status)
    SELECT node_id, direct_skipped_count, direct_unreadable_count, direct_disappearing_count,
      direct_symlink_count, direct_nested_mount_count, direct_duplicate_count, enumeration_status
    FROM ${schema}.directory_observations;
  `)
}

function rebuildFileOwners(database: DatabaseSync): void {
  database.exec(`
    UPDATE file_aliases SET allocated_bytes = COALESCE((
      SELECT refreshed.allocated_bytes FROM refreshed_aliases refreshed
      WHERE refreshed.device = file_aliases.device AND refreshed.inode = file_aliases.inode
        AND refreshed.device <> '' AND refreshed.inode <> '' LIMIT 1
    ), allocated_bytes);
    DROP TABLE IF EXISTS temp.alias_owners;
    CREATE TEMP TABLE alias_owners AS
      SELECT ranked.path_key, ranked.parent_id, ranked.name, ranked.device, ranked.inode, ranked.allocated_bytes,
        COALESCE(old.node_id, 'n-' || lower(hex(randomblob(16)))) AS node_id
      FROM (
        SELECT aliases.*, row_number() OVER (
          PARTITION BY CASE WHEN device = '' OR inode = '' THEN 'path:' || path_key ELSE 'inode:' || device || ':' || inode END
          ORDER BY path_key COLLATE BINARY
        ) AS rank
        FROM file_aliases aliases
      ) ranked
      LEFT JOIN old_file_ids old ON old.path_key = ranked.path_key
      WHERE rank = 1;
    CREATE UNIQUE INDEX temp.alias_owners_path ON alias_owners(path_key);
    INSERT INTO nodes (id, parent_id, name, path, kind, own_bytes, size_bytes, own_unreadable, direct_children,
      descendant_count, unreadable_count, device, inode, scan_state, enumeration_complete, depth)
      SELECT owners.node_id, owners.parent_id, owners.name,
        parents.path || CASE WHEN parents.path = '/' THEN '' ELSE '/' END || owners.name,
        'file', owners.allocated_bytes, owners.allocated_bytes, 0, 0, 0, 0,
        owners.device, owners.inode, 'complete', 1, parents.depth + 1
      FROM alias_owners owners JOIN nodes parents ON parents.id = owners.parent_id;
    INSERT INTO hardlink_groups (device, inode, owner_path_key, node_id, allocated_bytes)
      SELECT device, inode, path_key, node_id, allocated_bytes FROM alias_owners WHERE device <> '' AND inode <> '';
    UPDATE directory_observations
      SET direct_skipped_count = direct_skipped_count - direct_duplicate_count, direct_duplicate_count = 0;
    UPDATE directory_observations
      SET direct_duplicate_count = (
        SELECT COUNT(*) FROM file_aliases aliases
        LEFT JOIN alias_owners owners ON owners.path_key = aliases.path_key
        WHERE aliases.parent_id = directory_observations.node_id AND owners.path_key IS NULL
      );
    UPDATE directory_observations
      SET direct_skipped_count = direct_skipped_count + direct_duplicate_count;
  `)
}

function rebuildAggregates(database: DatabaseSync): void {
  database.exec(`
    UPDATE nodes SET size_bytes = own_bytes, direct_children = 0, descendant_count = 0,
      unreadable_count = own_unreadable WHERE kind = 'directory';
  `)
  const depth = database.prepare("SELECT COALESCE(MAX(depth), 0) AS depth FROM nodes WHERE kind = 'directory'").get() as { depth: number }
  const update = database.prepare(`
    UPDATE nodes SET
      size_bytes = own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = nodes.id), 0),
      direct_children = (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id),
      descendant_count = COALESCE((SELECT SUM(1 + child.descendant_count) FROM nodes child WHERE child.parent_id = nodes.id), 0),
      unreadable_count = own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = nodes.id), 0)
    WHERE kind = 'directory' AND depth = ?
  `)
  for (let current = Number(depth.depth); current >= 0; current -= 1) update.run(current)
}

function updateMetadata(database: DatabaseSync, update: PersistentIndexUpdate): PersistentIndexUpdateResult {
  const root = database.prepare("SELECT id, size_bytes AS sizeBytes FROM nodes WHERE parent_id IS NULL AND kind = 'directory'").get() as unknown as { id: string; sizeBytes: number } | undefined
  if (!root) throw new IncrementalFallbackError('Incremental candidate has no root')
  const counts = database.prepare(`
    SELECT COUNT(*) AS scannedItems,
      COALESCE(SUM(observations.direct_skipped_count), 0) AS skippedItems,
      COALESCE(SUM(observations.direct_unreadable_count), 0) AS unreadableItems,
      COALESCE(SUM(observations.direct_nested_mount_count), 0) AS nestedMounts,
      COALESCE(SUM(observations.direct_symlink_count), 0) AS symlinks,
      COALESCE(SUM(observations.direct_duplicate_count), 0) AS duplicateHardLinks,
      COALESCE(SUM(observations.direct_disappearing_count), 0) AS disappearingItems
    FROM nodes LEFT JOIN directory_observations observations ON observations.node_id = nodes.id
  `).get() as unknown as Omit<ScanTotals, 'discoveredBytes' | 'elapsedMs'>
  const totals: ScanTotals = {
    scannedItems: Number(counts.scannedItems), discoveredBytes: Number(root.sizeBytes), elapsedMs: update.elapsedMs,
    skippedItems: Number(counts.skippedItems), unreadableItems: Number(counts.unreadableItems),
    nestedMounts: Number(counts.nestedMounts), symlinks: Number(counts.symlinks),
    duplicateHardLinks: Number(counts.duplicateHardLinks), disappearingItems: Number(counts.disappearingItems)
  }
  const put = database.prepare(`INSERT INTO metadata (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
  put.run('rootId', root.id)
  put.run('volume', JSON.stringify({ capacityBytes: update.capacityBytes, freeBytes: update.freeBytes }))
  put.run('totals', JSON.stringify(totals))
  put.run('scannedBytes', String(root.sizeBytes))
  put.run('indexRevision', String(update.indexRevision))
  put.run('refreshedAt', new Date().toISOString())
  return { rootId: root.id, scannedBytes: Number(root.sizeBytes), totals }
}

function validateCandidate(database: DatabaseSync, rootId: string): void {
  const foreignKeyFailure = database.prepare('PRAGMA foreign_key_check').get()
  if (foreignKeyFailure) throw new IncrementalFallbackError('Incremental candidate violates a foreign key')
  const roots = database.prepare('SELECT COUNT(*) AS count FROM nodes WHERE parent_id IS NULL').get() as { count: number }
  if (Number(roots.count) !== 1) throw new IncrementalFallbackError('Incremental candidate has an invalid root count')
  const aggregateFailure = database.prepare(`
    SELECT directory.id FROM nodes directory WHERE directory.kind = 'directory' AND (
      directory.size_bytes <> directory.own_bytes + COALESCE((SELECT SUM(child.size_bytes) FROM nodes child WHERE child.parent_id = directory.id), 0)
      OR directory.direct_children <> (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = directory.id)
      OR directory.descendant_count <> COALESCE((SELECT SUM(1 + child.descendant_count) FROM nodes child WHERE child.parent_id = directory.id), 0)
      OR directory.unreadable_count <> directory.own_unreadable + COALESCE((SELECT SUM(child.unreadable_count) FROM nodes child WHERE child.parent_id = directory.id), 0)
    ) LIMIT 1
  `).get()
  if (aggregateFailure) throw new IncrementalFallbackError('Incremental candidate has invalid directory aggregates')
  const hardLinkFailure = database.prepare(`
    SELECT groups.device FROM hardlink_groups groups
    LEFT JOIN file_aliases aliases ON aliases.path_key = groups.owner_path_key
    LEFT JOIN nodes owner ON owner.id = groups.node_id
    WHERE aliases.path_key IS NULL OR owner.id IS NULL OR aliases.device <> groups.device OR aliases.inode <> groups.inode
      OR owner.kind <> 'file' OR owner.own_bytes <> aliases.allocated_bytes OR groups.allocated_bytes <> aliases.allocated_bytes
      OR groups.owner_path_key <> (SELECT MIN(candidate.path_key COLLATE BINARY) FROM file_aliases candidate
        WHERE candidate.device = groups.device AND candidate.inode = groups.inode)
      OR EXISTS (SELECT 1 FROM file_aliases candidate WHERE candidate.device = groups.device AND candidate.inode = groups.inode
        AND candidate.allocated_bytes <> groups.allocated_bytes)
    LIMIT 1
  `).get()
  if (hardLinkFailure) throw new IncrementalFallbackError('Incremental candidate has invalid hard-link ownership')
  const root = database.prepare('SELECT 1 AS found FROM nodes WHERE id = ? AND parent_id IS NULL').get(rootId) as { found?: number } | undefined
  if (!root?.found) throw new IncrementalFallbackError('Incremental candidate root metadata is invalid')
}
