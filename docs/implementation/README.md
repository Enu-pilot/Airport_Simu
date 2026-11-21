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

## フェーズ全体の実装状況（2026-11-20、正本: docs/42）

| フェーズ | 実装状況 | 詳細計画書の配置 | 状況 |
|---|---|---|---|
| Phase 1 | completed | completed | [phase1_plan.md](completed/phase1_plan.md)。docs/42 §2・§5.1に完了根拠 |
| Phase 2 | completed | completed | [phase2_plan.md](completed/phase2_plan.md)。docs/42 §3.1・§5.2の完了記録と実測を参照 |
| Phase 2.5 | planned | planned | [phase2_5_map_expansion_plan.md](planned/phase2_5_map_expansion_plan.md)。最大320×320タイル。羽田相当レイアウト全体受入前に実装・性能検証 |
| Phase 3 | completed | completed | [phase3_plan.md](completed/phase3_plan.md)。docs/42 §3.2の実装・検証記録を参照 |
| Phase 4 | 実装完了・受入計測完了 | active（受入検証継続） | [phase4_plan.md](active/phase4_plan.md)。§8計測（MCT大規模・区間解析・2ターミナル波・朝の波 block）は2026-11-18深夜に完了（docs/44 §6/§8）。区間解析のみ高速機での再確認が望ましい。completed移管は受入記録の確認後 |
| Phase 5 | 個別計画ごとに実施中 | active（5-13〜5-18・5-20〜5-21・5-23〜5-24）／ planned（5-19・5-22・5-25） | 計画書が存在する要求はすべて下表にリンク。状態・タスク進捗は各正本を参照 |
| Phase 6 | active（P0を中心にP1/P2/P3の一部タスクも実施） | planned | [phase6_airport_facility_expansion_plan.md](planned/phase6_airport_facility_expansion_plan.md)。Phase 5の既存基盤・個別計画を再利用し、P0能力基盤→P1貨物→P2ターミナル→P3夜間→P4空港基盤の順に統合拡張。F6-00監査、F6-01能力契約、F6-02/03/04一部、F6-06/07一部、F6-09/11一部、F6-12完了。F6-17（都市間OD/乗継需要モデル）を横断計画として追加・未着手。詳細な状態はPhase 6計画を正本とする |

docs/42がフェーズの実装状況の正本、各計画書の状態とフォルダ配置は実装計画のライフサイクルを表します。過去の計画書配置が現在の実装状況と一致していない箇所は、受入記録を確認してから移管し、フォルダ名だけで実装済み/未実装を判断しません。

Phase 6 は親計画です。5-18 / 5-19 / 5-20 / 5-21 / 5-25 と A6（Phase 5 5-12）の詳細は各既存計画書を正本として維持し、Phase 6計画へコピーしません。特にA6はactiveのまま継続し、Phase 6への登録を理由に状態・ID・着手ゲートを変更しません。

施設・構造物・設備・車両・インフラを追加/変更する際の共通基準は [docs/45 施設・構造物のライフサイクル実装標準](../45_facility_lifecycle_standard.md) とします。各個別計画では10段階の適用要否、既存機能の再利用箇所、未実装・未検証の段階を明記します。

## フェーズ内の個別実装計画

フェーズ全体の計画と独立して着手できる要求は、個別の計画書で管理します。

