# 誘導路幅の F 区分（コード F の独立区分化）実装計画

> 管理状態: active（作業コピーで実装・検証中、PR 化は PO 指示待ち）
> 作成日: 2026-11-21
> 更新日: 2026-11-21
> 根拠: PO 指示（2026-11-21「論理ネットワークにおいて、新たにF対応の区分を作ってほしい。FキーでF級対応の誘導路などを配置・変更できるようにしたい」）、docs/42 §3.11 へ行 2026-CF を追加
> 正本: 本書は実装計画。現行機能仕様は docs/17（適合）・docs/06 §4.1.1（ショートカット）・docs/03（データモデル）を参照。

## 1. 現状と課題

- 現行の実装・テスト・仕様:
  - サイズ区分は `SizeClass = 'S' | 'M' | 'L'`（`src/core/model/types.ts`、`SIZE_ORDER` S=1/M=2/L=3）の3段階のみ。機体側は `sizeClassOf`（`src/core/aircraft/catalog.ts`）が ICAO コード文字（翼幅）から A/B=S、C=M、D/E/F=L とし、コード F（翼幅 65 m 以上 80 m 未満、および翼幅不明の安全側）は `size: 'L'` ＋ `codeF: true` フラグで表す。該当機種は A380-800（79.8 m）・B747-8（68.4 m）・B747-8F（68.4 m）の3機種。
  - 誘導路（`TaxiwayEdge`）は `widthClass: SizeClass` ＋ `codeF?: boolean`（L 級でのみ意味を持つ）で F 対応を表す。スポット（`Stand`）も `size: SizeClass` ＋ `codeF?: boolean` で同型。滑走路は舗装幅（m、30/45/60 の3段階）の実寸で、コード F は「幅 60 m 以上」で判定する（`compat.checkRunway` の `RUNWAY_CODE_F`）。
  - 論理ネットワーク（`src/core/airside/network.ts`）のエッジは `maxSize: SizeClass | null` と `codeF: boolean` を持ち、誘導路は `codeF = widthClass === 'L' && !!codeF`、滑走路は `maxSize === 'L' && surfaceWidthM >= 60`、スポット接続は `size === 'L' && !!codeF` で導出する。通行判定は `canAircraftUse(edge, size, { codeF })`。
  - 適合判定（`src/core/aircraft/compat.ts` の `checkTaxiway`）は区分不足を `TAXIWAY_CLASS`、コード F 指定なしを `TAXIWAY_CODE_F` と分けて理由を出す。
  - 描画幅は `TAXIWAY_DRAW_WIDTH_M = { S: 15, M: 23, L: 30, codeF: 38 }`（`src/core/model/catalog.ts`）で、codeF が区分より優先される（`src/core/layout/surfaces.ts`）。
  - エディタ: ツールボックスの誘導路幅セレクトとプロパティパネルは S/M/L の3択で、L 選択時のみ「コード F 対応」チェックボックスが出る。ショートカット（2026-KEY、PR #86）は段階位置の一般規則で、3段階の誘導路幅では F キー = L の別名（docs/06 §4.1.1）。
- 実装済み: コード F 機の運航可否の判定一式（フラグ方式）。F キーの段階割当ての一般規則（4段階リストでは S/M/L/F が 1 対 1 になる設計は既にある）。
- 部分実装・テスト不足: F が独立区分でないため、誘導路幅の選択肢として F を直接選べず、配置（F キー）も「L ＋ 後からチェック」の2操作になる。
- 不具合・未実装: 誘導路幅の F 区分そのものが無い（本計画の対象）。
- 調査したコード・テスト: `src/core/model/types.ts`、`src/core/model/catalog.ts`、`src/core/aircraft/catalog.ts`（`sizeClassOf` / `codeLetterOf`）、`src/core/aircraft/compat.ts`、`src/core/airside/network.ts`、`src/core/layout/operations.ts`（`addTaxiwayPath` / `updateEntity`）、`src/core/layout/surfaces.ts`、`src/core/io/migrate.ts`・`serialize.ts`・`project.ts`、`src/editor/shortcuts.ts`・`input.ts`・`store.ts`・`tools.ts`、`src/ui/Toolbox.tsx`・`PropertiesPanel.tsx`、`src/i18n/ja.ts`、ゴールデンフィクスチャ（`tests/golden/fixtures/*.layout.json` には誘導路 codeF の使用なし）。

## 2. 目的・対象範囲

