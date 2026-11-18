# フェーズ 4 実装計画・要件（格による解放・夜間滞泊・拠点・整備・国際線・ハブ・道路の区間能力）

> 管理状態: **active（実装完了・受入検証継続）** — 2026-11-18
> 実装本体は完了していますが、4-03・4-10等の受入計測が残っています。残件が解消するまで本書は `active/` に置きます。現在の実装状況は末尾 §12 と [docs/42 §3.3](../../42_implementation_roadmap.md) を参照してください。


- 根拠: docs/42 §1（K-5〜K-8）・§3.4（4-01〜4-14）・§3.6・§4・§5、docs/41 §2・§5・§6、docs/39 §7.2〜7.3・§12.3・§12.6・§12.7、docs/12・13・15・21・27・30・34・35。
- 設計起点: 2026-11-16に実装前計画として作成。以下の設計記述は当時の提案・仕様化であり、現在の実装状況を示すものではない。現行状態は §12 と docs/42 §3.3を参照する。数値はゲーム内の値で、実在の空港の能力・基準を表さない。
- 共通の約束:
  - **すべて opt-in**。会社の `features`（§1）・レイアウトの `accessCapacityModel`（§6）・契約の新しい種類がないデータは、計画・運航・保存の結果が今と同じ（ゴールデン一致で確認）。
  - 乱数: 既存の `state.rng`・`company.rng`・便ごとの `${c.seed}:${契約}:${日}:${i}` の消費順を変えない。新機能の乱数は**専用の種**（`${seed}:<用途>:<キー>`）から作る（`needsStepFreeRoute` と同じ方式）。
  - `SIM_MODEL_VERSION`（`src/core/scenario/scenario.ts`）は変えない。従来データの運航結果が変わる変更が必要になったら、作業を止めて差分・KPI を示し承認を得る（CLAUDE.md §3）。
  - `HANDOFF_PROMPT.md` と docs/42 の状況欄はコーディネーターだけが更新する。
  - 行番号ではなく関数名で参照する（フェーズ 1 の実装が同じ作業ツリーで進行中のため）。
- 前提の計画: `docs/implementation/active/phase2_plan.md`（区間走行 `taxiMode: 'block'`、都市の `nightOps`、夜間のスポット待機 `Flight.nightHold`、保存形式 4 の提案）と `docs/implementation/planned/phase3_plan.md`（`src/core/data/` のデータ、`registry.ts` は窓口、`legacy` 項目と `LEGACY_*_IDS`・`ID_ALIASES`、`airlinesFor(c)`・`destinationsFor(c)`、`company.market` の opt-in、`AirlineData.canBase`、`unlock.minRating`・`unlock.minTier`、`scope: 'domestic' | 'international'`）に合わせる。対応は §0.3。
- 文書番号: docs/43 はフェーズ 3 の `docs/43_data_extension_guide.md` が使うので、本フェーズの仕様書は **docs/44** とする。

---

## 0. 現状と前提

### 0.1 日の境目の現状（夜間滞泊の設計の前提）

| 経路 | 現在の動き（関数） | 機体はどうなるか |
|---|---|---|
| 続けて運航 | `stepSimulation` → `stepEconomy` が `now % DAY_SEC === 0` で `settleDay(sim, false)`（`c.day++`）→ 同じ `sim` で `generateDaySchedule(sim, day)` → `generateContractSchedule` | 同じ `sim` に残る。手動の夜着・翌朝発の便はスポットを保持して翌朝に出発する（docs/39 §12.6 で確認済み） |
| 1 日スキップ | `runHeadless('day')` → `stepTicks`（ライブと同じ `stepSimulation` の繰り返し） | 続けて運航と同一 |
| 停止 → 建設 → 再開 | `endOps` → `settleDay(sim, true)`（締め済みなら省略）→ `ops: null`（**sim を捨てる**）→ `ops.start` → `createSimulation(layout, { company: structuredClone(c), seed: ${site.seed}:ops:${c.day} })`。開始時刻は `SIM_START_SEC`（06:00、sim の 0 日目）、`economy.dayOffset = c.day − 0` | **すべての機体が消える**。日をまたぐ情報は `CompanyState.parkedCars`（翌日 0:00 からの秒）だけが前例 |
| 運航状態の保存・復元 | `restoreSimulation`（`createSimulation` を呼ばない）→ `ops.resume(sim)` | 保存時の状態のまま |

結論: 「軽い方式」で新しく要るのは**停止 → 再開の経路で、在泊機を記録から置き直すこと**だけ。続けて運航・スキップ・復元では機体は生きている。

### 0.2 他フェーズへの依存（着手できる範囲）

| 依存 | 必要になる箇所 | 先に始められること |
|---|---|---|
| フェーズ 1 の 1-11・1-14（スポットのターミナル属性・スポット変更） | 4-07 のターミナル間の乗継 | 同一ターミナルの乗継（DD）と MCT の解析 |
| フェーズ 1 の 1-19・1-20（能力ダッシュボードの行） | 4-03・4-10 の表示 | コアの能力関数 |
| フェーズ 2 の 2-01〜2-05・2-11・2-12（区間走行・出発時刻の制限・夜間のスポット待機） | 4-03 の朝の波、4-10 の波の受け入れ | 4B の実装と単体テスト（従来の全区間確保の方式で）。受け入れ基準の計測だけ後回し（それまで「未検証」と記録） |
| フェーズ 3 の 3-01・3-02・3-10（データ構成・国際の都市） | 4-04 の拠点にできる会社、4-06 の国際の提案 | 4A の機能単位の解放表、4C の工程・区域・検証 |
| フェーズ 3 の 3-04・3-05（輸送人員） | 4-07 の乗継人数の元になる到着旅客数 | `plannedPax` を入力とする形で先に実装 |

2-12 との共有: 「日付をまたいでスポットにいる機体」の記録 `CarryOverAircraft`（§1）は、4-02 の滞泊と、2-12 で止めた出発（`dep.nightHold?.kind === 'stand'`）の両方を対象にする。フェーズ 2 は続けて運航だけを扱い、停止 → 再開で失われる点は 4B-2 で解消する（フェーズ 2 の計画 §8 リスク 8「持ち越し機のスポット」の共通化もここで行う）。

### 0.3 フェーズ 2・3 の計画との対応（本書で使う名前）

| 相手の計画の項目 | 本書での使い方 |
|---|---|
| P2 `Flight.nightHold = { kind: 'stand' \| 'origin' \| 'airborne', … }` | 記録の対象の判定に使う（§3.3）。滞泊の便には `nightHold` を付けない（予定どおりの夜間滞泊で、遅延ではない）。P2 の日報 `night.carriedOver` に滞泊の便を数えない |
| P2 `city.nightOps`（夜間制限の終わり `nextCityMovementTime`） | 滞泊の朝の出発の下限 = max(開場 + 30 分, 夜間制限の終わり)。`nightOps` がない会社は開場 + 30 分 |
| P2 `taxiMode: 'block'` | 4-03・4-10 の受け入れの計測を block で行う。4B・4D の実装は full でも動く |
| P2 保存形式 4（`layoutUsesFormat4`・`companyUsesFormat4`・`taxiBlocks`、承認待ち） | 本フェーズは**次の番号 5** を使う（§1）。P2 の 4 が承認されず未出荷なら、4 にまとめるかをコーディネーターが決める |
| P2 `SIM_MODEL_VERSION` を P2 完了時に 1 回上げる案 | 本フェーズは上げない（§8）。P2 で上がった値をそのまま使う |
| P3 `src/core/data/`・`registry.ts` 窓口 | 本フェーズはデータの項目を足さない（`transferShare` 等は契約に持つ）。参照は `registry.ts` の窓口関数だけ |
| P3 `airlinesFor(c)`・`destinationsFor(c)`（`market` なし = `legacy` 項目のみ・同じ順） | 新しい種類の提案も同じ関数で候補を作る。`market` なしの会社では候補・順序が今と同じ |
| P3 `AirlineData.canBase`（既定 false、P3 では保持・検証のみ） | 4-04 の拠点にできる会社の判定に使う。`legacy` 8 社は既定 false のままなので、拠点の提案は P3 のデータで `canBase: true` を書いた会社だけになる |
| P3 `unlock.minTier`（P3 では判定しない） | 4-01 で `game.goals` 有効時に `goals.tier >= minTier` を提案の候補の判定に足す（`legacy` 項目は `minTier` を持たないので結果は変わらない） |
| P3 `scope: 'domestic' \| 'international'` と `routeAvailability` | 国際の判定は `scope`（= `classifyRoute`）。国際の都市は `internationalPassengerProcessing` が true になるまで提案されない（P3 3-10）。true にする条件は §4.5 |
| P3 `company.market`（路線需要）と `routeLoadFactors` | 乗継の人数の元は `PlannedFlight.arrPax`（`market` ありなら P3 の搭乗率、なしなら従来の `loadFactor`）。乗継は空席だけを使い、P3 の路線需要（D_r・S_r）にも数えない |

