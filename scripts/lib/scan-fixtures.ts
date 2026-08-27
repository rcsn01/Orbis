import { link, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type ScanFixtureName = 'wide' | 'deep' | 'tiny' | 'mixed' | 'semantics' | 'directories' | 'hardlinks'
export type ScanFixtureProfile = 'quick' | 'baseline'

export interface ScanFixtureManifest {
  readonly name: ScanFixtureName
  readonly profile: ScanFixtureProfile
  readonly files: number
  readonly directories: number
  readonly symlinks: number
  readonly hardLinkAliases: number
  readonly bytesWritten: number
  readonly filesystemType?: string
}

export interface ScanFixture {
  readonly directory: string
  readonly root: string
  readonly manifest: ScanFixtureManifest
  cleanup(): Promise<void>
}

export async function createScanFixture(name: ScanFixtureName, profile: ScanFixtureProfile = 'baseline'): Promise<ScanFixture> {
  const directory = await mkdtemp(join(tmpdir(), `orbis-${name}-`))
  const root = join(directory, 'volume')
  await mkdir(root, { recursive: true })
  try {
    const manifest = name === 'wide'
      ? await createWide(root, profile)
      : name === 'deep'
        ? await createDeep(root, profile)
        : name === 'tiny'
          ? await createTiny(root, profile)
          : name === 'mixed'
            ? await createMixed(root, profile)
            : name === 'semantics'
              ? await createSemantics(root, profile)
              : name === 'directories'
                ? await createDirectories(root, profile)
                : await createHardlinks(root, profile)
    return { directory, root, manifest, cleanup: () => rm(directory, { recursive: true, force: true }) }
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
}

async function createWide(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const files = profile === 'quick' ? 200 : 2_000
  const payload = Buffer.alloc(128, 0x77)
  await writeBatches(Array.from({ length: files }, (_, index) => [join(root, `wide-${padded(index)}.dat`), payload] as const))
  return manifest('wide', profile, files, 1, 0, 0, files * payload.length)
}

async function createDeep(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const depth = profile === 'quick' ? 32 : 128
  const payload = Buffer.alloc(64, 0x64)
  let current = root
  for (let index = 0; index < depth; index += 1) {
    current = join(current, `d${padded(index, 3)}`)
    await mkdir(current)
    await writeFile(join(current, `file-${padded(index, 3)}.dat`), payload)
  }
  return manifest('deep', profile, depth, depth + 1, 0, 0, depth * payload.length)
}

async function createTiny(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const directoryCount = profile === 'quick' ? 10 : 100
  const filesPerDirectory = profile === 'quick' ? 20 : 100
  const payload = Buffer.from([0x74])
  const writes: Array<readonly [string, Uint8Array]> = []
  for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
    const child = join(root, `bucket-${padded(directoryIndex, 3)}`)
    await mkdir(child)
    for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) writes.push([join(child, `tiny-${padded(fileIndex, 3)}.dat`), payload])
  }
  await writeBatches(writes)
  const files = directoryCount * filesPerDirectory
  return manifest('tiny', profile, files, directoryCount + 1, 0, 0, files)
}

async function createMixed(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const directoryCount = profile === 'quick' ? 5 : 20
  const filesPerDirectory = profile === 'quick' ? 20 : 100
  let bytesWritten = 0
  for (let directoryIndex = 0; directoryIndex < directoryCount; directoryIndex += 1) {
    const child = join(root, `group-${padded(directoryIndex, 3)}`)
    await mkdir(child)
    const writes: Array<readonly [string, Uint8Array]> = []
    for (let fileIndex = 0; fileIndex < filesPerDirectory; fileIndex += 1) {
      const size = 512 * (1 + (directoryIndex * 17 + fileIndex * 31) % 128)
      bytesWritten += size
      writes.push([join(child, `mixed-${padded(fileIndex, 3)}.dat`), Buffer.alloc(size, (directoryIndex + fileIndex) % 251)])
    }
    await writeBatches(writes)
  }
  const files = directoryCount * filesPerDirectory
  return manifest('mixed', profile, files, directoryCount + 1, 0, 0, bytesWritten)
}

async function createDirectories(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const branches = profile === 'quick' ? 10 : 100
  const children = profile === 'quick' ? 20 : 100
  for (let branch = 0; branch < branches; branch += 1) {
    const parent = join(root, `branch-${padded(branch, 3)}`)
    await mkdir(parent)
    await Promise.all(Array.from({ length: children }, (_, child) => mkdir(join(parent, `empty-${padded(child, 3)}`))))
  }
  return manifest('directories', profile, 0, 1 + branches + branches * children, 0, 0, 0)
}

async function createHardlinks(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const identities = profile === 'quick' ? 10 : 100
  const pathsPerIdentity = profile === 'quick' ? 20 : 100
  const sources = join(root, 'Z-sources')
  const owners = join(root, 'A-owners')
  await mkdir(sources)
  await mkdir(owners)
  let bytesWritten = 0
  for (let identity = 0; identity < identities; identity += 1) {
    const payload = Buffer.alloc(128 + identity, identity % 251)
    const source = join(sources, `source-${padded(identity, 3)}.dat`)
    await writeFile(source, payload)
    bytesWritten += payload.length
    const identityDirectory = join(owners, `identity-${padded(identity, 3)}`)
    await mkdir(identityDirectory)
    await Promise.all(Array.from({ length: pathsPerIdentity - 1 }, (_, alias) => link(source, join(identityDirectory, `alias-${padded(alias, 3)}.dat`))))
  }
  return manifest('hardlinks', profile, identities, 3 + identities, 0, identities * (pathsPerIdentity - 1), bytesWritten)
}

async function createSemantics(root: string, profile: ScanFixtureProfile): Promise<ScanFixtureManifest> {
  const documents = join(root, 'Documents')
  const nested = join(documents, 'Nested')
  await mkdir(nested, { recursive: true })
  await mkdir(join(root, 'Empty'))
  await writeFile(join(documents, 'small.txt'), 'small')
  await writeFile(join(nested, 'large.bin'), Buffer.alloc(48 * 1024, 0x6c))
  await writeFile(join(root, 'root.txt'), Buffer.alloc(8 * 1024, 0x72))
  let symlinks = 0
  let hardLinkAliases = 0
  try { await symlink(documents, join(root, 'Documents-link')); symlinks += 1 } catch { /* Unsupported by the fixture filesystem. */ }
  try { await symlink(join(root, 'root.txt'), join(root, 'root-link.txt')); symlinks += 1 } catch { /* Unsupported by the fixture filesystem. */ }
  try { await link(join(root, 'root.txt'), join(root, 'hard-link.txt')); hardLinkAliases += 1 } catch { /* Unsupported by the fixture filesystem. */ }
  return manifest('semantics', profile, 3, 4, symlinks, hardLinkAliases, 5 + 48 * 1024 + 8 * 1024)
}

async function writeBatches(writes: readonly (readonly [string, Uint8Array])[]): Promise<void> {
  const width = 64
  for (let offset = 0; offset < writes.length; offset += width) {
    await Promise.all(writes.slice(offset, offset + width).map(([path, contents]) => writeFile(path, contents)))
  }
}

function manifest(name: ScanFixtureName, profile: ScanFixtureProfile, files: number, directories: number, symlinks: number, hardLinkAliases: number, bytesWritten: number): ScanFixtureManifest {
  return { name, profile, files, directories, symlinks, hardLinkAliases, bytesWritten }
}

function padded(value: number, width = 5): string { return String(value).padStart(width, '0') }
