# HANDOFF_PROMPT — Airport_Simu

> 目的: Claude の再開時に必要な作業状態だけを渡す。仕様本文・長文日誌は複製しない。
> 上限: 本ファイル全体 1,200 tokens 目安。

## 再開時の指示
1. CLAUDE.md と docs/implementation/README.md を読み、標準開発ルールと計画の正本を確認する。
2. git status -sb、git diff --stat、git diff --name-only、git log -3 --oneline を確認し、未コミット変更を保護する。
3. 実装計画の開始・中断・完了に合わせて、本ファイルと該当計画書を更新する。
4. 計画外の変更、受入条件の変更、保存/シミュレーション版の変更はPO判断を得る。

## 現在の作業
- 2026-11-23 性能改善 第8弾＋E2E 追随＋lint（**完了**・push 済み、PR 未作成）: 実セーブ mainplay1 で tick 日中 −22%・深夜 −46%、最終状態ハッシュ不変（性能改善計画 §3.7）。lint 0、unit 新規失敗 0（38 は main 既存）、E2E は UI 再編へ追随（docs/39 §14）。新規不具合: 実規模の運航中セーブが P6 で読み込めない（docs/10 R-07）、1400px で詳細パネル 12px はみ出し。操作性の改善案は planned/ui_usability_improvement_plan.md（PO 判断待ち）。
- 2026-11-23 総合テスト（**完了**、PO 依頼）: 結果は docs/39 §13。新規 E2E tests/e2e/featureReach.spec.ts 7/7 合格。main 既存の失敗: lint 15・unit 44（ENOENT 7 ファイル・タイムアウト・ゴールデン・paxConservation 等）・E2E 53/114（UI 再編への未追随が主）。600 倍速は 500 往復規模で維持不可（地図 ×420/3.3fps、無描画のみ ×618）。空港能力タブのレイアウト崩れを確認。修正は未着手（PO 判断待ち）。
- 2026-11-22 就航都市の地域順表示（2026-REGION、docs/42 §3.11、実装完了・未push）: 表示専用の地域区分（国内11地方＋海外11地域）を src/core/data/destinationRegions.ts に新設し、就航先セレクト（CapacityPanel）・就航範囲表示（AirlineScoreTable）・路線の需要と供給表（ManagementPanels）の並びを地域順へ統一した。地域内は destinations.ts の登録順を維持。既存 regionId・保存形式・SIM_MODEL_VERSION は不変、ゴールデン 26/30（失敗4件は既存の幾何不一致）。新規テスト 7/7・関連 98/100（失敗2件は shellPhase7b の既存失敗）・typecheck・build・変更ファイル lint 合格。全スイート完走と E2E は未実施（VM 混雑／ブラウザ未導入）。計画は docs/implementation/active/destination_region_order_plan.md。push・PR は PO 指示待ち。
- 2026-11-21 鉄道の複々線（2026-QT、実装完了・未push）: 線路辺 tracks = 4 を追加し、区間モデルの既定能力を 24 本/時（複線の線形 2 倍）にした。対象テスト 13/13・関連 30/30・typecheck・build 合格、ゴールデンは main 既存の幾何 4 件を除き一致（新規不一致ゼロ）。全テスト完走のみ VM 混雑で未完了（失敗ファイルは変更前後で同一集合であることを A/B 比較で確認済み）。計画は docs/implementation/active/rail_quadruple_track_plan.md。集約モデル・既存レイアウト・保存形式・SIM_MODEL_VERSION は不変。push・PR は PO 指示待ち。
- 2026-11-21 離陸入口制限（2026-TK、docs/42 §3.11）: 第 1 段（診断のみ）を作業コピーで実装済み・PR 化待ち。経営 sim の入口候補の絞り込み（残り距離 ≥ 離陸距離 + 100m）は実装済みだったため、第 1 段は本当に困る構成の可視化に絞り、検証に 2 コード（RUNWAY_ENTRY_ALL_SHORT / STAND_NO_DEPARTURE_ENTRY、docs/26 §3c）を追加。挙動変更なし・SIM_MODEL_VERSION 不変。ゴールデンは main の時点で失敗している分と同一で新規の不一致なし（ゴールデン自体の陳腐化は範囲外）。第 2 段（候補ゼロ時のフォールバック方針と ATC 側）は未着手で、論点は docs/10 R-06 と計画書 §10。
- 2026-11-21 性能改善 第5弾「無描画運行モード」（**完了**・未push）: opsPrefs.noRender（表示モード3択: 地図／地図なし／無描画、noRender 優先）、simRunner の公開間引き（約1秒間隔＋日次締め・dropped の即時公開、clock 端数は pendingClock 保持で結果中立）、OperateLayout の最小ステータス表示（HeadlessStatus 新規）。正本は performance_improvement_plan.md §3.5・§6。検証: tsc・ビルド・変更ファイル ESLint・ゴールデン 30/30 不変・新規テスト 12 件（公開 1,800→29 回／1,800 フレーム、状態 JSON が通常モードと完全一致）・関連テスト通過。全テストスイートは VM 競合下で2回とも環境側で途中終了（出力範囲に失敗なし。ログ: ~/workspace/airport_simu_work/headless-fulltest.log・headless-fulltest2.log）。Playwright はブラウザ未導入のため未検証。SIM_MODEL_VERSION・保存形式は不変更。
- 2026-11-20 PO 追加要望バッチ（docs/42 §3.11 が一覧の正本）: A 隣接自動接続・B 使用ターミナル容量表示・C スポット寸法見直しは PR #63 でマージ済み（SIM_MODEL_VERSION 10.9）。D ターミナル設計 Workspace の核は PR #64 でマージ済み（5-18 計画に進捗記録）。UI 再編 PR #61・階層表示統一 PR #62・FIDS 便名カラー PR #66・性能改善第1/2弾（計測＋地図なし）PR #65 はいずれもマージ済み。F 架空会社の制限＋持ち替えは PR #67 でマージ済み（残件は docs/13・14 への仕様反映）。E 住民満足度施策（防音・夜間割増・NoiseCard＋海上移転係数・住民向け施設・騒音対策費、10.10）は PR #68 作成済み・マージ待ち。性能改善第3弾は実装完了（作業コピー、tick 約 −37%・ゴールデン不変、PR 化は PO 指示済み）。貨物航空会社の拡充は実装完了（作業コピー。国内貨物専用機の対象はスプリング・ジャパンのみと確定、PR 化はゴールデン 3 件の再採取込みで PO 指示済み）。G〜J（地下・PBB・AGT・階層統一）は詳細設計完了・PO 承認済み（H に PBB 本数 1/2 と既存ゲートの全置き換えの変更要望あり）。乗客生成の見直しは要望受付のみ。
- 2026-11-20 Docs 反映（PR 作成中）: 当日の作業・機能・計画を docs へ反映する変更一式（17 ファイル）を PR として提出する。内容は docs/42 §3.11・§5.3、機能別仕様（03・06・34・35・36・37）、計画書 4 件の新規作成（E・F・G〜J・国内貨物）と既存 2 件の更新（5-18・性能）、docs/10 §R、索引 2 件。F の確定仕様（docs/13・14）と E の確定仕様（docs/31）への反映は別途残件。
- 2026-11-19 国内航空需要モデル（Docs完了）: docs/46_domestic_air_demand_model.md に国内83都市の利用圏人口・航空依存度（鉄道競合を統合）・必須/観光需要指数・8季節プロファイル・新千歳代理指標とA/B/C流用根拠を追加し、docs/README.md に索引。コード/保存形式/SIM_MODEL_VERSIONは不変更。Docsリンク・83件・必須項目を確認、コードテストはDocsのみのため未実行。
- 2026-11-19 粒度分離バックエンド（**マージ済み**: PR #48。続く PO 決定バッチも PR #51 でマージ済み）: 5-19 T11〜T13。集約profile adapter（terminal/serviceProfile.ts、カテゴリ×ターミナル、根拠なし値は未算出 null、layout同一性でキャッシュ）、運営モード集約接続（sim/serviceAggregate.ts、CreateOptions.serviceGranularity で切替、売上は従来の onShopDone 経由）、詳細モード独立実行（terminal/serviceDetailSim.ts、findPaxRoute+経路キャッシュ、店舗別実績→aggregateServiceRecords で集約整合）。性能実測: 運営 aggregate は同一条件で約31%短縮、詳細は128店舗・約1,450人/hでも tick p95 0.14ms。PO 決定バッチ（PR #51）: 集約方式を既定化（1B、SIM_MODEL_VERSION 10.8）、ラウンジをエリア種別として新設（2A、形式8。運営モード接続は後続）、詳細結果の運営 profile 反映は作らない（3B）、5-16 T6 は UI 更新が落ち着くまで保留し次の基盤課題として残置（4B）、乗継 OD 集計を表示用データとして用意（5A、DailyReport.hubOd）。
- 状態: Phase 5の個別計画を進行中。正本一覧は docs/implementation/README.md、全体ロードマップは docs/42。
- 完了: Phase 1〜3。Phase 4は 2026-11-18 夜に §8 の未検証 4 件を全て計測し解消（docs/44 更新済み。区間解析だけこの VM で予算超過、高速機での再確認が望ましい）。
- Phase 5: 5-13〜5-17、5-20、貨物（5-12）は実装の核まで進行。Phase 6 相当（5-18〜5-25）は 2026-11-18 夜に着手: 5-21・5-23・5-18 の核と 5-24 の判定核を実装、5-19・5-22・5-25 は計画書を作成し planned。貨物はPO指示で基盤ゲートに先行着手。
- 現行SIM_MODEL_VERSION: 10.9（main。10.9 = 隣接自動接続＋スポット寸法見直し。10.10 は PR #68 に含まれマージ待ち）。保存形式は最大 8（形式7 = 動く歩道/Work Order、形式8 = ラウンジ。docs/21 に記載）。航空会社カタログは 115 社・目的地 178 件（2026-11-20 の F 詳細設計で確定した実数）。版履歴・ゴールデンの扱いは docs/21・docs/42 §5。
- 2026-11-18夕方: プレイテスト由来の表示改善（処理能力・ピーク需要の表示、乗り遅れ内訳とボトルネック、航空会社の不満の具体化、次格要件の表示）、夜間滞泊のターンアラウンド不満の解消を実装。カタログ版は 2026.11.1（貨物専用機追加）。PR #34 として統合・マージ済み。
- 2026-11-18夜 PR #35（マージ済み）: 管制塔レベル表示ラベル修正。5-13 完了。CARGO-05 集約モデル。5-16 T8・T4 検証接続・T9 実測。5-15 T6 検証完了。
- 2026-11-18 深夜分は PR #36 でマージ済み（Phase 4 計測 + P6 バグ修正 2 件、5-21/5-23/5-18 の核、5-24 判定核、5-16 T7/T9、5-15 T7 2D、5-17 T4/T5、fingerprint 再基準化、ゴールデン監査分）。push 前に既定ブランチの Phase 6 親計画・正本計画書と突き合わせ、並行計画書は作らず進捗を正本へ統合した。
- 2026-11-19 Phase 6 続きは PR #37 で push 済み（F6-00〜07 + 5-21 ターミナル別内訳 + F6-03 実績列 + F6-11 夜間滞泊）。マージ待ち。
- 2026-11-19 動く歩道 + Work Order（PR #39 でマージ済み）: ターミナル内エリア種別 movingWalkway を通路の拡張として追加（実効速度 = 歩行 1.3 + ベルト 0.5 = 1.8 m/s、歩道の中心〜境界区間のみ。linkCostSec / linkWalkLengthM で経路と歩行を統一。movingWalkway 4/4、fingerprint 不変）。5-25 Work Order を実装（company.workOrders、夜間枠 23:00〜05:00 で実施し対象を一時閉鎖、管理 UI 付き。workOrders 7/7）。PO 承認で SIM_MODEL_VERSION 10.6→10.7 に版上げし、ゴールデン 9 件は版文字列のみの差分で再採取。保存形式 7 を新設（Work Order を使う会社・動く歩道レイアウト）。P4 供給インフラは PO 指示で保留。
- 2026-11-19 Phase 6 着手（PR #36・#37 でマージ済み）: 親計画 phase6_airport_facility_expansion_plan.md を正本に P0 から実施。F6-00 監査（算出源・単位・未算出の所在を計画書 §16 に記録）。F6-01 共通能力契約 src/core/capability.ts（理論/有効/需要/実績/単位/状態/未算出理由。adapter は既存計算を参照のみ。回帰 capabilityF6 6/6）。F6-02 PropertiesPanel に施設の能力節（状態/理論/有効/根拠）。F6-03/04 経営画面 CapacityPanel に共通能力ビューと要確認リスト（核）。F6-06 CARGO-05 区間モデル統合（segments に貨物目的地、segmentTraverse 単一消費点でトラック背景交通。cargoSegmentsF6 4/4）。F6-07 貨物格境界テスト追加（格2=ゼロ、格5〜7=国際継続。cargoTierGate 7/7）。格5〜7の規模拡張は定義値が未確定のため PO 判断待ち。5-20 T8 投資プレイは 25 日目でプロセス消失（再実行は PO 判断待ち）。
- 2026-11-19 passengers.ts 回帰の復旧（同バッチに含む）: PR #38 の push が PR #36 以前のコピーから行われたため、default の passengers.ts が PR #35 時点 + サテライト修正の状態に戻り、PR #36 の P6 修正 2 件・5-23 journeyStats 連携・PR #36/#37 の 5-21 工程記録が欠落していた（fingerprint が PR #34 時代の値に逆戻りして検出）。三方マージ（基準 = PR #35 ブランチ、 自分 = PR #39 ブランチ、相手 = 現在の default）で復元し、競合はコメント差分 1 件のみ。検証: satelliteComplex 6/6・processPeak521 4/4・ゴールデン 37/37・city core fingerprint が基準値 9b02c51c と完全一致。今後は stale コピーからの push で共有ファイルを巻き戻さないこと。
- 2026-11-19 PO 承認案 + docs/45 必須受入の着手（PR #40 でマージ済み）: 貨物格 5「取扱規模拡張」（大型貨物専用機 600 m³ 以上 = B747F/B777F 系の契約を格 5 で解放、格 4 以下は提案から除外。isLargeFreighter、締結済みは既得権。cargoTierGate に境界テスト）、F6-11 翌朝の出発可能機数（決済時に翌朝 06:00–10:00 の滞泊出発を予定/確定可能/リスクありで数え DailyReport.morningReadiness → DayReview 表示。morningReadiness 2/2）、F6-04 状態生成の第一弾（ポータル到達不能な交通施設は disconnected で有効能力 0・理論保持。capabilityF6 9/9）。Phase 6 計画に docs/45 の 10 段階適用表（§18）を記録。格 6（トラック時間帯配分）・格 7（積替貨物）は定義承認済みで後続。施設種別の格解放表は PO 判断待ち。
- ゴールデン監査（2026-11-18 深夜）: 全ゴールデンを回したところ bus-sim と legacy-remote-sim の 2 件が既定ブランチ時点から不一致だった。bus は PR #32 の理由分類変更（noStand 22 → 20 + standTooSmall 2、合計不変）の取りこぼしと特定し再採取。legacy-remote は KPI 完全一致・状態 209 バイト減のみで、PR #34 前の既定コードでも現行ハッシュになることを実走確認（PR #32/#33 のいずれかで紛れたもの。今夜の変更は戻し実験で原因でないことを確認）。再採取したが完全な特定は未実施で、テスト内コメントに記録済み（要 PO 確認）。
- ATC: 経営モードとは独立した計画。GROUND/TOWER両方必須、要求はシナリオから自動生成。基盤と ATC-06/07 は既定ブランチへ統合済み（PR #29・#42）。残件は ATC 担当へ引き継ぎ: ATC-04（物理移動カーネルの抽出、未着手）、ATC-11（E2E・性能計測・ブラウザ実機での目視確認、未実施）。本バックエンドバッチでは ATC には触れない。

