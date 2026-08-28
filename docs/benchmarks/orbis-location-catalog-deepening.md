# Location catalog deepening benchmark

## Scope

This benchmark compares the catalog architecture before and after `LocationCatalogStore` took ownership of serialized saved-location transitions, catalog revisions, commit durability, the publication live set, and post-commit retirement.

- Baseline commit: `6e6f20c2d1102740a7bd2e4bee8824dfd5bbd88c`
- Changed commit: `89efcb22844bfa8915bc3b651d0e9232ad18789b`
- Profile: `baseline`
- Samples: 5 measured, 1 warmup
- Fixtures: all
- Metadata concurrency: 4
- Batch size: 256
- Cache state: warm
- Node: v22.22.3
- Platform: macOS arm64

Both revisions used the same fixture profile, native addon, worker build, and benchmark settings. Reports record the commit and environment metadata. Raw reports are retained locally under `benchmark-results/catalog-deepening/` and `/tmp/orbis-catalog-deepening-{baseline,changed}*.json`; `benchmark-results/` is intentionally ignored by Git.

## Acceptance gates

A result requires investigation when median throughput falls by more than 5%, median total scan time, first-preview latency, or database size rises by more than 5%, or checkpoint counts change unexpectedly.

| Scenario | Median throughput change | Median total-time change | Median first-preview change | Median database-size change | Checkpoints |
| --- | ---: | ---: | ---: | ---: | ---: |
| Initial full | -1.0% to +10.0% | -9.1% to +1.0% | -11.6% to +1.0% | -0.3% to +0.7% | unchanged at 3 |
| Resume, clean Pause | +0.1% to +13.1% | -11.6% to -0.1% | -9.2% to +0.8% | -0.3% to +0.8% | unchanged at 3 |
| Resume, process restart | -1.2% to +4.3% | -4.1% to +1.2% | -3.4% to +3.2% | -0.1% to +0.6% | unchanged at 3 |
| Resume, unacknowledged Pause | -1.4% to +46.9% | -31.9% to +1.4% | -2.2% to +1.4% | -0.9% to 0.0% | unchanged at 3 |

Publication-time medians had no regression over 5%: the worst increases were 4.3% for initial scans, 4.0% for clean-Pause Resume, 3.1% for process-restart Resume, and 2.7% for unacknowledged-Pause Resume.

## Investigations

The first clean-Pause matrix reported two failures of the 5% gate:

- `tiny`: first preview rose 16.7%.
- `mixed`: throughput fell 22.3% and total time rose 28.6%.

The `mixed` samples showed FSEvents replay rising from roughly 74–78 ms in the baseline to roughly 195–204 ms in four changed samples, while traversal became slightly faster. A five-sample fixture-only rerun returned to baseline: throughput +0.1%, total time -0.1%, first preview -3.8%, and database size +0.4%.

Because `tiny` is sensitive to fixed startup and history-validation costs, both commits were rerun back-to-back with the same fixture-only command. The changed revision measured throughput +0.2%, total time -0.2%, first preview +0.8%, and database size -0.3% against the fresh baseline. The original increase was environmental rather than architectural.

The unacknowledged-Pause hard-link fixture completed all five changed samples and emitted the expected repair timings. This run did not reproduce the earlier intermittent missing `resume-hardlink-repair` diagnostic.

## Result

The catalog deepening passes the performance gates. It does not reduce scan throughput, delay first preview, increase total scan time or database size materially, or alter checkpoint behavior.