| 要求 | 状態 | 正本の計画書 | 備考 |
|---|---|---|---|
| Phase 5 / 5-13 旅客動線の3段階接続判定 | active | [passenger_connectivity_status_plan.md](active/passenger_connectivity_status_plan.md) | 接続グラフ全体を通行可能/建設完了待ち/未接続に分類。5-16と統合。T2・T4 実施済み、T5・T6 は残件 |
| Phase 5 / 5-14 ターミナル階層・駅/バスターミナル | active | [terminal_building_structure_plan.md](active/terminal_building_structure_plan.md) | B3〜4F、駅/バスターミナル独立・内包。T1〜T5 実施済み、T6・T7 は一部（内包施設の能力接続は 5-16 側の残件） |
| Phase 5 / 5-15 複雑形状・ターミナル複合体 | active | [terminal_complex_geometry_plan.md](active/terminal_complex_geometry_plan.md) | 直交footprint/複合体判定に加え汎用Curve/Arc演算基盤は既存だが、Facility.footprintへの曲線統合は未実装。2D本体描画はポリゴン対応、選択輪郭/3D/E2Eは残件。T3・T5・T8は未完了 |
| Phase 5 / 5-16 対外交通・階層歩行網とPaxGroup統合 | active | [passenger_network_unification_plan.md](active/passenger_network_unification_plan.md) | TerminalModel/Dijkstra/Portal/Step-free/上下接続と単一Portal区間のaccessWalkは既存。T4は検証接続済みだが診断表示残り、T6の複合経路進行・能力予約/待機・Step-free再探索は未完了。T7は全5施設種の往復検証済みだがゲート別/E2E残り |
| Phase 5 / 5-17 誘導路実幅・高速離脱 | active | [taxiway_realism_plan.md](active/taxiway_realism_plan.md) | FAA TDG/EASA OMGWSのprofileを混同しない。T1・T3 基盤と T4・T5 の純幾何（フィレット/主脚オフトラック/RET経路/停止距離）を実施済み。T2・検証/UI接続・T6・T7 は残件 |
| Phase 5 / 5-18 ターミナル専用設計Workspace | active（接続マトリクスの核＋専用Workspaceの核を実装済み） | [terminal_design_workspace_plan.md](active/terminal_design_workspace_plan.md) | 個別施設をID単位で配置/編集する。詳細運営は店舗単位、空港運営はカテゴリ集約する案を5-19に記録。専用Workspaceの核は2026-11-20にPR #64でマージ済み（導線・フロア切替・集計）。断面/void、曲線UI、統合カタログ等は未完了 |
| Phase 5 / 5-19 空港全体1日運航・ターミナル単独詳細Simulation | planned | [terminal_simulation_modes_plan.md](planned/terminal_simulation_modes_plan.md) | 提案粒度: 詳細モードは個別店舗IDへの立寄り/待ち/売上、空港運営モードはカテゴリ×ターミナル/区域の集約計算。店舗数×旅客需要を段階増加させ、速度/メモリ/KPI正確性から対応規模と最適化方針を決める |
| Phase 5 / 5-20 空港格の8段階化・成長判定の多軸化 | active | [airport_tier_progression_plan.md](active/airport_tier_progression_plan.md) | 既存格解放・契約提案・旧セーブ互換を含めて段階的に拡張。T2・T3・T5・T7 実施済み、T6・T8 は残件。planned/ に旧版コピーが残存（正本は active） |
| Phase 5 / 5-21 最混雑時間帯・ターミナル別工程能力 | active（核実装済み・計画書はplanned配置のまま） | [peak_hour_passenger_capacity_plan.md](planned/peak_hour_passenger_capacity_plan.md) | 6工程の時刻バケット集計、processPeak/processPeakByTerminal、DayReviewのターミナル別表示まで実装。ローリング60分、アクセス/ランプバス/トイレ工程、根拠のある需要のターミナル別配分は残件 |
| Phase 5 / 5-22 共通シナリオ管理・運航モード横断比較 | planned | [scenario_comparison_plan.md](planned/scenario_comparison_plan.md) | Phase 8の既存比較を再利用し、Airport Day / Terminal Detailを同じ入力条件から比較。2026-11-18深夜に設計検討を計画書へ追記（5-19が前提） |
| Phase 5 / 5-23 旅客Door-to-Door KPI | active（核実装済み・計画書はplanned配置のまま） | [passenger_door_to_door_kpi_plan.md](planned/passenger_door_to_door_kpi_plan.md) | 入口→搭乗/降機→退出/ゲート間の p50/p95 と Step-free 完了率を日報とDayReviewに表示する核を実装（2026-11-18深夜）。工程別内訳・外部境界からの計測は残件 |
| Phase 5 / 5-24 都市上空回避型・方向別夜間運用 | active（判定の核を実装・計画書はplanned配置のまま） | [urban_night_runway_operations_plan.md](planned/urban_night_runway_operations_plan.md) | 保護区域（方位範囲）と滑走路端ごとの方向別夜間許可の判定を実装（2026-11-18深夜）。全面カーフューが既定で、運航計画への適用はPO判断待ち |
| Phase 5 / 5-25 夜間整備・工事Work Order | planned | [nighttime_work_order_plan.md](planned/nighttime_work_order_plan.md) | 既存機体周期整備と統合し、夜間シフト・資源・資産閉鎖・工事進捗を管理。2026-11-18深夜に設計検討を計画書へ追記 |


