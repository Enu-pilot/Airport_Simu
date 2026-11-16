# ゴールデン基準値の保存（フェーズ 1 の修正前）

- 採取日: 2026-11-16　対象コミット: 4af0fd2（製品コードは 3d8a706 と同一）
- 期待値: `tests/golden/`（このコミット時点のまま。b8104e2 以降未変更）
- 実測値: `actual/`（隔離した複製で `GOLDEN_UPDATE=1 npx vitest run tests/unit/golden` を 2 回実行し、2 回の出力が完全に一致することを確認。リポジトリの `tests/golden/` は変更していない）
- 不一致: 14 ファイル（テスト 13 件）。一致: geometry-all-headings / free-runways / routes / runway-table と fixtures。
- 原因の経緯は docs/39 §4.1 の G-1。

## 差分の概要

| ファイル | 異なる項目数 | 主な差（期待 → 実測） |
|---|---|---|
| bus-sim.golden.json | 219 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.sandbox.stateSha256` 2079628ff6ae468de17836656fa42186849793b54450eefd91ad1de6c... → 6f7957a9edbc4425baf48b080096cb86db1ae5555371ff56fecbbc3ba...; `runs.plain-seed.stateSha256` 8498d78c569cd0bf281770ef2d702b4cb4bb8d75d2f15982f31fe463a... → d0afb906aa5b3f614b59e0473133763a608ca723ad176673d110d5822...; `runs.plain-seed.kpis.arrivals` 79 → 78 |
| crossing-sim.golden.json | 189 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.free-crossing|free-a.stateSha256` d31a789650a077cbfd11ace183da63ebc8dd39e3afa5e2d61bfb9d01c... → 81d148bbd66dcfad30b3b0b62e9cc046813a9857cb362c7845ac33670...; `runs.free-crossing|free-b.stateSha256` 07614a12c9b0d355b2c953ba9b22ce25a3e9bf472cada1ca70461c6f4... → d6a7acc3ea5adc76c541566113f7431d4215878ceb9d5acafc2a904c8...; `runs.free-parallel|free-a.stateSha256` 9c7863aeafe0b1de85c0e2a5e91033a13808782b269bf81aa2184032a... → 7a61d0a2099e4b349e98c6ddb7d163c97738c6af152eacda30ce6e655... |
| game-models.golden.json | 55 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.day0-normal.cash` 1000976536 → 1000984136; `runs.day0-normal.rating` 59.7 → 60.5; `runs.day0-normal.kpi.otp` 0.9210526315789473 → 1 |
| game-weather.golden.json | 77 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.day0-normal.kpi.otp` 0.9210526315789473 → 1; `runs.day0-normal.kpi.rating` 58.6 → 59.6; `runs.day0-normal.stateSha256` 63a45257d30b869550f78ab7c030b33a2802e55694efc508f361bd95f... → 84912b42e3f5f4215bcfddffe56cb24da24e668b26bd97f4063ae3c82... |
| geometry-sample.golden.json | 44 | `footprints.fac_1[0].level` (なし) → 0; `footprints.fac_2[0].level` (なし) → 0; `footprints.fac_3[0].level` (なし) → 0; `footprints.fac_4[0].level` (なし) → 0 |
| geometry-starter.golden.json | 28 | `footprints.fac_1[0].level` (なし) → 0; `footprints.fac_2[0].level` (なし) → 0; `footprints.fac_3[0].level` (なし) → 0; `footprints.fac_4[0].level` (なし) → 0 |
| legacy-remote-sim.golden.json | 135 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.sandbox.stateSha256` 1e4d061774275f813daa8c333d4aa1c427a8b41471bdf88c90c05b1b0... → b4a55c2a8b1e21892b8ad2c6cd0b0d94ac9e7152d59beb4ef33856ee2...; `runs.plain-seed.stateSha256` 8b7dff955e3c0d989ca3a63c9b3758c47034e814a09bcc593a721406d... → 0df9aec2d1c690635f534843bddba8188e7045726ef4ad6541e5b0452...; `runs.sandbox.paxStats.boarded` 584 → 587 |
| normalized-hashes.golden.json | 1 | `project` f85663321db674077536c842cceaa638a9ce483fa798c66c627659f09... → 0cf73c9e1256470aafd3e3cb94f0bfc0a4fe6f5c064e562df42520300... |
| project-sim.golden.json | 4 | `sha256` bddfe2b5048add0943b9f8ce05d3eaa556ec9ac420df4aecf60a9ae7f... → 50677afda1afaaa2220ddc04404df7cf846c8203efc0f7234f287d133...; `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `normalizedSha256` 6b22e47c83bcd306439ccf2f1e953b4b274ca95bc577af9baec71cdd3... → 865c8012445f26317690b3dcaf432125ca699c8d151f4a4c2c5f47d94...; `length` 219654 → 220887 |
| project.golden.json | 1 | `sha256` cc93b2eda90981061919160c8c779eace94af54407aac495a21481085... → 2c175ab5d8b6ed20c19d32d167e9040ba259e5e89ea392984d961cc69... |
| sim-midrun.golden.json | 3 | `hashes.original` dd8aa5e45e6de454b3454eb8df3f386eb56347660ee983782cfd1aacc... → 3aae0aa02add47b539f96ec0e9a676f895fea38527401e7f348a93aac...; `hashes.restored` dd8aa5e45e6de454b3454eb8df3f386eb56347660ee983782cfd1aacc... → 3aae0aa02add47b539f96ec0e9a676f895fea38527401e7f348a93aac...; `projectLength` 421346 → 423637 |
| sim-versions.json | 9 | `sim.golden.json` skyport-sim-10.0 → skyport-sim-10.3; `bus-sim.golden.json` skyport-sim-10.0 → skyport-sim-10.3; `sim-midrun.golden.json` skyport-sim-10.0 → skyport-sim-10.3; `stress-sim.golden.json` skyport-sim-10.0 → skyport-sim-10.3 |
| sim.golden.json | 64 | `cash` 1000669991 → 1000683791; `stateSha256` e1807f8dfcafe44b8425db3761d195a5f652c659c901a2ef40ace5d23... → fe897baede036b9ea7f49694b74993763b075ce841dbbdb830a8cd252...; `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `kpis.avgTaxiInMin` 3.8 → 3.6 |
| stress-sim.golden.json | 117 | `simModelVersion` skyport-sim-10.0 → skyport-sim-10.3; `runs.stress-a.stateSha256` 0bbcea2a012ff597f4b7bb130020d2fb2f104c0f67cb23f4a8a2db485... → 019547009b5f7f0f68b611d27fa495f7093cd248a1ae4d57be9182fa9...; `runs.stress-b.stateSha256` ff7dd238478a617bd229658bbd8a4747be5b74562b2c8abc266417d30... → a195d1bc4b2ef87cfb6229a59b1bd33c940729f46f54866aa23e1b312...; `runs.stress-a.kpis.avgTaxiInMin` 5.3 → 5.1 |

## 項目別（各ファイル先頭 40 項目。全体は `actual/` と `tests/golden/` の比較で得られる）

### bus-sim.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.sandbox.stateSha256`: 2079628ff6ae468de17836656fa42186849793b54450eefd91ad1de6c... → 6f7957a9edbc4425baf48b080096cb86db1ae5555371ff56fecbbc3ba...
- `runs.plain-seed.stateSha256`: 8498d78c569cd0bf281770ef2d702b4cb4bb8d75d2f15982f31fe463a... → d0afb906aa5b3f614b59e0473133763a608ca723ad176673d110d5822...
- `runs.plain-seed.kpis.arrivals`: 79 → 78
- `runs.plain-seed.kpis.cancelled`: 23 → 25
- `runs.plain-seed.kpis.missedPax`: 113 → 41
- `runs.plain-seed.stats.arrivals`: 88 → 86
- `runs.plain-seed.stats.diverted`: 23 → 25
- `runs.sandbox.kpis.apronBus.pax`: 1265 → 1827
- `runs.sandbox.kpis.avgTaxiInMin`: 3.8 → 3.7
- `runs.sandbox.kpis.unitUtil.tug`: 0.07100694444444444 → 0.07241898148148149
- `runs.plain-seed.kpis.departures`: 79 → 78
- `runs.plain-seed.paxStats.exited`: 9885 → 9687
- `runs.plain-seed.paxStats.missed`: 113 → 41
- `runs.sandbox.kpis.avgTaxiOutMin`: 5.8 → 6.1
- `runs.sandbox.kpis.bagProcessMin`: 49.1 → 51.2
- `runs.sandbox.paxStats.waitTotal`: 1333043 → 1573053
- `runs.sandbox.paxStats.walkTotal`: 2949351 → 2537138
- `runs.plain-seed.paxStats.boarded`: 9466 → 9056
- `runs.plain-seed.paxStats.spawned`: 16402 → 16258
- `runs.plain-seed.stats.departures`: 79 → 78
- `runs.sandbox.kpis.apronBus.trips`: 26 → 38
- `runs.sandbox.kpis.avgGroundDistM`: 2531.1 → 2549.5
- `runs.sandbox.kpis.stands[0].util`: 0.41096064814814814 → 0.18059027777777778
- `runs.sandbox.kpis.stands[1].util`: 0.06019675925925926 → 0.17025462962962962
- `runs.sandbox.kpis.stands[2].util`: 0.17418981481481483 → 0.1280439814814815
- `runs.sandbox.kpis.stands[5].util`: 0.15975694444444444 → 0.19912037037037036
- `runs.sandbox.kpis.stands[6].util`: 0.10997685185185185 → 0.24078703703703705
- `runs.sandbox.kpis.unitUtil.staff`: 0.09943981481481481 → 0.09775231481481482
- `runs.plain-seed.kpis.apronBus.pax`: 10063 → 9873
- `runs.plain-seed.kpis.avgTaxiInMin`: 3.8 → 3.9
- `runs.plain-seed.kpis.unitUtil.tug`: 0.2979861111111111 → 0.30106481481481484
- `runs.plain-seed.paxStats.deplaned`: 10212 → 9997
- `runs.plain-seed.paxStats.finished`: 19351 → 18743
- `runs.sandbox.kpis.runways[0].util`: 0.027164351851851853 → 0.027453703703703702
- `runs.sandbox.kpis.stands[0].turns`: 7 → 3
- `runs.sandbox.kpis.stands[1].turns`: 1 → 3
- `runs.sandbox.kpis.stands[2].turns`: 4 → 3
- `runs.sandbox.kpis.stands[5].turns`: 3 → 4
- `runs.sandbox.kpis.stands[6].turns`: 2 → 4
- …ほか 179 項目