## 次の作業
- 2026-11-19 性能粒度の分離案（完了）: 5-18/5-19へ、詳細モードの店舗単位利用と空港運営モードのカテゴリ集約、施設個別データからの集約変換、段階負荷テスト/性能判断基準を追記。docs/42・索引も同期。Docsのみ・コードテスト未実行。
- 2026-11-19 Docs監査反映（完了）: 5-15/16/18/19/21 のコード監査結果を既存正本へ追記し、docs/42・実装計画索引を同期。Docsリンク/状態/差分を確認。コード変更・コードテストなし。
- 5-13: 完了。
- 5-14: 内包駅/busTerminalの接続後能力集計、地下/地上駅の接続検証、描画・Undo/Redo・E2E。
- 5-15: 作図/編集UI（T3）、物理/複合ID分離（T5）、3D描画の多角形対応とE2E（T7 残）。
- 5-16: T6（複合グラフ経路進行が主体。ポータル区間の能力・stepFree・閉鎖時再探索を含む）、T7 のゲート別網羅と E2E。
- 5-17: 機体実寸の出典データ（T2）、T4/T5 の検証・UI への接続、T6 運航接続（版判断が要る）。
- 5-20: 残は T8 の投資プレイ再計測（実行中）と Hard/Expert 検証。
- 5-21: 完了（2026-11-19 ローカル、未push）: ローリング 60 分窓（分バケット + rollingPeak60、日報に peakStartMin）、残り 3 工程（restroom / apronBus / access）の記録と日報行、ターミナル別内訳は前日分で完了済み。残: 需要のターミナル別配分（根拠未定のため空港全体のみ）。5-23: 完了（同）: 工程別の待ちパーセンタイル（doorToDoor.stepWaits）と外部境界（アクセス移動を含む）からの計測。5-24: planning への適用（版判断が要る）と都市設定 UI が残る。5-19/5-22/5-25: 計画書どおり後続で実装。
- 貨物: Tier6（トラック時間帯配分）・Tier7（積替貨物・翌日接続のみ）まで完了（2026-11-19 ローカル、未push。cargoTiers67 8/8）。CARGO-08 のテスト強化は cargoTierGate.test.ts 10/10 で実施済みだったことを確認。残: なし（貨物計画の実装分は完了。F6-13 供給インフラは PO 指示で保留中）。
- docs/46 国内需要モデル: コード反映完了（2026-11-19 ローカル、未push。§7.4 に反映記録・簡略化・実値検証）。K=1,263 は暫定値のまま。**要 PO 確認**: 需要水準が大きく変わるため SIM_MODEL_VERSION の版上げ要否（今回は変更なしで実装）。fingerprint の再基準化（下記）。
- fingerprint 再基準化（2026-11-20 実施、ユーザー承認済み）: 5-21/5-23 の日報内容変更（processPeak のローリング化 + peakStartMin + 新工程、doorToDoor の stepWaits + 外部境界計測）により、legacyFingerprint の会社データを含む 2 件（city core / sample airport）のみ基準値と不一致だったもの。再基準化時に JSON 全体差分で帰属を再証明（city core の差分 102 件・sample の差分 31 件すべてが reports の processPeak / processPeakByTerminal / doorToDoor 内で、SimState はバイト同一、運航結果は無変更）。新基準値: city core = 2353f4b9…、sample airport = c93e2ae8…。再基準化後に 7/7 通過を確認済み。
- 注意: 出発グループが他ターミナルを迂回する歩行は不変条件P6と衝突する（5-13計画書T5行に記録）。
- ATC（担当への引き継ぎ）: 既定ブランチ統合済み。次アクションは ATC-04（物理移動カーネルの抽出。可否は経営 sim 側の変更が落ち着いた時点で差分を見て判断）と ATC-11（E2E・性能・ブラウザ目視の統合検証）。
- UI（担当への引き継ぎ）: バックエンド済み・画面待ちの項目 — DailyReport.hubOd（乗継 OD 集計、PR #51）の表示、hubStats.byLink の表示（docs/44 §8）、ラウンジの配置 UI（エリア種別・能力契約・集約 profile は PR #51 で用意済み。Toolbox の内部エリア一覧への追加が起点）、F6-02 の配置/増設プレビュー差分表示、F6-03 の空港/ターミナル/分野の階層切替、5-15 T3 の作図/編集 UI、5-18 専用 Workspace 本体、5-16 T4 の flowDiagnostics 表示。2026-11-19 追加分: F6-04 の運航中状態（`capability.ts` の `operationalStateReadings(state, layout)` が closed/failed/resourceShortage を生成済み。CapacityPanel・要確認リストへの接続）、5-21 の新工程行（restroom/apronBus/access）と peakStartMin の DayReview 表示、5-23 の doorToDoor.stepWaits（工程別の「待ち時間」パーセンタイルと明示すること）の DayReview 表示、ラウンジの運営モード滞留（日報のサービス利用に lounge が出る。満足度係数は暫定値で PO 確定待ち）、貨物 Tier 7 の日報 transshipmentM3 表示、docs/46 の需要根拠表示（利用圏人口・航空依存度・ビジネス/レジャー指標・季節性の表示は従来ゼロ。閾値の多くは BALANCE 連動で自動追随するが、説明文中の倍率リテラルと凡例 40%/70% は UI 側の棚卸しが必要）。

