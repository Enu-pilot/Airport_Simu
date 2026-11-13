# SkyPort

PCブラウザで動作する空港デザイン・運営シミュレーションゲーム。

プレイヤーは滑走路・誘導路・駐機場・ターミナル・各種設備を建設し、航空機の発着、旅客・手荷物の流れ、地上支援、航空会社との契約を管理して、空港の処理能力と収益を高める。
施設や道路の配置は見た目だけでなく、航空機・旅客・手荷物の流れに実際に影響する。

> 本ゲームは娯楽目的の簡略化モデルであり、実際の航空管制・航空安全基準への適合を保証するものではない。

## 現在の状態

**Phase 12** — 滑走路を任意の真方位・実長（m）で置ける「自由形」を追加（滑走路ツールのオプション。既定は従来の 8 方向）。実寸の舗装・肩・着陸帯・RESA による判定、
磁気偏角つきの滑走路番号（L/C/R）、平行間隔の警告、交差する滑走路（従属運用）、2D/3D の描画。従来形の舗装は実寸の幅で表示。
設計・参考値は [docs/23](docs/23_runway_design.md)、検証は [docs/26](docs/26_validation_rules.md)、移行・互換性は [docs/27](docs/27_migration_and_compatibility.md)。
参考値はゲーム内の判定であり、実際の安全基準への適合を保証しない。未実装・既知の制限は [docs/10](docs/10_open_issues.md) の M。

**Phase 7〜10** — 具体的な機種・派生型（777-300 と 777-300ER など、メーカー資料で照合した値と出典つき）を航空会社の保有機材・便に割り当て、
機種ごとに座席・手荷物・地上作業・必要な滑走路長・スポットの適合性が変わる。天候・障害（滑走路閉鎖・ゲート故障・車両故障・欠勤・需要急増など）と対応操作。
機種別・航空会社別などの運営分析、ボトルネックの根拠、混雑マップ、シナリオ比較。2D/3D 表示の切り替え（3D の機体は手続き生成）。
プロジェクトの保存・復元（運航中の状態を含む）、機種データの固定と最新カタログとの差分、旧形式の移行。
Phase 1〜6 の建設エディタ、運航、旅客、地上支援・手荷物、運航計画・経営、空港アクセス・拡張はそのまま使える。
ルールは docs/11〜21（下表）。いずれもゲーム用の簡略化モデルで、金額はゲーム内通貨 cr（実在の料金・費用とは無関係）。
未実装の機能・既知の制限は [docs/10](docs/10_open_issues.md) の K（自動最適化は未実装、3D の専用機体モデルはなし など）。

## 使い方

```bash
npm install
npm run dev        # 開発サーバー（http://localhost:5173）
npm run build      # 型チェック + 本番ビルド（dist/）
npm test           # 単体テスト（Vitest）
npm run test:e2e   # ブラウザテスト（Playwright）
npm run lint       # ESLint（レイヤー境界ルールを含む）
```

| 操作 | 内容 |
|------|------|
| 左クリック / ドラッグ | 選択 / 移動（選択ツール）、配置（各建設ツール） |
| 右ドラッグ・中ドラッグ・Space+ドラッグ | パン |
| ホイール | ズーム（カーソル位置を中心） |
| 誘導路・道路 | クリックで頂点追加、ダブルクリック・Enter・右クリックで確定 |
| R / Ctrl+D / Delete | 回転 / 複製 / 削除 |
| Ctrl+Z / Ctrl+Shift+Z・Ctrl+Y | 元に戻す / やり直し |
| 矢印キー | 選択中の施設を1タイル移動（Shift で10） |

上部の「3D表示へ」で 3D ビューに切り替え（ドラッグで回転、右ドラッグでパン、ホイールでズーム。運航は止まらない）。

### 保存・バックアップ

- 作業中の空港・会社はブラウザに自動保存される。
- 下部の「プロジェクト」タブで **保存 / 名前を付けて保存 / 開く / 削除**。運航中に保存すると運航状態も含まれ、開くと一時停止で再開する。
- 保存先はこのブラウザの localStorage（端末・ブラウザごと、約 5 MB まで）。**バックアップや別の端末へは「JSON に書き出し」**、戻すときは「JSON を読み込み」。
  以前の「書き出し」で作ったレイアウトファイルも読み込める。読み込みは検証してから適用し、問題があれば開いている内容は変えない。

運航モード: 機体をクリックで状態・経路・運航履歴を表示 / Space 一時停止 / 1〜5 時間倍率（実時間〜×600）/ 左パネルで滑走路の運用方向・モード変更と便の追加。
運航モードの画面（Phase 12B-1）: 左右の常設カード（本日の KPI・滑走路・天候/障害・工事・ターミナル・地上支援・アクセス・航空会社の評価・イベント）、マップ右上の案内板風の運航表（出発/到着の切り替え・折りたたみ・行クリックで機体選択・⋯ から遅延/スポット変更/優先）、左上のアラート（クリックで移動・修理など）、上部のボタン列から大きなオーバーレイ（経営・分析・アクセスなど。×/Esc で閉じる）。下部には選択中の機体・施設の詳細。

## ソース構成

