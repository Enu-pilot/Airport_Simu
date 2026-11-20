# 03. 空港データモデル

本書のデータ型は TypeScript 風の記法で示す（実装時の正式定義は `src/core/model/` に置く）。

## 1. 設計原則

1. **単一の状態ツリー**: シミュレーション状態はすべて `GameState` に集約し、JSONシリアライズ可能な plain object とする（クラスインスタンス・関数・循環参照を含めない）。
2. **安定ID**: すべてのエンティティは文字列IDを持つ。IDは状態内のカウンタから決定的に発行し、再利用しない。
3. **参照はIDで**: エンティティ間の参照はオブジェクト参照ではなくIDで持つ。
4. **建設レイヤーと論理モデルの分離**: プレイヤーが編集するのは建設レイヤー（`AirportLayout`）のみ。通行可能性・接続は **派生データ**（`AirsideNetwork` 等）として建設レイヤーから再生成する。派生データはセーブしない。
5. **割り当ての単一情報源**: 「どのスポットにどの便がいるか」「滑走路を誰が占有しているか」は、それぞれ1か所（`StandAllocation` / `RunwayState`）にのみ記録する。航空機側には参照用のIDを持たせるが、整合性チェックで一致を検証する。
6. **金額は整数**: 金額は最小通貨単位の整数（`Money = number`、小数を使わない）。
7. **時刻は整数秒**: `SimTime = number`（ゲーム開始からの秒）。

## 2. ID

```ts
type Id<K extends string> = `${K}_${number}`;   // 例: "ac_42", "std_7"
```

建設エンティティ（Phase 1 で実装）:

| 接頭辞 | エンティティ |
|--------|-------------|
| `rwy` / `tn` / `twy` / `rn` / `rd` / `std` / `fac` | 滑走路 / 誘導路ノード / 誘導路 / 道路ノード / 道路 / スポット / 施設（Phase 1 で実装、§4） |

運用エンティティ（Phase 2 以降。ゲート・スポット等は建設エンティティのIDを参照する）:

| 接頭辞 | エンティティ |
|--------|-------------|
| `al` | Airline |
| `ct` | Contract |
| `fl` | Flight |
| `ac` | Aircraft（運航中の機体インスタンス） |
| `pg` | PaxGroup（旅客グループ） |
| `bg` | BagBatch（手荷物バッチ） |
| `job` | TurnaroundTask（地上支援作業） |
| `crew` | GseCrew |
| `ev` | イベントログ |

発行: `counters[prefix]++`（削除しても再利用しない）。ID はシミュレーション中もロード後も不変。論理グラフのノード/エッジIDは派生データなので、建設エンティティのIDから決定的に計算する（§5）。

## 3. GameState（トップレベル）

```ts
interface GameState {
  schemaVersion: number;          // セーブ互換用
  meta: { name: string; createdAt: string; mode: 'sandbox' | 'free' };
  time: { now: SimTime; speed: 0 | 1 | 15 | 60 | 240 | 600 };
  rng: RngState;                  // ストリーム別の乱数状態（§9）
  idCounters: Record<string, number>;

  map: MapState;                  // 地形
  layout: AirportLayout;                     // 建設レイヤー（§4）
  // ↓ 建設レイヤーに紐づく運用時の状態（Phase 2 以降。建設エンティティのIDを参照する）
  runways: Record<Id<'rwy'>, RunwayState>;
  stands: Record<Id<'stand'>, StandState>;
  gates: Record<Id<'gate'>, GateState>;
  facilities: Record<Id<'fac'>, FacilityState>;

  airlines: Record<Id<'al'>, Airline>;
  contracts: Record<Id<'ct'>, Contract>;
  flights: Record<Id<'fl'>, Flight>;
  aircraft: Record<Id<'ac'>, Aircraft>;
  turnaroundTasks: Record<Id<'job'>, TurnaroundTask>;
  gseCrews: Record<Id<'crew'>, GseCrew>;

  paxGroups: Record<Id<'pg'>, PaxGroup>;
  bagBatches: Record<Id<'bg'>, BagBatch>;

  standAllocation: StandAllocation;   // スポット割り当ての単一情報源
  taxiReservations: TaxiReservations; // 誘導路区間予約
  arrivalQueue: Id<'ac'>[];           // 空中待機列（進入順）

  finance: FinanceState;
  staff: StaffState;
  rating: RatingState;
  stats: StatsState;                  // 日次集計（グラフ用）
  eventLog: GameEvent[];              // リングバッファ（上限件数）
  settings: GameSettings;             // 料金設定・難易度・イベントON/OFF
}
```

