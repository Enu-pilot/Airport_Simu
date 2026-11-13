# 12B-3a 詳細設計: バス搭乗・独立ゲート／天候 5 段階・予報・難易度／航空会社の評価要素／目標と空港の格

作成: 設計リード（2026-11-13）。対象: `claude/phase12b-ops-experience`（コミット `636b651` 時点の **コミット済み** コードを調査。実装者の未コミットの変更は無視）。**設計のみ**（リポジトリは未変更）。
入力: `scratchpad/phase12b/design.md`（§C・§C.6・§E.1・§F・§G.4・§G.6）、`scratchpad/phase12b/po_request.md`（追加要望 2026-11-13「リモートスポット・搭乗バスゲート」）。
本文は日本語、識別子は英語。数値はすべて **ゲーム値**（実在の運用基準・安全基準への適合をうたわない）。

## 0. 要約と判定

- 12B-3a は 2 つの独立した柱からなる。**(A) 搭乗方式（バス搭乗・独立ゲート）** は **レイアウトのデータ**（ゲートの `boardingMode: 'bus'`／`connectedTo`、GSE 基地の `apronBuses`）で有効化し、**(B) ゲームのモデル（天候・難易度・評価・目標）** は **会社の `company.game`** で有効化する。どちらも欠落 = 従来と完全一致。
- 調査の結論: 今日のリモートスポット（ゲートのないスポット）は **割り当てられる** が、出発旅客は全員「ゲートなし」で乗り遅れ、到着旅客は「到達不能」になる（§1.3）。バス搭乗はこの空白を埋める。従来データの挙動は **一切変えない**（バスゲートが 1 つもなければ新しいコードに入らない）。
- `SCHEMA_VERSION`・`SIM_MODEL_VERSION` は上げない。`PROJECT_FORMAT_VERSION` は 2 にするが、**新しい項目を使うファイルだけ** `formatVersion: 2` を書く（`project.golden.json` は直列化の sha256 なので、無条件に変えると壊れる — §5）。
- 実装順: **A（バス・独立ゲート）→ B（天候・難易度 → 評価 → 目標）**。合計 約 16 コミット、3〜4 回の集中した実装セッション。最もリスクが高いのは A4（`passengers.ts`）と B3（`simulation.ts` の着陸復行・欠航）。

---

## 1. 調査結果（現状と空白）

### 1.1 ゲート施設とスポットの紐付け

| 事実 | 出典 |
|---|---|
| `Facility.props` は `Record<string, PropValue>`（`string | number | boolean | null`。配列は持てない） | `src/core/model/types.ts:184-199` |
| ゲートは 1×1、層 `gate`、プロパティは `standId`（`standRef`）と `jetBridge`（bool）だけ。既定 `{ standId: null, jetBridge: true }` | `src/core/model/catalog.ts:47,76-79,113` |
| ゲートとスポットの最大距離 3 タイル | `catalog.ts:153-154` |
| 配置時に最も近い空きスポットを自動で紐付け | `src/core/layout/operations.ts:146-165` |
| 後処理で、削除済みスポットを指す `standId` を null にする | `operations.ts:105-112` |
| プロパティの更新の検証は `PROP_SCHEMAS` の型ごと（`standRef` は存在するスポット ID か null） | `operations.ts:929-946` |
| `contact` = `standId` を持つゲートが **1 つでもある** スポット（ゲートの建設状態は見ない） | `src/core/sim/context.ts:133-149` |
| `standGate`（スポット → ゲート）は ID 順で最初のゲート | `context.ts:151-154` |
| `paxTerminal` = 入口を持つ最初のターミナル（出発旅客は必ずここに現れる） | `context.ts:155-158` |
| ゲートの搭乗口・降機口 = ゲートの上下左右 4 タイルに接するターミナルのエリア（出発区域: 出発ロビー > 待合 > その他、到着区域: 到着通路優先） | `src/core/terminal/model.ts:103-134` |
| エリアのリンクは **同じターミナルの中だけ**（ターミナル間・屋外の経路はない） | `terminal/model.ts:85-100`、`docs/12 §7` |

### 1.2 検証（ゲート・スポット）

- `GATE_NOT_AT_TERMINAL`（error: ターミナルに接していない）、`GATE_NO_STAND`（warning）、`GATE_STAND_TOO_FAR`（error）、`STAND_REMOTE`（info）、`STAND_MULTIPLE_GATES`（warning）: `src/core/validation/validate.ts:716-748`。
- `GATE_NO_BOARDING_ACCESS`・`GATE_UNREACHABLE`・`GATE_NO_ARRIVAL_ACCESS`・`GATE_ARRIVAL_NO_EXIT`（`model.gates` から）: `validate.ts:850-873`。`TERMINAL_NO_GATE`（info）は隣接ゲートだけを数える: `validate.ts:722-729`。
- 互換性: `checkGate` は `standId` がなければ `unknown`（`GATE_NO_STAND`）: `src/core/aircraft/compat.ts:89-100`。

### 1.3 スポットの割り当てと、今日のリモートスポットの旅客

- `assignStand`: 候補を「ゲート故障中でない > 計画スポット > **区分の小さい順** > ゲート付き > ID」で並べる（`src/core/sim/simulation.ts:548-601`、並びは `565-572`）。**区分が合えばリモートスポットも割り当てる**（S 機は M のゲート付きより S のリモートを先に選ぶ）。運航計画の仮割り当ても同じ並び（`src/core/economy/planning.ts:206-229`、ゲートがなければ `NO_GATE` の warning）。
- 出発便: `p.gateId = ctx.standGate[ac.standId] ?? null` を毎ティック設定（`src/core/sim/passengers.ts:191`）。ゲート未定の旅客は待合で `dwell`（`passengers.ts:548-560`）。締切で **全員 `missed`（理由 `noGate`）**（`passengers.ts:231-232`、`docs/12 §6`「スポットにゲートがない → 待合で待機 → 乗り遅れ（ゲートなし）」）。機体は締切（`boarding === 'closed'`）までプッシュバックしない（`simulation.ts:1060-1065`）。
- 到着便: 降機口がない → グループは生成されるが `stranded`（`unreachable`）のまま（`passengers.ts:401-404`）。降機速度はゲートの `jetBridge` で決まる（`passengers.ts:358`）。
- **結論**: リモートスポットの旅客処理は存在しない（`docs/12 §7`「リモートスポットのバス搭乗は未実装」、`docs/10` G-05）。**この挙動（乗り遅れ・到達不能）を従来データでは 1 ビットも変えない**。

### 1.4 旅客の流れ（関係する部分）

- 搭乗開始: スポットで地上作業中・降機等の完了・`estimated − BOARDING_LEAD_MIN[S/M/L]`（20/30/40 分）: `passengers.ts:48,140-143,193-201`。締切: `max(estimated − 10 分, 開始 + 15 分)`、ゲートの列が残る間は締めない: `passengers.ts:202-211`。
- ゲートは待ち行列キー `gate:<id>`、窓口数 1（故障中 0）: `passengers.ts:106-112`。処理時間 3 秒/人（ブリッジ）・5 秒/人: `passengers.ts:53,777-781`。処理完了で `boarded`: `passengers.ts:723-733`。
- 経路探索はエリアのグラフのダイクストラ（区域の規則つき）: `src/core/terminal/route.ts:25-62`。不変条件 P1〜P5: `src/core/sim/invariants.ts:253-293`（P2: 搭乗済みは自便のゲートを通過）。

### 1.5 地上車両（ユニット）

