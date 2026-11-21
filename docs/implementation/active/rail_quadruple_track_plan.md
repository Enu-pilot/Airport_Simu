# 鉄道の複々線 実装計画（2026-QT）

> 管理状態: active
> 作成日: 2026-11-21
> 更新日: 2026-11-21
> 根拠: docs/42 §3.11（2026-QT として行を追加）、PO 指示 2026-11-21「鉄道の複々線を実装してほしい」
> 正本: 本書は実装計画。現行機能仕様は docs/44 §5（道路・線路の区間能力）を参照。

## 1. 現状と課題

- 現行の実装・テスト・仕様:
  - 線路は道路と同じ辺（`layout.roads`、roadClass `'rail'`）で表現され、辺は `tracks?: 1 | 2`（`src/core/model/types.ts`）を持つ。1 = 単線、2 = 複線のみ。
  - 区間モデル（`accessCapacityModel: 'segment'`）でのみ線路辺がボトルネックになる。既定能力は `src/core/access/segments.ts` の `railEdgeCapacity`: 明示 `capacityPerHour` が優先、未設定なら単線 4・複線 12 本/時。
  - 実効本数 = min(駅の宣言本数の合計, 出入口ごとのボトルネック合計（maximin 経路）, ホーム能力合計 = Σ 駅 platforms×6 本/時)（`analyzeSegments`）。
  - 既定の集約モデル（`analyzeAccess`）には線路容量の概念がなく、駅の `trainsPerHour` 合算のみ。`tracks` は使われない。
  - `tracks` の設定経路は PropertiesPanel の select（単線／複線）のみ。作成時（`addRoadPath`）には車線数・線路数とも指定せず、配置後に `updateEntity` で変更する（検証: `operations.ts` の `tracks: (v) => v === 1 || v === 2`）。
  - 建設費は線路長 × `railPerTile` で、`tracks`（および道路の `lanes`）には連動しない。描画幅も roadClass ごとの固定値で `tracks` に連動しない（単線／複線も見た目は同じ）。
  - 駅の `trainsPerHour` はスキーマ上限 20 本/時、`platforms` は上限 12（= 72 本/時）。
- 実装済み: 単線・複線と区間モデルのボトルネック計算、ホーム能力、明示能力の上書き。
- 未実装: 複々線（tracks = 4）。複線 12 本/時が線路側の上限で、宣言本数を増やしても頭打ちになる。
- 調査したコード・テスト: `src/core/access/segments.ts`・`model.ts`、`src/core/model/types.ts`・`catalog.ts`、`src/core/layout/operations.ts`（updateEntity / addRoadPath）、`src/core/economy/construction.ts`、`src/core/layout/surfaces.ts`・`src/render/MapRenderer.ts`、`src/core/io/project.ts`（形式 6 判定）・`serialize.ts`（tracks の検証なし）、`src/ui/PropertiesPanel.tsx`、`tests/unit/accessSegments.test.ts`。

## 2. 目的・対象範囲

### 目的
- 区間モデルで鉄道の頭打ち（複線 12 本/時）を緩和できるよう、線路辺に複々線（tracks = 4）を追加する。ユーザーの文脈は「道路は区間モデル＋車線増で改善しうるが、鉄道側の頭打ちへの備えがほしい」。

### 対象
- `RoadEdge.tracks` の許容値に 4 を追加（型・`updateEntity` 検証・PropertiesPanel の選択肢）。
- `railEdgeCapacity` の既定能力に複々線 24 本/時を追加。
- 機能仕様（docs/44 §5）、docs/42 §3.11、計画索引（docs/implementation/README）、HANDOFF の更新。
- 新規テスト（能力値・区間ボトルネック・ホーム頭打ち境界・集約モデル不変・保存/読込往復）。

### 非目標
- 集約モデルへの線路容量の導入（従来どおり駅の宣言合算のみ）。
- 建設費・維持費への連動（道路の `lanes` も建設費に連動しておらず、前例に合わせて連動させない）。
- 描画の変更（描画幅・枕木表現は現行でも単線／複線を区別しておらず、前例に合わせて変更しない。複々線の見た目の区別は将来課題）。
- 駅スキーマ（`trainsPerHour` 上限 20・`platforms` 上限 12）の変更。
- 3 線・5 線等の任意線路数（実在の主要形態である 1／2／4 の離散選択に限る）。

## 3. 設計方針