派生データ（セーブ対象外、ロード時・建設変更時に再構築）:

```ts
interface DerivedState {
  occupancy: TileOccupancy;        // タイル → エンティティID
  airside: AirsideGraph;           // 航空機用グラフ
  landside: LandsideNetwork;       // 旅客処理ネットワーク
  roads: RoadGraph;                // 車両・旅客アクセス
  validation: ValidationIssue[];   // 接続性警告
  structureVersion: number;        // 建設変更ごとに増加（キャッシュ無効化用）
}
```

## 4. マップと建設レイヤー（Phase 1 で実装）

> Phase 0 では誘導路・道路を「タイルのペイント」で持つ案だったが、Phase 1 で **ノード＋エッジのネットワーク** に変更した。
> 交差点・滑走路入口が安定IDを持つエンティティになり、接続関係がデータとして明示されるため（経路探索にそのまま使える）。
> 実装: `src/core/model/types.ts`, `src/core/layout/*`

### 4.1 座標系

座標系は 4 つに名前を付けて区別する（詳細・変換関数は [22](22_geometry_architecture.md) §1、実装は `src/core/geometry/frames.ts`）。

| フレーム | 単位 | 原点・向き | 使う場所 |
|---|---|---|---|
| Tile | タイル番号（整数） | タイル (i, j) | 地形・施設の `origin`・占有ラスタ |
| World | タイル（1 = 25 m）、実数 | **整数 = タイル中心**。+x = 東、+y = 南 | core 全般: ノード・滑走路端点・機体の x/y・多角形 |
| Map | タイル、実数 | タイル (i, j) は `[i, i+1) × [j, j+1)`。**Map = World + 0.5** | 2D 描画、`camera.ts`（コード上は「世界座標」） |
| Scene | m | X = Map.x × 25、Z = Map.y × 25、Y = 上 | 3D（three.js） |

- **ノード・滑走路端点は整数のタイル番号（= World フレームの整数点、タイル中心を指す）として保存**し、描画のときに +0.5 してタイルの中心に置く（Map フレーム）。
  保存データに 0.5 は現れない。`±0.5` の変換は `frames.ts`（`worldToMap` / `mapToWorld` など）だけで行う。
- 位置にはメートルを使わない（長さ・幅・半径だけ m。位置 × 25 を経由すると距離が 1 ulp ずれ、保存済みの経路 `cum` が一致しなくなる）。
- 角度は度・真方位（0 = 北 = −y、時計回り、[0, 360)）。磁方位 = 真方位 − 東偏差（偏差の保存は Phase 12 の予定で未実装）。
- 1タイル = 25m。施設・スポットは回転後の外接矩形の左上タイル `origin` で位置を持つ。
- 画面 ↔ Map の変換は `src/core/geometry/camera.ts`（`worldToScreen` / `screenToWorld` / `screenToTile` / `zoomAt`。「世界座標」= Map フレーム）。

### 4.2 AirportLayout