- `UnitKind` 8 種、`GroundUnit` は 1 台ずつ、`taskId` は `state.tasks` の ID: `src/core/sim/types.ts:199-224`。
- 基地（GSE 基地・整備施設）のプロパティから運航開始時に生成。種類の順は固定の配列: `src/core/sim/ground.ts:72-99`、基地の台数は `context.ts:165-182`。
- **移動は直線（道路網を使わない）**: `travelSec = 距離 × 25m ÷ 8 m/s + 30 秒`（`ground.ts:107-109`、`baggage.ts:23-24`）。サービス道路（`roadClass: 'service'`）は検証の「エアサイドへの接続」にだけ使われ、車両の移動には使われていない（`validate.ts:700-707`）。
- 作業の割り当て `allocate` は種類で絞る（`ground.ts:449-469`）。故障 `setUnitBroken`（`ground.ts:137-156`）、ランダム故障は **全ユニットについて乱数を 1 回ずつ引く**（`ground.ts:598-613`）。不変条件 G1: `u.taskId` は `state.tasks` にあり自分を含む（`invariants.ts:217-220`）。
- 作業の定義 `TASK_DEFS`・`TURNAROUND_TASKS`（全機体で同じ 8 作業）: `src/core/sim/tasks.ts:11-22`。
- 障害: `vehicleFailure` は `state.units[id]` を故障させる（`disruptions.ts:172-176`）、ランダムな `gateFailure` は `Object.values(ctx.standGate)` から選ぶ（`disruptions.ts:394-396`）、配置換え `moveUnitToBase` は `taskId` がなければ移動できる（`disruptions.ts:346-359`）。
- 空港アクセスのバス（`src/core/access/*`、施設 `busStop`、`fees.bus`、`accessFees.bus`）は **陸側の路線バス** で無関係。混同を避けるため、新しい車両は **`apronBus`（ランプバス）** と命名する。

### 1.6 経済・分析・UI・描画・保存

- 車両の購入費 `construction.vehicle`（`balance.ts:36`）、基地の資産額は `VEHICLE_PROPS` の台数分（`src/core/economy/construction.ts:18-25,37-38`）。日次の費用は基地の `units` を走査し、給与表にない種類は「車両」1 台 300 cr（`src/core/economy/ops.ts:95-128`）。作業ごとの費用は `groundOps`（`ops.ts:233-238`）。
- 記録 `FlightRecord.gateId = dep.pax.gateId ?? standGate`（`src/core/analytics/records.ts:27,154`）。KPI の車両稼働率は種類ごと（`kpi.ts:189-194`）。
- 評価カード（12B-1）: `airlineScorecard` の要素 `stand` は計画の `NO_GATE` を warn として数える（`src/core/economy/airlineScore.ts:114-122`）。
- 振り返り（12B-2）: `WeatherForecast { summary }` が「12B-3a まで常に null」（`src/core/analytics/review.ts:73-77,88,177`）。
- UI: 施設のプロパティは `PROP_SCHEMAS` を走査して描画。`enum` は `String(value)` を選択値にする（欠落すると `"undefined"`）: `src/ui/PropertiesPanel.tsx:469-505`。運航表のスポット列: `src/ui/operate/FidsOverlay.tsx:110-144`。地上カード: `src/ui/operate/cards/GroundCard.tsx`。
- 描画: 2D のユニット色 `UNIT_COLOR: Record<UnitKind>`（`src/render/MapRenderer.ts:804,902`）、3D は全ユニットを同じ箱のインスタンスで描く（`src/render/three/Scene3D.ts:47,304-326`）。
- 保存: `PROJECT_FORMAT_VERSION = 1`（`src/core/io/project.ts:27`）、`buildProject` は `formatVersion` と `versions.format` に定数を書く（`project.ts:86-98`）。読み込みは新しい版を拒否（`project.ts:289-290`）。`validateProject` も定数で作り直す（`project.ts:384-403`）。`tests/golden/project.golden.json` は **直列化全体の sha256**。レイアウトの施設プロパティの中身は検証していない（`checkLayout` は ID・参照・滑走路だけ: `project.ts:123-152`）。

### 1.7 空白（ギャップ）

1. リモートスポットの旅客処理がない（出発は全員乗り遅れ、到着は到達不能）。
2. ゲートの接続先は「隣接」で暗黙に決まる。明示の接続・屋外の通路・ターミナル間の経路がない。
3. 旅客を運ぶ車両がない（GSE は作業単位で、旅客を載せる概念がない）。
4. 天候は 4 種の障害（`WEATHER_EFFECTS`）だけ。予報・難易度・評価要素の保存・目標がない（design.md §C/§E.1 の骨子のみ）。

---

## 2. バス搭乗とリモートスポット

### 2.1 方針（最小で一貫した集合）

- **バスゲート** = `boardingMode: 'bus'` のゲート。ターミナルの搭乗口（またはその独立ゲート版、§3）で搭乗券を確認し、ゲートのタイル（エプロン側）がバス乗り場（bay）を兼ねる。**バス乗り場の新しい施設は作らない**（施設の種類・占有・3D・建設費が増えるだけで遊びが増えない）。
- **バスゲートはスポットに固定しない（プール方式）**: 実際の空港でもバスゲートは便ごとに割り当てる。バスゲートが 1 つ以上ある空港では、**コンタクトゲートのない（`contact === false`）すべての運用中スポット** がバスで扱われる（以下「バス扱いのスポット」）。便ごとに負荷の少ないバスゲートを選ぶ（§2.4）。→ `PropValue` に配列がない制約（§1.1）とも整合し、スポットの一覧を持つ UI も要らない。
- **ランプバス** = 新しい `UnitKind 'apronBus'`。GSE 基地の新しいプロパティ `apronBuses`（0〜30、**欠落 = 0**）で台数を決め、その基地を拠点にする。移動は既存の GSE と同じ **直線の移動時間モデル**（§1.5）。サービス道路の経路化は全車両の共通課題として後続（Phase 13 の形状の後）。
- **タラップ（旅客用ステップ車）は作らない**: 機体側のステップ（自走タラップ）がある前提で、時間だけを見込む（`could`: 後で `stairsTruck` ユニット）。

### 2.2 データモデル

```ts
// catalog.ts — PropDef に参照型を 1 つ追加
| { key: string; type: 'facilityRef'; of: FacilityKind }   // §3 の connectedTo 用

PROP_SCHEMAS.gate = [
  { key: 'standId', type: 'standRef' },
  { key: 'jetBridge', type: 'bool' },
  { key: 'boardingMode', type: 'enum', options: ['contact', 'bus'] },   // 欠落 = 'contact'
  { key: 'connectedTo', type: 'facilityRef', of: 'terminal' },          // 欠落 = 隣接（§3）
];
PROP_SCHEMAS.gseBase に { key: 'apronBuses', type: 'int', min: 0, max: 30 } を追加（欠落 = 0）
```

- **`DEFAULT_PROPS` は変更しない**（新しく置いたゲート・基地の JSON が従来と同じになり、`placeFacility` で作るテスト・サンプル・ゴールデンの入力が変わらない）。欠落 = 既定値は読む側で解釈する: `gateMode(f) = f.props.boardingMode === 'bus' ? 'bus' : 'contact'`（`src/core/model/gates.ts` 新設、純関数。`connectedTerminal(f, layout)` も同じファイル）。
- UI の `enum` は欠落時に先頭の選択肢を表示する（`PropertiesPanel` の `String(undefined)` を直す。`PropDef` に `default?: PropValue` を足し、`enum` は `options[0]`、`int` は `min` を既定に）。
- バスへ切り替えると UI は 1 回の更新で `{ boardingMode: 'bus', standId: null, jetBridge: false }` を送る（取り消しは 1 回）。`contact` に戻すときは `standId` を自動の紐付けにしない（プレイヤーが選ぶ）。

```ts
// sim/types.ts（型の追加のみ。既存の値は不変）
export type UnitKind = … | 'apronBus';
export type PaxState = … | 'waitingBus' | 'onBus';
export type MissReason = … | 'noBus';
export type DelayCause = … | 'apronBus';
interface GroundUnit { …; trip?: string }               // バスの運行 ID（バスだけ。欠落 = なし）
interface FlightPax { …; bus?: { gateClosedAt: number | null } }   // バス扱いの便だけ持つ
interface PaxGroup { …; busTrip?: string }              // 乗車中・乗車待ちの運行
interface SimState { …; bus?: ApronBusRuntime }          // バスゲートがある運航だけ

interface ApronBusRuntime {
  trips: Record<string, BusTrip>;      // ID 'bt_n'（counters.bt）
  active: string[];                    // 未完了の運行（発行順）
  stats: { trips: number; pax: number; waitSec: number; shortageSec: number; rescues: number };
}
interface BusTrip {
  id: string;
  dir: 'dep' | 'arr';                  // dep: ゲート → スポット / arr: スポット → ゲート
  flightId: string;
  gateId: string;
  standId: string;
  busId: string | null;                // 未配車 = null（バス不足）
  phase: 'waiting' | 'toPickup' | 'loading' | 'driving' | 'unloading' | 'stalled' | 'done' | 'cancelled';
  phaseSince: number;
  phaseUntil: number | null;
  groups: string[];
  pax: number;
  createdAt: number;
  /** 故障したバスの位置（救援の合流点） */
  stallAt?: { x: number; y: number };
}

// context.ts
interface SimContext { …; busGates: string[] }   // 運用中・boardingMode 'bus' のゲート（ID 順）
```