### 目的
- 論理ネットワークの誘導路幅に **F を独立した第4の区分**として追加し、従来の「L ＋ コード F 対応フラグ」を「F 区分」へ一本化する。
- F キーで F 級の誘導路を直接配置・変更できるようにする（誘導路ツールでは F キー = F 区分そのもの）。

### 対象
- `TaxiwayEdge.widthClass` の値域拡張（新型 `TaxiwayWidthClass = 'S' | 'M' | 'L' | 'F'`）と、関連する導出・判定・描画・エディタ UI・ショートカット。
- 旧セーブの読み替え（移行）: 誘導路の `widthClass: 'L'` ＋ `codeF: true` → `widthClass: 'F'`（`codeF` は誘導路から除去）。
- 文書: docs/42 §3.11（2026-CF 行）、docs/06 §4.1.1、docs/17、docs/03、docs/21、本書、HANDOFF。

### 非目標
- **スポットサイズへの F 追加は行わない**（判断と理由は §3）。スポットの `size` ＋ `codeF` フラグは現行のまま維持する。
- **滑走路への F 区分追加は行わない**: 滑走路は舗装幅（m）の実寸管理で、コード F は既に「60 m 以上」で独立に判定できており、区分化する対象（段階リスト）が存在しない。F キーでも滑走路は従来どおり最大段階（60 m）を選ぶ。
- **機体側の区分変更は行わない**: `sizeClassOf` は現行どおり（D/E/F = L、コード F はフラグ）。機体の `size` を 'F' に変えると、滑走路の最大区分・スポット区分・経営側のサイズ別集計まで「F 未満は不可」に変わり、既存空港で A380 等が一切運航できなくなるなど運航結果が大きく変わる（ゴールデン再採取と PO 判断が必要な別件）。
- 経営側のサイズ別集計（`SizeClass3`、容量ダッシュボード等）は対象外。

## 3. 設計方針

- 変更するデータ・計算・状態遷移:
  - `src/core/model/types.ts`: `TaxiwayWidthClass` と `TAXIWAY_WIDTH_ORDER`（S=1/M=2/L=3/F=4）、`taxiwayWidthAtLeast(a, b)`、および機体が要求する誘導路幅区分を返す `requiredTaxiwayWidth(size, codeF)`（codeF なら 'F'、そうでなければ size）を追加。`TaxiwayEdge.widthClass` の型を `TaxiwayWidthClass` に変え、`TaxiwayEdge.codeF` は削除する（スポットの `codeF` は残す）。
  - 論理ネットワーク（`src/core/airside/network.ts`）: 誘導路エッジの導出を `maxSize = widthClass === 'F' ? 'L' : widthClass`、`codeF = widthClass === 'F'` に変更。**既存レイアウト（移行後の姿を含む）では導出結果が従来と完全一致する**（(L, codeF=true) → F → (L, true)、(L, false) → (L, false)、S/M は不変）。したがって sim の挙動は変わらない。
  - 適合判定（`compat.ts` の `checkTaxiway`）: 理由コードの出方は従来と完全一致させる。区分不足の判定は F を L に丸めた比較（`sizeAtLeast(cap(widthClass), type.size)`）、コード F 機で幅が 'F' でない場合は `TAXIWAY_CODE_F`。F 級機が M 幅に当たれば従来どおり両方の理由が付く。
  - 描画（`surfaces.ts` / `model/catalog.ts`）: `TAXIWAY_DRAW_WIDTH_M` を `{ S: 15, M: 23, L: 30, F: 38 }` とし、F の描画幅は従来の codeF 幅 38 m をそのまま引き継ぐ。
  - 編集操作（`operations.ts`）: `TaxiwayOptions.widthClass` と `updateEntity` の誘導路検証を `TaxiwayWidthClass` に拡張（S/M/L/F を受理）。誘導路の `codeF` パッチは廃止する（スポットは現行どおり受理）。
  - 移行（`io/migrate.ts`）: 版に依らない正規化段を追加し、読み込み時に誘導路の (L ＋ codeF) を 'F' へ読み替えて `codeF` を落とす。S/M に付いた stray な codeF は従来も運航判定では無意味だった（ネットワーク・適合とも L でのみ参照）ため、読み替えずに落とすだけにする（描画幅だけが 38 m → 区分幅に変わる。UI からは到達不能なデータ）。`project.ts` の移行呼び出しは版 1 のときだけだったため、`migrateLayout` を常に呼ぶ形に改める（構造移行は従来どおり版でゲートされ、正規化だけが全版に効く）。
  - エディタ: `ToolOptions.taxiWidth` の型を `TaxiwayWidthClass` に変更。ツールボックスの誘導路幅セレクトとプロパティパネルの誘導路幅セレクトに F を追加し、誘導路のコード F チェックボックスは廃止する（スポット側は維持）。ラベルは `TAXIWAY_WIDTH_LABEL`（`src/i18n/ja.ts`、F = 'F（コード F）'）を新設する。
  - ショートカット（`shortcuts.ts` / `input.ts`）: 誘導路ツールだけ段階リストを4段（S/M/L/F）にして `sizeStageIndex` の一般規則で S/M/L/F が 1 対 1 に対応するようにする。スポット・滑走路は3段階のまま（F = 最大の別名を維持）。docs/06 §4.1.1 の「F は最大段階の別名」の記述は誘導路について更新する。