```ts
interface AirportLayout {
  schemaVersion: number;                     // 現行 SCHEMA_VERSION = 3（v2 → v3 は任意項目の追加のみで書き換えなし。docs/27）
  magneticVariationDeg?: number;             // 磁気偏角（東偏差が正、[-180, 180]。欠落 = 0。Phase 12）
  ruleSet?: 'classic' | 'realistic';         // 判定ルール（欠落 = classic。Phase 12。docs/26）
  name: string;
  site: Site;                                // 地形（不変。Undo 履歴の全スナップショットで共有）
  counters: Record<string, number>;          // ID発行カウンタ
  runways:    Record<Id<'rwy'>, Runway>;
  taxiNodes:  Record<Id<'tn'>,  NetNode>;    // 誘導路の交差点・滑走路入口・端点
  taxiways:   Record<Id<'twy'>, TaxiwayEdge>;// ノード間の直線区間
  roadNodes:  Record<Id<'rn'>,  NetNode>;
  roads:      Record<Id<'rd'>,  RoadEdge>;
  stands:     Record<Id<'std'>, Stand>;
  facilities: Record<Id<'fac'>, Facility>;   // 建物・エリア・ゲート
}

type BuildState = 'planned' | 'underConstruction' | 'operational';   // 計画 / 建設中 / 運用中

/** Phase 12: 判別共用体（discriminant = alignment）。詳細は docs/23 */
type Runway = RunwayGrid8 | RunwayFree;
interface RunwayGrid8 { id; name; start: Tile; heading: 0|45|…|315; length: number /*ステップ数*/; surfaceWidthM: 30|45|60; buildState; designatorSuffix?; alignment?: undefined }  // 従来形（v1/v2 はすべてこれ）
interface RunwayFree  { id; name; alignment: 'free'; start: WorldPoint /*実数可*/; headingDeg: number /*真方位*/; lengthM: number /*m、丸めない*/; surfaceWidthM; buildState; designatorSuffix?; dims?: RunwayDims }
interface NetNode  { id; pos: WorldPoint /*従来は整数。自由形の中心線上の入口だけ実数*/; name; holdShort: boolean /* 滑走路入口での停止義務 */ }
interface TaxiwayEdge { id; from; to; name; widthClass: 'S'|'M'|'L'; oneWay: boolean /* from→to */; buildState }
interface RoadEdge    { id; from; to; name; roadClass: 'public'|'service'; oneWay; buildState }
interface Stand    { id; name; origin: Tile; rotation: 0|90|180|270 /* 機首の向き */; size: 'S'|'M'|'L'; buildState }
interface Facility { id; kind: FacilityKind; name; origin: Tile; w; h /* 回転前 */; rotation; buildState; props }
```

| 種別 | 寸法（タイル） | 備考 |
|------|---------------|------|
| 滑走路 | 幅3（保護区域 幅7、端部 +2.5） | 実長 = ステップ数 × (斜めなら√2) × 25m |
| スポット S / M / L | 2×2 / 3×2 / 4×4（幅×奥行き。2026-11-20 見直し、PR #63。それ以前は 3×3 / 3×4 / 5×5） | サイズ区分はコード A/B=S・C=M・D/E/F=L（F は codeF 区分を維持）。入口は機首の反対側、外接矩形のすぐ外の「中央に最も近いタイル」。スポットは位置・向き・サイズ区分だけを保存し寸法はコード側定義のため、保存形式の変更はない。旧寸法の入口位置も接続扱いにする互換処理あり。版の記録は docs/21 の `skyport-sim-10.9` を参照 |
| 施設 | `src/core/model/catalog.ts` の `FACILITY_SPECS` | エプロン・ターミナル・サービスエリア・駐車場・格納庫はサイズ変更可 |

施設の種別ごとのプロパティは `PROP_SCHEMAS`（例: ゲート `{ standId, jetBridge }`、ターミナル `{ checkInCounters, securityLanes }`）で定義し、編集時に検証する。

### 4.3 ネットワーク編集の規則

経路（折れ線）を追加すると、以下の位置で自動的に分割・接続する（`src/core/layout/network.ts`）。

1. 頂点が既存エッジの途中にある → そのエッジを分割（T字交差点）
2. 区間の途中に既存ノードがある → そのノードで接続
3. 区間が既存エッジと交差し、交点がタイル中心 → 両方を分割（十字交差点）
4. 誘導路が滑走路中心線と交差 → 交点に **滑走路入口ノード** を作る
5. 同じノード間のエッジは重複して作らない

エッジを分割した場合、前半の区間が元のIDを引き継ぎ、後半に新しいIDを発行する。
スポットの入口が誘導路エッジの途中に来た場合も、全操作の後処理でそのエッジを分割して接続ノードを作る。

### 4.4 編集操作

