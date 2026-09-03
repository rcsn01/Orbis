import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  owner: undefined as { isDestroyed(): boolean; previewFile(path: string): void } | undefined,
  shell: { showItemInFolder: vi.fn(), openExternal: vi.fn(async () => undefined) },
  execFile: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => mocks.owner ?? null },
  shell: mocks.shell
}))
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }))

const { createOrbisSystemShell } = await import('../src/main/system-shell')

const contents = { isDestroyed: () => false }

describe('Orbis system shell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.owner = { isDestroyed: () => false, previewFile: vi.fn() }
    mocks.execFile.mockImplementation((_file, _args, callback) => { callback(null); return {} })
  })

  it('previews on the window that owns the registered renderer', () => {
    const adapter = createOrbisSystemShell(() => contents as never)
    adapter.quickLook('/target/file.txt')
    expect(mocks.owner!.previewFile).toHaveBeenCalledWith('/target/file.txt')
  })

  it('rejects Quick Look without a live owner', () => {
    const adapter = createOrbisSystemShell(() => contents as never)
    mocks.owner = undefined
    expect(() => adapter.quickLook('/target/file.txt')).toThrow('window was closed')
    mocks.owner = { isDestroyed: () => true, previewFile: vi.fn() }
    expect(() => adapter.quickLook('/target/file.txt')).toThrow('window was closed')
  })

  it('passes the terminal directory as one untouched open argument', async () => {
    const adapter = createOrbisSystemShell(() => contents as never)
    const directory = '/target/a folder/$(touch nope);&'
    await adapter.openInTerminal(directory)
    expect(mocks.execFile).toHaveBeenCalledOnce()
    expect(mocks.execFile.mock.calls[0]![0]).toBe('/usr/bin/open')
    expect(mocks.execFile.mock.calls[0]![1]).toEqual(['-b', 'com.apple.Terminal', directory])
  })

  it('rejects terminal process errors', async () => {
    mocks.execFile.mockImplementation((_file, _args, callback) => { callback(new Error('open exited 1')); return {} })
    const adapter = createOrbisSystemShell(() => contents as never)
    await expect(adapter.openInTerminal('/target')).rejects.toThrow('open exited 1')
  })
})
