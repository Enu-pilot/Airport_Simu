# 実装計画: 就航都市の地域順表示（2026-REGION）

> 管理状態: active
> 作成日: 2026-11-22
> 更新日: 2026-11-22
> 根拠: docs/42 §3.11（2026-REGION）、PO 指示 2026-11-22「就航都市の表示順を、地方ごとに並び替えてほしい」
> 正本: 本書は実装計画。現行機能仕様は docs/43（データの足し方）を参照。

## 1. 現状と課題

- 現行の実装・テスト・仕様: 目的地は `src/core/data/destinations.ts` の登録順（legacy 21 件 → フェーズ 3 追加 → 国内網羅追加 → 海外編）で保持され、一覧表示もその順のまま。地理的なまとまりがなく、目的の都市を探しにくい。
- 既存の `regionId` は粗い区分（国内 north/east/central/west/south、海外 east-asia 等）で、PO 指定の地方区分（北海道・東北・関東・甲信越・北陸・東海・近畿・中国・四国・九州・沖縄）と一致しない。しかも検証・ゴールデン（catalogLegacy.test.ts のスナップショット）・路線適性テストに組み込まれているため、表示用途に流用・変更できない。
- 実装済み: 目的地データ 178 件（国内 83・海外 95）、表示箇所は下記のとおり洗い出し済み。
- 調査したコード・テスト: src/core/data/（destinations.ts / types.ts / countries.ts / index.ts）、src/core/economy/registry.ts、src/ui/CapacityPanel.tsx、src/ui/operate/cards/AirlineScoreTable.tsx、src/ui/ManagementPanels.tsx、tests/unit/catalogLegacy.test.ts・routeEligibility.test.ts。

### 表示箇所の洗い出し

| 箇所 | 内容 | 扱い |
|---|---|---|
| CapacityPanel の就航先セレクト | `destinationsFor` の全件列挙 | **対象** |
| AirlineScoreTable の就航範囲表示 | 会社の `networkDestinations` の都市名列挙 | **対象** |
| PlanPanel「路線の需要と供給（今日）」表 | 路線のある目的地を行として列挙（契約順） | **対象**（行の並びだけ地域順に変える） |
| ContractsPanel の契約・提案一覧 | 検索＋終了日順・機材順の切替ソートを持つ | 対象外（意味的なソートが意図されている） |
| PlanPanel の便表・FIDS・DayReview・HubPanel の乗継ペア | 時刻順・ペア単位の表示 | 対象外（時刻順が意味を持つ） |
| AnalyticsPanel | 目的地の切り口自体がない | 対象外 |

## 2. 目的・対象範囲

### 目的
- 就航都市の一覧表示を地方順に統一し、都市を探しやすくする。

### 対象
- 表示専用の地域区分と地域順の正本を 1 箇所に新設し、上記 3 箇所の並び替えに適用する。

### 非目標
- 既存 `regionId` の変更、目的地データ（値・登録順）の変更、保存データ・シミュレーション・提案生成の順序変更（`destinationsFor` 自体の順序は変えない。乱数消費に影響するため）。

## 3. 設計方針

- 新規 `src/core/data/destinationRegions.ts` に集約する:
  - `DESTINATION_DISPLAY_REGIONS`: 地域順の正本（国内 11 ＋ 海外 11）。
  - `DESTINATION_DISPLAY_REGION_BY_ID`: 目的地 ID → 地域の対応表（全 178 件）。
  - `compareDestinationIdsByDisplayRegion` / `sortDestinationsByDisplayRegion` / `sortDestinationIdsByDisplayRegion`: 比較・並べ替え（地域順 → 登録順 → ID 辞書順。元配列は変更しない）。
  - registry.ts から再輸出し、UI はそこから使う。
- 地域内の並びは `destinations.ts` の登録順を維持する（地域順だけを今回決め、地域内の既存の相対順序は壊さない）。
- 対応表の網羅（全目的地に地域がある・実在しない ID がない・国内/海外スコープが目的地の scope と一致）は新規テストで固定する。都市追加時は destinations.ts とセットでここにも登録する（docs/43 に注記）。
- 表示専用モジュールであり、core の計算・保存・検証からは参照しない。

### 地域順の全表

- 国内（PO 指定どおり）: 北海道 → 東北 → 関東 → 甲信越 → 北陸 → 東海 → 近畿 → 中国 → 四国 → 九州 → 沖縄
- 海外（PO 指定順に、指定にない地域を地理的位置へ挿入）: 東アジア → 東南アジア → **南アジア**（挿入: 東南アジアと中東の間） → **中央アジア**（挿入: 南アジアの北西、中東の手前） → 中東 → ヨーロッパ → **アフリカ**（挿入: ヨーロッパの南、地中海を挟む位置） → 北アメリカ → **中米・カリブ**（挿入: 南北アメリカの間） → 南アメリカ → オセアニア
- 南アメリカは現時点で該当都市なし（順序表にのみ存在する）。

### 個別の割当判断（境界ケース）