---

## 1. C0: 共通の型・保存形式（コーディネーター、S、全トラック開始前に 1 コミット）

すべて任意の項目。値がないときは従来どおり。

| ファイル | 追加 |
|---|---|
| `src/core/economy/company.ts` | `type ContractKind = 'turnaround' \| 'overnight' \| 'based'`。`Contract` に `kind?: ContractKind`（欠落 = turnaround）、`basedAircraft?: number`（拠点: 常駐機数）、`transferShare?: number`（0〜0.5、乗継の割合）、`bankId?: string` |
| 同 `CompanyState` | `features?: { overnight?: true; based?: true; international?: true; hub?: true }`、`carryOver?: { forDay: number; aircraft: CarryOverAircraft[] }`、`basedFleet?: Record<string, BasedAircraft>`、`maintenanceCredit?: Record<string, number>`（施設ごとの端数）、`basedIssueDays?: Record<string, number>`（契約ID → 条件を満たさない連続日数）、`hub?: HubSettings` |
| 新 `src/core/economy/phase4Types.ts`（型のみ） | `CarryOverAircraft { sourceAircraftId; typeId; airlineId: string \| null; contractId: string \| null; destinationId: string \| null; callsign; depNumber; standId; parkedBeforeSec; depSecOfDay; depDelaySec; depPax: number \| null; seats?; basedAircraftId?; routeType?: 'international'; techDelaySec?; techCancel?: true }`、`BasedAircraft { id; airlineId; contractId; typeId; cycles; lastCheckDay: number \| null }`、`HubSettings { banks: BankWindow[]; maxConnectMin: number }`、`BankWindow { id; arriveFromMin; arriveToMin; departFromMin; departToMin }`、`TransferKind = 'DD' \| 'DI' \| 'ID' \| 'II'` |
| `src/core/economy/planning.ts` `PlannedFlight` | `overnight?: true`、`routeType?: 'international'`、`connections?: { depKey: string; pax: number; kind: TransferKind }[]`、`transferIn?: number`、`bankId?: string`。`PlanIssueCode` に `OVERNIGHT_CAPACITY_EXCEEDED`・`BASED_CONDITIONS_UNMET`・`INTL_GATE_MISSING`・`MCT_UNAVAILABLE` |
| `src/core/sim/types.ts` `Flight` | `overnight?: true`（出発便: 翌日発 / 到着便: 夜間滞泊）、`carryOver?: true`（置き直しで作った合成の到着便）、`routeType?: 'international'`、`basedAircraftId?`、`techHoldUntil?: number`、`transferPlan?: { depFlightId: string; pax: number; kind: TransferKind }[]`（到着便）、`plannedTransferIn?: number`（出発便） |
| 同 `FlightPax` | `transferOut?`（到着: 乗継として降機した人数）、`transferIn?`（出発: 乗継グループとして生成した人数）、`transferNoShow?`（出発: 到着便の欠航・未降機で来なかった人数）、`transferRng?: RngState` |
| 同 `PaxGroup` | `transfer?: { fromFlightId: string; kind: TransferKind }`、`ciq?: { emigration?: true; immigration?: true; customs?: true }` |
| 同 `PaxStep` | `'emigration' \| 'immigration' \| 'customs' \| 'transferSecurity'` を追加 |
| 同 `Bag` | `transferToFlightId?`、`transferFromFlightId?` |
| 同 `DelayCause` | `'technical'` を追加。`SimState` に `swingGates?: Record<string, { routeType: 'domestic' \| 'international'; busyUntil: number }>`、`hubStats?: { spawned: number; connected: number; missed: number; noShow: number; byLink: Record<string, number> }` |
| `src/core/model/types.ts` | `PaxZone` に `'departureIntl' \| 'arrivalIntl'`。`TerminalAreaKind` に `'emigration' \| 'immigration' \| 'customs' \| 'transferSecurity'`。`AirportLayout.accessCapacityModel?: 'segment'`。`RoadEdge.lanes?: number`（一般・サービス道路）、`RoadEdge.tracks?: 1 \| 2`（鉄道） |
| `src/core/model/catalog.ts` | 新しいエリアの `TERMINAL_AREA_SPECS`（§4.2）、ゲートの `routeType` プロパティ（`'domestic' \| 'international' \| 'swing'`、欠落 = domestic）、駅の `platforms`（1〜12、欠落 = 2） |
| `src/core/sim/invariants.ts` | `checkInvariants` から新ファイル `src/core/sim/invariants4.ts` の `checkPhase4Invariants(sim, full)` を呼ぶ 1 行（中身は各トラックが追加） |
| `src/i18n/ja.ts` | 新しいエリア・区域・計画コード・遅延原因・契約種別の和名 |

**保存形式**: フェーズ 2 が版 4 を提案しているので、`src/core/io/project.ts` に `PROJECT_FORMAT_VERSION_5` と、次を判定する `layoutUsesFormat5`・`companyUsesFormat5`・`simUsesFormat5` を追加し、`formatVersionOf` の**最優先**に入れる（版 4 の判定より前）。理由: 版 4 までを読めるアプリが本フェーズの `carryOver` などを黙って無視すると、在泊機・乗継旅客が消えたまま運航を続けるため。フェーズ 3 は保存形式を上げない（P3 §10 Q3）。

- レイアウト: 新しいエリアの種類・新しい区域、ゲートの `routeType`、`accessCapacityModel`、`lanes`・`tracks`、駅の `platforms`、連絡設備の `allowedZones` に国際の区域。
- 会社: `features`・`carryOver`・`basedFleet`・`hub`・`basedIssueDays`・`maintenanceCredit`、契約の `kind`・`basedAircraft`・`transferShare`・`bankId`。
- 運航状態: `swingGates`・`hubStats`、便・グループ・手荷物の上記の項目。

`PROJECT_FORMAT_MAX_READABLE` を 5 に上げる。旧形式（1〜4）は**移行不要**（全項目が任意）。旧アプリは新しい版を既存の規則で読まない。

**読み込みの検証**（`validateProject`・`importCompany`）: docs/30 の `game` と同じ扱い。`features` がない会社の `carryOver`・`basedFleet`・`hub` は `importCompany` で捨て、プロジェクトの検証ではエラーにする。各項目の型・範囲（`depSecOfDay ∈ [0, 86400)`、`parkedBeforeSec ≥ 0`、`transferShare ∈ [0, 0.5]`、波の分が 0〜1440 で from ≤ to）を確認する。参照先の欠落（消えたスポット・機種）は**警告**にして読み込む（置き直しのときに §3.3 の代わりの扱いをする）。

確認: `npm run typecheck`、`npx vitest run tests/unit/project.test.ts tests/unit/projectFormat2.test.ts tests/unit/migrate.v3.test.ts`。

---

## 2. ブロック A: 格による解放（4-01）

### 2.1 要件と非目標
- 機能ごとの「必要な格」を **1 か所のデータ**（新 `src/core/economy/unlocks.ts`）で定義する。建設ツール・ゲートの属性・契約の種類・会社の設定（`features`）がそれに従う。
- 解放前は選べず、「格 N（名前）で解放」と出す。**サンドボックス、`game.goals` がない会社（従来の会社を含む）は全解放**。格は下がらない（docs/30）ので、解放の取り消しはない。
- 解放と有効化は別。解放済みでも、プレイヤーが「空港の設定」で `features` を ON にするまで新機能は動かない（既存のサンドボックスの結果を変えないため）。
- 非目標: 既存機能（大型機・鉄道など）を後から格で縛ること。消防・管制塔の段階（5-05）。

### 2.2 データ

```ts
export type FeatureId = 'overnight' | 'based' | 'maintenance' | 'international' | 'hub';
export interface UnlockDef {
  feature: FeatureId; tier: Tier;
  areaKinds?: TerminalAreaKind[]; gateRouteTypes?: ('international' | 'swing')[];
  contractKinds?: ContractKind[]; settings?: (keyof NonNullable<CompanyState['features']>)[];
}
export const UNLOCKS: readonly UnlockDef[];          // 下表
export function effectiveTier(c): Tier;              // sandbox または !c.game?.goals → 3
export function isUnlocked(c, f: FeatureId): boolean;
export function lockLabel(c, f): string | null;      // `格 ${tier}（${TIER_NAMES[tier]}）で解放`
export function featureOn(c, f): boolean;            // isUnlocked && c.features?.[f]
```

