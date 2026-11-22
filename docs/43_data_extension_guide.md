# 43. データ拡張ガイド（就航都市・航空会社の足し方）

フェーズ 3 で、就航都市と航空会社の登録データを `src/core/data/` に分離した。
都市や会社を足す作業は、原則としてこのフォルダのデータファイルを編集するだけ。
プログラム（需要計算・提案・評価）は登録データを汎用的に読むので、コードの変更は要らない。

国内都市の利用圏人口・航空依存度・必須/観光需要・季節性の初期パラメータ案は [46. 国内就航都市の航空需要特性・初期パラメータ](46_domestic_air_demand_model.md) を参照。docs/46 は設計・校正案であり、現行カタログの型や需要計算に追加済みという意味ではない。現行の型・動作は本書とコードを正とする。

## 1. どこに何があるか

| ファイル | 内容 |
|---|---|
| `src/core/data/destinations.ts` | 就航都市の一覧（`DESTINATION_DATA`） |
| `src/core/data/airlines.ts` | 航空会社の一覧（`AIRLINE_DATA`） |
| `src/core/data/countries.ts` | 国と地域（`COUNTRY_DATA` / `REGION_DATA`） |
| `src/core/data/types.ts` | 入力の型と種別ごとの既定値 |
| `src/core/data/validate.ts` | 検証（範囲・重複・参照の存在）。起動時に必ず走る |
| `src/core/data/index.ts` | 構築（`buildCatalog` / `CATALOG`）、ID の別名（`ID_ALIASES`） |

`src/core/economy/registry.ts` は互換の窓口で、`AIRLINES` / `DESTINATIONS` などはここから再輸出している。

## 2. 就航都市を足す

`destinations.ts` の末尾に `defineDestination({...})` を 1 件足す。

```ts
defineDestination({ id: 'TST', name: '試験市', countryId: 'JP', distanceKm: 500, population: 900_000, coordinates: { latitude: 35.0, longitude: 137.0 }, demand: { business: 1.0, leisure: 1.0 }, congestion: 0.3 }),
```

| 項目 | 必須 | 既定 | 範囲・意味 |
|---|---|---|---|
| `id` | ✓ | — | `/^[A-Z][A-Z0-9]{2}$/`（3 文字）。保存データの参照キー。**後から変えない** |
| `name` | ✓ | — | 表示名 |
| `countryId` | ✓ | — | `COUNTRY_DATA` にある国。`JP` は国内線、それ以外は国際線（scope） |
| `distanceKm` | ✓ | — | 50〜20,000。自空港からのゲーム上の距離 |
| `population` | ✓ | — | 1,000〜40,000,000。需要の規模（ゲームの調整値で、実在の統計ではない） |
| `regionId` | | 国の regionId | 表示の地域 |
| `coordinates` | | 0,0（検証で警告） | 緯度 -90〜90 / 経度 -180〜180。表示用 |
| `demand.business` / `leisure` / `cargo` | | 1.0 | 各 0.1〜3.0。需要の構成（業務・観光・貨物） |
| `congestion` | | 0.3 | 0〜1。相手空港の混雑。提案の便数の上限が `×(1 − 0.5 × congestion)` になる（market 時） |
| `unlock.minRating` | | なし | 0〜100 の整数。提案に必要な空港評価 |
| `unlock.minTier` | | なし | 0〜5 の整数。フェーズ 3 では保持と検証だけ（判定は 4-01） |
| `passengerDemand` | legacy のみ必須 | 1.0 | 0.3〜2.0。旧モデルの需要係数 |
| `legacy` | | — | フェーズ 3 以前の項目にだけ付ける。**新規項目には付けない**（付けると旧ルールの会社にも出て、旧ゲームの乱数列が変わる） |
| `retired` | | — | 一覧と新規の提案から外すが、既存契約の参照は解決できる。削除の代わりに使う |
| `fictional` | | 実在 | 実在しない都市にだけ付ける。空港の格が閾値（格 3）以上のとき、架空会社の新規提案は架空の目的地だけになる（機能F）。付けられる ID は検証の固定リスト（`FICTIONAL_DESTINATION_IDS`）と一致が必要で、新しい架空都市を足すときはリストも更新する。架空の国（ND/BH/LM）の都市には必須 |

