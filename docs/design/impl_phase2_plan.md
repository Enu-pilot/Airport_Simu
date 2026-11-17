# フェーズ 2 実装計画・要件（誘導路を途中まで進む・出発時刻の制限）

- 根拠: docs/42 §1（K-2・K-3）・§3.1（2-01〜2-16）・§4・§5、docs/41 §1、docs/40（R1〜R17）、docs/39 §11、docs/11 §7〜§9。
- 位置づけ: 要件の詳細と作業の分割。仕様の本文は複製しない。**ここで置いた既定値は §8 にまとめ、理由を書く**（docs/42 §1 の「未決は実装計画で既定を置いて記録」）。
- 前提: フェーズ 1 の 1-12（`setHold` の起点の取り直し・`stepInbound` のダイバート条件）、1-13（`takeoffRollSec`・`departureBlocked` の予測）、1-14（`assignStand` の `requestedStandId`・`project.ts` `checkSim` の検証）が**合流済み**で、docs/42 §5 の第 3 段階（ゴールデンの扱い）が終わっていること。行番号ではなく関数名で示す。
- 共通の約束:
  - 新しい挙動はすべて opt-in。**設定のないデータでは新しいコードの分岐に入らない**（`if (sim.ctx.blocks)`・`if (city?.nightOps)` の外は従来のまま）。
  - 既存テストの期待値・ゴールデンは変えない。版の変更（§1.6）は承認を得てから行う。
  - `HANDOFF_PROMPT.md` と docs/42 の状況欄はコーディネーターだけが更新する。

---

## 1. データモデル

### 1.1 空港の設定（`src/core/model/types.ts` `AirportLayout`）— 判定ルール `ruleSet` と同じ形

| 項目 | 型・範囲 | 既定（欠落時） | 書き方 |
|---|---|---|---|
| `taxiMode?` | `'block'` | 欠落 = 従来の全区間確保（`'full'` は書かない） | `updateLayoutSettings` で `'full'` を選んだらキーを消す（`ruleSet` の `classic` と同じ） |
| `taxiBlockTiles?` | 整数 4〜40（タイル。1 タイル = `TILE_M` 25 m） | 10（= 250 m） | 10 のときは書かない。`taxiMode` が欠落でも保持してよい（切り替えて戻しても値が残る） |

`TaxiwayEdge.blockMaxAircraft?`: 整数 1〜10。その誘導路を含む区間の進入可能機数の**上限**（計算値より小さくする方向だけ。§8-3）。

- 変更は建設モードだけ（`AirportSettings` は `mode === 'operate'` で無効。既存の作り）。
- 検証: `src/core/io/serialize.ts` に `checkTaxiFields(layout, where)` を追加し、`checkRunwayFields` と同じ箇所から呼ぶ。不正値は読み込みエラー。

### 1.2 大きさ別の必要長（`src/core/sim/rules.ts`）

| 定数 | 値 | 根拠 |
|---|---|---|
| `FOLLOW_GAP_M` | 40 | `MIN_GROUND_SEPARATION_M`（20）の 2 倍。追従時の機首〜前機の尾部の間隔 |
| `BLOCK_REQ_M` | `{ S: 70, M: 90, L: 120 }` | 区分内の最大機体長 + `FOLLOW_GAP_M` を 10 m 単位に切り上げ。カタログ: S = regional70（27 m）、M 最大 44.51 m、L 最大 73.86 m |
| `JUNCTION_STOP_M` | 45 | 交差点・スポット入口の手前で止まる距離。機首点どうしの距離で測る `detectConflicts` で、交差点を通る機体と 20 m 未満にならない余裕 |

ゲーム内の値であり、実在の基準を表さない（docs/41 冒頭と同じ）。

### 1.3 区間の構造（`SimContext.blocks?: TaxiBlockGraph`。`taxiMode === 'block'` のときだけ作る）

新ファイル `src/core/sim/taxiBlocks.ts`（純粋関数。`buildTaxiBlocks(layout, network, tiles): TaxiBlockGraph`）。