| ディレクトリ | 役割 |
|-------------|------|
| `src/core/` | DOM・描画に依存しないロジック（データモデル、編集操作、論理ネットワーク、検証、Undo履歴、サンプル空港、`sim/` 運航シミュレーション） |
| `src/editor/` | エディタの状態（Zustand ストア）、ツールのプレビュー、マウス・キー操作の解釈、運航ループ（`simRunner.ts`） |
| `src/render/` | PixiJS によるマップ描画、`three/` three.js による 3D 表示 |
| `src/ui/` | React の画面部品（ツール、施設一覧、プロパティ、問題一覧） |
| `src/i18n/` | 表示文言（日本語） |
| `tests/unit/` | core の単体テスト / `tests/e2e/` ブラウザテスト |

## 設計文書

| # | 文書 | 内容 |
|---|------|------|
| 00 | [docs/00_survey.md](docs/00_survey.md) | 既存環境の調査結果 |
| 01 | [docs/01_requirements.md](docs/01_requirements.md) | 要件定義書（目的・スコープ・機能/非機能要件・用語集） |
| 02 | [docs/02_game_spec.md](docs/02_game_spec.md) | ゲーム仕様書（ゲームループ・施設・建設ルール・進行） |
| 03 | [docs/03_data_model.md](docs/03_data_model.md) | 空港データモデル（ID・エンティティ・論理グラフ・セーブ形式） |
| 04 | [docs/04_operations_passenger_spec.md](docs/04_operations_passenger_spec.md) | 運航・旅客・手荷物処理仕様（状態遷移・占有管理・動線） |
| 05 | [docs/05_economy_spec.md](docs/05_economy_spec.md) | 経営計算仕様（収支・料金・契約・需要） |
| 06 | [docs/06_ui_design.md](docs/06_ui_design.md) | UI設計書（画面構成・操作・オーバーレイ） |
| 07 | [docs/07_architecture.md](docs/07_architecture.md) | アーキテクチャ設計書（技術構成・モジュール分割・シミュレーションループ） |
| 08 | [docs/08_test_plan.md](docs/08_test_plan.md) | テスト計画（単体・統合・回帰・不変条件） |
| 09 | [docs/09_roadmap.md](docs/09_roadmap.md) | フェーズ別ロードマップ |
| 10 | [docs/10_open_issues.md](docs/10_open_issues.md) | 未決事項一覧 |
| 11 | [docs/11_operations_rules.md](docs/11_operations_rules.md) | 運航ルール仕様（Phase 2 実装、前提と制約・未実装の条件） |
| 12 | [docs/12_passenger_rules.md](docs/12_passenger_rules.md) | ターミナル・旅客流動仕様（Phase 3 実装） |
| 13 | [docs/13_ground_handling_rules.md](docs/13_ground_handling_rules.md) | 地上支援・手荷物・折り返し業務仕様（Phase 4 実装） |
| 14 | [docs/14_management_rules.md](docs/14_management_rules.md) | 運航計画・航空会社・経営ルール（Phase 5 実装、料金・費用・KPI の式） |
| 15 | [docs/15_access_rules.md](docs/15_access_rules.md) | 空港アクセス・周辺施設・拡張ルール（Phase 6 実装、手段選択・混雑・土地・工事の式） |
| 16 | [docs/16_aircraft_catalog.md](docs/16_aircraft_catalog.md) | 機種カタログとデータ出典一覧（公式値・ゲーム値・未設定の区別、未収録の機種） |
| 17 | [docs/17_compatibility.md](docs/17_compatibility.md) | 機種と施設の適合性ルール |
| 18 | [docs/18_analytics.md](docs/18_analytics.md) | 運営分析・機種別統計・ボトルネック・シナリオ比較（指標の式） |
| 19 | [docs/19_disruptions.md](docs/19_disruptions.md) | 天候・障害・運航トラブルと対応 |
| 20 | [docs/20_3d_view.md](docs/20_3d_view.md) | 3D 表示、3D アセットの対応一覧と利用条件、性能計測 |
| 21 | [docs/21_save_format.md](docs/21_save_format.md) | 保存形式・バージョン管理・移行・保存先とバックアップ |
| 23 | [docs/23_runway_design.md](docs/23_runway_design.md) | 滑走路の設計（自由方位・実寸・番号・交差の運航・参考値と出典・エディタの使い方、Phase 12） |
| 26 | [docs/26_validation_rules.md](docs/26_validation_rules.md) | 滑走路に関する検証コードと適用条件（従来 / 実寸、classic / realistic） |
| 27 | [docs/27_migration_and_compatibility.md](docs/27_migration_and_compatibility.md) | スキーマ v1→v2→v3、版の方針、互換性、ゴールデンの戦略 |
| 22 | [docs/22_geometry_architecture.md](docs/22_geometry_architecture.md) | 幾何基盤（座標フレーム・角度規約・許容誤差・ゴールデン基準値）とデータモデルの計画（Phase 11） |

## 技術構成

TypeScript / Vite / PixiJS（マップ描画）/ three.js 0.180.0（3D 表示）/ React（UIパネル）/ Zustand / Vitest / Playwright / ESLint。
詳細と選定理由は [docs/07_architecture.md](docs/07_architecture.md) を参照。
