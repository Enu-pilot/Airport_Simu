# H 監査: フェーズ 1（Track S / U）実装の読み取り監査

- 方法: 読み取りのみ。ファイル変更・テスト/ビルド/typecheck 実行・git 状態変更なし。
- 対象: HEAD a6e9bdd（docs のみの新コミット。src/tests は 06a393c と同一）。実装差分 `git diff 32f388d HEAD -- src tests`。
- 仕様: docs/design/impl_phase1_plan.md（1-01〜1-22、§3、§5）、docs/42 §2。
- 「未確認」= 読んでいない、または実行していないため判定できない。

## 1. 集計

- 1-01〜1-21（21 項目）: OK 17 / 逸脱 2（1-04, 1-09）/ オーナー判断 2（1-17, 1-18）/ 欠陥 0（個別の懸念は §5）
- 1-22（文書）: 未確認（docs 側は未読。a6e9bdd は docs のみ）
- 1-23（ゴールデン）: 未実施。確認済み: ゴールデン JSON 無変更、`SIM_MODEL_VERSION = 'skyport-sim-10.3'`（scenario.ts:21）無変更。
- 横断チェック: src/core → ui/editor/render/i18n の import なし。Math.random / Date.now なし。追加された Object.values 系は ids でソート済み（pick.ts は push 時に compareIds）。デバッグ残り（console/.only/.skip/TODO/FIXME）の追加なし（dayloop.spec.ts:157 の console.log は既存）。
- 保存: layoutUsesFormat2 と検証は terminalId を扱う。キーは値があるときだけ書く（null は operations.ts:1056 で delete）。版は上げていない。
- C0 の型（model/types.ts:176 Stand.terminalId、sim/types.ts:137 requestedStandId、terminal/model.ts:58、planning.ts:175、ja.ts:679）は既存。

## 2. 項目ごとの表

凡例: (a) 計画の変更が存在するか（ファイル・関数）。(b) 逸脱。(c) 回帰テストと旧再現の削除（known-issues / e2e-known は空、ディレクトリのみ残存）。