| 機能 | 格 | 対象 |
|---|---|---|
| overnight 夜間滞泊 | 1 地方空港 | 契約 `overnight`、設定 `features.overnight` |
| maintenance 整備能力 | 2 拠点空港 | 整備施設・格納庫の整備の役割（表示と運用） |
| based 拠点航空会社 | 2 拠点空港 | 契約 `based`、設定 `features.based`（overnight と maintenance を含む） |
| international 国際線 | 3 国際ハブ | エリア `emigration`・`immigration`・`customs`、国際の区域、ゲート `international`・`swing`、国際の就航都市の提案 |
| hub 乗継・波 | 3 国際ハブ | エリア `transferSecurity`、契約の `transferShare`・`bankId`、設定 `hub` |

道路・線路の区間能力（§6）は運航モデルの設定で、格の対象にしない。

### 2.3 適用箇所
- 経営（S）: `generateOffers` は従来の処理の後に、`featureOn` の機能だけ**別の乱数の種** `${c.seed}:offers4:${c.day}` で新しい種類の提案を作る（既存の提案の乱数を消費しない）。`acceptOffer` は解放・有効化されていない種類を `locked` で拒否する。 候補の会社・都市は P3 の `airlinesFor(c)`・`destinationsFor(c)` で作り、`game.goals` 有効時は P3 の `unlock.minTier` を `goals.tier` と比べる判定を足す（`legacy` 項目は `minTier` を持たないので従来の提案は変わらない）。
- 画面（P）: `Toolbox`・`PropertiesPanel` は `lockLabel` を出して無効にする。`src/editor/tools.ts` の配置・変更でも同じ判定で拒否する。`src/core/layout/**` は経営に依存させない。会社のないレイアウト編集（シナリオ）は全解放。
- 読み込んだレイアウトが未解放のエリアを持つ場合は、検証の**警告**だけ出す（データは保つ。運航では `features` がない限り使わない）。

---

## 3. ブロック B: 夜間滞泊・拠点航空会社・整備（4-02〜4-05）

### 3.1 要件と非目標
- 4-02: 契約 `overnight`。夕方に到着し翌朝に出発する。0:00 に契約の機数がスポットにいる。翌朝の最初の出発になる。夜間はスポットを占有し、駐機料が入る。
- 4-03: 滞泊できる機数を能力として出し、契約・仮想チェックで超過を拒否する。朝の始発の波を記録する。
- 4-04: 契約 `based`。常駐機 n 機（毎晩滞泊）＋日中の折り返し。条件・撤退・評価。
- 4-05: 整備の周期と能力。不足で機材の不具合（遅延・欠航）が増える。格納庫に役割を与える。
- 非目標: 運航状態を日またぎで完全に保つ方式（K-5 で不採用）、格納庫への牽引（docs/41 BA-7）、予備機、悪天時の退避、機体ごとの終日の運用（尾翼番号の通しの運用）。

### 3.2 計画（`planDay`）
- `overnight` 契約（日 D に有効）: `perDay` = 1 晩に泊まる機数。到着は `[closeMin − 240, closeMin − 30]`、出発は**翌日** `[m, m + 90 分]`、`m = max(openMin + 30, 夜間制限の終わり)`（P2 の `nightOps` がなければ `openMin + 30`）。到着・出発の位置は既存の `pos` の式と同じ便ごとの乱数（`${c.seed}:${k.id}:${D}:${i}`）。`departureAt = DAY_SEC + 朝の秒`（日をまたぐ値）、`overnight: true`。
- 日 D の計画は、D−1 の滞泊の朝の出発を**作らない**（前日の便として存在する）。分析（`analyzeDayPlan`）は「前日の滞泊がその朝まで占有するスポット」を、契約から決定的に求めて占有に加える（実行時の記録は見ない。プレビューと一致させるため）。
- 契約の最終日: その晩の到着は翌朝に出発する（契約は「泊数」を数える）。初日: 朝の出発はない。

### 3.3 軽い方式: 締めで記録し、新しい sim で置き直す
**記録**（`settleDay` の最後、`c.day++` の直前。新関数 `recordCarryOver(sim)`、新ファイル `src/core/sim/overnight.ts`）:
- `featureOn(c, 'overnight')` のときだけ。毎回の締め（0:00 の締め・停止の締め）で `c.carryOver` を**作り直す**（`forDay = c.day + 1`）。
- 対象: 状態が `parked` / `turnaround` / `readyForPushback` で、出発便が `scheduled` で、`overnight: true`（滞泊・拠点）または `nightHold?.kind === 'stand'`（P2 の 2-12 で止めた出発。`features.overnight` がなくても `nightOps` があれば対象）。置き直した P2 の便は `nightHold` を保ち、出発の時刻は記録の `depSecOfDay`（= P2 の `releaseAt` から求めた値）を使う。手動の便や通常の折り返しは対象外（停止で消える今の挙動を変えない）。
- 内容: 機種・航空会社・契約・便名・スポット、`parkedBeforeSec = now − arr.block`、`depSecOfDay = dep.scheduled mod DAY_SEC`、`depDelaySec = max(0, dep.estimated − dep.scheduled)`、計画旅客数・座席、`basedAircraftId`。整備（§3.6）の結果の `techDelaySec`・`techCancel`。

**置き直し**（新関数 `materializeCarryOver(sim)`、`createSimulation` の中で `generateDaySchedule` の**前**に呼ぶ。`c.carryOver?.forDay === c.day` のときだけ）:
1. ID: 新しい sim の `nextId('ac')`・`nextId('fl')` で振り直す（記録の `sourceAircraftId` は記録用）。
2. スポット: 記録のスポットが存在・運用中・閉鎖なし・機種に適合（`checkStand`）・未占有なら使う。そうでなければ同じ航空会社のホームスポット（docs/32）→ ID 順で最初の適合スポット。**どこにもなければ**出発便を `cancelled`（遅延原因 `technical` ではなく新しい欠航理由 `overnightNoStand`）、補償 `delayedFlight60` と同額、ログに残す。
3. 機体: 状態 `parked`、`state.standAssignments[standId] = acId`、位置は `placeAtStand`。
4. 便: 合成の到着便（`carryOver: true`、`status: 'completed'`、`block = 当日 0:00 − parkedBeforeSec`、`pax.generated = true`、`booked = 0`）と、出発便（`scheduled = 当日 0:00 + depSecOfDay`、ただし `state.now + 20 分` より前なら後ろへずらす。`estimated = scheduled + depDelaySec`、`overnight: true`）。
5. 地上作業: `createTurnaroundTasks(sim, ac, { skip: ['deplane', 'unload'] })`（ground.ts に引数を追加。旅客・手荷物のない作業を完了扱いにする）。
6. 整備の結果: `techDelaySec` があれば `dep.techHoldUntil`、`techCancel` なら `cancelTurnaround`（遅延原因 `technical`）。

**合成の到着便の除外**: `legsInPeriod`・`computeKpi`・分析の便の記録・振り返り・運航表の集計は `carryOver` の便を数えない（運航表では「前日着」と表示）。テストで「置き直しの有無で当日の到着数が変わらない」ことを確かめる。

**駐機料**: 既存の `onTakeoff`（`dep.block − arr.block`）のまま。合成の到着便の `block` により、前日の駐機時間 ＋ 0:00〜離陸が課金される。続けて運航の場合も同じ式で、前日の着陸から翌朝の離陸まで課金される。停止 → 再開では「停止〜0:00」の時間は数えない（記録しない時間）。

**経路ごとの扱い**:

| 経路 | 結果 |
|---|---|
| 続けて運航（0:00 の締め） | 機体は生きている。記録は書くが使わない（`createSimulation` を通らない） |
| 1 日スキップ | 同上（同じ `stepTicks`）。建設モードからのスキップは `ops.start` を通るので置き直す |
| 停止 → 建設 → 再開 | 停止の締めで記録し、`ops.start` で置き直す |
| 運航状態の保存 → 復元 | `restoreSimulation` は `createSimulation` を通らないので置き直さない（機体は状態に含まれる） |
| 建設モードで保存 → 読み込み → 再開 | `company.carryOver` が保存され、再開で置き直す |
| 夜間にスポットを撤去・閉鎖 | 建設の検証で警告（`OVERNIGHT_STAND_REMOVED`: 在泊 n 機）。再開時は手順 2 の代わりの扱い |

