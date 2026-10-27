# SkyPort

PCブラウザで動作する空港デザイン・運営シミュレーションゲーム。

プレイヤーは滑走路・誘導路・駐機場・ターミナル・各種設備を建設し、航空機の発着、旅客・手荷物の流れ、地上支援、航空会社との契約を管理して、空港の処理能力と収益を高める。
施設や道路の配置は見た目だけでなく、航空機・旅客・手荷物の流れに実際に影響する。

> 本ゲームは娯楽目的の簡略化モデルであり、実際の航空管制・航空安全基準への適合を保証するものではない。

## 現在の状態

**Phase 3（ターミナル・旅客流動）** — 建設エディタで空港とターミナル内部（階・エリア）を作り、「▶ 運航開始」で航空機の運航と旅客の流れ（チェックイン → 保安検査 → 搭乗、降機 → 手荷物受取 → 出口）をシミュレーションする。
ルールは [docs/11_operations_rules.md](docs/11_operations_rules.md)（運航）、[docs/12_passenger_rules.md](docs/12_passenger_rules.md)（旅客）。いずれもゲーム用の簡略化モデル。

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

運航モード: 機体をクリックで状態・経路・運航履歴を表示 / Space 一時停止 / 1〜5 時間倍率（実時間〜×600）/ 左パネルで滑走路の運用方向・モード変更と便の追加。

## ソース構成

| ディレクトリ | 役割 |
|-------------|------|
| `src/core/` | DOM・描画に依存しないロジック（データモデル、編集操作、論理ネットワーク、検証、Undo履歴、サンプル空港、`sim/` 運航シミュレーション） |
| `src/editor/` | エディタの状態（Zustand ストア）、ツールのプレビュー、マウス・キー操作の解釈、運航ループ（`simRunner.ts`） |
| `src/render/` | PixiJS によるマップ描画 |
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

## 技術構成

TypeScript / Vite / PixiJS（マップ描画）/ React（UIパネル）/ Zustand / Vitest / Playwright / ESLint。
詳細と選定理由は [docs/07_architecture.md](docs/07_architecture.md) を参照。
