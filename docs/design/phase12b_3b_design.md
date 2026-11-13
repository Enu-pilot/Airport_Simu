# 12B-3b 詳細設計: 都市とアクセス鉄道／騒音と夜間制限／出来事（イベント）

作成: 設計リード（2026-11-13）。対象: `claude/phase12b-ops-experience` @ `929d86e`（PR #5）。**設計のみ**（リポジトリは未変更）。
入力: `docs/design/phase12b_roadmap.md` §D・§E.2・§E.4・§G.4・§G.6、`docs/design/phase12b_po_requests.md`（要望 5・6・8）、`scratchpad/phase12b/review_12b.md`（注意点）。
本文は日本語、識別子は英語。数値はすべて **ゲーム値**（実在の運用基準・環境基準への適合をうたわない）。参考にした実在の考え方は「参考」と明記する。

## 0. 要約と判定

- 3 つの柱をすべて **`company.game` の新しいフラグ** で opt-in にする: `game.city`（都市の種類）・`game.noise`・`game.events`。フラグがない会社（従来の会社・12B-3a の会社）は **1 ビットも変わらない**。
- **都市**は Phase 6 のアクセスモデルを **置き換えず拡張** する: `analyzeAccess` に任意の `city` を渡したときだけ外部所要時間（`externalMin`）を都市の距離・道路/鉄道の整備度から計算し、`planDay` の中で需要の上限（`cityFactor`）を掛ける。呼び出し側（7 か所）は変えずに済む設計にする（§1.4）。
- **鉄道の種別**は駅の任意の props `railService`（`boardingMode` と同じ前例: `PROP_SCHEMAS` の enum、欠落 = `local`）。**効果は `game.city` があるときだけ**。`SCHEMA_VERSION` は上げない（読み込みは未知の props を拒否しない — §2.1 で確認済み）。
- **騒音**は運航のコードに触れず、**締めの時に記録（`FlightRecord`）から計算**する。門限は「運用時間 = 門限」とし、越えた離着陸を違反として数える（ハードな強制はバックログ）。夜間割増は `landingFee` の倍率 1 か所。
- **出来事**は会社の `events` に「計画（日ごと）・保留中の判断・履歴・一時的な効果」を持ち、運航中の効果は **既存の障害（`addDisruption`）と既存の便追加（`addTurnaround`）** で実現する。乱数は `Rng(`${c.seed}:ev:${day}`)` と、結果の判定ごとの使い捨て `Rng(`${c.seed}:ev:${day}:${eventId}:${choice}`)` だけ。**`state.rng`・`c.rng` は一切引かない**。保存すべき乱数の状態もない。
- 版: **`PROJECT_FORMAT_VERSION_3 = 3` を新設**（12B-3a のアプリは 3b のフィールドを黙って無視して遊べてしまうため。3a は未リリースだが PR が別なので段階をまたいだ誤読を防ぐ）。厳格チェックは「名乗る版 < 内容から求めた版 → 拒否」に一般化。
- 既存の `rail` 目標は **早すぎる達成が起きる**（駐車場のように「置いただけ」で達成。外部の線路につながっていない駅・本数 0 でも、既存レイアウトに駅がある会社でゲーム設定を付けた最初の締めでも達成）→ 「鉄道の利用者が 1 日 100 人以上」に変更する（§1.9）。12B-3a のゴールデンはサンプル空港（駅なし）なので不変。
- **PR #4（`acceptOffer` で `lowDays = 0`）**: 既定ブランチの差分は `company.ts:321-330` に 4 行足すだけで、PR #5 とは衝突なしでマージできる（`git merge-tree` で確認）。3b の作業前に PR #5 に既定ブランチを取り込む。チャーター便は `acceptOffer` を通さない（撤退カウンタのリセットという副作用を持ち込まない — §4.3）。
- 規模: **L〜XL（約 18 コミット）**。3 つのサブ段階 **3b-1 都市と鉄道 → 3b-2 騒音 → 3b-3 出来事** に分け、各サブ段階の終わりで全テストが通る状態にする。最もリスクが高いのは 3b-1 の `access/model.ts`・`access/runtime.ts`・`planning.ts`、3b-3 の `simulation.ts`（フック 1 行）と `company.ts`（チャーター）。

---

## 1. 調査結果（file:line）

### 1.1 Phase 6 のアクセスモデル

| 事実 | 出典 |
|---|---|
| 手段 6 種（car / dropoff / taxi / bus / rail / walk）、効用 `U = asc − β(time + fare/VoT)`、分担 = softmax、`A = Σexp(U)`、係数 `min(1.1, 0.3 + 0.85(1 − e^{−A/0.2}))` | `src/core/access/model.ts:17-27,123-126,215-250`、`docs/15_access_rules.md:30-63` |
| 外部の所要時間は固定表 `externalMin`（car/dropoff/taxi 35、bus 50、rail 30、walk 120） | `src/core/economy/balance.ts:118`、使用 `model.ts:219` |
| 駅は鉄道の線路（`net.railTiles`）に接し、ターミナルから `ACCESS_MAX_WALK_TILES` 以内のものだけ使える。本数 = 駅の `trainsPerHour` の合計 | `model.ts:156-174` |
| 鉄道の待ち = `30 / 本数`、定員 = `本数 × trainSeats(200)`、運賃 = 700 + 使用料 | `model.ts:197-204`、`balance.ts:120,136` |
| `analyzeAccess(layout, { fees, feedback })` の呼び出し 7 か所: `AccessPanels.tsx:34,185,190`・`ManagementPanels.tsx:47`・`ops.ts:98(既定引数),145`・`runtime.ts:82,112` | grep |
| 運航中: 出発グループは到着時に分担で抽選（`state.rng`）、鉄道・バスは毎時定員で次の便へ、道路は BPR 型の遅れで基準時間に `M.externalMin[mode]` を使う | `runtime.ts:170-222`（`withRng(state…)` は `runtime.ts:120-125`） |
| 到着旅客の乗り場の処理: `every(trainsPerHour)` ごとに `serve('rail', M.trainSeats)` | `runtime.ts:281-283` |
| 交通事業者の使用料: `count × accessFees[m] × c.fees[m]` を `transit` 収入へ | `runtime.ts:160-163` |
| アクセス施設の運営費: 駅 6,000/日 | `ops.ts:118-131`、`balance.ts:92` |
| 駅の props は `trainsPerHour` (int 1〜20) だけ、既定 4 | `src/core/model/catalog.ts:127,147` |

### 1.2 需要

