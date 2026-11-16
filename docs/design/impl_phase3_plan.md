# フェーズ 3 実装計画: 航空会社の輸送人員と、拡張できる就航都市データ（3-01〜3-10）

作成 2026-11-16。要件と完了条件は docs/42 §3.2 が正。本書は「どこを・どう変えるか」と既定値を定める。数値はすべて**ゲーム内の値**で、実在の統計・予測ではない。
行番号ではなく関数名で参照する（フェーズ 1 の作業が同じ作業ツリーで進行中のため）。

## 0. 現状（調査結果）

- 登録データは `src/core/economy/registry.ts` の配列 `AIRLINES`（8 社: SK NP RJ AQ HB AS NW ML）・`DESTINATIONS`（21 都市）・`COUNTRIES`・`REGIONS`。参照は `airlineDef(id)!` / `destinationDef(id)!`（非 null 断言。未知 ID で undefined が流れる）。
- 搭乗率: `planning.ts loadFactor()` = 基本(会社種別) × `passengerDemand` × 料金 × 評価 × アクセス × 揺らぎ、[0.15, 1]。**便数・座席数に依存しない**（docs/39 T4）。
- 都市: `city.ts cityDemandCeiling()`。`planDayWithDemand()` が `expectedPassengers()` との比で係数を掛ける（docs/31）。
- **乱数の注意**: `generateOffers()` は `c.rng` から `rng.int(0, dests.length-1)` で就航先を選び、`AIRLINES` の順に回る。都市・会社を 1 件足すだけで**既存ゲームの提案の乱数列が変わる**。→ 既存データの挙動を守るには「旧来の項目集合と順序」を固定する必要がある（§2）。
- 全会社ループ: `createCompany`/`defaultFleets`、`generateOffers`、`updateContracts`、`airlineScorecard`、`stepAirlineEval`、`checkAirlineEval`（ID 集合の検証）。
- 便の記録 `analytics/records.ts FlightRecord` は `seats / paxBooked / paxBoarded / paxMissed / paxArrived / contractId / airlineId` を持つ（表示の集計元に使える）。
- 塗装: `assets/registry.ts LIVERIES`（8 社）＋ `DEFAULT_LIVERY`、`liveryOf()` で既定に落ちる。
- 読み込み: `io/project.ts checkCompany()` は契約の airlineId/destinationId の**存在を検証していない**。
- UI の列挙: `ManagementPanels.tsx`（AIRLINES）、`CapacityPanel.tsx`（AIRLINES・DESTINATIONS の select）、`CatalogPanel.tsx`（AIRLINES）、ほか `airlineDef/destinationDef` を表示に使う `DayReview.tsx`・`operate/*`・`FidsOverlay.tsx`。`core/sim/simulation.ts` の局所定数 `AIRLINES = ['SK','NP','RJ','AQ']`（会社なしの自由運航用。対象外・変更しない）。

## 1. データの構成（3-01・3-02）

### 1.1 ファイル

```
src/core/data/
  types.ts         … 入力の型（DestinationInput / AirlineInput）と構築後の型（DestinationDef / AirlineDef）
  define.ts        … defineDestination / defineAirline（既定値の補完のみ。恒等に近い純関数）
  countries.ts     … COUNTRY_DATA / REGION_DATA（registry.ts から移動）
  destinations.ts  … DESTINATION_DATA: DestinationInput[]   ← 都市を足すのはここだけ
  airlines.ts      … AIRLINE_DATA: AirlineInput[]           ← 航空会社を足すのはここだけ
  validate.ts      … validateCatalog(raw) → CatalogIssue[]、formatIssue()
  index.ts         … buildCatalog(raw) → Catalog（検証して不正なら CatalogError を投げる）、CATALOG（既定データで構築）
                     ID_ALIASES、LEGACY_AIRLINE_IDS / LEGACY_DESTINATION_IDS（順序つきの固定リスト）
```
`src/core/economy/registry.ts` は**互換の窓口**として残し、`AIRLINES`・`DESTINATIONS`・`COUNTRIES`・`REGIONS`・`airlineDef`・`destinationDef`・`classifyRoute`・`routeAvailability` 等を `CATALOG` から再輸出する（既存の import を壊さない）。core 以外（UI）は registry か data/index を使う。data は economy に依存しない（AircraftTypeId と機種表 `AIRCRAFT_TYPES` の参照のみ）。

### 1.2 型（入力）