すべて `AirportLayout → OpResult` の純粋関数（`src/core/layout/operations.ts`）。失敗時は理由コード（`NOT_FOUND`, `INVALID_VALUE`, `NODE_EXISTS` …）を返し、レイアウトは変わらない。

| 操作 | 対象 |
|------|------|
| `placeFacility` / `placeStand` / `placeRunway` / `addTaxiwayPath` / `addRoadPath` | 配置 |
| `placeFreeRunway` / `placeFreeRunwayByEnds` / `setFreeRunwayGeometry` | 自由形の滑走路の配置（始点・真方位・実長、または両端）と幾何の変更（中点・始点・終点を固定） |
| `convertRunwayToFree` / `snapRunwayToGrid` | 従来形 → 自由形、自由形 → 従来形（プレイヤーの明示操作のみ） |
| `updateLayoutSettings` | 磁気偏角・判定ルール |
| `moveEntity` | 全種別（エッジは両端ノードを移動） |
| `rotateEntity` | 施設・スポット: 90°、従来形の滑走路: 45°（中点を保つ）、自由形の滑走路: 中点まわりに指定角（既定 15°） |
| `duplicateEntity` | 施設・スポット・滑走路（新ID。ゲートの紐付けは複製しない） |
| `deleteEntity` | 全種別（ノード削除は接続エッジも削除、孤立ノードは掃除） |
| `updateEntity` | 種別ごとに許可されたプロパティのみ（値を検証） |
| `setBuildState` / `reverseEdge` | 建設状態の一括変更 / 一方通行の反転 |

Undo / Redo はレイアウトのスナップショット履歴（`src/core/editor/history.ts`、上限200件）。

## 5. エアサイド論理ネットワーク（派生、Phase 1 で実装）

建設レイヤーから決定的に生成し、保存しない（`src/core/airside/network.ts`）。航空機の経路探索はこのグラフのみを使う。
グラフに無いエッジは通行できないため、**未接続の誘導路へ進入する経路は構造的に存在しない**。

```ts
interface AirsideNetwork {
  nodes: Record<string, AirsideNode>;     // kind: taxiway | intersection | endpoint | runwayEntry | runwayThreshold | runwayIntersection（Phase 12。自由形が関与する滑走路どうしの交差点）| stand
  edges: Record<string, AirsideEdge>;     // kind: taxiway | runway | standLink
  outgoing / incoming: Record<nodeId, edgeId[]>;  // 一方通行を考慮した隣接
  runwayNodes: Record<runwayId, nodeId[]>;        // 滑走路上のノード（始点側から順）
  standLinks: Record<standId, nodeId>;            // スポットの接続先
}
interface AirsideEdge {
  id; kind; sourceId /* 元エンティティ */; from; to; bidirectional; lengthM;
  maxSize: 'S'|'M'|'L'|null;   // 誘導路幅 / 滑走路の長さと舗装幅 / スポットサイズ
  operational: boolean;        // 建設状態が運用中か
  runwayId?; holdShortAt?: { nodeId; runwayId };  // 滑走路入口手前の停止義務
}
```

| ID 規則 | 例 |
|--------|----|
| 誘導路ノード・エッジ | レイアウトのIDそのまま（`tn_4`, `twy_7`） |
| 滑走路端（端に誘導路ノードが無い場合） | `rwy_1:T0`（始点側）/ `rwy_1:T1` |
| 滑走路区間 | `rwy_1:tn_3~tn_4` |
| スポット / スポット接続エッジ | `std_2:P` / `std_2:L` |

**航空機の通行可否**は `canAircraftUse(edge, size, { operationalOnly })` で判定する（区分 ≤ `maxSize` かつ、必要なら運用中）。
滑走路の `maxSize` は `min(長さ区分, 舗装幅区分)`（長さ: S ≥ 1,200m / M ≥ 2,000m / L ≥ 2,800m、幅: 30m→S / 45m→M / 60m→L）。

### 5.1 検証（配置エラー・接続エラー）

`analyzeLayout(layout)`（`src/core/validation/validate.ts`）が問題の一覧と各エンティティの運用可否を返す。
問題はコード＋パラメータで返し、文言は `src/i18n/ja.ts` で組み立てる。`targets` は問題のある対象、`related` は文中で参照するだけの対象。