## Docs更新記録（2026-11-18）
- 実装計画一覧を実ファイルに同期し、Phase 2/3をcompleted、Phase 4をactiveへ移管。planned側の古い重複は正本への案内ファイルに置換。
- docs/42・docs/10・docs/44・README・docs/designの旧パス案内を更新。詳細は docs/implementation/README.md と各正本を参照。

## Docs更新記録（2026-11-19）
- 5-15/16/18/19/21のコード監査結果を既存の正本計画へ追記。Curve/Arc汎用基盤とFacility footprint未統合、内部Area配置と専用Workspaceの差、Portal単一区間移動と複合グラフ全体経路の差、通常PaxGroup simと独立TerminalSimulationの差、時刻バケット工程ピークとローリング60分の差を明記。
- docs/42・docs/implementation/README.md の状態説明を同期。コード変更なし。リンク/記述整合を確認。コードテストはDocs-onlyのため未実行。

## Docs更新記録（2026-11-19、Simulation粒度案）
- 5-19を正本として、詳細運営は個別店舗IDへの立寄り/待ち/売上、AirportDayはカテゴリ×ターミナル/区域の集約とする案を追加。個別施設台帳は共通元データとし、店舗IDを失わずに集約変換する。
- 店舗数×旅客需要の段階負荷ベンチ、実時間/tick p50/p95/メモリ/経路探索回数/KPI保存則、最適化・対応規模の判断基準を追加。5-18/42/索引を相互参照。Docsのみ・コードテスト未実行。