```ts
export type Unlock = {
  minRating?: number;      // 空港評価 0〜100。既定 0（旧 minimumAirportRating）
  minTier?: number;        // 空港の格 0〜5。既定 0。フェーズ 4（4-01）で game.goals 有効時のみ判定。3 では保持と検証だけ
};
export interface DestinationInput {
  id: string;              // 必須。/^[A-Z][A-Z0-9]{2}$/。保存データの参照キー（変えない）
  name: string;            // 必須。表示名
  countryId: string;       // 必須。COUNTRY_DATA に存在。国内/国際の別は HOME_COUNTRY_ID との比較で導出（scope は構築後に付く）
  distanceKm: number;      // 必須。50〜20,000 km（自空港からのゲーム上の距離）
  population: number;      // 必須。都市規模（人）。1,000〜40,000,000
  regionId?: string;       // 既定: 国の regionId
  coordinates?: { latitude: number; longitude: number }; // 既定なし（表示用。-90〜90 / -180〜180）
  demand?: { business?: number; leisure?: number; cargo?: number }; // 各 0.1〜3.0、既定 1.0
  congestion?: number;     // 相手空港の混雑度 0〜1、既定 0.3（提案の便数上限に効く §3.4）
  unlock?: Unlock;
  passengerDemand?: number;// 旧モデルの需要係数 0.3〜2.0。legacy 項目は必須、新規項目は既定 1.0
  legacy?: true;           // フェーズ 3 以前からある項目（旧ルールの会社でも使う）。新規項目には付けない
  retired?: true;          // 新規の提案・一覧に出さないが、既存契約の参照は解決できる（削除の代わり）
}
export interface AirlineInput {
  id: string;              // 必須。/^[A-Z][A-Z0-9]$/（2 文字）
  name: string;            // 必須
  type: 'fullService' | 'lcc' | 'regional'; // 必須
  services: ('domesticPassenger' | 'internationalPassenger' | 'cargo')[]; // 必須。1 件以上
  fleet: { typeId: AircraftTypeId; seats: number }[];  // 必須。1 件以上。機種は AIRCRAFT_TYPES に存在、座席 1〜機種の maxPax
  code?: string;           // 便名の接頭辞。既定 = id
  baseLoadFactor?: number; // 採算の基準搭乗率 0.3〜0.95。既定 種別: fullService 0.78 / lcc 0.86 / regional 0.70（BALANCE.demand.baseLoadFactor）
  fareLevel?: number;      // 運賃水準 0.5〜2.0。既定 fullService 1.0 / lcc 0.7 / regional 0.9
  priceSensitivity?: number; // 0〜1。既定 fullService 0.3 / lcc 0.8 / regional 0.5
  minOtp?: number;         // 求める定時率 0.5〜0.99。既定 fullService 0.82 / lcc 0.7 / regional 0.75
  canBase?: boolean;       // 拠点にできるか（4-04 用。3 では保持と検証のみ）。既定 false
  unlock?: Unlock;
  livery?: { body: number; tail: number; stripe: number; engine: number }; // 0x000000〜0xffffff。省略時 §1.5
  legacy?: true;  retired?: true;  // 都市と同じ意味
}
```
構築後の `DestinationDef` は既存の型に `population, demand(全キー補完), congestion, unlock(補完), scope: 'domestic'|'international', legacy: boolean, retired: boolean` を足したもの。既存フィールド `minimumAirportRating` は `unlock.minRating` から**同値で**埋めて残す（既存コード・テストの互換）。`AirlineDef` も同様（`minimumAirportRating` を残す）。

### 1.3 例

```ts
// destinations.ts — 国内（最小 5 行）
defineDestination({ id: 'KCZ', name: '高知', countryId: 'JP', distanceKm: 560, population: 320_000 }),
// 国際（項目を全部書いた例）
defineDestination({
  id: 'PUS', name: '釜山', countryId: 'KR', distanceKm: 980, population: 3_300_000,
  demand: { business: 0.9, leisure: 1.3, cargo: 0.8 }, congestion: 0.4,
  coordinates: { latitude: 35.18, longitude: 129.08 }, unlock: { minRating: 70, minTier: 2 },
}),
// airlines.ts
defineAirline({
  id: 'TB', name: 'ツバメエア', type: 'lcc', services: ['domesticPassenger'],
  fleet: [{ typeId: 'A320neo', seats: 186 }, { typeId: 'B737-8', seats: 189 }],
  baseLoadFactor: 0.85, fareLevel: 0.65, unlock: { minRating: 55 },
  livery: { body: 0xffffff, tail: 0xf97316, stripe: 0x1e3a8a, engine: 0xe5e7eb },
}),
```

### 1.4 解放の条件・国内/国際

- `unlock.minRating`: 現行どおり `c.rating >= minRating` で提案候補・新規参入を許す（`generateOffers` の 2 か所）。
- `unlock.minTier`: フェーズ 3 では判定しない（保持・検証のみ）。4-01 で `goals` 有効時に `goals.tier >= minTier` を足す。
- 国内/国際: `scope = countryId === HOME_COUNTRY_ID ? 'domestic' : 'international'`（`classifyRoute` と同じ）。国際は `routeAvailability` の `internationalPassengerProcessing=false` で現行どおり提案されない（3-10 の条件。4-03/4-06 で解除）。

### 1.5 塗装の既定

`liveryOf(id)`: ① `assets/registry.ts LIVERIES[id]`（既存 8 社、値は変えない）→ ② `CATALOG` の航空会社の `livery`（`id: 'liv-' + id.toLowerCase()` を付けて返す）→ ③ `DEFAULT_LIVERY`。assets → core/data の依存は core 内なので可。

### 1.6 拡張の手引き（3-09）

新規文書 **`docs/43_data_extension_guide.md`**: 「都市を足す」「航空会社を足す」「機種を足す（`aircraft/catalog.ts AIRCRAFT_MODELS` の既存手順を参照）」「削除せず retired にする」「ID を変えるときは ID_ALIASES」「legacy を付けてはいけない理由（旧ゲームの提案の乱数列が変わる）」「検証エラーの読み方」「`npx vitest run tests/unit/catalog*.test.ts` で確認」。項目表は §1.2 を正とし、同じ表を docs/31 等に複製しない。

## 2. 移行・互換（3-08）

### 2.1 ID の対応

| 現行 | 新データ | 変換 |
|---|---|---|
| AIRLINES 8 社（SK NP RJ AQ HB AS NW ML） | `AIRLINE_DATA` の先頭 8 件、**同じ順**、`legacy: true` | 値は逐語移動。`minimumAirportRating`→`unlock.minRating`。`baseLoadFactor` 等は**書かない**（既定＝種別値で旧と同値） |
| DESTINATIONS 21 都市 | `DESTINATION_DATA` の先頭 21 件、同じ順、`legacy: true` | `passengerDemand`・`cargoDemand`（→`demand.cargo`）・座標・距離は逐語。`population`・`demand.business/leisure`・`congestion` を追加（§7、旧ルールでは未使用） |
| COUNTRIES 9・REGIONS 10 | `countries.ts` へ移動、順序維持 | 新規国（CN PH VN MY US AU）を末尾に追加 |