- 変更するデータ・計算:
  - `tracks?: 1 | 2 | 4`（既存キーの値域拡張のみ。新キーは追加しない）。
  - `railEdgeCapacity`: `capacityPerHour` 明示が最優先（従来どおり）。未設定時の既定は tracks 1 → 4、2 → 12、4 → 24 本/時。
  - **24 本/時の根拠**: 複線 12 の単純 2 倍。実物の複々線は方向別分離＋優等／緩行分離で 2 倍超の効率もありうるが、本作の他の能力は線形比例（道路 = 車線数 × 900 台/時）が原則であり、線形の 24 を採る。分離ボーナス（例: 30〜36）を採る場合はバランス再検討が要るため、今回は採らない（PO 判断事項として記録）。
  - `analyzeSegments` の計算式・maximin・ホーム能力は不変。複々線辺はボトルネック候補として 24 で効く。
- 依存関係: `railEdgeCapacity` の利用者は `analyzeSegments` と区間ヒートマップ（`access/heatmap.ts`、segments 経由）。集約モデル・運航（runtime）は不経由。
- 既存データ・既存挙動を守る方法:
  - tracks が 1／2／未設定の辺は従来と同一の能力値になるため、既存レイアウトの解析結果・ゴールデンは不変。
  - 保存形式: `tracks` は既存キー（保存形式 6 の判定対象）で、値 4 の追加は形式版を変えない。旧版コードが tracks = 4 を読んでも `>= 2` 判定で複線扱いになるだけで壊れない（serialize に tracks の値域検証はない）。
  - `SIM_MODEL_VERSION`: 据え置き。結果が変わるのは tracks = 4 を新規に設定したレイアウトだけで、既存レイアウト・既存セーブの結果は変わらない（opt-in の値域拡張。AGT 等の前例と同じ判断）。
- PO 判断・承認が必要な事項:
  - 複々線の能力を 24（線形）とするか、分離ボーナス込みの値にするか。本計画は PO 指示の基本案どおり 24 で実装し、判断材料は本書に残す。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了 | tracks = 4 の型・検証・UI 選択肢 | types.ts / operations.ts / PropertiesPanel.tsx | updateEntity で 4 を受理・3 を拒否するテスト（accessSegments 13 件に含み合格） |
| T2 | 完了 | railEdgeCapacity に複々線 24 を追加 | segments.ts | 能力値の単体テスト（未設定 4・1→4・2→12・4→24・明示優先）合格 |
| T3 | 完了 | 区間モデルの統合テスト | tests/unit/accessSegments.test.ts | 複々線入口で実効 24、ホーム能力が細いと駅側が頭打ち、集約モデルは不変（いずれも合格） |
| T4 | 完了 | 保存/読込の往復 | tests/unit/accessSegments.test.ts（exportLayout / importLayout） | tracks = 4 のレイアウトが往復で保持される（合格） |
| T5 | 完了 | Docs・索引・HANDOFF 更新 | docs/44 §5、docs/42 §3.11、implementation/README、HANDOFF_PROMPT.md | 記述と実装の一致 |

## 5. 互換性・リスク

- 保存形式／スキーマ／移行: 変更なし（既存キーの値域拡張）。移行処理は不要。
- シミュレーションモデル版・ゴールデン: SIM_MODEL_VERSION 据え置き。ゴールデンは区間モデルを使うフィクスチャがなく、既存値（tracks 1／2）では結果不変のため再採取しない。
- 既存データ・既存シードの結果: 不変。
- 性能・決定性・不変条件: 計算式は不変で定数の分岐追加のみ。決定性への影響なし。
- 失敗時の切り戻し・影響範囲: 変更は辺の能力定数と値域に閉じる。切り戻しは該当コミットの revert で足りる。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 正常系 | railEdgeCapacity の値、区間モデルで複々線入口の実効本数 | 24 本/時が実効になる | 合格（accessSegments 13/13、新規 6 件を含む） |
| 境界値・異常系 | tracks = 3 の拒否、ホーム能力が細い場合の頭打ち、駅宣言の上限 | 拒否される／駅側が上限になる | 合格（同上） |
| 回帰・互換性 | 既存 access/segments 系テスト、ゴールデン、保存/読込往復、集約モデル不変 | 全件従来どおり | 合格: 関連 4 ファイル 30/30、ゴールデン 21/25（失敗 4 件は main 既存の幾何ゴールデン陳腐化で本変更と無関係。§9 参照）、往復・集約不変は新規テストで合格 |
| E2E・性能（該当時） | UI 変更は select の選択肢追加のみ。Playwright はブラウザ環境があれば関連ケースを確認 | 未検証の場合は明記 | 未検証（この環境に Playwright ブラウザが無く、従来タスクでも未実施。変更は選択肢 1 件の追加のみ） |

## 7. 更新対象の文書

