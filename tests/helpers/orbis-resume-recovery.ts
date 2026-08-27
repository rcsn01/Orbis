import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { createHmac } from 'node:crypto'
import { join } from 'node:path'

export interface ConstructionSnapshot {
  readonly nodes: readonly Record<string, unknown>[]
  readonly directoryTasks: readonly Record<string, unknown>[]
  readonly hardlinkOwners: readonly Record<string, unknown>[]
  readonly hardlinkPaths: readonly Record<string, unknown>[]
  readonly directoryObservations: readonly Record<string, unknown>[]
  readonly directoryAggregateOracle: readonly DirectoryAggregateOracleRow[]
}

export interface DirectoryAggregateOracleRow {
  readonly id: string
  readonly sizeBytes: number
  readonly directChildren: number
  readonly descendantCount: number
  readonly unreadableCount: number
}

export function readConstructionSnapshot(path: string): ConstructionSnapshot {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      nodes: rows(database, `SELECT id, parent_id AS parentId, name, path, kind, own_bytes AS ownBytes,
        size_bytes AS sizeBytes, own_unreadable AS ownUnreadable, direct_children AS directChildren,
        descendant_count AS descendantCount, unreadable_count AS unreadableCount, device, inode,
        scan_state AS scanState, enumeration_complete AS enumerationComplete, depth
        FROM nodes ORDER BY path, id`),
      directoryTasks: rows(database, `SELECT node_id AS nodeId, path, depth, enqueue_order AS enqueueOrder,
        focused, status, entries_read AS entriesRead, ready, pending_children AS pendingChildren,
        subtree_complete AS subtreeComplete, shallow_band AS shallowBand
        FROM directory_tasks ORDER BY node_id`),
      hardlinkOwners: rows(database, 'SELECT device, inode, node_id AS nodeId, path_key AS pathKey FROM hardlink_owners ORDER BY device, inode'),
      hardlinkPaths: rows(database, `SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode,
        allocated_bytes AS allocatedBytes FROM hardlink_paths ORDER BY path_key COLLATE BINARY`),
      directoryObservations: rows(database, `SELECT node_id AS nodeId, direct_skipped_count AS directSkippedCount,
        direct_unreadable_count AS directUnreadableCount, direct_disappearing_count AS directDisappearingCount,
        direct_symlink_count AS directSymlinkCount, direct_nested_mount_count AS directNestedMountCount,
        direct_duplicate_count AS directDuplicateCount, enumeration_status AS enumerationStatus
        FROM directory_observations ORDER BY node_id`),
      directoryAggregateOracle: readDirectoryAggregateOracleFromDatabase(database)
    }
  } finally { database.close() }
}

/**
 * Run the pre-Stage-4 full-rebuild recovery against a copied checkpoint.
 * This is deliberately test-only: it provides a semantic oracle, not a
 * production fallback or a second recovery implementation.
 */
export function readDirectoryAggregateOracle(path: string): readonly DirectoryAggregateOracleRow[] {
  const database = new DatabaseSync(path, { readOnly: true })
  try { return readDirectoryAggregateOracleFromDatabase(database) }
  finally { database.close() }
}