`ID_ALIASES: Record<string, string> = {}`（初期は空）。`resolveAirlineId/resolveDestinationId` が別名→正 ID を返す。`importCompany()` で契約・`airlines`・`fleets`・`airlineEval` のキーに適用（別名がなければ何もしない＝現行データは不変）。

### 2.2 存在しない ID

- `airlineDef/destinationDef` は現行の非 null 契約を保つ。新たに `findAirline/findDestination(id): Def | undefined` を追加。
- `io/project.ts checkCompany()` に検証を追加: 別名解決後も存在しない ID を持つ契約は  
  `会社: 契約 K12 の就航先 "XYZ" が登録データにありません（retired にするか ID_ALIASES に対応を追加してください）` のエラー（読み込みを止める。既存の検証の流儀に合わせる）。
- 削除は推奨しない: `retired: true` は解決可能・提案と一覧からは除外。出荷データ同梱の削除は禁止（テストで旧 ID 全件の解決を固定）。

### 2.3 新しい設定（opt-in）

`company.city` と同じく会社直下の任意項目:
```ts
// src/core/economy/market.ts
export interface MarketSettings {
  version: 1;
  /** 契約ごとの搭乗率の移動平均と、低迷/好調の連続日数（3-06） */
  routes: Record<string /*contractId*/, { lfEma: number; lowDays: number; highDays: number }>;
}
// CompanyState に追加
market?: MarketSettings;
```
- 有効化: 新規ゲーム設定（`src/ui/GameSetup.tsx`）に「路線需要モデル」チェック。**`city` 必須**（チェック時に都市設定も有効にする）。`startGame` 相当の生成時に `market = { version: 1, routes: {} }`。
- 検証: `checkMarket(raw): string[]`（market.ts）。`checkGameFields` と同じく `io/project.ts checkCompany()` から呼ぶ。`market` があり `city` がない → `会社: 路線需要（market）には都市設定（city）が必要です`。`importCompany()` は寛容に、不正な market を削除（`city` 不正時の流儀と同じ）。
- `market` がない保存データ: 旧ルールそのまま（旧 `loadFactor`、旧 `expectedPassengers`、`legacy` 項目のみ、旧の重み表）。
- 会社の版 `version: 1` は変えない（任意項目の追加のみ。city/game と同じ扱い）。sim-versions の扱いは §10 Q3。

### 2.4 項目集合の切り替え（決定性の要）

```ts
airlinesFor(c)     = c.market ? 全(非retired) : legacy かつ非retired   // 順序はデータの順
destinationsFor(c) = 同上
```
`createCompany/defaultFleets`（market 未確定のため常に legacy）、`generateOffers`、`updateContracts`、`airlineScorecard`、`stepAirlineEval` のループを `airlinesFor(c)` に置き換える。`checkAirlineEval` の ID 集合は全 ID（retired 含む）。→ market なしの会社では反復対象・順序・乱数消費が現行と同一。

### 2.5 ゴールデンへの影響

- 期待: **影響なし**（ゴールデンの会社は market を持たない）。`golden.gameModels` / `golden.gameWeather` / 他は「フェーズ 1 後の基準と同じ合否」であることを確認（docs/42 §5。現状の不一致を本作業で増やさない）。
- 追加の固定テスト: `tests/unit/catalogLegacy.test.ts` が、旧 registry の 8 社・21 都市・国・地域の値を**テスト内に逐語で写した表**と、`airlinesFor(legacy会社)` 等の出力（順序・旧フィールド）を deepEqual 比較。これが崩れると旧ゲームの提案が変わる。

## 3. 需要モデル（3-04・3-05。`market` 有効時のみ）

新規 `src/core/economy/demand.ts`（純関数・決定的・新しい乱数列なし）。

### 3.1 路線の 1 日の需要（往復、人/日）

```
D_r = K × (P_o/1e6)^α × (P_d/1e6)^β × I_d × g(d) × φ_r × A × F × R
  P_o = c.city.population, P_d = destination.population
  I_d = 0.55 × business + 0.45 × leisure
  g(d) = min(1, 0.4 + 0.6 × d/600) × exp(-max(0, d − 1000)/6000)   // 短距離は陸上交通と競合、長距離は減衰
  φ_r = 1（国内）/ 0.6（国際）
  A = 0.7 + 0.3 × clamp((access − 0.3)/0.8, 0, 1)                    // cityDemandCeiling と同じ正規化
  F = 1 − (fees.terminal − 1) × BALANCE.feeSensitivity.loadFactorPerRatio
  R = ratingFactorMin + (ratingFactorMax − ratingFactorMin) × rating/100   // 旧 loadFactor と同じ
  K = 600, α = 0.6, β = 0.4（定数は BALANCE.market に置く）
```
「需要がある路線」= 当日有効な契約がある就航先の集合 S（routeAvailability が available のもの）。

### 3.2 都市の需要上限との関係（docs/31）

```
C = cityDemandCeiling(city, access) × event.demandMultiplier
ΣD = Σ_{r∈S} D_r;  D'_r = D_r × min(1, C/ΣD)
```
→ 路線需要の合計は常に C 以下。`planDayWithDemand` の旧係数 `cityFactor` は market 有効時は使わない（二重に絞らない）。