- `context.ts` の `contactStands` と `standGate` の集計から **バスゲートを除く**（`f.props.boardingMode !== 'bus'` を条件に足す）。従来データにはバスゲートがないので結果は同一。
- 基地の `units` には `apronBuses > 0` のときだけ `apronBus` のキーを足す（0 のキーを作らない → `dailyFixedCosts`・`planning` の集計の走査順・値が従来と同一）。
- `createGroundUnits` の `order` の **末尾** に `'apronBus'` を足す（台数 0 なら ID の発行は従来と同一）。
- `createSimulation`: `ctx.busGates.length > 0` のときだけ `state.bus = { trips: {}, active: [], stats: … }`。ないときはキー自体を作らない（`JSON.stringify(state)` が従来と一致）。

### 2.3 「新しいコードに入らない」ことの根拠（従来データ）

| 入口 | 条件 | 従来データで |
|---|---|---|
| 旅客のバス扱い（`passengers.ts`） | `state.bus` があり、スポットが `contact === false` | `state.bus` がない → 既存の行 `p.gateId = ctx.standGate[…] ?? null` だけを通る（§1.3 の乗り遅れ・到達不能のまま） |
| `stepApronBuses(sim)`（`simulation.ts` の `stepSimulation` で `stepPassengers` の直後） | `if (state.bus)` | 呼ばれない |
| ランプバスの生成 | 基地の `apronBuses > 0` | 生成しない → `randomFailures` の乱数の回数・`gu_n` の ID は同一 |
| `contact`・`standGate` | バスゲートを除く | バスゲートがない → 同一。ランダムな `gateFailure` の候補（`standGate` の値）も同一 |
| 旅客の新しい状態 `waitingBus`・`onBus` | バス扱いの便だけ | 発生しない |
| 保存 | `formatVersion` 2 は新しい項目があるときだけ | 1 のまま（§5） |

保護テスト（A0 で **先に** 入れる、§6）: (1) リモートスポットを含む既存の形のレイアウト（ゲート 1 つを外したサンプル空港）で 1 日運航した `state` の sha256 を **変更前のコードで** 採ってテストに固定、(2) 全ゴールデンが不変。

### 2.4 出発便の流れ（状態遷移の拡張）

```
toAirport → … → security → (shop/restroom) → walking → [バスゲートの搭乗口] dwelling
  → boardingQueue（gate:<id>、搭乗券の確認 2 秒/人）
  → waitingBus（搭乗口のエリアに滞在、busTrip = 乗る運行）
  → onBus（area = null、バスに乗車）
  → boarded（スポットで降車 → タラップで機内へ）
```

1. **バスゲートの選択**（`pickBusGate(sim, f, need: 'boarding' | 'deplane')`、`sim/apronBus.ts`）: スポットが決まり（`ac.standId`）、`contact === false`、`state.bus` があるとき。候補 = `ctx.busGates` のうち、故障・閉鎖中でなく、`model.gates[g].boarding`（到着は `deplane`）があるもの。並び = そのゲートを使っている未締切の便の数 → スポットとの距離 → ID。**選んだら固定**（`p.gateId`）。搭乗開始前にゲートが故障したら選び直す。候補がなければ `p.gateId = null`（従来と同じく締切で `noGate`）。`p.bus = { gateClosedAt: null }` を付ける。
   - プレイヤーが運航表でコンタクトスポットへ変えた場合（`reassignStand`）、`standGate` の値が優先し `p.bus` を消す。
2. **搭乗開始**: 条件は従来と同じで、先行時間に `BUS_EXTRA_LEAD_MIN = 10` 分を足す（S 30 / M 40 / L 50 分前）。最低の搭乗時間は `BUS_MIN_WINDOW_SEC = 20 分`。
3. **ゲートの処理**: `serviceSec` はバスゲートなら `BUS_GATE_SEC_PER_PAX = 2` 秒/人（`hasBridge` を見ない。バスゲートの `jetBridge` は無視）。処理の完了で `boarded` にせず `waitingBus` にし、`boardedGate = gateId` を記録（P2 を満たす）。`g.area` は搭乗口のまま（混雑に数える）。
4. **ゲートの締切**（バス扱いの便）: `now >= deadline` かつゲートの列が空 → **ゲートより前** のグループを従来の理由（`late`・`unreachable`・`facilityClosed`）で乗り遅れにし（`onPaxMissed` で補償）、`p.bus.gateClosedAt = now`。`waitingBus`・`onBus` のグループは乗り遅れにしない。
5. **搭乗の完了**: `waitingBus`・`onBus` のグループがなくなったら `closeBoarding(sim, f, null)`（残りはないので `boarding = 'closed'` だけ）→ 地上作業 `board` が完了 → 機体はプッシュバックへ（`ground.ts:411-416`、`simulation.ts:1060-1065` は無変更）。
6. **バスが来ない**: `gateClosedAt + BUS_GIVEUP_SEC（15 分）` を過ぎても `waitingBus` のグループ（まだ乗車していない）は `missed`（理由 `noBus`）。乗車中（`onBus`）は必ず運ぶ。
7. **遅延の理由**: バス扱いの便で `now > estimated` かつ未締切なら `addDelayCause(dep, 'apronBus')`（既存の `boarding` も従来どおり付く）。

### 2.5 到着便の流れ

```
（ブロックイン）降機: スポットで waitingBus（area = null、busTrip = 運行）
  → onBus → [バスゲートの降機口] walking → claim → exit（従来どおり）
```

- バス扱いの到着便は、降機口の代わりにスポットに `waitingBus` で現れる（降機速度はタラップの 12 人/分）。手荷物受取所はバスゲートの降機口から決める（`claimAreaId` の計算は同じ関数）。`p.gateId` に到着のバスゲートを入れる（到着便の `gateId` は従来 null のまま使っていない項目）。
- 地上作業 `deplane` は `deplaneRemaining === 0` で完了（従来どおり）。旅客がバスで移動中でも折り返しは進む。
- 降機口がないバスゲートしかない場合: 従来どおり `stranded`（`unreachable`）。

### 2.6 配車（`stepApronBuses`、決定的）

処理順: (1) 故障の検出 → (2) 各運行の段階を進める → (3) 運行の要求を作る → (4) 空きバスを割り当てる。

- **要求の作成**:
  - 出発: バス扱いの便で `waitingBus` のグループがゲートにいて、その便の「乗車受付中（`toPickup`/`loading`/`waiting`）」の運行がない → 新しい運行（`waiting`）。
  - 到着: バス扱いの便がブロックインし、スポットで `waitingBus` のグループがいて、受付中の運行がない → 新しい運行。
- **割り当て**: 未配車の運行を「出発の締切が早い順 → 到着のブロックイン順 → 運行 ID」で並べ、空きバス（`apronBus`・故障でない・`trip` なし・`idle` か `returning`）のうち乗車地点に最も近いもの（同距離は ID）。空きがなければ `waiting` のまま（`stats.shortageSec++`。UI の「ランプバス不足」アラート）。
- **段階**（ゲーム値）:

| 段階 | 時間 | 終わる条件 |
|---|---|---|
| `toPickup` | `travelSec(bus, 乗車地点)`（`ground.ts:107-109` を export して共用） | 到着 |
| `loading` | ドアの開閉 `BUS_DOOR_SEC = 60` 秒 ＋ 乗車 1 秒/人 | 満員（次のグループが入らない）／その便に乗車待ちがもう来ない（出発: ゲートより前のグループがない、到着: `deplaneRemaining === 0` でスポットに残りなし）／`BUS_MAX_LOAD_SEC = 300` 秒経過かつ 1 人以上／出発の締切を過ぎた |
| `driving` | `travelSec(乗車地点, 降車地点)` | 到着 |
| `unloading` | `BUS_DOOR_SEC` ＋ 出発: 2.5 秒/人（降車してタラップ 2 か所で搭乗）／到着: 1 秒/人 | 完了 → 出発: グループを `boarded`（`f.pax.boarded`・`paxStats.boarded`・`finish`）、到着: 降機口に置いて `planStep` |
| 完了後 | — | バスは基地へ `returning`（途中でも次の運行に割り当て可能＝既存の GSE と同じ） |

