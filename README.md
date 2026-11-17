# SkyPort

PC ブラウザで動作する空港デザイン・運営シミュレーションゲームです。滑走路・誘導路・スポット・ターミナル・各種設備を配置し、航空機の運航、旅客・手荷物の流れ、地上支援、航空会社との契約を管理します。施設や交通網の配置は、見た目だけでなくシミュレーション上の処理能力と動線に影響します。

> 本ゲームは娯楽目的の簡略化モデルです。実際の航空管制・航空安全基準への適合を保証するものではありません。

## 開発状況（2026-11-17）

| フェーズ | 状態 | 内容 |
|---|---|---|
| Phase 1 | 完了 | 現行機能の不具合修正、操作性・UI 改善、品質ゲートとゴールデンの確認 |
| Phase 2 | 実装中 | 誘導路の区間走行、出発時刻・夜間制限、遅延指標 |
| Phase 3 | 計画 | 航空会社の輸送人員と就航都市データの拡張 |
| Phase 4 | 計画 | 格による解放、夜間滞泊、拠点・整備、国際線・ハブ、道路区間能力 |
| Phase 5 | 候補 | 追加の能力・経営・ゲーム体験の改善 |

現在の優先順位・受入条件・フェーズ進捗は [docs/42](docs/42_implementation_roadmap.md)、詳細な実装タスクは [実装計画一覧](docs/implementation/README.md) を参照してください。個別機能の現行仕様は各機能の Docs を正本とします。

## 開発環境

Node.js と npm を使用します。

```bash
npm ci
npm run dev          # 開発サーバー（http://localhost:5173）
npm run typecheck    # TypeScript の型検査
npm run lint         # ESLint
npm test             # Vitest 単体テスト
npm run test:e2e     # Playwright E2E テスト
npm run build        # 型検査 + 本番ビルド（dist/）
```

## 操作と保存

- 左クリック／ドラッグで選択・移動・配置、右ドラッグ・中ドラッグ・Space+ドラッグでパン、ホイールでズームします。
- 誘導路・道路はクリックで頂点を追加し、ダブルクリック・Enter・右クリックで確定します。
- R / Ctrl+D / Delete は回転 / 複製 / 削除、Ctrl+Z / Ctrl+Shift+Z（または Ctrl+Y）は元に戻す / やり直しです。
- 3D 表示ではドラッグで回転、右ドラッグでパン、ホイールでズームできます。
- プロジェクトはブラウザ内に保存されます。端末・ブラウザをまたぐバックアップには JSON の書き出し・読み込みを使用してください。形式・移行の詳細は [docs/21](docs/21_save_format.md) と [docs/27](docs/27_migration_and_compatibility.md) を参照してください。

## ドキュメント

- [Docs 全体の索引・正本の使い分け](docs/README.md)
- [標準開発ルール](CLAUDE.md)
- [実装計画の管理・状態一覧](docs/implementation/README.md)
- [全体ロードマップ・受入条件](docs/42_implementation_roadmap.md)
- [未決事項・既知の制限](docs/10_open_issues.md)
- [総合テスト・監査記録](docs/39_comprehensive_test_audit_and_handover.md)
- [設計記録・調査資料](docs/design/README.md)

## 技術構成

React 19 / TypeScript 5.9 / Vite 8 / PixiJS 8 / Three.js 0.180 / Zustand 5 を使用します。テストは Vitest 5 と Playwright 1.63 です。依存関係と実行スクリプトの確定値は [package.json](package.json) を参照してください。
