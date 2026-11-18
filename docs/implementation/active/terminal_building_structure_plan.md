# Phase 5 / 5-14 実装計画: ターミナル建物の階層拡張と駅・バスターミナルの内包

> 管理状態: **active（T1〜T5 実施済み 2026-11-18。T6 は未接続の内包施設が能力に加算されないところまで、T7 は一部。接続後の能力集計は 5-16 側の残件）**
> 作成日・更新日: 2026-11-18
> 根拠: PO 依頼（2026-11-18）、docs/42 §3.4 要件 5-14、docs/34・35・39
> 正本: 本書は実装計画。現行仕様は docs/34・35 と関連コードを参照。

## 1. 現状と課題

- ターミナル施設は src/core/model/catalog.ts の FACILITY_SPECS.terminal で矩形・既定20×8。PROP_SCHEMAS.terminal.levels は1〜3、既定2。TerminalArea.level は0以上かつ terminal.props.levels 未満で、現在は地上1〜3階に限定される。
- Facility.floorIndex は親施設内の階（0=1F、負数=地下）を保持し、placeFacility() は親が建物なら子施設を格納できる。既定の内部階範囲は-5から親の levels-1。一方で mapLevel は空港地図上の地下・地上・高架階を表す別概念で、混同してはならない。
- railStation は既に layer: building の構造物種別で、親施設に内包する基礎もある。ただし駅の旧 props.level と、親施設内の floorIndex の優先関係を明示する必要がある。
- busStop は layer: area で、既存のバス停・アクセス判定に使われる。親建物への格納が一部可能でも、複数バース・乗降場・コンコースを持つ構造物モデルではない。既存busStopの意味を変えると旧データとアクセス判定に影響する。
- 建物内施設は parentFacilityId / floorIndex、保存形式3、階別占有に対応するが、ターミナル内部旅客エリアの経路モデルとは別のデータである。親建物に内包したGSE・手荷物・給油等の設備は、地上サービス網への内部接続モデルがない場合、能力・運用に加算されない（docs/34の既知制限）。
- 関連コード: src/core/model/catalog.ts、src/core/model/types.ts、src/core/model/levels.ts、src/core/layout/operations.ts、src/core/layout/footprint.ts、src/core/terminal/model.ts、src/core/validation/validate.ts、src/core/io/serialize.ts、src/core/io/project.ts、src/ui/Toolbox.tsx、src/ui/PropertiesPanel.tsx。
- 現状の建物内施設の階範囲を、そのまま旅客が移動できるターミナル内部階の範囲とみなしてはならない。旅客エリアの床・上下接続・階層検証を別途拡張する必要がある。

## 2. 目的・対象範囲

### 目的

- ターミナル内部階を B3 / B2 / B1 / 1F / 2F / 3F / 4F に対応させる。
- 既存のFacility・TerminalArea・道路グラフの階層と整合し、鉄道駅・バスターミナルを独立した構造物として配置しつつ、ターミナル建物の内部にも配置できるようにする。
- 既存railStation・busStop・ターミナル保存データの意味を保ち、新規データにのみ必要な情報を追加する。

### 対象

- 階の共通規約、ターミナルの階数定義、内部エリアのfloor index。
- 駅・バスターミナルの施設種別と親施設への内包、地上鉄道/バスネットワークとの接続点。
- 建設・検証・2D/3D表示・選択・保存・読み込み・移行。
- 旅客グラフへの駅コンコース・バスターミナルの接続インターフェース（経路統合の詳細は5-16と連携）。

### 非目標

- この計画だけで複雑なターミナル外形ポリゴンやターミナル複合体判定を完成させること（5-15）。
- 鉄道列車・バス車両の位置を個別に運行すること。
- 旅客の道路・通路グラフ統合の完成（5-16）。
- 建築基準法・消防法・鉄道事業法等の法令適合や構造計算を保証すること。

## 3. 設計方針

### 3.1 床階と地図階層を分離する

- ターミナル内部階 index は B3=-3、B2=-2、B1=-1、1F=0、2F=1、3F=2、4F=3 と定義する。7階を連続区間として扱う。
- Facility.floorIndex と TerminalArea.level は同じ内部階規約を使う新しい型・名前への整理を検討する。現状のTerminalArea.levelの意味（0=1F、非負のみ）を変える場合は保存移行を行う。
- Facility.mapLevel / RoadNode.level は地図空間の階層として維持する。地下鉄駅の地図階層とターミナル内部B2は、親建物・駅コンコース・路線ホームを結ぶ明示接続で対応付け、同じ値だと仮定しない。
- 旧ターミナルの props.levels は読み込み時の互換入口として扱う。旧データは従来の床数・1F開始位置を保ち、読込時にB3〜4Fへ勝手に拡張しない。旧セーブの意味を保ったまま、新規建物でB3〜4Fを選択できる方式を第一候補とする。
- props.levels を残すか minFloorIndex / maxFloorIndex または floors: {min,max} へ置き換えるかは、PROP_SCHEMAS、プロパティ編集、floorExistsInParent、validationを監査して確定する。二重の真実を作らない。