function readDirectoryAggregateOracleFromDatabase(database: DatabaseSync): readonly DirectoryAggregateOracleRow[] {
  type Node = { id: string; parentId: string | null; kind: string; ownBytes: number; ownUnreadable: number; depth: number }
  const nodes = database.prepare(`SELECT id, parent_id AS parentId, kind, own_bytes AS ownBytes,
    own_unreadable AS ownUnreadable, depth FROM nodes`).all() as unknown as Node[]
  const children = new Map<string, Node[]>()
  for (const node of nodes) {
    if (!node.parentId) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const aggregates = new Map<string, DirectoryAggregateOracleRow>()
  for (const node of [...nodes].sort((left, right) => right.depth - left.depth || left.id.localeCompare(right.id))) {
    if (node.kind !== 'directory') continue
    const direct = children.get(node.id) ?? []
    let sizeBytes = Number(node.ownBytes)
    let descendantCount = 0
    let unreadableCount = Number(node.ownUnreadable)
    for (const child of direct) {
      const aggregate = child.kind === 'directory' ? aggregates.get(child.id) : undefined
      sizeBytes += aggregate?.sizeBytes ?? Number(child.ownBytes)
      descendantCount += 1 + (aggregate?.descendantCount ?? 0)
      unreadableCount += aggregate?.unreadableCount ?? Number(child.ownUnreadable)
    }
    aggregates.set(node.id, { id: node.id, sizeBytes, directChildren: direct.length, descendantCount, unreadableCount })
  }
  return [...aggregates.values()].sort((left, right) => left.id.localeCompare(right.id))
}

export function recoverWithLegacyReference(sourcePath: string, destinationPath: string): ConstructionSnapshot {
  copySQLiteFamily(sourcePath, destinationPath)
  const database = new DatabaseSync(destinationPath)
  try {
    database.exec('PRAGMA foreign_keys=ON; BEGIN; CREATE TEMP TABLE legacy_recovery_roots (id TEXT PRIMARY KEY);')
    database.exec(`
      INSERT INTO legacy_recovery_roots (id)
      SELECT task.node_id FROM directory_tasks task
      WHERE task.status IN ('queued', 'scanning') AND NOT EXISTS (
        WITH RECURSIVE ancestors(id, parent_id) AS (
          SELECT parent.id, parent.parent_id
          FROM nodes child JOIN nodes parent ON parent.id = child.parent_id
          WHERE child.id = task.node_id
          UNION ALL
          SELECT parent.id, parent.parent_id
          FROM nodes parent JOIN ancestors child ON parent.id = child.parent_id
        )
        SELECT 1 FROM ancestors JOIN directory_tasks ancestor_task ON ancestor_task.node_id = ancestors.id
        WHERE ancestor_task.status IN ('queued', 'scanning')
      );
      UPDATE directory_observations
      SET direct_skipped_count = MAX(0, direct_skipped_count - direct_duplicate_count), direct_duplicate_count = 0;
      DELETE FROM hardlink_paths WHERE parent_id IN (SELECT id FROM legacy_recovery_roots);
      DELETE FROM nodes WHERE parent_id IN (SELECT id FROM legacy_recovery_roots);
      DELETE FROM hardlink_owners;
      UPDATE nodes SET size_bytes = own_bytes, direct_children = 0, descendant_count = 0,
        unreadable_count = own_unreadable, scan_state = 'queued', enumeration_complete = 0
        WHERE id IN (SELECT id FROM legacy_recovery_roots);
      UPDATE directory_tasks SET status = 'queued', entries_read = 0
        WHERE node_id IN (SELECT id FROM legacy_recovery_roots);
      UPDATE directory_observations SET direct_skipped_count = 0, direct_unreadable_count = 0,
        direct_disappearing_count = 0, direct_symlink_count = 0, direct_nested_mount_count = 0,
        direct_duplicate_count = 0, enumeration_status = 'queued'
        WHERE node_id IN (SELECT id FROM legacy_recovery_roots);
    `)
    repairAllHardLinks(database)
    database.exec(`
      UPDATE nodes SET direct_children = (SELECT COUNT(*) FROM nodes child WHERE child.parent_id = nodes.id);
      UPDATE nodes SET size_bytes = own_bytes, descendant_count = 0, unreadable_count = own_unreadable;
      WITH RECURSIVE closure(ancestor, descendant) AS (
        SELECT parent_id, id FROM nodes WHERE parent_id IS NOT NULL
        UNION ALL SELECT nodes.parent_id, closure.descendant
        FROM nodes JOIN closure ON nodes.id = closure.ancestor WHERE nodes.parent_id IS NOT NULL
      ), totals AS (
        SELECT ancestor, SUM(nodes.own_bytes) AS bytes, COUNT(*) AS descendants, SUM(nodes.own_unreadable) AS unreadable
        FROM closure JOIN nodes ON nodes.id = closure.descendant GROUP BY ancestor
      ) UPDATE nodes SET size_bytes = own_bytes + COALESCE((SELECT bytes FROM totals WHERE ancestor = nodes.id), 0),
        descendant_count = COALESCE((SELECT descendants FROM totals WHERE ancestor = nodes.id), 0),
        unreadable_count = own_unreadable + COALESCE((SELECT unreadable FROM totals WHERE ancestor = nodes.id), 0);
      UPDATE directory_tasks SET subtree_complete = CASE WHEN node_id IN
        (SELECT id FROM nodes WHERE scan_state IN ('complete', 'unreadable')) THEN 1 ELSE 0 END;
      UPDATE directory_tasks SET pending_children = (SELECT COUNT(*) FROM nodes child JOIN directory_tasks child_task
        ON child_task.node_id = child.id WHERE child.parent_id = directory_tasks.node_id AND child_task.subtree_complete = 0);
      UPDATE directory_tasks SET ready = CASE WHEN subtree_complete = 1 THEN 0
        WHEN node_id IN (SELECT id FROM nodes WHERE parent_id IS NULL) THEN 1
        WHEN node_id IN (SELECT child.id FROM nodes child JOIN nodes parent ON parent.id = child.parent_id
          WHERE parent.enumeration_complete = 1) THEN 1 ELSE 0 END;
      DROP TABLE legacy_recovery_roots;
      COMMIT;
    `)
  } catch (error) {
    try { database.exec('ROLLBACK') } catch { /* Preserve the oracle error. */ }
    throw error
  } finally { database.close() }
  return readConstructionSnapshot(destinationPath)
}

function repairAllHardLinks(database: DatabaseSync): void {
  type Alias = { parentId: string; name: string; pathKey: string; device: string; inode: string; allocatedBytes: number }
  const aliases = database.prepare(`SELECT parent_id AS parentId, name, path_key AS pathKey, device, inode,
    allocated_bytes AS allocatedBytes FROM hardlink_paths`).all() as unknown as Alias[]
  const groups = new Map<string, Alias[]>()
  for (const alias of aliases) {
    if (alias.device === '' || alias.inode === '') continue
    const key = `${alias.device}\0${alias.inode}`
    const group = groups.get(key) ?? []
    group.push(alias)
    groups.set(key, group)
  }
  const seedRow = database.prepare('SELECT node_id_seed AS seed FROM scan_run WHERE singleton = 1').get() as { seed?: string } | undefined
  if (!seedRow?.seed) throw new Error('Legacy oracle checkpoint has no node ID seed')
  const seed = Buffer.from(seedRow.seed, 'hex')
  const existingNodes = database.prepare("SELECT id, device, inode FROM nodes WHERE kind = 'file'")
  const deleteNode = database.prepare('DELETE FROM nodes WHERE id = ?')
  const parentNode = database.prepare('SELECT path, depth FROM nodes WHERE id = ?')
  const insertNode = database.prepare(`INSERT INTO nodes
    (id, parent_id, name, path, kind, own_bytes, size_bytes, device, inode, scan_state, enumeration_complete, depth)
    VALUES (?, ?, ?, ?, 'file', ?, ?, ?, ?, 'complete', 1, ?)`)
  const insertOwner = database.prepare('INSERT INTO hardlink_owners (device, inode, node_id, path_key) VALUES (?, ?, ?, ?)')
  const bumpDuplicate = database.prepare(`UPDATE directory_observations SET direct_skipped_count = direct_skipped_count + 1,
    direct_duplicate_count = direct_duplicate_count + 1 WHERE node_id = ?`)
  const fileNodes = new Map<string, string[]>()
  for (const row of existingNodes.all() as unknown as Array<{ id: string; device: string; inode: string }>) {
    const key = `${row.device}\0${row.inode}`
    const ids = fileNodes.get(key) ?? []
    ids.push(row.id)
    fileNodes.set(key, ids)
  }
  for (const group of groups.values()) {
    group.sort((left, right) => Buffer.compare(Buffer.from(left.pathKey, 'utf8'), Buffer.from(right.pathKey, 'utf8')))
    const owner = group[0]!
    const id = `n-${createHmac('sha256', seed).update(owner.parentId).update('\0').update(owner.name).digest('hex').slice(0, 32)}`
    const existing = fileNodes.get(`${owner.device}\0${owner.inode}`) ?? []
    if (group.length === 1 && existing.length === 1 && existing[0] === id) {
      insertOwner.run(owner.device, owner.inode, id, owner.pathKey)
      continue
    }
    for (const rowId of existing) deleteNode.run(rowId)
    const parent = parentNode.get(owner.parentId) as { path?: string; depth?: number } | undefined
    if (!parent?.path) continue
    insertNode.run(id, owner.parentId, owner.name, join(parent.path, owner.name), owner.allocatedBytes, owner.allocatedBytes,
      owner.device, owner.inode, Number(parent.depth ?? 0) + 1)
    insertOwner.run(owner.device, owner.inode, id, owner.pathKey)
    for (const duplicate of group.slice(1)) bumpDuplicate.run(duplicate.parentId)
  }
}

function copySQLiteFamily(sourcePath: string, destinationPath: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    const source = `${sourcePath}${suffix}`
    const destination = `${destinationPath}${suffix}`
    rmSync(destination, { force: true })
    if (existsSync(source)) copyFileSync(source, destination)
  }
}