- 定員 `APRON_BUS_CAPACITY = 60` 人。グループ（1〜5 人）は分割しない。乗車地点: 出発 = ゲートのタイルの中心、到着 = スポットのノード `${standId}:P`。
- バスのユニットの `taskId` は使わず `trip` を使う（G1 の不変条件と `allocate` に触れない）。移動は `fromX…moveEnd` を設定し、`stepUnit`（`ground.ts:284-297`）の補間をそのまま使う。稼働時間（`busySec`）はバスの処理側で加算。

### 2.7 故障・不足・欠航

- **バス不足**: 運行が `waiting` のまま → 乗車待ちが増え、締切後 15 分で `noBus` の乗り遅れ、機体は搭乗の締切待ちで遅延（`apronBus`・`boarding`）。航空会社の満足度は既存の乗り遅れ率・定時率で下がる。補償は既存の `compensation.missedPax`。
- **故障**（`vehicleFailure`・ランダム故障・手動）: `setUnitBroken` は `taskId` がないバスには作業の処理をしない（変更不要）。`stepApronBuses` が `trip` を持つ故障中のバスを検出する:
  - `toPickup`／`loading`（出発で乗客がゲート側）: 乗車済みのグループを `waitingBus` に戻し、運行を未配車（`waiting`）に戻す。
  - `driving`／`unloading`（乗客が車内）: 運行を `stalled`（`stallAt` = 故障位置）にし、**救援**: 別の空きバスを最優先で故障位置へ送り、乗り換え（`BUS_DOOR_SEC × 2`）してから目的地へ（`stats.rescues++`）。救援が来るまで乗客は車内で待つ（遅延）。
  - 故障したバスは `trip` を外され、修理後は基地へ戻る（既存）。
- **配置換えの保護**: `moveUnitToBase` は `u.trip` があるバスを `OCCUPIED` で拒否（条件を 1 つ足すだけ。従来のユニットに `trip` はない）。
- **ゲート故障**（手動の `gateFailure` でバスゲートを指定）: `serversOf = 0` で列が進まない（既存）。搭乗開始前ならゲートを選び直す。ランダムな `gateFailure` の候補（`standGate`）にはバスゲートは入らない（乱数の並びを変えないため。`could`: バスがある運航だけ候補に足す）。
- **欠航**（`closeBoarding(..., 'cancelled')`）: `waitingBus`/`onBus` を含む未完了のグループは従来どおり `cancelled`。その便の運行は `cancelled`（車内の旅客は記録上欠航扱い、バスは基地へ）。

### 2.8 不変条件（`checkBusInvariants`、`state.bus` があるときだけ `checkInvariants` から呼ぶ）

- BU1 `onBus` のグループはちょうど 1 つの未完了の運行の `groups` に含まれ、`g.busTrip` が一致。
- BU2 運行の `pax` = グループの人数の合計 ≤ 定員。
- BU3 配車済みの運行のバスは `trip === 運行 ID` で、1 台が 2 つの運行を持たない。故障中のバスは `driving/unloading/loading/toPickup` の運行を持たない。
- BU4 `waitingBus`/`onBus` のグループの便は `p.bus` を持つ（到着は `p.gateId` がバスゲート）。
- 既存の P1（人数の一致）は状態の追加後もそのまま成り立つ（`waitingBus`/`onBus` は終了状態でない）。P3 の「待ち状態だが待ち行列にいない」（`invariants.ts:293`）の判定対象に新しい状態を含めないこと。

### 2.9 スポットの割り当て・計画・航空会社

- `assignStand` と計画の並びは **変えない**（従来の結果を保つ。バス扱いのスポットはもともと割り当てられている）。`could`: 「バス空港ではコンタクトを区分より優先」の設定（`company.game` 側）。
- 計画の分析: `ctx.busGates` があり、仮割り当てのスポットがリモートなら `NO_GATE` の代わりに `BUS_BOARDING`（info、新しい `PlanIssueCode`）。
- 評価カード（12B-1 の `stand` 要素）: `BUS_BOARDING` の便の割合を `busShare` として事実に足す（表示のみ）。12B-3a の評価要素（§4.3）では種類別の重みで減点: フルサービス −20×busShare、リージョナル −10×busShare、LCC 0。

### 2.10 経済

| 項目 | 値（ゲーム値） | 場所 |
|---|---|---|
| ランプバスの購入費 | 250,000 cr/台 | `balance.ts` `construction.vehicle.apronBus`、`construction.ts` `VEHICLE_PROPS` に `['apronBuses','apronBus']`（欠落は `num(undefined) = 0` で従来値と同一） |
| 維持費 | 既存の車両 300 cr/台・日 ＋ 運転士 `daily.salary.apronBus = 1,500` | `ops.ts:95-128`（給与表に入れると自然に `salary` に計上） |
| 運行ごとの費用 | 150 cr/運行（`taskCost.busTrip`、`groundOps`） | `onBusTrip(sim)` を `economy/ops.ts` に追加 |
| バスゲート | 建設費・要員費は従来のゲートと同じ。`jetBridge` は 0 扱い（UI で false に） | — |
| 料金の割引 | **入れない**（航空会社の評価要素で表現）。`could` | — |

### 2.11 分析

- `FlightRecord` に任意項目 `boarding?: 'bus'`、`busWaitSec?: number`（ゲート通過からバス出発までの平均）を **バス扱いの便だけ** 書く（従来の記録の JSON は不変）。
- `AirportKpis` に任意の `apronBus?: { trips; pax; avgWaitMin; shortageMin; rescues }`（`state.bus` があるときだけ）。遅延理由の集計に `apronBus`、乗り遅れの理由に `noBus`。

### 2.12 検証・互換性

| コード | 重大度 | 条件 |
|---|---|---|
| `GATE_NO_STAND` | warning | **バスゲートは対象外**（条件を足す） |
| `GATE_BUS_HAS_STAND` | info | バスゲートに `standId` がある（無視される） |
| `GATE_BUS_NO_VEHICLES` | warning | 運用中のバスゲートがあり、運用中の GSE 基地の `apronBuses` の合計が 0 |
| `BUS_GATE_NO_REMOTE_STAND` | info | バスゲートがあるがリモートスポットがない |
| `STAND_REMOTE` | info | 文言だけ分岐: バスゲートがあれば「バス搭乗で運用」 |

- `checkGate`: バスゲートは `standId` を見ずに、運用中なら `ok`（理由 `GATE_BUS` を情報として付ける）。互換表の UI は「バス」と表示。

### 2.13 UI・描画・e2e

- 建設モード: ゲートの PropertiesPanel に「搭乗方式」（`prop-boardingMode`: 通常（コンタクト）/ バス）。バスのときは `standId`・`jetBridge` を隠し「対象: リモートスポット n か所」を表示。GSE 基地に「ランプバス」（`prop-apronBuses`）。
- 運航モード（12B-1 の部品に追加。既存の testid は不変）:
  - 運航表（FIDS）のスポットのセルに「BUS」の札（`fids-bus-<n>`）とバスゲート名。
  - 地上カード（GroundCard）にランプバスの行（運行中/待機/故障、`ground-apronBus`）。
  - ターミナルカードにバス待ちの人数（`terminal-bus-wait`）。
  - アラート（`deriveAlerts`）: 「ランプバス不足（n 便が待機）」（未配車の運行が 3 分以上）、「バス故障（乗客 n 人が車内）」。
  - 機体パネル: 便がバス扱いならバスゲートと運行の状況。