### 3.4 滞泊の能力と朝の波（4-03）
- `overnightCapacity(ctx, closures)`（`src/core/economy/capacity.ts`）: 運用中で誘導路につながったスポット（リモートを含む）に、大きさ L → M → S の順で貪欲に割り当てた最大機数（大きさ別）。O(スポット数)。
- 必要数: 有効な `overnight`・`based` 契約の 1 晩の機数（大きさ別）。`previewContractCapacity` と `acceptOffer` で超過なら `OVERNIGHT_CAPACITY_EXCEEDED`（受け入れ不可）。計画の分析でも同じコードをエラーで出す。
- 朝の波の記録: 振り返りに `morningWave = { departures, firstTakeoff, lastTakeoff, intervalsSec[] }`（`overnight` の出発便から集計）。能力ダッシュボードに「朝の 1 時間に出せる始発の数」（滑走路の能力の値を流用、未算出なら未算出）。

### 3.5 拠点航空会社（4-04）
- 契約 `based`: `basedAircraft = n`（1〜6）、`typeId`、`perDay` = 日中の折り返しの数、期間 = 通常の 3 倍、割引は通常より大きい。計画上は「n 機の `overnight` ＋ perDay 回の通常の折り返し」として作る。`basedFleet` に n 機（`ba_<n>`）を登録し、`overnight` の便に `basedAircraftId` を付ける（ID 順に割り当て）。
- 提案できる会社: `airlinesFor(c)` のうち P3 の `canBase === true`。P3 の前に実装する場合も、型だけ P3 の名前（`canBase?`）で受け、値がなければ拠点の提案は出さない。
- 条件（提案・受け入れ・毎日の締めで判定。`basedConditions(c, ctx)`）: (a) 滞泊の能力 ≥ 全契約の必要数、(b) 整備の能力（§3.6）が 1 晩あたり `ceil(n / BALANCE.maintenance.checkCycles × 日中の回数)` 以上、(c) 整備士 ≥ `ceil(n / 2)`、作業員 ≥ 既存の折り返しの必要数。
- 撤退: 条件を満たさない日が**3 日連続**（`basedIssueDays`）、または既存の満足度による撤退。撤退時は契約を `withdrawn`、`basedFleet` から削除、空港評価 −5、その会社の満足度を 30 に下げる。
- 評価への反映: 拠点の会社は `airlineSatisfaction` の加重を 2 倍にする（`features.based` のときだけ）。`technical` の遅延は既存の定時率に入る。

### 3.6 整備の周期と能力（4-05）
- 運航回数: 締めで、`based` 契約の当日の出発数を、その契約の所属機に ID 順で 1 回ずつ配って `cycles` に足す（決定的）。
- 1 晩の整備の枠: 格納庫 1 棟 = 1 機（`maxSize` 以下の大きさ）、整備施設 = `bays × 0.5` 機（端数は `maintenanceCredit` に繰り越す。S・M のみ）。格納庫がなければ L の所属機は整備できない → **格納庫の有無で差が出る**。
- 締めの処理順: (1) 運航回数を足す → (2) 今夜在泊している所属機のうち `cycles ≥ checkCycles（12）` を、`cycles` の多い順・ID 順で枠の数だけ整備（`cycles = 0`）→ (3) 翌朝の出発の不具合を決める → (4) 記録（§3.3）→ (5) 条件の判定（§3.5）。
- 不具合の式（ゲーム値）: 超過率 `r = max(0, cycles − 12) / 12`。確率 `p = min(0.6, 0.3 r)` で `techDelaySec = 30〜120 分`。`r ≥ 1` の不具合は 30% で欠航。乱数は専用の種 `${c.seed}:tech:${D}:${basedAircraftId}`。続けて運航の場合は生きている出発便の `techHoldUntil` を締めで設定、置き直しの場合は記録の値を使う（どちらも同じ値）。
- 効果の場所: `stepReadyForPushback` は `techHoldUntil` までプッシュバックしない（遅延原因 `technical`）。地上作業は変えない。
- 記録: 日報に `maintenance = { checked, overdue, faults, techCancelled }`。

---

## 4. ブロック C: 国際線（4-06）

### 4.1 要件と非目標
- 路線・便・スポット/ゲートに国内/国際の別。出国審査・入国審査・税関を工程（ターミナル内部のエリア）として追加。国際の旅客は到着が早く滞在が長い。兼用ゲートを切り替える。格 3 で解放。
- 有効化: `features.international`。国内だけの既存データは変わらない。
- 非目標: 査証・検疫・国ごとの規則、税関での手荷物検査の個別処理、国際貨物、出入国の職員の配置。

### 4.2 区域とエリア
区域は **2 つ追加**（`departureIntl` 国際出発、`arrivalIntl` 国際到着）。合計 5 区域。

| エリア | 区域 | プロパティ（既定） | 区域の境界の規則（`canMove` に追加） |
|---|---|---|---|
| `emigration` 出国審査 | departureIntl | `lanes` 4、`serviceSecPerPax` 30 | departure → departureIntl は `to.kind === 'emigration'` のときだけ |
| `immigration` 入国審査 | arrival | `booths` 6、`serviceSecPerPax` 45 | arrivalIntl → arrival は `to.kind === 'immigration'` のときだけ |
| `customs` 税関 | landside | `lanes` 4、`serviceSecPerPax` 20 | arrival → landside に `to.kind === 'customs'` を追加 |
| `transferSecurity` 乗継保安検査（§5） | departure または departureIntl（選択） | `lanes` 2、`serviceSecPerPax` 15 | arrival → departure、arrivalIntl → departureIntl は `to.kind === 'transferSecurity'` かつ区域が一致するときだけ |

- 既存の規則の枝は変えない（新しいエリアがないレイアウトでは `canMove` の結果が同じ）。待合・トイレ・店舗・ホール・上下移動は国際の区域も選べる（`zoneEditable`）。
- 連絡設備（`terminalLinks`）の `allowedZones` に国際の区域を許す（同じ区域どうしだけ通れる既存の規則のまま）。
- `serviceSecPerPax`（`src/core/terminal/capacity.ts`）と `serversOf` に新しい種類を加える。処理の待ち行列は既存の施設の仕組みを使う。

### 4.3 ゲート・スポット
- ゲートの `routeType`: `domestic`（既定）/ `international` / `swing`。`buildTerminalModel` で `GateAccess` に `routeType` と、`international`・`swing` のときの `boardingIntl`（隣接する departureIntl のエリア）・`deplaneIntl`（arrivalIntl）を加える。国内の値（`boarding`・`deplane`）の求め方は変えない。
- スポットの別はゲート（コンタクト）またはバスゲート（リモート、1-11）から導く。スポット自体に項目は足さない。
- 割当（`assignStand`、`analyzeDayPlan`）: 国際の便は `international`・`swing` のゲートのスポットだけ。国内の便は `domestic`・`swing`。
- 兼用ゲート: `state.swingGates[gateId] = { routeType, busyUntil }`。別の種類に切り替えるのは、そのゲートの便がなく `now ≥ busyUntil + swingChangeSec（600 秒）` のときだけ。計画の分析も同じ間隔で判定する。

### 4.4 旅客の工程
- 出発（`addGroup`、`f.routeType === 'international'` のときだけ分岐。国内の乱数の消費は変えない）: `checkIn`（国際は手荷物なしでも 90%）→ `security` → `emigration` → 任意の `shop`・`restroom`（今いる区域の店舗）→ `gate`（`boardingIntl`）。現れる時刻 `PAX_ARRIVAL_MIN_INTL = { earliest: 240, mode: 150, latest: 75 }`、搭乗開始は国内 +15 分。
- 到着: 降機口 `deplaneIntl` → `immigration` → `claim`（手荷物あり）→ `customs` → `exit`。通過したら `ciq` に印を付ける。
- 経路（`findPaxRoute`）: 保安検査を済ませていないグループは `security`・`transferSecurity` 以外から出発区域へ入れない（既存の `uncleared` の判定に `transferSecurity` を加える）。

### 4.5 計画のエラー・検証
- `routeCapabilitiesForAirport(countryId, { international })` の `internationalPassengerProcessing` は、`featureOn(c, 'international')` かつ `intlProcessingReady(ctx.terminal)`（出国審査・入国審査・税関が各 1 つ以上あり、国際のゲートから経路がある）のときだけ true。
- 国際の契約があり設備が足りなければ、既存の `INTERNATIONAL_PROCESSING_REQUIRED`（詳細に足りない種類）。国際のゲートがなければ `INTL_GATE_MISSING`。
- レイアウトの検証（`src/core/validation/validate.ts`、新コード）: `INTL_EMIGRATION_UNLINKED`（出国審査が departure と departureIntl の両方に接していない）、`INTL_IMMIGRATION_UNLINKED`、`INTL_CUSTOMS_UNLINKED`、`INTL_GATE_ZONE`（国際のゲートに国際の区域のエリアが接していない）、`SWING_GATE_ZONE`（両方に接していない）、`INTL_LOCKED`（未解放なのに国際のエリアがある: 警告）。
- 就航都市の国内/国際は P3 の `scope`（= `classifyRoute(countryId)`）。`PlannedFlight.routeType` → `addTurnaround` の `plan` → `Flight.routeType`。