- 現行仕様として更新する機能別 Docs: docs/44 §5（単線 4・複線 12・複々線 24）。
- docs/42 の要求・フェーズ状態: §3.11 に 2026-QT 行を追加。
- docs/10 の未決事項・既知制限: 該当なし（集約モデルで効かない点は docs/44 §5 の既存記述＝区間モデル opt-in の範囲）。
- README・Docs 索引・HANDOFF: docs/implementation/README に行追加、HANDOFF_PROMPT.md に作業記録。

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-21 | 調査・計画 | tracks の現行扱い（型・検証・UI・費用・描画・保存）を調査し本書を作成。能力 24 の根拠・非目標（費用／描画の非連動は lanes 前例に整合）を記録 | コード調査のみ | T1〜T5 |
| 2026-11-21 | T1〜T4 | 土台は最新 main（24c681ab、PR #85 まで）を新規取得した quad-work。型・検証・UI・能力を実装し、accessSegments.test.ts に新規 6 件を追加 | 対象テスト 13/13、関連 4 ファイル 30/30 合格 | T5・全体ゲート（typecheck / lint / build / 全テスト / ゴールデン） |

## 9. 完了記録

- 完了日: 2026-11-21（作業コピーまで。push・PR は PO 指示待ち）
- 完了した受入条件: T1〜T5 すべて完了。tracks = 4 の型・検証・UI・能力（24 本/時）、区間モデルでの実効化、ホーム頭打ち境界、集約モデル不変、保存/読込往復を新規テスト 6 件で固定。
- 計画からの差分と理由: なし（能力 24 は基本案どおり。費用・描画の非連動は計画どおり lanes 前例に整合）。
- 変更ファイル:
  - コード: `src/core/model/types.ts`（tracks 型 1 | 2 | 4）、`src/core/access/segments.ts`（railEdgeCapacity に複々線 24）、`src/core/layout/operations.ts`（updateEntity の tracks 検証）、`src/ui/PropertiesPanel.tsx`（選択肢「複々線（24 本/時）」）
  - テスト: `tests/unit/accessSegments.test.ts`（新規 describe「鉄道の複々線（2026-QT）」6 件）
  - Docs: 本書、`docs/44` §5、`docs/42` §3.11（2026-QT 行）、`docs/implementation/README.md`、`HANDOFF_PROMPT.md`
- 品質ゲート（コマンド・結果）:
  - `npx vitest run tests/unit/accessSegments.test.ts`: 13/13 合格
  - 関連テスト（accessHeatmap / cargoSegmentsF6 / projectFormat6 / operations）: 30/30 合格
  - ゴールデン 9 ファイル: 21/25 合格。失敗 4 件（geometry-sample / geometry-starter / routes / free-runways）は main 既存の幾何ゴールデン陳腐化で、無変更の main でも同一に失敗することが他タスクの pristine 比較で確認済み。本変更による新規不一致はゼロ
  - `npm run typecheck`: 合格。変更ファイルの eslint: 合格（警告なし）。`npm run build`: 成功
  - 全テスト（`npm test`）: 共有 VM の混雑で実行が途中で環境終了（ログは quad-fulltest.log）。到達範囲で失敗した 9 ファイルは個別に再実行し、さらに本変更を一時的に戻した同一土台でも同条件で実行して失敗集合が一致することを確認した（access / aircraft / cargoAirlines / economy / geometry-curve / shellPhase7b / backendFollowup134 / sim-crossing / integration-fullflow。いずれも本変更と無関係な main 既存失敗または 5 秒テストタイムアウト等の環境要因）
  - 監査テスト（vitest.audit.config.ts）: 完走（約 74 分）。313/334 合格、21 件失敗はいずれも本変更の対象外（a_flightgen の ID07 planDay 12 件、e_airside の滑走路容量 1 件等の main 側既存失敗。アクセス関係の e_access 2 件は 120 秒／300 秒のテストタイムアウトで、アサーション不一致ではない）
- 保存・旧版互換性・ゴールデンへの影響: 保存形式の変更なし（既存キー tracks の値域拡張のみ、形式 6 判定は不変）。SCHEMA_VERSION・SIM_MODEL_VERSION とも据え置き。旧版が tracks = 4 を読んでも複線扱いで壊れない。
- 未実行／失敗／未検証: 全テスト完走は未完了（環境要因。上記の切り分けで代替）。Playwright E2E はブラウザ未導入のため未検証。
- 残件: push・PR 化（PO 指示待ち）。複々線の見た目の区別（描画）は将来課題として非目標に記録済み。
- 機能仕様書・docs/42・HANDOFF の更新: 実施済み（docs/44 §5、docs/42 §3.11、implementation/README、HANDOFF）。計画書は push・PR の段階で completed へ移す。
