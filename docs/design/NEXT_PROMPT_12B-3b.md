# 次の作業の指示プロンプト（12B-3b の実装）

新しいセッションでそのまま貼り付けて使う。

```
SkyPort（Enu-pilot/Airport_Simu）の開発を続けてください。
まず docs/design/HANDOVER.md、docs/design/README.md、docs/design/phase12b_3b_design.md を読んでください。

体制: 指示・統合は Fable、設計とレビューは Opus、実装は Sonnet、調査・監査は Haiku。
各段階で「Sonnet の実装（ステップごとにコミット・push）→ Haiku の独立監査（リポジトリの写しで実行、読み取りのみ）→ Opus の差分レビュー → 修正 → PR」の順に進めてください。

## 作業
0. 準備（設計書の S0）
   - PR #5（ブランチ claude/phase12b-ops-experience）がマージ済みなら、既定ブランチ claude/sweet-pasteur-4denw0 から新しいブランチ claude/phase12b-3b-city-noise-events を作る。
     未マージなら claude/phase12b-ops-experience の上に積み、既定ブランチ（PR #4 の acceptOffer の変更）をマージしておく（衝突なしを確認済み）。
   - 12B-3a 後半の独立監査の結果: docs/design/phase12b_3a_partB_audit.md（あれば）。指摘があれば先に修正する。
1. 12B-3b を設計書 docs/design/phase12b_3b_design.md の手順どおりに実装する。
   3b-1 都市とアクセス鉄道（7 コミット）→ 3b-2 騒音と夜間制限（4）→ 3b-3 イベント（7）。
   高リスクの手順（C4/C5 access、C6 planning/company/goals、E2 simulation.ts のフック、E4 契約のチャーター）は設計書 §6.1 の回帰テスト一式を実行する。
2. 監査・レビュー・修正のあと、既定ブランチ向けに PR を作成する（マージは PO が行う）。

## PO の決定（設計書の確認事項への回答）
- 新しいゲームの既定の都市タイプ: core（中核都市）。
- 新しいゲームでは 都市・騒音・イベント を既定でオン（設定画面でそれぞれオフにできる）。

## 守ること
- 既存のセーブが読める。既存のレイアウト・プロジェクト（ゲーム設定なし）と 12B-3a までの結果を変えない。tests/golden の既存ファイルはバイト一致（新しいゴールデンは新しいファイルで追加し、sim-versions.json の台帳に記録）。
- 新しい仕組みは game.city / game.noise / game.events のフラグがあるときだけ動く。乱数は専用の系列（state.rng や会社の rng から引かない）。
- 既存テストの期待値と既存の e2e spec を、テストを通すために編集しない。
- SIM_MODEL_VERSION・SCHEMA_VERSION は上げない。新しい項目を使うファイルだけ保存形式の版 3（formatVersionOf の拡張と厳格な検査を同じコミットで）。
- 値はゲーム値として明記し、実際の基準（騒音の Lden などは参考）への適合を保証する表示をしない。
- コミット末尾に Co-Authored-By と Claude-Session の 2 行。モデル名を他に書かない。
- 使用量の上限で止まることがあるので、小さく検証してコミット・push し、止まったら中断箇所から再開する。
```
