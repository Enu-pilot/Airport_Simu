# 07. アーキテクチャ設計書

## 1. 技術構成（提案・承認待ち）

既存コードがないため新規に選定する（[00_survey.md](00_survey.md)）。

| 領域 | 採用案 | 理由 | 代替案 |
|------|--------|------|--------|
| 言語 | TypeScript（strict） | データモデルの型安全、リファクタ耐性 | — |
| ビルド | Vite | 高速な開発サーバー、静的出力、Web Worker 対応 | webpack |
| マップ描画 | PixiJS v8（WebGL/WebGPU） | 数千スプライトの2D描画に強い、カメラ操作が容易 | Canvas2D 自作（依存ゼロだが性能上限が低い）、Phaser（ゲームエンジン機能が過剰で、独自シム構造と衝突しやすい） |
| UI | React 18 | パネル・表・フォームの実装効率 | Svelte / Preact |
| UI状態 | Zustand（表示モデルのストア） | 軽量、React外からも購読可能 | Redux Toolkit |
| グラフ描画 | 軽量チャート（uPlot など） | KPI折れ線・棒グラフ | Recharts |
| 単体・統合テスト | Vitest | Vite と設定共有、Node でコアを実行 | Jest |
| プロパティテスト | fast-check | 不変条件のランダム検証 | — |
| E2E | Playwright | 環境にプリインストール済み | Cypress |
| Lint / 整形 | ESLint（+ import 境界ルール）/ Prettier | モジュール境界の強制 | Biome |
| パッケージ管理 | npm | 追加導入不要 | pnpm |
| ホスティング | 静的ホスティング（GitHub Pages 等） | サーバー不要 | — |

## 2. レイヤー構成

```
┌───────────────────────────────────────────────────────────────┐
│ app/        起動・画面遷移・ゲームループ（requestAnimationFrame）│
├───────────────┬───────────────────────────┬───────────────────┤
│ ui/ (React)   │ render/ (PixiJS)          │ platform/          │
│ HUD・パネル    │ マップ・航空機・旅客描画   │ セーブ(IndexedDB)  │
│ 入力→Command  │ 補間・カメラ・オーバーレイ │ ファイル入出力      │
├───────────────┴───────────────────────────┴───────────────────┤
│ view/  表示モデル（セレクタ）: GameState → UI/描画用の読み取り専用データ │
├───────────────────────────────────────────────────────────────┤
│ core/  シミュレーションコア（純TypeScript、DOM・描画・実時間に非依存） │
│   model/      型定義・ID・初期状態                                   │
│   commands/   コマンド検証・適用                                     │
│   sim/        ティック処理・システム実行順                           │
│   map/        地形・建設レイヤー・占有・配置検証                      │
│   airside/    エアサイドグラフ生成・経路探索・区間予約・デッドロック    │
│   ops/        便・航空機状態機械・滑走路コントローラ・スポット割当・    │
│               ターンアラウンド                                       │
│   pax/        ランドサイドネットワーク・旅客グループ・施設待ち行列      │
│   baggage/    手荷物フロー                                           │
│   economy/    料金・ledger・需要・契約・評価・日次締め                │
│   rng/        シード付き乱数（ストリーム別）                          │
│   invariants/ 不変条件チェック                                       │
│   save/       シリアライズ・スキーマ移行                              │
├───────────────────────────────────────────────────────────────┤
│ data/  静的データ（機種・施設定義・バランス値・航空会社テンプレート）JSON │
└───────────────────────────────────────────────────────────────┘
```

**依存方向**: `app → ui/render/platform → view → core → data`。逆方向・横方向（`ui ↔ render`、`core → ui` など）の import は ESLint ルール（`no-restricted-imports` または `eslint-plugin-boundaries`）で禁止する。

`core/` 内でも、`ops` が `airside` を使う等の依存は許すが、循環は禁止（`madge --circular` を CI で実行）。

## 3. ディレクトリ構成（Phase 1 で作成）

> Phase 1 の実装では、上図の `view/` に相当する層を `src/editor/`（エディタ状態・ツールのプレビュー・入力の解釈）として作成し、
> 表示文言を `src/i18n/` に分けた。`platform/`（IndexedDB 保存）は未作成で、保存は `editor/store.ts` の localStorage 自動保存と JSON 入出力のみ。
> 依存方向 `ui / render → editor → core` は ESLint（`eslint.config.js`）で強制している。