都市を足したら、表示順のための地域も登録する。一覧表示の並びは `src/core/data/destinationRegions.ts` の表示用地域区分（2026-REGION。国内 11 地方＋海外 11 地域）が決めており、`regionId`（検証・ゴールデンで使う粗い区分）とは別物。`DESTINATION_DISPLAY_REGION_BY_ID` に新しい都市の ID を足すこと（網羅は `tests/unit/destinationRegionOrder.test.ts` が検証するので、足し忘れるとテストが落ちる）。

## 3. 航空会社を足す

`airlines.ts` の末尾に `defineAirline({...})` を 1 件足す。

```ts
defineAirline({ id: 'ZZ', name: '試験航空', type: 'regional', services: ['domesticPassenger'], fleet: [{ typeId: 'E175', seats: 76 }] }),
```

| 項目 | 必須 | 既定 | 範囲・意味 |
|---|---|---|---|
| `id` | ✓ | — | `/^[A-Z][A-Z0-9]$/`（2 文字）。保存データの参照キー。**後から変えない** |
| `name` | ✓ | — | 表示名。計画では架空の会社を原則としたが、2026-11-17 のユーザーの依頼で実在の航空会社も追加した（塗装はブランド色の近似）。どちらも扱いは同じ |
| `type` | ✓ | — | `fullService` / `lcc` / `regional` |
| `services` | ✓ | — | `domesticPassenger` / `internationalPassenger` / `cargo` から 1 件以上 |
| `fleet` | ✓ | — | 1 件以上。`typeId` は機種表にあるもの、`seats` は 1〜機種の最大旅客数（maxPax 未設定の機種は上限なし） |
| `code` | | `id` | 便名の接頭辞。他社と重複不可 |
| `baseLoadFactor` | | 種別値（0.78 / 0.86 / 0.70） | 0.3〜0.95。採算の基準搭乗率（評価と市場の減便・撤退の基準） |
| `fareLevel` | | 種別値（1.0 / 0.7 / 0.9） | 0.5〜2.0。運賃水準。安い会社ほど需要を取りやすい |
| `priceSensitivity` | | 種別値（0.3 / 0.8 / 0.5） | 0〜1。料金への敏感さ |
| `minOtp` | | 種別値（0.82 / 0.7 / 0.75） | 0.5〜0.99。求める定時率 |
| `canBase` | | false | 拠点にできるか（4-04 用。フェーズ 3 では保持と検証のみ） |
| `networkDestinations` | | 無制限 | 就航範囲の許可集合（目的地 ID の配列、国内・国際共通）。指定すると、その集合の目的地にしか提案が出ない（提案生成の3経路が `airlineNetworkAllows` を参照）。既存の有効契約が範囲外の場合は、セーブ読み込み時（`importCompany` → `reassignOutOfScopeContracts`）に路線を保ったまま範囲内の会社へ付け替える（候補がなければ元の会社のまま維持し、契約は破棄しない）。実在の地域航空・LCC の路線網を表すために使う |
| `unlock.minRating` / `minTier` | | なし | 都市と同じ |
| `livery` | | 既定塗装 | `{ body, tail, stripe, engine }`（各 0〜0xffffff）。省略すると既定塗装になる |
| `legacy` / `retired` | | — | 都市と同じ |
| `fictional` | | 実在 | 実在しない会社にだけ付ける。空港の格が閾値（格 3）以上のとき、新規提案は架空の目的地だけになる（機能F。判定は `airlineFictionalAllows`、提案生成だけに効き既存契約は不変）。付けられる ID は検証の固定リスト（`FICTIONAL_AIRLINE_IDS`）と一致が必要で、新しい架空会社を足すときはリストも更新する。`legacy` とは別概念（SK は legacy だが実在の SAS なので付けない）。既存の架空会社の有効契約は、契約パネルから実在会社へ付け替えできる（条件はそのまま） |

