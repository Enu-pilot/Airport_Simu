# inv: 仕様 ↔ 実装 ↔ テスト 追跡インベントリ（audit39）

対象: /home/user/Airport_Simu, HEAD 3d8a706（read-only 監査。ファイル変更なし。本ファイルのみ作成）
クラス: A 実装・テスト済 / B 実装・テスト不足 / C 仕様との矛盾（要実行確認は C 扱いで明記）/ D 未実装（文書に明記）/ E 仕様の欠落・矛盾

## 0. 集計（実測）

| 項目 | 値 |
|---|---|
| Vitest（`npx vitest list`, config は unit+integration） | **741 件 / 83 ファイル**（tests/audit は対象外） |
| Playwright（`npx playwright test --list`） | **69 件 / 15 spec ファイル** |
| `it(`/`test(` 呼び出し（grep、unit+integration+e2e） | 808 行 |
| src の TypeScript 行数 | 約 36,400 行 |
| 検証 IssueCode（validate.ts:44–125） | 72 種 |
| 検証 IssueCode の ja ラベル（ja.ts:168 以降 `ISSUE_TEXT`） | 72 / 72 あり |
| 検証 IssueCode で既存テストが言及しないもの（tests/audit 除く） | **29 / 72**（§5） |
| 依存ファイルに fast-check | **0**（package.json に無し、コードにも無し） |

## 1. 文書の版定数と実コード

| 定数 | コード | 文書 | 判定 |
|---|---|---|---|
| SCHEMA_VERSION | `src/core/model/types.ts:291` = 3 | docs/03:125, docs/21:37, docs/27:4,19 = 3 | A（一致） |
| PROJECT_FORMAT_VERSION / _2 / _3, MAX_READABLE | `src/core/io/project.ts:33–38` = 1 / 2 / 3, max 3 | docs/21:5–7,30 | A（一致） |
| SIM_MODEL_VERSION | `src/core/scenario/scenario.ts:21` = `skyport-sim-10.3` | docs/21:47 = 10.3。ただし docs/22:230 と docs/23:137 は「10.0 のまま」と記述 | E（履歴記述が現行と紛らわしい。§4 参照） |
| tests/golden 台帳 | `tests/golden/sim-versions.json:2–10` は全件 `skyport-sim-10.0` | 現行 10.3 | E/要実行確認（coordinator の基準再採取で既知） |
| CATALOG_VERSION | `src/core/aircraft/catalog.ts:16` = 2026.11.0 | docs/16:18, docs/21:31 = 2026.11.0 | A（一致） |
| ASSET_VERSION | `src/core/assets/registry.ts:15` = 2026.11.0 | docs/20:43, docs/21:32 = 2026.11.0 | A（一致） |

## 2. 実装主張の検証（実装済みと書かれた項目を src で確認 = 33 件）

| # | 文書の主張 | 根拠（src） | 結果 |
|---|---|---|---|
| 1 | 日次ループ `stepTicks`（分割実行＝連続実行） | `src/core/sim/dayloop.ts:33` | 一致 |
| 2 | 毎ティック不変条件 `checkInvariants` | `src/core/sim/invariants.ts:71` | 一致 |
| 3 | 旅客不変条件 `checkPaxInvariants` | `invariants.ts:317` | 一致 |
| 4 | 地上作業不変条件 `checkGroundInvariants` | `invariants.ts:263` | 一致 |
| 5 | 天候 5 段階（level 0〜4、`typeFor`） | `src/core/sim/weather.ts:47–74` | 一致 |
| 6 | 天候予報 `forecastForDay`（docs/30 Part B） | `weather.ts:139`、`src/ui/operate/cards/WeatherCard.tsx:9` | 一致（docs/10 O6 の「未実装」は古い） |
| 7 | 1 日スキップ `skipDay` | `src/editor/simRunner.ts:278`、`src/ui/App.tsx:275` | 一致 |
| 8 | 運航アラート `deriveAlerts`（docs/09 12B-1） | `src/ui/operate/alerts.ts:87` | 一致 |
| 9 | 遅延評価 `evaluateDelayPair`（docs/36） | `src/core/economy/delayEvaluation.ts:27` | 一致 |
| 10 | 保存に機種固定 `catalogPin`（docs/10 K7） | `src/editor/project.ts:65` | 一致 |
| 11 | 経路探索 `findPath`（docs/11） | `src/core/sim/pathfinding.ts:79` | 一致 |
| 12 | サンプル空港生成（docs/09 Phase 1） | `src/core/sample/sampleAirport.ts:32` | 一致 |
| 13 | 夜間制限 22:00〜06:00（docs/31） | `src/core/economy/city.ts:34–38` | 一致 |
| 14 | 航空会社別ホームスポットの日次状態（docs/32） | `src/core/sim/simulation.ts:148, 582–583` | 一致 |
| 15 | ターミナル間経路計画 API（docs/35「API あり」） | `src/core/terminal/interTerminal.ts:32` | 一致（ただし sim からの呼び出しは無し、§3 D-10） |
| 16 | バス搭乗（ランプバス）関数群（docs/29） | `src/core/sim/apronBus.ts:27, 64, 80, 118, 155` | 一致 |
| 17 | 到着旅客の到着 150/90/45 分前（docs/12:41） | `src/core/sim/passengers.ts:42` | 一致 |
| 18 | 搭乗率 65〜90%（docs/12:40） | `passengers.ts:43` | 一致 |
| 19 | 搭乗開始 S/M/L = 20/30/40 分前（docs/12:45） | `passengers.ts:53` | 一致 |
| 20 | 搭乗締切 10 分前・最低 15 分の搭乗窓（docs/12:46） | `passengers.ts:54, 56` | 一致 |
| 21 | 店舗・飲食店での立ち寄り（docs/14:68–70） | `passengers.ts:417` | 一致（テストは 1 ファイルのみ、§3 B-08） |
| 22 | 旅客グループの最大人数（docs/04:217「既定 1 グループ最大 10 人」、docs/10 A-04） | `passengers.ts:44` `MAX_GROUP_SIZE = 5`、`:340` | **不一致（C 候補、§3 C-1）** |
| 23 | 検証 IssueCode と重大度（docs/26） | `src/core/validation/validate.ts:44–126` | 一致 |
| 24 | 日報の履歴は IndexedDB、localStorage 不使用（docs/10 O3） | `src/editor/dayHistoryStore.ts:7` | 一致 |
| 25 | 3D のパイロット追従トグル（docs/09 12B-4） | `src/render/View3D.tsx:81, 87` | 一致 |
| 26 | ハイドラント接続スポット（docs/09 U の一部） | `src/core/layout/fuelHydrants.ts`、`src/core/sim/context.ts:16, 90` | 一致（テスト 0 件、§3 B-14） |
| 27 | 都市イベントの計画 UI（docs/09「イベント定義 未実装」と矛盾） | `src/ui/ManagementPanels.tsx:321`、`src/editor/store.ts:545–558`、`src/core/economy/city.ts:110` | **矛盾（E、§4）** |
| 28 | Undo / Redo（docs/02・README） | `src/ui/App.tsx:178, 232` | 一致 |
| 29 | 手動のスポット変更（docs/11 §11 は「手動割り当て・再割り当て 未実装」） | `src/editor/simRunner.ts:408`、`src/core/sim/disruptions.ts`、`src/ui/operate/flightActions.ts:7` | **矛盾（E、§4）** |
| 30 | 経営の定時率 OTP（docs/05:195, docs/18） | `src/core/analytics/kpi.ts:39`、`review.ts:24` | 一致 |
| 31 | 天候の運航状態 `state.wx` は `game.weather === 'levels'` のときだけ（docs/30） | `src/core/sim/weather.ts:10` | 一致 |
| 32 | プロジェクト保存形式・破損ファイル拒否（docs/21） | `src/core/io/project.ts`、`tests/unit/project.test.ts`（12 件） | 一致 |

未実装と明記された機能の確認（「無いこと」の検証）:

| 文書の「未実装」 | 検索結果 | 判定 |
|---|---|---|
| 自動最適化（docs/10 K1、docs/18:91） | 該当コード無し | 一致（D） |
| 交差点予約モード S7b（docs/10 M1、docs/23 §7.4） | `intersection` は占有種別名のみ（`simulation.ts:770`）。`runwayCrossingModes` 無し | 一致（D） |
| 国際線の出入国・税関（docs/12:78） | `src/core/economy/registry.ts:20` のコメントのみ | 一致（D） |
| 手荷物の後続便への転送（docs/10 H-04、docs/13:86） | `transferBag` 等の名前無し | 一致（D） |
| 時間窓スポット予約 `StandBooking`（docs/04 S1、docs/11 §11） | 型・関数無し | 一致（D）。ただし docs/04 は不変条件として書いている（E、§4） |
| 土地の売却（docs/15:108、133） | `sellLand` 等無し | 一致（D） |
| 専用機体モデル（README、docs/10 K4） | 手続き生成のみ | 一致（D） |
| Web Worker 化（docs/10 O1） | `new Worker` 無し | 一致（D） |
| 曲線誘導路 `edgeCurve`（docs/09 Phase 13） | 無し | 一致（D） |
| 除雪（docs/10:222） | 気候 `snowy` の名称のみ（`game.ts:10`） | 一致（D） |
| ハブ航空会社・整備サイクル（docs/09:155） | 無し | 一致（D） |
| 軌道上の旅客の端数・個別車両・列車走行（docs/34:7, 21） | 無し（駅の頻度は集約値） | 一致（D） |

**文書に無いコード機能（code without doc）**: 都市イベントの計画 UI（`ManagementPanels.tsx:321`）は docs/09 で未実装扱い。ほかに文書化されていない大きな機能は確認できなかった（未精査）。

## 3. Matrix（docs/38 ID 01–21）

凡例: テストは §6 のファイル表の ID 列で対応づけ。「テスト」欄は代表的な既存ファイル。

### 01 基本プレイ・ゲーム進行
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 新規→建設→運航→日次締め→翌日 | docs/02, 09, 12B-2 | simRunner.ts:278, dayloop.ts:33 | integration/fullflow（10）, unit/dayflow（3）, dayloop（5）, e2e/dayloop（7） | A |
| 振り返り（日報） | docs/36 | analytics/review.ts | unit/review（7） | A |
| 新規ゲーム設定画面（ブラウザからの新規作成） | README | ui/GameSetup.tsx | 専用の e2e は未確認（dayloop 等に含まれるかは未精査） | B（要確認） |