### 3.3 便・会社への配分と搭乗率

- 路線 r の座席（往復）: `S_r = Σ_{契約 k∈r} perDay_k × seats_k × 2`
- 会社の魅力 `q_a = typeAppeal × (1 + 0.3 × priceSensitivityOfMarket × (1 − fareLevel))`, typeAppeal: fullService 1.0 / lcc 1.05 / regional 0.95。`priceSensitivityOfMarket = 0.45 × leisure 比 + 0.15`（I_d の構成比から）。
- 路線の基準搭乗率 `L_r = D'_r / S_r`
- 契約 k の搭乗率 `L_k = clamp(L_r × q_k / q̄_r, LF_MIN=0.10, LF_MAX=0.98)`, `q̄_r` は座席加重平均 → クランプがなければ `Σ seats×L_k = D'_r`（保存）。
- 便の旅客 `arrPax/depPax = round(seats × clamp(L_k × (1 + noise × (2u − 1)), 0, 1))`。`u` は現行どおり `planDay` 内の便ごとの `Rng(\`${seed}:${k.id}:${day}:${i}\`)` の同じ位置の 2 回の `rng.next()`（消費順・回数を変えない）。noise = 0.08。
- 最後の保護: 計画の旅客合計 > C なら全便に `C/合計` を掛けて再丸め（下限 LF_MIN を割ってよい）。→ 3-04「合計が上限を超えない」を不変条件として保証。
- 実装: `planDay` に任意引数 `paxModel?: (k, u) => number`（搭乗率を返す）を追加し、`planDayWithDemand` が market 有効時に `demand.ts routeLoadFactors(c, day, access, types, caps)` の結果で作る。market なしは引数なし＝現行コードパス。

### 3.4 混雑度

`congestion` は提案の便数上限にだけ効く: `maxPerDay' = max(1, round(maxPerDay × (1 − 0.5 × congestion)))`（market 有効時）。

### 3.5 city がない場合

market は city 必須（§2.3）。万一 city なしで market が来た場合（API 直接）は market を無視し旧ルール（`demand.ts` は `null` を返し、呼び出し側は旧パス）。

### 3.6 計算例（地方都市、アクセス 1.0、料金 1.0、評価 50）

P_o=0.3（地方の既定）→ 0.3^0.6=0.486。A=0.7+0.3×0.875=0.9625。R=0.75+0.4×0.5=0.95。F=1。
- TYO（P_d=14.0, business 1.4/leisure 1.0 → I=1.22, d=760 → g=1）: 600×0.486×2.874×1.22×1×0.9625×0.95 ≈ **934 人/日**
- KTA（P_d=0.5→0.758, I=1.0, d=450 → g=0.85）: 600×0.486×0.758×1.0×0.85×0.9625×0.95 ≈ **172 人/日**
- 上限 C = 300,000×0.004×exp(−10/60)×0.9625 ≈ 978。ΣD=1,106 > C → 係数 0.884 → TYO 826、KTA 152。
- KTA を RJ（70 席）×1 便/日 → S=140 → L=1.09→0.98（クランプ。需要あふれ）。2 便/日 → S=280 → L=0.54（便を倍にすると搭乗率が下がる＝3-04）。
- TYO を SK B787-9（266 席）×1 便 → S=532 → L=0.78。B777-300ER（316）に大型化 → L=0.65（3-05）。

## 4. 航空会社の採算評価（3-06）

### 4.1 評価要素「需要（搭乗率）」

- `airlineScore.ts`: `ScoreKey` に `'demand'` を追加。`SCORE_KEYS` は**変えない**（旧 7 要素）。`SCORE_KEYS_V2 = [...SCORE_KEYS, 'demand']`、`scoreKeysFor(c) = c.market ? V2 : V1`。`airlineScorecard` は market 有効時のみ demand 要素を作る。
- 値: `LF_a = Σ(paxBooked(出発) + paxArrived(到着)) / Σ(seats × 2)`（その会社の当日の便記録。欠航便は分母から除く）。目標 `T_a = baseLoadFactor`。  
  `score = clamp(60 + (LF_a − T_a) × 200, 0, 100)`、level: good ≥70 / warn 45〜70 / bad <45、便なしは n/a。
- 重み表の版: `EVAL_WEIGHTS`（v1、現行のまま）と `EVAL_WEIGHTS_V2`（各行で v1 の 7 要素 ×0.8、demand 0.2。合計 1）:

| 種別 | otp | turn | stand | fees | slots | aircraft | pax | demand |
|---|---|---|---|---|---|---|---|---|
| regional | .24 | .08 | .12 | .12 | .08 | .08 | .08 | .20 |
| lcc | .24 | .12 | .08 | .20 | .08 | .04 | .04 | .20 |
| fullService | .24 | .04 | .12 | .08 | .08 | .12 | .12 | .20 |

  `evalWeightsFor(c)`、`evalDelta(type, ema, weights = EVAL_WEIGHTS)` に引数追加（既定で現行と同値）。`stepAirlineEval` の `SCORE_KEYS` ループは `scoreKeysFor(c)` に。`checkAirlineEval` の要素名集合は V2（'demand' を許す。v1 の保存データは 'demand' を持たないので結果不変）。

### 4.2 路線の判断（要望と実行）