| 事実 | 出典 |
|---|---|
| 搭乗率 = 基本(種類) × 路線需要 × 料金係数 × 評価係数 × `access` × (1 ± 揺らぎ)、0.15〜1.0 に丸め | `src/core/economy/planning.ts:72-85` |
| `planDay(c, day, access = 1, types)`、便ごとに `Rng(`${c.seed}:${k.id}:${day}:${i}`)` | `planning.ts:92-133` |
| `planDay` の呼び出し: `simulation.ts:395`（`refreshAccess` の戻り値）・`ops.ts:477`・`review.ts:164`・`useScorecard.ts:11`・`AccessPanels.tsx:186,191`・`ManagementPanels.tsx:47` | grep |
| 契約の時間帯 `TimeWindow = morning / daytime / evening / any`、窓 6–11 / 10–17 / 16–22 | `company.ts:56`、`planning.ts:31-35` |
| 運用時間の既定 6:00〜23:00、UI の選択肢は開始 5〜8 時・終了 20〜23 時、最短 6 時間 | `company.ts:212,365-368`、`ManagementPanels.tsx:210-231` |
| 提案の確率 `p = (base + ratingProb × rating × sat/60) × offerBoost`、乱数は `c.rng`（`withRng(c…)`） | `company.ts:383-391,370-375` |
| 行き先 6 か所（`demand` 0.85〜1.15）。国内/国際の区分なし | `src/core/economy/registry.ts:57-70` |

### 1.3 12B-3a のゲーム設定

| 事実 | 出典 |
|---|---|
| `GameSettings { version: 1; difficulty; weather; airlineEval; goals; climate }`（**`events` はロードマップにあったが未実装**） | `src/core/economy/game.ts:16-26` |
| 難易度の表（weatherScale・disruptionScale・otpAdd・cashMul・costMul・forecastAccuracy） | `game.ts:44-48` |
| `checkGameSettings` は **未知のキーを拒否しない**（＝3a のアプリは 3b のフラグを黙って無視する） | `game.ts:55-64` |
| `checkGameFields`（フラグとデータの食い違いをエラー）、`applyGameState`、`startGame` | `game.ts:80-115` |
| 新しいゲームの UI（モード・難易度・気候・天候・評価・目標・従来ルール） | `src/ui/GameSetup.tsx:32-115`、`editor/store.ts:493-513` |
| 天候の乱数の前例: 計画 `Rng(`${seed}:wx:${day}`)`、運航中は `state.wx.rng`（`${state.seed}:wx`）だけ | `src/core/sim/weather.ts:59-61`、`weatherStep.ts:19-28` |

### 1.4 目標

- `rail`: `Object.values(layout.facilities).some(f => f.kind === 'railStation' && f.buildState === 'operational')`、報酬 評価 +2（`src/core/economy/goals.ts:78`）。評価は `settleDay` の最後（`ops.ts:511-525`）。
- 早すぎる達成の経路: (a) 線路に接していない／ターミナルから遠い駅（`model.ts:160-163` で使われない）でも達成、(b) 既存レイアウトに駅がある会社で `setGameSettings` した最初の締めで達成、(c) 3b で都市の鉄道整備度 0（地方都市）の場合に鉄道が使えないのに達成。

### 1.5 障害・1 日のループ・振り返り・UI

| 事実 | 出典 |
|---|---|
| ランダムな障害は毎正時に `state.rng` から（種類ごとに必ず 1 回 `rng.next()`）、`randomDisruptionScale` は難易度 | `src/core/sim/disruptions.ts:97-104,378-411`、`simulation.ts:137` |
| `addDisruption`（乱数を引かない。ID は `state.counters.dr`）、`Disruption.origin: 'manual' \| 'random' \| 'scenario'` | `disruptions.ts:74-95`、`types.ts:619-639` |
| `demandSurge`・`inboundDelay`・`runwayClosed`（`end` 付き、予定 → 発生）が使える | `disruptions.ts:126-130`、`types.ts:606-617` |
| ティックの順: 締め（0:00）→ `stepDisruptions` → `stepWeather` → 管制 → 機体 → 旅客 … | `simulation.ts:620-640` |
| 運航開始時に `createAccessRuntime`・`createWx` | `simulation.ts:183-190` |
| `settleDay` の順: KPI → アクセスの締め → 工事 → 評価 → 契約 → 評価点 → 提案 → 日報 → 目標 → 破綻判定 → 日送り | `ops.ts:463-539` |
| 振り返り `DayReview`（`goals?`・`tomorrow.weather` など opt-in の節を持つ） | `src/core/analytics/review.ts:78-102,152-215` |
| アラートは状態から導く純関数（`AlertAction = focus/repair/delay15/reassign/openPanel`） | `src/ui/operate/alerts.ts:13-41` |
| 常設カード: 左 TodayKpi・Runway・Weather・Construction・Goals、右 Terminal・Ground・Access・Airline・Events | `src/ui/operate/OperateLayout.tsx:33-51` |
| 便の記録 `FlightRecord`（機種・`landedAt`・`takeoffAt`・結果） | `src/core/analytics/records.ts:14-54` |
| 着陸料 = MTOW × 150 × 料金倍率 × ピーク 1.25 × 割引。到着時に計上 | `ops.ts:180-185,199` |

### 1.6 保存

| 事実 | 出典 |
|---|---|
| `formatVersionOf`: レイアウト（バス・連絡通路・ランプバス）・会社（`game`/`airlineEval`/`goals` のキー）・運航（`bus`/`wx`）で 2 | `src/core/io/project.ts:29-61` |
| 版 1 を名乗り版 2 の内容 → 拒否 | `project.ts:497-502` |
| 読み込み時のレイアウトの props の検査は新項目だけ（`checkBusProps`）。**未知の props は拒否しない**。編集（`updateFacility`）は `PROP_SCHEMAS` にないキーを `INVALID_VALUE` で拒否 | `project.ts:189-207`、`src/core/io/serialize.ts:22-35`、`src/core/layout/operations.ts:930-950` |
| `checkCompany` → `importCompany`（不正な 3a 項目は捨てる）＋ `checkGameFields`（厳格） | `project.ts:209-219`、`company.ts`（importCompany） |

### 1.7 PR #4（既定ブランチ）

- 差分: `acceptOffer` に `c.airlines[k.airlineId]!.lowDays = 0;` を追加（受諾時に撤退カウンタをリセット）。それ以外の差分は PR #5 で入った 3a のコードが既定ブランチにないことによる見かけの差。マージベース `5e638f1`、`git merge-tree --write-tree` で衝突なし。ゴールデンは `acceptOffer` を使わない（`tests/golden` に呼び出しなし）。
- 3b への影響: チャーター便（§4.3）は `acceptOffer` を使わずに専用関数で作る。

---

## 2. 都市モデル（`game.city`）

### 2.1 データ