- 依存関係・呼び出し元／呼び出し先: 判定の正本は従来どおり compat と airside/network（重複実装を増やさない）。sim 側（pathfinding 等）はネットワーク経由でのみ影響し、導出が不変なため無変更。
- 既存データ・既存挙動を守る方法: 移行は情報保存的（(L, codeF) ≡ F が全判定・描画で同値）。ゴールデンフィクスチャは誘導路 codeF を使っていないため、フィクスチャ由来の導出も不変。
- PO 判断・承認が必要な事項:
  - スポットへの F 区分の波及（今回は見送り。やる場合はスポット寸法・容量集計とセットの別計画）。
  - 並行作業「配置済み誘導路の経路一括幅変更」（別担当、main 未投入）が入る際は、その幅パラメータも `TaxiwayWidthClass` 化すると F が経路一括変更でも使える。本計画では main の現行コードに対してのみ実装し、競合箇所（`operations.ts`・`input.ts`・`PropertiesPanel.tsx`・docs/06）を明記する。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了 | 型と導出: `TaxiwayWidthClass` 追加、ネットワーク導出・適合判定・描画幅の追随 | model/types.ts、airside/network.ts、aircraft/compat.ts、layout/surfaces.ts、model/catalog.ts | 既存レイアウトで導出・判定が従来と一致（既存テスト全通過） |
| T2 | 完了 | 編集操作と移行: operations の検証拡張、migrate の正規化、project の移行呼び出し | layout/operations.ts、io/migrate.ts、io/project.ts | 旧セーブ（L＋codeF）の読み替え・往復の新規テスト |
| T3 | 完了 | エディタ UI とショートカット: セレクトへの F 追加、チェックボックス廃止、誘導路4段階キー | editor/store.ts・tools.ts・input.ts・shortcuts.ts、ui/Toolbox.tsx・PropertiesPanel.tsx、i18n/ja.ts | F キーで配置・変更できることの新規テスト |
| T4 | 完了 | テスト: 新規単体テスト＋表現変更に伴う既存テストの追随 | tests/unit/taxiwayWidthClassF.test.ts（新規）ほか | 新規テスト全通過、ゴールデン全件不変 |
| T5 | 完了 | 文書: 計画・仕様・台帳の更新 | docs/42・06・17・03・21・27、docs/implementation/README、本書 | 記述と実装の一致 |

## 5. 互換性・リスク

