# HANDOFF_PROMPT — Airport_Simu

> 目的: Claude の再開時に今回必要な情報だけを渡す。仕様書の複製・長文の作業日誌は禁止。
> **上限: 本ファイル全体 1,200 tokens 目安。**

## 再開時の指示
1. CLAUDE.md と docs/implementation/README.md を読む（標準開発ルール・計画書の状態管理を確認）。
2. 本ファイルの「現在の作業」と「次の作業」だけ読む。
3. git status -sb、git diff --stat、git diff --name-only、git log -3 --oneline を確認する。未コミット変更・未追跡ファイルを保護する。
4. 記録済みの対象ファイルから調査を始め、必要な範囲だけ読む。
5. コード・仕様の作業を始める前に「現在の作業」を進行中にし、開始日時・目的・対象を記録して本ファイルを先に更新する。
6. 作業終了・中断時は実施内容・検証結果・残件を記録し、状態を完了または中断に更新する。

## 現在の作業
- 状態: 進行中（Docs 計画作成のみ。コード変更なし）
- 開始: 2026-11-18
- 目的: 空港能力に「最混雑60分の評価・ボトルネック」と「ターミナル別・工程別の人/時能力・実績」を追加する Phase 5 計画（5-21）を作成。
- 対象: `docs/42_implementation_roadmap.md`、`docs/implementation/README.md`、新規 `docs/implementation/planned/peak_hour_passenger_capacity_plan.md`。
- 調査: `docs/33`、`docs/35`、`src/core/economy/capacity.ts`、`src/core/terminal/capacity.ts`、`src/core/sim/passengers.ts`、`src/core/access/runtime.ts`、`src/core/sim/apronBus.ts`、`src/ui/CapacityPanel.tsx`。
- 重要: チェックイン/保安検査は計画能力あり。トイレは90秒/人・fixture基準、アクセスは主に空港全体集計、バスは旅客/便・運行実績中心で、各工程の同一時間窓・ターミナル別時系列評価は不足。推定値と未算出を混同しない。

## 次の作業
- 5-21 計画作成後、Codex等で実装する際は、5-16の対外交通・ターミナル別割当との依存を確認する。
- 未検証: Phase 4 の朝の波・バンクの区間走行再計測、2ターミナルの波（docs/44 §8）。
- 既存の未 push 変更（実在航空会社データ・階層拡張・敷地サイズ選択等）は、ユーザー承認前に push しない。

## 作業記録（直近）
- 2026-11-18: マップサイズ選択、実在航空会社・機材データ追加、ターミナル階層拡張を実施。詳細・テストは直近の Git 履歴と docs/42 を参照。push はユーザー承認待ち。
- 2026-11-18: Phase 4 完了。仕様 docs/44。朝の波・バンクの区間走行再計測と2ターミナル波は未検証。
- 2026-11-18: Phase 5 個別計画 5-13〜5-20 を登録。正本一覧は docs/implementation/README.md。

## 記録ルール
- 作業概要は最大200 tokens、対象ファイルは最大8件、次の作業は最大5項目。
- 仕様の転載は禁止。状態・参照先・検証結果だけ記録する。
- 状態は 未開始 / 進行中 / 中断 / 完了。完了と中断は区別する。