```ts
// src/core/economy/city.ts（新設、純関数のみ。planning.ts を import しない＝循環なし）
export type CityType = 'regional' | 'core' | 'metropolitan';
export interface CityState {
  version: 1;
  type: CityType;
  population: number;        // 人（整数）
  distanceKm: number;        // 空港〜都心
  roadQuality: 1 | 2 | 3 | 4 | 5;
  railQuality: 0 | 1 | 2 | 3 | 4 | 5;   // 0 = 都市側に鉄道網なし
  /** 鉄道協定の工事中（完了日。なければ欠落） */
  railUpgradeDay?: number;
  /** 前日の需要の利用率（旅客 ÷ 上限、0..∞、表示と提案・成長に使う） */
  util: number;
  /** 道路の整備度が上がった人口のしきい値（重複通知を防ぐ） */
  roadMilestones: number;
}
// CompanyState に city?: CityState
// GameSettings に city?: CityType（欠落 = 都市モデルなし）
```

| 種類 | 人口 | 距離 | 道路 | 鉄道 | 旅行率（出発＋到着/人/日） | 需要の倍率 | 騒音の感度 |
|---|---|---|---|---|---|---|---|
| regional（地方都市） | 300,000 | 25 km | 2 | 0 | 0.012 | 0.9 | 0.7 |
| core（中核都市） | 1,200,000 | 18 km | 3 | 2 | 0.010 | 1.0 | 1.0 |
| metropolitan（大都市） | 6,000,000 | 30 km | 4 | 4 | 0.008 | 1.1 | 1.5 |

- ロードマップ（§D.1）の旅行率 0.004〜0.009 は **低すぎる**: 地方都市の上限が約 830 人/日になり、空港の格 1（旅客 2,000/日、`goals.ts:99-103`）に届かない。上の値で上限はおよそ 地方 2,900・中核 11,400・大都市 37,000（アクセス良好時）。地方都市は「需要が育ちにくい難しい立地」、大都市は「需要は大きいが騒音に厳しく道路が混む」。
- 住民の満足度は `noise.residents`（§3。都市と騒音は独立に付け外しできるようにする）。

### 2.2 式（ゲーム値）

**需要の上限**（旅客/日、出発＋到着）:
```
decay      = exp(−max(0, distanceKm − 15) / 60)
catchment  = 0.7 + 0.3 × clamp01((accessFactor − 0.3) / 0.8)      // アクセスが良いほど広い範囲から集まる
ceiling    = population × tripRate[type] × decay × catchment
```

**都市係数**（`planDay` の中で計算。`planning.ts` に `cityDemandFactor(c, day, access, types)` を置く）:
```
expected   = Σ_{有効な契約 k} perDay_k × seats_k × 2 × loadFactor(c, k, 0.5, access × demandMul[type])  // 揺らぎなしの搭乗率
cityFactor = demandMul[type] × min(1, ceiling / max(1, expected))
planDay 内: const eff = c.game?.city && c.city ? access * cityFactor : access   // 都市がなければ access をそのまま使う（×1 も掛けない）
```
- 決定的（乱数なし）。`planDay` の **引数・戻り値の形は不変**、呼び出し 7 か所は変更不要で、プレビュー（計画パネル・スコアカード・振り返りの明日）と実運航が自動で一致する。
- 搭乗率の下限 0.15（`planning.ts:84`）があるので上限は「やわらかい」（便を増やしすぎると 1 便あたりの搭乗率が下がる＝航空会社の評価要素「搭乗率」が下がる、という自然な罰になる）。
- 提案: `generateOffers` の `p` に `cityOfferMul = clamp(1.2 − util, 0.2, 1)` を掛ける（`c.city` があるときだけ。`rng.next()` の回数は不変）。上限に張り付くと新しい提案が減る。

**アクセスの所要時間**（`analyzeAccess(layout, { fees, feedback, city })`、`city` がある場合だけ `externalMin` を置き換える）:
```
car / dropoff / taxi : distanceKm / (20 + 8 × roadQuality) × 60 + cityCongestion[type]   // 0 / 5 / 15 分
bus                  : 上の 1.3 倍
rail                 : distanceKm / speed[service] × 60 + (5 − railQuality) × 4           // 乗り換えの手間
walk                 : 従来どおり
```
- 例: 中核都市の車 = 18/44×60 + 5 ≈ 29.5 分（従来 35）。大都市の特急 = 30/90×60 + 4 = 24 分、車 = 30/52×60 + 15 ≈ 49.6 分 → 大都市は鉄道の分担が大きくなる。
- `railQuality = 0` の都市では鉄道は使えない: 新しい理由 `AccessUnavailable = 'noCityRail'`（ja ラベル追加）。
- 道路の混雑の基準時間（`runtime.ts:206` の `M.externalMin[mode]`）も都市の値を使う: `AccessRuntime` に任意の `extMin?: Record<AccessMode, number>` を **都市があるときだけ** 持たせる（従来の運航状態にはキー自体を作らない）。

**都市の成長**（日次締め、`game.city` のときだけ。`settleDay` の目標の評価の後、破綻判定の前）:
```
paxDay = kpi.paxDeparted + kpi.paxArrived;   util = paxDay / ceiling
resTerm = noise があれば clamp(residents / 70, 0, 1)、なければ 1
growth = base[type] + 0.003 × clamp((util − 0.6) / 0.4, 0, 1) × resTerm    // base = 0.0002 / 0.0003 / 0.0002
population = round(population × (1 + growth))
```
- 満杯で運航し続けると 1 日 約 +0.3%（120 日の 1 年で約 ×1.4）。
- 人口が初期値の ×1.5・×2・×3 を越えるたびに `roadQuality + 1`（上限 5）。ログと出来事の履歴に通知。
- **鉄道協定**（会社の操作 `investRail(c)`）: 費用 `[3M, 4M, 6M, 8M, 12M]`（現在の整備度で）、30 日後に `railQuality + 1`（`railUpgradeDay`）。工事中は再投資不可。キャリアモードで現金不足なら不可。
- 住民の満足度 < 30 のとき成長は 0（§3.3）。

### 2.3 opt-in と移行

- 新しいゲーム: `GameSetup` に都市の種類（ラジオ、既定 **core** — §7 Q1）。`startGame` / `applyGameState` が `c.city ??= initialCity(type)`、種類を変えたら作り直す、`game.city` 欠落なら `delete c.city`。
- 既存の会社（従来・3a）: 何もしない（移行なし）。「ゲーム設定」で都市を選んだときだけ有効。

---

## 2b. アクセス鉄道の種別と本数

### 2.4 保存場所の判断