`market.ts stepMarket(c, records)`（ops.ts 日次締めで `updateContracts` の直前、market 有効時のみ。airlineEval の有無に依存しない）:
- 契約ごと `lfEma ← 0.7 × lfEma + 0.3 × LF_k(当日)`（初期値 = 初日の LF）。
- 低迷: `lfEma < T_a − 0.20` の日が続くと `lowDays++`（以上で 0）。好調: `lfEma > max(0.85, T_a + 0.10)` かつ `L_r(需要/座席) ≥ 1.0` で `highDays++`。
- 結果（イベントログに理由つき）:
  - `lowDays ≥ 5` かつ perDay > 1 → **減便**（perDay −1、lowDays=0）「XX 航空が搭乗率の低迷で ○○線を 1 便減らしました」
  - `lowDays ≥ 10` かつ perDay = 1 → **撤退**（status 'withdrawn'）
  - `highDays ≥ 5` → **要望**を立てる（`signal: 'grow'`）。契約の更新時（`updateContracts` の満了処理）に market 有効なら: 増便の条件を `既存の条件 AND signal==='grow'` に、増便が上限（§3.4 の maxPerDay'）に達していれば保有機材で座席が次に大きく、`operable` に含まれる機種へ**大型化**（`changeContractAircraft`）。`updateContracts` に任意引数 `operable?` を追加。
  - market 無効時は `updateContracts` の現行動作を一切変えない（増便条件も現行のまま）。
- 状態は `market.routes[contractId]`（契約が active でなくなったら削除）。

### 4.3 提案（generateOffers）

market 有効時のみ:
- 候補都市 = `destinationsFor(c)` ∩ 解放 ∩ routeAvailability ∩ 未就航。選択は一様ではなく `未充足需要 w = max(0.05, D_r − S_r(既存座席))` の重みで、`rng.next()` 1 回の累積比較（c.rng の消費回数は旧と同じ 1 回）。
- 機種: 旧ロジックで候補を作り、`w` に最も近い `seats × perDay × 2` の組を選ぶ（追加の乱数なし）。
- market 無効時は現行コードパス（一様選択）。

## 5. 表示（3-07）

集計は core の純関数 `src/core/economy/traffic.ts`:
- `trafficByAirline(records, contracts): Record<airlineId, {flights, seats, pax, lf}>`、`trafficByRoute(...)`（destinationId は contractId 経由で解決）。pax = 出発 paxBooked + 到着 paxArrived、seats = 便の座席 × 方向数。欠航便は除く（件数は別に持つ）。
- `previewLoadFactor(c, offerOrContract, access): { routeDemand, seats, lf } | null`（market なしは旧 `loadFactor` の u=0.5 の期待値を返す）。

UI（実装者 B）:
| 画面 | 追加 | testid |
|---|---|---|
| ManagementPanels 契約表 | 列「座席/日」「見込み旅客」「見込み搭乗率」 | `contract-seats-${id}` `contract-lf-${id}` |
| ManagementPanels 提案表 | 列「見込み搭乗率」「路線需要」 | `offer-lf-${id}` `offer-demand-${id}` |
| ManagementPanels 新節「輸送実績（前日）」 | 会社別・路線別の旅客/座席/搭乗率の表 | `traffic-airlines`, `traffic-airline-${id}`, `traffic-routes`, `traffic-route-${destId}` |
| DayReview | 節「輸送人員」（会社別表＋低迷/好調の要望） | `review-traffic`, `review-traffic-${airlineId}`, `review-route-signal-${contractId}` |
| CapacityPanel 仮想契約チェック | 見込み搭乗率・路線需要 | `capacity-preview-lf` |
| AirlineScoreTable | demand 列（market 時のみ） | 既存の要素列の testid 規則に従う |
- 一覧（select・表）は `airlinesFor(c)`・`destinationsFor(c)` を使う（retired・非対象を出さない）。`CatalogPanel` の AIRLINES も同様。
- 表示文言は既存の文言定義（`GAME_UI`/`DAY_LOOP` 等）に追加。

## 6. 検証（3-03）

`validate.ts validateCatalog(raw): CatalogIssue[]`、`CatalogIssue = { kind: '就航都市'|'航空会社'|'国'|'別名'; id: string; field: string; message: string }`。
文の形式（固定）: **`[<kind> <id>] <field>: <理由>（<期待>）`**。例:
- `[就航都市 TYO] id: 重複しています（2 件目: 9 番目の項目）`
- `[就航都市 KCZ] population: 範囲外の値 -5（1,000〜40,000,000）`
- `[就航都市 XYZ] countryId: 国 "QQ" が COUNTRY_DATA にありません`
- `[航空会社 TB] fleet[1].typeId: 機種 "B999" が機種表にありません`
- `[航空会社 TB] fleet[0].seats: 座席 240 が機種 A320neo の最大旅客数 220 を超えています`
- `[別名 OLD] → NEW: 別名の先の ID がありません`

検査項目: ID の形式・重複（都市内・会社内・会社 code 重複）、name 空、countryId/regionId の存在、距離・人口・指数・混雑度・解放条件（rating 0〜100、tier 0〜5 の整数）・基準搭乗率・運賃・敏感さ・定時率の範囲（有限数か）、services 空・未知値、fleet 空・機種の存在・座席範囲、塗装色の範囲、legacy 項目が passengerDemand を持つ、legacy の ID と順序が `LEGACY_*_IDS` と一致、retired と legacy の両方は可、ID_ALIASES の元が既存 ID と衝突しない・先が存在する、国際の都市（scope）で `services` に internationalPassenger を持つ会社が 1 社以上あるか（警告扱いの issue `level: 'warn'`）。
実行場所: `data/index.ts` のモジュール読み込み時に `buildCatalog(既定データ)` が **常に** 実行（50 件程度で軽い。不正なら `CatalogError`（全 issue を改行で連結）を投げて起動時に原因が出る）。テスト `tests/unit/catalogValidation.test.ts` で出荷データが issue 0 件（warn 含め 0）。