種別値は `AIRLINE_TYPE_DEFAULTS`（`types.ts`）。`baseLoadFactor` の種別値は `BALANCE.demand.baseLoadFactor` と同値に保つ。

## 4. 国・地域を足す

`countries.ts` に足す。地域は `REGION_DATA`、国は `COUNTRY_DATA` の**末尾**に追加する
（既存の順序は互換のために変えない）。新しい国の都市は、その国を足してから追加する。

## 5. 検証とエラーの読み方

アプリの起動時（`CATALOG` の構築時）に全データの検証が走り、不正があると `CatalogError` で
理由の一覧が出て起動しない。文の形式は固定で `[<種別> <id>] <field>: <理由>（<期待>）`。

- `[就航都市 TYO] id: 重複しています（2 件目: 9 番目の項目）` → 同じ ID が 2 件ある
- `[就航都市 KCZ] population: 範囲外の値 -5（1,000〜40,000,000）` → 範囲を見直す
- `[就航都市 XYZ] countryId: 国 "QQ" が COUNTRY_DATA にありません` → 先に国を足す
- `[航空会社 TB] fleet[1].typeId: 機種 "B999" が機種表にありません` → 機種 ID の綴りを確認
- `[航空会社 TB] fleet[0].seats: 座席 240 が機種 A320neo の最大旅客数 220 を超えています` → 座席を下げる
- `[別名 OLD] → NEW: 別名の先の ID がありません` → `ID_ALIASES` の対応先を確認

テストでも同じ検証を確認している（`tests/unit/catalogValidation.test.ts`）。
出荷データは警告（warn）を含めて issue 0 件が条件。

## 6. ID を変える・項目を消すとき

保存データは ID で参照しているので、**出荷した ID は変えない・項目は消さない**。

- 名前や数値の変更: そのまま編集してよい（保存データは ID だけを持つ）。
- ID をどうしても変える: 旧 ID の項目を消す前に、`src/core/data/index.ts` の `ID_ALIASES` に
  `{ 旧ID: 新ID }` を足す。読み込み時に契約・関係・機材・評価のキーが新 ID に寄せられる。
  別名の元が既存 ID と衝突する・先がない場合は検証エラーになる。
- 項目を引退させる: 削除ではなく `retired: true` を付ける。一覧と新規の提案からは消えるが、
  既存の契約はそのまま解決できる。
- 登録にない ID を参照する保存データは、読み込みエラーになる
  （理由と対処が文に出る。`tests/unit/marketSave.test.ts`）。

## 7. legacy と market の対象

- `legacy` の項目だけが、従来ルールの会社（market なし）の対象。集合と順序が旧ゲームの
  提案の乱数列を決めるので、legacy の ID と順序は検証で固定している
  （`LEGACY_AIRLINE_IDS` / `LEGACY_DESTINATION_IDS`、`tests/unit/catalogLegacy.test.ts`）。
- 新規項目は market（路線需要モデル）を有効にした会社でのみ使う。
  新しい会社・都市を足しても、market なしの会社の動作とゴールデンは変わらない。
- 初期の会社（`createCompany` / `defaultFleets`）はいつも legacy の範囲で作る。

## 8. 追加したときの確認

1. `npm run typecheck` / `npm run lint`
2. `npx vitest run tests/unit/catalogValidation.test.ts tests/unit/catalogLegacy.test.ts tests/unit/catalogExtension.test.ts`
   （検証 issue 0 件・legacy の固定・足し方の例）
3. market の会社で提案・計画に出ることは E2E（`tests/e2e/phase3-traffic.spec.ts`）と
   画面（運航計画の路線の需要と供給）で確認できる。