- **レイアウトの施設 props** に置く: `PROP_SCHEMAS.railStation` に `{ key: 'railService', type: 'enum', options: ['local', 'rapid', 'express'] }` を追加（`DEFAULT_PROPS` には入れない — 新しく置いた駅の JSON を従来と同じに保つ。`boardingMode` と同じ前例 `catalog.ts:93-98`）。
  - 確認結果: 読み込み（`validateLayoutData`・`checkLayout`）は未知の props を拒否しない。編集（`operations.ts:930-950`）は `PROP_SCHEMAS` で検査するので追加が必要。→ 会社側（`CityConfig.railServices`）に逃がす必要はない。
  - 読み込みの検査: `checkBusProps` を `checkNewProps` に改名・拡張し、`railService` が 3 値以外ならエラー。
- 本数は既存の `trainsPerHour`（1〜20）をそのまま使う。
- **効果は `game.city` があるときだけ**。都市がなければ props は無視（全駅が従来の計算）。プロパティパネルでは都市がないとき「都市モデルが有効なときだけ効果があります」と注記。
- 都市の鉄道整備度で使える種別: `local` ≥ 1、`rapid` ≥ 2、`express` ≥ 3。足りなければ使える最上位に落として扱い（`effectiveService`）、検証の警告 `RAIL_SERVICE_UNAVAILABLE`（会社が要るので、レイアウトの検証ではなくアクセス表・計画パネルの警告として出す）。

### 2.5 効果（ゲーム値）

| 種別 | 速度 | 1 本の空港利用の定員 | 旅客の運賃の上乗せ | 空港の使用料の倍率 | 駅の運営費の倍率 |
|---|---|---|---|---|---|
| local（各停） | 45 km/h | 200 | +0 | 1.0 | 1.0 |
| rapid（快速） | 65 km/h | 250 | +0 | 1.2 | 1.4 |
| express（特急） | 90 km/h | 150（座席指定） | +500 cr | 1.6 | 2.2 |

- 複数の駅: 本数で重み付けした平均で 1 つの「鉄道」手段にまとめる（外部時間・運賃・使用料の倍率）。定員は `Σ 本数_i × 定員_i`。分析の `ModeInfo` に `railMix?: { service; trainsPerHour }[]` を足して表示に使う。
- 運航中: `AccessRuntime` に任意の `railSeats?`（1 本あたりの平均定員）と `railFeeMul?` を **都市があるときだけ** 持たせ、`runtime.ts:191-194`（出発の毎時定員）・`:283`（到着の serve）・`fee()`（使用料）で `?? M.trainSeats` / `?? 1` として使う。
- 運営費: `ops.ts:123` で駅の運営費 × 倍率（都市があるときだけ）。
- 効用の検算: 特急の上乗せ 500 cr は 500/60 ≈ 8.3 分相当。距離 30 km で各停 40 分 → 特急 20 分なので特急が有利、距離 15 km では差 10 分 → ほぼ互角。

### 2.6 UI

- プロパティパネル: 種別のセレクト（汎用の enum 表示がそのまま使える。`PropertiesPanel.tsx:490`）＋注記。
- AccessCard / アクセスの詳細パネル: 都市の行（人口・距離・道路/鉄道の整備度・需要の上限・利用率のバー）、鉄道の内訳（種別・本数・所要時間）。理由 `noCityRail` の表示。
- 経営パネル: 「鉄道会社と協定（整備度 +1）」ボタン（費用・完了日）。
- 計画パネル: 需要の上限を越えているときの警告 `DEMAND_CEILING`（`PlanIssueCode` に追加、`c.city` があるときだけ。従来の分析結果は不変）。

---

## 3. 騒音と夜間制限（`game.noise`）

### 3.1 データ

```ts
// src/core/economy/noise.ts（新設、純関数）
export interface NoiseState {
  version: 1;
  residents: number;          // 住民の満足度 0..100（初期 70）
  insulation: 0 | 1 | 2 | 3;  // 防音工事の助成の段階
  /** 直近の日の騒音指数・違反（表示用。直近 30 日） */
  history: { day: number; index: number; night: number; violations: number }[];
}
// CompanyState に noise?: NoiseState、GameSettings に noise?: boolean
```

### 3.2 騒音指数（締めの時に記録から計算。運航のコードに触れない）

- 1 回の離着陸の騒音単位: 機種の区分 S 1・M 2・L 4（`resolveType(types, typeId).size`）。
- 時間帯の重み（**参考**: EU の環境騒音指令 2002/49/EC の Lden は夕方 +5 dB・夜間 +10 dB の加重。ここでは単純化した倍率として借用したゲーム値）: 昼 07–19 ×1、夕 19–23 ×3、夜 23–07 ×10。
- 対象: その日の `FlightRecord` の `landedAt`・`takeoffAt`（完了・ダイバートの到着は含まない、離陸・着陸した分だけ）。
- `index = Σ 単位 × 重み`、`night = 夜の回数`。
- **門限 = 運用時間**（`c.hours.openMin`〜`closeMin`）。運用時間外に離着陸した回数を `violations`（遅れて閉場後に出発した便など）。

### 3.3 住民の満足度と影響（日次、`game.noise` のときだけ）

```
sens      = 都市があれば noiseSens[type]、なければ 1
tolerance = 300 + 150 × insulation
delta     = 1.0 − sens × max(0, index − tolerance) / 200 − 2 × violations      // 1 日の変化は −8..+1.0 に丸める
residents = clamp(residents + delta, 0, 100)
```
- 目安: 中核都市で M 機 150 回/日（昼のみ）= 300 → 変化 +1。M 機 250 回 + 夜 10 回 = 500 + 200 = 700 → −1.0/日。拡張には防音工事か夜を減らす判断が要る。
- 影響:
  - `residents < 50`: 空港評価に `−(50 − residents) × 0.05`（`nextRating` の後に、`c.rating` へ。最大 −2.5/日）。
  - `residents < 30`: 新設・改修工事の日数 ×1.2（反対運動。`construction.ts` の日数計算に倍率、game.noise のときだけ）、都市の成長 0。
  - `violations > 0`: 1 回あたり罰金 200,000 cr（新しい費用区分 `noise`。0 なら日報にキーが出ない — `ops.ts:493-495` の「0 は載せない」）。
- 防音工事の助成（経営パネルの操作 `fundInsulation(c)`）: 段階ごと 2M / 4M / 8M cr、即時に `insulation + 1`。
- 夜間割増: 夜（23–07）と夕方（19–23）の到着の着陸料 ×1.3 / ×1.1（`landingFee` に `noiseTimeMul(c, at)`、`game.noise` のときだけ）。運用時間 5:00 開始・23:00 終了は従来の選択肢で既に作れるので、**「朝 5〜7 時を開けて割増を取る vs 住民」** が判断になる。

### 3.4 UI