- 2D: `UNIT_COLOR.apronBus`（例 0x2b8cff）、バスは他の車両より長い矩形（2 倍）。乗客数のバッジは `could`。
- 3D: `UNIT_COLOR3D.apronBus`。インスタンスの形は共通のまま（長さの違いは `could`: 別の InstancedMesh）。`staff` 以外の移動中ユニットを描く既存の処理に自然に入る。
- e2e（新 `tests/e2e/bus.spec.ts`。既存 spec は編集しない）: (1) ゲートを置いて搭乗方式をバスへ → `prop-standId` が消える → 検証パネルに `GATE_BUS_NO_VEHICLES` → 基地の `prop-apronBuses` を 2 → 警告が消える、(2) バス空港のプロジェクト（`tests/e2e/fixtures/bus-project.json`、既存の読み込み経路）を開いて運航 → 運航表に `fids-bus-*` が出る → 一定時間後に `ground-apronBus` の運行中が 1 以上 → コンソールエラーなし（2D/3D 切替）。

---

## 3. 独立搭乗ゲート（ターミナルに隣接しないゲート）

### 3.1 モデル

- ゲートの `connectedTo`（`facilityRef`、ターミナル ID）が **明示の接続先**。欠落 = 従来の隣接の判定（`terminal/model.ts:103-134`、無変更）。
- `connectedTo = T` で、ゲートが T に隣接していない場合は **連絡通路でつながる独立ゲート**（小さな搭乗待合の建物と屋外の通路を抽象化）。隣接している場合は従来と同じ扱い（`connectedTo` は一致の確認だけ）。
- `buildTerminalModel` が独立ゲートごとに **合成のエリアノード** を 2 つ作る（`layout.terminalAreas` には書かない＝保存しない派生データ）:
  - `${gateId}:dep`（`kind 'waiting'`、`zone 'departure'`、`terminalId T`、矩形 = ゲートのタイル、`capacity = GATE_LOUNGE_CAPACITY = 150`）→ `gates[g].boarding`
  - `${gateId}:arr`（`kind 'arrivalCorridor'`、`zone 'arrival'`）→ `gates[g].deplane`
  - 接続点（アンカー）: T の 1 階（`level 0`）の出発区域のエリア（保安検査・上下移動を除く）のうちゲートに最も近いもの（同距離は ID）。到着側は到着区域で同様。
  - リンク: `lengthM = 直線距離 × 25 m × CONNECTOR_DETOUR（1.25）`、`travelSec = 0`、`via` = 中点。`findPaxRoute`（`route.ts`）は無変更で通る（区域は同じなので `canMove` も通る）。
  - 合成ノードは `byTerminal` に **入れない**（「ゲート未定の旅客の待合」「施設の選択」の候補にならない）。ID に `:` を含むので実エリアの ID と衝突しない。`TerminalModel.connectors: { gateId, depAnchor, arrAnchor, lengthM }[]` を追加（描画・検証・将来の拡張用）。
- 搭乗方式とは直交: 独立ゲートは `contact`（ブリッジ・スポットあり、エプロン上の小さなピア）にも `bus` にもなれる。**「独立したバスラウンジ（ターミナルからバスで運ぶ先の建物）」は作らない**（2 段のバスは遊びに比べて複雑すぎる）。

### 3.2 検証・編集

| コード | 重大度 | 条件 |
|---|---|---|
| `GATE_NOT_AT_TERMINAL` | error | **`connectedTo` が有効なときは出さない**（従来の条件はそのまま） |
| `GATE_CONNECTION_INVALID` | error | `connectedTo` が存在しない・ターミナルでない |
| `GATE_CONNECTOR_LONG` | warning | 通路が 60 タイル（1.5 km）超 |
| `GATE_NO_BOARDING_ACCESS`・`GATE_NO_ARRIVAL_ACCESS` | 既存 | アンカーが見つからない |
| `TERMINAL_NO_GATE` | info | 接続されたゲートも数える |

- `finalize`（`operations.ts:105-112`）で削除済みの施設を指す `connectedTo` を消す（キーを削除。従来のゲートはキーがないので不変）。
- `updateEntity` の検証に `facilityRef`（null か、`of` の種類の施設 ID）を追加。
- UI: ゲートの「接続先ターミナル」（`prop-connectedTo`: （自動: 隣接）/ ターミナル一覧）、通路の長さと歩行時間（`距離 ÷ 1.3 m/s`）を表示。
- 2D: 接続先のアンカーまで破線（`MapRenderer`、選択中は太く）。3D: 細い通路の箱（`could`）。

### 3.3 サテライトターミナルへの拡張の覚え書き

- 連絡の単位を `connectors` に一般化してある。サテライト = 入口のないターミナル（`connectedTo` = 本館）とし、本館とサテライトの出発区域・到着区域どうしを同じ方法（アンカー間のリンク）でつなげば、旅客は `paxTerminal`（本館）から保安検査後にサテライトへ歩く（既存の「出発旅客は入口のある最初のターミナル」とも整合）。
- ピープルムーバー = `connector.mode: 'mover'`（`travelSec` = 待ち時間の半分 ＋ 乗車時間、将来は定員つきの待ち行列）。
- 12B-3a ではターミナル同士の接続は **入れない**（`facilityRef` の `of: 'terminal'` をターミナルのプロパティにも使えるようにしておくだけ）。

---

## 4. 天候・予報・難易度／評価要素／目標（design.md §C・§C.6・§E.1 の具体化）

### 4.1 ゲーム設定（opt-in）

```ts
// economy/company.ts
export interface GameSettings {
  version: 1;
  difficulty: 'normal' | 'hard' | 'expert';
  weather: 'levels' | 'legacy';
  airlineEval: boolean;
  goals: boolean;
  climate: 'temperate' | 'snowy' | 'humid';
}
interface CompanyState { …; game?: GameSettings; airlineEval?: AirlineEvalState; goals?: GoalState }
```

- `createCompany`・`createCareerCompany`・`createSandboxCompany` は不変。新しいゲームの既定は UI の `newGame()`（`src/editor/`）で `game = { version: 1, difficulty: 'normal', weather: 'levels', airlineEval: true, goals: true, climate: 'temperate' }` を付ける。`new-career` は従来の流れを保ち、設定を選ぶのは「新しいゲーム（設定）」（`new-game-setup`）。既存の会社は「ゲーム設定」オーバーレイ（`tab-settings`、建設モード、確認「運航の結果が変わります」）で付け外し。
- `events`（12B-3b）は 3b で任意項目として足す（3a の型には入れない）。

### 4.2 天候 5 段階・予報（`src/core/sim/weather.ts` 新設、純関数中心）

```ts
export type WxType = 'clear' | 'cloud' | 'rain' | 'snow' | 'fog' | 'storm';
export interface WxHour { level: 0 | 1 | 2 | 3 | 4; type: WxType }
export function weatherPlan(seed: string, day: number, climate, difficulty): WxHour[];   // 24 時間分
export function forecast(plan: WxHour[], accuracy: number, seed: string, day: number): WeatherForecast;
export const LEVEL_EFFECTS: Record<0|1|2|3|4, { separation; taxi; goAround; cancelPerHour; arrivalDelay?: { prob; maxMin } }>;
interface WxRuntime { day: number; hours: WxHour[]; level; type; override: { level; type; until } | null; rng: RngState }  // SimState.wx?
```

- **計画**: 乱数 `new Rng(`${company.seed}:wx:${day}`)`（会社のシードと **暦の日**（`company.day`）だけで決まる → 翌日の予報と同じ関数）。0 時の段階は `[0.5, 0.3, 0.15, 0.05, 0]` から。以後 1 時間ごと: `u < b × 0.5` → +1、`u > 0.65` → −1、それ以外は維持（0〜4 に丸める）。`b = BASE[climate][season] × DIFF[difficulty] × 時間帯の補正`。
  - `BASE`（春/夏/秋/冬）: temperate 0.20/0.24/0.20/0.24、snowy 0.20/0.16/0.24/0.40、humid 0.24/0.40/0.30/0.16。`DIFF`: normal 1.0 / hard 1.5 / expert 2.0。季節 = `floor((day % 120) / 30)`。
  - 種類: 0 → clear、1 → cloud、≥2 → 冬（snowy は冬と秋の夜も）なら snow、5〜9 時は 30% で fog、夏の 14〜19 時で ≥3 なら storm、それ以外 rain。
  - **day 0 は全時間 ≤1**。
  - テスト（受け入れ基準）: 同じ入力で同じ出力、temperate/normal の 120 日の平均段階が 0.5〜1.3、expert は normal より高い、段階 4 の時間の割合が normal で 3% 未満。