## 7. 初期データ（3-10。すべてゲーム値）

人口・指数はゲームの調整値で実統計ではない（ファイル冒頭とガイドに明記）。距離は自空港（架空）からのゲーム上の距離。B=業務、L=観光。

**旧来 21 都市（legacy、追加する値）**
| ID 名前 | 人口 | B/L | 混雑 |
|---|---|---|---|---|
| TYO 東京 | 14,000,000 | 1.4/1.0 | 0.8 |
| OSA 大阪 | 8,800,000 | 1.2/1.1 | 0.6 |
| TWN 東湾市 | 2,400,000 | 1.2/0.9 | 0.4 |
| SPK 札幌 | 1,950,000 | 1.0/1.2 | 0.4 |
| FUK 福岡 | 1,600,000 | 1.1/1.0 | 0.6 |
| HSM 星見 | 1,100,000 | 1.0/1.0 | 0.3 |
| AOS 青島 | 900,000 | 1.0/1.1 | 0.3 |
| OKA 那覇 | 800,000 | 0.6/1.6 | 0.5 |
| KTA 北港 / NSH 西浜 | 500,000 / 450,000 | 1.0/1.0, 0.9/0.9 | 0.2 |
| YKH 雪原 / KRG 霧ヶ丘 / MSK 南岬 | 350,000 / 300,000 / 250,000 | 0.7/1.2, 0.8/0.8, 0.6/1.3 | 0.2 |
| SEL ソウル / TPE 台北 / HKG 香港 | 9,700,000 / 7,000,000 / 7,400,000 | 1.2/1.2, 1.0/1.3, 1.4/1.1 | 0.7/0.6/0.8 |
| SIN / BKK | 5,900,000 / 10,500,000 | 1.4/1.0, 0.9/1.5 | 0.7/0.7 |
| NDB / BNH / LUM（架空国） | 1,800,000 / 1,200,000 / 2,500,000 | 1.0/0.9, 1.1/0.8, 0.7/1.2 | 0.4/0.3/0.4 |

**追加 16 都市（market 有効時のみ）** — 国内（規模別）
| 区分 | ID 名前 距離km 人口 B/L unlock |
|---|---|
| 大 | NGO 名古屋 380 7,500,000 1.3/0.9 rating 55 |
| 中 | SDJ 仙台 620 1,500,000 1.0/1.0 r50；HIJ 広島 430 1,400,000 1.0/1.0 r50 |
| 小 | KOJ 鹿児島 980 600,000 0.8/1.2；KMQ 小松 300 450,000 0.9/0.9；NGS 長崎 1,000 400,000 0.7/1.3；MYJ 松山 520 500,000 0.8/1.0；HKD 函館 900 250,000 0.6/1.4 |
| 離島 | ISG 石垣 1,950 50,000 0.3/2.0 |
国際（地域別。既存と同じく rating 70〜90、4-03 まで提案されない）
| 地域 | ID 名前 距離 人口 unlock |
|---|---|
| 東アジア | PUS 釜山 980 3,300,000 r70；SHA 上海 1,700 24,000,000 r75 |
| 東南アジア | MNL マニラ 2,900 13,000,000 r75；HAN ハノイ 3,600 8,000,000 r80；KUL クアラルンプール 5,200 7,800,000 r80 |
| 太平洋 | HNL ホノルル 6,300 1,000,000（L 2.2）r85；SYD シドニー 7,600 5,200,000 r90 |
新しい国: CN 中国/east-asia、PH・VN・MY/southeast-asia、US・AU（地域 `pacific` 太平洋を REGION_DATA に追加）。合計 37 都市。

**追加の架空航空会社（market 有効時のみ。実在の社名・塗装は使わない）**
| ID | 名前 | 種別 | services | fleet | 基準LF/運賃 | unlock |
|---|---|---|---|---|---|---|
| TB | ツバメエア | lcc | 国内 | A320neo 186, B737-8 189 | 0.85/0.65 | r55 |
| IL | アイランドリンク | regional | 国内 | ATR72-600 70, regional70 70 | 0.65/1.0 | r45 |
| OX | オーシャンクロス航空 | fullService | 国内・国際 | A321neo 194, A350-900 300, B787-9 280 | 0.80/1.1 | r75 |
塗装: TB は §1.3 の値、IL・OX は `livery` 省略（既定塗装で表示されることのテスト対象を兼ねる…OX は塗装を付け、IL のみ省略）。

## 8. 要件ごとの変更とテスト

テストは原則 `tests/unit/`。シードは各テストに定数で記す。