## Docs更新記録（2026-11-20）
- 当日の PO 追加要望バッチ（A〜J・UI・階層・FIDS・性能・貨物・乗客生成）を docs/42 §3.11 に一覧化し、§5.3 に 10.9/10.10 の版記録を追加。マージ済みの確定仕様は docs/03・06・34・35・36・37 へ反映。
- 計画書を 4 件新規作成（E 住民施策・F 架空会社・国内貨物会社は active、G〜J 地下/PBB/AGT/階層は planned）し、5-18・性能改善の 2 件に進捗を追記。docs/10 に §R（式の構造的限界・既存テスト失敗・未決事項・Vercel 確認待ち）を追加。索引（docs/README・implementation/README）を同期。
- 本変更は PO の指示で PR として提出する（ブランチ `claude/docs-20261120-sync`）。コード変更なし、コードテスト未実行（Docs-only）。リンク・パス・記述整合は検証済み。

## 実装記録（2026-11-21、2026-CF 誘導路幅の F 区分）
- PO 指示で誘導路幅に F を独立区分として追加（作業コピー `fclass-work`、土台 main `11b552c7`、PR 化は PO 指示待ち）。`TaxiwayWidthClass = S/M/L/F` を新設し、旧「L ＋ codeF フラグ」を廃止。読み込み時に (L, codeF) → F へ版に依らず正規化（migrate の正規化段。project 側の移行呼び出しを常時化）。ネットワーク導出は (maxSize L, codeF true) で従来と完全一致するため SIM_MODEL_VERSION・SCHEMA_VERSION は据え置き、ゴールデン再採取なし。
- F キーは誘導路ツールで F 区分そのもの（スポット・滑走路では従来どおり最大の別名）。プロパティパネル／ツールボックスは4段階セレクト、誘導路のコード F チェックボックスは廃止（スポット側は存続）。F 幅の建設費は 10,000 cr/タイル（+2,000 の等差延長、PO 調整可）。スポット・滑走路・機体区分への波及は見送り（理由は計画書 §2）。
- 検証: 新規テスト 15 件・監査 a_network 18 件・関連既存テスト全通過、tsc・vite build・ESLint 通過。ゴールデンは幾何 4 件の既存不一致（pristine でも再現）を除き全通過。全スイートは本 VM の制約で完走できず、失敗は分離再実行で全件切り分け済み（本変更起因 0 件、詳細は計画書 §9）。
- 統合注意: 作業後に main へ PR #88・#89・#90 がマージ済み。PR 化前に最新 main と突合せ。並行作業「経路一括幅変更」が入る場合は、その幅パラメータの TaxiwayWidthClass 化が統合点（競合ファイル: operations.ts・input.ts・PropertiesPanel.tsx・docs/06）。
- 正本: docs/implementation/active/code_f_taxiway_width_plan.md、docs/42 §3.11（2026-CF 行）、docs/06 §4.1.1、docs/17、docs/27、docs/21、docs/03。
