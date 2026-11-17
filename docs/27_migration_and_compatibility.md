# 27. 移行と互換性（スキーマ v1 → v2 → v3、版の方針、ゴールデン）

保存形式の全体は [21](21_save_format.md)、幾何基盤の版の方針は [22](22_geometry_architecture.md) §7、滑走路のデータは [23](23_runway_design.md)。
実装: `src/core/io/migrate.ts`（移行）、`src/core/io/project.ts`（`checkLayout` / `validateProject`）、`src/core/io/serialize.ts`（新しい項目の検査）、`src/core/model/types.ts`（`SCHEMA_VERSION`）。

## 1. スキーマの版

| 版 | 追加されたもの | 移行 |
|---|---|---|
| v1 | 初期のレイアウト | — |
| v2（Phase 6 以前） | ターミナル内部のエリア（`terminalAreas`） | v1 → v2: `terminalAreas = {}` を足し `schemaVersion = 2` |
| v3（Phase 12） | 任意項目のみ: `runways[].alignment`・`headingDeg`・`lengthM`・`dims`・`designatorSuffix`、`layout.magneticVariationDeg`・`ruleSet`、`NetNode.pos` が実数可 | **何も書き換えない**（`layout.schemaVersion` も 2 のまま） |

- v3 の追加はすべて任意項目で、欠落は従来の意味。v2 のデータはそのまま妥当な v3。必須の変換がないので、`layout.schemaVersion` は「作成または最後に構造的な移行をした版」という意味になる。
  **保存ファイルの外側の版**（レイアウトファイルの `schemaVersion`、プロジェクトの `versions.layoutSchema`）は保存時に常に現行（3）になり、こちらが正。新規作成の `createLayout` は 3 を書く。
- 既定値はキーとして書かない。そのため従来形だけのレイアウトの JSON は、移行の前後でバイト列まで同じ（版を除く）。
- Phase 13 の `TaxiwayEdge.geometry`（任意項目）は同じ v3 に含める方針（再度の版の更新は不要。**未実装**）。

Phase U の階層・交通項目も任意データとして追加し、内部 `SCHEMA_VERSION = 3` を維持する。多層設備を含むプロジェクトは外側の `formatVersion: 3` で識別し、旧アプリが階層・旅客区域・接続能力を無視しないよう読み込みを拒否する。

## 2. 版の方針（Phase 12 の結果）

| 版 | 値 | 理由 |
|---|---|---|
| `SCHEMA_VERSION` | 2 → **3** | 自由形・磁気偏角・ルール切替を保存する。Phase U の任意項目も v3 の拡張として保持 |
| `PROJECT_FORMAT_VERSION` | 1 のまま | ファイルの構造は変わらない |
| `CATALOG_VERSION` | 不変 | 機種データは変えない。滑走路の参考値はカタログ外の別表 |
| `SIM_MODEL_VERSION` | `skyport-sim-10.0` のまま | v2 で表現できるレイアウトの運航結果が 1 ビットも変わらない。自由形・交差の新しい処理は、従来形だけのレイアウトでは空ループ（ゴールデンで確認） |
| 運航状態の `state.version` | 1 のまま | 任意項目の追加のみ |

`SIM_MODEL_VERSION` を上げる必要が生じたら実装を止めて設計を見直す（保存済みの運航状態が復元されなくなるため）。

## 3. 旧アプリ・新アプリの互換性

| 組み合わせ | 結果 |
|---|---|
| 新アプリ（v3）で v1/v2 のファイル・プロジェクトを開く | 読める（v1 は v2 へ移行。v2 → v3 は恒等）。**開いた直後の空港の検証・運航結果は従来と同じ** |
| 旧アプリ（v2 まで）で v3 の **レイアウトファイル** を開く | 「未対応の版」として拒否（既存の処理） |
| 旧アプリで v3 の **プロジェクトファイル** を開く | **拒否されない可能性がある**。旧アプリは `versions.layoutSchema` を見ていないため、自由形の滑走路は未知の項目（`heading` / `length` が無い）として壊れたまま読めてしまう。旧アプリは直せないので既知の制限 |
| 新アプリ（Phase 12 以降）で、より新しい版のプロジェクト | `versions.layoutSchema > SCHEMA_VERSION` はエラー（今後の版のための検査を追加済み） |

## 3b. 保存形式 v2（Phase 12B-3a）

新しい項目（バスゲート・独立ゲート・ランプバス・運航中のバスの状態）を使うプロジェクトだけ `formatVersion: 2` で書き、使わなければ 1 のまま（`project.golden.json` は不変）。旧アプリ（`PROJECT_FORMAT_VERSION = 1` まで）は v2 のプロジェクトを「新しい版」として拒否するので、バスゲートを知らないまま誤って読むことがない。**レイアウトだけの旧形式（`SAVE_FORMAT`）は版を持たない**ため、旧アプリはバスゲートを「スポットのない通常ゲート」として読む（プロジェクト形式での書き出しを推奨）。docs/21。