- **予報**: 3 区間（6〜12・12〜18・18〜24 時）の最大段階と代表の種類。各区間を確率 `1 − accuracy` で ±1 ずらす（`Rng(`${seed}:fc:${day}`)`、決定的）。`accuracy`: normal 0.9 / hard 0.8 / expert 0.65。`WeatherForecast` を `{ day, blocks: { fromH, toH, level, type }[], accuracy, summary }` に広げる（`summary` は残す → 12B-2 の UI と互換）。
- **シミュレーションへの組み込み**（`company.game?.weather === 'levels'` のときだけ `createSimulation` が `state.wx` を作る）:
  - `weatherEffects(state)`: `state.wx` があれば `LEVEL_EFFECTS[effectiveLevel]`、なければ従来の `WEATHER_EFFECTS[state.weather.kind]`（`disruptions.ts:64-66`）。`state.weather.kind` は表示用に写像（clear/cloud → clear、rain/storm → rain、snow、fog）。
  - `stepWeather(sim)`（設計は `stepSimulation` で `stepDisruptions` の前としたが、実装は後。上書きが同じティックの障害を見られるため意図どおり。`if (state.wx)`）: `now % 3600 === 0` で段階を更新、日が変わったら計画を作り直す、`override` の期限切れを外す。
  - 効果（design.md §C.3 の表）: 離着陸間隔・走行速度（既存の倍率の経路）。着陸復行は `approach` の着陸の瞬間に `wx.rng` で判定 → 既存の `goAround`（イベントの `reason: 'weather'`）。欠航は段階 ≥3 の時間の始めに、2 時間以内に到着予定で `scheduled` の機体を判定 → 新しい `cancelTurnaround(sim, ac, 'weather')`（到着・出発とも `cancelled`、`stats.cancelled++`、`onFlightLost`、`HoldReason 'weather'`）。段階 2 の到着の遅れ（20% で +0〜10 分）は時間の始めに次の 1 時間の `scheduled` 便へ。段階 4 の storm は地上作業の通常進捗を 20 分ごとに 5 分止める（`stepGround` の既定の進捗の分岐に `if (state.wx && lightningStop(state))`）。
  - 手動・シナリオの天候の障害: `wx` があれば `override` に写像（rain→2、snow→3、fog→3）。ランダムな天候の障害: 乱数は従来どおり引いたうえで登録しない（`disruptions.ts:385`）。
  - `wx.rng` は `${state.seed}:wx` で、`state.rng` を消費しない。
- **プレイヤーの対応**: (1) 先行欠航（運航表の行メニュー `fids-cancel-<n>`、補償なし・満足度 −1）、(2) 除雪（雪で段階 ≥3、滑走路を 30 分閉鎖して以後 3 時間その滑走路の走行の倍率を 1 段階良く、60,000 cr、既存の `maintenance` の障害を使う）— (2) は `could`。
- **UI**: WeatherCard（12B-1）に現在の段階（`weather-level`）・今日の残りの時間ごとの帯・明日の予報（`weather-forecast`）。振り返りの `tomorrow.weather`（`review-forecast`）。計画パネルに明日の予報の 1 行。12B-2 の自動停止条件に「段階 4 の開始」を足す（`stopWhen`）。

### 4.3 難易度

| 難易度 | 悪天の頻度 | ランダムな障害 | 要求 OTP | 初期資金 | 予報の的中率 | 建設費 |
|---|---|---|---|---|---|---|
| normal | ×1.0 | ON・×0.6 | 従来 | 従来（4,000,000 cr） | 90% | ×1.0 |
| hard | ×1.5 | ON・×1.0 | +0.05 | ×0.75 | 80% | ×1.1 |
| expert | ×2.0 | ON・×1.5 | +0.10 | ×0.5 | 65% | ×1.2 |

- ランダムな障害: `SimSettings.randomDisruptionScale?`（欠落 = 1）。`createSimulation` は `company.game` があるときだけ `randomDisruptions: true` と倍率を設定（`RANDOM_PROB_PER_HOUR` に掛ける。乱数の引き方は同じ）。
- 要求 OTP: 評価の計算（§4.4）または `updateContracts` の中で `c.game` があるときだけ足す。建設費: `editor/store.ts:408` の `charge` で `c.game` があるときだけ倍率を掛ける（normal は ×1.0）。初期資金: `newGame()` で掛ける。
- 運航シードの日ごとの変化（design.md §G.6 の既存不具合）: `c.game` があるときだけ `simRunner.start` が `${site.seed}:ops:${company.day}` を渡す。

### 4.4 航空会社の評価要素・不満・要望（コア）

- 12B-1 の `airlineScorecard`（読み取り専用、`airlineScore.ts`）の 7 要素（`otp`/`turnaround`/`stand`/`fees`/`slots`/`aircraft`/`pax`）を **そのまま入力** にする（式を二重に持たない）。
- 会社に `airlineEval?: Record<airlineId, { ema: Partial<Record<ScoreKey, number>>; low: Partial<Record<ScoreKey, number>>; complaints: Complaint[]; requests: AirlineRequest[]; boostUntil: number }>`。
- 締め（`settleDay` の `updateContracts` の位置、`ops.ts:450`）: `c.game?.airlineEval` なら `updateContractsEval(c, byAirline, scorecard)`、なければ従来の `updateContracts`（入口で分岐）。`scorecard` は `records` をその日の分に絞り、`plan = planDay(c, c.day, …)`・`analyzeDayPlan` で作る。
  - EMA: `ema = 0.7 × ema + 0.3 × score`（`n/a` は更新しない）。
  - 満足度の変化 `delta = Σ wᵢ × (emaᵢ − 60) / 10`、`[-8, +4]` に丸め、欠航 −5/便（天候欠航は −2.5）は従来どおり別に引く。
  - 重み: 既定 otp 0.30 / turnaround 0.10 / stand 0.15 / fees 0.15 / slots 0.10 / aircraft 0.10 / pax 0.10。LCC は fees 0.25・turnaround 0.15・pax 0.05・aircraft 0.05、フルサービスは pax 0.15・aircraft 0.15・fees 0.10・turnaround 0.05（合計 1）。
  - 不満: `ema < 45` が 2 回の締めで続く → `{ key, sinceDay }`。`ema ≥ 55` で解消（ヒステリシス）。
  - 要望: 乱数 `${c.seed}:req:${day}`（`c.rng` を消費しない）で 1 社あたり 1 日 15%、未達の要望は 1 件まで。種類: `standFor(typeId)`（保有機材で運航不能な機種）、`slot(window)`（計画で外れた便）、`contactGate`（フルサービスで busShare > 0.3）、`otp`（3 日連続で要求 OTP）。期限 14 日。達成で満足度 +5・7 日間の提案確率 ×1.3（`boostUntil`）。
  - 契約: 不満 2 件以上 → 更新で増便しない、`aircraft` の EMA < 45 → 運航できない大型機の提案を出さない、`slots` の EMA ≥ 75 → 増便に応じる満足度の下限 60 → 50。
- UI: AirlineCard（12B-1）に不満の札と要望（`airline-complaint-<id>`、`airline-request-<id>`）、`AirlineScoreTable` に EMA の列。振り返りの航空会社の行に新しい不満・達成した要望。

### 4.5 目標とマイルストーン・空港の格（`src/core/economy/goals.ts` 新設）

```ts
interface GoalDef { id: string; tier: 0|1|2|3; check(x: GoalCtx): boolean; streak?: number; reward: { cash?: number; rating?: number; offerBoostDays?: number } }
interface GoalCtx { c: CompanyState; report: DailyReport; layout: AirportLayout; records: readonly FlightRecord[] }
interface GoalState { done: Record<string, number>; streaks: Record<string, number>; tier: 0|1|2|3; grants: { day: number; id: string; amount: number }[] }
```

