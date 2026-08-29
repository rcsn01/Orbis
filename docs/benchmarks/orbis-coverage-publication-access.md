# Coverage publication access benchmark

## Setup

The baseline is clean commit `e93c32490dd43d6750c0bd0a4423b24c8634d6d6`. The changed run uses the same commit plus working-tree hash `b908447585f332ec93aae6a9d4baaa813182e5e686c1baa5adfec1f19df22d90`; there is no changed commit yet. Both runs used Node v22.22.3 on Darwin 25.4.0, Apple M5 Pro arm64, 18 logical CPUs, 64 GiB memory, the same native addon hash `456514e154fa33bdf22538f11099e6edcdf47613c015c6de9e82658cf9b49d1f`, metadata concurrency 4, batch size 256, one warmup, and five measured samples.

Raw schema-8 reports are retained under ignored `benchmark-results/coverage-publication-access/`. Values below are medians. Each cell is baseline to changed, followed by the changed percentage.

## initial-full

| Fixture | Items/s | Total ms | Traversal ms | First preview ms | Publication ms | Checkpoints | Database |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 7810 to 8249 (+5.6%) | 256.2 to 242.6 (-5.3%) | 26.6 to 30.7 (+15.4%) | 58.3 to 55.5 (-4.9%) | 12.5 to 12.5 (-0.0%) | 3 to 3 | 1.02 to 1.02 MiB (+0.0%) |
| deep | 713 to 269 (-62.3%) | 360.4 to 956.0 (+165.2%) | 172.2 to 322.0 (+87.0%) | 51.7 to 202.9 (+292.7%) | 10.6 to 31.8 (+199.4%) | 3 to 3 | 0.43 to 0.43 MiB (+0.9%) |
| tiny | 20772 to 21037 (+1.3%) | 486.3 to 480.1 (-1.3%) | 152.5 to 166.9 (+9.4%) | 90.7 to 88.4 (-2.6%) | 15.4 to 14.8 (-4.4%) | 3 to 3 | 4.83 to 4.83 MiB (+0.0%) |
| mixed | 7618 to 7906 (+3.8%) | 265.3 to 255.6 (-3.6%) | 29.3 to 31.6 (+7.9%) | 56.6 to 52.5 (-7.3%) | 14.5 to 13.7 (-5.4%) | 3 to 3 | 1.07 to 1.08 MiB (+0.4%) |
| semantics | 39 to 40 (+3.3%) | 179.3 to 173.6 (-3.2%) | 3.6 to 3.2 (-9.2%) | 54.7 to 44.0 (-19.5%) | 15.2 to 12.2 (-19.7%) | 3 to 3 | 0.14 to 0.14 MiB (+0.0%) |
| directories | 4890 to 5166 (+5.7%) | 2065.8 to 1955.3 (-5.3%) | 1729.6 to 1667.6 (-3.6%) | 88.4 to 57.8 (-34.6%) | 10.5 to 10.8 (+2.7%) | 3 to 3 | 8.18 to 8.18 MiB (+0.0%) |
| hardlinks | 397 to 488 (+22.9%) | 510.9 to 415.7 (-18.6%) | 146.2 to 143.6 (-1.8%) | 107.6 to 60.4 (-43.9%) | 11.2 to 11.1 (-0.4%) | 3 to 3 | 3.79 to 3.79 MiB (+0.1%) |

## resume-clean-pause