---

## 5. ブロック D: 乗継旅客・最小乗継時間・乗継手荷物・波（4-07〜4-10）

### 5.1 要件と非目標
- 到着便の旅客の一部が、制限区域の中を**実際に歩いて**別の便に乗り継ぐ（同じターミナル、または連絡設備で別のターミナル）。出入口・アクセス交通を使わない。国内 ↔ 国際は審査を通る。
- 有効化: `features.hub` と、契約の `transferShare > 0`（既定 0）。設定のない契約は今と同じ。
- 非目標: 人数だけ移す簡易版、出発便を待たせる判断（5-08）、航空会社の提携の表、乗継客の買い物の収入の別計上、乗継の手荷物の到着地での受け取り。

### 5.2 最小乗継時間（MCT、4-08）— 解析時に 1 回だけ
- 新 `src/core/terminal/hub.ts` の `analyzeHub(layout, model): HubAnalysis`。結果は `WeakMap<TerminalModel, HubAnalysis>` に保持し、配置が変わったときだけ作り直す（毎ティック計算しない）。
- 到着ゲートごとに 1 回、全エリアへの所要時間を求める（ダイクストラの一対全、乗継の種類ごとの区域の規則で）。所要時間 = 歩行（`lengthM / WALK_SPEED_MPS`）＋上下移動・連絡設備の `travelSec` ＋ 境界の工程の目安（`serviceSecPerPax × 5 人 / 窓口数 + 300 秒`）。
- ゲートの組の MCT = 所要時間 ＋ 降機の目安 10 分 ＋ 搭乗締切の前倒し（既存の締切の値）＋ 余裕 5 分。5 分単位に切り上げ、最小 30 分。
- 空港の MCT（計画に使う値）= 種類（DD・DI・ID・II）ごとに、その種類で使えるゲートの組の**最大値**。経路がない組の種類は `MCT_UNAVAILABLE`（その種類の乗継は計画しない）。
- 計算量: ゲート G × 種類 4 × O(A log A)（A = エリア数）。

### 5.3 乗継の計画（決定的）
- 新 `src/core/economy/hub.ts` の `planConnections(plan, c, mct)`。`planDayWithDemand` の後で呼び、`generateContractSchedule` とプレビュー（`previewContractCapacity`）の両方に同じ `mct` を渡す。
- 到着便 a（到着時刻・key の順）: `T = round(a.arrPax × transferShare × (0.9 + 0.2u))`。`u` は専用の種 `${c.seed}:xfer:${day}:${a.key}`。
- 候補の出発便 d: `MCT[kind] ≤ d.departureAt − a.arrivalAt ≤ maxConnectMin（240 分）`、同じ航空会社、または両方の契約の `transferShare > 0`（相互乗継）。`kind` は a・d の国内/国際から決める。国際が含まれる種類は `features.international` が必要。
- 割当: 候補を出発時刻・key の順に並べ、空席（`seats − depPax − 既に割り当てた乗継`）に比例して配る（端数は先頭から）。空席を超えない。**乗継は空席を埋めるだけで、出発便の地元の旅客（`depPax`）を減らさない** = 都市のアクセス需要を使わない。
- 結果: `a.connections`、`d.transferIn`。`generateContractSchedule` が key → 便 ID の対応を作り、`Flight.transferPlan`（到着便）と `Flight.plannedTransferIn`（出発便）に入れる。`plannedPax` の意味は変えない。

### 5.4 乗継旅客の生成と移動（`passengers.ts`）
- 生成（`stepArrivalFlight`）: `transferPlan` がある到着便だけ、降機の人数を「乗継」と「地元」に分ける。乗継の分は先に降機し、グループの大きさ・手荷物・段差回避は**専用の乱数** `p.transferRng`（初期値 `${seed}:xfer:${f.id}`）で決める。地元の分は既存の `state.rng` の処理のまま（減った人数分だけ消費が変わるのは opt-in の便だけ）。
- グループ: `direction: 'departure'`、`flightId = 出発便`、`transfer = { fromFlightId, kind }`、`terminalId` = 到着ゲートのターミナル、`targetTerminalId` = 出発ゲートのターミナル（未定なら `reconcileDepartureGate` で後から入る）、`area` = 降機口、`accessDone: true`（アクセスを使わない）。出発便の `pax.booked` と `transferIn` に加え、到着便の `deplaned` と `transferOut` に加える。
- 工程: DD `['transferSecurity', 'gate']`、DI `['transferSecurity', 'emigration', 'gate']`、ID `['immigration', 'transferSecurity', 'gate']`、II `['transferSecurity', 'gate']`（departureIntl 側の乗継保安検査）。任意の `shop`・`restroom` は専用の乱数で。`transferSecurity` を出たら `securityCleared = true`。税関は通らない（手荷物は通しで預かる）。
- 移動: 既存の `planStep`・`walk`・`startLeg`（連絡設備・上下移動の毎時の能力の予約）をそのまま使う。出発ゲートが未定なら、出発側の区域の待合で待つ（既存の `planGate`）。
- 乗継の失敗: 搭乗締切までに着かなければ既存の `missGroups`（理由 `late` など）。到着便が欠航・ダイバートで来なかった人数は、出発便の締切で `transferNoShow` に数える（グループは作らない）。
- 補償・評価: 失敗 1 人あたり `BALANCE.compensation.missedConnection`（600）。航空会社の評価の乗り遅れ率に含める（既存の式）。`hubStats` に原因別（遅れ・到着便の欠航・連絡設備の待ち）を記録。

### 5.5 乗継手荷物（4-09、`baggage.ts`・`ground.ts`）
- 乗継グループの手荷物は**到着便の手荷物**として作る（`flightId = 到着便`、`transferToFlightId = 出発便`）。荷下ろし（`stepUnload`）は今のまま。
- 搬送の完了時、`transferToFlightId` のある手荷物は受取所へ送らず、新関数 `retagTransferBag` で `flightId = 出発便`・`direction: 'departure'`・`transferFromFlightId` に付け替え、`checkedIn`（所在 `transfer:<到着便>`）にする。便ごとの索引（`flightBags`・`groupBags`）も付け替える。以降は既存のコンベヤー → 仕分け → 積み込み。**仕分け場の能力がそのまま制約になる**。
- 積み残し: 出発便の積み込みの締切に間に合わなければ既存の `leftBehind`。旅客が乗り継げなければ既存の `reconcileDepartureBags` の取り下ろし。

### 5.6 波（バンク）とハブの表示（4-10）
- `company.hub.banks`（最大 6）。契約の `bankId` があれば、到着をその波の到着の時間帯、出発を `max(到着 + 折り返し + 余裕, 波の出発の時間帯の位置)` に置く（同じ便ごとの乱数の値を使い、時間帯だけを替える）。
- 表示（能力ダッシュボードと振り返り、`src/core/economy/capacity.ts`）: 種類ごとの MCT（最大と中央値）、1 つの波で扱える機数 = min(使えるスポット, 種類の合うゲート)、1 つの波で扱える乗継旅客数 = min(乗継保安検査の処理量 × 波の長さ, 連絡設備の能力 × 波の長さ ÷ ターミナルをまたぐ割合)、連絡設備の利用率（`hubStats.byLink` ÷ 能力 × 時間）、ゲートの処理率（降機・搭乗の人/分。既存の `DEPLANE_PAX_PER_MIN`）。算出できない値は未算出のまま。

---

## 6. ブロック E: 道路・線路の区間能力（4-11・4-12）

### 6.1 要件と非目標
- 個別の車両・列車は動かさない。区間ごとの通過の上限と、混雑による遅れだけを持つ。出入口から車寄せ・駐車場までの経路で最も細い区間が上限。線路は単線/複線と駅のホーム数で本数の上限。入力した明示能力を使う。
- 有効化: レイアウトの `accessCapacityModel: 'segment'`（建設モードの空港の設定）。欠落 = 今の集約モデル（出入口数 × 900 台/時）。
- 非目標: 正確な最大流（max-flow）、信号・交差点の遅れ、時間帯による経路の選び直し、個別の列車の運行。