| ID | 条件（その日の日報） | 報酬 |
|---|---|---|
| `flights10` | 完了 10 便 | 300,000 cr |
| `otp85x3` | 定時率 85% 以上を 3 日連続 | 評価 +2 |
| `mov50` | 50 発着 | 1,000,000 cr |
| `firstHeavy` | L 区分の機体の初就航 | 30 日間 大型機の提案 ↑ |
| `firstBus` | バス搭乗の便を初めて完了（§2） | 200,000 cr |
| `rail` | 鉄道駅（`railStation`）が運用中 | 評価 +2 |
| `pax10k` | 旅客 10,000 人/日 | 2,000,000 cr |
| `noMiss` | 20 便以上で乗り遅れ 0 | 評価 +1 |
| `mov200` / `mov500` | 200 / 500 発着 | 5,000,000 / 10,000,000 cr |
| `rating80` | 評価 80 以上 | 30 日間 提案 ↑ |

- 空港の格（3 日連続で満たすと昇格、降格しない）: 0 飛行場 → 1 地方空港（20 発着・旅客 2,000）→ 2 拠点空港（80 発着・旅客 10,000・評価 60）→ 3 国際ハブ（200 発着・旅客 30,000・L 区分が運航可能・評価 70）。格ごとに提案の 1 日の便数の上限 +1（`generateOffers` の `maxPerDay` に `c.goals` があるときだけ足す）。
- 評価: `settleDay` の最後（日報を積んだ後、`c.day++` の前）で `c.goals` があるときだけ。報酬の現金は `c.cash += amount` と `goals.grants` に記録（日報の営業収支には入れない。日報に任意の `grants?: number`）。
- UI: 左列 GoalsCard（`goals-card`、次の 3 つ・`goal-<id>`）、上部バーの格（`airport-tier`）、振り返りの「達成」（`review-goals`）。

---

## 5. 保存・版・移行・検証・ゴールデン

| 版 | 方針 |
|---|---|
| `SCHEMA_VERSION`（3） | **上げない**。ゲートの `boardingMode`/`connectedTo`、基地の `apronBuses` は種類ごとのプロパティの袋（`Facility.props`）への任意の追加で、エンティティの形は変わらない。上げると `versions.layoutSchema` がすべての保存で変わり `project.golden.json`（sha256）が壊れる。旧アプリによる誤読はプロジェクトの `formatVersion 2` で防ぐ |
| `SIM_MODEL_VERSION` | **上げない**（新しい挙動は新しいデータがあるときだけ） |
| `PROJECT_FORMAT_VERSION` | 定数を 2 に。`formatVersionOf(p) = usesFormat2(p) ? 2 : 1` を `buildProject` と `validateProject` の作り直し（`project.ts:86-98,384-403`）の **両方** で `formatVersion` と `versions.format` に使う |
| `CompanyState.version`・`SimState.version` | 1 のまま |

- `usesFormat2(p)`: 会社（`company`・`sim.company`・各シナリオの `company`）に `game`/`airlineEval`/`goals`、`sim.state.wx`/`sim.state.bus`、レイアウト（本体・シナリオ）に `boardingMode === 'bus'` か `connectedTo` を持つゲート、`apronBuses > 0` の基地のいずれか。
- 読み込み: `formatVersion ≤ 2` を受け付ける。v1 → v2 は恒等。
- 検証の追加（`validateProject`、不正はエラー＝何も適用しない）: `checkLayout` にゲートの `boardingMode`（enum）・`connectedTo`（存在するターミナル）、基地の `apronBuses`（0〜30 の整数）。`checkCompany` に `game`（値の範囲）・`airlineEval`・`goals` の形。`checkSim` に `wx`（段階 0〜4、24 時間）と `bus`（運行の便・ゲート・スポット・バスの参照、`groups` が存在）。復元後の `checkInvariants` に BU1〜BU4。自動保存（`localStorage`）経由の `importCompany` は不正な任意項目を捨てて警告（読み込みは止めない）。
- レイアウトだけの旧形式の書き出し（`SAVE_FORMAT`）は版を持たないので、旧アプリはバスゲートを「スポットのない通常ゲート」として読む（docs/27 に明記。プロジェクト形式を推奨）。
- **ゴールデン**: 既存は一切再採取しない（`sim-versions.json` の既存項目も不変）。新規のみ:
  - `tests/golden/fixtures/bus.layout.json`（サンプル空港 ＋ リモートスポット 3（M2・L1）＋ バスゲート 2（1 つは独立ゲート）＋ 独立コンタクトゲート 1 ＋ 基地の `apronBuses: 3`）→ `bus-sim.golden.json`（サンドボックスの会社で 1 日: 便の結果・乗り遅れの理由・運行の統計・`state` の sha256）。
  - `game-models.golden.json`（サンプル空港 ＋ `game` normal/expert で 1 日: 天候の計画・予報・締めの KPI・満足度・目標）。
  - `sim-versions.json` に 2 項目を追加。
- **保護テスト**: 「`game` のない会社では `state.wx` がなく、`planDay`・`updateContracts`・`generateOffers` の結果が従来の関数と同一」「バスゲートのないレイアウトでは `state.bus`・`apronBus` のユニット・`p.bus` がない」「リモートスポットを含むレイアウトの `state` の sha256 が A0 で固定した値と一致」。

---

## 6. 作業分解（各ステップで `npm test`・`npm run test:e2e`・`tsc` を通す）

凡例: **must** = 12B-3a の PR に必須、**could** = 規模が膨らんだら次へ回す。★ = `simulation.ts`/`passengers.ts` に触れる高リスク。

### A. 搭乗方式（レイアウトで有効化）

| # | 作業 | 主なファイル | テスト | 区分 |
|---|---|---|---|---|
| A0 | 特性テスト: リモートスポットを含むレイアウト（サンプルからゲート 1 つ削除）を 1 日運航した `state` の sha256 と、`noGate`・`unreachable` の人数を **現行コードで** 固定 | `tests/unit/sim/legacyRemote.test.ts` | それ自体 | must |
| A1 | 版の枠組み: `PROJECT_FORMAT_VERSION = 2`、`usesFormat2`（最初は会社の `game` とゲート・基地のプロパティ）、`formatVersionOf` を build/validate の両方に | `io/project.ts` | 単体: 従来の会社・レイアウトは 1、`boardingMode: 'bus'` で 2、v2 を読める、v3 を拒否。`project.golden` 不変 | must |
| A2 | データ: `PropDef` の `facilityRef`・`default`、ゲートの `boardingMode`/`connectedTo`、基地の `apronBuses`、`model/gates.ts`（`gateMode`・`connectedTerminal`）、`updateEntity` の検証、`finalize` の参照切れ、PropertiesPanel（既定の表示・バスで隠す・接続先の選択）、i18n | `model/catalog.ts`、`model/gates.ts`、`layout/operations.ts`、`ui/PropertiesPanel.tsx`、`i18n/ja.ts` | 単体: プロパティの検証・参照切れ・`DEFAULT_PROPS` 不変。e2e: 搭乗方式の切り替え | must |
| A3 | 独立ゲート: `buildTerminalModel` の合成ノード・`connectors`、検証コード（§3.2）、2D の破線 | `terminal/model.ts`、`validation/validate.ts`、`render/MapRenderer.ts` | 単体: 接続先の合成ノード・リンク長・入口からの経路・`byTerminal` に入らない・従来のゲートの `gates` が同一（全ゴールデンのレイアウトで比較）。検証の各コード | must |
| A4 | 文脈・互換・経済・計画: `ctx.busGates`、`contact`/`standGate` からバスゲートを除く、基地の `apronBus`、`checkGate`、`VEHICLE_PROPS`・費用、計画の `BUS_BOARDING`、検証（§2.12） | `sim/context.ts`、`aircraft/compat.ts`、`economy/construction.ts`・`balance.ts`・`ops.ts`・`planning.ts`、`validation/validate.ts` | 単体: 各関数の従来値の一致・バス時の値 | must |
| A5 ★ | 型とランタイム（出発）: 型の追加、`createGroundUnits` の順序、`state.bus` の生成、`sim/apronBus.ts`（ゲートの選択・要求・配車・段階）、`passengers.ts` の出発の分岐（ゲートの選択・先行時間・ゲートの処理 → `waitingBus`・締切・`noBus`）、`stepSimulation` に 1 行 | `sim/types.ts`、`sim/ground.ts`（順序・`travelSec` の export）、`sim/apronBus.ts`、`sim/passengers.ts`、`sim/simulation.ts`、`sim/invariants.ts` | 単体（`tests/unit/sim/apronBus.test.ts`）: 1 便が 3 運行で搭乗、定員を超えない、バス 1 台・2 便で遅延、バス 0 台で `noBus`、毎ティック不変条件。**回帰: A0・全ゴールデン・`passengers.test.ts`・`invariants.test.ts`** | must |
| A6 ★ | 到着・故障・欠航: 到着のバス（`stepArrivalFlight` の分岐）、故障の検出と救援、`moveUnitToBase` の保護、欠航時の運行の取り消し | `sim/passengers.ts`、`sim/apronBus.ts`、`sim/disruptions.ts` | 単体: 到着旅客が降機口 → 出口へ、手荷物が受取所へ、走行中の故障 → 救援で到着、積み込み中の故障 → 再配車、欠航。回帰は A5 と同じ | must（救援は could に落とせる: 落とす場合は修理まで車内待機） |
| A7 | 分析・評価カード: `FlightRecord` の任意項目、`AirportKpis.apronBus`、遅延・乗り遅れの理由、`airlineScorecard` の `busShare` | `analytics/records.ts`・`kpi.ts`、`economy/airlineScore.ts` | 単体: 従来の記録の JSON が同一 | must |
| A8 | 運航の UI と描画: FIDS の札、GroundCard・TerminalCard、アラート、機体パネル、2D/3D の色と形 | `ui/operate/*`、`ui/OpsPanels.tsx`、`render/MapRenderer.ts`、`render/three/Scene3D.ts` | e2e `bus.spec.ts`（§2.13） | must（3D の別形状・乗客数バッジは could） |
| A9 | 保存の検証（`checkLayout`・`checkSim`・BU 不変条件の復元）、新ゴールデン `bus-sim`、docs（12 §6/§7、13、17、21、26、27、10 の G-05） | `io/project.ts`、`tests/golden/*`、`docs/*` | 単体: 運航中に保存 → 読み込み → 継続で結果一致 | must |

