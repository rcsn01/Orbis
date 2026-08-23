# Orbis

Orbis is a read-only disk usage visualizer for macOS 14 and later on Apple Silicon. It scans the startup volume when it opens, stores the completed index in a temporary SQLite database, and draws the result as an interactive sunburst. Choose another folder or mounted volume when you need a narrower scan.

Orbis never deletes, moves, edits, or uploads files. It can reveal a discovered item in Finder. Allocated blocks, not apparent file length, drive the size display. Symbolic links are skipped and hard links are counted once.

## Development

Orbis is an independent Electron application. Install its dependencies from this directory so its lockfile stays separate from Moirasia:

```sh
pnpm install --ignore-workspace
pnpm dev
```

Set `ORBIS_SCAN_ROOT` while developing or testing to scan a fixture instead of `/`. `ORBIS_USER_DATA` gives an automated run its own Electron data directory.

## Verification and packaging

```sh
pnpm typecheck
pnpm test
pnpm test:smoke
pnpm verify
pnpm package:mac:unsigned
```

The macOS package is an unsigned ARM64 DMG with bundle identifier `com.opense.Orbis`. Full Disk Access is optional. If protected paths are skipped, Orbis keeps the readable index, reports the skipped count, and provides a button to open the relevant System Settings pane.

## Architecture

The renderer receives snapshots, progress, and opaque node IDs through a context-isolated preload. It never receives a filesystem path. The main process owns the active read-only SQLite index and resolves Finder paths only after validating an ID against that index.

Traversal runs in `src/main/scan-worker.ts`, which is built as its own Electron Vite main entry. The worker stays on the selected filesystem, avoids nested mounts and macOS duplicate trees for startup scans, skips unreadable and disappearing entries, and publishes a generation-named database only after traversal and aggregate indexes finish. A canceled or stale worker cannot replace the last completed index.