| 区分 | 主なコード |
|------|-----------|
| 配置 | `OUT_OF_BOUNDS`, `UNBUILDABLE_TERRAIN`, `OVERLAP`, `IN_RUNWAY_STRIP`, `STAND_NOT_ON_APRON` |
| 滑走路 | `RUNWAY_TOO_SHORT`, `RUNWAY_NO_TAXIWAY` |
| 誘導路 | `TAXIWAY_ON_RUNWAY`, `TAXIWAY_CROSSES_RUNWAY_NO_ENTRY`, `TAXIWAY_CROSSING_NO_JUNCTION`, `TAXIWAY_OVERLAP`, `TAXIWAY_ISOLATED`, `TAXIWAY_DEAD_END`, `DUPLICATE_NODE`, `DUPLICATE_EDGE` |
| スポット・ゲート | `STAND_NOT_CONNECTED`, `STAND_NO_RUNWAY_ROUTE`, `STAND_ROUTE_SIZE_LIMITED`, `STAND_ONE_WAY_TRAP`, `STAND_REMOTE`, `STAND_MULTIPLE_GATES`, `GATE_NOT_AT_TERMINAL`, `GATE_NO_STAND`, `GATE_STAND_TOO_FAR` |
| 施設・道路 | `NO_AIRSIDE_ACCESS`, `TERMINAL_NO_ROAD`, `TERMINAL_NO_GATE`, `PARKING_NO_ROAD`, `ROAD_NO_ENTRANCE`, `ROAD_CROSSING_NO_JUNCTION` |
| 全体 | `NO_RUNWAY`, `NO_TOWER` |

重なりの可否はレイヤーの互換表で決める（例: 誘導路×エプロン 可、スポット×エプロン 可、建物×何か 不可、保護区域×誘導路以外 不可。誘導路×滑走路は、その誘導路が滑走路と交差・接続している場合のみ可）。

**運用可否**（`operability`）: 建設状態が運用中で、エラーがなく、さらにスポットは「運用中の誘導路だけで、その区分が使える運用中の滑走路と往復できる」こと。

### 5.2 誘導路区間予約（Phase 2 で実装予定）

```ts
interface TaxiReservations {
  byNode: Record<NodeId, { aircraftId: Id<'ac'>; until?: SimTime }>;
}
```

- 航空機は経路上の先行ノードを順に予約しながら進む（詳細は [04](04_operations_passenger_spec.md) §4）。
- 1ノードを予約できるのは1機のみ。

## 6. 運用エンティティ

```ts
type SizeClass = 'S' | 'M' | 'L';

interface RunwayState {
  id: Id<'rwy'>; structureId: Id<'st'>;
  lengthTiles: number;
  maxSize: SizeClass;
  ends: [RunwayEnd, RunwayEnd];      // 方位名（例 "09" / "27"）と閾値ノード
  activeEnd: 0 | 1;                  // 使用方向（初期版はプレイヤー設定、後続で風向）
  mode: 'mixed' | 'arrivalsOnly' | 'departuresOnly' | 'closed';
  occupancy: RunwayOccupancy | null; // 単一情報源
  lastOpAt: SimTime; lastOpSize?: SizeClass; lastOpKind?: 'arr' | 'dep';
}
interface RunwayOccupancy {
  aircraftId: Id<'ac'>;
  purpose: 'landing' | 'takeoff' | 'crossing' | 'lineUp';
  since: SimTime;
}

interface StandState {
  id: Id<'stand'>; structureId: Id<'st'>;
  size: SizeClass;
  entryNode: NodeId;
  gateId?: Id<'gate'>;
  status: 'available' | 'closed';
}

interface StandAllocation {
  // スポットごとの時間窓予約。重なり禁止。
  byStand: Record<Id<'stand'>, StandBooking[]>;  // 開始時刻順
}
interface StandBooking {
  flightPairId: string;          // 到着便+出発便のペア
  aircraftId?: Id<'ac'>;
  from: SimTime; to: SimTime;    // 予定占有時間窓（バッファ込み）
  state: 'planned' | 'occupied' | 'released';
}

interface GateState {
  id: Id<'gate'>; structureId: Id<'st'>;
  standIds: Id<'stand'>[];
  hasJetBridge: boolean;
  holdroomCapacity: number;      // 待合席数（派生）
}

interface FacilityState {        // チェックイン・保安検査・受取所・仕分け場・店舗
  id: Id<'fac'>; structureId: Id<'st'>;
  kind: 'checkIn' | 'kiosk' | 'security' | 'baggageClaim' | 'baggageSort' | 'shop' | 'restroom';
  servers: number;               // レーン数 / カウンター数
  staffed: number;               // 配置職員数（servers 以下）
  queue: Id<'pg'>[];             // 待ち行列（FIFO）
  inService: { groupId: Id<'pg'>; remainingPax: number; progress: number }[];
  queueCapacityPax: number;
  airlineIds?: Id<'al'>[];       // チェックインの航空会社割り当て（空=共用）
}
```

