# GitHub Copilot 引き継ぎプロンプト

あなたは Airport_Simu（SkyPort）のシニアエンジニアです。現在のブランチ `claude/sweet-pasteur-4denw0` にある変更を起点に作業を続けてください。対象リポジトリは `Enu-pilot/Airport_Simu` です。

## 目標

README と仕様書に記載された機能を、既存のレイヤー設計・シミュレーション・保存互換性に合わせて実装する。未実装項目を完了扱いにせず、依存順に一段ずつ完成させる。実装優先で進め、テストを通すために既存の期待値やゴールデンを変更しない。

最初に `README.md`、`docs/08_test_plan.md`、`docs/09_roadmap.md`、`docs/21_save_format.md`、`docs/22_geometry_architecture.md`、`docs/design/phase12b_roadmap.md`、関連する `docs/10`〜`docs/27` を確認する。

## このブランチで実装済みの範囲

- 複数ターミナルの出発・到着旅客割当。単一ターミナル互換、ゲート未割当の曖昧な推測抑止、同一ターミナル内の施設選択と経路再探索。
- ターミナル別の動線構造検証、旅客滞留・誤ターミナル・経路喪失の動的アラート、常設アラート一覧とローカル履歴。
- ターミナル別旅客数・チェックイン/保安の能力表示、実績ログに基づく日次ボトルネック表示。根拠のない航空機・輸送能力は数値を捏造せず未算出表示。
- 2D/3Dのゲーム時刻に応じた昼夜表示、選択機に追従する簡易3D視点。
- README、ロードマップ、関連仕様・テスト計画の状態と前提を更新。

主要実装: `src/core/sim/passengers.ts`、`src/core/validation/validate.ts`、`src/core/terminal/`、`src/core/economy/planning.ts`、`src/core/analytics/review.ts`、`src/ui/operate/`、`src/render/`。

## 未完了項目（実装順）

1. **12B-3b**: 都市設定と旅客需要・アクセス連動、イベントの持続的な需要/運営影響、騒音・住民満足度・夜間運航制限。空港アクセス鉄道の基盤（駅・頻度・容量・待ち行列）は既存実装を再利用し、都市との連動を追加する。
2. **12B-4**: 現在の昼夜表示と簡易追従視点を仕様の季節・日の出日没・経路表示へ仕上げる。マニア向け運航日誌・機種別累計などを追加する。
3. **Phase U**: 地下レベルを保存可能な別ネットワークとして設計し、地上接続、地下駅、燃料ハイドラントを実際の旅客・車両・給油処理へ統合する。表示だけで終わらせない。
4. **Phase 13**: `docs/22_geometry_architecture.md` と既存 `src/core/geometry/` を使い、曲線誘導路の保存・編集・分割・接続判定・経路探索を実装する。
5. **Phase 14/15**: 機種別の実寸・脚配置・操向制約と施設クリアランス、曲線上の位置/速度/衝突判定を運航予約グラフへ統合する。
6. **Phase 16**: 専用3Dアセット、LOD/描画負荷、2Dとの対応を拡充する。

12B-3b以降の設計が不足する場合は、上記の既存ロードマップに沿って、データ形式・算出式・単位・移行条件・失敗時の挙動を docs に具体化してから実装する。レイアウトや保存形式を変える場合は `docs/21_save_format.md` に従い、旧セーブを追加する。

## 回帰・検証メモ

- `npm run build`: 成功。Vite は 1.5 MB を超えるメインバンドル警告を出す。
- `npm run lint`: 成功。
- 対象集中テスト: `tests/unit/sim/multiTerminalPassengers.test.ts`、`tests/unit/ops12b.test.ts`、`tests/unit/review.test.ts` は 30/30 成功。
- `npm test`: 74/75 ファイル、696/697 テスト成功。既存 `project-sim.golden.json` と保存結果が不一致。期待値は更新しないこと。
- `npm run test`: 70/75 ファイル、692/697 成功。上記ゴールデン不一致に加え、複数の重い既存テストが 5 秒/30 秒の時間制限でタイムアウト。集中実行で再現性を確認し、実装の性能回帰と実行負荷を切り分けること。
- `package.json` の実在スクリプト: `build`、`typecheck`、`lint`、`test`、`test:watch`、`test:e2e`。

作業を再開したら、まず `git status --short` と `git diff --check` を確認し、ゴールデン差分を再採取せず、上記の未完了リストから実装を続ける。各段階で状態遷移・経路探索を含むテストと docs 更新を追加する。README と `docs/09_roadmap.md` は実装に合わせて更新する。