| Overnight carry-over departure readiness | completed | [overnight_departure_readiness_fix_plan.md](completed/overnight_departure_readiness_fix_plan.md) | skip された地上作業と固定タスク数の不整合。修正・通しテストによる翌朝便の離陸検証まで実施済み |
| 2026-TK 離陸滑走の入口位置ベース制限（2段構え） | active（第1段） | [takeoff_entry_restriction_plan.md](active/takeoff_entry_restriction_plan.md) | 第1段は診断のみ（検証に2コード追加、挙動変更なし）。第2段（候補ゼロ時のフォールバック・ATC側）は未着手で計画書 §10 に設計下書き |

## 2026-11-20 PO 追加要望バッチの個別計画（docs/42 §3.11）

| 要求 | 状態 | 正本の計画書 | 備考 |
|---|---|---|---|
| 2026-A〜C ターミナル隣接・使用ターミナル容量表示・スポット寸法 | 完了（PR #63 マージ済み） | 計画書は作成せず、確定仕様は docs/35・37・03・21 へ直接反映 | `SIM_MODEL_VERSION` 10.9 |
| 2026-E 住民満足度施策 | active（PR #68 マージ待ち） | [resident_satisfaction_measures_plan.md](active/resident_satisfaction_measures_plan.md) | 防音工事・夜間割増・NoiseCard＋海上移転係数・住民向け施設・騒音対策費。10.10 |
| 2026-F 架空会社の制限と持ち替え | active（PR #67 マージ済み、仕様反映のみ残件） | [fictional_airline_restriction_plan.md](active/fictional_airline_restriction_plan.md) | 提案生成への制限と契約パネルでの付け替え。版上げなし |
| 2026-G〜J 地下ターミナル・PBB・AGT・階層統一 | planned（詳細設計完了・PO 承認済み） | [underground_terminal_pbb_agt_plan.md](planned/underground_terminal_pbb_agt_plan.md) | 5-18 の後段。推奨順 J-1 → G → H → J-2 → I。H に PBB 本数と既存ゲート置き換えの変更要望あり |
| 2026-G 追随 ターミナル階範囲のプルダウン一本化 | active（実装済み・PR 化待ち） | [terminal_floor_span_unification_plan.md](active/terminal_floor_span_unification_plan.md) | パネルで建物の絶対階範囲（最下階・最上階）から基底階・階数を導出し、地下だけの建物をパネルから作れるようにする。エリア範囲の絞り込みは詳細設定として残置。版上げなし |
| 2026-PERF 性能改善 | active（第1・2弾は PR #65 マージ済み、第3弾は実装完了・PR 化指示済み） | [performance_improvement_plan.md](active/performance_improvement_plan.md) | 計測→地図なし→結果不変の削減。簡略モードは保留 |
| 2026-QT 鉄道の複々線 | active（実装完了・未push） | [rail_quadruple_track_plan.md](active/rail_quadruple_track_plan.md) | 線路辺 tracks = 4 を追加し、区間モデルの既定能力を 24 本/時に。集約モデル・既存レイアウト・保存形式・SIM 版は不変 |
| 2026-CARGO 国内貨物航空会社の拡充 | active（実装完了・PR 化指示済み） | [domestic_cargo_airlines_plan.md](active/domestic_cargo_airlines_plan.md) | 5-12 貨物基盤の上のカタログ拡充。国内貨物専用機の対象はスプリング・ジャパンのみ |
| 2026-UI 日報・経営再編／2026-LV 階層同期／2026-FIDS 便名カラー | 完了（PR #61・#62・#66 マージ済み） | 計画書は作成せず、確定仕様は docs/36・37・34・06 へ直接反映 | — |