## 7. 航空会社・契約・便・航空機

```ts
interface Airline {
  id: Id<'al'>; name: string; code: string;           // 架空
  type: 'lcc' | 'fullService' | 'regional';
  priceSensitivity: number;      // 0..1
  qualityRequirement: { minOtp: number; maxAvgTaxiMin: number };
  satisfaction: number;          // 0..100
}

interface Contract {
  id: Id<'ct'>; airlineId: Id<'al'>;
  route: { destination: string; distanceKm: number };
  aircraftType: AircraftTypeId;
  weeklyFrequency: number;
  preferredWindow: { fromMin: number; toMin: number }; // 時刻帯（日内分）
  feeTerms: { landingFeeDiscount: number; paxFeeDiscount: number };
  startDay: number; endDay: number;
  status: 'proposed' | 'active' | 'expired' | 'terminated';
}

interface Flight {
  id: Id<'fl'>; contractId: Id<'ct'>; airlineId: Id<'al'>;
  number: string;                // "SL123"
  direction: 'arrival' | 'departure';
  pairFlightId?: Id<'fl'>;       // 折り返しペア
  scheduled: SimTime;            // 到着=着陸予定 / 出発=プッシュバック予定（ブロック時刻）
  estimated: SimTime;            // 遅延反映後の予定
  actual?: SimTime;
  aircraftId?: Id<'ac'>;
  standId?: Id<'stand'>;
  gateId?: Id<'gate'>;
  paxBooked: number;             // 予約旅客数
  bagsBooked: number;
  status: FlightStatus;          // [04] §2
  delayCauses: DelayCause[];
}

interface AircraftType {         // 静的定義データ（セーブには含めない、IDのみ参照）
  id: AircraftTypeId;            // 'regional70' | 'narrow180' | 'wide300'
  size: SizeClass;
  seats: number;
  mtowT: number;                 // 着陸料計算用
  minRunwayTiles: number;
  taxiSpeedMps: number;
  approachSepSec: number;        // 先行機との最小間隔（簡略化した後方乱気流区分）
  runwayOccupancyLandSec: number;
  runwayOccupancyTakeoffSec: number;
  turnaroundMinSec: number;      // 最小折り返し時間
  fuelLiters: number;
}

interface Aircraft {
  id: Id<'ac'>; typeId: AircraftTypeId; airlineId: Id<'al'>;
  registration: string;
  state: AircraftState;          // [04] §3
  stateSince: SimTime;
  arrivalFlightId?: Id<'fl'>; departureFlightId?: Id<'fl'>;
  standId?: Id<'stand'>;         // 参照用（正は StandAllocation）
  route?: { nodes: NodeId[]; index: number; progressM: number };
  pos: { x: number; y: number; heading: number }; // 論理位置（タイル座標・連続値）
  holdReason?: string;
}
```

## 8. 旅客・手荷物

旅客は1人ずつではなく **旅客グループ** 単位で扱う（性能と決定性のため。[04](04_operations_passenger_spec.md) §6 参照）。