### 6.2 解析（`analyzeAccess` に追加、`src/core/access/segments.ts` 新規）
- グラフ: `layout.roads` の運用中の一般道路（鉄道は別）を辺、`roadNodes` を頂点にする。辺の能力 = `capacityPerHour`（明示）、なければ `(lanes ?? 1) × 900` 台/時。辺の基準所要時間 `t0` = 長さ ÷ 時速 30 km（出入口の辺には `externalMin[mode]` を足す）。
- 目的地: 車寄せ（ターミナルに接する辺）、駐車場に接する辺。
- 出入口ごとに、目的地の集合までの**最も太い経路**（区間の能力の最小を最大にする経路、ダイクストラの変形）を求め、経路の辺の列とボトルネックの値を保持する。計算量 O(出入口数 × (E log V))。
- 目的地ごとの能力 = min(出入口のボトルネックの和, 目的地に接する辺の能力の和)。`AccessAnalysis` に `segments = { curbCapacity, parkingCapacity, bottleneckEdgeId, paths }` を加え、集約モデルの `roadCapacityPerHour` はそのまま残す（表示の比較用）。
- 鉄道: 鉄道の辺の能力 = 明示、なければ単線 4 本/時・複線 12 本/時（`tracks`）。駅の能力 = `platforms × 6` 本/時。実効の `trainsPerHour` = min(駅の本数の合計, 外周から駅までの最も太い経路のボトルネック, ホームの能力)。
- 4-12（docs/41 AC-3）: 区間モデルのとき、既存の `railWalkCapacityPerHour`（明示した通路の能力）を運航の鉄道の受け入れの上限に使う（`createAccessRuntime` の鉄道の定員 = min(本数 × 定員, 通路の能力)）。

### 6.3 運航（`runtime.ts`）
- 区間モデルのときだけ: 車のグループは、その時間帯の `volume / capacity` が最小の出入口の経路に割り当てる（決定的、乱数なし）。経路の各辺の毎時の台数 `seg:<辺>:<時>` を足し、遅れ = Σ 辺の `t0 × 0.15 × (v/c)^4`（BPR。辺ごとの上限 `congestionMaxMin`、合計も同じ上限）。
- 集約モデルとの関係: 出入口 n 本・明示能力なし・直線の道路では、各経路の台数 ≈ 全体 ÷ n、能力 900 になり、既存の `congestionDelayMin(externalMin, v, n × 900)` とほぼ同じ値になる（テストで差を記録）。
- 1 グループあたり O(経路の辺数)。毎時のキーは経路上の辺だけ。

---

## 7. 要件ごとの実装とテスト

トラック: **S**（運航・経営・アクセス）、**P**（旅客・ターミナル・レイアウト・検証・保存・画面）。§9 の持ち主に従う。

| ID | 主なファイル・関数 | テスト（新規ファイル） | 完了の判定（docs/42 §3.4） |
|---|---|---|---|
| 4-01 | S: `economy/unlocks.ts`、`generateOffers`・`acceptOffer`。P: `Toolbox`・`PropertiesPanel`・`editor/tools.ts`、設定画面 | `tests/unit/unlocks.test.ts`: 格 0〜3 の解放一覧、サンドボックス・目標なしは全解放、格を満たしても `features` OFF なら提案に新しい種類が出ない、既存の会社の提案の列が変わらない（回帰）。`tests/e2e/unlocks.spec.ts`: 解放前は選べず理由が出る | 単体と E2E の合格。既存の会社の提案・計画が同一 |
| 4-02 | S: `sim/overnight.ts`（`recordCarryOver`・`materializeCarryOver`）、`createSimulation`、`settleDay`、`planDay`、`ground.ts` `createTurnaroundTasks`、`ops.ts` の集計の除外 | `tests/unit/sim/overnight.test.ts`: 0:00 に契約の機数が在泊、翌朝の最初の出発、駐機料が前日分を含む、スポット撤去・閉鎖・不適合・満杯の代わりの扱い、全滅で欠航と補償。`tests/unit/sim/overnightSave.test.ts`: 続けて運航・停止 → 再開・建設モードの保存 → 読み込み → 再開・1 日スキップで、翌朝の便の便名・機種・スポット・時刻が一致。運航状態の保存 → 復元で二重に置かない。境界: 23:59 着・00:01 の停止・最終日・初日 | 左記がすべて合格 |
| 4-03 | S: `capacity.ts` `overnightCapacity`、`previewContractCapacity`、`analyzeDayPlan`、振り返りの `morningWave` | `tests/unit/overnightCapacity.test.ts`: 大きさ別の境界（ちょうど・1 機超過）、閉鎖中のスポットを除く。`tests/unit/sim/morningWave.test.ts`: 6 機・入口 1 の配置で離陸間隔を記録（フェーズ 2 の後に区間走行で再計測） | 超過は受け入れ不可。朝の波の間隔の記録（フェーズ 2 前は「未検証」と明記） |
| 4-04 | S: `company.ts`（based の提案・受け入れ・撤退）、`basedConditions`、`ops.ts` の評価 | `tests/unit/basedAirline.test.ts`: 条件 (a)〜(c) の各欠け、3 日連続で撤退・2 日なら継続、撤退の影響、評価の加重 | 単体の合格 |
| 4-05 | S: `sim/overnight.ts` の整備処理、`stepReadyForPushback` の `techHoldUntil`、日報 | `tests/unit/maintenance.test.ts`: 周期で cycles が 0 に戻る、枠 0・枠十分で 20 日運航して不具合の数を記録（不足で増える）、格納庫なしで L が整備されない、同じ種で同じ結果 | 単体の合格。増え方を docs に記録 |
| 4-06 | P: `model/types.ts`・`catalog.ts`・`terminal/model.ts`（`canMove`・`GateAccess`）・`terminal/route.ts`・`passengers.ts`（工程）・`validate.ts`。S: `registry.ts` `routeCapabilitiesForAirport`、`planning.ts`、`assignStand`、兼用ゲート | `tests/unit/sim/international.test.ts`: 出発は出国審査を、到着は入国審査・税関を必ず通る、国際の便は国際・兼用ゲートだけ、兼用ゲートの切替の間隔。`tests/unit/intlZones.test.ts`: `canMove` の新しい枝、新しいエリアがないとき従来と同じ。`tests/unit/validation.intl.test.ts`: 各検証コード。計画: 設備がないと `INTERNATIONAL_PROCESSING_REQUIRED` | 単体の合格。国内だけのデータのゴールデン一致 |
| 4-07 | P: `passengers.ts`（乗継の生成・工程）、`route.ts`。S: `economy/hub.ts` `planConnections`、`generateContractSchedule` | `tests/unit/sim/transfer.test.ts`: 旅客数の保存（到着 = 出口 ＋ 乗継成功 ＋ 乗継失敗 ＋ 移動中）、乗継旅客が出入口・アクセスを使わない（`accessDone`・区域）、同一ターミナル・連絡設備経由・DI・ID、連絡設備・上下移動の能力を下げると失敗が増える（3 段階 × 3 種）。乗継なしの契約で結果が同一（回帰） | 単体の合格 |
| 4-08 | P: `terminal/hub.ts` `analyzeHub`。S: 補償・評価・表示 | `tests/unit/mct.test.ts`: 同じ配置で同じ値、ゲートを遠ざけると増える、経路なしで `MCT_UNAVAILABLE`。`tests/unit/sim/transfer.test.ts` に: 表示の MCT 以上の乗継は遅れなしで成功、到着を遅らせると失敗し補償が記録される | 単体の合格 |
| 4-09 | P: `baggage.ts` `retagTransferBag`、`ground.ts`（搬送の完了の分岐、S と調整） | `tests/unit/sim/transferBags.test.ts`: 手荷物の保存、仕分け場の能力を下げると積み残しが出る条件、旅客が乗り遅れたら取り下ろし | 単体の合格 |
| 4-10 | S: 波の計画、`capacity.ts` のハブの表示。P: 画面 | `tests/unit/sim/hubBank.test.ts`: 波の時間帯に便が集まる、2 ターミナルの波（30 分に 8 機到着、60 分後に 8 機出発）を 3 シードで不変条件を保って完了 | 単体の合格（区間走行での再計測はフェーズ 2 の後） |
| 4-11 | S: `access/segments.ts`、`analyzeAccess`、`runtime.ts`。P: `RoadEdge.lanes`・`tracks`・駅の `platforms` の編集と検証、設定画面 | `tests/unit/accessSegments.test.ts`: 区間の能力を下げると遅れ・乗り遅れが増える、最も細い区間が上限、単線 < 複線、ホーム数の上限、集約モデルとの差の記録、設定なしの既存データで結果が同一 | 単体の合格。表示と実績の比を記録 |
| 4-12 | S: `createAccessRuntime` | `tests/unit/accessSegments.test.ts` に: 通路 100 人/時の地下駅で鉄道の受け入れが 100 人/時を超えない | 単体の合格 |
| 4-13 | P: `io/project.ts`（版 4 の判定・検証）、`importCompany` | `tests/unit/projectFormat5.test.ts`: 版 1〜4 の読み込みが従来どおり、新項目の往復、不正データ（範囲外・型違い・`features` なし）の拒否、参照切れの警告、復元後の継続が連続実行と一致（夜間滞泊・乗継の途中で保存） | 単体の合格 |
| 4-14 | S: docs/13・14・15・31・41。P: docs/09・12・21・32・34・35・README。新規 `docs/44_hub_and_international.md`（夜間滞泊・拠点・整備・国際・乗継・区間能力の仕様） | リンク・パス・コマンドの確認 | 各文書が実装と一致 |