### crossing-sim.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.free-crossing|free-a.stateSha256`: d31a789650a077cbfd11ace183da63ebc8dd39e3afa5e2d61bfb9d01c... → 81d148bbd66dcfad30b3b0b62e9cc046813a9857cb362c7845ac33670...
- `runs.free-crossing|free-b.stateSha256`: 07614a12c9b0d355b2c953ba9b22ce25a3e9bf472cada1ca70461c6f4... → d6a7acc3ea5adc76c541566113f7431d4215878ceb9d5acafc2a904c8...
- `runs.free-parallel|free-a.stateSha256`: 9c7863aeafe0b1de85c0e2a5e91033a13808782b269bf81aa2184032a... → 7a61d0a2099e4b349e98c6ddb7d163c97738c6af152eacda30ce6e655...
- `runs.free-parallel|free-b.stateSha256`: aea1248840b3f2c313ad2ad296b817c8301ee8e4ea0a9e753e34614f9... → e28ad3b35ab96387d83422899c84e22bb5cf5f95829fe4611a4ac9702...
- `runs.free-crossing|free-b.kpis.arrivals`: 10 → 8
- `runs.free-parallel|free-a.kpis.arrivals`: 8 → 10
- `runs.free-crossing|free-b.kpis.cancelled`: 0 → 2
- `runs.free-crossing|free-b.stats.arrivals`: 14 → 12
- `runs.free-crossing|free-b.stats.diverted`: 0 → 2
- `runs.free-parallel|free-a.kpis.cancelled`: 2 → 0
- `runs.free-parallel|free-a.stats.arrivals`: 12 → 13
- `runs.free-parallel|free-a.stats.diverted`: 2 → 0
- `runs.free-parallel|free-b.stats.arrivals`: 14 → 13
- `runs.free-crossing|free-b.kpis.departures`: 10 → 8
- `runs.free-parallel|free-a.kpis.departures`: 8 → 10
- `runs.free-crossing|free-b.stats.departures`: 10 → 8
- `runs.free-parallel|free-a.stats.departures`: 8 → 10
- `runs.free-crossing|free-a.kpis.unitUtil.tug`: 0.26546296296296296 → 0.23333333333333334
- `runs.free-crossing|free-b.kpis.unitUtil.tug`: 0.3569907407407407 → 0.2536574074074074
- `runs.free-parallel|free-a.kpis.avgTaxiInMin`: 4.5 → 4.6
- `runs.free-parallel|free-a.kpis.unitUtil.tug`: 0.23717592592592593 → 0.2038888888888889
- `runs.free-parallel|free-b.kpis.unitUtil.tug`: 0.35324074074074074 → 0.20439814814814813
- `runs.free-crossing|free-a.kpis.avgTaxiOutMin`: 8.1 → 7.9
- `runs.free-crossing|free-b.kpis.avgTaxiOutMin`: 8.1 → 8.2
- `runs.free-parallel|free-a.kpis.avgTaxiOutMin`: 6.3 → 6.1
- `runs.free-parallel|free-b.kpis.avgTaxiOutMin`: 6 → 5.9
- `runs.free-crossing|free-a.kpis.avgGroundDistM`: 2984.1 → 2946.8
- `runs.free-crossing|free-a.kpis.stands[1].util`: 0.8386111111111111 → 0.8392592592592593
- `runs.free-crossing|free-a.kpis.stands[2].util`: 0.7703703703703704 → 0.768425925925926
- `runs.free-crossing|free-a.kpis.stands[3].util`: 0.7301851851851852 → 0.7288888888888889
- `runs.free-crossing|free-a.kpis.unitUtil.staff`: 0.2403888888888889 → 0.2869305555555556
- `runs.free-crossing|free-b.kpis.avgGroundDistM`: 2971.8 → 2909.4
- `runs.free-crossing|free-b.kpis.runways[0].ops`: 15 → 12
- `runs.free-crossing|free-b.kpis.runways[1].ops`: 5 → 4
- `runs.free-crossing|free-b.kpis.stands[0].util`: 0.8555555555555555 → 0.8567592592592592
- `runs.free-crossing|free-b.kpis.stands[1].util`: 0.807962962962963 → 0.8093518518518519
- `runs.free-crossing|free-b.kpis.stands[2].util`: 0.7570370370370371 → 0.7559259259259259
- `runs.free-crossing|free-b.kpis.stands[3].util`: 0.7487962962962963 → 0.7526851851851852
- `runs.free-crossing|free-b.kpis.unitUtil.staff`: 0.27470833333333333 → 0.27182407407407405
- …ほか 149 項目