## 基盤完成後に再検討する個別計画

以下は計画書を作成済みだが、Phase 5 の依存基盤が受入完了するまで実装着手を保留する項目。planned は「計画が整理済み」を表し、実装開始の承認・優先順位確定を意味しない。詳細な着手条件・受入条件は各計画書と docs/42 §3.8 を正とする。

| ID / 既存要求 | 状態 | 正本の計画書 | 着手条件 |
|---|---|---|---|
| A6 / Phase 5 5-12 貨物輸送 | active（PO 指示で着手済み） | [cargo_operations_plan.md](active/cargo_operations_plan.md) | 5-14〜5-16、5-21（基盤ゲートに先行して随時実装中。CARGO-01〜08 の核まで実施、sim 実便化等が残件） |
| D4 空港ブランド効果 | planned（基盤ゲート待ち） | [airport_brand_effects_plan.md](planned/airport_brand_effects_plan.md) | 5-04・5-21、指標/効果幅のPO承認 |
| K1 自動最適化 | planned（基盤ゲート待ち） | [automatic_optimization_plan.md](planned/automatic_optimization_plan.md) | 5-19・5-21・5-22 |
| F3 風向による滑走路方向選択 | planned（基盤ゲート待ち） | [wind_runway_direction_plan.md](planned/wind_runway_direction_plan.md) | 5-24、予約/占有の設計レビュー |
| F4 除雪・防除氷 | planned（基盤ゲート待ち） | [snow_removal_deicing_plan.md](planned/snow_removal_deicing_plan.md) | 5-17・5-21・5-25 |

A6 は既存の5-12を詳細化した計画であり、別要求ではありません。A6（貨物）は 2026-11-18 の PO 指示により基盤ゲートに先行して着手し、計画書は active/ へ移管済みです。その他の項目は、基盤ゲートを満たしただけでは着手せず、HANDOFF更新・計画書のactive移管・POによる実装順序確認を行います。

## フェーズ外の独立ゲームモード計画

フェーズ5の空港経営・旅客/ターミナル関連要求とは別のゲームモードとして管理する。2026-11-18にPO指示で実装開始済み（基盤まで）。

| ID | 状態 | 正本の計画書 | 位置づけ・着手条件 |
|---|---|---|---|
| ATC / 管制官モード | active（2026-11-18 PO指示で開始。基盤まで実装済み） | [air_traffic_control_mode_plan.md](active/air_traffic_control_mode_plan.md) | 空港経営モードから独立したGROUND/TOWER両方必須の管制ゲーム。シナリオからスポット割当・着陸/離陸RWY・必要な横断要求を自動生成し、管制官が候補確認・承認・許可を行う。ATC専用の状態・時計・シナリオ・保存形式を持ち、空港レイアウトは静的スナップショットとしてのみ共有。POの実装開始指示後にactiveへ移す |

ATCはPhase 5の5-19（空港全体/ターミナル詳細の旅客シミュレーション）とは別機能であり、両者の時計・シナリオ・データモデルを統合しない。共有するのは静的レイアウト・機種カタログ・検証済みの物理/経路ロジックに限る。詳細な独立境界・依存禁止・テスト条件はATC計画書を正本とする。

## ディレクトリの意味

- `planned/`: 要求・受入条件・設計が整理され、実装に未着手の計画。
- `active/`: 実装開始済み。中断中・一部タスク完了でも、フェーズ全体が未完了ならここに置く。
- `completed/`: 計画範囲と受入条件を満たし、必要な品質ゲート・互換性確認が完了した計画。

## 標準フロー

1. **調査**: 関連する仕様・コード・テスト・既存計画を必要な範囲で確認し、実装済み／部分実装／未実装／不具合／テスト不足を区別する。
2. **計画**: 既存計画があれば更新し、なければ `TEMPLATE.md` から作成する（本作業コピーには未配置）。要求 ID・受入条件、非目標、依存関係、保存互換性、テスト、更新対象の機能仕様書を明記する。
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
