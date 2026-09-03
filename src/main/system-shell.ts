import { execFile } from 'node:child_process'
import { BrowserWindow, shell, type WebContents } from 'electron'
import type { OrbisShell } from './controller'

export function createOrbisSystemShell(getWebContents: () => WebContents | undefined): OrbisShell {
  return {
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openExternal: (url) => shell.openExternal(url),
    quickLook: (path) => {
      const contents = getWebContents()
      const owner = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null
      if (!owner || owner.isDestroyed()) throw new Error('Quick Look is unavailable because the Orbis window was closed')
      owner.previewFile(path)
    },
    openInTerminal: (directory) => new Promise<void>((resolve, reject) => {
      execFile('/usr/bin/open', ['-b', 'com.apple.Terminal', directory], (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}
