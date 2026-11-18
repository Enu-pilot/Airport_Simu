# docs/design — 設計判断・調査資料・履歴

このディレクトリは、設計の経緯・判断理由・監査補助資料・外部調査の根拠を保持します。**現在の機能仕様や実装進捗の正本ではありません。** 実装計画書は [docs/implementation/](../implementation/README.md) で状態別に管理します。

## PO 要望・判断記録
- [phase12b_po_requests.md](phase12b_po_requests.md): Phase 12B の PO 要望と判断の記録。設計経緯の参照資料。

## 調査・参考根拠
- [research_ground_geometry.md](research_ground_geometry.md): 機種別の脚配置・旋回半径に関する調査。Phase 14 の参考資料。
- [research_runway_reference.md](research_runway_reference.md): 滑走路寸法の参考値（FAA / EASA 資料）。
- [haneda_airport_facilities_survey.md](haneda_airport_facilities_survey.md): 羽田空港で確認できる施設・一般的な空港設備候補と、Airport_Simu の施設分類・能力設計の参考。現行仕様ではない。

## 過去フェーズの設計記録
- [phase11_design.md](phase11_design.md): Phase 11 幾何基盤の設計・座標フレーム・データモデル方針。
- [phase12_design.md](phase12_design.md): Phase 12 滑走路の自由設計。
- [phase12_decision_c1_m1.md](phase12_decision_c1_m1.md): 滑走路横断の占有漏れ（C1）と停止位置（M1）の判断記録。
- [phase12b_roadmap.md](phase12b_roadmap.md): Phase 12B と地下・後続フェーズの当時の全体計画。
- [phase12b_3a_design.md](phase12b_3a_design.md): Phase 12B-3a の詳細設計。
- これらは設計履歴です。現行仕様と異なる箇所があれば、日付・対象コミットを確認し、現行の機能別仕様書と実装を照合してください。

## 監査補助資料・旧引継ぎ
- [phase1_audit.md](phase1_audit.md): Phase 1 の監査記録。
- [phase12b_3a_audit_open_items.md](phase12b_3a_audit_open_items.md): Phase 12B の当時の監査未対応項目。
- [audit39_game_design_analysis.md](audit39_game_design_analysis.md): Audit 39 時点のゲームデザイン分析。
- [audit39_traceability_inventory.md](audit39_traceability_inventory.md): Audit 39 時点の仕様・実装・テスト対応表。
- [HANDOVER.md](HANDOVER.md): 2026-11-13 時点の古い引継ぎ。現在の再開情報には [HANDOFF_PROMPT.md](../../HANDOFF_PROMPT.md) を使用してください。

## 実装計画書の旧パス
従来の `impl_phaseN_plan.md` は状態別管理に移行しました。旧ファイルは新しい正本への案内のみを残しています。計画の編集は [docs/implementation/README.md](../implementation/README.md) の一覧にある正本で行ってください。