| ID | 変更（ファイル/関数） | テスト（正常/境界/異常/回帰） | 受入（docs/42） |
|---|---|---|---|
| 3-01 | `src/core/data/*` 新設、registry.ts を窓口化、`destinationsFor`、UI 一覧の差し替え | `catalogExtension.test.ts`（下記）、`catalogLegacy.test.ts`（回帰: 旧 21 都市・順序・値）、境界: 最小 5 行の項目が既定値で補完 | 試験都市が提案候補・計画・一覧に出る／全データ検証 OK |
| 3-02 | `airlines.ts`、`airlinesFor`、`liveryOf` の 3 段階 | 同上（試験会社）、`assets.test.ts` に「livery 未定義→DEFAULT_LIVERY」「data livery が使われる」「既存 8 社は LIVERIES のまま」 | 試験会社が出る／既定塗装 |
| 3-03 | `validate.ts`、`buildCatalog` | `catalogValidation.test.ts`: 出荷データ 0 件。異常: 重複 ID、未知国、未知機種、座席超過、人口 0・負・NaN・Infinity、indices 3.01、unlock.rating 101・tier 1.5、空 fleet/services、legacy 順序の入れ替え、別名の先なし。各ケースで `field` と ID を含む文、`buildCatalog` が CatalogError | 該当項目名を含むエラー |
| 3-04 | `demand.ts routeDemand/routeLoadFactors`、`planDayWithDemand` の分岐、`planDay` の `paxModel` | `demand.test.ts`: 人口↑で D↑（単調）、便数 2 倍で LF↓、大型化で LF↓、距離 0 付近・20,000 の有限性、ΣD' ≤ C（シード 20 個×契約構成ランダム、seed 記録）、計画合計 ≤ C（最終保護）、city なし market→旧パス、event 倍率 | 3 条件 |
| 3-05 | `planDay`（便の旅客）、sim の生成は `plannedPax` を使う（`simulation.ts` の plan→`plannedPax` 経路を**確認のみ**。食い違えば報告） | `paxConservation.test.ts`: market 会社で 1 日運航し、完了便で `plan.depPax === record.paxBooked`（許容差 0）、`paxBooked = paxBoarded + paxMissed`、欠航便は booked を欠航分として集計、到着 `arrPax === paxArrived`（ダイバート除く）。旧会社でも同じ等式が成り立つこと（回帰） | 計画=生成、旅客の保存 |
| 3-06 | `airlineScore.ts`（demand 要素、`scoreKeysFor`）、`airlineEval.ts`（`EVAL_WEIGHTS_V2`、`evalWeightsFor`、`evalDelta` 引数、`checkAirlineEval` の要素名）、`market.ts stepMarket`、`company.ts updateContracts(…, operable?)`・`generateOffers` 重み選択、`ops.ts` 締めでの呼び出し | `marketEval.test.ts`: LF が T−0.21/T−0.19 の境界で lowDays の増減、5 日で減便、10 日で撤退、high 条件で更新時の増便/上限時の大型化（operable 外は大型化しない）、score の境界（LF=T→60）。回帰: market なし＋airlineEval ありの会社で `stepAirlineEval`・`updateContracts` の結果が変更前と一致（`airlineEvalGoals.test.ts` 既存テストが無変更で合格＋golden game-models） | 閾値で要望が変わる／既存設定は不変 |
| 3-07 | `traffic.ts`、UI（§5） | `traffic.test.ts`: 便記録の手計算と一致、欠航・ダイバート・0 座席の扱い。E2E `tests/e2e/phase3-traffic.spec.ts`: market ゲームで 1 日運航→振り返りと経営画面の会社別旅客・座席・LF が `window.__store` の記録集計と一致、提案に `offer-lf-*` が出る、コンソールエラーなし | 表示値＝集計 |
| 3-08 | `importCompany`（別名適用・market 寛容削除）、`checkCompany`（未知 ID、market 検証）、`market.ts checkMarket` | `marketSave.test.ts`: 旧保存（market なし）の読み込み→従来どおり、往復×3 で同一、market の不正形（version 2、routes 非オブジェクト、city なし）でエラー文、未知 ID の契約でエラー文、別名で旧 ID→新 ID、保存→復元→継続 = 連続実行（シード固定）。ゴールデン全件が基準と同じ合否 | 旧保存がそのまま読める／ゴールデン一致 |
| 3-09 | `docs/43_data_extension_guide.md` | `catalogExtension.test.ts` の試験データは手引きの例と同一文字列（手引きのコード片をテストにも置き、差異はレビューで確認） | 手引きどおりで 3-01・3-02 が通る |
| 3-10 | `destinations.ts`・`airlines.ts`・`countries.ts` の追加項目 | 検証 0 件、国際都市は `internationalPassengerProcessing=false` で提案候補に出ない（全 rating・全シード 10 個）、market なしの会社では追加 16 都市・3 社が一切出ない | 検証 OK／国際は 4-03 まで提案されない |

### 8.1 データだけで足すテスト（`tests/unit/catalogExtension.test.ts`）

```ts
vi.doMock('../../src/core/data/destinations', async (orig) => {
  const m = await orig<typeof import('../../src/core/data/destinations')>();
  return { ...m, DESTINATION_DATA: [...m.DESTINATION_DATA, defineDestination({ id: 'TST', name: '試験市', countryId: 'JP', distanceKm: 500, population: 900_000 })] };
});
// airlines も同様に { id: 'ZZ', name: '試験航空', type: 'regional', services: ['domesticPassenger'], fleet: [{ typeId: 'E175', seats: 76 }] }（livery なし）
vi.resetModules(); const { … } = await import('../../src/core/economy/company') など動的 import
```
検証: ① `validateCatalog` 0 件、② market 会社（city=地方、rating 100）で `offerCandidates(c, 'ZZ')`（generateOffers から候補計算を切り出した純関数）に TST が含まれ、`generateOffers` をシード固定で N 日回すと ZZ・TST の提案が出る、③ ZZ→TST の契約を `addContract` して `planDayWithDemand` に便が出て旅客 > 0、④ `airlinesFor/destinationsFor`（UI 一覧の供給元）に含まれる、⑤ `liveryOf('ZZ') === DEFAULT_LIVERY`、⑥ market なしの会社では出ない。テスト中で core のコード（data 以外）を一切差し替えないこと。

## 9. 作業の分割（2 人。ファイル所有は排他）