### game-models.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.day0-normal.cash`: 1000976536 → 1000984136
- `runs.day0-normal.rating`: 59.7 → 60.5
- `runs.day0-normal.kpi.otp`: 0.9210526315789473 → 1
- `runs.bad-winter-hard.cash`: 1000983988 → 1000970237
- `runs.day0-normal.kpi.rating`: 59.7 → 60.5
- `runs.bad-winter-hard.kpi.otp`: 0.9473684210526315 → 0.9210526315789473
- `runs.day0-normal.kpi.gateUtil`: 0.16005658436213993 → 0.15979938271604938
- `runs.day0-normal.kpi.avgWaitMin`: 3.5 → 3.3
- `runs.day0-normal.kpi.avgWalkMin`: 9.8 → 9.9
- `runs.day0-normal.kpi.avgDelayMin`: 2.5 → 0.2
- `runs.day0-normal.kpi.modePax.car`: 1619 → 1626
- `runs.bad-winter-hard.kpi.gateUtil`: 0.1553360768175583 → 0.15058641975308643
- `runs.day0-normal.kpi.avgGroundMin`: 45.6 → 43.8
- `runs.day0-normal.kpi.facilityUtil`: 0.09821141975308642 → 0.09834413580246913
- `runs.day0-normal.kpi.modePax.walk`: 3 → 12
- `runs.bad-winter-hard.kpi.avgWalkMin`: 10 → 10.2
- `runs.bad-winter-hard.kpi.avgDelayMin`: 2.5 → 1.3
- `runs.bad-winter-hard.kpi.modePax.car`: 1663 → 1578
- `runs.day0-normal.kpi.modePax.dropoff`: 2578 → 2562
- `runs.day0-normal.kpi.paxSatisfaction`: 90.6 → 93.2
- `runs.bad-winter-hard.kpi.avgGroundMin`: 44.5 → 41.9
- `runs.bad-winter-hard.kpi.facilityUtil`: 0.09633487654320988 → 0.09612268518518519
- `runs.bad-winter-hard.kpi.modePax.walk`: 7 → 13
- `runs.day0-normal.goals.streaks.otp95x7`: 0 → 1
- `runs.day0-normal.kpi.actualAvgDelayMin`: (なし) → 2.4
- `runs.day0-normal.airlineEval.SK.ema.otp`: 68.4 → 72
- `runs.bad-winter-hard.kpi.modePax.dropoff`: 2471 → 2550
- `runs.bad-winter-hard.kpi.paxSatisfaction`: 90.3 → 91.4
- `runs.day0-normal.kpi.airlineSatisfaction`: 61.1 → 61.2
- `runs.bad-winter-hard.kpi.actualAvgDelayMin`: (なし) → 2.9
- `runs.day0-normal.airlineEval.SK.otpBadDays`: 1 → 0
- `runs.day0-normal.airlines.AQ`: 61.15 → 61.2
- `runs.day0-normal.airlines.HB`: 61.17 → 61.2
- `runs.day0-normal.airlines.ML`: (なし) → 60
- `runs.day0-normal.airlines.NP`: 61.14 → 61.16
- `runs.day0-normal.airlines.RJ`: 61.11 → 61.12
- `runs.day0-normal.airlines.SK`: 61.09 → 61.2
- `runs.day0-normal.airlineEval.AS`: (なし) → {"ema": {"fees": 72, "aircraft": 72}, "low": {"fees": 0, ...
- `runs.day0-normal.airlineEval.ML`: (なし) → {"ema": {"fees": 72, "aircraft": 72}, "low": {"fees": 0, ...
- …ほか 15 項目

### game-weather.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.day0-normal.kpi.otp`: 0.9210526315789473 → 1
- `runs.day0-normal.kpi.rating`: 58.6 → 59.6
- `runs.day0-normal.stateSha256`: 63a45257d30b869550f78ab7c030b33a2802e55694efc508f361bd95f... → 84912b42e3f5f4215bcfddffe56cb24da24e668b26bd97f4063ae3c82...
- `runs.bad-humid-expert.kpi.otp`: 0.8947368421052632 → 1
- `runs.day0-normal.kpi.gateUtil`: 0.1600531550068587 → 0.15979595336076818
- `runs.bad-winter-normal.kpi.otp`: 0.9210526315789473 → 0.868421052631579
- `runs.day0-normal.kpi.avgWaitMin`: 3.7 → 3.4
- `runs.day0-normal.kpi.avgWalkMin`: 9.8 → 9.9
- `runs.bad-humid-expert.kpi.rating`: 58.2 → 59.4
- `runs.day0-normal.kpi.avgDelayMin`: 2.5 → 0.2
- `runs.day0-normal.kpi.modePax.car`: 1618 → 1604
- `runs.bad-humid-expert.stateSha256`: 274c1b7e0540c0afd445457e9bebb17a271abdfb477c0d682d74405e0... → 14b196016862b0853d4d0cc5cb1e9dbd04c63245be7e186b99a5586d9...
- `runs.bad-winter-normal.kpi.rating`: 58.7 → 58.5
- `runs.day0-normal.kpi.avgGroundMin`: 43.6 → 44.6
- `runs.day0-normal.kpi.facilityUtil`: 0.09932253086419753 → 0.09934336419753087
- `runs.day0-normal.kpi.modePax.walk`: 9 → 13
- `runs.bad-humid-expert.kpi.gateUtil`: 0.15758573388203018 → 0.15528120713305898
- `runs.bad-winter-normal.kpi.flights`: 36 → 34
- `runs.bad-winter-normal.stateSha256`: d0b65cf2176c4115cb6d6e508d0026605170e3205949b9cc0142c3829... → 3dd5ce54db2ffce62865a732ba99404bf5b60c74b7a62ccd57e2771b6...
- `runs.bad-winter-normal.kpi.gateUtil`: 0.1495233196159122 → 0.14282750342935527
- `runs.bad-humid-expert.kpi.avgWaitMin`: 3.7 → 3.5
- `runs.bad-winter-normal.kpi.cancelled`: 1 → 2
- `runs.bad-winter-normal.kpi.movements`: 36 → 34
- `runs.day0-normal.kpi.modePax.dropoff`: 2573 → 2583
- `runs.day0-normal.kpi.paxSatisfaction`: 90.2 → 93
- `runs.bad-humid-expert.kpi.avgDelayMin`: 3.2 → 0.4
- `runs.bad-humid-expert.kpi.modePax.car`: 1706 → 1748
- `runs.bad-winter-normal.kpi.avgWaitMin`: 3.4 → 3.6
- `runs.bad-winter-normal.kpi.avgWalkMin`: 10.2 → 9.9
- `runs.bad-winter-normal.kpi.paxArrived`: 1879 → 1932
- `runs.bad-winter-normal.kpi.runwayUtil`: 0.06666666666666667 → 0.06296296296296296
- `runs.bad-winter-normal.stats.arrivals`: 18 → 17
- `runs.bad-winter-normal.weatherCancels`: 1 → 2
- `runs.day0-normal.stats.taxiInSecTotal`: 3350 → 3152
- `runs.bad-humid-expert.kpi.avgGroundMin`: 43.9 → 43
- `runs.bad-humid-expert.kpi.facilityUtil`: 0.10238194444444444 → 0.10223842592592593
- `runs.bad-humid-expert.kpi.modePax.walk`: 15 → 14
- `runs.bad-winter-normal.kpi.avgDelayMin`: 2.9 → 1.5
- `runs.bad-winter-normal.kpi.modePax.car`: 1543 → 1518
- …ほか 37 項目

### geometry-sample.golden.json

- `footprints.fac_1[0].level`: (なし) → 0
- `footprints.fac_2[0].level`: (なし) → 0
- `footprints.fac_3[0].level`: (なし) → 0
- `footprints.fac_4[0].level`: (なし) → 0
- `footprints.fac_5[0].level`: (なし) → 0
- `footprints.fac_6[0].level`: (なし) → 0
- `footprints.fac_7[0].level`: (なし) → 0
- `footprints.fac_8[0].level`: (なし) → 0
- `footprints.fac_9[0].level`: (なし) → 0
- `footprints.fac_10[0].level`: (なし) → 0
- `footprints.fac_11[0].level`: (なし) → 0
- `footprints.fac_12[0].level`: (なし) → 0
- `footprints.fac_13[0].level`: (なし) → 0
- `footprints.fac_14[0].level`: (なし) → 0
- `footprints.fac_15[0].level`: (なし) → 0
- `footprints.fac_16[0].level`: (なし) → 0
- `footprints.fac_17[0].level`: (なし) → 0
- `footprints.fac_18[0].level`: (なし) → 0
- `footprints.fac_19[0].level`: (なし) → 0
- `footprints.fac_20[0].level`: (なし) → 0
- `footprints.rd_1[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_2[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_3[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_4[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.fac_1[0].vertical`: (なし) → {"minM": 0, "maxM": 0.2}
- `footprints.fac_2[0].vertical`: (なし) → {"minM": 0, "maxM": 21.599999999999998}
- `footprints.fac_3[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_4[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_5[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_6[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_7[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_8[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_9[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_10[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_11[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_12[0].vertical`: (なし) → {"minM": 0, "maxM": 45}
- `footprints.fac_13[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_14[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_15[0].vertical`: (なし) → {"minM": 0, "maxM": 10}
- `footprints.fac_16[0].vertical`: (なし) → {"minM": 0, "maxM": 9}
- …ほか 4 項目

### geometry-starter.golden.json

- `footprints.fac_1[0].level`: (なし) → 0
- `footprints.fac_2[0].level`: (なし) → 0
- `footprints.fac_3[0].level`: (なし) → 0
- `footprints.fac_4[0].level`: (なし) → 0
- `footprints.fac_5[0].level`: (なし) → 0
- `footprints.fac_6[0].level`: (なし) → 0
- `footprints.fac_7[0].level`: (なし) → 0
- `footprints.fac_8[0].level`: (なし) → 0
- `footprints.fac_9[0].level`: (なし) → 0
- `footprints.fac_10[0].level`: (なし) → 0
- `footprints.fac_11[0].level`: (なし) → 0
- `footprints.fac_12[0].level`: (なし) → 0
- `footprints.rd_1[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_2[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_3[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.rd_4[0].vertical`: (なし) → {"minM": -0.2, "maxM": 0.2}
- `footprints.fac_1[0].vertical`: (なし) → {"minM": 0, "maxM": 0.2}
- `footprints.fac_2[0].vertical`: (なし) → {"minM": 0, "maxM": 21.599999999999998}
- `footprints.fac_3[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_4[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_5[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_6[0].vertical`: (なし) → {"minM": 0, "maxM": 45}
- `footprints.fac_7[0].vertical`: (なし) → {"minM": 0, "maxM": 9}
- `footprints.fac_8[0].vertical`: (なし) → {"minM": 0, "maxM": 14}
- `footprints.fac_9[0].vertical`: (なし) → {"minM": 0, "maxM": 10}
- `footprints.fac_10[0].vertical`: (なし) → {"minM": 0, "maxM": 6}
- `footprints.fac_11[0].vertical`: (なし) → {"minM": 0, "maxM": 10}
- `footprints.fac_12[0].vertical`: (なし) → {"minM": 0, "maxM": 3}

### legacy-remote-sim.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.sandbox.stateSha256`: 1e4d061774275f813daa8c333d4aa1c427a8b41471bdf88c90c05b1b0... → b4a55c2a8b1e21892b8ad2c6cd0b0d94ac9e7152d59beb4ef33856ee2...
- `runs.plain-seed.stateSha256`: 8b7dff955e3c0d989ca3a63c9b3758c47034e814a09bcc593a721406d... → 0df9aec2d1c690635f534843bddba8188e7045726ef4ad6541e5b0452...
- `runs.sandbox.paxStats.boarded`: 584 → 587
- `runs.plain-seed.kpis.missedPax`: 912 → 832
- `runs.sandbox.paxStats.finished`: 1190 → 1193
- `runs.plain-seed.paxStats.exited`: 3594 → 3604
- `runs.plain-seed.paxStats.missed`: 912 → 832
- `runs.sandbox.kpis.bagProcessMin`: 50.4 → 50.6
- `runs.sandbox.paxStats.waitTotal`: 219896 → 205438
- `runs.sandbox.paxStats.walkTotal`: 711154 → 715054
- `runs.plain-seed.paxStats.boarded`: 3010 → 2997
- `runs.plain-seed.paxStats.spawned`: 8316 → 8341
- `runs.sandbox.kpis.stands[0].util`: 0.4074074074074074 → 0.24078703703703705
- `runs.sandbox.kpis.stands[4].util`: 0.24078703703703705 → 0.4074074074074074
- `runs.sandbox.kpis.unitUtil.staff`: 0.10636111111111111 → 0.10572222222222222
- `runs.plain-seed.kpis.avgTaxiInMin`: 4.1 → 3.8
- `runs.plain-seed.kpis.unitUtil.tug`: 0.2994907407407407 → 0.23981481481481481
- `runs.plain-seed.paxStats.deplaned`: 5071 → 4945
- `runs.plain-seed.paxStats.finished`: 6604 → 6601
- `runs.sandbox.stats.taxiInSecTotal`: 1013 → 950
- `runs.plain-seed.kpis.avgTaxiOutMin`: 6.6 → 6.7
- `runs.plain-seed.kpis.bagProcessMin`: 75.2 → 75.9
- `runs.plain-seed.paxStats.waitTotal`: 7298152 → 7162928
- `runs.plain-seed.paxStats.walkTotal`: 3863302 → 3825138
- `runs.sandbox.kpis.facilities[1].id`: gate:fac_7 → gate:fac_3
- `runs.sandbox.kpis.facilities[2].id`: gate:fac_3 → gate:fac_7
- `runs.plain-seed.kpis.avgGroundDistM`: 2675.7 → 2634.8
- `runs.plain-seed.kpis.stands[0].util`: 0.9462962962962963 → 0.9473611111111111
- `runs.plain-seed.kpis.stands[1].util`: 0.8739351851851852 → 0.8752777777777778
- `runs.plain-seed.kpis.stands[2].util`: 0.87125 → 0.8729166666666667
- `runs.plain-seed.kpis.stands[3].util`: 0.8067129629629629 → 0.82125
- `runs.plain-seed.kpis.stands[4].util`: 0.8477777777777777 → 0.8457870370370371
- `runs.plain-seed.kpis.stands[5].util`: 0.822037037037037 → 0.8224074074074074
- `runs.plain-seed.kpis.stands[6].util`: 0.8218981481481481 → 0.8075462962962963
- `runs.plain-seed.kpis.stands[7].util`: 0.7843981481481481 → 0.7858796296296297
- `runs.plain-seed.kpis.stands[8].util`: 0.8237962962962962 → 0.8241203703703703
- `runs.plain-seed.kpis.unitUtil.staff`: 0.6421875 → 0.6281643518518518
- `runs.sandbox.kpis.unitUtil.engineer`: 0.11091049382716049 → 0.11186728395061728
- `runs.plain-seed.kpis.runways[0].util`: 0.21976851851851853 → 0.215
- …ほか 95 項目

### normalized-hashes.golden.json

- `project`: f85663321db674077536c842cceaa638a9ce483fa798c66c627659f09... → 0cf73c9e1256470aafd3e3cb94f0bfc0a4fe6f5c064e562df42520300...

### project-sim.golden.json

- `sha256`: bddfe2b5048add0943b9f8ce05d3eaa556ec9ac420df4aecf60a9ae7f... → 50677afda1afaaa2220ddc04404df7cf846c8203efc0f7234f287d133...
- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `normalizedSha256`: 6b22e47c83bcd306439ccf2f1e953b4b274ca95bc577af9baec71cdd3... → 865c8012445f26317690b3dcaf432125ca699c8d151f4a4c2c5f47d94...
- `length`: 219654 → 220887

### project.golden.json

- `sha256`: cc93b2eda90981061919160c8c779eace94af54407aac495a21481085... → 2c175ab5d8b6ed20c19d32d167e9040ba259e5e89ea392984d961cc69...

### sim-midrun.golden.json

- `hashes.original`: dd8aa5e45e6de454b3454eb8df3f386eb56347660ee983782cfd1aacc... → 3aae0aa02add47b539f96ec0e9a676f895fea38527401e7f348a93aac...
- `hashes.restored`: dd8aa5e45e6de454b3454eb8df3f386eb56347660ee983782cfd1aacc... → 3aae0aa02add47b539f96ec0e9a676f895fea38527401e7f348a93aac...
- `projectLength`: 421346 → 423637

### sim-versions.json

- `sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `bus-sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `sim-midrun.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `stress-sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `game-models.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `project-sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `crossing-sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `game-weather.golden.json`: skyport-sim-10.0 → skyport-sim-10.3
- `legacy-remote-sim.golden.json`: skyport-sim-10.0 → skyport-sim-10.3

### sim.golden.json

- `cash`: 1000669991 → 1000683791
- `stateSha256`: e1807f8dfcafe44b8425db3761d195a5f652c659c901a2ef40ace5d23... → fe897baede036b9ea7f49694b74993763b075ce841dbbdb830a8cd252...
- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `kpis.avgTaxiInMin`: 3.8 → 3.6
- `kpis.unitUtil.tug`: 0.07541666666666667 → 0.07632523148148149
- `kpis.avgTaxiOutMin`: 5.6 → 5.8
- `kpis.bagProcessMin`: 48.1 → 48.3
- `kpis.avgGroundDistM`: 2565.2 → 2565
- `kpis.stands[0].util`: 0.41096064814814814 → 0.18059027777777778
- `kpis.stands[1].util`: 0.21903935185185186 → 0.12387731481481482
- `kpis.stands[2].util`: 0.15975694444444444 → 0.19912037037037036
- `kpis.stands[3].util`: 0.06019675925925926 → 0.24078703703703705
- `kpis.stands[4].util`: 0.06019675925925926 → 0.16461805555555556
- `kpis.stands[8].util`: 0.17023148148148148 → 0.1696527777777778
- `kpis.unitUtil.staff`: 0.09781018518518518 → 0.09719386574074074
- `kpis.stands[0].turns`: 7 → 3
- `kpis.stands[1].turns`: 5 → 3
- `kpis.stands[2].turns`: 3 → 4
- `kpis.stands[3].turns`: 1 → 4
- `kpis.stands[4].turns`: 1 → 3
- `stats.taxiInSecTotal`: 3350 → 3152
- `kpis.hotspots[0].node`: tn_10 → tn_3
- `kpis.hotspots[1].node`: tn_3 → tn_15
- `kpis.hotspots[2].node`: tn_13 → tn_16
- `kpis.hotspots[3].node`: tn_6 → tn_13
- `kpis.hotspots[4].node`: tn_14 → tn_10
- `kpis.hotspots[5].node`: tn_15 → tn_14
- `kpis.hotspots[6].node`: tn_16 → tn_6
- `stats.taxiOutSecTotal`: 3841 → 4040
- `kpis.unitUtil.engineer`: 0.09491898148148148 → 0.08898919753086419
- `kpis.blockedMin.noStaff`: 13 → 10
- `kpis.unitUtil.fuelTruck`: 0.12266782407407407 → 0.12122685185185185
- `kpis.hotspots[0].waitMin`: 7.1 → 4.3
- `kpis.hotspots[1].waitMin`: 4.3 → 4.1
- `kpis.hotspots[2].waitMin`: 4.2 → 4.1
- `kpis.hotspots[3].waitMin`: 3.2 → 3.1
- `kpis.hotspots[4].waitMin`: 2.1 → 3.1
- `kpis.hotspots[5].waitMin`: 2.1 → 3.1
- `kpis.hotspots[6].waitMin`: 2.1 → 2.9
- `kpis.unitUtil.beltLoader`: 0.1152391975308642 → 0.11508101851851851
- …ほか 24 項目

### stress-sim.golden.json

- `simModelVersion`: skyport-sim-10.0 → skyport-sim-10.3
- `runs.stress-a.stateSha256`: 0bbcea2a012ff597f4b7bb130020d2fb2f104c0f67cb23f4a8a2db485... → 019547009b5f7f0f68b611d27fa495f7093cd248a1ae4d57be9182fa9...
- `runs.stress-b.stateSha256`: ff7dd238478a617bd229658bbd8a4747be5b74562b2c8abc266417d30... → a195d1bc4b2ef87cfb6229a59b1bd33c940729f46f54866aa23e1b312...
- `runs.stress-a.kpis.avgTaxiInMin`: 5.3 → 5.1
- `runs.stress-a.kpis.unitUtil.tug`: 0.2139814814814815 → 0.21513888888888888
- `runs.stress-b.kpis.unitUtil.tug`: 0.29583333333333334 → 0.2850925925925926
- `runs.stress-a.kpis.avgTaxiOutMin`: 5.5 → 6.2
- `runs.stress-a.kpis.bagProcessMin`: 52.7 → 54.6
- `runs.stress-b.kpis.avgTaxiOutMin`: 7.2 → 7
- `runs.stress-b.kpis.bagProcessMin`: 53.7 → 52.8
- `runs.stress-a.kpis.avgGroundDistM`: 3222 → 3308
- `runs.stress-a.kpis.stands[0].util`: 0.7963888888888889 → 0.6703703703703704
- `runs.stress-a.kpis.stands[1].util`: 0.7703703703703704 → 0.7981481481481482
- `runs.stress-a.kpis.stands[2].util`: 0.7703703703703704 → 0.6259259259259259
- `runs.stress-a.kpis.stands[3].util`: 0.6703703703703704 → 0.7703703703703704
- `runs.stress-a.kpis.stands[4].util`: 0.5092592592592593 → 0.4537962962962963
- `runs.stress-a.kpis.stands[5].util`: 0.4559259259259259 → 0.31657407407407406
- `runs.stress-a.kpis.stands[6].util`: 0.17212962962962963 → 0.11657407407407408
- `runs.stress-a.kpis.stands[7].util`: 0.11657407407407408 → 0.10546296296296297
- `runs.stress-a.kpis.stands[8].util`: 0.10546296296296297 → 0.055462962962962964
- `runs.stress-a.kpis.stands[9].util`: 0.03324074074074074 → 0.5041666666666667
- `runs.stress-a.kpis.unitUtil.staff`: 0.47786574074074073 → 0.4908101851851852
- `runs.stress-b.kpis.avgGroundDistM`: 3336.3 → 3223.4
- `runs.stress-b.kpis.stands[0].util`: 0.8903703703703704 → 0.8653703703703703
- `runs.stress-b.kpis.stands[4].util`: 0.6981481481481482 → 0.6592592592592592
- `runs.stress-b.kpis.stands[5].util`: 0.6592592592592592 → 0.6314814814814815
- `runs.stress-b.kpis.stands[6].util`: 0.6537037037037037 → 0.5259259259259259
- `runs.stress-b.kpis.stands[7].util`: 0.5712962962962963 → 0.5777777777777777
- `runs.stress-b.kpis.stands[8].util`: 0.4861111111111111 → 0.4751851851851852
- `runs.stress-b.kpis.stands[9].util`: 0.1999074074074074 → 0.24435185185185185
- `runs.stress-b.kpis.unitUtil.staff`: 0.5252314814814815 → 0.5186620370370371
- `runs.stress-a.kpis.runways[1].util`: 0.11638888888888889 → 0.11583333333333333
- `runs.stress-a.kpis.stands[5].turns`: 1 → 0
- `runs.stress-a.kpis.stands[9].turns`: 0 → 1
- `runs.stress-a.stats.taxiInSecTotal`: 3213 → 3172
- `runs.stress-b.kpis.runways[0].util`: 0.030740740740740742 → 0.028888888888888888
- `runs.stress-b.kpis.runways[1].util`: 0.14314814814814814 → 0.14944444444444444
- `runs.stress-b.kpis.stands[10].util`: 0.18324074074074073 → 0.1999074074074074
- `runs.stress-b.kpis.stands[11].util`: 0.038796296296296294 → 0.18324074074074073
- `runs.stress-b.stats.taxiInSecTotal`: 4248 → 3930
- …ほか 77 項目