### 3.2 鉄道駅とバスターミナル

- railStation は既存の構造物種別を維持し、独立設置とターミナル内の parentFacilityId / floorIndex の両方をサポートする。
- 親建物内の駅は親のmapLevelを継承し、内部階はfloorIndexで表現する。props.levelは独立設置の旧データ互換に限定し、親内の階と競合する場合は優先順位を明確に検証する。
- 新しい busTerminal 構造物種別を追加する。既存 busStop は外部バス停・簡易停留所として維持し、レイヤ・既定値・既存アクセス選択を破壊的に変更しない。
- busTerminal はバース/乗降場数、時間当たり処理能力、乗客待合/コンコースへの接続、地上バスアクセスとの接続を持つ。バス車両を個別運行しない集約モデルを維持する。
- 鉄道ホーム・バスバースと旅客コンコースを同じレベルとみなす暗黙接続は禁止する。明示のPedestrianPortal相当の接続エンティティを5-16と共同設計し、階・地図標高・アクセス方向・能力を持たせる。

### 3.3 内部施設と運用能力

- 親ターミナルに内包された施設は、親の平面形状内かつ許可された内部階に存在しなければならない。
- 同一階の重複、異なる階の許可、建物の階数変更による孤立設備、階をまたぐ配管/道路コネクタの扱いを検証する。
- 内包した施設が運航能力に加算される条件を定義する。親建物内に置いただけでGSE・手荷物・給油・バス・鉄道の能力へ加算してはならない。運用ネットワークへ明示接続されていることを条件とする。
- 階段・エスカレーター・エレベーターを内部階間の経路エッジとして表現し、接続するfloor index、方向、歩行時間、能力、アクセシビリティを持たせる。現行のTerminalArea.kindによる重なり判定だけで複数階を接続しない。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了 | 既存floor index / map level / terminal level / railStation.props.levelの意味・参照を棚卸し | model/types、model/levels、catalog、validation、UI、save | 全参照と旧データ解釈を図示。意味が曖昧な値を実装者判断で変更しない |
| T2 | 完了 | ターミナル床階-3〜3の定義、階数UI、親内配置検証を実装 | catalog / types / operations / levelRules / PropertiesPanel | B3・B2・B1・1F〜4Fが選べる。B4・5Fは拒否。階indexと表示ラベルの対応テスト |
| T3 | 完了 | TerminalAreaの負階対応、階別グラフ、上下接続を拡張 | terminal/model / route / validation / terminal types | 同一階・上下階の隣接条件を満たすルートのみ到達。ゾーン・stepFree・閉鎖判定を維持 |
| T4 | 完了（テスト不足） | 既存railStationを独立/内包両対応へ整理し、旧props.levelを互換処理 | catalog / operations / access / project validation | 独立地下駅・地上駅・親内B2駅の接続。旧駅セーブの位置/アクセス/表示が一致 |
| T5 | 完了 | 新規busTerminal構造物を追加し、busStopは旧互換として保持 | FacilityKind / catalog / access / validation / Toolbox | 独立・ターミナル内の双方に配置可能。バース能力と外部バス接続を検証 |
| T6 | 一部完了 | 内部駅・バスターミナル・各種施設の運用接続と能力集計 | access / terminal / economy / validation | 接続されていない内包施設は運用能力へ加算されず、接続後だけ集計される |
| T7 | 一部完了 | 保存・移行・描画・E2E・Docsを整備 | io / renderer / UI / tests | 旧保存データ往復、建物の階数変更、Undo/Redo、2D/3D、全品質ゲート合格 |

## 5. 互換性・リスク