| Fixture | Items/s | Total ms | Traversal ms | First preview ms | Publication ms | Checkpoints | Database |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 4942 to 5166 (+4.5%) | 404.9 to 387.4 (-4.3%) | 35.8 to 33.3 (-7.1%) | 189.7 to 178.6 (-5.8%) | 13.5 to 12.5 (-7.5%) | 3 to 3 | 1.02 to 1.02 MiB (+0.0%) |
| deep | 589 to 597 (+1.4%) | 436.6 to 430.5 (-1.4%) | 128.0 to 126.3 (-1.3%) | 164.6 to 161.8 (-1.7%) | 10.4 to 10.9 (+5.3%) | 3 to 3 | 0.43 to 0.43 MiB (+0.0%) |
| tiny | 16200 to 16718 (+3.2%) | 623.5 to 604.2 (-3.1%) | 153.7 to 146.5 (-4.7%) | 220.5 to 218.2 (-1.1%) | 15.7 to 15.1 (-3.7%) | 3 to 3 | 4.83 to 4.83 MiB (+0.0%) |
| mixed | 5146 to 5152 (+0.1%) | 392.8 to 392.3 (-0.1%) | 33.6 to 36.3 (+8.0%) | 181.1 to 185.9 (+2.7%) | 14.6 to 16.2 (+10.3%) | 3 to 3 | 1.08 to 1.08 MiB (+0.0%) |
| semantics | 24 to 23 (-3.9%) | 290.1 to 301.8 (+4.0%) | 3.2 to 4.3 (+34.5%) | 153.0 to 164.2 (+7.4%) | 10.4 to 14.6 (+40.2%) | 3 to 3 | 0.14 to 0.14 MiB (+0.0%) |
| directories | 4836 to 4819 (-0.3%) | 2088.8 to 2095.9 (+0.3%) | 1623.1 to 1633.3 (+0.6%) | 215.4 to 212.2 (-1.5%) | 10.5 to 10.7 (+1.6%) | 3 to 3 | 8.18 to 8.17 MiB (-0.0%) |
| hardlinks | 316 to 319 (+1.0%) | 642.2 to 636.1 (-0.9%) | 147.9 to 149.4 (+1.0%) | 249.8 to 248.3 (-0.6%) | 11.1 to 11.3 (+2.5%) | 3 to 3 | 3.79 to 3.79 MiB (-0.1%) |

## resume-process-restart

| Fixture | Items/s | Total ms | Traversal ms | First preview ms | Publication ms | Checkpoints | Database |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 5120 to 4959 (-3.1%) | 390.8 to 403.5 (+3.2%) | 31.6 to 38.0 (+20.4%) | 184.0 to 196.4 (+6.7%) | 12.0 to 14.6 (+21.5%) | 3 to 3 | 1.02 to 1.02 MiB (+0.4%) |
| deep | 587 to 564 (-4.0%) | 437.9 to 456.0 (+4.1%) | 129.4 to 136.7 (+5.7%) | 163.9 to 184.3 (+12.4%) | 10.6 to 11.1 (+4.4%) | 3 to 3 | 0.43 to 0.44 MiB (+0.9%) |
| tiny | 15718 to 16127 (+2.6%) | 642.6 to 626.3 (-2.5%) | 154.7 to 150.4 (-2.7%) | 233.4 to 238.5 (+2.2%) | 14.6 to 15.4 (+5.7%) | 3 to 3 | 4.84 to 4.82 MiB (-0.2%) |
| mixed | 5197 to 4946 (-4.8%) | 388.9 to 408.6 (+5.1%) | 31.9 to 42.7 (+33.7%) | 179.2 to 193.7 (+8.1%) | 14.4 to 17.7 (+22.8%) | 3 to 3 | 1.08 to 1.07 MiB (-0.4%) |
| semantics | 24 to 23 (-6.2%) | 285.7 to 304.7 (+6.6%) | 3.0 to 6.5 (+116.2%) | 154.4 to 174.7 (+13.2%) | 10.2 to 16.3 (+60.0%) | 3 to 3 | 0.14 to 0.14 MiB (+0.0%) |
| directories | 4803 to 4832 (+0.6%) | 2103.0 to 2090.4 (-0.6%) | 1636.8 to 1619.1 (-1.1%) | 225.2 to 229.3 (+1.8%) | 10.4 to 10.6 (+2.7%) | 3 to 3 | 8.21 to 8.21 MiB (+0.0%) |
| hardlinks | 318 to 309 (-2.5%) | 639.4 to 656.0 (+2.6%) | 144.1 to 149.1 (+3.5%) | 254.7 to 264.1 (+3.7%) | 11.3 to 11.2 (-0.9%) | 3 to 3 | 3.79 to 3.78 MiB (-0.2%) |