- 左列に `NoiseCard`（`game.noise` のときだけ）: 住民の満足度のバー、今日の騒音指数（運航中の記録から逐次計算した見込み）、夜間の回数、門限まで の残り時間と未出発の便の数。
- アラート: 閉場 30 分前に未出発の便があれば「門限まで 30 分: 未出発 n 便」（`openPanel` → 運航表）。運航表の既存の行操作（遅延・先行欠航）で対処する。
- 振り返りに「騒音」の節: 指数・夜間・違反・罰金・住民の満足度の変化、悪化の主な原因（時間帯×機種の上位 3）。
- 経営パネル: 防音工事の助成ボタン。
- 騒音の等高線のオーバーレイ: **could**（滑走路ごとに楕円 3 本を 2D で塗るだけの安い表現。3D なし）。

---

## 4. 出来事（`game.events`）

### 4.1 枠組み

```ts
// src/core/economy/events.ts（新設）: 定義表・計画・判断・効果（会社側）
// src/core/sim/eventStep.ts（新設）: 運航中の実現（障害・便の追加）と判断の期限
export type EventView = 'exec' | 'ops' | 'pilot' | 'spotter';
export interface PlannedEvent {
  id: string;                 // `ev_${day}_${n}`
  defId: EventDefId;
  day: number;                // 会社の暦の日
  atMin: number;              // 発生時刻（日内の分）。exec は 0（前日の振り返りで判断）
  targetId: string | null;    // 滑走路・エリア・航空会社など（計画の時点で決定、実現時に再検証）
  params: Record<string, number | string>;   // 機種・倍率・時間など
  status: 'planned' | 'awaiting' | 'active' | 'done' | 'cancelled';
  choice: string | null;      // 選んだ選択肢（期限で既定を自動適用）
  deadlineMin: number | null; // 判断の期限（日内の分。exec は前日の 24:00 = 0）
  outcome?: string;           // 結果の要約キー
}
export interface EventsState {
  version: 1;
  planned: PlannedEvent[];    // 今日と明日の分だけ
  history: { day: number; defId: EventDefId; view: EventView; choice: string | null; outcome: string | null }[];  // 直近 100 件（12B-4 のスポッティング記録が読む）
  modifiers: { kind: 'offerMul' | 'landingFeeMul' | 'retailMul'; value: number; until: number; airlineId?: string }[];
}
// CompanyState に events?: EventsState、GameSettings に events?: boolean
```

- **計画**: 締め（`settleDay`）の最後に翌日分を `planEvents(c, layoutSummary, day+1)` で作る。最初の日は `createSimulation` で今日の分がなければ作る（決定的なので何度作っても同じ）。乱数は `Rng(`${c.seed}:ev:${day}`)` の 1 本。**引く回数を結果によらず固定**（候補ごとに必ず 1 回、選択に 1 回、時刻に 1 回）して、表の変更以外で乱数列がずれないようにする。
- **件数**: 運航系（ops/pilot/spotter）は 2 枠をそれぞれ確率 `λ/2`（`λ` = 0.6 / 0.9 / 1.2: normal / hard / expert）、経営系は 1 枠を確率 0.15 / 0.2 / 0.25。最大 1 日 3 件。
- **結果の判定**: 選択肢の結果に乱数が要るときは `Rng(`${c.seed}:ev:${day}:${eventId}:${choice}`)` を使い捨てで作る（状態を保存しない）。
- **判断の期限と既定**: すべての判断に既定の選択肢があり、期限（運航系 = 発生から 15 分、経営系 = 日の初め 0:00）を過ぎたら自動で適用する。1 日スキップ（ヘッドレス）でも同じ結果になる。
- **実現**: `stepEvents(sim)` を `simulation.ts` の `stepWeather` の直後に 1 行（`if (sim.company?.events) stepEvents(sim)`）。毎分の境界で `planned` の `atMin` に達したものを実現し、期限切れの判断に既定を適用する。運航中の効果は既存の API だけ:
  - `addDisruption(sim, { kind, targetId, start, end, amount, origin: 'event' })`（`origin` に `'event'` を追加、`Disruption.eventId?: string`）
  - `addTurnaround(sim, typeId, at, {...})`（臨時便）
  - 会社の `post`・`events.modifiers`
- **レイアウトの再検証**: 計画の後に建設モードで滑走路などが消えたら、実現の時点で同じ乱数で別の対象を選び直す、なければ `cancelled`（「取りやめ」）。

### 4.2 カタログ（must = 3b で実装、could = バックログ）

| # | 視点 | 出来事 | 時期 | 確率の重み | 効果 | 判断（既定は **太字**） | 期間 | 区分 |
|---|---|---|---|---|---|---|---|---|
| X1 | 経営 | **チャーター便の依頼**（VIP・スポーツ団体） | 前日の振り返り | 3 | 明日 1 往復の臨時便（運航できる機種のみ）。着陸料 ×2・旅客数は満席 | 受ける（定時なら評価 +1、15 分超の遅れで評価 −2）／**断る** | 1 日 | must |
| X2 | 経営 | **燃料価格の高騰** | 前日 | 2 | 航空会社の負担増 | 着陸料を 5 日間 10% 減免（`landingFeeMul 0.9`）／**何もしない**（5 日間 提案確率 ×0.7・契約中の各社の満足度 −0.5/日） | 5 日 | must |
| X3 | 経営 | **投資家の視察** | 前日 | 2 | 明日の定時率 ≥ 85% かつ乗り遅れ 0 なら 500,000 cr（営業外 `grants`）と評価 +1 | なし（挑戦。結果は振り返りに） | 1 日 | must |
| X4 | 経営 | **地元の祭り**（都市があるときだけ） | 前日 | 2 | 明日 10–18 時の需要 ×1.3（既存 `demandSurge`）。道路の混雑も増える | 臨時バスを手配 300,000 cr（その日のバスの本数 +4 相当 = バス乗り場があるときだけ）／**何もしない** | 1 日 | must |
| X5 | 経営 | 航空会社の経営危機・合併の打診 | 前日 | 1 | 1 社の契約が 7 日後に終了 | 支援（30 日 減免 20%）／受け入れる | 7〜30 日 | could |
| X6 | 経営 | 鉄道会社の増発の提案（都市があるときだけ） | 前日 | 1 | 鉄道協定の半額 | 受ける／断る | — | could |
| O1 | 運航 | **バードストライク** | 運航中 | 3 | 対象の滑走路を閉鎖 | **通常点検 20 分**／簡易点検 10 分（25% で FOD 発見 → 追加 40 分閉鎖・評価 −1） | 10〜60 分 | must |
| O2 | 運航 | **急病人のダイバート受け入れ要請** | 運航中 | 2 | 20 分後に契約外の臨時到着（運航できる機種から）、90 分駐機 | **受け入れる**（着陸料・評価 +1。スポットを 1 つ使う）／断る（評価 −1） | 〜2 時間 | must |
| O3 | 運航 | **航空交通の流量制限** | 運航中 | 2 | 2 時間、到着便に 15〜40 分の遅れ（既存 `inboundDelay`） | なし（情報。アラートと運航表で見せる） | 2 時間 | must |
| O4 | 運航 | **保安上の警報** | 運航中 | 2 | 保安検査エリアを停止（既存 `maintenance` の対象をエリアに） | **全面検査 45 分**／短縮 20 分（20% で報道 → 評価 −3） | 20〜45 分 | must |
| O5 | 運航 | 作業員のストライキ | 前日 | 1 | 4〜8 時間 欠勤 6 人（既存 `staffAbsence`） | 交渉（300,000 cr で半減）／受け入れる | 半日 | could |
| P1 | パイロット | **滑走路の定期点検**（予定された閉鎖） | 前日に予告 | 2 | 明日の閑散時間（計画の便が最も少ない 1 時間）に 45 分閉鎖 | **予定どおり**／夜間に移す（150,000 cr、運用時間外になり影響なし） | 45 分 | must |
| P2 | パイロット | **FOD（異物）の発見** | 運航中 | 2 | 滑走路 15 分閉鎖 | **清掃車を急行**（50,000 cr、8 分で再開）／自然復旧を待つ | 8〜15 分 | must |
| S1 | マニア | **珍しい機体の来訪**（大型機・保有外の機種） | 前日に予告 | 2 | 明日、臨時の 1 往復（機種は `AIRCRAFT_TYPES` のうち契約にない機種から。運航できなければ「受け入れ不可」と理由を表示） | **受け入れる**（着陸料・その日の店舗収入 ×1.15 `retailMul`、履歴に記録）／断る | 1 日 | must |
| S2 | マニア | 特別塗装機の就航 | 前日 | 1 | 契約便 1 便に `livery: 'special'` の印（描画は Phase 16） | なし | 1 日 | could |
| S3 | マニア | 初めて来た機種（乱数ではない） | 締め | — | 記録から検出し履歴に `firstType` | なし | — | could（12B-4 の記録で実装するのが自然。3b では履歴の形だけ用意） |