- 保存形式／スキーマ／移行: `widthClass` の値域に 'F' が増える。`SCHEMA_VERSION` は上げない（v2→v3 が任意項目追加のみで書き換えなかった前例、および施設種別追加等でも 3 のままだった運用に倣う。読み替えは migrate の正規化段で版に依らず行う）。旧版のゲームで 'F' を含むセーブを読むと誘導路の検証で弾かれる（前方互換は従来から保証していない）。
- シミュレーションモデル版・ゴールデン: 導出が既存レイアウトで完全一致するため `SIM_MODEL_VERSION` は据え置き（現行 10.12）、ゴールデンは再採取しない（全件不変をテストで確認する）。
- 既存データ・既存シードの結果: サンプル／スターター空港は S/M/L のみで不変。ユーザーのセーブは誘導路 codeF の有無によらず移行後のネットワークが同一になる。
- 性能・決定性・不変条件: 導出は決定的な純関数のまま。移行は読み込み時に1回だけ。
- 失敗時の切り戻し・影響範囲: 変更は誘導路幅まわりに閉じる。並行作業（経路一括幅変更・PBB 描画）との競合はファイル単位で §3 に明記。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 正常系 | 新規: F 区分の適合境界（F 機 × F/L/M 幅、L 機 × F 幅）、ネットワーク導出、F キーの配置・変更、addTaxiwayPath の F | 全件通過 | 通過（新規 15 件、tests/unit/taxiwayWidthClassF.test.ts） |
| 境界値・異常系 | 新規: 移行（L＋codeF → F、L のまま、スポット codeF は不変）、保存/読込往復、スポット size への 'F' 拒否 | 全件通過 | 通過（同上） |
| 回帰・互換性 | 既存単体テスト全件＋ゴールデン全件 | 従来と同一（ゴールデン再採取なし） | ゴールデン: 幾何 4 件（sample/starter/routes/free）を除き全通過（4 件は pristine な main でも不一致の既存分、本変更と無関係）。運航ゴールデン・保存ゴールデンは不変。全スイート（276 ファイル）は本 VM の制約で完走できず（約2時間で 275 ファイル報告・219 通過）、失敗 56 ファイルは分離再実行で全件切り分け済み: 本変更起因は 0 件（内訳は §9） |
| E2E・性能（該当時） | ビルド（tsc ＋ vite build） | 成功 | 成功（tsc exit 0、vite build 成功、変更ファイルの ESLint クリーン）。Playwright E2E は未実施（誘導路 codeF への参照なし。パネル/ツールボックスのセレクトは単体テストで担保） |

## 7. 更新対象の文書

- 現行仕様として更新する機能別 Docs: docs/17（誘導路の判定を F 区分で記述）、docs/06 §4.1.1（誘導路は4段階・F は F 区分そのもの）、docs/03（TaxiwayEdge の記述）、docs/21（読み替えの記録）。
- docs/42 の要求・フェーズ状態: §3.11 に 2026-CF 行を追加。
- docs/10 の未決事項・既知制限: スポット F 区分の見送りを残件として記録するかは §8 の判断に従う。
- README・Docs 索引・HANDOFF: docs/implementation/README の §3.11 表に行追加。HANDOFF_PROMPT.md に要約を追記。

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-21 | 調査 | 現行モデル（区分・フラグ・導出・判定・描画・UI・移行経路）と F 級該当3機種を確認。スポット・滑走路・機体区分への波及は見送る判断を §2 非目標に記録 | コード調査（最新 main `11b552c7`） | T1〜T5 |
| 2026-11-21 | T1〜T5 | §3 の設計どおり実装。追加判断: F 幅の建設費は区分ごとの +2,000 の等差を延長して 10,000 cr/タイル（`balance.ts`、PO 調整可）。移行は serialize（importLayout）と project（deserializeProject）の両経路で効くよう project 側の移行呼び出しを常時化 | §6 のとおり。新規 15 件・監査 a_network 18 件・関連既存テスト全通過、tsc・ビルド・lint 通過 | PR 化（PO 指示待ち）。並行作業「経路一括幅変更」が main に入る際は幅型の TaxiwayWidthClass 化が統合点 |

## 9. 完了記録

- 実装完了（2026-11-21、作業コピー `~/workspace/airport_simu_work/fclass-work`、土台は main `11b552c7`）。push はしていない（PO 指示待ち）。
- 全スイート失敗 56 ファイルの切り分け（分離再実行 26 ファイルで確認）: (1) 本 VM（共有 1.5 CPU）での 5 秒デフォルトタイムアウト多数（taxiBlocks.run の分離実行でも 14 件すべてタイムアウトで assertion 失敗は 0）。(2) 環境依存の ENOENT（実セーブファイル・出力先ディレクトリ不在: thinSave、gaps510、tiersReachability520）。(3) main 既存のコード/テスト不整合（需要校正 docs/46 の K 値、MapRenderer の frames lint、施設の階検証 u_labels/u_pick/u_levelRules、goals.tier=7 の受理、shellPhase7b の目的地数・複合体表示、fullflow の 777-300ER/SK 前提、legacyFingerprint の sample 基準値＝SIM 10.11/10.12 反映前の採取値）。(4) 幾何ゴールデン 4 件（pristine でも不一致を確認済みの既存分）。本変更に起因する失敗は 0 件。
- 統合時の注意: 作業開始後に main へ PR #88・#89・#90 がマージされている（2026-11-21 時点）。PR 化前に最新 main との突合せが必要。特に #90 が経路一括幅変更を含む場合、その幅パラメータの `TaxiwayWidthClass` 化が統合点になる。