**共通の回帰**: 各ブロックの後に `npx vitest run tests/unit/golden*.test.ts tests/unit/sim/invariants.test.ts` と監査テスト（`npx vitest run -c vitest.audit.config.ts`）。新機能を OFF にした同じ配置で、運航の記録が変更前と一致すること。

### 7.1 追加する不変条件（`src/core/sim/invariants4.ts`、新機能があるときだけ検査）
- O1 置き直した機体はちょうど 1 つのスポットを占有し、1 つのスポットに 2 機いない。合成の到着便は `carryOver` で、旅客・手荷物を持たない。
- O2 `techHoldUntil` より前にプッシュバックしていない。
- C1 `departureIntl` にいる出発グループは `ciq.emigration` を持つ。C2 国際の到着グループが `exited` なら `ciq.immigration` と `ciq.customs` を持つ。C3 国内の便のグループ（乗継 DI を除く）は国際の区域に入らない。
- T1 到着便: `transferOut` = その便から出た乗継グループの人数の合計。`deplaned` = 地元のグループ ＋ `transferOut`。
- T2 乗継グループは `landside` のエリアにいない・アクセスの手段を持たない・`toAirport` にならない。
- T3 出発便: `transferIn` = 乗継グループの合計。既存の P1（予約 = グループの合計）がそのまま成り立つ。
- B1 乗継手荷物: 付け替えは 1 回だけ。付け替え後は出発便の手荷物として既存の状態の保存に入る。
- E1 区間の毎時の台数 ≥ 0、遅れは有限で上限以下。

---

## 8. 保存形式・版のまとめ（4-13）
- 新しい版（§1）は、新項目を 1 つでも使うファイルだけが書く。使わないファイルは今の版のまま（ゴールデンの出力が変わらない）。
- 運航状態（スナップショット）の新しいキーはすべて任意。復元時に欠けていれば作らない（従来の運航のまま）。`SIM_MODEL_VERSION` は本フェーズでは変えない（従来データの結果を変えないため。P2 で上がった値をそのまま使う）。版 5 の番号は P2 の版 4 の承認結果を見てコーディネーターが確定する。
- docs/21・27 に版の項目一覧と、旧形式の読み込み・往復・不正データの扱いを追記する。

---

## 9. 作業の分割

### 9.1 ファイルの持ち主（2 人の実装者で重ならない）

| 対象 | 持ち主 |
|---|---|
| `src/core/economy/**`（`unlocks.ts`・`hub.ts`・`capacity.ts`・`planning.ts`・`company.ts`・`ops.ts`・`balance.ts`）、`src/core/sim/simulation.ts`・`sim/overnight.ts`・`sim/ground.ts`・`sim/disruptions.ts`・`sim/invariants.ts`、`src/core/access/**`、`src/core/analytics/**`、`src/editor/simRunner.ts` | **S** |
| `src/core/terminal/**`（`model.ts`・`route.ts`・`hub.ts`・`capacity.ts`）、`src/core/sim/passengers.ts`・`sim/baggage.ts`・`sim/invariants4.ts`、`src/core/model/**`・`src/core/validation/**`・`src/core/layout/**`・`src/core/io/**`（C0 の後）、`src/editor/**`（simRunner を除く）、`src/ui/**`、`src/render/**`、`src/i18n/ja.ts`（C0 の後） | **P** |
| C0、`docs/42`・`HANDOFF_PROMPT.md`、版の番号の決定 | コーディネーター |

- 境界をまたぐ呼び出し: 乗継手荷物の搬送の完了（`ground.ts` の `stepUnload`）から P の `retagTransferBag` を呼ぶ 1 行は S が入れる。P の工程のための `Flight.routeType`・`transferPlan` は S が設定する（型は C0）。
- テスト: S は `tests/unit/{unlocks,overnightCapacity,basedAirline,maintenance,accessSegments}.test.ts`・`tests/unit/sim/{overnight,overnightSave,morningWave,hubBank}.test.ts`。P は `tests/unit/{intlZones,validation.intl,mct,projectFormat4}.test.ts`・`tests/unit/sim/{international,transfer,transferBags}.test.ts`・`tests/e2e/**`。
- 並行作業の注意（フェーズ 1 と同じ）: タスクごとは対象を絞ったテストだけ。`npm test` 全件・`npm run build`・E2E は同期点でコーディネーターが実行する。

### 9.2 サブフェーズと順序（価値とリスクの順）

推奨の順序: **4A → (4B ∥ 4E) → 4C → 4D → 4F**。4A は以降すべての土台。4B は価値が大きく変更範囲が狭い。4E は独立で他フェーズに依存しない。4D は最も重く、4C の区域を使うので最後にする（DD だけなら 4C の前に始められる）。

| # | タスク | 持ち主 | 規模 | 依存 | テスト（各タスクの後） |
|---|---|---|---|---|---|
| 4A-0 | C0（型・版の判定・和名） | コーディ | S | — | `npm run typecheck`、`npx vitest run tests/unit/project*.test.ts` |
| 4A-1 | `unlocks.ts`、提案・受け入れの判定、`features` | S | S | 4A-0 | `npx vitest run tests/unit/unlocks.test.ts tests/unit/airlineEvalGoals.test.ts` |
| 4A-2 | ツール・プロパティ・設定画面の解放表示、版 5 の検証 | P | S〜M | 4A-1 | `npx vitest run tests/unit/projectFormat5.test.ts`、`npx playwright test tests/e2e/unlocks.spec.ts --trace off` |
| 4B-1 | 夜間滞泊の計画（`planDay`・分析の占有） | S | M | 4A | `npx vitest run tests/unit/economy.test.ts tests/unit/overnightCapacity.test.ts` |
| 4B-2 | 記録・置き直し・合成の到着便の除外・駐機料 | S | L | 4B-1（2-12 と型を共有） | `npx vitest run tests/unit/sim/overnight.test.ts tests/unit/sim/overnightSave.test.ts tests/unit/review.test.ts` |
| 4B-3 | 滞泊の能力・仮想チェック・朝の波の記録 | S | S | 4B-2 | `npx vitest run tests/unit/overnightCapacity.test.ts tests/unit/sim/morningWave.test.ts tests/unit/capacity.test.ts` |
| 4B-4 | 拠点契約・条件・撤退 | S | M | 4B-3 | `npx vitest run tests/unit/basedAirline.test.ts` |
| 4B-5 | 整備の周期・枠・不具合 | S | M | 4B-4 | `npx vitest run tests/unit/maintenance.test.ts tests/unit/sim/ground.test.ts` |
| 4B-6 | 画面（契約の種類、在泊の表示、撤去の警告 `OVERNIGHT_STAND_REMOVED`、ダッシュボードの行） | P | M | 4B-3 | `npx vitest run tests/unit/validation.test.ts`、`npx playwright test tests/e2e/dayloop.spec.ts --trace off` |
| 4E-1 | 区間の解析（道路・鉄道）と 4-12 | S | M | 4A-0 | `npx vitest run tests/unit/accessSegments.test.ts tests/unit/access.test.ts` |
| 4E-2 | 運航の BPR・出入口の割当 | S | M | 4E-1 | 同上 ＋ `tests/unit/regression/s_transitOverbook.test.ts` |
| 4E-3 | `lanes`・`tracks`・`platforms`・設定の編集と検証、表示 | P | S〜M | 4E-1 | `npx vitest run tests/unit/validation.test.ts tests/unit/regression/u_roadDefaultCapacity.test.ts` |
| 4C-1 | 区域・エリア・`canMove`・経路・`GateAccess` | P | M | 4A | `npx vitest run tests/unit/intlZones.test.ts tests/unit/sim/passengers.test.ts tests/unit/sim/multiTerminalPassengers.test.ts` |
| 4C-2 | 旅客の工程（出発・到着） | P | M | 4C-1 | `npx vitest run tests/unit/sim/international.test.ts` |
| 4C-3 | 計画のエラー・割当・兼用ゲート・`routeType` の受け渡し | S | M | 4C-1 | `npx vitest run tests/unit/sim/international.test.ts tests/unit/routeEligibility.test.ts` |
| 4C-4 | 検証コード・建設ツール・画面 | P | M | 4C-1 | `npx vitest run tests/unit/validation.intl.test.ts` |
| 4D-1 | MCT の解析と表示用の値 | P | M | 4C-1（DD だけなら 4A） | `npx vitest run tests/unit/mct.test.ts` |
| 4D-2 | `planConnections`・波・スケジュールへの受け渡し | S | M | 4D-1 | `npx vitest run tests/unit/sim/hubBank.test.ts tests/unit/economy.test.ts` |
| 4D-3 | 乗継旅客の生成・工程・失敗（DD → DI/ID/II） | P | L | 4D-2、1-11・1-14 | `npx vitest run tests/unit/sim/transfer.test.ts tests/unit/sim/invariants.test.ts` |
| 4D-4 | 乗継手荷物 | P（＋ S の 1 行） | M | 4D-3 | `npx vitest run tests/unit/sim/transferBags.test.ts tests/unit/sim/ground.test.ts` |
| 4D-5 | 補償・評価・ハブの表示・振り返り | S（コア）、P（画面） | M | 4D-3 | `npx vitest run tests/unit/capacity.test.ts tests/unit/review.test.ts` |
| 4F | 文書（4-14）、品質ゲート | 両方・コーディ | M | 全部 | §9.3 |