- 奄美群島（奄美・徳之島・沖永良部・与論・喜界）は沖縄に分類する。琉球弧の島嶼路線網として那覇側と一体で、ゲーム内データでも regionId `south`・季節プロファイル OKINAWA 等で沖縄側に寄せられているため。屋久島・種子島は鹿児島本土側として九州。
- 八丈島は東京都のため関東。
- イスタンブールは中東（国の地域区分 middle-east と一致）。
- ウラジオストクは東アジア（極東）。イルクーツクは中央アジア（シベリア中部で、既存区分の中で最も近い位置）。
- ホノルルは北アメリカ（米国）。グアム・サイパンはオセアニア（データの regionId `pacific` と一致）。
- メキシコシティは中米・カリブ（国連の地理区分で中央アメリカ）。
- 架空都市は座標で判定: 北港・雪原 = 北海道、東湾市 = 関東、星見 = 東北、霧ヶ丘 = 甲信越、西浜 = 近畿、青島 = 九州、南岬 = 沖縄、ノルデンブルク・ベルンハイム = ヨーロッパ、ルミナス = アフリカ（座標は東アフリカ沿岸）。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了 | 表示用地域モジュールの新設 | src/core/data/destinationRegions.ts、registry.ts | 新規テストの網羅・順序・スコープ一致が合格 |
| T2 | 完了 | 表示 3 箇所への適用 | CapacityPanel.tsx、AirlineScoreTable.tsx、ManagementPanels.tsx | 関連既存テスト合格、typecheck・lint・build 合格 |
| T3 | 完了 | 文書の同期 | docs/42 §3.11、docs/43、docs/implementation/README、HANDOFF | 記述と実装の一致を確認 |

## 5. 互換性・リスク

- 保存形式／スキーマ／移行: 影響なし（保存データに地域を持たせない）。
- シミュレーションモデル版・ゴールデン: 不変。目的地データと `destinationsFor` の順序に触れないため、提案生成の乱数列も変わらない。
- 既存データ・既存シードの結果: 不変。
- 性能・決定性・不変条件: 並べ替えは表示時のみ。比較関数は全順序（同点は ID で決着）で決定的。
- 失敗時の切り戻し・影響範囲: 新規モジュールと表示 3 箇所のみ。戻せば従来表示に戻る。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 正常系 | destinationRegionOrder.test.ts（地域順の正本・代表ペアの前後・並べ替え） | 全件合格 | 7/7 合格 |
| 境界値・異常系 | 同上（網羅・スコープ一致・元配列の不変・同点） | 全件合格 | 7/7 に含め合格 |
| 回帰・互換性 | catalogLegacy / catalogExtension / routeEligibility / airlineNetwork 系 / capacity 系＋ typecheck・lint・build | 既存の失敗と同一集合であること | 関連 9 ファイル 98/100（失敗 2 件は shellPhase7b のターミナル複合体表示で、変更なしコピーでも同一失敗＝既存）。ゴールデン 26/30（失敗 4 件は既存の幾何不一致、main と同一）。typecheck・build 合格、変更ファイルの lint 合格（全体 lint の 15 件は未変更ファイルの既存エラー） |
| E2E・性能（該当時） | 対象は既存画面の並び替えのみで新規フローなし | — | 未検証（Playwright ブラウザがこの VM に未導入） |

## 7. 更新対象の文書

- 現行仕様として更新する機能別 Docs: docs/43（都市追加時に表示用地域も登録する旨の注記）。
- docs/42 の要求・フェーズ状態: §3.11 に 2026-REGION を登録。
- docs/10 の未決事項・既知制限: なし。
- README・Docs 索引・HANDOFF: docs/implementation/README の個別計画表に行追加、HANDOFF_PROMPT.md の現在の作業を更新。

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-22 | T1〜T3 | 着手。表示箇所の洗い出しと地域割当（全 178 件）を確定 | 割当表の機械検証（網羅・スコープ）済み | 実装と検証 |
| 2026-11-22 | T1〜T3 | 実装完了。モジュール新設、表示 3 箇所へ適用、文書同期 | §6 のとおり | push・PR は PO 指示待ち |

## 9. 完了記録

- 完了日: 2026-11-22（実装・検証完了。push はしていない）
- 完了した受入条件: 地域順の正本と対応表（全 178 件）を 1 箇所に集約し、就航先セレクト・就航範囲表示・路線の需要と供給表の並びが地域順になった。網羅・スコープ一致・地域内の登録順維持を新規テストで固定。
- 計画からの差分と理由: なし（対象外とした箇所は §1 の表のとおり）。
- 変更ファイル: src/core/data/destinationRegions.ts（新規）、src/core/economy/registry.ts、src/ui/CapacityPanel.tsx、src/ui/operate/cards/AirlineScoreTable.tsx、src/ui/ManagementPanels.tsx、tests/unit/destinationRegionOrder.test.ts（新規）、docs/42、docs/43、docs/implementation/README.md、HANDOFF_PROMPT.md、本計画書。
- 品質ゲート（コマンド・結果）: `npx vitest run`（新規 7/7、関連 9 ファイル 98/100＝失敗 2 件は既存、ゴールデン 26/30＝失敗 4 件は既存の幾何不一致）、`npm run typecheck` 合格、`npm run build` 合格、変更ファイルの `eslint` 合格。
- 保存・旧版互換性・ゴールデンへの影響: なし（表示専用。目的地データ・regionId・destinationsFor の順序は無変更）。
- 未実行／失敗／未検証: 全テストスイート完走は未実行（VM 混雑のため対象を絞った。関連範囲は上記のとおり実行済み）。E2E はブラウザ未導入で未検証。shellPhase7b の既存失敗 2 件は本変更と無関係。
- 残件: push・PR 化は PO 指示待ち。
- 機能仕様書・docs/42・HANDOFF の更新: docs/42 §3.11 に 2026-REGION を登録、docs/43 §2 に地域登録の注記、docs/implementation/README に行追加、HANDOFF 更新済み。