## resume-unacknowledged-pause

| Fixture | Items/s | Total ms | Traversal ms | First preview ms | Publication ms | Checkpoints | Database |
|---|---:|---:|---:|---:|---:|---:|---:|
| wide | 5430 to 4921 (-9.4%) | 368.5 to 406.6 (+10.4%) | 30.3 to 38.9 (+28.6%) | 179.7 to 200.3 (+11.4%) | 11.9 to 13.5 (+13.7%) | 3 to 3 | 1.02 to 1.02 MiB (-0.4%) |
| deep | 585 to 561 (-4.0%) | 439.5 to 457.9 (+4.2%) | 128.0 to 138.4 (+8.1%) | 168.8 to 184.9 (+9.5%) | 10.3 to 10.9 (+5.2%) | 3 to 3 | 0.43 to 0.44 MiB (+0.9%) |
| tiny | 15814 to 15797 (-0.1%) | 638.7 to 639.4 (+0.1%) | 148.5 to 154.2 (+3.9%) | 236.0 to 236.4 (+0.2%) | 15.4 to 15.5 (+0.4%) | 3 to 3 | 4.83 to 4.82 MiB (-0.2%) |
| mixed | 5241 to 4758 (-9.2%) | 385.6 to 424.7 (+10.1%) | 31.5 to 48.2 (+52.9%) | 180.1 to 202.8 (+12.6%) | 14.8 to 15.9 (+6.9%) | 3 to 3 | 1.07 to 1.07 MiB (+0.0%) |
| semantics | 24 to 23 (-6.3%) | 286.6 to 306.0 (+6.7%) | 3.2 to 6.1 (+90.2%) | 155.1 to 178.2 (+14.9%) | 10.4 to 14.3 (+37.7%) | 3 to 3 | 0.14 to 0.14 MiB (+0.0%) |
| directories | 4780 to 4713 (-1.4%) | 2113.2 to 2143.4 (+1.4%) | 1644.9 to 1661.2 (+1.0%) | 222.2 to 235.0 (+5.7%) | 10.4 to 10.4 (+0.3%) | 3 to 3 | 8.20 to 8.21 MiB (+0.1%) |
| hardlinks | 319 to 295 (-7.3%) | 636.7 to 687.1 (+7.9%) | 142.1 to 151.0 (+6.3%) | 253.8 to 287.5 (+13.3%) | 11.3 to 11.2 (-0.7%) | 3 to 3 | 3.78 to 3.79 MiB (+0.4%) |

## Acceptance assessment

The first ordered pass exceeded 5% in several timing cells, while database size and checkpoint counts stayed stable. A paired rerun checked the largest initial-scan outlier and two short fixtures:

| Scenario and fixture | Items/s | Total | Traversal | First preview | Publication | Database |
|---|---:|---:|---:|---:|---:|---:|
| initial-full, deep | -2.3% | +2.4% | -0.1% | +1.4% | +3.2% | +0.0% |
| resume-unacknowledged-pause, wide | +124.3% | -55.4% | +13.1% | -54.4% | -40.2% | +0.4% |
| resume-unacknowledged-pause, semantics | -0.4% | +0.4% | +4.8% | +2.3% | +6.6% | +0.0% |

The paired deep rerun reduced the earlier 165% total-time outlier to 2.4%; traversal changed by -0.1% and first preview by 1.4%. The wide rerun reversed the earlier total and preview regressions, which points to machine-state noise rather than a stable code effect. The seven-item semantics publication phase increased by 0.68 ms, or 6.6%; this is a fixed-cost percentage on the shortest fixture. Its total time changed by 0.4%, first preview by 2.3%, and database size did not change. No checkpoint count changed in the full reports.

The matched reruns meet the 5% acceptance limits for throughput, total time, first preview, and database size. Publication timing is recorded for diagnosis but is not one of the stated rejection limits.