export interface CandidateSemantics {
  readonly nodes: readonly Record<string, unknown>[]
  readonly observations: readonly Record<string, unknown>[]
  readonly hardlinkPaths: readonly Record<string, unknown>[]
  readonly hardlinkGroups: readonly Record<string, unknown>[]
  readonly metadata: readonly Record<string, unknown>[]
  readonly semanticTotals: Readonly<Record<string, unknown>>
}

export function readCandidateSemantics(path: string): CandidateSemantics {
  const database = new DatabaseSync(path, { readOnly: true })
  try {
    return {
      nodes: rows(database, `SELECT node.path, parent.path AS parentPath, node.name, node.kind,
        node.own_bytes AS ownBytes, node.size_bytes AS sizeBytes, node.own_unreadable AS ownUnreadable,
        node.direct_children AS directChildren, node.descendant_count AS descendantCount,
        node.unreadable_count AS unreadableCount, node.device, node.inode, node.scan_state AS scanState
        FROM nodes node LEFT JOIN nodes parent ON parent.id = node.parent_id ORDER BY node.path`),
      observations: rows(database, `SELECT node.path, observations.direct_skipped_count AS directSkippedCount,
        observations.direct_unreadable_count AS directUnreadableCount, observations.direct_disappearing_count AS directDisappearingCount,
        observations.direct_symlink_count AS directSymlinkCount, observations.direct_nested_mount_count AS directNestedMountCount,
        observations.direct_duplicate_count AS directDuplicateCount
        FROM directory_observations observations JOIN nodes node ON node.id = observations.node_id ORDER BY node.path`),
      hardlinkPaths: rows(database, `SELECT parent.path AS parentPath, paths.name, paths.path_key AS pathKey,
        paths.device, paths.inode, paths.allocated_bytes AS allocatedBytes
        FROM hardlink_paths paths JOIN nodes parent ON parent.id = paths.parent_id ORDER BY paths.path_key COLLATE BINARY`),
      hardlinkGroups: rows(database, `SELECT groups.device, groups.inode, groups.owner_path_key AS ownerPathKey,
        owner.path, groups.allocated_bytes AS allocatedBytes
        FROM hardlink_groups groups JOIN nodes owner ON owner.id = groups.node_id ORDER BY groups.device, groups.inode`),
      metadata: rows(database, 'SELECT key, value FROM metadata ORDER BY key'),
      semanticTotals: readSemanticTotals(database)
    }
  } finally { database.close() }
}