- 条件（`eligible`）: 対象がないもの（滑走路がない・保安検査エリアがない・契約 0 社など）は候補から外す（乱数を引く回数は変えない＝重み 0 にする）。
- 難易度: 確率の `λ` に加え、悪い結果の確率を hard ×1.25・expert ×1.5。
- 同時発生の制限: 同じ滑走路の閉鎖が重ならないよう、計画の時点で時刻をずらす（決定的）。天候の段階 4 の時間帯にはバードストライクを置かない。

### 4.3 実装の要点

- **チャーター便（X1）**: `addCharter(c, def)` で `Contract` を `status: 'active'`, `startDay = endDay = day`, `perDay: 1`, `window: 'any'`, `feeDiscount: −1`（＝ ×2）, 任意の `charter: true` で作る。`updateContracts` の満了処理（`company.ts:458-466`）は `charter` を更新せず `'expired'` にする（`k.charter` があるときだけの分岐。従来の契約は不変）。`acceptOffer` は使わない（PR #4 の `lowDays` リセットを持ち込まない）。`feeDiscount` が負の値を許すか `checkCompany` を確認し、許さないなら `feeMul?: number` を別に持つ。
- **臨時便（O2・S1）**: `addTurnaround(sim, typeId, at, { airline: null, numbers: ['EV…'], plan: { arrPax, depPax, seats, contractId: null, … } })` — 手動追加便と同じ経路（`OpsPanels` の便追加）。便名の重複は既知の課題（HANDOVER §5）なので接頭辞 `EV` で避ける。
- **評価・現金の変化**は `settleDay` の中で（`evaluateEventOutcomes(c, report, records)`、目標の評価の直後）。営業外の現金は `report.grants` に足す（3a の目標と同じ扱い）。
- **乱数の非干渉の証明**: `addDisruption` は乱数を引かない、`addTurnaround` は `state.rng` を引く（旅客の生成）が、これは「出来事が起きた運航」だけの差。出来事が **起きない日** の運航は `game.events` なしと完全一致する（テスト §6 E5）。

### 4.4 UI

- `EventsCard`（右列、既存）: 今日の出来事（予定・発生中・判断待ち）を先頭に、判断待ちは選択肢のボタン（`event-choice-${eventId}-${choice}`）と期限の残り。
- アラート: 判断待ちは `critical`、新しい `AlertAction = 'eventChoice'`（`choiceId` 付き）。期限切れで既定が適用されたら消える。
- 振り返り: 「出来事」の節（今日の出来事・選択・結果）と「明日の見通し」に予定の出来事（経営系・P1・S1 の判断はここで行う）。
- 出来事の文言は `ja.ts` の `EVENT_UI`（視点ごとの見出しと説明。ゲーム上の表現で、実在の手順の再現ではないと注記）。

---

## 5. 保存・版・ゴールデン

### 5.1 版

| 版 | 方針 |
|---|---|
| `SCHEMA_VERSION` | 3 のまま（`railService` は任意の props） |
| `SIM_MODEL_VERSION` | 上げない（新しい効果はすべてフラグの下） |
| `PROJECT_FORMAT_VERSION` | `PROJECT_FORMAT_VERSION_3 = 3` を追加、`PROJECT_FORMAT_MAX_READABLE = 3` |
| `GameSettings.version` | 1 のまま（新しいキーは任意。欠落 = 無効） |

- `formatVersionOf`: 先に 3 を判定 → 次に 2 → 1。
  - `companyUsesFormat3(c)`: `game.city`・`game.noise`・`game.events` のいずれかがある、または `city`・`noise`・`events` のキーがある。
  - `layoutUsesFormat3(l)`: 駅の `railService` が `rapid` か `express`。
  - 運航: `sim.company` の判定に加え、`state.access` に `extMin`/`railSeats`/`railFeeMul` のキー、`state.disruptions` に `origin === 'event'` がある。
- 厳格チェックを一般化: `if (data.formatVersion < fv) → 拒否`（`project.ts:497-502` を置き換え。版 1 の既存の文言は残し、版 2 → 3 の文言を追加）。テスト: 版 1・2 を名乗る 3 の内容をそれぞれ拒否。
- 検証:
  - `checkGameSettings`: `city` は 3 種か欠落、`noise`・`events` は真偽値か欠落。
  - `checkGameFields` に `checkCity`・`checkNoise`・`checkEvents` とフラグの食い違い（`game.city` なのに `city` がない／逆）を追加。`importCompany` は不正・食い違いの項目を捨てる（3a と同じ）。
  - `checkNewProps`（旧 `checkBusProps`）に `railService`。
  - `checkSim`: `state.access` の新キーの形、`origin: 'event'` の障害は会社に `game.events` があること。
- 同じコミットで: `formatVersionOf` の拡張・厳格チェック・`checkGameFields` の拡張（レビューの注意どおり、新しい項目を書き始めるコミットで版と検証も入れる）。