## 3c. 保存形式 v3（Phase U 交通基盤）

多層道路ノード/エッジ、垂直接続、駅階層、ターミナル間連絡リンクのいずれかを含む場合だけ `formatVersion: 3` を書く。該当データを v1/v2 として名乗るファイルは検証で拒否する。v3 以前の通常プロジェクトは従来どおり読み、書き戻すと使っている機能に必要な版を選ぶ。旧アプリが v3 の連絡設備や階層値を無視する可能性があるため、該当プロジェクトは新アプリでのみ編集する。

## 3d. 保存形式 v5（フェーズ 3）・v6（フェーズ 4）

v5 は会社の `market`（路線需要モデル）を含む場合だけ書く。v6 はフェーズ 4 の項目（会社の `features`・持ち越し・所属機・ハブ設定、契約の種類・乗継率・バンク、レイアウトの区間能力モデル・国際のエリアとゲート属性・運航状態の兼用ゲートと乗継統計など）のいずれかを含む場合だけ書く。どちらも、該当項目を含まないプロジェクトは従来の版のまま書き戻され、バイト列は変わらない。版未満を名乗るファイルに新項目がある場合は検証で拒否する。`features` のない会社への取り込み（`importCompany`）では、持ち越し・所属機・ハブ設定は落として取り込む。項目一覧と検証条件は docs/21 の版 5・版 6 の節、機能の仕様は docs/44。

## 4. 保存・読込の検査（`checkLayout`）

追加したのは **新しい項目だけを対象とする検査**（従来形の滑走路に新しい検査を足すと、今まで読めたファイルが読めなくなるため足さない）。

- `alignment` が `undefined` / `'free'` 以外 → エラー（新しいバージョンで作成された可能性）。
- 自由形: `start` が有限、`headingDeg` が有限で [0, 360)、`lengthM` が有限で範囲内、`surfaceWidthM` ∈ {30, 45, 60}、`dims` の値が有限（標高以外は ≥ 0、`stripHalfWidthM`・`resaWidthM` は > 0）、`designatorSuffix` ∈ {L, C, R, none}。
- 任意の滑走路の `designatorSuffix`、`layout.magneticVariationDeg`（有限で [-180, 180]）、`ruleSet`（classic / realistic）。
- シナリオのレイアウトも `checkLayout` を通る。運航状態は復元して不変条件を検査する（R2・R6 を含む）。

## 5. ゴールデンの戦略（docs/22 §5 の続き）

- **1 回だけの再採取（S1）**: SCHEMA_VERSION 3 で版に敏感なキーだけが変わるファイル（`geometry-{sample,starter,all-headings}.golden.json` の `exportLayoutSha256`、`project.golden.json`、`project-sim.golden.json` の `sha256`）を再採取した。
  版に依存しないハッシュ（`normalized-hashes.golden.json`、`project-sim.golden.json` の `normalizedSha256`）と、そのほかのすべての項目は不変であることをスクリプトで確認した。
- 運航ゴールデン（`sim: true`）は版に敏感なキー（`sha256`・`length`・`exportLayoutSha256`）だけの変更で、`normalizedSha256` が同じときに限って再採取を許す（`isVersionOnlyChange`、単体テストあり）。それ以外の変化は `SIM_MODEL_VERSION` を上げずに再採取できない。
- **S1 以降はゴールデンを変えない**。Phase 12 の自由形のゴールデンは **新しいファイルだけ** を追加した: `free-runways.golden.json`（ネットワーク・検証・runwayAreas・番号）、`crossing-sim.golden.json`（運航の状態ハッシュ、交差・平行 × 2 シード × 3 時間）、
  入力のフィクスチャ `fixtures/free-crossing.layout.json` / `free-parallel.layout.json`。運航のゴールデンの台帳（`sim-versions.json`）に新しい行を 1 つ足した。既存のゴールデンファイルは変更していない。その後の不具合修正 M1（自由形の停止位置）で交差のレイアウトの運航が変わったため、**この新しいファイル `crossing-sim.golden.json` だけ** を再採取した（台帳の版は同じ。既存のゴールデンは不変）。
- 再採取: `GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.free.test.ts`。入力フィクスチャの再生成: `GOLDEN_FIXTURES_UPDATE=1 npx vitest run tests/unit/golden.free.test.ts`（ゴールデン全体の再採取が必要になる）。

- Phase 12B-3a Part B: `SCHEMA_VERSION`・`SIM_MODEL_VERSION` は上げない（新しい挙動は会社の `game` があるときだけ）。新規ゴールデン `game-weather.golden.json`・`game-models.golden.json` を `sim-versions.json` に追加（既存の項目は不変）。旧アプリは `formatVersion 2` を読み込まない。