| 項目 | (a) 実装箇所 | (b) 逸脱 | (c) テスト・旧再現 | 判定 |
|---|---|---|---|---|
| 1-01 道路の既定能力 | tools.ts computePreview/computeOp（options.roadCapacityPerHour>0 のときだけ渡す）、input.ts finishPath | なし | u_roadDefaultCapacity.test.ts（3 種）、levels.spec V-1 | OK |
| 1-02 階層接続設備 | validate.ts roadJunction（約 L363-380）、judge の呼び出し（約 L393） | 判定の位置が COMPATIBLE の後（先頭ではない）。結果は同じ | u_connectorOverlap.test.ts（4）、v_connectorOverlap 削除 | OK |
| 1-03 選択 | pick.ts PickView / pickCandidatesAt / pickAt(view?)、input.ts selectAtWorld、store.ts pickCandidates、PropertiesPanel pick-candidates | なし | u_pick.test.ts（7）、levels.spec V-3/V-4 と 1-03 の 2 件、levels.repro 削除 | OK |
| 1-04 階の理由・階の変更 | levelRules.ts（新規）、tools.ts computeOp、input.ts commitPreview、ja PLACEMENT_PROBLEM_LABEL、Toolbox.tsx:126、PropertiesPanel prop-floorIndex、levelsInUse のトースト | Toolbox.tsx:144（ターミナル内部の階ボタン level-0〜2）に注記と title がない（計画は :134 に注記を要求） | u_levelRules.test.ts（8）、levels.spec V-5/V-6 と 1-04 の 2 件 | 逸脱 |
| 1-05 階層表示 | labels.ts（新規）、MapRenderer.ts 737 付近（ラベル絞り）・drawInterior（interior 表示時のみ、:113）、ja CONNECTOR_KIND_LABEL、displayName の road 分岐、Toolbox の FACILITY_LABEL | なし | u_labels.test.ts（5）、levels.spec の 1-05 の 2 件 | OK |
| 1-06 ツール箱 | styles.css:92 `.left > .toolbox:not(.ops)` | セレクタに :not(.ops) を追加（意図どおり。.left の overflow は未追加） | toolbox.spec.ts（3 サイズ）、toolbox.repro は改名 | OK |
| 1-07 バスゲート閉鎖 | apronBus.ts pinnedGateStillValid（約 L80）、applyBusDeparture（pinned は L110）、passengers.ts 227-228（付け直し条件）、stepGroup 防御（666-672） | 防御の発火条件が §3 の表に入っていない（後述 D5） | s_busGateReopen.test.ts（6）、b_busGateReopen 削除。b_multiTerminal:164 更新（e 参照） | OK |
| 1-08 滑走路閉鎖の重なり | disruptions.ts closeRunway（290-291）、reopenRunway は無変更（still チェックで保持） | なし（旧保存の固着は未修正。D7） | s_runwayOverlap.test.ts（5）、c_runwayOverlap 削除 | OK |
| 1-09 欠航の手荷物 | passengers.ts closeBoarding（reconcileDepartureBags は missGroups の後）、baggage.ts 196-205 | onCart の手荷物も leftBehind にする（計画は leftBehind/offloaded の終端のみ。D4） | s_bagsCancelled.test.ts（3）、b_bagsCancelled 削除 | 逸脱 |
| 1-10 2 ターミナルのゲート | terminal/model.ts 173-186（adjacent 配列、ambiguousTerminalIds）、validate.ts 1033-1036、ja ISSUE_TEXT（文言は計画と同一） | なし | u_gateTwoTerminals.test.ts（4）、s_gateTerminalModel.test.ts（3）、b_gateTwoTerminals 削除 | OK |
| 1-11 所属ターミナル・固定 | busGateAssignment.ts resolveBusGateForStand（88-127、表の 6 行すべて一致）、apronBus 固定、validate.ts STAND_TERMINAL_* ループ、operations.ts finalize（126）と updateEntity stand（1044-1056）、project.ts 44・266・355、PropertiesPanel prop-standTerminal（約 605）・prop-busGateId 絞り・stand-gate-fix-note | なし（決定表・検証 4 コード・文言は計画と一致を確認） | u_standTerminal.test.ts（13）、sim/standTerminal.test.ts（新規）、standTerminal.spec.ts（2）。docs は未確認 | OK |
| 1-12 夜間待機後のダイバート | simulation.ts setHold（231-241）、ダイバート判定 1106 は無変更 | なし。待機アラートの分数の検査はテスト名になし（ギャップ） | s_curfewDivert.test.ts（2）、d_curfewDivert 削除 | OK |
| 1-13 離陸の予測 | aircraftTypes.ts takeoffRollSec（130-141）、simulation.ts departureBlocked（763-766）。積分（1023-1024）と一致を確認 | accel≤0 のガードなし（元式は Math.max(0.1,…)。D9） | s_curfewTakeoff.test.ts（4）、d_curfewTakeoffEarly 削除。±1 tick は未確認 | OK |
| 1-14 スポット変更 | disruptions.ts reassignStand（341）、simulation.ts assignStand（ソート先頭 約 L611、割当後 delete 約 L642）、project.ts 354-355 | なし | s_reassignHome.test.ts（5）、e_reassignHome 削除。監査 e_hub の変更は HB-7 のもので 1-14 の影響は未確認 | OK |
| 1-15 計画の地上支援エラー | planning.ts groundBlockers（約 L256）、analyzeDayPlan（315-318）、ja PLAN_ISSUE_LABEL | なし | s_noGroundSupportPlan.test.ts（7）、e_noFuelFarmPlan 削除 | OK |
| 1-16 バス・鉄道の定員 | access/runtime.ts TRANSIT_LOOKAHEAD_H=24（146）、先読みと切替（198-212） | なし | s_transitOverbook.test.ts（6）、e_transitOverbook 削除。e_access:251 は未確認 | OK |
| 1-17 既存 E2E | gamemodels.spec.ts 57/95/100 を settingsAction へ。opslayout.spec.ts 131-133（承認済み）。dayloop.spec.ts 42-52（beforeAll・setTimeout・フィクスチャ共有） | dayloop は製品側の原因を直していない（simRunner.ts 未変更）。時間枠の拡大と同等の回避。計画は「待ち時間を延ばすだけの対応はしない」。opslayout の根本原因（trace）は未記録 | E2E のため該当なし | オーナー判断 |
| 1-18 economy.test.ts | economy.test.ts 366-367・397 の perDay（承認済み） | 計画の案 A（作業員を増やす）でなく需要（perDay）を増やした。承認の範囲内だが確認が必要 | 該当なし | オーナー判断（承認済み） |
| 1-19 能力ダッシュボード | capacity.ts overall・AS-4・AS-5（live）・AC-1・AC-2・HB-7、CapacityPanel live と capacity-overall / -limit、ja OVERALL_* | なし（overall の式は計画の文言どおり） | capacity.test.ts（新 describe 6）、capacity-nav.spec.ts（2）、e_access・e_hub を更新 | OK |
| 1-20 折り返し能力 | planning.ts turnaroundCapacity（約 L250-268）、groundUnitTotals | なし。GROUND_OVERLOAD の severity が 0 のとき error になる（planning.ts:416、計画どおりの帰結。D8） | capacity.test.ts（1-20）、e_turnaround・e_base を更新 | OK |
| 1-21 振り返り・罰則・不満 | review.ts weatherOfDay（383）と weather（472）、DayReview.tsx review-weather、company.ts 519 付近（flights>0 \|\| cancelled>0）、airlineEval.ts 158-167（low[k]=0 を 45 以上で実施） | なし（S-2 の再現の記録はなし） | s_reviewWeather（4）、s_cancelPenalty（5）、s_complaintStreak（5）。gamemodels の review-weather テストは弱い（D12） | OK |

