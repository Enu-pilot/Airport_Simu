# 実装計画の管理

このディレクトリは、機能実装の計画・進捗・完了記録を一元管理します。実装計画の作成・更新は、コード変更と同じ開発サイクルの一部です。

## 文書の役割

| 文書 | 管理する内容 |
|---|---|
| [docs/42](../42_implementation_roadmap.md) | PO 承認済みの優先順位、要求 ID、フェーズ全体の受入条件・状態 |
| このディレクトリの計画書 | 現状調査、設計、変更対象、タスク分割、タスク単位の進捗、差分・検証結果 |
| 各機能の仕様書 | 実装・検証で確認した現在の挙動、データ形式、判定基準、制限 |
| [docs/10](../10_open_issues.md) | 未決事項・既知制限の累積台帳 |
| [docs/39](../39_comprehensive_test_audit_and_handover.md) | 監査を実施した時点の結果。現在の状態は再確認する |
| [HANDOFF_PROMPT.md](../../HANDOFF_PROMPT.md) | セッション・担当者をまたぐ現在の作業と再開情報 |

## フェーズ全体の実装状況（2026-11-18、正本: docs/42）

| フェーズ | 実装状況 | 詳細計画書の配置 | 状況 |
|---|---|---|---|
| Phase 1 | completed | completed | docs/42 §2・§5.1に完了根拠 |
| Phase 2 | completed | active（移管未反映） | docs/42 §3.1は2026-11-18完了。計画書のcompleted移管はライフサイクル整合の残件 |
| Phase 2.5 | planned | planned | 最大320×320タイル。羽田相当レイアウト全体受入前に実装・性能検証 |
| Phase 3 | completed | planned（移管未反映） | docs/42 §3.2は2026-11-18完了。計画書のcompleted移管はライフサイクル整合の残件 |
| Phase 4 | 実装完了・一部受入計測未検証 | planned（監査継続） | docs/42 §3.3。4-03/4-10等の未検証条件を解消するまでcompletedへ移さない |
| Phase 5 | backlog / 個別計画あり | planned | 5-13〜5-25を依存関係に従って個別実施 |

docs/42がフェーズの実装状況の正本、各計画書の状態とフォルダ配置は実装計画のライフサイクルを表します。過去の計画書配置が現在の実装状況と一致していない箇所は、受入記録を確認してから移管し、フォルダ名だけで実装済み/未実装を判断しません。

## フェーズ内の個別実装計画

フェーズ全体の計画と独立して着手できる要求は、個別の計画書で管理します。

| 要求 | 状態 | 正本の計画書 | 備考 |
|---|---|---|---|
| Phase 5 / 5-13 旅客動線の3段階接続判定 | planned | [passenger_connectivity_status_plan.md](planned/passenger_connectivity_status_plan.md) | 接続グラフ全体を通行可能/建設完了待ち/未接続に分類。5-16と統合 |
| Phase 5 / 5-14 ターミナル階層・駅/バスターミナル | planned | [terminal_building_structure_plan.md](planned/terminal_building_structure_plan.md) | B3〜4F、駅/バスターミナル独立・内包 |
| Phase 5 / 5-15 複雑形状・ターミナル複合体 | planned | [terminal_complex_geometry_plan.md](planned/terminal_complex_geometry_plan.md) | 凹形ポリゴンと複合体判定。旅客の実経路とは分離 |
| Phase 5 / 5-16 対外交通・階層歩行網とPaxGroup統合 | planned | [passenger_network_unification_plan.md](planned/passenger_network_unification_plan.md) | 車・送迎・タクシー・バス・鉄道・徒歩からPortal/ターミナル/各ゲートまでの双方向経路 |
| Phase 5 / 5-17 誘導路実幅・高速離脱 | planned | [taxiway_realism_plan.md](planned/taxiway_realism_plan.md) | FAA TDG/EASA OMGWSのprofileを混同しない |
| Phase 5 / 5-18 ターミナル専用設計Workspace | planned | [terminal_design_workspace_plan.md](planned/terminal_design_workspace_plan.md) | フロア・内部設備・メッシュ能力、対外交通の接続マトリクス/経路ハイライト |
| Phase 5 / 5-19 空港全体1日運航・ターミナル単独詳細Simulation | planned | [terminal_simulation_modes_plan.md](planned/terminal_simulation_modes_plan.md) | 2モードのclock/state分離、対外交通6手段、全方向の旅客動線/容量検証 |
| Phase 5 / 5-20 空港格の8段階化・成長判定の多軸化 | planned | [airport_tier_progression_plan.md](planned/airport_tier_progression_plan.md) | 既存格解放・契約提案・旧セーブ互換を含めて段階的に拡張 |
| Phase 5 / 5-21 最混雑時間帯・ターミナル別工程能力 | planned | [peak_hour_passenger_capacity_plan.md](planned/peak_hour_passenger_capacity_plan.md) | ローリング60分・工程別の能力/需要/実績。共有アクセス・ランプバスの能力を重複計上しない |
| Phase 5 / 5-22 共通シナリオ管理・運航モード横断比較 | planned | [scenario_comparison_plan.md](planned/scenario_comparison_plan.md) | Phase 8の既存比較を再利用し、Airport Day / Terminal Detailを同じ入力条件から比較 |
| Phase 5 / 5-23 旅客Door-to-Door KPI | planned | [passenger_door_to_door_kpi_plan.md](planned/passenger_door_to_door_kpi_plan.md) | 外部〜ゲート/外部退出・乗継の全所要時間、p50/p95、搭乗締切到達、Step-free |
| Phase 5 / 5-24 都市上空回避型・方向別夜間運用 | planned | [urban_night_runway_operations_plan.md](planned/urban_night_runway_operations_plan.md) | 都市保護区域と到着/出発経路回廊を検証し、適合方向のみ夜間許可 |
| Phase 5 / 5-25 夜間整備・工事Work Order | planned | [nighttime_work_order_plan.md](planned/nighttime_work_order_plan.md) | 既存機体周期整備と統合し、夜間シフト・資源・資産閉鎖・工事進捗を管理 |