**実装者 A（core データ・経済）**: `src/core/data/**`、`src/core/economy/{registry,company,planning,city,demand,market,traffic,airlineScore,airlineEval,evalRules,ops,game}.ts`、`src/core/io/project.ts`、`src/core/assets/registry.ts`（liveryOf のみ）、`tests/unit/*`（上記の新規ファイル）。
**実装者 B（UI・文書・E2E）**: `src/ui/{ManagementPanels,DayReview,CapacityPanel,CatalogPanel,GameSetup}.tsx`、`src/ui/operate/cards/AirlineScoreTable.tsx`、文言定義ファイル、`docs/43_data_extension_guide.md`、docs/31・docs/30 §3・docs/14・docs/42 状況欄・README の該当箇所、`tests/e2e/phase3-traffic.spec.ts`。

| # | 担当 | 作業 | 規模 | 依存 |
|---|---|---|---|---|
| A1 | A | `catalogLegacy.test.ts` を**先に**書く（旧 registry の値を逐語で写す）→ 現行コードで合格を確認 | S | — |
| A2 | A | `data/*`（types/define/countries/destinations/airlines/index）へ移動、registry.ts を窓口化。値は逐語。追加項目は legacy に population 等のみ | M | A1 |
| A3 | A | `validate.ts`・`buildCatalog`・`catalogValidation.test.ts` | M | A2 |
| A4 | A | `airlinesFor/destinationsFor`、全ループ差し替え、`findAirline` 等、`liveryOf` 3 段階、`checkCompany` の未知 ID | S | A2 |
| **CP1** | A | typecheck/lint/全 unit/golden が**変更前と同じ合否**。B に型（Def・`airlinesFor`）を引き渡し | — | A1–A4 |
| A5 | A | `market.ts`（型・checkMarket・import/validate 連携）、`marketSave.test.ts` | S | CP1 |
| A6 | A | `demand.ts`、`planDay` の `paxModel`、`planDayWithDemand` 分岐、`demand.test.ts`、`paxConservation.test.ts` | L | A5 |
| A7 | A | demand 要素・V2 重み・`stepMarket`・`updateContracts`/`generateOffers` 分岐・ops 呼び出し・`marketEval.test.ts` | L | A6 |
| A8 | A | `traffic.ts`・`previewLoadFactor`・`offerCandidates`、`traffic.test.ts`、`catalogExtension.test.ts`、3-10 の追加データ | M | A7 |
| **CP2** | A | 品質ゲート 4 種＋監査テスト。golden の合否が CP1 と同じ | — | A8 |
| B1 | B | 手引き docs/43 の下書き（§1.2・§1.3 から）、docs/31 に「路線需要（market）」節、docs/30 §3 に demand 要素と V2 表 | M | CP1（型確定） |
| B2 | B | UI 一覧を `airlinesFor/destinationsFor` に差し替え、GameSetup に market チェック（city 必須） | S | CP1 |
| B3 | B | §5 の表示（traffic・preview の関数を使う。A8 前はモック不要、A8 の関数シグネチャを CP1 時点で合意しスタブ） | M | A8 |
| B4 | B | E2E `phase3-traffic.spec.ts`、既存 E2E（経営画面・振り返り）の関連分を実行 | M | B3 |
| **CP3** | A+B | `npm run typecheck`・`npm run lint`・`npm test`・`npm run build`・`npm run test:e2e`・`npx vitest run -c vitest.audit.config.ts`。docs/42 の 3-01〜3-10 状況欄を更新 | — | 全部 |

対象を絞った実行例: `npx vitest run tests/unit/catalog*.test.ts tests/unit/demand.test.ts tests/unit/market*.test.ts tests/unit/traffic.test.ts tests/unit/routeEligibility.test.ts tests/unit/assets.test.ts tests/unit/economy.test.ts tests/unit/airlineEvalGoals.test.ts tests/unit/golden.gameModels.test.ts`、`npx playwright test tests/e2e/phase3-traffic.spec.ts`。

## 10. リスクと未決事項（既定で解決）

1. **旧ゲームの乱数列が変わる危険**（項目追加・並べ替え）→ legacy フラグと `LEGACY_*_IDS` の順序固定、`catalogLegacy.test.ts`。既定: 新規項目は market 専用。
2. **フェーズ 1 と同じファイル（ManagementPanels・ops.ts・planning.ts）の競合** → フェーズ 1 の完了（docs/42 §5 第 2 段階）後に A6 以降へ着手。A1〜A4 は registry 中心で衝突が小さい。
3. **版の扱い**（sim-versions.json・docs/22）→ 既定: 変更しない（market なしは結果不変、market は新規の opt-in）。PO 確認事項として記録。
4. **K=600 等の定数の妥当性** → 既定値で実装し、ヘッドレス実行（地方/中核/大都市 × 30 日、seed 記録）で平均搭乗率 0.55〜0.85 に入るか確認、外れたら BALANCE.market のみ調整（docs/39 C1 の実測と合わせる）。
5. **city なし market** → 既定: 検証エラー（strict）、寛容読み込みは market を削除。
6. **未知 ID の保存データ** → 既定: 読み込みエラー（理由と対処を文に含む）。出荷データからの削除は禁止、retired を使う。
7. **minTier** → フェーズ 3 は保持のみ。判定は 4-01。
8. **国際都市の需要** → 4-03 まで提案されないため、φ_r=0.6 は計算のみ（表示の見込みも出さない）。
9. **既存 E2E の select 件数・並び** → legacy 会社では一覧不変。market 会社のみ増える。
10. **ScoreKey の拡張で UI の要素列が増える** → market 会社のみ demand 列。既存の 7 列の testid は変えない。