```
/
├─ docs/                 設計文書
├─ data/                 静的データ JSON（balance.json, aircraftTypes.json, structures.json, airlines.json）
├─ src/
│  ├─ core/ ...          （上記）
│  ├─ view/
│  ├─ render/
│  ├─ ui/
│  ├─ platform/
│  └─ app/
├─ tests/
│  ├─ unit/              core の単体テスト（src と同構造）
│  ├─ integration/       シナリオテスト（core のみ、Node 実行）
│  ├─ regression/        ゴールデン（シード + コマンドログ → 状態ハッシュ）
│  ├─ fixtures/          テスト用マップ・セーブデータ
│  └─ e2e/               Playwright
├─ tools/                ヘッドレス実行CLI（シナリオを N 日回して KPI を出力）
├─ index.html
├─ package.json / tsconfig.json / vite.config.ts / eslint.config.js
└─ README.md
```

### 3.1 実装後の構成（Phase 12 時点）

上の図は Phase 0 の計画で、実在しないディレクトリ（`view/`・`platform/`・`data/`・`tests/regression/`・`tests/fixtures/`・`tools/`）を含む。実際の構成は次のとおり。

```
src/
├─ app/ editor/ i18n/ render/ ui/        （editor = 表示モデル・ツール・入力（自由形の吸着・ハンドル）。滑走路の編集 UI は ui/RunwayPanels.tsx。render/ui → editor → core の向きを ESLint で強制）
└─ core/
   ├─ geometry/   幾何の土台（Phase 11、外部依存なし）
   │   frames.ts     座標フレーム Tile / World / Map / Scene と変換（位置の ±0.5 はここだけ）
   │   angle.ts      角度規約（真方位）、GRID8_STEP、磁方位、滑走路番号
   │   tolerance.ts  許容誤差・限界値（POS_EPS_T、MAX_FLATTEN_POINTS ほか）
   │   vec.ts        Vec2 / Tile と既存の述語（変更しない）
   │   bbox.ts segment.ts polygon.ts stroke.ts raster.ts
   │   curve.ts arc.ts bezier.ts integrate.ts arclength.ts intersect.ts   曲線（直線・円弧・2 次/3 次 Bezier）
   │   camera.ts     画面 ↔ Map（既存）   index.ts  公開 API
   ├─ layout/     編集操作、フットプリント、ネットワーク編集、ピック、runway.ts（runwayAxis。従来形・自由形）、designators.ts（滑走路番号）、runwayAreas.ts（自由形の実寸の領域）、surfaces.ts（描画用の面 `runwaySurfaces`。World フレーム）
   ├─ model/ （runwayReference.ts = 滑走路の参考値とゲーム既定値） io/ （io/migrate.ts = レイアウト版の移行）  airside/ sim/ validation/ economy/ access/ aircraft/ analytics/ assets/ scenario/ terminal/ editor/ sample/ rng.ts
tests/
├─ unit/ integration/ e2e/               unit/geometry/ が幾何ライブラリのテスト
└─ golden/                               ゴールデン基準値・入力フィクスチャ・採取関数（docs/22 §5）
```

依存の向き: `core/geometry` は何にも依存しない（`model/types` の型 `Heading` を `import type` で参照するのみ）。`layout`・`sim`・`airside` は geometry を使い、逆は禁止。
2D・3D の描画は、位置を `frames.ts`、形を `layout/surfaces.ts` から得る（詳細は [22](22_geometry_architecture.md)）。

## 4. シミュレーションループ

### 4.1 固定ティックと描画の分離

```
 requestAnimationFrame(frame):
   accumulatorTicks += realDeltaSec × ticksPerRealSec(speed)
   n = min(floor(accumulatorTicks), MAX_TICKS_PER_FRAME)   // 追いつけない時の上限（スパイラル防止）
   repeat n: core.step()                                   // 1ティック = 1ゲーム秒
   accumulatorTicks -= n
   alpha = accumulatorTicks                                // 0..1 の補間係数
   render.draw(view.select(state), alpha)
   ui.publish(view.snapshot(state))  // 10Hz スロットル
```

- `core.step()` は実時間を一切参照しない。入力は `state` と、そのティックに適用するコマンドのみ。
- 8x（480ティック/実秒）で処理が追いつかない場合は、ゲーム速度を実効的に落とす（ティックを捨てない）。HUD に「処理遅延」表示。
- 将来、コアを **Web Worker** に移す（Phase 7 以降の最適化）。そのため `core` は postMessage 可能なデータのみを入出力し、メインスレッドとは「コマンド送信」「スナップショット受信」だけで通信できる設計にしておく。

### 4.2 ティック内のシステム実行順（固定）

決定性のため、毎ティック以下の順で実行する。各システム内のエンティティ処理順は **ID の昇順**（数値部分で比較）。

