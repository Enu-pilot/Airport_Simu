# SkyPort

PCブラウザで動作する空港デザイン・運営シミュレーションゲーム。

プレイヤーは滑走路・誘導路・駐機場・ターミナル・各種設備を建設し、航空機の発着、旅客・手荷物の流れ、地上支援、航空会社との契約を管理して、空港の処理能力と収益を高める。
施設や道路の配置は見た目だけでなく、航空機・旅客・手荷物の流れに実際に影響する。

> 本ゲームは娯楽目的の簡略化モデルであり、実際の航空管制・航空安全基準への適合を保証するものではない。

## 現在の状態

**Phase 0（要件定義・技術設計）** — 設計文書のみ。実装コードはまだない。

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

## 想定技術構成（承認待ち）

TypeScript / Vite / PixiJS（マップ描画）/ React（UIパネル）/ Vitest / Playwright。
詳細と選定理由は [docs/07_architecture.md](docs/07_architecture.md) を参照。
