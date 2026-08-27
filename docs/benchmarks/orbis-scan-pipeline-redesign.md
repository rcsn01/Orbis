# Orbis scan pipeline redesign benchmark

## Captured artifact

A schema-6 harness validation run completed on 2026-08-27 at 04:54 UTC. The raw report is `benchmark-results/orbis-scan-pipeline-redesign-quick.json`, which remains ignored by the repository's benchmark-results policy.

- Orbis base commit: `99c759b7e9be560f4f0a9d26accc4cb97f0e2c0f`
- Orbis working-tree hash: `3068bdcf7aabc6b9655ca36956b6a8573016ed478a1970227a4f6e0a8bb023a3`
- Worker SHA-256: `f698f27c865136559ac500f7a73f7ffdfbd6d0fb0ed63355da8f4e523edd8a42`
- Benchmark runner SHA-256: `590f8db6669f2b43cd6d69609b2aadaddc0ef6a0f8609d5d5129e22f91969358`
- Native addon SHA-256: `456514e154fa33bdf22538f11099e6edcdf47613c015c6de9e82658cf9b49d1f`
- Machine: Apple M5 Pro, 18 logical CPUs, 64 GiB RAM
- Runtime: Node v22.22.3, Darwin 25.4.0, arm64
- Cache label: warm
- Metadata concurrency: 4
- Page size: 256
- Profile: quick
- Samples: one per fixture, no warm-up

The checkout already contained uncommitted scan-execution and publication-artifact work when this implementation began. No clean, matched pre-change artifact was available, so this run validates correctness and report plumbing only. It is not evidence for the release percentage gates. A release comparison still needs five warm baseline and final samples from clean, commit-pinned artifacts on the same machine.

## Quick validation results

| Fixture | Items | Scan ms | Traversal ms | Aggregation ms | First preview ms | Checkpoints | Hard-link paths | Database MiB |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| wide | 201 | 549.94 | 10.03 | 0.97 | 410.70 | 3 | 0 | 0.24 |
| deep | 65 | 308.40 | 16.77 | 4.25 | 41.58 | 3 | 0 | 0.18 |
| tiny | 211 | 304.50 | 9.48 | 2.11 | 44.14 | 3 | 0 | 0.24 |
| mixed | 106 | 177.92 | 6.17 | 1.26 | 43.67 | 3 | 0 | 0.20 |
| semantics | 7 | 172.32 | 3.42 | 0.90 | 42.43 | 3 | 2 | 0.14 |
| directories | 211 | 211.35 | 41.94 | 23.14 | 44.48 | 3 | 0 | 0.33 |
| hardlinks | 23 | 306.11 | 8.70 | 2.44 | 38.76 | 3 | 200 | 0.22 |

The `tiny` fixture produced zero `hardlink_paths` rows. The `hardlinks` fixture stored all 200 observed tracked paths for ten identities and reported 190 duplicate observations. Native mode handled every metadata entry in this run. The raw samples contain all nested work timings, counters, table-level byte totals, RSS samples, median fields, p95 fields, and median absolute deviation fields required by report schema 6. With one sample, p95 and median absolute deviation do not characterize variance.

## Required release matrix

Before release, capture both baseline and final artifacts with:

```sh
pnpm benchmark:scan -- --profile baseline --warmup 1 --samples 5 --fixture all --concurrency 4 --batch-size 256
```

Repeat the five refresh scenarios with the same cache state and artifacts: warm no-change, one-file allocation, directory rename, hard-link owner change, and dropped-history fallback. Evaluate deterministic result parity first. Then apply the scan-time, first-preview, RSS, and database-byte gates from the redesign plan. Do not compare this quick dirty-tree run with historical reports made from different implementations.

Current resume measurements use report schema 8 and are documented separately in `docs/benchmarks/orbis-resume-optimization.md`. Schema-7 reports remain historical Stage 4 artifacts; schema-6 reports do not contain resume lifecycle metrics and are not resume baselines.