```ts
interface PaxGroup {
  id: Id<'pg'>;
  flightId: Id<'fl'>;
  direction: 'departing' | 'arriving';
  count: number;                 // 人数（1〜20程度）
  bags: number;                  // 預け手荷物数
  stage: PaxStage;               // [04] §6
  stageSince: SimTime;
  location: { facilityId?: Id<'fac'>; nodeId?: string };
  arrivedAirportAt?: SimTime;
  waitAccumSec: number;          // 累計待ち時間（満足度用）
  walkAccumM: number;
  satisfaction: number;          // 0..100
  spentMoney: Money;
}

interface BagBatch {
  id: Id<'bg'>;
  flightId: Id<'fl'>;
  count: number;
  stage: 'checkedIn' | 'sorting' | 'madeUp' | 'toAircraft' | 'loaded'
       | 'unloading' | 'toClaim' | 'onBelt' | 'collected' | 'missed';
  stageSince: SimTime;
}
```

## 9. 乱数（RngState）

- PRNG: 32bit 整数演算のみで実装できる `sfc32` または `xoshiro128**`（浮動小数の機種差を避ける）。
- **ストリーム分離**: 用途ごとに独立した状態を持つ。ある機能に乱数呼び出しを追加しても、他機能の乱数列がずれない。

```ts
interface RngState {
  seed: string;                          // ユーザー指定可
  streams: Record<'demand' | 'delay' | 'paxArrival' | 'service' | 'events' | 'airline', [number, number, number, number]>;
}
```

## 10. 財務・統計

```ts
interface FinanceState {
  cash: Money;
  loans: { id: string; principal: Money; ratePerDay: number; remaining: Money }[];
  ledger: LedgerEntry[];         // 当日分の明細（日次締めで集計→統計へ）
}
interface LedgerEntry { t: SimTime; category: LedgerCategory; amount: Money; ref?: string }
type LedgerCategory =
  | 'landingFee' | 'paxFee' | 'parkingFeeAircraft' | 'retail' | 'carParking'
  | 'construction' | 'maintenance' | 'salary' | 'utilities' | 'loanInterest' | 'refund';
```

## 11. コマンド（プレイヤー操作）

プレイヤー操作はすべて **コマンド** としてコアに渡す。UIは状態を直接書き換えない。

```ts
type Command =
  | { type: 'build'; kind: StructureKind; footprint: TileRect | TileKey[]; params: unknown }
  | { type: 'demolish'; target: Id<'st'> | TileKey[] }
  | { type: 'setSpeed'; speed: 0 | 1 | 15 | 60 | 240 | 600 }
  | { type: 'acceptContract'; contractId: Id<'ct'> }
  | { type: 'rejectContract'; contractId: Id<'ct'> }
  | { type: 'setFees'; fees: Partial<FeeSettings> }
  | { type: 'setStaff'; facilityId: Id<'fac'>; staffed: number }
  | { type: 'assignStand'; flightPairId: string; standId: Id<'stand'> }
  | { type: 'setRunwayMode'; runwayId: Id<'rwy'>; mode: RunwayState['mode']; activeEnd?: 0 | 1 };

interface CommandEnvelope { atTick: SimTime; seq: number; command: Command }
```

- コマンドは検証（`validate`）→ 適用（`apply`）の2段階。検証失敗時は理由コードを返し、状態は変化しない。
- 適用はティック境界でのみ行う。コマンドログ（`CommandEnvelope[]`）を保存すれば、初期状態 + ログでリプレイできる（回帰テストに使用）。

## 12. セーブ形式

> 以下は Phase 0 の案（`skyport-save` / IndexedDB）で、**実装とは異なる**。実際の保存形式（`skyport-project` / `skyport-layout`、4 つの版、検証と移行、保存先）は
> [21_save_format.md](21_save_format.md) を参照。

```json
{
  "format": "skyport-save",
  "schemaVersion": 1,
  "buildVersion": "0.1.0",
  "state": { "...": "GameState" }
}
```

- ロード時: `schemaVersion` を確認 → マイグレーション関数を順に適用 → 派生データ再構築 → 不変条件チェック、という流れは実装でも同じ（レイアウトの移行は `src/core/io/migrate.ts`）。
- 大きな配列（地形）の圧縮格納は未決事項のまま（現状は JSON の数値配列）。