### 9.3 同期点（コーディネーター）
1. 4A-0 → S・P を開始。4A の終わりに `npm run typecheck && npm run lint && npm test`。
2. 4B と 4E の終わり: `npm test`、ゴールデン、監査テスト、`npm run build`。4B-6 の後に `npm run test:e2e`。
3. 4C の終わり: 国内だけのデータのゴールデン一致を確認してから 4D に進む。
4. 4D の終わり・4F: `npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e`、`npx vitest run -c vitest.audit.config.ts`、性能の計測（§10）。
5. フェーズ 2 の完了後: 4-03 の朝の波と 4-10 の波を区間走行で再計測し、記録を docs/44 に追記（それまで「未検証」）。

---

## 10. 性能の予算とリスク

### 10.1 予算（計測テストで値を記録し、超えたら失敗）
- 旅客グループ: 現状は 3 時間で到着約 1,000 組・出発約 1,000 組（docs/39 §12.7）。乗継の割合 30% の契約が全体を占める場合、乗継グループは到着の 30% で、地元の出発グループは減らないので**グループ数は最大 +15〜30%**。1 ティックの計算時間は、同じ配置で乗継なしの 1.25 倍以内。1 日スキップも 1.25 倍以内。
- MCT の解析: ゲート 80・エリア 500 で 100 ms 以内。配置の変更時だけ（`WeakMap` に保持）。毎ティックと計画のたびには計算しない。
- 区間の解析: 道路の辺 2,000 で 20 ms 以内。運航中は 1 グループあたり経路の辺数（最大 64）だけ。
- 夜間滞泊・整備: 締めのときだけ O(機体数)。
- 保存の大きさ: 1 グループあたり項目 2 つ（`transfer`・`ciq`）。1 日の増加量を記録し、docs/39 §3.1 の約 2.2 MB からの増分を docs/44 に書く。

### 10.2 リスクと対策
1. 合成の到着便が KPI・振り返り・分析に混ざる → `carryOver` の除外を 1 か所の判定関数にまとめ、置き直しの有無で当日の集計が同じことをテストする。
2. 乗継グループが P1・P6 の不変条件や `reconcileDepartureGate` を崩す → 出発便のグループとして作り、既存の経路・連絡設備の処理を再利用する。DD だけで先に通す。
3. `canMove` の変更が従来の配置を変える → 新しい枝は新しいエリア・区域があるときだけ通る。ゴールデンで確認する。
4. 乱数の流れの乱れ → 新機能の乱数はすべて専用の種。機能 OFF の回帰テストを各ブロックに置く。
5. フェーズ 2・3 の遅れ → 4-03・4-10 の受け入れの計測と、国際の都市の提案・拠点にできる会社のデータは後で差し込む形にしてある。
6. 保存形式の版の番号の衝突 → C0 で番号を決め、フェーズ 2・3 の計画と突き合わせる。
7. 兼用ゲートの割当が複雑になる → 4C-3 の最後に入れ、固定のゲートだけで 4C を先に通す。
8. 置き直しと続けて運航で朝の地上作業の状態が違う（置き直しは朝に作業する） → 仕様として docs/44 に書き、テストは「便・スポット・時刻」の一致だけを求める。
9. 計画のプレビューと運航で MCT が違う → 両方に同じ `analyzeHub` の結果を渡す。配置を変えたら計画を作り直す（既存の挙動）。

---

## 11. 既定を置いて決めた未決事項（12 件）
1. **解放の格**: 夜間滞泊 1、整備・拠点 2、国際・乗継・波 3。区間能力は格の対象外。サンドボックスと目標のない会社は全解放（docs/39 §7.3 の 2 への回答に合わせる）。
2. **有効化**: 解放に加えて `features` の ON が必要。新しいキャリアでも既定は OFF（既存の結果とゴールデンを守る）。
3. **夜間滞泊の時間帯**: 到着 `[閉場 − 240 分, 閉場 − 30 分]`、出発 `[開場 + 30 分, 開場 + 120 分]`。
4. **停止で持ち越す範囲**: `overnight` の印の出発便だけ。手動の便・通常の折り返しは今と同じく停止で消える。
5. **スポットがなくなったとき**: 別の適合スポット（ホームスポット → ID 順）。なければ欠航（`overnightNoStand`）と補償。
6. **駐機料**: 離陸時に、合成の到着便の時刻から計算（前日の駐機 ＋ 0:00〜離陸）。停止〜0:00 は数えない。
7. **整備**: 周期 12 回、格納庫 1 棟 = 1 機/晩（`maxSize` 以下）、整備施設 = `bays × 0.5` 機/晩（S・M のみ）。不具合の確率 `min(0.6, 0.3 × 超過率)`、遅れ 30〜120 分、超過率 1 以上で不具合の 30% が欠航。整備中の機体は滞泊のスポットに置いたまま（牽引しない）。
8. **拠点の撤退**: 条件を満たさない日が 3 日連続、または既存の満足度による撤退。影響は評価 −5・満足度 30。
9. **国際の区域**: 新しい区域は 2 つ。乗継は全員が乗継保安検査を通る（docs/41 §8 の 3 への回答）。乗継旅客は税関を通らない。
10. **計画に使う MCT**: 種類ごとに使えるゲートの組の最大値、5 分単位の切り上げ、最小 30 分。乗継の上限 240 分。経路がない種類は計画しない。
11. **乗継の割当**: 契約ごとの `transferShare`（既定 0、提案で 0.1〜0.3）。同じ会社、または両方の契約に割合がある会社の間だけ。空席に比例して配り、地元の旅客は減らさない。
12. **区間能力**: レイアウトの設定で opt-in。既定の能力は一般道路 `lanes × 900` 台/時、鉄道 単線 4・複線 12 本/時、駅 `platforms × 6` 本/時（既定 2 面）。能力のない歩行路は未算出（上限なし）。4-12 は区間モデルのときだけ適用する（明示能力のある既存データの結果を変えないため。docs/41 §8 の 5 への回答）。


## 12. 実装状況・未検証事項（2026-11-18）

- 状態: **実装完了・受入検証継続**。4-01〜4-09、4-11〜4-14は実装済み。保存形式は6。機能仕様の正本は[docs/44](../../44_hub_and_international.md)。
- 実装済みテスト: unlocks、overnight、basedAirline、maintenance、accessSegments、intlZones、validation.intl、international、MCT、transfer、transferBags、hubBank、projectFormat6等。個別件数・全体テスト履歴は[docs/42 §3.3](../../42_implementation_roadmap.md)を参照。
- 未検証: 4-03朝の波・4-10バンクの区間走行での受入再計測、および2ターミナルの波の完了。乗継の単体テストは単一ターミナルが中心で、連絡設備の利用率は集計蓄積までで画面表示が未実装。
- 全体テスト: 2026-11-18の分割実行で1163件合格・10件失敗という当時の記録がある。失敗内訳の既知ゴールデンG-1は、その後のSIM_MODEL_VERSION 10.5・10.6への版上げと再取得で解消。残る速度/制限時間の扱いは当時の実行環境条件を含め[docs/42 §3.3・§5.2](../../42_implementation_roadmap.md)に記録する。
- 完了条件: 上記の受入計測・2ターミナル波の検証、必要な仕様/テストの更新、および品質ゲートの確認が終わるまで`completed/`へ移さない。