### 02 建設操作・描画
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 配置・回転・移動・削除・複製 | docs/02 | core/editor, editor/tools.ts | unit/operations（12）, operations.free（21）, editor.free（20）, e2e/editor（7） | A |
| Undo/Redo・履歴方針 | docs/10 O4 | editor/store, ui/App.tsx:178 | unit/history（4）, historyPolicy（4） | A |
| 幾何（角度・曲線・交差・多角形・ラスタ） | docs/22 | core/geometry/* | unit/geometry/*（約 130 件） | A |
| 2D と 3D の面の一致 | docs/22, 20 | render/three | unit/surfaces（5）, surfaces.free（9）, geometry/surfaces.frames（2） | B（3D の目視・描画差は未検証、K6） |
| 座標フレームの生の ±0.5 禁止 | docs/22 | lint 規則 | unit/geometry/frames.lint（5） | A（L3: core は走査対象外） |

### 03 接続ネットワーク
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 誘導路・スポット接続、一方通行、孤立 | docs/11, 26 | core/airside/*, validation/validate.ts | unit/network（12）, network.free（10）, validation（22）, validation.free（13）, pathfinding（5） | A |
| 独立ゲート接続・連絡通路と滑走路交差 | docs/29 | core/layout | unit/independentGate（5） | A |
| 誘導路の端・重なり・袋小路・無効な接続 | docs/26 | validate.ts | `TAXIWAY_DEAD_END`, `TAXIWAY_OVERLAP`, `DUPLICATE_EDGE`, `DUPLICATE_NODE`（テスト 0 件） | B |
| 曲線の交差判定の基盤 | docs/22 | core/geometry/intersect | unit/geometry/intersect（18）, curve（27） | A（誘導路の曲線化は D、docs/09 Phase 13） |
| 切断・再接続の一連操作 | docs/02 | — | 明示テスト無し（validation の個別ケースのみ） | B |

### 04 階層・建物内部設備
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 階層の道路・歩行路の接続検査 | docs/34 | core/access/model, validate.ts（`ROAD_LAYER_CONNECTION_INVALID`） | unit/verticalTransport（8）（`ROAD_LAYER_CONNECTION_INVALID` は 0 件） | B |
| 建物内設備の階層・外側検査 | docs/34:20 | validate.ts（`FACILITY_INTERIOR_INVALID` / `_OUTSIDE`） | `FACILITY_INTERIOR_OUTSIDE` 1 件、`FACILITY_INTERIOR_INVALID` 0 件 | B |
| 建物内設備から地上サービス網への接続 | docs/34:20 | — | — | D（文書に明記） |
| ターミナル区域の重なり・外側 | docs/35 | validate.ts（`TERMINAL_AREA_OVERLAP` / `_OUTSIDE`） | 0 件 | B |

### 05 滑走路運用
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 従来形・自由形の滑走路属性、番号、領域 | docs/23 | core/model/runway*, core/geometry | runway（8）, runway.free（5）, designators（13）, runwayAreas（11） | A |
| 交差する滑走路の従属運用・連続横断・停止位置 | docs/23 §7 | sim/crossing（12）, crossing.chain（10） | A（連続横断の占有漏れ C1 は回帰テストあり） |
| 平行滑走路の運航上の従属化 | docs/10 M2 | — | 警告のみ（`RUNWAY_PARALLEL_*` は validation.test で検査） | D（文書に明記） |
| 交差点予約モード S7b | docs/10 M1, docs/23 §7.4 | — | — | D |
| 滑走路の横断デッドロック（離脱直後） | docs/10 M15 | sim/crossing.chain | 既知の限界として文書化 | 既知（D/B、要再現の追試） |
| 進入・離陸の競合、閉鎖、間隔 | docs/04 | sim/holdshort, resourceClosures | holdshort（5）, holdshort-perf（2）, resourceClosures（4）, e2e/runway（7） | A |

### 06 航空機の移動
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 到着→駐機→折り返し→プッシュバック→出発 | docs/11 | sim/simulation.ts | simulation（14）, invariants（5）, golden.ops（5）, golden.midrun（1）, golden（4）, e2e/operations（4）, opsfix（3） | A |
| 遅延・外部要因の評価 | docs/36, docs/11 | economy/delayEvaluation.ts | delayEvaluation（4） | A |
| 混雑・閉鎖時の動作 | docs/11 | sim/resourceClosures | 4 件 | B（閉鎖中の折り返し・滞留の不変条件は要追加） |
| 着陸復行の発生 | docs/10 L5, M10 | — | `goArounds = 0` のゴールデン | B（競合シナリオ不足） |

### 07 便生成・航空会社・スポット
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 機種カタログと機種別適合 | docs/16, 17 | core/aircraft, validation | aircraft（26）, routeEligibility（8） | A |
| 航空会社別ホームスポット | docs/32 | simulation.ts:148, 582 | airlineStandHomes（5） | A |
| 運航計画・契約・増便 | docs/05, 14 | core/economy/planning.ts, company.ts | economy（28）, economy.free（7）, airlineEvalGoals（14） | A |
| バスゲート割当（リモートスポット） | docs/29 | core/terminal/busGateAssignment.ts | busGateAssignment（8）, gateProps（4） | A |
| 時間窓のスポット予約（StandBooking）、S1 不変条件 | docs/04:152, docs/11 §11 | — | — | D（docs/11 は未実装と明記）／E（docs/04 は不変条件として記述） |
| 手動の割り当て・変更 | docs/04:169, docs/11 §11 | simRunner.ts:408 `reassignStand`（着陸前の機のみ） | reassignStand 2 ファイル | E（§4） |
| 国際線・ハブ航空会社 | docs/09 後続表・156 | registry.ts:20 | — | D |

### 08 旅客生成・出発動線
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 旅客数（搭乗率）・到着時刻分布 | docs/12:40–41 | passengers.ts:42–43 | passengers（13）, multiTerminalPassengers（17） | A |
| 搭乗開始・締切・乗り遅れ | docs/12:45–46 | passengers.ts:53–56 | passengers, apronBus（14） | A |
| 旅客グループの最大人数 | docs/04:217（最大 10）、docs/10 A-04 | passengers.ts:44（= 5） | — | **C（C-1）** |
| 店舗・飲食店での立ち寄り | docs/14:68–70 | passengers.ts:417 | `shop`・`restaurant` を含むテストは各 1 ファイル | B |
| チェックイン・保安検査の処理能力 | docs/14 | ui/operate/cards/TerminalCard.tsx（UI）、core/terminal/capacity.ts | e2e/terminal（2） | B（sim 側の旅客列テストは少ない） |
| 国内線・国際線の区別 | docs/12:78 | — | — | D |

### 09 到着旅客・手荷物
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 降機・到着通路・手荷物受取・退出 | docs/12 | passengers.ts, terminal/model.ts | `TERMINAL_NO_BAGGAGE_CLAIM` 等は 0 件。sim の到着テスト（simulation 14） | B |
| 手荷物の追跡（預け入れ→仕分け→搬送→積載）、ゲート不到達の旅客の手荷物は積まない、仕分け・ベル停止 | docs/13 | sim/baggage.ts | unit/sim/ground.test.ts:125,148,163,176（同ファイル内） | A（追跡・停止）／B（`NO_BAGGAGE_SORT` 検証は 0 件） |
| 手荷物の保安検査（X 線）・乗継手荷物 | docs/13:85 | — | — | D |
| 積み残し手荷物の後続便への転送 | docs/10 H-04, docs/13:86 | — | — | D |

### 10 複数ターミナル
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| ターミナル別の所属・旅客区域 | docs/35 | core/terminal/*, passengers.ts | multiTerminalPassengers（17）, e2e/terminal（2） | A |
| 旅客の別ターミナルへの移動（経路の実行） | docs/35（「未実装」）, README | interTerminal.ts は sim から未使用（`findTerminalTransferRoute` の参照は interTerminal と 1 テストのみ） | terminalTransit（6） | D（文書の「未実装」と一致。経路 API は実装済み） |
| 旅客の誤誘導・経路不成立の監視 | docs/35 | core/terminal/flowDiagnostics.ts | — | B |
| `TERMINAL_NO_*` 系の検証（gate/checkin/security/exit/entrance） | docs/26 | validate.ts | 0 件 | B |

### 11 階層移動・連絡設備
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 階段・エレベーター・エスカレーター（上下階） | docs/34:18 | core/terminal/model.ts:47,140 | verticalTransport（8） | A（能力の時間帯別制限・閉鎖の専用テストは未確認） |
| ターミナル間連絡設備（能力・区域・方向） | docs/34 | core/access/runtime.ts, core/terminal/interTerminal.ts | terminalTransit（6） | B |
| 道路の `capacityPerHour` による混雑・予約 | docs/34:7 | — | — | D（任意入力の表示値のみ） |
| 個別道路車両・列車の位置・占有 | docs/34:21 | — | — | D |

### 12 リモートスポット・ランプバス
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| バスゲート共有・割当 | docs/29 | busGateAssignment.ts | busGateAssignment（8）, e2e/busgate（6） | A |
| 車両不足・バス搭乗・降機 | docs/29 | sim/apronBus.ts | apronBus（14）, busSave（3）, golden.bus（1） | A |
| ランプバスの故障・救援・保護 | docs/29 | sim/apronBus.ts, sim/disruptions.ts | unit/sim/apronBus.test.ts:141「バスの故障・救援・保護」（3 件） | A（配車競合の多台数シナリオは B） |
| バスラウンジ・ピープルムーバー・サテライト | docs/29:96 | — | — | D |
| リモートスポットの一覧表示 | docs/09 | ui/PropertiesPanel.tsx:767 | — | A（表示のみ） |

### 13 GSE・折り返し作業
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 折り返し作業の依存・完了・準備完了 | docs/13 | sim/ground.ts, simulation.ts:271 | ground（11）, e2e/ground（2）, invariants（G1–G3） | A |
| 人員・車両不足、同時使用の順番待ち | docs/13:44 | sim/ground.ts | ground.test.ts:72「要員・車両の不足」（3 件、:91 は給油車の同時使用） | A |
| GSE（給油車）の故障と再割り当て、仕分け・ベルトの停止と復旧 | docs/13, 19 | disruptions.ts, ground.ts | ground.test.ts:106「設備・車両の停止」（3 件） | A（復旧後の別車両の多重故障は未確認＝B） |
| 作業員のシフト・休憩・技能区分 | docs/13:83 | — | — | D |
| `NO_GSE_BASE` 検証 | docs/26 | validate.ts | 0 件 | B |

### 14 道路・鉄道・燃料設備
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| アクセス手段（タクシー・バス・鉄道）と到達性 | docs/15 | core/access/*（landside, rail, runtime） | access（20）, e2e/access（3） | A |
| 駅の列車種別・騒音 | docs/31 | core/economy/city.ts | gameModels（19） | A |
| 燃料管・ハイドラント給油 | docs/09 U（部分）, docs/34 | layout/fuelHydrants.ts | `hydrant` を含むテスト 0 件。`fuelFarm` は 6 ファイル | B（給油の運航経路テストが無い） |
| `NO_FUEL_FARM` / `STATION_NO_RAIL` 等の検証 | docs/26 | validate.ts | `NO_FUEL_FARM` 0 件 | B |
| 列車・道路車両の運行、道路容量の予約 | docs/34:7, 21 | — | — | D |

### 15 障害・外部要因
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 天候 5 段階の効果（欠航・地上作業停止） | docs/30 | sim/weather.ts, weatherStep.ts | weatherSim（9）, golden.gameWeather（1） | A |
| 滑走路閉鎖・ゲート故障・車両故障・欠勤・需要急増 | docs/19 | sim/disruptions.ts | ops12b（13）, resourceClosures（4） | B（単独は確認、複合障害は未確認） |
| 複合障害（天候＋閉鎖＋欠員） | docs/38 15 | — | 明示テスト無し | B |
| 除雪 | docs/10:222 | — | — | D |
| 障害の一覧・対応操作 | docs/19:23 | ui/operate/alerts.ts | ops12b（アラート） | A |

### 16 経営・空港能力・評価
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 契約可否・増便・収支・資産額 | docs/05, 14 | core/economy/*.ts | economy（28）, economy.free（7）, capacity（5）, e2e/management（3）, e2e/capacity-nav（2） | A |
| 日次 KPI と実績の一致 | docs/18 | core/analytics/kpi.ts, records.ts | analytics（8） | A |
| 空港の評価・格・目標 | docs/30 | core/economy/goals.ts, airlineEval*.ts | airlineEvalGoals（14）, gameModels（19）, golden.gameModels（1）, e2e/gamemodels（8） | A |
| 都市イベントの計画（CityEventPlanner） | docs/09「未実装」 | ManagementPanels.tsx:321, store.ts:545 | `addCityEvent` 等を検査するテスト 0 件 | B（文書との矛盾は E、§4） |
| 土地売却・地価の場所差 | docs/15 | — | — | D |

### 17 保存・復元・日次進行
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| プロジェクト保存・復元（運航状態を含む） | docs/21 | core/io/project.ts, serialize.ts | project（12）, projectFormat2（6）, golden.io（5）, golden.midrun（1）, e2e/project（5） | A |
| 旧形式（v1・v2）の移行、v3 の恒等 | docs/27 | migrate*.ts | migrate（4）, migrate.v3（11） | A |
| 破損・不正データの拒否（エラー内容を返す） | docs/21 | project.ts | project.test（「壊れたファイル・不正なファイル…」） | A |
| 旧アプリで v3 プロジェクトを開く | docs/27:39, docs/10 M6 | — | — | E（既知の制限として文書化） |
| 日次の履歴・日報の保存 | docs/10 O8 | editor/dayHistory*.ts | dayflow（3）, sim/gameSave（3） | A |

### 18 長時間・高負荷
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 3 時間ストレス運航（2 シード） | docs/08 §QA, docs/10 L8 | — | integration/qa（3）, golden.ops（5） | B（より長時間・多レイアウト未採取、L8） |
| 大量の便・旅客・手荷物の不変条件 | docs/08 | invariants.ts | integration/qa（大量の便） | B |
| ホールドショート探索の性能 | docs/23 | holdshort.ts | holdshort-perf（2） | A |

### 19 UI・ブラウザ E2E
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 主要操作（建設・運航・経営・保存・アクセス・滑走路） | docs/08 | ui/*, e2e | e2e 15 ファイル / 69 件（全件 `--list` で確認） | A |
| 3D 表示（機体選択、切替、倍率） | docs/20 | render/View3D.tsx | e2e/view3d（2） | B（ソフトウェア描画のみ、K6） |
| 複数解像度（1400px 未満） | docs/10 N4 | ui | — | B（N4 で未実装と明記：右列を隠すだけ） |
| コンソールエラー・操作不能の全面検査 | docs/08 | — | 明示検査無し | B |
| 3D の性能・GPU 環境 | docs/10 K6 | — | — | D（未計測） |

### 20 ランダム操作・回帰
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 毎ティック不変条件の検査 | docs/08 §4 | invariants.ts | sim/invariants（5）, audit.s0s4（8）, crossing.chain（10） | A |
| プロパティテスト（fast-check、ランダムなマップ・操作列） | docs/08:15, 51 | — | fast-check は package.json・tests のどこにも無い | **E**（§4）。手動のシード列テストで代替 |
| 回帰（C1 占有漏れ、ゴールデン） | docs/10 M13 | — | crossing.chain、golden（17 ファイル） | A |

### 21 統合総合テスト
| 機能 | 仕様 | コード | テスト | クラス |
|---|---|---|---|---|
| 建設→便→機体→旅客→手荷物→地上→経営→保存の長期シナリオ | docs/38 21 | — | integration/fullflow（10）, integration/qa（3） | B（単一シナリオ。全ターミナル・バス・天候の組み合わせは未確認） |

## 4. 文書の不整合

| # | 文書 | 内容 | 実装・他の文書 | 分類 |
|---|---|---|---|---|
| D-1 | docs/08:201–202 | 「20 ファイル / 231 件」（履歴の値）。docs/08:244,283,294,308,330 にも 395/564/578/597/631 の旧値、docs/08:334–336 は 674/683 テスト。文書内で数値が衝突 | 現在 741 件 / 83 ファイル（unit+integration）、Playwright 69 件 / 15 ファイル。docs/08:330 は「68 ファイル」 | E（文書更新。自動生成が望ましい） |
| D-2 | docs/08:15, 51 | 「Vitest + fast-check」「fast-check でランダム操作列」 | package.json に fast-check 無し | E |
| D-3 | docs/08:56 | `tests/fixtures/maps/` に JSON マップ | 存在しない（`tests/golden/fixtures` は有る） | E（パス誤り） |
| D-4 | docs/08:76 | `tests/regression/golden/*.json` | 存在しない（実際は `tests/golden/*.golden.json`） | E（パス誤り） |
| D-5 | docs/06:157 | `src/ui/i18n/ja.json` | 存在しない（実際は `src/i18n/ja.ts`） | E（パス誤り） |
| D-6 | docs/10 O6 | 「天候予報は未実装」 | `forecastForDay`（weather.ts:139）と WeatherCard で表示。docs/30 Part B も実装済み | E（古い記述） |
| D-7 | docs/10 O7 | 「天候 Lv4 を追加する予定」 | `WxLevel` 0〜4、`min(4, …)`（weather.ts:74） | E（古い記述） |
| D-8 | docs/09「後続フェーズ」表 | 「リモートスポット: バス搭乗、ランプバス」「騒音・夜間制限」を後続候補 | 12B-3a（docs/29）・12B-3b の一部として実装済み | E（後続表の更新漏れ） |
| D-9 | docs/09 12B-3b 行・README:72 | 「イベント・都市鉄道投資は未完了」「イベント定義は未実装」 | `CityEventPlanner`（ManagementPanels.tsx:321）と `addCityEvent`（store.ts:545）が存在。テスト 0 件 | E（実装は有るが文書は未実装扱い。テスト不足） |
| D-10 | docs/11 §11 | 「スポットの時間窓予約・手動割り当て・再割り当て 未実装」 | 再割り当て（`reassignStand`、simRunner.ts:408）は着陸前の機に実装済み。時間窓予約は未実装 | E（部分実装を分けて書く必要） |
| D-11 | docs/04:152, 169 | S1「時間窓が重なる StandBooking は存在しない」、手動割り当ては S1〜S3 で検証 | `StandBooking` 型が無い（D-10 と同じ未実装）。docs/04 は未実装マーカー無し | E（不変条件が参照する実体が存在しない） |
| D-12 | docs/04:217, docs/10 A-04 | 旅客グループは既定「最大 10 人」 | `MAX_GROUP_SIZE = 5`（passengers.ts:44） | **C-1**（§5） |
| D-13 | docs/22:230, docs/23:137 | SIM_MODEL_VERSION「skyport-sim-10.0 のまま」 | 現行は 10.3（scenario.ts:21）、docs/21:47 も 10.3 | E（履歴の記述が現行と誤読される） |
| D-14 | tests/golden/sim-versions.json:2–10 | 全ゴールデンの採取版 10.0 | 現行 SIM_MODEL_VERSION 10.3。`tests/golden/io.ts:7, 20, 99` は版と台帳の一致を検査。coordinator が基準再採取で既知の失敗を報告済み | 要実行確認（C 候補。ゴールデン再採取の方針が未決） |
| D-15 | docs/27:39, docs/10 M6 | 旧アプリで v3 のプロジェクトファイルが拒否されない可能性 | 文書化された既知の制限 | E（既知） |
| D-16 | README:72 | 「12B-3b は … 一部実装」 | 与件どおり（D-9 と同根） | — |
| — | 相対リンク | README・HANDOFF_PROMPT・docs/*.md の `](path)` 形式のリンク | 全て存在（検査済み） | A |

## 5. 検証 IssueCode（src/core/validation/validate.ts:44–125, 72 種）

- ja ラベル: 72 / 72 あり（`src/i18n/ja.ts` の `ISSUE_TEXT`、行 168 以降、`^  CODE:` で照合）。
- 既存テストの言及（tests/audit を除く、単語一致）: 43 / 72 あり。**29 件はテストに一度も現れない**:

ACCESS_FAR_FROM_TERMINAL, ACCESS_ROUTE_UNREACHABLE, DUPLICATE_EDGE, DUPLICATE_NODE, FACILITY_INTERIOR_INVALID, GATE_ARRIVAL_NO_EXIT, GATE_NO_ARRIVAL_ACCESS, NO_BAGGAGE_SORT, NO_FUEL_FARM, NO_GSE_BASE, NO_MAINTENANCE, PARKING_NO_ROAD, ROAD_CROSSING_NO_JUNCTION, ROAD_LAYER_CONNECTION_INVALID, SECURITY_NOT_CONNECTED, STAND_BUS_NO_GATE, STAND_MULTIPLE_GATES, STAND_REMOTE, TAXIWAY_DEAD_END, TAXIWAY_OVERLAP, TERMINAL_AREA_OUTSIDE, TERMINAL_AREA_OVERLAP, TERMINAL_LINK_CLEARANCE, TERMINAL_NO_BAGGAGE_CLAIM, TERMINAL_NO_CHECKIN, TERMINAL_NO_ENTRANCE, TERMINAL_NO_EXIT, TERMINAL_NO_GATE, TERMINAL_NO_SECURITY

（詳細: `inv_codes_table.txt`。形式: コード|ja 件数|テスト件数）

## 6. テストファイル一覧（ID 対応・件数・代表テスト名）

列: ファイル | 対応 ID | 件数（vitest list / playwright list の実数） | 保証（代表テスト名 2 件。「/」区切り）。
ID の対応は本調査の判断（ファイル名と describe 名による）。

| ファイル | ID | 件数 | 保証（代表テスト名） |
|---|---|---|---|
| tests/e2e/access.spec.ts | 14 | 3 | アクセスの画面で手段の状況を確認し、タクシー乗り場を置くとタクシーが使えるようになる / 土地を購入すると敷地が広がり、拡張計画に購入面積が表示される |
| tests/e2e/busgate.spec.ts | 12 | 4 | ゲートの搭乗方式をバスにすると紐付けスポットが消え、ランプバスを足すと警告が消える / リモートスポットの便がバスで搭乗・降機し、運航表に BUS が出る |
| tests/e2e/capacity-nav.spec.ts | 16 | 2 | 主要ページを切り替え、能力画面と設定メニューへ移動できる / 建設・経営ページへ移動している間も運航シミュレーションは進む |
| tests/e2e/dayloop.spec.ts | 01,17 | 7 | 0:00 で自動的に一時停止し、収支・定時率・明日の見通しなどの振り返りが出る。「次の日へ」で 2 日目の朝から続く / 途中で建設モードに戻る（stop-ops）は従来どおりその日を途中で締める |
| tests/e2e/editor.spec.ts | 02 | 7 | 起動するとサンプル空港がエラー・警告なしで表示される / 建物を滑走路の保護区域へ移動するとエラーになり、取り消すと解消する |
| tests/e2e/gamemodels.spec.ts | 16,15 | 8 | 新しいゲーム（設定）で難易度を選ぶと、資金・難易度の表示が変わり、運航で天候の段階と明日の予報が出る / 振り返りの「明日の見通し」に天候の予報（3 区間）が出る |
| tests/e2e/ground.spec.ts | 13 | 2 | 地上支援の画面で作業員・車両の配置と設備を確認し、車両を故障させられる / 到着した機体の折り返し作業の進捗と手荷物の状況が表示される |
| tests/e2e/management.spec.ts | 16 | 3 | 新しいゲームは小さな飛行場と初期資金・初期契約で始まり、翌日の運航計画が表示される / 建設すると建設費を支払い、元に戻すと同額が戻る。資金が足りない建設はできない |
| tests/e2e/operations.spec.ts | 06 | 4 | 運航を開始すると便が生成され、時間が進み、到着・出発が完了する / 追加した到着便を運航表から選ぶと、機体の状態と運航履歴が表示される |
| tests/e2e/opsfix.spec.ts | 06,19 | 3 | 運航表は見出しのドラッグで移動でき、コンパクト表示と位置が記憶される / 運航中の施設の詳細は読み取り専用（回転・複製・削除・編集欄を出さない） |
| tests/e2e/opslayout.spec.ts | 19,06 | 10 | 運航モードは常設のカードと右上の運航表を出し、建設用のツールボックスは出さない / 航空会社の評価カードが点数と「足りないもの」を表示する（キャリア） |
| tests/e2e/project.spec.ts | 17 | 5 | 保存したプロジェクトを開くと、変更前の空港・会社に戻る / 壊れたファイル・参照切れのファイルは読み込まず、開いているプロジェクトを変えない |
| tests/e2e/runway.spec.ts | 05 | 7 | 自由形の滑走路を任意の方位で置き、番号が決まり、磁気偏角を変えると番号が変わる / 従来形の向きの選択肢は、磁気偏角を設定すると磁方位の番号になる |
| tests/e2e/terminal.spec.ts | 08,10 | 2 | ターミナル内部のエリアを階を選んで配置し、選択してプロパティを編集できる / 運航中のターミナル表で旅客数・待ち時間を確認し、施設を閉鎖できる |
| tests/e2e/view3d.spec.ts | 19 | 2 | 2D/3D を切り替えても運航は止まらず、3D に機体が表示され性能値が計測される / 3D で施設をクリックするとプロパティに詳細が出て、何もない所をクリックすると選択が外れる |
| tests/integration/fullflow.test.ts | 21,01,17 | 10 | 総合テスト: 新規作成 → 建設 → 機種割り当て → 運航 → 分析 → シナリオ → 保存・復元 → カタログ更新 → 旧形式 → 不正データ > 1〜2. 空港を新規作成・建設し、配置エラーがない / 総合テスト: 新規作成 → 建設 → 機種割り当て → 運航 → 分析 → シナリオ → 保存・復元 → カタログ更新 → 旧形式 → 不正データ > 8. 機種の割り当てを変更したシナリオを比較し、改善・悪化の両方を判 |
| tests/integration/qa.test.ts | 18,21 | 3 | 長時間の運航 > 3日間、ランダムな障害ありで運航しても不変条件を保ち、毎日の締めが行われる / 大量の便・旅客・手荷物 > 乱数のスケジュール 90 往復/日の過密日でも不変条件を保ち、処理速度を計測する |
| tests/unit/access.test.ts | 14 | 20 | アクセス手段と接続 > 小さな飛行場は自家用車・送迎・徒歩だけ使え、アクセス係数はほぼ 1 / 運航中のアクセス > アクセス容量の不足: 道路の容量が小さいと車の旅客が遅れ、道路の遅れが KPI に出る |
| tests/unit/aircraft.test.ts | 07 | 26 | 機種カタログ > 派生型を別の機種IDで保持する（777-300 と 777-300ER、737-800 とウィングレット付き） / 機種の特性とシミュレーション > 機材変更: 保有機材の機種にだけ変えられ、旅客定員が計画に反映される |
| tests/unit/airlineEvalGoals.test.ts | 16 | 14 | 12B-3a B5: 航空会社の評価 > 重みは種類ごとに合計 1。満足度の変化は (移動平均−60)/10 の重み付き和を [−8, +4] に丸める / 12B-3a B5: 航空会社の評価 > 検証: 不正な形を拒否する |
| tests/unit/analytics.test.ts | 16 | 8 | 運営分析（実績からの集計） > 運航を終えた機体ごとに1件ずつ記録し、機種IDで 777-300ER と A350-900 を区別して集計する / ボトルネックの推定 > 保安検査のレーンが少ないと、待ち時間・待ち人数を根拠に保安検査がボトルネックとして挙がる |
| tests/unit/assets.test.ts | 19 | 3 | 3D アセット登録簿 > カタログの全機種にアセットが登録され、専用モデルはない（すべて手続き生成） / 3D アセット登録簿 > 各アセットは版・原点・単位・LOD・出典・ライセンスを持つ |
| tests/unit/audit.s0s4.test.ts | 20 | 8 | 監査修正（S0〜S4） > 負の標高を保存・再読込できる（プロジェクトの検証・checkLayout・importLayout） / 監査修正（S0〜S4） > checkLayout / importLayout: 未知の dims キー・不正な長さ・未知の alignment を拒否する。従来形の有効なデータは通る |
| tests/unit/busContext.test.ts | 12 | 8 | バスゲート・ランプバスの文脈 > 建物内 GSE 基地は地上アクセス網がないため運用資源に加算しない / 経済・互換 > ランプバスの購入費 250,000 とバス台数 0 の基地は従来と同じ資産額 |
| tests/unit/capacity.test.ts | 16 | 5 | 空港能力分析 > 計画需要と既存の運航計画能力から時間・日次サマリーを作る / 空港能力分析 > 能力モデルがない工程は未算出とし、仮想契約チェックで会社状態を変更しない |
| tests/unit/dayflow.test.ts | 01,17 | 4 | hist / 1 日スキップと締め > 壊れた履歴は読み込まず、開いているプロジェクトを変えない |
| tests/unit/dayloop.test.ts | 01,17 | 5 | stepTicks: 分割しても連続実行と同じ > ${name}: ランダムなチャンク・一括・停止条件つきがすべて一致する / stepTicks: 分割しても連続実行と同じ > stopAtDayClose なしでは日をまたいで進む |
| tests/unit/delayEvaluation.test.ts | 15,06 | 4 | 外部要因と折り返し猶予を含む遅延評価 > 実際に記録された外部遅延秒だけを到着評価から控除する / 外部要因と折り返し猶予を含む遅延評価 > 到着遅延が折返し余裕以内なら出発猶予を付けず、超えた部分だけを使う |
| tests/unit/designators.test.ts | 05 | 13 | 滑走路番号 designatorsOf（S2） > 0〜359° の整数と 0.5° 刻み: 番号は磁方位/10 の四捨五入（0.5 は切り上げ、0 は 36）で、逆向きは必ず 18 差 / 滑走路番号 designatorsOf（S2） > 接尾辞: 平行 2 本は L・R（進入方向から見て左から右）。終点側は L↔R が入れ替わる |
| tests/unit/economy.free.test.ts | 16,02 | 7 | 自由形の建設費（S8） > 任意の角度: 実長（m）から求める。幅で倍率が変わる / 拡張計画: 変換は改修工事にしない（S8） > 従来形 → 自由形、自由形 → 従来形（丸めが恒等のとき）の変換は工事を作らず、運用中のまま |
| tests/unit/economy.test.ts | 16,07 | 28 | 小さな飛行場と建設費 > 開始レイアウトはエラー・警告がなく、M級まで運航できる / 収入の計算 > 運航実績から着陸料・ターミナル使用料・地上支援料が計上される |
| tests/unit/editor.free.test.ts | 02 | 20 | 自由形ツール: 吸着 > 格子: タイル・半タイル・なし / 自由形ツール: ハンドル > 端の当たり判定は自由形の選択中だけ |
| tests/unit/gameModels.test.ts | 16,15 | 19 | 12B-3a B1: ゲーム設定（game） > コア関数が作る会社には game がなく、倍率は従来と同じ / 12B-3a B2: 天候の計画・予報（純関数） > 季節: 1 年 = 120 日（30 日ごと）。冬の悪天は雪、夏の午後の荒天は雷雨になりうる |
| tests/unit/gateProps.test.ts | 12 | 4 | 12B-3a A2: ゲートの搭乗方式・接続先・ランプバスのプロパティ > DEFAULT_PROPS は変えない（新しく置いたゲート・基地の JSON は従来と同じ） / 12B-3a A2: ゲートの搭乗方式・接続先・ランプバスのプロパティ > 更新の検証: boardingMode は列挙、connectedTo はターミナルか null、apronBuses は 0〜30 の整数 |
| tests/unit/geometry.test.ts | 02 | 9 | 座標変換（カメラ） > 世界座標 ↔ 画面座標の往復で一致する / 座標変換（カメラ） > パンはドラッグ方向と逆にカメラが動く / centerOn で中央に表示 |
| tests/unit/geometry/angle.test.ts | 02 | 12 | angle: 旧式とのオラクル比較 > GRID8_STEP は旧 headingVector と 8 方位すべてで === 一致する / angle: 基本 > bearingToDir: 90° の倍数は厳密、45° の奇数倍は ±√½、一般角は sin/-cos |
| tests/unit/geometry/audit.test.ts | 02 | 26 | flatten: 巨大半径・上限 > r = 1e15 の円弧が有限時間で終わり、端点を含む / NaN / Infinity > classifySegmentIntersection は none |
| tests/unit/geometry/curve.test.ts | 03 | 27 | integrate > gauss5 は 9 次以下の多項式を厳密に積分する / Bezier > 導関数が有限差分と一致する（全種別） |
| tests/unit/geometry/frames.lint.test.ts | 02 | 3 | frames lint: 描画・UI・編集コードに生の ±0.5 座標オフセットが無い > 検出器が +0.5 / -0.5 / .5 の各形と許可マーカーを正しく扱う / frames lint: 描画・UI・編集コードに生の ±0.5 座標オフセットが無い > src/render・src/ui・src/editor・camera.ts に違反が無い |
| tests/unit/geometry/frames.test.ts | 02 | 8 | frames > TILE_M は 25 で、catalog からも同じ値が見える / frames > 整数 World 点は自分自身のタイルに丸まる |
| tests/unit/geometry/index.test.ts | 02 | 1 | geometry index > 公開 API が揃っていて、既存の述語も引き続き公開されている /  |
| tests/unit/geometry/intersect.test.ts | 03 | 18 | line–line > 交差・端点接触・共線重なり・平行 / 一般（Bezier を含む） > S 字 3 次と水平線: 点が両曲線上にある、t1 昇順 |
| tests/unit/geometry/polygon.test.ts | 02 | 10 | 面積・向き・凸性 > signedArea / orientation / 一般多角形 > 非凸: 凹部に入る小さな矩形は重ならず、腕にかかる矩形は重なる |
| tests/unit/geometry/raster.test.ts | 02 | 4 | raster（vec.ts から移動、再エクスポートで同一関数） > vec.ts からの export は raster.ts と同じ関数 / rasterizeCurve > 線分は rasterizeSegment と一致する |
| tests/unit/geometry/segment.test.ts | 02 | 13 | vec 追加関数 > lerp / normalize / perp / rotate / nearlyEqualPoint / classifySegmentIntersection > 端点同士の接触（L 字） |
| tests/unit/geometry/stroke.test.ts | 02 | 11 | rectAlong / rectAlongDir と旧 runwayRect（オラクル） > rectAlongDir は 8 方位 × 長さ 1..120 × 半幅 2 種で頂点が === 一致する / strokePolyline > L 字: miter は外側の角を埋める、bevel は削る、round は円弧 |
| tests/unit/geometry/surfaces.frames.test.ts | 02,19 | 2 | surfaces の頂点が 2D と 3D で一貫して変換される > worldPolyToMap / worldPolyToScene は各頂点に worldToMap / worldToScene を適用した結果と === 一致する（描画が使う変換） / surfaces の頂点が 2D と 3D で一貫して変換される > 滑走路の中心線端点（タイル中心）は Map で +0.5、Scene で (x + 0.5) × 25 に来る |
| tests/unit/golden.bus.test.ts | 12,20 | 1 | ゴールデン: バス搭乗・独立ゲートの運航（12B-3a） > 出発・到着がバスで運ばれ、不変条件を保ち、基準値と一致する /  |
| tests/unit/golden.fixtures.test.ts | 17 | 3 | ゴールデン入力フィクスチャ > フィクスチャを再生成する / ゴールデン入力フィクスチャ > ${name}: 読み込めて、レイアウトとして妥当で、保存・読込で変わらない |
| tests/unit/golden.free.test.ts | 05 | 4 | ゴールデン入力フィクスチャ（自由形） > フィクスチャを再生成する / ゴールデン: 自由形の滑走路（幾何・検証・番号） > 入力は自由形の交差・平行の空港で、基準値と一致する |
| tests/unit/golden.gameModels.test.ts | 16 | 1 | ゴールデン: ゲームのモデル（評価・目標、12B-3a） > 評価の移動平均・目標・格が基準値と一致する /  |
| tests/unit/golden.gameWeather.test.ts | 15 | 1 | ゴールデン: 天候 5 段階・難易度の運航（12B-3a） > 悪天の日に着陸復行・欠航が起き、不変条件を保ち、基準値と一致する /  |
| tests/unit/golden.io.test.ts | 17 | 5 | 運航ゴールデンの再採取の例外（版に敏感なキーだけの変更） > sha256・length だけが変わり normalizedSha256 が同じなら許可する / 運航ゴールデンの再採取の例外（版に敏感なキーだけの変更） > normalizedSha256 が違えば拒否する（運航結果・データの変化） |
| tests/unit/golden.legacyRemote.test.ts | 12 | 1 | ゴールデン: 従来のリモートスポットの運航（12B-3a A0） > 出発は ゲートなし で乗り遅れ、到着は到達不能のままで、状態の sha256 まで基準値と一致する /  |
| tests/unit/golden.midrun.test.ts | 17,06 | 1 | ゴールデン: 運航の途中保存・復元 > 復元後の +2 時間が元と一致し、基準値と一致する /  |
| tests/unit/golden.ops.test.ts | 06,18 | 5 | ゴールデン: ストレス運航 > 横断・ホールドショートを含み、基準値と一致する / ゴールデン: 運航状態入りの保存 > +2 時間の serializeProject（sim あり）が基準値と一致する |
| tests/unit/golden.test.ts | 06,17 | 4 | ゴールデン基準値（幾何・検証・運航・保存） > ${name}: ネットワーク・検証・フットプリント・滑走路多角形が基準値と一致する / ゴールデン基準値（幾何・検証・運航・保存） > 固定プロジェクトの serializeProject 出力が基準値と一致する |
| tests/unit/history.test.ts | 02 | 4 | Undo / Redo > commit → undo → redo / Undo / Redo > 履歴は上限件数で古いものから捨てる |
| tests/unit/historyPolicy.test.ts | 02 | 4 | 履歴の保持規則 > 直近 7 日はすべて残す / 履歴の保持規則 > 現在の日より先の履歴は捨てる（別の経過の残り） |
| tests/unit/independentGate.test.ts | 03 | 5 | 独立ゲートの接続 > connectedTo のないレイアウトでは従来と同じ（合成ノード・接続なし） / 独立ゲートの接続 > 検証: 接続済みは GATE_NOT_AT_TERMINAL を出さず、未接続は出す。接続先が不正なら GATE_CONNECTION_INVALID、遠すぎれば GATE_CONNECTOR_LO |
| tests/unit/migrate.test.ts | 17 | 4 | レイアウト移行 v1 → v2（migrate.ts） > migrateLayout は v1 だけを書き換え、v2 以上とオブジェクト以外は触らない / レイアウト移行 v1 → v2（migrate.ts） > v1 レイアウトだけのファイルを validateProject（旧形式）で読むと従来どおりの v2 になる |
| tests/unit/migrate.v3.test.ts | 17 | 11 | レイアウトの版 3（v2 → v3 は恒等） > SCHEMA_VERSION は 3 で、新規レイアウトは 3 を書く / レイアウトの版 3（v2 → v3 は恒等） > 旧アプリ向けの上限: レイアウトファイル・プロジェクトの版が SCHEMA_VERSION を超えると拒否する |
| tests/unit/network.free.test.ts | 03 | 10 | 自由形の滑走路 × 誘導路（S5） > 斜めの自由形を 8 方向の誘導路で横切ると、実数の位置に入口ノードと停止義務ができる / 滑走路どうしの交差点ノード（S5） > 方位 %i° の滑走路と（東西の滑走路が）交わる 2 本に交差点ノードができ、両方の滑走路が分割される |
| tests/unit/network.test.ts | 03 | 12 | 誘導路の描画と接続 > 直線を引くとノード2つ・エッジ1本 / 誘導路の描画と接続 > ノードを削除すると接続エッジと孤立ノードも消える |
| tests/unit/operations.free.test.ts | 02 | 21 | 自由形の配置 placeFreeRunway / ByEnds（S4） > 配置すると自由形のデータができ、新しい項目は指定したときだけ書かれる / 自由形の回転・幾何の変更（S4） > 移動・複製: 自由形は start を delta だけ動かす／複製は進行方向に直交して 12 タイル |
| tests/unit/operations.test.ts | 02 | 12 | 施設の配置・回転・移動・削除・複製 > 配置すると安定IDが発行され、元のレイアウトは変更されない / プロパティ編集 > 検証を通る値のみ反映する |
| tests/unit/ops12b.test.ts | 15 | 13 | 12B-1: 読み取り専用の集計・導出は状態を変えない > computeKpi（本日の KPI カード）は呼び出し前後でシミュレーションと会社の状態を変えない / 12B-1: アラート（deriveAlerts） > 航空機のスポット〜滑走路間に経路がない構造問題を常設アラートにし、対象をマップ選択できる |
| tests/unit/project.test.ts | 17 | 12 | プロジェクトの保存形式 > 段差なし経路設定を運航セーブで保存・復元し、不正な値を拒否する / プロジェクトの保存形式 > 旧形式のレイアウトファイルを移行する（会社は現在のもの、汎用機材は汎用のまま） |
| tests/unit/projectFormat2.test.ts | 17 | 6 | 12B-3a A1: 保存形式の版は新しい項目を使うときだけ 2 > 従来のレイアウト・会社は 1 のまま（formatVersion も versions.format も） / Phase U: 多層交通は保存形式 v3 を使う > 階層道路を含むレイアウトを v3 で保存・復元し、v2 を名乗る不整合は拒否する |
| tests/unit/review.test.ts | 01 | 7 | 振り返りのデータ > 前日比: 改善と悪化を、指標ごとの良くなる向きで判定する / 振り返りのデータ > 日次の制約分析は便記録の根拠・影響便・時刻を示し、該当ログがない日を除外する |
| tests/unit/routeEligibility.test.ts | 07 | 8 | structured airline and destination registry > classifies routes by country identifier, not destination display text / structured airline and destination registry > rejects unknown airport country identifiers in imported layouts |
| tests/unit/runway.free.test.ts | 05 | 5 | 自由形の runwayAxis（S0） > 整数の方位 0〜359° と 0.25° 刻み: 端点間の距離が lengthM と一致し、方位・方向が保たれる / 自由形の runwayAxis（S0） > 従来形と等価な自由形は、終点が従来の整数終点と POS_EPS_T 以内で一致する |
| tests/unit/runway.test.ts | 05 | 8 | 滑走路の属性 > 長さ（m）と終点 / 滑走路の属性 > 長さ・向き・幅の編集（向きは中点を保つ） |
| tests/unit/runwayAreas.test.ts | 05 | 11 | 自由形の領域 runwayAreas（S3）: 幅 30/45/60 m を任意の角度で > 舗装幅 ${w} m: 舗装・肩・着陸帯・RESA の寸法（既定値） / 参考値の表と出典キー（S3） > 既定値は採用元の参考値と一致する（140・60・90・90/107.5・肩 (全幅 − 舗装幅) / 2） |
| tests/unit/sample.test.ts | 01 | 7 | サンプル空港 > エラー・警告がない / サンプル空港 > 全スポットが接続され、L級滑走路を持つ |
| tests/unit/sim/airlineStandHomes.test.ts | 07 | 5 | 航空会社別ホームスポット > 同一社は初回スポットをホーム登録し、次便を近接する追加ホームへ、他社は未割当スポットへ誘導する / 航空会社別ホームスポット > 日付が変わると航空会社別ホーム割当をリセットする |
| tests/unit/sim/apronBus.test.ts | 12,08 | 14 | バス搭乗（出発） > リモートスポットの出発便がバスで搭乗でき（全員が乗り遅れにならない）、不変条件を保ち、定員を超えない / リモートスポットごとのバスゲート > 明示設定したバスゲートがない場合、到着・出発旅客を誤って生成しない |
| tests/unit/sim/busGateAssignment.test.ts | 12 | 8 | リモートスポットのバスゲート割当 > 1つの明示バスゲートを複数スポットで共有でき、個別指定はそれぞれ優先する / リモートスポットのバスゲート割当 > 計画時の自動割当は閉鎖・建設中・片方向ゲートを候補にしない |
| tests/unit/sim/busSave.test.ts | 12,17 | 3 | バス搭乗の保存 > 運航中（バスの運行中）に保存 → 読み込み → 継続すると、中断しなかった場合とビット単位で一致し、BU 不変条件を保つ / バス搭乗の保存 > 新しい項目の形が不正なファイルは読み込まない（何も適用しない） |
| tests/unit/sim/crossing.chain.test.ts | 05,20 | 10 | 連続横断（C1） > 従来形の平行 2 本: 不変条件が常に成り立ち、占有が漏れず、全機が出発する（2 シード × 6 時間） / 保存と復元（C1） > heldCrossings のないふつうの保存は、読み込んで書き直しても同一のバイト列 |
| tests/unit/sim/crossing.test.ts | 05 | 12 | 交差する自由形の滑走路: 文脈（S7） > 交差点・交差点ノードの滑走路・自由形の停止位置の情報ができる。従来形だけなら空 / 交差する自由形の滑走路: 運航（S7） > 保存 → 復元（状態の複製）しても、続きの運航が一致する |
| tests/unit/sim/gameSave.test.ts | 17,16 | 3 | ゲームのモデルの保存 > 悪天の運航中に保存 → 読み込み → 継続が、中断しなかった場合とビット単位で一致する（formatVersion 2） / ゲームのモデルの保存 > 分割実行の一致: game ありでも、1 回で進めても細切れに進めても結果が同じ |
| tests/unit/sim/ground.test.ts | 13 | 11 | 正常な折り返し > 全作業が完了してから出発準備完了になり、手荷物は自便に1回ずつ積まれ、到着手荷物は受け取られる / 設備・車両の停止 > 作業中の給油車が故障すると作業を止め、別の給油車に再割り当てして続きから完了する |
| tests/unit/sim/holdshort-perf.test.ts | 05,18 | 2 | HOLD_SHORT_TOO_CLOSE の探索量（F1） > 滑走路の隣の 6×6 の誘導路の格子でも analyzeLayout は 500 ms 未満 / HOLD_SHORT_TOO_CLOSE の探索量（F1） > 小さな格子の乱択で、総当たり（再訪なしの全経路）と警告の有無が一致する |
| tests/unit/sim/holdshort.test.ts | 05 | 5 | 自由形の停止位置（M1） > 浅い角度（θ = 20°）で、エッジが短く換算が頭打ちになるとき、経路に沿って H（90 m）まで戻る / 自由形の停止位置（M1） > 換算が頭打ちにならない自由形は、従来の値のまま（既存の挙動を変えない） |
| tests/unit/sim/invariants.test.ts | 20,06 | 5 | 不変条件チェック > 正常な状態では違反なし / 不変条件チェック > 占有していない滑走路で離陸滑走すると検出する |
| tests/unit/sim/multiTerminalPassengers.test.ts | 10,08 | 17 | 複数ターミナルの旅客処理 > 単一ターミナルでは従来どおりゲート所属ターミナルへ出発旅客を割り当てる / 複数ターミナルの旅客処理 > ターミナル未割当ての出発ゲートは既定ターミナルへ決定的に流れ、ゲートなしとして処理する |
| tests/unit/sim/passengers.test.ts | 08 | 13 | 出発旅客 > 通常生成グループにも段差なし需要を決定的に割り当て、明示的な設定を優先する / 施設の処理能力と混雑 > チェックインカウンター1台では、処理能力を超えた旅客は列に並び即座には処理されない |
| tests/unit/sim/pathfinding.test.ts | 03 | 5 | 誘導路の経路探索 > 接続されたエッジだけを辿ってスポットから滑走路入口へ行ける / 誘導路の経路探索 > 機体区分が通れない誘導路は使わない |
| tests/unit/sim/resourceClosures.test.ts | 03,15 | 4 | スポット・誘導路の使用停止 > 閉鎖したスポットを新しい到着機に割り当てず、未着陸の予約は安全に解放する / スポット・誘導路の使用停止 > 手動閉鎖と障害閉鎖の解除は互いに独立し、既存の移動経路は途中で破棄しない |
| tests/unit/sim/simulation.test.ts | 06,09 | 13 | 到着から駐機まで > 着陸 → 滑走路離脱 → 誘導路 → スポット進入 → 駐機の順に遷移する / 到達不能な経路 > 滑走路とスポットがつながっていなければ着陸せず待機し、最後はダイバート |
| tests/unit/sim/weatherSim.test.ts | 15 | 9 | 天候 5 段階: 有効化と従来の運航の不変 > game のない会社・会社なしの運航は state.wx も randomDisruptionScale も持たない / 天候 5 段階: 効果 > 間隔・走行の倍率は有効な段階の表どおり（時間ごとに計画へ追従する） |
| tests/unit/surfaces.free.test.ts | 02 | 9 | runwaySurfaces（自由形） > 舗装・肩・着陸帯・RESA は別々の多角形で、寸法は任意の角度で実寸どおり（幅 30/45/60） / runwaySurfaces（自由形） > 偏角を変えると番号が変わる（磁方位） |
| tests/unit/surfaces.test.ts | 02 | 5 | 描画用の面（surfaces） > 誘導路の描画幅は m の単一の表で、codeF は区分より優先 / 描画用の面（surfaces） > 帯は幅 widthM・両端を半幅延長した矩形（水平） |
| tests/unit/terminalTransit.test.ts | 11,10 | 6 | ターミナル間連絡設備 > 運行画面向けに今時間帯の予約人数と能力待ち人数を集計する / ターミナル間連絡設備 > 建設中リンクは利用せず、接続データを保存・復元する |
| tests/unit/validation.free.test.ts | 03,05 | 13 | 自由形の実寸の占有（S6） > 着陸帯内の施設は IN_RUNWAY_STRIP、RESA 内は IN_RUNWAY_RESA（criterion = real） / 交差する滑走路（S6） > 従来形 × 自由形の交差もエラーなし。従来形どうしの交差は従来どおり OVERLAP |
| tests/unit/validation.test.ts | 03,02 | 22 | 配置エラー > 立体占有では別階層を重複扱いせず、同階層の実干渉は検出する / 接続エラー・孤立施設の検出 > 誘導路幅が足りない場合は機体区分による経路制限 |
| tests/unit/verticalTransport.test.ts | 04,11 | 8 | 階層交通ネットワーク > ターミナルの階段は上下階の旅客経路を接続し、保存・復元後も利用できる / 階層交通ネットワーク > 移動手段に合わない階層接続と短すぎるランプを拒否する |

合計: Vitest 741（unit + integration）、Playwright 69（e2e）。

## 7. 未テスト・テスト不能な項目（理由と必要な環境）

- 3D の描画品質・GPU 環境の性能（K6）: ヘッドレス Chromium の SwiftShader のみ。実機ブラウザで `window.__skyport3d` を確認が必要。
- 日次 1 日スキップの UI 応答（O1）: 重い空港での実測が必要。
- 長時間（3 時間超）・多レイアウトのストレス（L8, 18）: 実行時間の許容が必要。
- 旧アプリでの v3 読み込み（D-15）: 旧ビルドが必要。
- 複合障害（天候＋閉鎖＋欠員）（15）: 明示テストが無く、シード付きの運航シナリオを追加すれば検査可能。GSE・ランプバスの単独の故障と救援は既存テストで確認済み（§3 12・13）。
- 旅客グループ最大人数（C-1）: 5 が仕様上の意図か確定するには PO 確認、または既存の仕様変更記録の確認が必要。実行で旅客数分布を取れば 5 超の分布は無いと確認できる（未実施）。

## 8. C 候補（要実行確認、再現は未実施）

- **C-1 旅客グループ最大人数**（suspected, not reproduced）: 仕様 docs/04:217 は既定「1 グループ最大 10 人」、コードは `MAX_GROUP_SIZE = 5`（passengers.ts:44、使用 :340 `rng.int(1, MAX_GROUP_SIZE)`）。定数の値そのものが仕様と異なる。再現手順: 任意の便を運航し、出発旅客グループの `count` の最大値を記録（期待 10、実測は 5 以下の見込み）。影響: 旅客グループ数・搭乗速度・乗り遅れ判定。
- **C-2 ゴールデン台帳の版**（要実行確認）: sim-versions.json 全件 10.0 と現行 10.3 の食い違い（D-14）。
- 他に C 候補は見つからなかった。

## 9. 追加に使った資料（scratch）

- `inv_vitest_list.txt`（Vitest の全テスト名）、`inv_pw_list.txt`（Playwright の全テスト名）
- `inv_codes_table.txt`（IssueCode ごとの ja/テスト件数）、`inv_file_rows.md`（§6 の元データ）
- `gen/inv_inventory.py`（§6 の生成スクリプト。読み取りのみ）