export function normalizeCandidateSemantics(value: CandidateSemantics): CandidateSemantics {
  const volatileMetadata = new Set(['capturedAt', 'refreshedAt', 'indexDirectoryIdentity', 'resumeDrainedThrough', 'resumeDirtyScopes'])
  const metadata = value.metadata
    .filter((row) => typeof row.key !== 'string' || !volatileMetadata.has(row.key))
    .map((row) => {
      if (row.key === 'rootId') return { ...row, value: '<root>' }
      if (row.key !== 'totals' && row.key !== 'volume' || typeof row.value !== 'string') return row
      try {
        const metadata = JSON.parse(row.value) as Record<string, unknown>
        if (row.key === 'totals') delete metadata.elapsedMs
        else delete metadata.freeBytes
        return { ...row, value: JSON.stringify(metadata) }
      } catch { return row }
    })
  const semanticTotals = { ...value.semanticTotals }
  delete semanticTotals.elapsedMs
  return { ...value, metadata, semanticTotals }
}

function readSemanticTotals(database: DatabaseSync): Readonly<Record<string, unknown>> {
  const nodes = database.prepare(`SELECT COUNT(*) AS scannedItems,
    COALESCE((SELECT size_bytes FROM nodes WHERE parent_id IS NULL), 0) AS discoveredBytes FROM nodes`).get() as {
    scannedItems?: number; discoveredBytes?: number
  }
  const observations = database.prepare(`SELECT COALESCE(SUM(direct_skipped_count), 0) AS skippedItems,
    COALESCE(SUM(direct_unreadable_count), 0) AS unreadableItems,
    COALESCE(SUM(direct_disappearing_count), 0) AS disappearingItems,
    COALESCE(SUM(direct_symlink_count), 0) AS symlinks,
    COALESCE(SUM(direct_nested_mount_count), 0) AS nestedMounts,
    COALESCE(SUM(direct_duplicate_count), 0) AS duplicateHardLinks
    FROM directory_observations`).get() as Record<string, number>
  const row = database.prepare("SELECT value FROM metadata WHERE key = 'totals'").get() as { value?: unknown } | undefined
  let persisted: Record<string, unknown> = {}
  if (typeof row?.value === 'string') {
    try { persisted = JSON.parse(row.value) as Record<string, unknown> }
    catch { persisted = {} }
  }
  return {
    scannedItems: Number(nodes.scannedItems ?? 0), discoveredBytes: Number(nodes.discoveredBytes ?? 0),
    skippedItems: Number(observations.skippedItems ?? 0), unreadableItems: Number(observations.unreadableItems ?? 0),
    disappearingItems: Number(observations.disappearingItems ?? 0), symlinks: Number(observations.symlinks ?? 0),
    nestedMounts: Number(observations.nestedMounts ?? 0), duplicateHardLinks: Number(observations.duplicateHardLinks ?? 0),
    bulkMetadataEntries: Number(persisted.bulkMetadataEntries ?? 0), fallbackMetadataEntries: Number(persisted.fallbackMetadataEntries ?? 0),
    activeElapsedMs: Number(persisted.activeElapsedMs ?? 0)
  }
}

function rows(database: DatabaseSync, query: string): readonly Record<string, unknown>[] {
  return database.prepare(query).all() as unknown as readonly Record<string, unknown>[]
}