### 5.2 ゴールデン

- 既存のゴールデン（`sim`・`sim-midrun`・`stress-sim`・`project-sim`・`crossing-sim`・`bus-sim`・`legacy-remote-sim`・`project`・`free-runways`・`routes`・`geometry-*`・`runway-table`・`normalized-hashes`、**12B-3a の `game-models`・`game-weather`**）は **再採取しない**。
- 新規（新しいファイルだけ。`sim-versions.json` に追記、既存の項目は不変）:
  - `tests/golden/fixtures/rail.layout.json`（サンプル空港 + 線路 + 駅 2 つ: local 4 本・express 2 本）
  - `city-access.golden.json`（純関数: 3 種類の都市 × 鉄道整備度 × 種別の `analyzeAccess` の手段表・係数、`ceiling`・`cityFactor`・`planDay` の便ごとの旅客数）
  - `city-sim.golden.json`（rail フィクスチャ + core 都市 + noise で 1 日、締めの KPI・都市・騒音）
  - `events-sim.golden.json`（サンプル + `game.events`、出来事が 2 件以上起きるシードを固定、既定の選択で 1 日 + 1 件は手動の選択）
- 保護のテスト（新規）: 「`game` に新フラグがない会社では `analyzeAccess(layout, { fees, feedback })` と `{ …, city: undefined }` が深い一致」「`planDay` が 3a の会社で不変」「`state.access` に新キーなし」「`c.events` がない運航で `stepEvents` が呼ばれない」。

---

## 6. 作業分解（各ステップで `npm test`・`tsc`・Lint、UI のステップは `npm run test:e2e` も）

前提ステップ **S0**: PR #5 のブランチに既定ブランチ（PR #4）を取り込む（衝突なし）→ 全テスト・全ゴールデンが通ることを確認。12B-3a 後半の未実施の独立監査（HANDOVER §1）をこの時点で先に済ませる（3b の土台なので）。

### 3b-1 都市と鉄道（7 コミット）

| # | 内容 | 主なファイル | テスト | リスク |
|---|---|---|---|---|
| C1 | 版と検証の枠: `PROJECT_FORMAT_VERSION_3`、`formatVersionOf` の 3、厳格チェックの一般化、`GameSettings` の任意キー、`checkCity`/`checkNoise`/`checkEvents` の骨格（中身は各段階で） | `io/project.ts`・`economy/game.ts` | 版の単体（1/2/3 の書き分け・名乗り違いの拒否）、既存の project ゴールデン | 中（保存） |
| C2 | `city.ts`（データ・初期値・`ceiling`・成長・鉄道協定の純関数）、`applyGameState` | `economy/city.ts`・`game.ts` | 式の単体（表の値・境界） | 低 |
| C3 | `railService` の props（`PROP_SCHEMAS`・`checkNewProps`・`layoutUsesFormat3`）| `model/catalog.ts`・`io/project.ts` | 編集の検証・読み込みの検査 | 低 |
| C4 | **`analyzeAccess` に `city`**（`externalMin` の置き換え・`noCityRail`・鉄道の内訳・運賃と使用料の倍率）。`accessOptsOf(c)` ヘルパで 7 か所の呼び出しを置き換え | `access/model.ts`・`AccessPanels.tsx`・`ManagementPanels.tsx`・`AccessCard.tsx`・`ops.ts`・`runtime.ts` | 単体（都市なしの深い一致・3 種類の都市）、`city-access` ゴールデン | **高**（回帰: 全 sim 系ゴールデン、`access*.test.ts`、e2e `access`・`management`） |
| C5 | **運航中のアクセス**（`extMin`・`railSeats`・`railFeeMul` を都市があるときだけ）、駅の運営費の倍率 | `access/runtime.ts`・`ops.ts` | 単体（従来の運航状態にキーなし）、全 sim 系ゴールデン | **高**（`runtime.ts` は `state.rng` を引く。抽選の回数・順は変えない） |
| C6 | **需要の上限**: `planning.ts` の `cityDemandFactor`、`generateOffers` の倍率、締めの成長・利用率・鉄道協定の完了、`DEMAND_CEILING` の計画警告、`rail` 目標の条件の変更 | `planning.ts`・`company.ts`・`ops.ts`・`goals.ts` | 単体（都市なしで `planDay` 不変、上限での係数、提案の乱数の回数不変）、`game-models` ゴールデン不変の確認、`city-sim` ゴールデン | **高**（回帰: 全ゴールデン、`planning.test.ts`、`company.test.ts`、`goals.test.ts`） |
| C7 | UI: GameSetup の都市、AccessCard の都市の行、経営パネルの鉄道協定、プロパティパネルの注記、ja ラベル | `GameSetup.tsx`・`AccessCard.tsx`・`ManagementPanels.tsx`・`PropertiesPanel.tsx`・`i18n/ja.ts` | e2e 新規 `city.spec.ts`（新しいゲームで都市 = 大都市 → アクセス表の車の所要時間が都市の値・駅の種別を特急に変えると鉄道の分担が上がる） | 中 |

### 3b-2 騒音（4 コミット）

| # | 内容 | 主なファイル | テスト | リスク |
|---|---|---|---|---|
| N1 | `noise.ts`（騒音単位・重み・指数・住民の式・防音工事） | `economy/noise.ts` | 式の単体 | 低 |
| N2 | 締めへの組み込み（指数・違反・罰金の費用区分 `noise`・評価の減点・工事日数の倍率・成長への影響）、`landingFee` の時間帯の倍率 | `ops.ts`・`company.ts`（費用区分）・`construction.ts` | 単体（noise なしで日報のキー不変・着陸料不変）、`city-sim` ゴールデンに含める | 中（回帰: 全 sim 系ゴールデン） |
| N3 | UI: NoiseCard、門限のアラート、経営パネルの防音工事、GameSetup のチェック | `cards/NoiseCard.tsx`・`alerts.ts`・`OperateLayout.tsx` | e2e（騒音カードの表示・閉場前のアラート） | 低 |
| N4 | 振り返りの「騒音」の節 | `analytics/review.ts`・振り返りの UI | 単体（`noise` なしで `DayReview` にキーなし） | 低 |

### 3b-3 出来事（7 コミット）

