# Orbis

Orbis is a standalone read-only disk usage visualizer for macOS 14 and later on Apple Silicon. Choose a location and click Scan to begin. It stores the completed index in an app-private SQLite database and draws the result as an interactive sunburst. It shares Moirasia's desktop shell and React UI packages, but Moirasia does not embed, discover, launch, or configure it.

Orbis never deletes, moves, edits, or uploads files. Right-click any indexed file or folder to preview it with macOS Quick Look, show it in Finder, or open Terminal. A folder opens Terminal at its own location. A file opens Terminal at the folder currently focused in Orbis. These actions only ask macOS to display an item or open Terminal. Allocated blocks, not apparent file length, drive the size display. Symbolic links are skipped and hard links are counted once.

## Development

Orbis is an independent Electron application. Install its dependencies from this directory so its lockfile stays separate from Moirasia:

```sh
pnpm install --ignore-workspace
pnpm dev
```

Set `ORBIS_SCAN_ROOT` while developing or testing to scan a fixture instead of `/`. `ORBIS_USER_DATA` gives an automated run its own Electron data directory.

Orbis does not import its former suite data. Existing data under `Application Support/Moirasia/features/orbis` is left untouched, while this app reads and writes only its own Electron data directory.

## Scan benchmark

The benchmark builds the real worker, creates deterministic fixtures outside the timed section, runs one warm-up and five measured scans, and writes schema-6 JSON under the ignored `benchmark-results` directory. Reports separate wall-clock phases from overlapping work totals and include scheduler, metadata, checkpoint, hard-link, and retry counters:

```sh
pnpm benchmark:scan -- --profile baseline --warmup 1 --samples 5 --fixture all
```

Use `--profile quick --samples 1` to validate the harness. Pass `--scanner progressive` or `--scanner legacy` to compare the two implementations. Progressive is the default. A live path requires both `--target <path>` and `--allow-live-target`, so the benchmark cannot scan the startup volume by accident.

Prepare a cold-cache run before restarting. The prepared command performs no build afterward:

```sh
pnpm benchmark:scan:prepare
pnpm benchmark:scan:prepared -- --target / --allow-live-target --cache-state cold-manual --warmup 0 --samples 1
```

## Verification and packaging

```sh
pnpm typecheck
pnpm test
pnpm test:smoke
pnpm verify
pnpm package:mac:unsigned
```

Create and publish a macOS release from the local Mac:

```sh
brew install gh
gh auth login
pnpm release:mac
```

The release command requires a clean `main` branch and a semantic `package.json` version greater than the latest `v<version>` release. It builds the unsigned ARM64 DMG, writes a SHA-256 checksum, creates the matching tag, atomically pushes `main` and the tag, and uploads both files to a GitHub Release with generated notes. Use `pnpm release:mac --dry-run` to inspect the artifact paths without building, tagging, pushing, or uploading anything.

The macOS package is an unsigned ARM64 DMG with bundle identifier `com.opense.Orbis`. Full Disk Access is optional. If protected paths are skipped, Orbis keeps the readable index, reports the skipped count, and provides a button to open the relevant System Settings pane.

### Opening the unsigned DMG

After dragging `Orbis.app` from the DMG into `/Applications`, macOS may report that the app is damaged because the package is unsigned. For a DMG you built or otherwise trust, remove its quarantine flag and try opening it:

```sh
xattr -dr com.apple.quarantine "/Applications/Orbis.app"
open "/Applications/Orbis.app"
```

If macOS still reports that the app is damaged, repair the local ad-hoc signature:

```sh
sudo xattr -cr "/Applications/Orbis.app"
sudo codesign --force --deep --sign - "/Applications/Orbis.app"
open "/Applications/Orbis.app"
```

These commands bypass Gatekeeper checks for this local copy. Use them only for an Orbis build you trust. They do not replace Developer ID signing and notarization for normal distribution.

## Architecture

The renderer receives snapshots, progress, and opaque node IDs through a context-isolated preload. It never receives a filesystem path or chooses a privileged menu action. The main process owns the active read-only SQLite index and resolves native item actions only after validating the node ID, canonical path, filesystem kind, and scan target confinement against the active scan or index.

Traversal, indexing, and the worker protocol live in `src`. `pnpm build:worker` produces the single ESM file `worker-dist/scan-worker.mjs` for development. Packaged builds place that file at `Resources/worker/scan-worker.mjs`. The optimized progressive scanner is always the production default. It emits path-free previews after root pages, keeps metadata concurrency at four by default, limits open directory handles to eight, and publishes a generation-named database only after traversal and aggregate indexes finish. During live traversal and indexing, the displayed scanned-byte total never falls behind the last durable preview. Published schema 3 stores unique files only in `nodes` and keeps sparse `hardlink_paths` for identities that need deduplication. Construction schema 4 retains checkpointed rows, replays unfinished directories from offset zero with epoch-checked pages, sweeps unseen children only after enumeration, and reconciles hard-link ownership before publication. On macOS, native traversal uses packed metadata pages and opens directories relative to one no-follow target descriptor. Native capability notices and worker failures are kept in the private, mode-0600 `indexes/scan-diagnostics.json`; records are bounded, path-free, atomic, and best effort. `ORBIS_LEGACY_SCAN=1` is a no-op compatibility setting and no longer disables live previews, saved pause/resume, persistence, focus/reveal, or incremental refresh. The benchmark harness alone can select the Stage 5 reference with `--scanner legacy`. A canceled or stale worker cannot replace the last completed index.