### B. ゲームのモデル（`company.game` で有効化）

| # | 作業 | 主なファイル | テスト | 区分 |
|---|---|---|---|---|
| B1 | `GameSettings`、`importCompany`/`checkCompany`、`usesFormat2` の拡張、「新しいゲーム（設定）」と「ゲーム設定」のオーバーレイ（保存だけ。効果なし） | `economy/company.ts`、`io/project.ts`、`editor/*`、`ui/*` | 単体: 形の検証。e2e: `new-game-setup` → 難易度 hard → `company-day` 表示。既存の `new-career` の e2e 不変 | must |
| B2 | `weather.ts` の純関数（計画・予報・効果表）、振り返りの予報・WeatherCard・計画パネル（読み取り） | `sim/weather.ts`、`analytics/review.ts`、`ui/operate/cards/WeatherCard.tsx`、`ui/DayReview.tsx` | 単体: 決定性・分布・day 0。e2e: 振り返りに `review-forecast` | must |
| B3 ★ | シミュレーションへの組み込み: `state.wx`、`weatherEffects` の分岐、`stepWeather`、override、ランダムな天候の抑止、着陸復行、`cancelTurnaround`、段階 2 の遅れ、雷の停止 | `sim/simulation.ts`、`sim/disruptions.ts`、`sim/ground.ts`、`sim/types.ts` | 単体: 効果ごと・同じシードで同じ結果・`wx` なしで乱数を引かない。新ゴールデン `game-models`。**回帰: 全ゴールデン・dayloop の分割一致（`game` あり条件を追加）** | must（雷の停止・除雪は could） |
| B4 | 難易度: 障害の倍率、要求 OTP、初期資金、建設費、日ごとの運航シード、先行欠航の操作 | `sim/disruptions.ts`、`economy/*`、`editor/store.ts`・`simRunner.ts`、`ui/operate/FidsOverlay.tsx` | 単体: normal の値が従来と一致。e2e: 先行欠航 | must（先行欠航は could） |
| B5 | 評価要素・不満・要望・契約への反映、AirlineCard の表示 | `economy/airlineEval.ts`（新）、`economy/ops.ts`・`company.ts`、`ui/operate/cards/AirlineCard.tsx` | 単体: 式・ヒステリシス・要望の達成・`airlineEval` なしで従来と同一 | must（要望は could） |
| B6 | 目標・空港の格・報酬、GoalsCard・上部バー・振り返り | `economy/goals.ts`（新）、`economy/ops.ts`、`ui/*` | 単体: 判定・連続・昇格・報酬の記録。e2e: `goals-card` | must（格による提案の変化は could） |
| B7 | docs（14・19・02・06・08・09・21）・性能の確認（1 日スキップの時間に `wx`・バスの影響がないこと） | docs | — | must |

- **コミットのまとめ方**: A0+A1、A2、A3、A4、A5、A6、A7+A8、A9、B1、B2、B3、B4、B5、B6、B7（約 15〜16 コミット）。
- **高リスクのステップでの回帰確認**（A5・A6・B3）: `npx vitest run tests/unit/golden*.test.ts tests/unit/sim tests/unit/dayloop.test.ts tests/integration`、A0 の特性テスト、`checkInvariants` を毎ティック回す既存の長時間テスト、e2e の `operations`・`ground`・`terminal`・`opslayout`。
- **規模の目安**: A ≈ 1,800〜2,300 行（うち `apronBus.ts` 450〜600、テスト 600）、B ≈ 1,500〜2,000 行。セッションの区切り: (1) A0〜A4、(2) A5〜A6、(3) A7〜A9 ＋ B1〜B2、(4) B3〜B7。
- **削る順（膨らんだ場合）**: 3D の通路・バスの形 → 除雪 → 雷の停止 → 要望 → 格による提案の変化 → 救援（修理まで待機に） → 先行欠航。**削らない**: バス搭乗の出発・到着・不足・故障の基本、独立ゲート（歩行の連絡）、天候 5 段階と予報、難易度、評価要素の満足度への反映、目標。

---

## 7. リスクと PO への確認

### 7.1 リスク

| リスク | 対策 |
|---|---|
| `passengers.ts` の分岐が従来の流れに漏れる | 分岐の入口は `state.bus` と `p.bus` の有無だけ。A0 の特性テスト（変更前に固定）と全ゴールデン |
| ランダム故障の乱数がユニットの数で変わる | バスは `apronBuses > 0` のときだけ生成。従来データでは同一 |
| G1 の不変条件（`taskId`）とバスの運行の衝突 | バスは `trip` を使い `taskId` を使わない |
| 搭乗の締切が永久に来ない（バスが来ない・故障） | `BUS_GIVEUP_SEC` で `noBus`、車内の旅客は救援で必ず運ぶ |
| 合成のエリアノードを実エリアとして扱う箇所 | `byTerminal` に入れない。`layout.terminalAreas[g.area]` を引く箇所（描画・分析）を A3 で洗い出し、`ctx.terminal.areas` に寄せる |
| 版の変更でゴールデンが壊れる | `formatVersion` を条件つきで書く。`SCHEMA_VERSION` は上げない |
| 範囲の膨張 | §6 の must / could。バス（A）を先に完成させ、B は 1 ステップずつ |
| 天候の乱数が他の乱数を乱す | `wx.rng`・予報・要望はそれぞれ専用のシード |

### 7.2 PO への確認（必要なものだけ、推奨の既定つき）

1. **バスゲートとスポットの関係**: バスゲートは「ゲートのないすべてのリモートスポット」を便ごとに受け持つ（プール方式）。特定のスポットに固定する指定は入れない。→ **推奨: プール方式**（実運用に近く、データ・UI が単純）。
2. **独立ゲートと旅客の移動**: 12B-3a は「徒歩の連絡通路」まで。ピープルムーバー・サテライトターミナル・ターミナルからバスで運ぶ独立ラウンジは後続。→ **推奨: この範囲**。
3. **実装順**: 12B-3a の中で、PO の最新の要望であるバス搭乗・独立ゲート（A）を先に、天候・難易度・評価・目標（B）を後に行い、まとめて 1 つの PR。→ **推奨: この順**。

（その他は本書の既定で進める: ランプバスの定員 60 人・購入費 250,000 cr、バス搭乗の料金の割引なし、タラップ車なし、移動は既存の直線モデル。）