## 3. (d) 既存の unit / e2e テストの expect 変更（変更行の全件）

- tests/unit/economy.test.ts:366-367 と 397 の perDay（6→10、4→8、4→6）。承認済み。expect 行は変更なし。
- tests/e2e/opslayout.spec.ts:131-133 は `alert-disruption:*` の 0 件に変更し、`alert-status` が「問題なし」を追加。承認済み。
- tests/e2e/gamemodels.spec.ts:57・95・100 は `getByTestId(...).click()` を `settingsAction(page, ...)` に変えただけ（ナビゲーションの helper のみ）。新規テスト（末尾）の追加は expect の変更ではない。
- tests/e2e/dayloop.spec.ts:42-52 は expect の変更なし（beforeAll 追加、test.setTimeout、フィクスチャのキャッシュ）。
- tests/unit/capacity.test.ts、tests/unit/project.test.ts、tests/e2e/capacity-nav.spec.ts は追加のみ。
- 上記以外に、既存の unit / e2e の expect 変更はなし。

## 4. (e) tests/audit の変更された assertion

| ファイル:行 | 変更 | 理由（コメント） | 計画項目との一致 |
|---|---|---|---|
| b_multiTerminal.audit.test.ts:164-184 | gateId 3 件・terminalId 集合・乗り遅れ理由（fac_11→fac_10、1 ターミナル、facilityClosed/late） | 「K-1・計画 1-11 で更新」 | 一致（計画の §4 に明記。:79 は未変更で、実行は未確認） |
| b_arrivalBaggage.audit.test.ts:45-46 | `count('leftBehind') - cancelledLeft` と bagsLeftBehind を比較 | 「計画 1-09 で更新」 | 一致（ただし計画の監査更新リストにはない。保存則の検査を弱めている。D11） |
| e_access.audit.test.ts:59, 66-68 | 追加行（空港アクセス合計、出入口・車寄せ等の行）を許容 | 「計画 1-19 AC-1/AC-2」 | 一致 |
| e_hub.audit.test.ts:129-131 | 能力値を terminalLinkCapacityPerHour に、basis の検査を追加 | 「計画 1-19 HB-7」 | 一致（計画は e_hub を 1-14 の監査としていたが、変更は HB-7。1-14 の影響は未確認） |
| e_base.audit.test.ts:147-149 | 整備士 0 で能力 0 | 「計画 1-20 TA-2」 | 一致 |
| e_turnaround.audit.test.ts:4, 76, 86, 105-124, 186-203 | 能力式、tug/整備士/燃料施設 0 で 0、ハイドラント 1 | 「計画 1-20」（理由は各 it に記録） | 一致 |
| tests/audit/e2e/levels.audit.spec.ts:51-55 | 「建物内配置」の確認を interior-children・prop-floorIndex の操作へ | 「1-03 / 1-04」 | 一致 |

## 5. 欠陥・懸念（重大度順。file:line は確認済みの行）