1. 予約済みコマンドの適用（`atTick == now`、`seq` 順）
2. 建設完了処理 → 必要なら派生データ再構築（`structureVersion++`）
3. 便スケジューラ（便の状態遷移、航空機の spawn）
4. スポット割り当て（トリガーがあった便のみ）
5. 滑走路コントローラ（進入・離陸・横断の許可）
6. 航空機の移動と状態遷移（区間予約を含む）
7. デッドロック検出（10ティックごと）
8. ターンアラウンド作業・GSEクルー
9. 旅客: 空港到着生成 → 歩行 → 施設キュー処理
10. 手荷物フロー
11. 経済のイベント課金（ledger 記録）
12. 日次締め（`now % 86400 == 0` のとき、[05](05_economy_spec.md) §9 の順）
13. 不変条件チェック（開発/テスト時）
14. `time.now++`

### 4.3 状態の変更方法

- 初期版は **可変な単一状態**（ミュータブルな plain object）をシステムが直接更新する（性能優先）。イミュータブル更新（Immer 等）は毎ティックのコストが大きいため採用しない。
- UI・描画にはスナップショット（必要部分のコピー / 表示モデル）を渡し、`GameState` への参照を外に漏らさない。
- 状態を変更してよいのは `core/` のみ。

### 4.4 派生データの再構築

- 建設レイヤーが変わった時のみ（ティック境界）再構築する。
- 初期版は全再構築（目標規模で数ms程度を想定）。性能が問題になれば差分更新を検討。

## 5. 状態遷移の実装方針

- 航空機・便・旅客グループ・手荷物バッチ・ターンアラウンド作業の状態機械は、**遷移表（データ）+ ガード関数 + 遷移時アクション** の形で `core/ops/*.fsm.ts` に定義する。
- 状態の直接代入を禁止し、`transition(entity, to, ctx)` 関数経由に統一する。不正遷移は開発時に例外、本番ではログ + 現状維持。
- 遷移表から状態遷移図（Mermaid）を生成するスクリプトを用意し、ドキュメントと実装の乖離を防ぐ（S優先度）。

## 6. 決定性の担保

| 要因 | 対策 |
|------|------|
| 乱数 | シード付き PRNG、ストリーム分離（[03](03_data_model.md) §9）。`Math.random()` を ESLint で禁止（core 内） |
| 実時間 | `Date.now()` / `performance.now()` を core 内で禁止 |
| 反復順 | `Object.keys` の順序に依存せず、ID ソート済み配列で反復するヘルパーを使用 |
| 浮動小数 | 金額は整数。位置・速度は浮動小数を許容（同一ブラウザでの再現を保証範囲とする）。比較には許容誤差を使う |
| コマンド | ティック境界でのみ適用し、`atTick` と `seq` をログに記録 |
| 非同期 | core 内で Promise・タイマーを使わない |

## 7. エラーハンドリング・可観測性

- コマンド検証エラーは理由コード（`'TERRAIN_BLOCKED' | 'OVERLAP' | 'INSUFFICIENT_FUNDS' | 'IN_USE' | ...`）を返し、UI が i18n で表示。
- 不変条件違反は `eventLog` に `severity: 'error'` で記録し、開発ビルドではコンソールと画面に表示。
- デバッグオーバーレイ（グラフ・予約・状態）と、ヘッドレスCLI（`tools/run-scenario.ts`）でコアを単独検証できる。

## 8. 性能目標と見積り

| 項目 | 目標規模 | 方針 |
|------|---------|------|
| 同時航空機 | 40機 | 経路キャッシュ、予約はノード単位の Map |
| 同時旅客グループ | 2,000 | 歩行はノードネットワーク上の時間経過のみ（タイル単位探索なし） |
| 1ティック処理時間 | 平均 0.1ms 以下（8xで 480ティック/秒 → 48ms/秒） | ベンチマークをCIで計測 |
| 描画 | 60fps | スプライトプール、旅客ドットはパーティクルコンテナ |
| 派生データ再構築 | 20ms 以下 | 建設時のみ実行 |

## 9. セーブ・ロード

- `platform/save` が IndexedDB（スロット + オートセーブ）とファイル入出力を担当。core は `serialize(state): SaveFile` / `deserialize(file): GameState` を提供。
- ロード後に派生データ再構築 → 不変条件チェックを必須とする。
- スキーマ移行: `migrations[v] : (stateV) => stateV+1` を順次適用。

## 10. ビルド・CI（Phase 1 で設定）

- `npm run dev` / `build` / `preview`
- `npm run lint`（ESLint + 境界ルール + 循環依存チェック）
- `npm run typecheck`（`tsc --noEmit`）
- `npm test`（Vitest: unit + integration + regression）
- `npm run test:e2e`（Playwright）
- `npm run bench`（ティック性能）
- GitHub Actions: PR ごとに lint / typecheck / test / build。E2E は main への merge 時と夜間。