```ts
interface TaxiBlockSpan { edgeId: string; fromM: number; toM: number; forward: boolean } // エッジ上の範囲（エッジの from からの距離）
interface TaxiBlock {
  id: string;            // `${segmentId}#${k}`（segmentId = 区切りの間の最初のエッジ ID。レイアウトの ID から決まる）
  corridorId: string;
  spans: TaxiBlockSpan[];
  lengthM: number;
  startNode: string | null; endNode: string | null;   // 正規の向きの両端。分割点は null
  endKind: { start: EndKind; end: EndKind };          // 'junction' | 'runway' | 'standEntry' | 'endpoint' | 'split' | 'attr'
  usableM: { fwd: number; rev: number };              // 長さ − 出口側の停止距離（向きごと）
  maxAircraft?: number;                               // 誘導路の上書きの最小値
}
interface TaxiCorridor { id: string; blocks: string[]; oneWay: boolean }
interface TaxiBlockGraph {
  tiles: number;
  blocks: Record<string, TaxiBlock>;
  corridors: Record<string, TaxiCorridor>;
  edgeBlocks: Record<string, string[]>;  // 誘導路エッジ ID → 区間 ID（エッジの from からの順）
  junctions: Set<string>;                // 同時に 1 機のノード（交差点・スポット入口・滑走路ノード）
}
```

経路から区間への対応は `routeBlocks(ctx, route)` で求め、`WeakMap<Route, RouteBlocks>` にキャッシュする（`routes.ts` の `holdCache` と同じ方式。保存しない。復元後に同じ値で作り直す）。

### 1.4 運航状態（`src/core/sim/types.ts`）

```ts
// SimState（block のときだけキーを作る。従来の運航にはキーなし）
taxiBlocks?: {
  occ: Record<string, string[]>;   // 区間 ID → 機体 ID（先頭 = 進行方向の前）。区間内の機体 + 先に枠を確保した機体
  locks: Record<string, { dir: 1 | -1; holders: string[] }>; // 回廊 ID → 向きと確保している機体（ID 順）
  oppWait?: Record<string, { acId: string; since: number }>; // 対向待ちの公平性（§2.6）
  priority?: string;               // 規則 4 で優先中の機体
  stats: { resolutions: number; reroutes: number; overruns: number; unresolved: number; nightStranded: number };
}
// 交差点（junctions）の排他は既存の nodeReservations を使う。block では edgeReservations を使わない。
```

`HoldReason` に追加: `'blockFull'`（前の区間が満杯）、`'opposingTraffic'`（対向待ち）、`'runwayQueue'`（滑走路手前の列）。横断待ちは既存の `'crossing'`。`HOLD_TO_DELAY`: blockFull・opposingTraffic → `taxiCongestion`、runwayQueue → `runwayQueue`。

`Flight` に追加（値があるときだけ書く）:
- `nightHold?: { kind: 'stand' | 'origin' | 'airborne'; decidedAt: number; releaseAt: number }`（夜間制限で止めた便。R15 の集計に使う）。
- 遅延の指標は保存項目を増やさず、既存の `scheduled`・`actual`・`standId`・`runwayId` と `nominalOutSec`（§3.1）から計算する（§3.5）。

### 1.5 出発時刻の制限（`src/core/economy/city.ts` `CityConfig`）

```ts
nightOps?: {
  version: 1;
  departureCutoffMin: number;   // 最終出発時刻（日内の分）。既定 1275（21:15 = 22:00 − 45 分）。範囲 1200〜1305（制限開始の 120〜15 分前）
  inboundPolicy: 'originHold';  // R10。フェーズ 2 は 1 種類だけ（§8-8）
  airborneHoldMaxMin: number;   // 上空の夜間待機の上限。既定 30、範囲 0〜120
  warnLeadMin: number;          // R11。予測離陸が制限開始の何分前を越えたら警告。既定 20、範囲 0〜120
  prioritizeAtRisk: boolean;    // R12。既定 false
}
```

- `nightOps` が欠落 = 従来どおり（計画の出発は 21:50 まで、夜間は滑走路手前で待つ）。**都市設定のある既存の保存データにも自動では入れない**（docs/40 §5・§8-8）。新規ゲームで都市を選んだときだけ、画面の新規作成の処理が既定値で入れる（`defaultCity` は変えない。ゴールデンを守るため）。
- 検証: `isCityConfig` は `nightOps` を見ない（不正な都市設定を `delete` する既存の正規化 `company.ts` の `c.city` を巻き込まないため）。`isCityNightOps(v)` を別に作り、`project.ts` の `checkCompany` で**読み込みエラー**にする（検証 → 適用の原則）。

### 1.6 版

| 版 | 判断 | 理由 |
|---|---|---|
| 保存形式 `PROJECT_FORMAT_VERSION` | **4 を新設して、使うときだけ 4 で書く（承認が必要）** | `taxiMode` / `nightOps` / `state.taxiBlocks` を旧アプリ（最大 3 まで読める）が読むと、知らないキーを無視して従来方式で運航を続ける。block の途中状態は `edgeReservations` を持たないので、旧アプリでは不変条件 T1 違反と異なる結果になる。4 にすれば旧アプリは「新しい版」として読み込みを拒否する。`formatVersionOf` に `layoutUsesFormat4(layout) \|\| companyUsesFormat4(company) \|\| hasKey(sim.state,'taxiBlocks')` を最優先で足す。使わないファイルは今の版のまま（バイト列不変） |
| `SIM_MODEL_VERSION` | フェーズ 2 の完了時に 1 回だけ上げる案を出す（承認が必要。フェーズ 1 の §5 第 3 段階の版と合わせて番号を決める） | 計算規則が増える（opt-in）。従来データの結果は変わらないが、新方式のシナリオ結果を区別するため。上げると保存のゴールデン（版の文字列）が変わるので、§5 の手順で扱う。承認されなければ上げず、記録する |
| `SCHEMA_VERSION`（レイアウト）・`state.version` | 変えない | 任意項目の追加だけ。欠落 = 従来の既定 |
| 旧データの移行 | 不要 | 欠落 = 従来方式。読み込み時に何も足さない |

**決定（2026-11-17、コーディネーター。版の判断はプロダクトオーナーから委任）**:
- 保存形式: **4 を採用**。`taxiMode`・`nightOps`・`state.taxiBlocks`・`nightHold` のいずれかを含むときだけ 4 で書き、それ以外は従来どおり 3 以下。理由: 旧アプリが新方式のデータを黙って従来方式で運航するのを防ぐ（読み込み時に「新しい版」として拒否される）。
- `SIM_MODEL_VERSION`: **上げない**（現在 10.4）。理由: 新方式は opt-in で、既存レイアウトの結果は変わらない（`legacyFingerprint.test.ts` とゴールデンで証明する）。上げると、運航中に保存したデータが不必要に建設モードで開くことになる。従来方式の結果が変わることが分かった場合は、その時点で上げる。

---

## 2. 地上走行のアルゴリズム（`taxiMode === 'block'` のときだけ）

### 2.1 区間の分割（配置の解析時に 1 回。`createContext` から呼ぶ）

1. **区切りのノード**（必ず区切る）: 誘導路の次数（`standLink`・滑走路エッジを除く誘導路エッジの本数）が 2 でないノード（交差点 ≥3・行き止まり 1）、`runwayIds` を持つノード（滑走路の入口・横断点・自由角度の交差点の保護範囲 `crossingNodeRunways` を含む）、`standIds` を持つノード（スポットの入口）、前後のエッジの `widthClass`・`oneWay`・`codeF`・`blockMaxAircraft`・運用状態が異なるノード（区間内の条件を一様にする）。
2. **区切りの間（セグメント）**: 区切りのノードを `compareIds` 順、出るエッジを ID 順に回り、区切りでないノードを通り抜けて次の区切りまでのエッジ列を作る。通ったエッジは印を付けて二重に作らない。正規の向き = 端点の ID が小さい側から。
3. **タイル数による分割**: セグメントの長さ `Ls`（m）を `n = max(1, ceil(Ls / (tiles × TILE_M) − 1e-9))` 等分する。境界はエッジの途中でもよい（`spans` で表す）。等分なので端数の短い区間ができない。
4. **滑走路の手前**: 端が滑走路ノードのセグメントは、その端から停止距離 `h = max over 入るエッジ holdShortDistanceAt(...)`（自由角度は `holdShortOnRoute` と同じ規則でセグメントに沿って戻した距離）の位置でも区切る。滑走路側の小片（**入口の小片**）は区間の枠を持たず、離陸・横断の許可を得た機体だけが入る。`h` がセグメント長以上になる浅い角度の自由角度の滑走路では、セグメント全体を入口の小片にし、その手前の交差点を停止位置にする（安全側）。
5. **回廊**: 区間を「交差点・行き止まり・滑走路ノードでない区切り」（スポット入口・条件の変わり目・分割点）でつないだ最大の列。1 車線なので、回廊は**同時に 1 つの向き**しか使えない（§2.4）。
6. **交差点**（`junctions`）: 次数 ≥3 のノード、スポットの入口、滑走路ノード。同時に 1 機（`nodeReservations`）。
7. **決定性**: 入力は配置だけ。走査の順を ID 順に固定し、等分の位置は同じ浮動小数の計算で得る。`tiles` を変えると区間数が変わる（2-01 の単体テスト）。区間の長さの和 = 元の誘導路の長さの和（入口の小片を含む。誤差 1e-6 m 以内）。

### 2.2 進入可能機数（2-02）

- 向き `d` の使える長さ `U = usableM[d]`（出口が交差点・スポット入口なら `JUNCTION_STOP_M`、滑走路なら 0（入口の小片で切ってあるため）、分割点・行き止まりなら 0 を引く）。
- 入れる条件: `Σ BLOCK_REQ_M[区間内と確保済みの機体の大きさ] + BLOCK_REQ_M[s] ≤ max(U, BLOCK_REQ_M[s])` かつ機数 < `maxAircraft`（あれば）。空の区間には常に 1 機入れる（最小 1）。
- 同じ大きさだけなら `cap[s] = max(1, floor(U / BLOCK_REQ_M[s]))`。よって S ≥ M ≥ L。
- **止まれない区間**: `U < BLOCK_REQ_M[s]` の区間は、その大きさの機体にとって「通過専用」（入るときは、先の止まれる区間まで一緒に確保する。§2.3）。
- 計算例（出口が交差点。U = 長さ − 45 m）:

| 区間の長さ | U | S（70） | M（90） | L（120） |
|---|---|---|---|---|
| 4 タイル 100 m | 55 | 1（通過専用） | 1（通過専用） | 1（通過専用） |
| 8 タイル 200 m | 155 | 2 | 1 | 1 |
| 10 タイル 250 m（既定） | 205 | 2 | 2 | 1 |
| 12 タイル 300 m | 255 | 3 | 2 | 2 |
| 20 タイル 500 m | 455 | 6 | 5 | 3 |

  滑走路手前の列（出口が滑走路で U = 長さ）: 10 タイルなら M が 2 機（250 / 90）、L が 2 機（250 / 120）。混在の境界: U = 180 m で M+M（180）は入る、U = 179 m では入らない（2-02 の境界値）。

### 2.3 確保と前進（2-03）

- **確保の単位（チェーン）**: 機体が今の停止位置を越えて進むには、「次に止まれる区間まで」の交差点（`nodeReservations`）と区間の枠をまとめて確保する。交差点・入口の小片・通過専用の区間では止まらない。確保は全部できたときだけ行う（部分的な確保をしない）。
- **確保の時刻**: 停止位置までの距離が「制動距離 + 50 m」未満になった機体だけが要求を出す。要求は新関数 `taxiBlockControl(sim)`（`stepSimulation` の `runwayControl` の直後・`stepAircraft` の前、`sim.ctx.blocks` があるときだけ）でまとめ、`(waitSince ?? now, id)` の順に許可する（早く待ち始めた機体が先。合流点での飢餓を防ぐ）。
- **前進の上限（`movementLimit` に block の項を足す）**: `min(従来の上限, 確保した最後の区間の停止位置, 追従の上限)`。
  - 停止位置 = 区間の終わり − 出口の停止距離（滑走路手前は既存の `holdShortOnRoute`。従来と同じ停止位置）。
  - **追従（総当たりなし）**: `occ[b]` で自機の 1 つ前の機体 P を引き、P の区間内の進み `p_P`（P の `routeBlocks` から O(1)）を使い `上限 = 自機の区間入口 + p_P − P.lengthM − FOLLOW_GAP_M`。同じ区間は同じ端から同じ向きに入るので、進みの座標が一致する。
- **解放**: 尾部が区間の終わりを過ぎたら `occ[b]` から外す（`releasePassed` と同じ「機首位置 ≥ 端 + 機体長」）。交差点も同じ条件で解放。回廊の最後の区間を抜けたら `locks` の holders から外し、空なら消す。
- **区間の順序の保証**: 先に確保した機体が前。合流する交差点は同時に 1 機で、チェーンは交差点と先の区間を同時に確保するので、確保の順 = 物理的な順。
- **出発**（`stepReadyForPushback` の block の分岐）: 経路 = `departurePath`（`findPath` に新しい任意の `blockedMove(edgeId, fromNode)` を渡し、自機以外が逆向きに確保している回廊を避ける。`pathfinding.ts` は `blockedMove` が無ければ従来どおり）。経路の全回廊の向き（§2.4）+ スポット入口 + 最初のチェーンを確保できたらプッシュバック。理由: 向き → `opposingTraffic`、枠 → `blockFull`、経路なし → `noRoute`（従来の 60 分で運航不能も同じ）。
- **滑走路手前の列**: 列の先頭（停止位置にいる機体）だけ `holdShort`（`runwayControl` の列は従来どおり `queuedSince` 順）。後ろは `taxiOut` のまま止まり、理由 `runwayQueue`。先頭が `lineUp` に入ると後続が詰める。
- **滑走路の横断**: 既存の `pendingCrossing`・`crossingChain`・`runwayControl` の許可を使う。block では許可の条件に「向こう側の入口の小片 + 次に止まれる区間までのチェーンを確保できる」を足し、許可と同時に確保する（`runwayControl` の横断の部分。滑走路上で止まらない）。連続横断はチェーンが次の滑走路の先まで伸びる。
- **待機の理由**（2-06）: 速度 0 になったとき、上限を決めた要因で付ける: 確保の失敗（枠）→ `blockFull`、確保の失敗（向き）→ `opposingTraffic`、前の機体が `holdShort`/`runwayQueue` → `runwayQueue`、前の機体が `blockFull` → `blockFull`、横断 → `crossing`。

### 2.4 デッドロックを避ける規則（2-04。docs/41 §1.4）

- **規則 1（向き）を経路全体に広げる**: 機体は動き出す前（出発はプッシュバック時、到着は進入許可時）に、経路上の**すべての回廊の向き**をまとめて確保する。同じ向きは共有（holders に足す）、逆向きがあれば確保しない。枠（機数）は §2.3 のとおり先の分だけ。
  - 理由: docs/41 の「一本道だけ」では、2 つの回廊が交差点で向かい合う形（X は C1→C2、Y は C2→C1、交差点で互いの回廊を待つ）を防げない。向きの確保を経路全体で一括にすると、逆向きの 2 機が同じ回廊を確保することがなく、正面の行き詰まりは構造的に起きない。同じ向きの後続は続けて入れるので G2（追従・列）は満たす。
  - **公平性**: 逆向きを待つ機体が `DIR_FAIRNESS_SEC`（120 秒）以上待ったら `oppWait` に記録し、その回廊への同じ向きの新しい確保を止める（流れが切れて逆向きが通る）。
- **規則 2（行き止まり）**: 回廊の端が行き止まり（またはスポット入口だけが並ぶ行き止まりのエプロン）のとき、到着が奥向きを確保するのは、その奥に `readyForPushback`（出発予定 − `PUSHBACK_DISPATCH_LEAD_SEC` を過ぎた）・`pushback` の機体がいないときだけ（出発を優先）。到着は奥のスポットに入れば回廊を抜けるので待ちの輪ができない。
- **規則 3（到着の離脱）**: 進入の許可（`stepInbound` の block の分岐）は、(a) 滑走路の出口からスポットまでの経路があり、(b) その全回廊の向きを確保でき、(c) 出口の小片 + 機体が滑走路の解放位置（`cum[exit] + max(holdShortOnRoute(+1), lengthM)`）を越えて止まれる最初の区間までのチェーンを確保できるときだけ出す。確保は進入許可の時点で行い、ゴーアラウンドで解放する。スポットまでの全区間の**枠**は要求しない（docs/41 規則 3）。向きは要求する（§8-5）。
- **交差点の中で止まらない**: チェーンの単位で保証（§2.3）。
- **規則 4（検出と解消）**: `now % RETRY_SEC === 0` のティックだけ `detectTaxiStall(sim)` を実行する。
  1. 対象: block で速度 0、理由が `blockFull`/`opposingTraffic`/`runwayQueue` 以外の地上待機ではなく、`now − waitSince ≥ STALL_SEC`（180 秒）の機体。
  2. 待ちの相手: 確保できないチェーンの区間の先頭の機体（枠）または逆向きの holders（向き）。ID 順に辺を作り、ID 順の深さ優先で閉路を探す。
  3. 閉路があれば、その中で最も長く待っている機体（同時なら ID 順）X に対して順に試す: (i) 待っている区間を避けて現在の停止ノードから経路を探し直し（1 回）、新経路のチェーンと向きが確保できれば乗り換える（`reroutes++`）。(ii) できなければ `priority = X` とし、X の次のチェーンへの他機の新しい確保を止める。(iii) さらに `STALL_SEC` 進まなければ、X の次の区間に機数を超えて入れる。ただし追従の上限で物理的に止まれる位置（尾部が交差点を抜ける）があるときだけ（`overruns++`）。(i)〜(iii) のどれかが効いたら `resolutions++`。どれもできなければ `unresolved++` とイベント `taxiGridlock` を記録する（受け入れテストは 0 を要求）。
  4. 終わること: 1 回の検査は O(待機機数 + 辺) と経路探索 1 回で終わり、ティック内で繰り返さない。(i)(iii) は X の上限を厳密に増やし、(ii) は閉路の外からの流入を止めるので、経路が有限（単純経路）の機体は閉路の外へ抜けていく。完全に満杯の環で物理的な余地もない場合だけ (iii) が効かず、`unresolved` として検出される（黙って止まらない）。
- **防げないと分かっている型**（§7 リスク）: 交差する流れが作る閉路（格子状の誘導路で全区間が満杯）。規則 4 で解消し、回数を記録する。ストレス配置で回数が 0 でなければ、§7 の「環への流入の制限」を入れる。

### 2.5 経路の選び直し（T4）

- 待っている機体（停止位置にいて `now − waitSince ≥ REROUTE_SEC`（60 秒））だけ、`REROUTE_SEC` ごとに 1 回、停止位置の先のノードから経路を探す（他機の逆向きの回廊・満杯の区間・閉鎖を避ける）。新経路のチェーンと向きが確保できるときだけ乗り換え、旧経路の未進入の回廊の向きを返す。経路は「通過済みの部分 + 新しい部分」でつなぐので `dist` と `cum` の前半は変わらない。毎ティックの経路探索はしない。

### 2.6 決定性

- すべての走査は `sortedValues`・`compareIds` の順。要求の許可は `(waitSince, id)` の順。乱数は使わない。
- 派生データ（`ctx.blocks`・`routeBlocks`）は配置と経路だけから作り、保存しない。保存するのは `taxiBlocks` の `occ` の順・`locks`・`oppWait`・`priority`・`stats`（T8）。

### 2.7 既存の処理との関係（漏れると占有が残る箇所）

`releaseEverything`・`goAround`・`divert`・`cancelTurnaround`・`cancelFlightEarly`・運航不能・`startTakeoff`（`releaseAll` の隣）で、`releaseTaxiBlocks(state, acId)`（その機体の `occ` と `locks` を外す）を呼ぶ。`reassignStand`（1-14）で到着機のスポットが変わったときは、未進入の回廊の向きを確保し直す（できなければ進入前なら許可を取り消して待機）。閉鎖（`closures.taxiways`）は新しい確保だけを止め、走行中の機体は従来どおり走り切る。

---

## 3. 夜間（K-3、docs/40 R8〜R15）

### 3.1 予測離陸時刻（1-13 と同じ予測を使う）

新ファイル `src/core/sim/nightOps.ts`:
- `nominalOutSec(sim, ac, path?)` = プッシュバック（`cum[1] / PUSHBACK_SPEED` を tick に切り上げ）+ `ENGINE_START_SEC` + 地上走行（停止位置まで / `taxiSpeed × weatherEffects.taxi`）+ 整列（停止位置から滑走路ノード / `LINEUP_SPEED`）+ `LINEUP_ALIGN_SEC` + `takeoffRollSec(type)`。
- 経路を引数で渡さないときは、スポット → 使える入口の**混雑を無視した最短経路**を 1 回だけ探し、`Simulation` に持つ保存しないキャッシュ（キー: スポット・機種の大きさ・codeF・滑走路の運用方向）に置く。復元後は同じ値で作り直す。
- `predictTakeoffAt(sim, ac, startAt)` = `startAt + nominalOutSec + 列の見込み`（同じ滑走路の `holdShort`・`runwayQueue`・`taxiOut` の機数 × `SEPARATION_SEC[M][M]`）+ `NIGHT_DEP_MARGIN_SEC`（600 秒）。
- `departureBlocked` の夜間判定（1-13 で `takeoffRollSec` に置き換え済み）は、整列以降の部分を `nightOps.ts` の `lineUpToAirborneSec(sim, ac)` に移して共通にする（値は変えない。1-13 の回帰テスト `s_curfewTakeoff` が守る）。

### 3.2 スポットで待機（R8・R9(a)）

- 判定点は 2 つ（`city.nightOps` があるときだけ）:
  1. **早い判定**: `turnaround`・`readyForPushback` で、搭乗開始の前（`now ≥ dep.estimated − boardingLeadSec − 60`）に 1 回。`predictTakeoffAt(sim, ac, max(now, dep.estimated))` が夜間なら止める。搭乗の開始は `f.estimated` 基準なので、`dep.estimated` を朝へ動かせば搭乗も朝になる（旅客は機内に入らない）。
  2. **最後の判定**: `stepReadyForPushback` で経路が決まった後、プッシュバックの直前に実際の経路で再判定する。
- 止めたとき: `dep.estimated = releaseAt`（§3.4）、`setHold(…, 'noiseCurfew')`、`addDelayCause(dep, 'noiseRestriction')`、`dep.nightHold = { kind: 'stand', … }`、`ac.retryAt = releaseAt − PUSHBACK_DISPATCH_LEAD_SEC`。
- **待機中に持つもの**: スポット（`standAssignments`）だけ。誘導路・交差点・区間・滑走路は持たない。プッシュバックの作業がすでに作られていたら取り消してトーイングカーと作業員を返す（`ground.ts` に `cancelPushbackTask(sim, acId)` を追加。`cancelTasks` の pushback 版）。搭乗済みの旅客（最後の判定で止めた場合だけ）は機内のまま（§7 の制限）。
- 万一の取りこぼし（予測が外れて離陸前に 22:00 を越えた機体）: 従来どおり滑走路手前で待ち、`stats.nightStranded++`。受け入れテストは 0 を要求する。

### 3.3 到着（R10。既定 = 出発地で待機）

- `stepAircraft` の `scheduled` の分岐（`inbound` に変わる前）: `arr.estimated` が夜間なら現れずに `arr.estimated = nextCityMovementTime(...) + k × SEPARATION_SEC[L][L]`（k = 同じ朝に出発地待機にした到着の順番。`(元の estimated, id)` の順）、`dep.estimated` も折り返し時間で動かす。`nightHold = { kind: 'origin' }`。上空に出ないので一晩の上空待機がなく、補償・ダイバートもない。
- すでに上空にいて夜間にかかった到着（現れた後に遅れた便）は、既存の `stepInbound` の `noiseCurfew` 待機。`now − 待機開始 ≥ airborneHoldMaxMin` でダイバート（`nightHold.kind = 'airborne'`）。既存の 45 分の判定（1-12 で `noiseCurfew` を起点から除外済み）とは別の判定として足す。
- 既定の理由: K-3（出発は止めて翌朝）と対になり、便を失わない（ダイバート・欠航は補償と評価の損失）。上空での 7.7 時間待ち（N-1）がなくなる。ダイバート・欠航を選べるようにするのはフェーズ 2 の範囲外（§8-8）。

### 3.4 朝の解放の順（R13）

- `releaseAt` は、同じ夜に止めた出発を `(元の scheduled, id)` の順に並べ、`releaseAt_k = nextCityMovementTime(now) − nominalOutSec + Σ SEPARATION_SEC[前][自]`（k 番目まで）とする。予測離陸が 06:00:00 以降で、通常の間隔で順に出る。
- 到着のスポット: 待機している出発がスポットを持ち続けるので、朝の到着は `assignStand` の通常の規則（1-14 の `requestedStandId`・計画スポット・空き）で別のスポットを選ぶか、空くまで待つ。出発地待機の到着は 06:00 以降に現れ、出発機は 06:00 前後から出るので、スポット不足は短い。テストで「朝の到着のダイバート 0」を確認する。

### 3.5 日次締め・遅延の指標（R14・R15、docs/36）

- **離陸の遅れ**（新しい値。既存の指標は置き換えない）: `takeoffDelaySec = max(0, dep.actual − (dep.scheduled + nominalOutSec(標準の経路)))`。スポットを離れた後の待機・夜間の待機を含む。標準の経路はスポットと滑走路から決まるので、保存項目を増やさない。
- `settleDay`（`src/core/economy/ops.ts`）: `city.nightOps` があるときだけ、日報 `DailyReport.city` の隣に `night?: { lastDepartureDelayMin: number | null; standHeld: number; originHeld: number; carriedOver: number; diverted: number; cancelled: number }` を書く（R15）。持ち越し便はその便の予定日に数え、まだ離陸していなければ `lastDepartureDelayMin` は予測離陸から求める（日付をまたぐ便の収入・費用の計上は従来どおり。変わらないことをテストで確認）。
- 振り返り（`src/core/analytics/review.ts`）: 便別の一覧に「離陸の遅れ」を「出発の実遅延」と別の列で出す。評価対象の遅延・補償（R16）にはフェーズ 2 では入れない（§8-10）。
- 夜の早送り（`dayloop.ts` `nightEndAt`）は変えない（到着は出発地待機で朝に現れ、出発は通常の刻みで 06:00 に動く）。

### 3.6 出発時刻の制限・警告・優先（R1〜R7・R11・R12・R17）

- `cityOperatingHours(hours, city)`: `nightOps` があれば `closeMin = min(hours.closeMin, nightOps.departureCutoffMin)`。`planDay` の出発 = 到着 + 折り返し + `PLAN_TURN_BUFFER_SEC` で、到着の上限が `closeMin − turnMin` なので、出発は最終出発時刻以前に収まる（R5）。収まらない契約は既存の `dropped` → `OUTSIDE_HOURS`（理由: `detail` に「最終出発時刻 21:15」）（R6）。仮想契約チェックも同じ `planDayWithDemand` を使う。
- 手動の便（R7）: `departureCutoffIssue(company, departureAt)` を `city.ts` に置き、画面で追加前に警告する（禁止しない。§8-9）。
- 早めの警告（R11）: `nightOps.ts` の `nightRiskFlights(sim)`（未離陸の出発で `predictTakeoffAt > 22:00 − warnLeadMin`）。`src/ui/operate/alerts.ts` が `night:<flightId>` の警告を出す。
- 優先（R12）: `prioritizeAtRisk` のときだけ、`runwayControl` の列の並びの先頭キーに「危険な便を先」を足す。既定 false では並びは変わらない。
- 能力ダッシュボード（R17）: 夜の枠を `departureCutoffMin` で切る（`capacity.ts` の運用時間）。

---

## 4. 要件ごとの変更とテスト

テストのファイルは `tests/unit/sim/`（コア）・`tests/unit/`（経済・保存）・`tests/e2e/`（画面）。監査の `tests/audit/d_helpers.ts`（`linearLayout`・`traceRun`・`allDone`・`takeoffTimes`・`runwayIntrusions`・`cityCompany`・`citySim`）を import して使う。`d_taxi_partial`・`d_curfew` は**従来方式の記録**として変えずに合格し続けること。

| ID | 変更する箇所 | テスト（ファイル: 観点） | 完了の判定（docs/42 §3.1） |
|---|---|---|---|
| 2-01 | `taxiBlocks.ts` `buildTaxiBlocks`、`context.ts` `createContext` | `taxiBlocks.partition.test.ts`: 直線・分岐・環状・行き止まり・一方通行・自由角度の滑走路・横断（a_network・crossingLayouts の配置）で区間の長さの和 = 誘導路の長さの和、同じ配置で 2 回作って一致、`tiles` 4/10/40 で区間数が単調、交差点・滑走路手前・スポット入口が必ず区切り。異常: 長さ 0 のエッジ、孤立した誘導路、運用中でない誘導路 | 左のとおり |
| 2-02 | `taxiBlocks.ts` `admits(block, dir, sizes, s)`、`rules.ts` | `taxiBlocks.capacity.test.ts`: S ≥ M ≥ L、混在は必要長の合計、境界（U = 180 で M+M 可、179 で不可）、最小 1、`blockMaxAircraft` の上限、通過専用 | 左のとおり |
| 2-03 | `simulation.ts`: `stepSimulation`（`taxiBlockControl` の呼び出し）、`movementLimit`・`moveTaxi`（block の項）、`stepReadyForPushback`（block の分岐）、`runwayControl`（横断の条件）、新 `blockControl.ts`、`pathfinding.ts`（`blockedMove`）、`invariants.ts`（B1〜B6） | `taxiBlocks.run.test.ts`: 途中状態を 10 秒ごとに検査（B1 占有 ≤ 進入可能機数、B2 逆向きの同居なし、B3 交差点・入口の小片での停止なし、B4 区間内の順と間隔 ≥ 最小値、B5 走行中の機体は `occ` に載る、B6 保持者が有効）。docs/39 §11.2 の条件（`linearLayout` 入口 1 つ・4 機同時）×3 シードで離陸間隔 ≤ 2 × `SEPARATION_SEC`、滑走路手前に 2 機以上並ぶ瞬間がある | 左のとおり |
| 2-04 | `blockControl.ts` 規則 1〜4、`detectTaxiStall`、`oppWait` | `taxiBlocks.deadlock.test.ts`（timeout 300 秒）: 対向 25 通り × 3 シード、ストレス 30 機 × 3 シード × 6 時間、自由角度（`crossingAirport`）、ランダム配置（`c_fuzz` の生成器、シード 5 個を記録）で競合 0・未完了 0・`unresolved` 0。通常の配置（サンプル空港・linear）で `resolutions` 0。規則 4 の単体: わざと満杯の環を作り検出・解消されること | 左のとおり |
| 2-05 | `stepInbound` の block の分岐（1-12 の変更と同じ関数） | `taxiBlocks.arrival.test.ts`: 到着 12 機の連続流入 × 出発（d1d と同じ条件）で `landing`/`vacating` の機体が解放位置の手前で速度 0 になった回数 0、`runwayIntrusions` 0、ゴーアラウンド時に確保が残らない | 左のとおり |
| 2-06 | `types.ts` `HoldReason`、`HOLD_TO_DELAY`、`src/i18n/ja.ts`（理由の文言 2 か所）、運航表・`alerts.ts` | 単体: 各理由が出るシナリオ 4 つ。E2E `tests/e2e/taxiBlocks.spec.ts`: 運航表に「前の区間が満杯」などが出る | 左のとおり |
| 2-07 | `operations.ts` `updateLayoutSettings`（`taxiMode`・`taxiBlockTiles`）・`updateEntity`（誘導路の `blockMaxAircraft`）、`RunwayPanels.tsx` `AirportSettings`、`PropertiesPanel.tsx`（誘導路）、`MapRenderer.ts`（論理ネットワーク表示: 区切りの印と「機数 / 進入可能機数」）、`View3D.tsx`（区間ごとの線の色） | `tests/unit/operations.test.ts` に追加（範囲外・NO_CHANGE・既定でキーを書かない）。E2E: 設定の切替、区間の表示、運航中は無効 | 左のとおり |
| 2-08 | `capacity.ts`（誘導路の行。block のときだけ値を出し、従来は `uncomputed` のまま） | `taxiwayCapacity.test.ts`: 能力 = `min(cap[M] × 3600 / 通過時間, 3600 × taxiSpeed / BLOCK_REQ_M[M])`（回/時、区間の最小）。飽和シナリオの実績との比を記録（目標 0.8〜1.2。外れたら記録して式を見直す） | 左のとおり |
| 2-09 | — | `taxiBlocks.perf.test.ts`: 同じ配置・同じ 30 機で従来と block の 1 ティックの時間（中央値、5 回）を比べ ≤ 1.5 倍。1 日スキップも同じ。値は出力に記録（`holdshort-perf.test.ts` の方式） | 閾値を超えたら失敗 |
| 2-10 | `project.ts` `checkSim`（`taxiBlocks` の検証）・`formatVersionOf` | `taxiBlocks.save.test.ts`: 3 時点（列あり・横断中・規則 4 の優先中）で保存 → 復元 → 継続が連続実行と JSON で一致、`occ` の順・`locks`・`oppWait` が保たれる。異常: 存在しない区間 ID、終端状態の機体、逆向きの holders、機数超過 → 読み込みエラー。`legacyFingerprint.test.ts`（§5.3）とゴールデン一式 | ゴールデン一致・往復一致 |
| 2-11 | `city.ts`（`cityOperatingHours`・`isCityNightOps`・`departureCutoffIssue`）、`planning.ts`、`ManagementPanels.tsx`（最終出発時刻の入力） | `departureCutoff.test.ts`: 3 種類の都市 × 3 シードで出発予定 ≤ 最終出発時刻、`nightOps` なしは計画が完全一致、範囲外の値は拒否、収まらない契約は `OUTSIDE_HOURS` | 左のとおり |
| 2-12 | `nightOps.ts`、`stepAircraft`（`turnaround`）・`stepReadyForPushback`、`ground.ts` `cancelPushbackTask` | `nightStandHold.test.ts`: `d_curfew` の配置で 3 日 × 3 シード。夜間に `taxiOut`/`holdShort`/`pushback` の機体 0、`nightStranded` 0、翌朝 06:00:00 以降に全便が離陸し間隔 ≥ `SEPARATION_SEC`、待機中はスポットだけを持ちトーイングカーを持たない、朝の到着のダイバート 0。境界: 予測がちょうど 21:59:59 / 22:00:00。full と block の両方で実行 | 左のとおり |
| 2-13 | `stepAircraft`（`scheduled`）・`stepInbound`（1-12 と同じ関数） | `nightInbound.test.ts`: 到着の遅れを最大にした 3 日で上空の夜間待機 ≤ `airborneHoldMaxMin`、出発地待機・ダイバートの数が `nightHold` と日報に一致 | 左のとおり |
| 2-14 | `nightOps.ts` `nominalOutSec`、`ops.ts` `settleDay`、`review.ts`、docs/36 | `takeoffDelay.test.ts`: 8 時間待った便の離陸の遅れ ≥ 480 分、日報の `lastDepartureDelayMin` が便の記録と一致、既存の出発遅延の値は変わらない | 左のとおり |
| 2-15 | `nightOps.ts` `nightRiskFlights`、`runwayControl` の並び、`alerts.ts` | `nightWarning.test.ts`: 警告の発生条件（境界 20 分）、`prioritizeAtRisk` false で順序が従来と一致、true のときだけ変わる | 左のとおり |
| 2-16 | docs/11（§7 区間・§8 理由）、docs/10 F-01、docs/31（夜間）、docs/33（誘導路の能力）、docs/36（離陸の遅れ）、docs/40・41（状態を「実装済み」と既定値）、docs/03・21（項目と版） | リンク・項目名・既定値が実装と一致することを目視とテスト名で確認 | 各文書が実装と一致 |

---

## 5. 作業の分割

### 5.1 ファイルの持ち主

| 担当 | 持つファイル |
|---|---|
| **A（コア: 運航）** | `src/core/sim/**`（`simulation.ts`・`routes.ts`・`pathfinding.ts`・`context.ts`・`types.ts`・`rules.ts`・`invariants.ts`・`ground.ts`・新 `taxiBlocks.ts`・`blockControl.ts`・`nightOps.ts`）、`tests/unit/sim/**` |
| **B（データ・経済・画面・文書）** | `src/core/model/types.ts`、`src/core/layout/operations.ts`、`src/core/io/**`、`src/core/economy/**`、`src/core/analytics/**`、`src/ui/**`、`src/render/**`、`src/i18n/**`、`docs/**`、`tests/unit/*.test.ts`（sim 以外）、`tests/e2e/**` |

A は B のファイルの関数を呼ぶだけ（`isCityNightMovement` など）。B は A の公開関数（`buildTaxiBlocks`・`nominalOutSec`・`nightRiskFlights`・`taxiwayCapacityPerHour`）を使う。

### 5.2 順序（規模 S/M/L、各タスクの後のテスト）

各タスクの後に必ず: `npm run typecheck` と下の対象テスト、`npx vitest run tests/unit/sim/legacyFingerprint.test.ts`。

| # | 担当 | 内容 | 規模 | 依存 | テスト |
|---|---|---|---|---|---|
| T0 | A+B（1 コミット） | 型だけ先に入れる: §1.1 の項目、§1.4 の型・`HoldReason`・`Flight.nightHold`、§1.5 の型、`ja.ts` の文言。ふるまいは変えない | S | フェーズ 1 合流 | `npm run typecheck`、`npm test` |
| T1 | A | `legacyFingerprint.test.ts`: §5.3 の基準値を T0 の状態で採取して固定 | S | T0 | 同ファイル |
| T2 | B | 設定の操作・検証・保存（`updateLayoutSettings`・`checkTaxiFields`・`isCityNightOps`・`formatVersionOf` の 4（承認後）。承認前は判定関数だけ入れて版は書かない） | S | T0 | `npx vitest run tests/unit/operations.test.ts tests/unit/project.test.ts tests/unit/projectFormat2.test.ts tests/unit/golden.io.test.ts` |
| T3 | A | 区間の分割・進入可能機数（2-01・2-02） | M | T0 | `npx vitest run tests/unit/sim/taxiBlocks.partition.test.ts tests/unit/sim/taxiBlocks.capacity.test.ts` |
| T4 | B | 出発時刻の制限の計画側（2-11） | M | T0 | `npx vitest run tests/unit/departureCutoff.test.ts tests/unit/economy.test.ts tests/unit/gameModels.test.ts` |
| T5 | A | 走行の本体: 確保・追従・解放・出発・列・横断・到着（2-03・2-05）、不変条件 B1〜B6 | L | T3 | `npx vitest run tests/unit/sim/taxiBlocks.run.test.ts tests/unit/sim/taxiBlocks.arrival.test.ts tests/unit/sim/invariants.test.ts tests/unit/sim/crossing.test.ts tests/unit/sim/crossing.chain.test.ts` |
| T6 | B | 能力ダッシュボードの誘導路（2-08。T3 の純粋関数だけを使う） | S | T3 | `npx vitest run tests/unit/taxiwayCapacity.test.ts tests/unit/capacity.test.ts` |
| **CP1** | A+B | 型と保存の形の確定。block の途中状態の保存 → 復元 | — | T2・T5 | `npx vitest run tests/unit/sim/taxiBlocks.save.test.ts`、`npm run lint`、`npx vitest run -c vitest.audit.config.ts` |
| T7 | A | 規則 1〜4・経路の選び直し・公平性（2-04） | M〜L | T5 | `npx vitest run tests/unit/sim/taxiBlocks.deadlock.test.ts --testTimeout=300000` |
| T8 | A | 夜間: 予測・スポット待機・出発地待機・上空の上限・朝の順（2-12・2-13）、警告と優先のコア（2-15） | M | T0（block とは独立） | `npx vitest run tests/unit/sim/nightStandHold.test.ts tests/unit/sim/nightInbound.test.ts tests/unit/sim/nightWarning.test.ts tests/unit/regression/s_curfewTakeoff.test.ts tests/unit/regression/s_curfewDivert.test.ts`、`npx vitest run -c vitest.audit.config.ts tests/audit/d_curfew.audit.test.ts` |
| T9 | B | 保存の検証（`checkSim` の `taxiBlocks`・`nightHold`）と往復テスト | S | CP1 | `npx vitest run tests/unit/project.test.ts tests/unit/sim/gameSave.test.ts` |
| T10 | B | 指標・日報・振り返り（2-14）、警告の表示（2-15 の画面） | M | T8 | `npx vitest run tests/unit/takeoffDelay.test.ts tests/unit/review.test.ts tests/unit/analytics.test.ts` |
| T11 | B | 画面: 設定・誘導路の上書き・理由の文言・運航表（2-06・2-07 の画面） | M | T2・T5 | `npx playwright test tests/e2e/taxiBlocks.spec.ts tests/e2e/nightOps.spec.ts --trace off` |
| T12 | B | 2D・3D の区間表示（2-07） | M | T5 | 同上 + `npx playwright test tests/e2e/opslayout.spec.ts --trace off` |
| T13 | A | 性能の計測（2-09）。超えたら `routeBlocks` のキャッシュ・要求の絞り込みを直す | S〜M | T7 | `npx vitest run tests/unit/sim/taxiBlocks.perf.test.ts` |
| **CP2** | A+B | 受け入れ一式（2-03・2-04・2-12 の数値を記録） | — | T7〜T13 | §5.4 |
| T14 | B | 文書（2-16）。版の承認結果を docs/21・22・23 に反映 | S | CP2 | リンク・項目の確認 |
| **CP3** | A+B | 品質ゲート | — | 全部 | `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run test:e2e`、`npx vitest run -c vitest.audit.config.ts` |

並行: T2・T4 は B、T3・T5 は A で、T0 の後に同時に進められる。T8（夜間）は block と独立なので、T5 と並行で A の別コミットにしてよい（ただし同じ `simulation.ts` なので A が順に入れる）。

### 5.3 途中のコミットで従来方式が変わらないことの証明

- `tests/unit/sim/legacyFingerprint.test.ts`（新規、T1）: `taxiMode`・`nightOps` を持たない次の運航を決まった時間だけ回し、最終の `SimState` と `company` の JSON の SHA-256 を T0 の時点の値と比べる: `linearLayout` 入口 1 つ・4 機（d1a）、入口 2 つ（d1b）、ストレス 30 機 2 時間、`crossingAirport`、`citySim`（都市 core・3 日、`nightOps` なし）、サンプル空港の 1 日。あわせて `taxiMode` を明示的に `'full'` にして `updateLayoutSettings` を通したレイアウトがキーなしと同じバイト列になること。
- 既存: ゴールデン一式（`tests/unit/golden*.test.ts`）、監査 `d_taxi_partial`・`d_curfew`・`a_runway_ops`・`a_movement`。
- この基準値は「フェーズ 2 の作業中に従来方式を変えていない」ことの証明専用。フェーズ 1 の §5 第 3 段階が終わってから採取する。

### 5.4 統合の確認（CP2 で記録する値）

離陸の間隔（中央値・最大）と滑走路手前の最大の列、対向 25 通りの待ちの最大、規則 4 の回数（`resolutions`・`overruns`・`unresolved`）、夜間に誘導路にいた機体数、持ち越し便数（docs/40 §6-2 の比較: 現状 1 日 0〜3 便）、1 ティックの時間の比。値は `[phase2]` の行でテスト出力に出し、docs/41・40 の実装の記録に転記する。

---

## 6. 計算の重さ（G4）

- 毎ティック: 走行中の機体ごとに O(1) の追従の上限と、停止位置に近い機体だけ O(チェーン長) の確保の試行。機体どうしの総当たりなし（既存の `detectConflicts` は従来どおり）。
- 5 秒ごと: 規則 4 の閉路探索（待機機だけ）。60 秒ごと: 待機機の経路の選び直し（1 機 1 回）。
- 配置の解析時 1 回: 区間の分割（O(ノード + エッジ)）。経路 → 区間の対応は経路ごとに 1 回（キャッシュ）。
- 夜間の予測: 便ごとに判定点 2 回。最短経路はスポットごとにキャッシュ。

---

## 7. リスクと対策

| # | リスク | 対策 |
|---|---|---|
| 1 | 規則 1〜3 で防げない閉路: 格子状の誘導路で交差する流れが全区間を満杯にする環。複数の滑走路の連続横断で向こう側が満杯 | 横断はチェーンを確保できるまで手前で待つ（滑走路上で止まらない）。環は規則 4 で検出・解消・回数を記録。ストレス・ランダム配置で `resolutions > 0` なら「環への流入の制限」（配置の解析で閉路を含む回廊の集合を求め、そこへの流入を総枠 − L 1 機分までにする）を追加する |
| 2 | 経路全体の向きの確保で、逆向きの流れが多い配置（入口と出口が同じ 1 本）では従来と同じく直列になる | 同じ向きの追従と列ができる分だけ従来より良い。公平性（120 秒）で飢餓を防ぐ。対向 25 通りで待ちの最大を記録し、従来（最大 115 / 200 秒）より悪化しないことを確認 |
| 3 | 性能（30 機で 1.5 倍以内） | §6。キャッシュと要求の絞り込み。T13 で超えたら CP2 の前に直す |
| 4 | 保存の互換: 旧アプリが block の途中状態を読み違える | 版 4（§1.6、承認が必要）。承認されない場合は、block のプロジェクトを運航中に保存できないようにする（建設モードの保存だけ許す）案を代わりに出す |
| 5 | フェーズ 1 との衝突: `setHold`・`stepInbound`（1-12）、`departureBlocked`・`takeoffRollSec`（1-13）、`assignStand`・`checkSim`（1-14）を同じく触る | フェーズ 1 の合流後に着手（前提）。1-13 の予測は値を変えずに `nightOps.ts` へ移し、`s_curfewTakeoff` で守る |
| 6 | 交差点の角で機首点どうしの距離が 20 m を切る（`detectConflicts`） | `JUNCTION_STOP_M` = 45。B4 と既存の C1 で検査。足りなければ値を上げる（区間の使える長さが減るだけ） |
| 7 | 夜間のスポット待機で、旅客（最後の判定で止めた便は機内のまま）・手荷物・地上作業の状態が一晩続く。docs/39 §11.5 で未検証の領域 | 早い判定で大半を搭乗前に止める。最後の判定で止めた便の数を記録し、テストで旅客・手荷物の不変条件（`checkPaxInvariants`・`checkGroundInvariants`）を夜間も検査する |
| 8 | 持ち越し機がスポットを持つため、朝のスポットが足りない | 出発地待機の到着は 06:00 以降。朝の到着のダイバート 0 をテストで確認。足りなければ計画の分析に「持ち越し機のスポット」を入れる（フェーズ 4 の夜間滞泊 4-02 と共通化） |
| 9 | バス・GSE 車両との干渉 | **干渉しない**: ランプバス・地上支援の車両は誘導路のネットワークを使わず、`ground.ts` `travelSec` の直線距離で動く（`apronBus.ts` はスポットのノード位置だけを参照）。区間の占有には入れない。将来、車両を誘導路で走らせる場合（docs/34 の後続）は別に扱う |
| 10 | 運航中の閉鎖・ゴーアラウンド・ダイバート・スポット変更で占有が残る | §2.7 の解放の呼び出しを 1 か所の関数に集め、B6 と既存の T0 で検査。`d_taxi_partial` の d1f（閉鎖）と同じ手順を block で実行するテストを 2-03 に含める |

---

## 8. 既定で決めた事項（docs/41 §1.7・docs/40 §8 の残り）

1. **区切りの長さ**: 既定 10 タイル（250 m）、範囲 4〜40。docs/41 の案（8〜12）の中央。4 未満は L 機が止まれない区間ばかりになる。
2. **必要長**: S 70 m・M 90 m・L 120 m、追従の間隔 40 m、交差点の手前 45 m（§1.2）。大きさが混ざるときは必要長の合計で判定（「L は 2 枠」のような固定の換算はしない）。
3. **誘導路ごとの上書き**: 進入可能機数の上限（1〜10）だけ。増やす方向は許さない（間隔の保証を崩さない）。建設費・維持費への影響なし。
4. **新規ゲームの既定**: 区間の方式は選択式のまま（既定は従来方式）。CP2 の数値を見て次のフェーズで既定化を判断する。
5. **向きの確保の範囲**: 経路全体（docs/41 規則 1 より広い。§2.4 の理由）。到着は進入許可の時点で向きを確保し、枠は出口の先だけ。
6. **余裕時間**: 45 分（最終出発 21:15）、範囲 15〜120 分（docs/40 R1・R2 の案どおり）。
7. **止めた出発便の扱い**: (a) 翌朝まで駐機して出発（K-3）。便ごとの選択・特例離陸はフェーズ 2 では作らない。
8. **夜間にかかる到着**: (a) 出発地で待機（§3.3）。上空の夜間待機の上限 30 分、超えたらダイバート。
9. **手動の便**: 最終出発時刻を過ぎる場合は警告だけ（禁止しない）。運航では R8 のとおりスポットで待つ。
10. **既存データ・指標**: 都市設定のある既存データには `nightOps` を入れない（新規ゲームだけ既定で有効）。離陸の遅れは既存の指標と別に並べ、評価・補償の重み（R16）と優先の方針の自動化（R12）は既定なし・次のフェーズで決める。