- D1（中・未確認）project.ts:355: requestedStandId の読み込み検証は「存在するスポット」を要求する。スポットを削除したときに機体の requestedStandId が消えるか（operations.ts の deleteEntity にその処理はない）は未確認。消えなければ、保存したファイルが読み込めなくなる。
- D2（中）tests/e2e/dayloop.spec.ts:42-52: 1-17 の計画は「製品側の競合を直す。待ち時間の延長だけはしない」。実装は fixture の計算を beforeAll に移し、hook の timeout を 120 秒にした。製品側の修正（simRunner.ts:87,143-170,296-305,387,118）はない。オーナーの承認が必要。
- D3（中）src/ui/Toolbox.tsx:144: 計画 1-04（Toolbox:134）は、親の階数を超える階に注記と title を要求。ターミナル内部の階ボタンには注記がない。逸脱。
- D4（中）src/core/sim/baggage.ts:196-199: 欠航の onCart の手荷物を leftBehind に終端する。計画は leftBehind・offloaded の終端のみ。搬送中（onCart）の手荷物を物理的な所在と合わせて扱うかは未確認。
- D5（中・未確認）src/core/sim/passengers.ts:666-672: stranded・noGate・!area・terminalId の防御は、閉鎖なしの運航でも発火し得る。§3 の表には入っていない。発火条件は未確認。
- D6（低）src/core/sim/apronBus.ts:110: pinned は、閉鎖なしでも（閉鎖から再開後の近いゲートなど）生成後の選び直しを止める。計画 §3 は「閉鎖・スポット変更」のみ記載。結果が変わるケースとして §3 に追記が必要。
- D7（低）src/core/sim/disruptions.ts:290-291: 旧保存で prev='closed' が二重に記録されている場合（修正前の保存）、移行は行わない。固着した閉鎖は残る。計画に移行の記載なし。
- D8（低）src/core/economy/planning.ts:416 と capacity.ts（previewContractCapacity の newErrors、約 L297・L324）: turnarounds=0 で GROUND_OVERLOAD が error になり、契約プレビューが unacceptable になる。計画どおりの帰結だが、影響範囲をオーナーに示す必要がある。
- D9（低）src/core/sim/aircraftTypes.ts:130-141: accel≤0 で 100000 tick（約 100000 秒）を返し、夜間の保留が続く。元式の Math.max(0.1,…) 相当のガードがない。カタログの全機種が正値かは未確認。
- D10（低）src/ui/operate/alerts.ts:52: GATE_TERMINAL_AMBIGUOUS を AIRSIDE_ISSUES に入れている（TERMINAL_ISSUES が妥当）。airsideRecommendation の既定文の内容は未確認。
- D11（低・オーナー判断）tests/audit/b_arrivalBaggage.audit.test.ts:45-46: 保存則の検査から欠航分を引いた。理由は 1-09 に一致するが、計画の監査更新リストになく、検査が弱くなる。
- D12（低）tests/e2e/gamemodels.spec.ts（末尾の review-weather テスト）: 天候の要素がなければ、障害の行数が 0 の場合にしか検査しない。両分岐とも検査が空振りし得る。
- D13（低）src/ui/PropertiesPanel.tsx（prop-floorIndex の select、prop-busGateId の絞り込み）: 現在値が選択肢にないとき（階数の減少、ターミナル変更後の旧ゲート）、select の表示が実際の値と違う。
- D14（低）src/editor/dayHistoryStore.ts:18 の DayReview は IndexedDB から検証なしで戻る。review.weather の不正値は ReviewBody（DayReview.tsx:207-214）で例外になり得る。project.ts の検査の対象外。
- D15（低・既存）src/core/terminal/model.ts:176: adjacent[0] を使うため、connectedTo が 2 番目に隣接するターミナルのとき connectIndependentGate になる。この diff で導入されたものではない（旧 .find と同じ）。
- D16（低）src/core/analytics/review.ts:384: weatherPlan に report.day を渡す。運航側は calendarDay(state)=floor(now/DAY_SEC)+dayOffset（weatherStep.ts:17）。一致は未確認。
- 計画どおりで欠陥ではないもの: 1-10 の文言・severity、1-11 の決定表、1-14 のソート順、1-13 の積分の一致、1-12 の判定（simulation.ts:1106）。

## 6. 検証できなかった項目（読み取りだけでは判定不可）

- 全テスト・typecheck・lint・build・E2E の結果（指示により未実行）。新規コードの型（ctx.hydrantStands、access.modes[m].facilities、reason=null の型）はコンパイルしていない。
- ゴールデン（bus-sim、crossing-sim、free-runways、game-models、game-weather、stress 系）: 1-07・1-08・1-09・1-21 で結果が変わり得る（計画 §3）。ゴールデン無変更のまま、テストが赤くなるかは未確認。1-23 は未実施。
- 監査テストの残り（b_multiTerminal:79、e_access:251、c_fuzz、e_hub の他の expect、s_*）が 1-14・1-09・1-21 で変わらないかは未確認。
- 1-13 の予測と実際の離陸時刻の ±1 tick の一致（テストは実行していない）。
- 1-07 の閉鎖中ゲートでの旅客の待機（passengers.ts の waitingFacility 経路の全体）は未読。
- 1-17 opslayout の残存アラートの根本原因、dayloop の不安定の原因（trace 未確認）。
- 1-06 の表示（1280×720 等で .left が高さの制約を受けるか、画面の見た目）。
- 1-22 の文書（docs/29・32・35・26・21・39 など、a6e9bdd の docs 変更）は未読。
- 1-02 のスロープ端点（距離>0）の判定、1-05 の描画（MapRenderer の見た目）、1-03 の E2E 操作感は未確認。
- 1-19 の overall の式の妥当性（turns の単位は planning の定義の読みに基づく）。
- 1-21 S-2 の「再現してから修正」の記録（テストの書き順）は未確認。
- 1-15 の groundBlockers と ground.ts:380/465 の停止条件の完全な一致は未確認（機種ごとの taskNeeds の読みのみ）。
