# 03. 空港データモデル

本書のデータ型は TypeScript 風の記法で示す（実装時の正式定義は `src/core/model/` に置く）。

## 1. 設計原則

1. **単一の状態ツリー**: シミュレーション状態はすべて `GameState` に集約し、JSONシリアライズ可能な plain object とする（クラスインスタンス・関数・循環参照を含めない）。
2. **安定ID**: すべてのエンティティは文字列IDを持つ。IDは状態内のカウンタから決定的に発行し、再利用しない。
3. **参照はIDで**: エンティティ間の参照はオブジェクト参照ではなくIDで持つ。
4. **建設レイヤーと論理モデルの分離**: プレイヤーが編集するのは建設レイヤー（`Structure`）のみ。通行可能性・接続は **派生データ**（`AirsideGraph` 等）として建設レイヤーから再生成する。派生データはセーブしない。
5. **割り当ての単一情報源**: 「どのスポットにどの便がいるか」「滑走路を誰が占有しているか」は、それぞれ1か所（`StandAllocation` / `RunwayState`）にのみ記録する。航空機側には参照用のIDを持たせるが、整合性チェックで一致を検証する。
6. **金額は整数**: 金額は最小通貨単位の整数（`Money = number`、小数を使わない）。
7. **時刻は整数秒**: `SimTime = number`（ゲーム開始からの秒）。

## 2. ID

```ts
type Id<K extends string> = `${K}_${number}`;   // 例: "ac_42", "stand_7"
```

| 接頭辞 | エンティティ |
|--------|-------------|
| `st` | Structure（建設物） |
| `rwy` | Runway |
| `stand` | Stand（駐機スポット） |
| `gate` | Gate |
| `fac` | Facility（チェックイン・保安検査等の処理施設） |
| `al` | Airline |
| `ct` | Contract |
| `fl` | Flight |
| `ac` | Aircraft（運航中の機体インスタンス） |
| `pg` | PaxGroup（旅客グループ） |
| `bg` | BagBatch（手荷物バッチ） |
| `job` | TurnaroundTask（地上支援作業） |
| `crew` | GseCrew |
| `ev` | イベントログ |

発行: `state.idCounters[prefix]++`。ID はシミュレーション中もロード後も不変。論理グラフのノード/エッジIDは派生データなので、構造から決定的に計算する（例: `n_${x}_${y}`）。

## 3. GameState（トップレベル）

```ts
interface GameState {
  schemaVersion: number;          // セーブ互換用
  meta: { name: string; createdAt: string; mode: 'sandbox' | 'free' };
  time: { now: SimTime; speed: 0 | 1 | 2 | 4 | 8 };
  rng: RngState;                  // ストリーム別の乱数状態（§9）
  idCounters: Record<string, number>;

  map: MapState;                  // 地形
  structures: Record<Id<'st'>, Structure>;   // 建設レイヤー（配置系）
  paintLayers: PaintLayers;                  // 建設レイヤー（ペイント系: 誘導路・エプロン・道路）
  // ↓ 建設レイヤーに紐づく運用エンティティ（Structure と 1:1 でIDを共有しない独立ID）
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
  occupancy: TileOccupancy;        // タイル → Structure ID
  airside: AirsideGraph;           // 航空機用グラフ
  landside: LandsideNetwork;       // 旅客処理ネットワーク
  roads: RoadGraph;                // 車両・旅客アクセス
  validation: ValidationIssue[];   // 接続性警告
  structureVersion: number;        // 建設変更ごとに増加（キャッシュ無効化用）
}
```

## 4. マップと建設レイヤー

```ts
interface MapState {
  width: number; height: number;                 // タイル数
  terrain: Uint8Array | number[];                // index = y*width+x, TerrainType
  elevation?: number[];                          // 予約（初期版未使用）
  ownedMask: number[];                           // 購入済み区画
}

type TerrainType = 0 /*grass*/ | 1 /*water*/ | 2 /*forest*/ | 3 /*blocked*/;

type StructureKind =
  | 'runway' | 'stand' | 'holdPoint' | 'rapidExit'
  | 'tower' | 'gseBase' | 'fuelFarm' | 'fireStation' | 'hangar'
  | 'terminal' | 'checkIn' | 'security' | 'gate' | 'waitingArea' | 'shop'
  | 'baggageClaim' | 'baggageSort' | 'restroom'
  | 'road' | 'curbside' | 'parking' | 'busStop' | 'railStation';

interface Structure {
  id: Id<'st'>;
  kind: StructureKind;
  footprint: TileRect | TileSet;     // 占有タイル
  rotation: 0 | 90 | 180 | 270;
  status: 'constructing' | 'active' | 'pendingDemolition';
  buildCompleteAt?: SimTime;
  params: StructureParams[kind];     // 種類別パラメータ（下表）
  linkedEntityId?: string;           // rwy_/stand_/gate_/fac_ への参照
}
```

