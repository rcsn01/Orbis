# Orbis

Orbis is a read-only disk usage visualizer for macOS 14 and later on Apple Silicon. The standalone app scans the startup volume after its window loads. The same product code runs inside Moirasia, where the panel stays idle until you click Scan. It stores the completed index in a temporary SQLite database and draws the result as an interactive sunburst.

Orbis never deletes, moves, edits, or uploads files. It can reveal a discovered item in Finder. Allocated blocks, not apparent file length, drive the size display. Symbolic links are skipped and hard links are counted once.

## Development

Orbis is an independent Electron application. Install its dependencies from this directory so its lockfile stays separate from Moirasia:

```sh
pnpm install --ignore-workspace
pnpm dev
```

Set `ORBIS_SCAN_ROOT` while developing or testing to scan a fixture instead of `/`. `ORBIS_USER_DATA` gives an automated run its own Electron data directory.

## Scan benchmark

The benchmark builds the real worker, creates deterministic fixtures outside the timed section, runs one warm-up and five measured scans, and writes raw JSON under the ignored `benchmark-results` directory:

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

The macOS package is an unsigned ARM64 DMG with bundle identifier `com.opense.Orbis`. Full Disk Access is optional. If protected paths are skipped, Orbis keeps the readable index, reports the skipped count, and provides a button to open the relevant System Settings pane.

## Architecture

The renderer receives snapshots, progress, and opaque node IDs through a context-isolated preload. It never receives a filesystem path. The main process owns the active read-only SQLite index and resolves Finder paths only after validating an ID against that index.

Traversal, indexing, and the worker protocol live in `src`. `pnpm build:worker` produces the single ESM file `worker-dist/scan-worker.mjs` for development. Packaged builds place that file at `Resources/features/orbis/worker/scan-worker.mjs`. The optimized progressive scanner is always the production default. It emits path-free previews after root pages, keeps metadata concurrency at four by default, limits open directory handles to eight, and publishes a generation-named database only after traversal and aggregate indexes finish. `ORBIS_LEGACY_SCAN=1` is a no-op compatibility setting and no longer disables live previews, saved pause/resume, persistence, focus/reveal, or incremental refresh. The benchmark harness alone can select the Stage 5 reference with `--scanner legacy`. A canceled or stale worker cannot replace the last completed index.