| Overnight carry-over departure readiness | planned | [overnight_departure_readiness_fix_plan.md](planned/overnight_departure_readiness_fix_plan.md) | skip された地上作業と固定タスク数の不整合。修正・翌朝便の離陸検証は未実施 |

## 基盤完成後に再検討する個別計画

以下は計画書を作成済みだが、Phase 5 の依存基盤が受入完了するまで実装着手を保留する項目。planned は「計画が整理済み」を表し、実装開始の承認・優先順位確定を意味しない。詳細な着手条件・受入条件は各計画書と docs/42 §3.8 を正とする。

| ID / 既存要求 | 状態 | 正本の計画書 | 着手条件 |
|---|---|---|---|
| A6 / Phase 5 5-12 貨物輸送 | planned（基盤ゲート待ち） | [cargo_operations_plan.md](planned/cargo_operations_plan.md) | 5-14〜5-16、5-21 |
| D4 空港ブランド効果 | planned（基盤ゲート待ち） | [airport_brand_effects_plan.md](planned/airport_brand_effects_plan.md) | 5-04・5-21、指標/効果幅のPO承認 |
| K1 自動最適化 | planned（基盤ゲート待ち） | [automatic_optimization_plan.md](planned/automatic_optimization_plan.md) | 5-19・5-21・5-22 |
| F3 風向による滑走路方向選択 | planned（基盤ゲート待ち） | [wind_runway_direction_plan.md](planned/wind_runway_direction_plan.md) | 5-24、予約/占有の設計レビュー |
| F4 除雪・防除氷 | planned（基盤ゲート待ち） | [snow_removal_deicing_plan.md](planned/snow_removal_deicing_plan.md) | 5-17・5-21・5-25 |

A6 は既存の5-12を詳細化した計画であり、別要求ではありません。基盤ゲートを満たしただけでは着手せず、HANDOFF更新・計画書のactive移管・POによる実装順序確認を行います。

## ディレクトリの意味

- `planned/`: 要求・受入条件・設計が整理され、実装に未着手の計画。
- `active/`: 実装開始済み。中断中・一部タスク完了でも、フェーズ全体が未完了ならここに置く。
- `completed/`: 計画範囲と受入条件を満たし、必要な品質ゲート・互換性確認が完了した計画。

## 標準フロー

1. **調査**: 関連する仕様・コード・テスト・既存計画を必要な範囲で確認し、実装済み／部分実装／未実装／不具合／テスト不足を区別する。
2. **計画**: 既存計画があれば更新し、なければ [TEMPLATE.md](TEMPLATE.md) から作成する。要求 ID・受入条件、非目標、依存関係、保存互換性、テスト、更新対象の機能仕様書を明記する。
3. **開始**: HANDOFF を先に進行中へ更新し、計画書を `planned/` から `active/` へ移してからコーディングを開始する。
4. **実装**: 計画書のタスクと検証結果を更新する。計画外の追加実装・受入条件の変更は PO の判断を得て、計画書を先に更新する。
5. **完了**: CLAUDE.md の品質ゲートを通し、機能仕様・docs/42・必要な docs/10・README・リンク・HANDOFF を更新する。未実行・失敗・未検証は明記し、合格扱いにしない。
6. **移管**: 全範囲の完了後に計画書を `active/` から `completed/` へ移す。コピーして二重管理しない。部分完了や中断では `active/` に残す。

## 計画書に記録する項目

- 根拠となる要求・仕様・監査指摘と PO 承認の有無
- 現状調査（実装済み／不足／不具合／未実装）と変更の目的・非目標
- 設計方針、変更するデータ・コードの範囲、依存関係・担当分担
- タスクごとの完了条件、対象テスト、受入基準
- 保存形式・旧データ・シミュレーション結果・ゴールデンへの影響
- 更新する機能仕様書・関連文書
- 実装中の進捗、計画との差分、変更理由、テスト結果、未完了事項
- 完了時の品質ゲート・互換性検証・残件

## 運用上の注意

- 仕様書は「現在の実装仕様」、計画書は「実装の進め方と作業記録」です。計画書の提案内容を、実装前に現行仕様へ転記しないでください。
- 小さな単一箇所の修正など、CLAUDE.md が認める例外では計画書を省略できます。複数ファイル・データ・シミュレーション変更を無計画で始めないでください。
- 旧パス `docs/design/impl_phaseN_plan.md` は参照互換用の案内ファイルです。計画の編集は本ディレクトリ内の正本に対して行います。