| kind | 主な params |
|------|-------------|
| runway | `{ start: Tile; end: Tile; widthTiles: 3 }` → 長さ・対応機種は派生 |
| stand | `{ size: 'S'\|'M'\|'L'; noseDir: Direction; pushbackDir: Direction }` |
| gate | `{ standIds: Id<'stand'>[]; hasJetBridge: boolean }` |
| checkIn / security / baggageClaim | `{ lanes: number }` |
| terminal | `{ zones: { restricted: TileSet; public: TileSet } }` |

> 建設物は2系統で保持する。**配置系**（滑走路・建物・スポット等、形と向きを持つもの）は `Structure`。**ペイント系**（誘導路・エプロン・道路、タイル単位で塗り広げるもの）は `PaintLayers` にタイルキー単位で保持する。ペイント系を巨大な1つの Structure にすると部分撤去・部分建設中の表現が煩雑になるため。

```ts
interface PaintLayers {
  taxiway: Record<TileKey, { widthClass: 'narrow'|'wide'; oneWay?: Direction; status: BuildStatus }>;
  apron:   Record<TileKey, { status: BuildStatus }>;
  road:    Record<TileKey, { oneWay?: Direction; status: BuildStatus }>;
}
type TileKey = `${number},${number}`;
```

## 5. エアサイド論理グラフ（派生）

```ts
interface AirsideGraph {
  nodes: Record<NodeId, AirsideNode>;
  edges: Record<EdgeId, AirsideEdge>;
  adjacency: Record<NodeId, EdgeId[]>;  // 出ていくエッジ
}

interface AirsideNode {
  id: NodeId;                    // "n_x_y"（タイル中心）
  pos: { x: number; y: number }; // タイル座標（描画とは独立）
  kind: 'taxiway' | 'apron' | 'runway' | 'holdPoint' | 'standEntry' | 'runwayThreshold';
  runwayId?: Id<'rwy'>;          // 滑走路上または保護区域内のノード
  standId?: Id<'stand'>;
}

interface AirsideEdge {
  id: EdgeId;
  from: NodeId; to: NodeId;      // 有向（双方向は2本）
  lengthM: number;               // メートル換算
  maxSize: 'S' | 'M' | 'L';      // 通行可能な最大機体
  kind: 'taxi' | 'runway' | 'runwayCrossing' | 'pushback' | 'standLink';
  runwayId?: Id<'rwy'>;          // このエッジ通行に滑走路占有が必要
  speedLimitMps: number;         // 直線/旋回/エプロンで異なる
}
```

### 5.1 グラフ生成規則

1. 有効（`active`）な誘導路・エプロン・滑走路タイルごとにノードを1つ作る。
2. 4近傍で隣接する走行可能タイル同士にエッジを張る。斜め接続は、両側の直交タイルも走行可能な場合のみ（角の切り込み防止）。
3. `maxSize` = 両端タイルの幅区分の小さい方（`narrow`→M, `wide`→L、エプロン→L、滑走路→滑走路の対応機種）。
4. 一方通行指定のタイルからは逆方向エッジを作らない。
5. 滑走路タイルに接する誘導路ノードは `holdPoint` とし、そこから滑走路ノードへのエッジに `runwayId` を設定する。滑走路を横切る経路は `runwayCrossing` として同じく滑走路占有を要する。
6. スポットは `standEntry` ノードを持ち、隣接するエプロン/誘導路ノードと `standLink`（進入）・`pushback`（退出、後退）エッジで接続する。
7. 建設中・撤去予約中のタイルはノードを作らない（撤去予約中は既存予約の完了まで残す）。

この生成規則により、**グラフに存在しないエッジは物理的に通れない**。航空機は必ずグラフ上の経路に沿ってのみ移動するため、「接続していない誘導路への進入」は構造的に起こらない。

### 5.2 誘導路区間予約

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
  | { type: 'setSpeed'; speed: 0 | 1 | 2 | 4 | 8 }
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

```json
{
  "format": "skyport-save",
  "schemaVersion": 1,
  "buildVersion": "0.1.0",
  "state": { "...": "GameState" }
}
```

- 保存先: IndexedDB（スロット制）+ JSONファイルのダウンロード/アップロード。
- ロード時: `schemaVersion` を確認 → マイグレーション関数を順に適用 → 派生データ再構築 → 不変条件チェック。
- 大きな配列（地形）は Base64 で圧縮格納を検討（未決事項）。