| # | 内容 | 主なファイル | テスト | リスク |
|---|---|---|---|---|
| E1 | `events.ts`: 定義表・`planEvents`（乱数の回数固定）・`eligible`・判断・既定・修飾子 | `economy/events.ts` | 単体（決定性、乱数の回数が結果によらず一定、難易度の確率、`state.rng`/`c.rng` を変えない） | 低 |
| E2 | `Disruption.origin 'event'`・`eventId`、`eventStep.ts`（実現・期限・再検証）、`simulation.ts` のフック 1 行と開始時の計画 | `sim/types.ts`・`sim/eventStep.ts`・`sim/simulation.ts` | 単体（`events` なしで `stepEvents` を通らない、出来事のない日の運航が完全一致）、不変条件 | **高**（回帰: 全 sim 系ゴールデン、`simulation*.test.ts`、`disruptions.test.ts`、1 日スキップの決定性テスト） |
| E3 | 運航系 O1〜O4・P2（障害の対応づけと選択肢の結果） | `eventStep.ts` | 単体（各出来事 1 本: 閉鎖の時間・評価の変化） | 中 |
| E4 | 経営系 X1〜X4・P1・S1（チャーター・臨時便・修飾子・営業外の現金）、`settleDay` の結果の評価と翌日の計画 | `events.ts`・`company.ts`（チャーターの満了分岐）・`ops.ts`・`landingFee` | 単体（チャーターが更新されない、`acceptOffer` を通らない）、`events-sim` ゴールデン | **高**（`company.ts` の `updateContracts` 分岐。回帰: `company.test.ts`、全ゴールデン） |
| E5 | アラートの `eventChoice`・EventsCard の判断・`flightActions` 相当の操作（`simRunner` に `respondEvent`） | `alerts.ts`・`EventsCard.tsx`・`editor/simRunner.ts` | e2e（判断待ちのアラート → 選択 → 消える） | 中 |
| E6 | 振り返り: 「出来事」の節と「明日の見通し」の予定・判断 | `review.ts`・振り返りの UI | 単体・e2e（振り返りで明日のチャーターを受ける → 翌日の運航表に臨時便） | 中 |
| E7 | ドキュメント: `docs/31_city_noise_events.md`（新）、docs/15・21・26・30・08 の更新、設計メモ | docs | — | 低 |

- **規模**: 18 コミット（S0 を除く）、実装セッション 4〜5 回。3b-1 が最大（C4〜C6 が山場）。
- コミットの束ね方: C1 単独（版の枠を先に入れる）、C2+C3、C4、C5、C6、C7、N1+N2、N3+N4、E1、E2、E3、E4、E5+E6、E7。各サブ段階の終わりに独立監査（Haiku）→ 差分レビュー（Opus）。

### 6.1 高リスクのステップの回帰リスト（毎回すべて実行）

- ゴールデン: `sim`・`sim-midrun`・`stress-sim`・`project-sim`・`crossing-sim`・`bus-sim`・`legacy-remote-sim`・`game-models`・`game-weather`・`project`・`normalized-hashes`（バイト一致）。
- 単体: `access`・`planning`・`company`・`ops`・`goals`・`airlineEval`・`disruptions`・`dayloop`（1 日スキップの決定性）・`project`（版）・`invariants`。
- e2e: `access`・`management`・`operate`・`dayloop`・`game-setup`。

### 6.2 must / could

- **must**: 都市（3 種類・上限・所要時間・成長・鉄道協定）、鉄道の種別（props・効果・UI）、騒音（指数・住民・違反の罰金・夜間割増・防音工事・カード・振り返り）、出来事 must の 11 件（X1〜X4・O1〜O4・P1・P2・S1）と判断の UI・振り返り。
- **could（バックログ、優先順）**: 騒音の等高線オーバーレイ → X5 経営危機 → 門限のハードな強制（閉場後の到着をダイバート・出発を欠航。`simulation.ts` の着陸許可に触れるので別段階）→ 夜間の契約の時間帯 `'night'`（`TimeWindow` の拡張は保存の形に影響）→ 運用時間の 4:00 開始・24:00 終了（0:00 の締めと衝突するので日の境界の設計が要る）→ O5・X6・S2 → 国内線/国際線の比率。
- 削る順（予算が足りないとき）: X4 の臨時バスの選択肢 → P1 の「夜間に移す」→ O4 の短縮 → 振り返りの騒音の原因の上位 3 → 鉄道の内訳表示。

---

## 7. リスクと PO への確認

### 7.1 リスク

| リスク | 対策 |
|---|---|
| 都市の式が既存の結果に漏れる（`planDay` の `access × 1` の浮動小数の差など） | 都市がなければ `access` をそのまま渡す分岐。`analyzeAccess` の深い一致の保護テスト。全ゴールデンのバイト一致 |
| `runtime.ts` の抽選の回数・順が変わる | 新しい値は定員・時間・倍率だけに使い、`withRng` の呼び出しは触らない。従来の運航状態に新キーなし |
| 需要の上限が強すぎて成長が止まる・弱すぎて無意味 | 表の値は §2.1 で格の条件と突き合わせ済み。C6 で 3 種類の都市 × 30 日のヘッドレス実行のバランス確認（テストではなく記録） |
| 出来事が多すぎて煩わしい／運航が壊れる | 1 日最大 3 件、normal の λ を低く。障害は既存の種類だけ（新しい閉鎖の仕組みを作らない）。判断はすべて既定と期限あり |
| 出来事が乱数の列を乱す | 専用の乱数（計画の 1 本と使い捨ての判定）。`state.rng`・`c.rng` を引かないことを単体で検証（前後の `state.rng`/`c.rng` の一致） |
| 1 日スキップで判断できない | 期限で既定を自動適用。経営系は振り返りで判断（スキップ前に判断の機会がある） |
| 3a のアプリで 3b のファイルを開く | `formatVersion 3` で拒否 |
| `rail` 目標の条件変更が 3a の進行に影響 | 3a は未リリース。ゴールデン（駅なし）は不変。docs/30 §4 を更新 |
| 臨時便の便名の重複 | 接頭辞 `EV`、既知の課題（HANDOVER §5）の範囲で扱う |
| 騒音の指数が記録の取りこぼしで不正確（途中の締め `partial`） | `partial` の日は表示のみで住民の満足度を更新しない |

### 7.2 PO への確認（本当に必要なものだけ、推奨の既定つき）

1. **新しいゲームの都市の既定**: ロードマップは「地方都市」だったが、地方都市は需要の上限が約 2,900 人/日で格 2（1 万人/日）に長く届かない。→ **推奨: 既定は中核都市**、地方都市は「難しい立地」、大都市は「需要は大きいが騒音に厳しい」として選べる。
2. **新しいゲームで騒音・出来事を既定 ON にするか**: → **推奨: 都市・騒音・出来事とも既定 ON**（normal の出来事は 1 日平均 約 0.45 件）。設定画面でそれぞれ外せる。

（その他はこの文書の値で進める: 門限 = 運用時間（ハードな強制はバックログ）、騒音の重みは Lden 風の ×1/×3/×10、鉄道の種別は都市モデルがあるときだけ効果、`rail` 目標は「鉄道の利用者 100 人/日」に変更、`PROJECT_FORMAT_VERSION 3` を新設。）