- Facility.floorIndex と TerminalArea.level の既存意味を調査してから共通化する。保存形式の版・layout schema・SIM_MODEL_VERSIONは必要性を示してから承認を得る。
- 旧railStation.props.levelと新しいmapLevel / floorIndexが重複する場合、旧データは既存挙動を保ち、読み書き時の正規化をテストする。
- 既存busStopの種別・レイヤ・バスアクセス選定を変えない。新しいbusTerminalを加える場合はunion・schema・catalog・各種switch・表示ラベル・保存検証の漏れを監査する。
- TerminalAreaの負階化は、経路・セキュリティゾーン・階段・上下移動設備・乗継MCTへ影響する。旧保存ファイルのarea.level=0..2をそのまま維持する移行を固定する。
- 大規模データでの能力計算はターミナル複合体の代表IDを使うが、物理建物IDと旅客グラフIDを失わない。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 正常系 | B3/B2/B1/1F/2F/3F/4Fの施設とエリア | 7階で配置・表示・接続が成立 | 未実行 |
| 境界値 | B4、5F、親階数縮小、mapLevel範囲外 | 理由付き拒否・既存状態保持 | 未実行 |
| 保存互換 | 旧terminal.levels、旧railStation.props.level、既存busStop | 旧データの位置・アクセス・結果が維持される | 未実行 |
| ネットワーク | 独立/内包の鉄道駅・バスターミナル、階層コネクタ | 連続した明示ルートだけ利用可能 | 未実行 |
| 運用能力 | 内包施設が接続前後で能力に加算されるか | 未接続は加算なし、接続後は定義どおり | 未実行 |
| E2E | 7階の切替・配置・選択・Undo/Redo・再読込 | 2D/3D表示と選択が一致 | 未実行 |
| 回帰 | 既存ターミナル・駅・バス停のゴールデン/テスト | 意図しない旅客・アクセス・収支変化なし | 未実行 |

## 7. 更新対象の文書

- 実装で確認した内容のみ: docs/34・35、docs/12、docs/21、docs/26・27、docs/42、README。
- 複合外形・同一ターミナル判定は5-15、旅客道路網統合は5-16に分け、本書へ重複実装しない。
- 関連する既知制限は docs/10 に記録する。

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-18 | 計画作成 | 現行階層モデルと駅/バス施設の実装を調査。既存busStopは保持し、新規busTerminalを提案 | Docsのみ。コードテスト未実行 | 床階データ表現・親内駅の地図階層・能力接続方式の詳細設計 |
| 2026-11-18 | T1 棚卸し | T2/T3 は計画作成時点より後に PR #21 で実施済み（TERMINAL_AREA_MIN_LEVEL=-3、catalog の levels 上限 4、Toolbox の B3〜4F ボタン、terminalLevels テスト 6 件）。計画書 §1 の「levels は1〜3・level は0以上」は古い記述。T6 は現行挙動が計画どおり: sim 文脈（context.ts）とアクセス区間（segments.ts）は内部施設（parentFacilityId あり）を能力集計から除外済み。T4 は railStation の内包配置自体は可能だが、props.level（地図階層）と floorIndex（内部階）の優先関係が未定義。T5 busTerminal は未実装（FacilityKind に存在しない） | コード確認（catalog/context/segments/model）。テストは T4/T5 実装時に追加 | T4 の優先関係の定義と検証、T5 busTerminal 新規種別、T7 仕上げ |
| 2026-11-18 | T4/T5/T6/T7 実施 | T5: busTerminal を新規 FacilityKind として追加（building 層 8×3、props berths/busesPerHour、建設費 600,000・運営費 2,400/日、Toolbox・検証・容量表示・色・ラベルを接続）。アクセス分析では busStop と合算し、容量は min(busesPerHour, berths×6)。T4: facilityLevel の優先順位（mapLevel > railStation の props.level > 0）と内包施設の floorIndex の意味を levels.ts に明文化。T6: 内部施設がアクセス・地上能力に加算されない現行挙動をテストで固定（interiorCapacity514）。busTerminal 単体 4 件＋内部能力 3 件合格、access/segments/catalog/fingerprint 回帰 39 件合格、typecheck・eslint 合格 | busTerminal514.test.ts / interiorCapacity514.test.ts | 内包駅・バスターミナルの能力接続は 5-16 の PedestrianPortal 設計で扱う（本計画 §5 の既知の制限どおり） |

## 9. 完了記録

- 完了日: 未完了
- 完了した受入条件: T1（棚卸し）、T2（B3〜4F 定義・UI。PR #21、terminalLevels 6 件）、T3（負階・階別グラフ）、T5（busTerminal 新規種別。busTerminal514 4 件）
- 品質ゲート: T4〜T7 実施時に回帰 39 件・typecheck・eslint を確認（§8）
- 未実行/未検証: T4 は facilityLevel 優先順位の明文化までで、独立地下駅・地上駅・親内 B2 駅の接続検証は不足。T6 は「接続されていない内包施設は加算されない」をテストで固定済みだが、受入条件の後半「接続後だけ集計される」は未達（5-16 ポータル実装後も内包駅/busTerminal の能力集計への接続はなく、現行挙動のまま）。T7 は E2E・2D/3D・階数変更時の Undo/Redo 検証が未確認
- 残件: T6（接続後の能力集計）、T7（E2E・描画・Undo/Redo の検証）
