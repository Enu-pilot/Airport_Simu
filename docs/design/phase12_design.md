# Phase 12 設計書 — 自由方位・実寸・複数・交差滑走路

基準: ブランチ `claude/phase12-runway-design`（Phase 11 = 1397e56 の上）。本書は設計のみ（リポジトリは変更していない）。
前提資料: docs/22（Phase 11）、phase11/design.md §C・§H（PO 回答 Q1〜Q5）、phase11/review_s0_s13.md、docs/10 §L、
research/runway_reference.md（参考値の出典表。以下「参考資料」）。

## 0. 要約（決定事項）

| # | 決定 |
|---|---|
| D1 | `Runway = RunwayGrid8 \| RunwayFree`（判別子 `alignment`）。従来形はデータも意味も永久に不変。**実寸 `dims` は自由形にだけ持たせる**（Phase 11 計画 §C.1 からの意図的な変更。理由: 「従来形 + dims」という第 3 の判定基準を作らない。実寸判定に切り替えたい従来形は「自由形に変換」という明示操作で行う） |
| D2 | 自由形は `start: WorldPoint`・`headingDeg`（真方位）・`lengthM`（**丸めない実数**）を正とする。終点は保存しない。番号は保存した方位から決まる |
| D3 | 新しい判定（実寸の多角形・交差滑走路・平行間隔・番号の重複）は **自由形が関与するときだけ**（または空港の `ruleSet: 'realistic'` のときだけ）動く。従来形だけのレイアウトでは、すべての新しいコード経路が空ループになる |
| D4 | `SCHEMA_VERSION` 2 → 3。v2 → v3 の移行は **何も書き換えない**（`layout.schemaVersion` も書き換えない。§B.1）。`PROJECT_FORMAT_VERSION`・`SIM_MODEL_VERSION`・`CATALOG_VERSION` は上げない |
| D5 | 交差滑走路は、自由形が関与する組に限り **論理ノード（交差点）** をネットワークに作り、運航では「従属（dependent）」モードを既定として **離着陸の同時使用を禁止** する。従来形同士の交差は従来どおり `OVERLAP` エラー（結果不変） |
| D6 | 自由形の占有・検証は実寸の多角形（舗装 + 肩、着陸帯、RESA）で、多角形どうしの重なり判定（整数ラスタではない）を使う。従来形は従来のラスタ判定のまま |
| D7 | 停止位置: 従来形は `HOLD_SHORT_M = 87.5` の既存式のまま。自由形は `dims.holdingPositionM`（ゲーム既定値は参考資料 Table D-2 から採用）を滑走路中心線からの垂直距離として扱う |
| D8 | 表示のみの変更（Q3: 従来形の舗装を実寸幅で描く、従来形の平行滑走路への L/R の自動表示）は独立コミットにする |

---

## A. データモデル

### A.1 型（`src/core/model/types.ts`）

```ts
export type RunwaySuffix = 'L' | 'C' | 'R' | 'none';   // 'none' = 明示的に付けない。欠落 = 自動

interface RunwayBase {
  id: string;
  name: string;
  surfaceWidthM: 30 | 45 | 60;        // 従来どおり。機体区分（RUNWAY_WIDTH_CLASS）も従来どおり
  buildState: BuildState;
  /** 始点側の番号の接尾辞の上書き（表示のみ。終点側は L↔R を入れ替える）。欠落 = 自動 */
  designatorSuffix?: RunwaySuffix;
}

/** 従来形（v1/v2 のデータはすべてこれ）。意味は永久に不変 */
export interface RunwayGrid8 extends RunwayBase {
  alignment?: undefined;
  start: Tile;
  heading: Heading;
  length: number;                      // ステップ数（斜めは 1 ステップ = √2 タイル）
}

/** 自由方位・実寸（Phase 12〜） */
export interface RunwayFree extends RunwayBase {
  alignment: 'free';
  start: WorldPoint;                   // 実数可（World フレーム、タイル単位）
  headingDeg: number;                  // 真方位 [0, 360)。保存時に normalizeDeg 済み
  lengthM: number;                     // 実長（m）。正の有限の実数。丸めない（D2）
  dims?: RunwayDims;                   // 欠落した項目はゲーム既定値（A.3）
}

export type Runway = RunwayGrid8 | RunwayFree;
export const isFreeRunway = (r: Runway): r is RunwayFree => r.alignment === 'free';

/** 自由形の実寸（すべて m。欠落 = ゲーム既定値） */
export interface RunwayDims {
  shoulderWidthM?: number;     // 片側の肩の幅
  stripHalfWidthM?: number;    // 着陸帯の半幅（中心線から）
  stripEndM?: number;          // 着陸帯の端部延長（滑走路端から）
  resaLengthM?: number;        // RESA の長さ（着陸帯の端から外側へ。0 = なし）
  resaWidthM?: number;         // RESA の全幅
  holdingPositionM?: number;   // 停止位置（中心線からの垂直距離）
  elevationStartM?: number;    // 始点・終点の標高（表示・勾配の計算のみ。Phase 12 は 3D に反映しない）
  elevationEndM?: number;
}

export interface AirportLayout {
  …既存…
  /** 磁気偏角（度、東偏差を正、[-180, 180]）。欠落 = 0（Q4: 手入力のみ） */
  magneticVariationDeg?: number;
  /** 判定ルール（Q2）。欠落 = 'classic' */
  ruleSet?: 'classic' | 'realistic';
}
```

- 単位: 位置はタイル（World）、長さ・幅は m（docs/22 §1 の規約）。`lengthM` は m だが **終点は `start + bearingToDir(headingDeg) × (lengthM / TILE_M)`** で求める（m を位置に使わない規約に反しない。位置はタイルで足す）。
- `NetNode.pos` は型を `WorldPoint` に広げる（構造は同じ `{x, y}`。従来データは整数のまま）。自由形の滑走路と誘導路の交点だけが実数の位置を持つ（C.3）。
- 自由形のときだけ書かれる項目（`alignment`・`headingDeg`・`lengthM`・`dims`）と、設定したときだけ書かれる項目（`designatorSuffix`・`magneticVariationDeg`・`ruleSet`）は **既定値をキーとして書かない**。そのため従来データは JSON のバイト列まで不変（`normalized-hashes` が不変の根拠）。

### A.2 アクセサ（`layout/runway.ts`）— すべての呼び出し元をここに寄せる

| 関数 | 従来形 | 自由形 |
|---|---|---|
| `runwayAxis(r)` | **現行コードのまま**（変更しない） | `dir = bearingToDir(headingDeg)`、`lengthT = lengthM / TILE_M`、`end = start + dir × lengthT`、`trueHeadingDeg = headingDeg`、`lengthM = r.lengthM` |
| `runwayEnd(r)` | 現行 | `runwayAxis(r).end` |
| `runwayLengthM(r)` | 現行（四捨五入） | `Math.round(r.lengthM)`（区分の判定と表示用） |
| `runwayLengthClass` / `runwayMaxSize` | 現行 | 同じ式に `runwayLengthM` を通す |
| `runwayPolygon` / `runwayStripPolygon` | 現行（占有の多角形。ゲーム値） | 使わない（自由形は `runwayAreas(r)`。D6） |
| `positionOnRunway(r, p)` | 現行（`pointOnSegmentInterior` と端の `sameTile`） | 中心線への射影 `t`、中心線からの距離 ≤ `POS_EPS_T`、端は距離 ≤ `POS_EPS_T` で 0/1 |
| `runwayDesignators(heading)` | **残す**（ゴールデンとテストが使う） | — |
| `designatorsOf(r, layout)`（新） | 偏差 0・接尾辞なしなら `runwayDesignators(heading)` と一致 | A.4 |

- 判別共用体にすると `r.heading` / `r.length` の直接参照はコンパイルエラーになる（docs/10 L7 の一覧: operations・expansion・construction・PropertiesPanel・OpsPanels・MapRenderer・tools・Scene3D）。**型ガード `isFreeRunway` で分岐し、従来形側の式は 1 文字も変えない**（演算順の保存。docs/22 R1）。
- `Pick<Runway, 'heading' | 'length'>` 型の引数は `Runway` に変える（従来形の中身は不変）。

### A.3 実寸の既定値と参考値（`model/runwayReference.ts`、新規）

2 つの表を分ける。**参考値の表**は出典つきで値を持つだけで、判定には使わない。**ゲーム既定値の表**は判定と描画に使い、各項目に「どの参考値から採ったか」を `note` で書く。
UI と docs には定型文「参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません」を必ず添える（docs/22 §6.1、R13）。

```ts
export const RUNWAY_REF_SOURCES = { 'faa-ac-150-5300-13b-chg1': …, 'faa-aim-2-3-3': …, 'easa-cs-adr-dsn-i5': … }; // DataSource 形式、accessed 2026-11-11
export const RUNWAY_REFERENCE: Record<string, Sourced<number>> = { … };   // status 'official'、source と note つき
export const FREE_RUNWAY_DEFAULTS: Record<30 | 45 | 60, Required<Omit<RunwayDims, 'elevationStartM' | 'elevationEndM'>>>; // ゲーム値
```

ゲーム既定値（すべて **ゲーム値**。右欄は採用元の参考値で、値は参考資料からの転記）:

| 項目 | 30 m | 45 m | 60 m | 採用元の参考値（参考資料の節） |
|---|---|---|---|---|
| 肩（片側） | 0 | 7.5 | 7.5 | EASA CS B.125(b): 肩が必要なのはコード文字 D/E/F。B.135(a)(b): 肩を含む全幅 60 m → 45 m 幅なら片側 7.5 m。60 m 幅は全幅 75 m（B.135(c)、4 発の F）で片側 7.5 m |
| 着陸帯の半幅 | 140 | 140 | 140 | EASA CS B.160(a)(b): 精密・非精密進入、コード番号 3〜4 は 140 m（§4b） |
| 着陸帯の端部延長 | 60 | 60 | 60 | EASA CS B.155: 60 m（§4b） |
| RESA 長さ | 90 | 90 | 90 | EASA CS C.215(a): 最小 90 m（可能な限り 240 m）（§4b） |
| RESA 全幅 | 60 | 90 | 120 | EASA CS C.215(c): 滑走路幅の 2 倍以上（最小値を採用）（§4b） |
| 停止位置 | 90 | 90 | 107.5 | EASA Table D-2: 精密進入 CAT I、コード 3〜4 は 90 m、コード文字 F は 107.5 m（§7b） |

- 30 m 幅をコード番号 3 とみなすのは **ゲームの仮定**（EASA Table B-1 ではコード 3 の 30 m 幅がある。§2b）。60 m 幅は参考資料にコード文字ごとの幅の表が無い（§8 NOT FOUND）ため、**60 m という幅自体がゲーム値** であることを UI に表示する。
- 勾配・標高の参考値は参考資料に無いので、Phase 12 では勾配の警告を作らず、表示（`(elevationEnd − elevationStart) / lengthM`、%）だけにする。
- FAA の値（RSA など、§4a）は参考値の表にだけ載せ、既定値には使わない（ICAO 系の EASA に統一）。プロパティ欄に「参考: FAA RSA …」を表示するのは任意。

### A.4 滑走路番号（`layout/designators.ts`、新規）

- 磁方位: `mag = magneticFromTrue(trueHeadingDeg, layout.magneticVariationDeg ?? 0)`（Phase 11 の関数。東偏差が正）。真方位と磁方位は型とラベルで常に区別する（`trueHeadingDeg` / `magHeadingDeg`）。
- 番号: `n0 = designatorNumber(mag)`。**逆向きの番号は `n1 = ((n0 + 17) % 36) + 1`**（必ず 18 差。`designatorNumber(mag + 180)` を別に計算すると、0.5 の境界で浮動小数点の差により 18 差が崩れる余地があるため使わない）。
  0.5 の丸め（切り上げ）と 0 → 36 は参考資料で確認できなかった（§8 NOT FOUND）ので、**ゲームの規則** として docs に書く（既存の `runwayDesignators` と一致させるため）。
- 接尾辞（参考: FAA AIM 2-3-3、EASA L.525。§1）: 同じ番号 `n0` を持つ滑走路をグループにし、**始点側から進入方向を見たときの左右**（`dir` に対する横方向のずれ `cross(dir, p − p0)`。World は y が下向きなので、符号は単体テストで固定する）で並べる。
  2 本 → L, R。3 本 → L, C, R。4 本以上 → 自動では付けず `RUNWAY_DESIGNATOR_CONFLICT`（参考資料では 4〜6 本は番号をずらす規則。ゲームでは手動の `designatorSuffix` で対応）。
  終点側は同じグループを逆向きに見るので L ↔ R が入れ替わる（C はそのまま）。手動の上書き `designatorSuffix` は自動より優先。
- 返り値: `{ trueDeg: [number, number], magDeg: [number, number], numbers: [n0, n1], suffix: [s0, s1], text: ['09L', '27R'] }`。
- 従来形にも同じ関数を使う（表示）。偏差 0・平行なしなら `runwayDesignators(heading)` と完全一致（テストで全 8 方位を確認）。
  **従来形の平行滑走路に L/R が自動で付くのは表示の変更**（ストレスレイアウトの 2 本が「09/27」から「09L/27R」「09R/27L」になる）なので、D8 の表示コミットに含め、PO に確認する（Q-A）。

### A.5 作成・編集の API（`layout/operations.ts`）

```ts
placeFreeRunway(layout, { start: WorldPoint, headingDeg, lengthM }, opts: PlaceRunwayOptions & { dims?, designatorSuffix? }): OpResult
placeFreeRunwayByEnds(layout, a: WorldPoint, b: WorldPoint, opts): OpResult      // headingDeg = dirToBearing(b − a)、lengthM = distance(a, b) × TILE_M
setFreeRunwayGeometry(layout, id, patch: { headingDeg?, lengthM?, start?, end? }, pivot: 'mid' | 'start' | 'end'): OpResult
convertRunwayToFree(layout, id): OpResult                                           // 明示操作（A.6）
snapRunwayToGrid(layout, id): OpResult                                              // 自由形 → 従来形（A.6）
updateLayoutSettings(layout, { magneticVariationDeg?, ruleSet? }): OpResult
```

- 検証: `headingDeg` は有限（保存前に `normalizeDeg`）、`lengthM` は有限で `[FREE_RUNWAY_MIN_M, FREE_RUNWAY_MAX_M]`（ゲーム値: 25 m 〜 `MAX_RUNWAY_LENGTH × 25 × √2`。従来形の最大と同じ範囲）、`start` の成分は有限、`dims` の各値は有限で ≥ 0。違反は `INVALID_VALUE`。
- 中点まわりの回転（`pivot: 'mid'`）: `mid = start + dir × lengthT / 2`、`start' = mid − dir' × lengthT / 2`。中点は毎回計算し直すので、誤差は 1 回あたり 1e-15 タイル程度（テストで 360 回の 1° 回転後に元へ `POS_EPS_T` 以内で戻ることを確認）。
- 既存の操作の分岐:
  - `moveEntity`: 自由形も `start += delta`（delta は整数タイル。将来の実数 delta も型上は可）。
  - `rotateEntity(layout, id, stepDeg = 15)`: 従来形は **現行の +45°**（引数を無視）、自由形は中点まわりに `+stepDeg`。
  - `duplicateEntity` / `defaultDuplicateOffset`: 従来形は現行。自由形は `bearingToDir(headingDeg + 90) × 12` を整数に丸めた横ずれ。
  - `updateEntity`（runway）: 従来形は現行の検証表のまま。自由形は `name`・`surfaceWidthM`・`buildState`・`designatorSuffix`・`dims`・`headingDeg`（中点を保つ）・`lengthM`（中点を保つ）を受け付ける。`heading` / `length` を自由形に渡したら `INVALID_VALUE`。

### A.6 従来形 ↔ 自由形の変換（プレイヤーの明示操作のみ）

- **従来形 → 自由形**（`convertRunwayToFree`）: `start` はそのまま、`headingDeg = heading`、`lengthM = runwayAxis(r).lengthT × TILE_M`（**丸めない**。斜めは n√2·25）、`dims` は書かない（既定値）、ID・名前・幅・建設状態・接尾辞を保つ。
  - 終点は従来の整数の終点と 1e-15 タイル程度の差（`√2·√½ = 1.0000000000000002`）なので、`POS_EPS_T` の判定で既存の誘導路ノード（入口・端）はそのまま滑走路上と認識される（テストで 8 方位 × 長さ数通りを確認）。
  - 変わるもの（確認ダイアログに列挙）: 占有と検証が実寸に切り替わる（着陸帯の半幅 87.5 m → 140 m など。周囲の施設が `IN_RUNWAY_STRIP` になりうる）、停止位置 87.5 m → 90/107.5 m（運航が変わる）、ほかの滑走路との交差・平行間隔の判定の対象になる。元に戻すには Undo を使う。
  - 建設費: 改修として扱わない（H.2）。
- **自由形 → 従来形**（`snapRunwayToGrid`。UI 名「グリッドに合わせる」）: 方位を 45° の倍数に、始点を整数に、長さをステップ数に丸めて従来形を作る。`dims` は捨てる（ダイアログで警告）。丸めが恒等（方位が 45° の倍数・始点が整数・長さが整数ステップから `POS_EPS_T` 以内）なら位置は変わらない。自動変換はしない（docs/22 §6.1）。

---

## B. 版・移行・保存時の検証

### B.1 `SCHEMA_VERSION` 3 と移行（`io/migrate.ts`）

- `SCHEMA_VERSION = 3`。v3 で増えるのは任意項目だけ（A.1）なので、v2 のデータはそのまま妥当な v3 である。
- `migrateLayout(raw, fromVersion)`: **v2 → v3 は何もしない**（関数に「v2 → v3: 任意項目の追加のみ。書き換えなし」の段とコメントを追加するだけ）。
  - `layout.schemaVersion` を 3 に書き換えない理由: 既存のテスト（`migrate.test.ts` の「v1 → v2 で schemaVersion が 2」「v1 ファイルの読込結果が `v2Expected()`（schemaVersion 2）と一致」）の期待値を変えないため。v3 で必須の変換が無いので、`layout.schemaVersion` は「作成または最後に構造的な移行をした版」という意味になる。保存ファイルの外側の版（レイアウトファイルの `schemaVersion`、プロジェクトの `versions.layoutSchema`）は保存時に常に 3 になる。docs/21 にこの意味を書く。
  - 新規作成のレイアウトは `createLayout` が 3 を書く。
- Phase 13 の `TaxiwayEdge.geometry` も任意項目なので、同じ v3 に含める（docs/22 §7 の推奨案。Phase 13 で再度の版の更新は不要）。
- 旧アプリは v3 のレイアウトファイルを「未対応の版」として拒否する（既存処理）。**プロジェクトファイルは旧アプリが `versions.layoutSchema` を見ていない**ため、旧アプリで自由形入りの v3 プロジェクトを開くと壊れたまま読める。旧アプリは直せないので docs/21 に既知の制限として書く。Phase 12 以降のアプリには、`versions.layoutSchema > SCHEMA_VERSION` をエラーにする検査を追加する（今後の版のため）。

### B.2 `checkLayout` / `validateProject` の追加（`io/project.ts`）

追加するのは **新しい項目だけを対象とする検査** に限る（従来形の滑走路に新しい検査を足すと、今まで読めたファイルが読めなくなるため足さない）。

- `runway.alignment` が `undefined` / `'free'` 以外 → エラー「未対応の滑走路の形式です（新しいバージョンで作成された可能性）」。
- 自由形: `start.x/y` が有限、`headingDeg` が有限で [0, 360)、`lengthM` が有限で範囲内、`surfaceWidthM` ∈ {30, 45, 60}、`dims` の値が有限で ≥ 0、`designatorSuffix` ∈ {L, C, R, none}。
- 任意の滑走路の `designatorSuffix` の値の検査。`layout.magneticVariationDeg` が有限で [-180, 180]、`ruleSet` ∈ {classic, realistic}。
- 運航状態（`checkSim`）: `runwayCrossingModes` があれば、キーが現在のレイアウトの交差点に存在し、値が既知のモードであること（E.4）。`aircraft.crossing.alsoRunwayIds` の滑走路が存在すること。
- シナリオのレイアウトは `checkLayout` を通るので同じ検査が自動で掛かる。

### B.3 版の方針

| 版 | Phase 12 | 理由 |
|---|---|---|
| `SCHEMA_VERSION` | 2 → **3** | 自由形・偏差・ルール切替を保存するため |
| `PROJECT_FORMAT_VERSION` | 1 のまま | ファイル構造は変わらない |
| `CATALOG_VERSION` | 不変 | 機種データは変えない（滑走路の参考値はカタログ外の別表） |
| `ASSET_VERSION` | 不変 | — |
| `SIM_MODEL_VERSION` | **`skyport-sim-10.0` のまま** | 下記 |
| 運航状態の `state.version` | 1 のまま | 任意項目の追加のみ |

**`SIM_MODEL_VERSION` を上げなくてよい根拠**（「v2 で表現できるレイアウトの運航結果が 1 ビットも変わらない」ことの論証）:

1. ネットワーク: 従来形だけのレイアウトでは、`buildAirsideNetwork` の新しい処理（交差点ノード、自由形の中心線上のノード判定）は自由形が 1 本も無いので実行されない。既存のノード・エッジにキーを足さない（`intersection: false` のような常に付く項目を作らない）。
2. 停止位置: `holdShortDistanceAt(ctx, nodeId, edgeLenM)` は、ノードの滑走路がすべて従来形なら **既存の式 `Math.min(HOLD_SHORT_M, edgeLenM * HOLD_SHORT_MAX_RATIO)` をそのまま返す**。
3. 交差: `ctx.crossings` は自由形が関与する交差点からだけ作るので、従来形のレイアウトでは空。運航側の追加の判定はすべて `ctx.crossingsByRunway[rid] ?? []` のループなので、何もしない。複数の滑走路の同時予約は交差点ノードに限る（従来形の重なった滑走路のノードは従来どおり `runwayIds[0]` だけ）。
4. 状態: 新しい状態（`runwayCrossingModes`、`crossing.alsoRunwayIds`）は使うときだけキーを作る。従来形のレイアウトでは `JSON.stringify(state)` が同一になる（ゴールデンのハッシュの計算方法）。
5. 乱数・反復順: 新しい処理は乱数を使わず、反復は `compareIds` の順。
6. 機械的な確認: 運航ゴールデン 4 種（sim / sim-midrun / stress-sim / project-sim の正規化ハッシュ）と routes ゴールデンが全ステップで一致すること。一致しなければ D10 の保護でテストが失敗する。

### B.4 ゴールデンの 1 回だけの再採取（S1）

- 変わってよいもの: `geometry-{sample,starter,all-headings}.golden.json` の `exportLayoutSha256`、`project.golden.json`、`project-sim.golden.json` の `sha256`（`length` は "2" → "3" で同じ長さのはず）。
- **変わってはいけないもの**: `normalized-hashes.golden.json`、`project-sim.golden.json` の `normalizedSha256`、ほかのすべての項目・ファイル。
- D10 の保護の調整（`tests/golden/io.ts`）: `project-sim.golden.json` は運航ゴールデンなので、今のままでは版の更新だけでも再採取が拒否される。
  「変わったキーが版に敏感なキー（`sha256`・`length`・`exportLayoutSha256`）だけで、`normalizedSha256` が同じ」ときに限って再採取を許す。この例外は単体テストつきの **独立したコミット**（S1a）にする。
- 再採取の手順: `GOLDEN_UPDATE=1` のあと、`git diff tests/golden` に上記のキー以外の差分が無いことを、スクリプト（JSON を読み込み、許したキーを除いて比較する）で確認し、その出力をコミットメッセージに貼る。

---

## C. 幾何とネットワーク

### C.1 `runwayAxis` に寄せる

- core・render・ui の全箇所が `runwayAxis(r)` / `runwayEnd(r)` / `designatorsOf` を使う。描画で方向ベクトルが必要な箇所（MapRenderer:195, :541）は `axis.dir` を使う。従来形の `axis.dir` は現行の `v / |v|` と同じ演算なので値は変わらない。
- `headingVector(heading)` は従来形の内部と、`GRID8_STEP` を必要とする箇所でだけ使う。

### C.2 自由形の端点

- 始点は保存値、終点は `runwayAxis` で毎回計算した `WorldPoint`（実数）。
- 端のネットワークノード（`${id}:T0` / `${id}:T1`）は、端から `POS_EPS_T` 以内に誘導路ノードがあればそれを使い、無ければ実数の位置に作る（従来形は現行の `findNodeAt`（厳密一致）のまま）。

### C.3 誘導路 × 自由形の交点のノード（`layout/network.ts addPath` の 2c）

```ts
for (const r of sortedValues(d.runways)) {         // 反復順は現行の Object.values のまま（下の注）
  if (!isFreeRunway(r)) { /* 現行コードそのまま: segmentIntersection + isIntegerPoint + roundPoint */ continue; }
  // 自由形: 交点を実数のまま採用
  const c = classifySegmentIntersection(pa, pb, axis.start, axis.end);
  if (c.kind !== 'point') continue;               // overlap（中心線上を走る誘導路）は作らず、検証の TAXIWAY_ON_RUNWAY に任せる
  const near = findNodeNear(nodes, c.point, POS_EPS_T) ?? splits.find(s => distance(nodes[s.id].pos, c.point) <= POS_EPS_T)?.id;
  splits.push({ t: c.t1, id: near ?? ensureNodeAtW(d, net, c.point) });
}
```

- 注: 現行の 2c は `Object.values(d.runways)` を反復している。従来形の分岐は **反復と処理の順序を含めて変えない**（`sortedValues` に変えると ID の発行順が変わりうる）。
- 実数の位置のノードは `createNode` でそのまま保存する（JSON は往復厳密。docs/22 §3）。`ensureNodeAtW` は既存エッジの内部に乗っていれば分割する（`closestPointOnSegment` の距離 ≤ `POS_EPS_T`）。
- エディタは、誘導路の点を自由形の中心線に吸着させる補助を持つ（F.1）。これにより、端点を滑走路上に置く入口も実数の位置で作れる。
- 既存の「交点がタイル中心のときだけ交差点を作る」（誘導路どうし、2b）は変えない（docs/22 §6.2）。

### C.4 滑走路 × 滑走路の交差点ノード（`airside/network.ts`）

- 対象: 2 本の組で **少なくとも一方が自由形** のもの。中心線の線分の交差を `classifySegmentIntersection` で判定し、`point`（端点での T 字の接触を含む）なら交差点を作る。`overlap`（同一直線上の重なり）は作らず、検証でエラーにする。
- ID: `${a}:X:${b}`（`compareIds(a, b) < 0`）。種別は新しい `AirsideNodeKind 'runwayIntersection'`、`runwayIds: [a, b]`、`holdShort: false`。
  交点から `POS_EPS_T` 以内に誘導路ノードがあれば、新しいノードを作らずそのノードを使う（`runwayIds` に両方が入る。種別は `runwayEntry` のまま）。
- 両方の滑走路の `onLine` に交差点の `t` を加え、滑走路エッジは交差点で分割される（`lengthM` は既存の `round(distance × 25)`）。交差点には誘導路が接続しないので、`exitCandidates` / `entryCandidates` の対象にならない。
- 処理の位置: 現行の滑走路のループの **後** に、自由形がある場合だけ実行する独立した段（`addRunwayIntersections`）とし、`onLine` を作り直す（従来形だけなら呼ばない）。

### C.5 停止位置（`sim/routes.ts`）

```ts
export function holdShortDistance(edgeLengthM: number): number          // 現行のまま（従来形とゴールデンが使う）
export function holdShortDistanceAt(ctx, runwayNodeId, prevNodeId, edgeLengthM): number {
  const free = freeRunwaysOfNode(ctx, runwayNodeId);
  if (free.length === 0) return holdShortDistance(edgeLengthM);         // 従来形: 既存の式
  // 自由形: 中心線からの垂直距離 H を、誘導路エッジに沿った距離に直す
  const d = max over free r of H(r) / max(sin θ(edge, r), SIN_MIN);    // θ = 誘導路エッジと中心線のなす角
  return Math.min(d, edgeLengthM * HOLD_SHORT_MAX_RATIO);
}
```

- `H(r)` は `dims.holdingPositionM ?? FREE_RUNWAY_DEFAULTS[w].holdingPositionM`。`SIN_MIN = sin 15°`（ゲーム値。浅い角度で停止位置が遠くなりすぎるのを防ぐ。上限は従来どおりエッジ長の 0.6 倍）。
- 呼び出し元 5 か所（simulation.ts:774, :859, :1099, :1111, :1145）はすべて対象ノードの添字を持っているので、`holdShortDistanceAt` に置き換える。
- 2D の停止位置の線（MapRenderer:264）も、自由形のときは同じ関数（m → タイル）を使う。従来形の表示は現行の `STRIP_HALF_WIDTH` のまま。

---

## D. 検証（`validation/validate.ts`、`layout/footprint.ts`）

### D.1 自由形の領域（`layout/runwayAreas.ts`、新規）

```ts
runwayAreas(r: RunwayFree): {
  pavement: WorldPoint[];           // rectAlongDir(start, end, dir, (W/2)/25, 0)
  paved: WorldPoint[];              // 舗装 + 肩: 半幅 (W/2 + shoulder)/25、延長 0
  strip: WorldPoint[];              // 半幅 stripHalf/25、延長 stripEnd/25
  resa: WorldPoint[][];             // 着陸帯の両端から外へ resaLength、全幅 resaWidth（長さ 0 なら空）
}
```

- すべて凸の 4 角形（`satOverlapConvex` が使える）。World フレーム・タイル単位。描画（G）も同じ関数を使う。

### D.2 占有の表現（`FootprintPart` の拡張）

- `FootprintPart` に任意の `poly?: WorldPoint[]` を追加する。自由形は `paved`（layer `runway`）・`strip`（layer `strip`）・`resa`（新しい layer `resa`）の 3 種類の部分を返す。
  `tiles` には **四角形が多角形と内部で重なるタイル**（新しい `tilesOverlappingPolygon`、`raster.ts` に追加。既存の `rasterizePolygon` は変えない）を入れる。地形・敷地の判定、`entityTiles`、landside はこれを使う。
- `checkPlacement` の既存のラスタのループは **`poly` を持つ部分を `occ` に入れない**。そのため、従来形どうしの組み合わせの結果と順序は不変。
- 地形・敷地（`OUT_OF_BOUNDS` / `UNBUILDABLE_TERRAIN`）: 自由形の `runway` の部分には既存の処理をそのまま適用する（`tiles` を使う）。着陸帯と RESA は従来どおり対象外。

### D.3 多角形による重なりの判定（自由形が関与する組だけ。既存のループの後に追加）

各自由形の部分 P について、次の相手と判定する。

| 相手 | 方法 |
|---|---|
| 別の自由形の部分 | `satOverlapConvex(P.poly, Q.poly)`（境界の接触は重ならない） |
| 従来の（ラスタの）部分 | P の bbox と重なるタイルだけ、タイルの正方形（World で [x−½, x+½]²）と `satOverlapConvex` |

レイヤーの組の規則は既存の `COMPATIBLE` を再利用し、次の 3 つを加える。

- `resa` は `strip` と同じ扱い（`taxiway`・`strip`・`resa` と両立、ほかは `IN_RUNWAY_RESA`（新しいエラー））。
- 誘導路 × 自由形の舗装: その誘導路が滑走路に接している（`edgeTouchesRunway` の自由形の分岐: 端が中心線上 ±`POS_EPS_T`、または中心線と 1 点で交差）なら許す。
- **交差する滑走路の組**（C.4 で交差点がある組）: 2 本の間の `runway|runway`・`runway|strip`・`runway|resa` の組を免除する。同一直線上の重なりは `OVERLAP` のまま。中心線が交わらない舗装の重なりも `OVERLAP` のまま。

- 発行するコードは既存の `OVERLAP` / `IN_RUNWAY_STRIP` と新しい `IN_RUNWAY_RESA`。`at` は最初に重なったタイル、自由形どうしは重なりの bbox の中心を丸めたもの。
  自由形の issue だけに `params.criterion = 'real'` を付ける（Q5 の UI の区別。従来形の issue のキーは変えない）。
- 従来形どうしの交差は従来どおり `OVERLAP`（「交差点がある場合だけ交差を許す」の要件。従来形どうしには交差点を作らないため）。

### D.4 誘導路と自由形の関係（`checkAirside`）

`positionOnRunway` の自由形の分岐（A.2）によって、`TAXIWAY_ON_RUNWAY` はそのまま動く。`TAXIWAY_CROSSES_RUNWAY_NO_ENTRY` は、自由形では `classifySegmentIntersection` で内部の交差（端点が中心線上 ±`POS_EPS_T` の場合を除く）を判定する。従来形は現行の `segmentIntersection` のまま。

### D.5 新しい検証コード（自由形が関与するとき、または `ruleSet === 'realistic'` のときだけ評価）

| コード | 重大度 | 条件（すべてゲームの規則。括弧内は表示する参考値） |
|---|---|---|
| `IN_RUNWAY_RESA` | error | D.3 |
| `RUNWAY_PARALLEL_TOO_CLOSE` | warning | 方位差 ≤ 1°（ゲーム値）で、長さ方向に重なる 2 本の中心線間隔 < 210 m（EASA B.050: 非計器、同時使用、コード 3〜4）。`params: { distanceM, refM: 210 }` |
| `RUNWAY_PARALLEL_DEPENDENT` | info | 同じ条件で 210 m 以上 1035 m 未満（EASA B.055: 独立した平行進入は 1035 m、従属は 915 m、出発は 760 m。FAA 3.9.3 の値も表示）。「独立した計器運用の参考値未満」。**`ruleSet === 'realistic'` のときだけ** |
| `RUNWAY_DESIGNATOR_CONFLICT` | warning | 接尾辞まで含めた番号が 2 本以上で同じ（例: 手動の上書きの重複、4 本以上の平行） |
| `RUNWAY_SLOPE_INFO` | — | 作らない（参考値が無い。A.3） |

- 「関与」の定義: 組のうち少なくとも 1 本が自由形。`ruleSet` が `realistic` なら従来形どうしにも適用する（既定は `classic` なので、既存レイアウトの結果は不変。Q2 の切替を Phase 12 から意味のあるものにする）。
- 運用可否（`operability`）は既存の仕組み（error があると `HAS_ERRORS`）に任せる。

### D.6 混在空港（Q5）

判定基準は滑走路ごとに決まる（従来形 = ゲームの占有、自由形 = 実寸）。組の判定は「関与する自由形の多角形 × 相手の占有（相手が従来形ならゲームの占有）」になる。この非対称は仕様とし、UI で基準を表示する（F.3）。

---

## E. シミュレーション

### E.1 文脈（`sim/context.ts`）

```ts
interface RunwayCrossing { id: string /* 交差点ノード ID */; a: string; b: string; nodeId: string; distA: number; distB: number /* 各滑走路の始点からの距離 m */ }
ctx.crossings: RunwayCrossing[];                         // 自由形が関与する交差点のみ。従来形だけなら []
ctx.crossingsByRunway: Record<string, RunwayCrossing[]>;
```

### E.2 運用モード（交差点ごと）

```ts
export type CrossingMode = 'dependent' | 'intersection';
state.runwayCrossingModes?: Record<string, CrossingMode>;   // 変更したときだけ作る。欠落 = 'dependent'
```

**`dependent`（既定。2 本の離着陸を 1 本の滑走路とみなす）**

以下で、B は A と交差する滑走路を指す。

- A の離陸許可（`departureBlocked`）: 追加の条件として、B の占有が `landing` / `takeoff` なら `'intersection'`（新しい `HoldReason`、遅延の原因は `runwayQueue` に対応づける）。B に予約があり到着予定まで `DEPARTURE_WINDOW_SEC` 未満なら同じく `'intersection'`。
- A の進入許可（`approachBlocked`）: B に予約がある → `'separation'`（同時に進入できる到着は組全体で 1 機）。B の占有が `landing` / `takeoff` → `'runwayBusy'`。
  「先行機」の判定（`ahead`）を組全体に広げる（`arrivalReadyAt` の順、同時なら ID の順）。飢餓防止（`DEPARTURE_STARVATION_SEC`）も、B の離陸待ちを含めて判定する。
- 接地の時点（`approach` → `landing`）: 従来の「A が占有されていれば着陸復行」に加え、B の占有が `landing` / `takeoff` なら着陸復行（既存の `goAround`）。進入許可の条件で通常は起きないが、整合のための最終防壁とする。
- 横断（誘導路の機体）: 横断する場所が交差点ノード（誘導路ノードが交差点にある場合）なら、**両方の滑走路を同時に予約** する（どちらにも占有が無く、どちらの予約も `CROSSING_WINDOW_SEC` 以上先）。
  `ac.crossing = { index, runwayId: a, alsoRunwayIds: [b] }` とし、横断を終えたら両方を解放する。交差点以外での横断は従来どおりその滑走路だけを予約する。

**`intersection`（交差点予約。任意のステップ E7b）**

- A の運用が交差点を **通る** ときだけ B と排他にする。
  - 着陸: 運用方向で見た接地点から離脱ノードまでの区間（経路の `runwayEnd` まで）に交差点が含まれるとき。
  - 離陸: 運用方向で見て進入ノードより先に交差点があるとき。離陸後に上空を通過する場合も含める（ゲームの単純化）。
- 判定は占有・予約している機体の経路から計算するので、新しい状態は持たない（`coversIntersection(sim, acId, runwayId, crossing)`）。
- 通らない運用どうしは同時に許す（例: 交差点の手前で離脱する着陸と、交差点の先から始まる離陸）。

### E.3 優先順位（決定的・既存の順序に合わせる）

1. **着陸**: 予約が入った時点で、組の他方の離陸・交差点横断は窓の時間（`DEPARTURE_WINDOW_SEC` / `CROSSING_WINDOW_SEC`）のあいだ拒否される。
2. **離陸**: `runwayControl` が滑走路 ID の順に離陸待ちの先頭を処理する（既存）。組の他方が同じティックで許可済みなら、後の滑走路は `'intersection'` で待つ。
3. **横断**: 各滑走路の離陸の後に処理する（既存の順序）。

飢餓防止は既存の規則（10 分）を組全体に拡張して使う。

### E.4 一貫性の保証（`sim/invariants.ts`）

- R2 の拡張: 占有の目的が `crossing` の場合、`ac.crossing.runwayId === rid` **または** `alsoRunwayIds` に `rid` が含まれていれば正しい。
- 新しい R6: `dependent` の組で、2 本が同時に `landing` / `takeoff` で占有されていない。`intersection` の組では、同時の運用のうち交差点を通るものは 1 つ以下。
- 運航のテスト: 交差する 2 本（60° と 90°）・高需要・2 シードで、毎ティック不変条件が 0 件、`conflicts` が 0、交差点の横断と `'intersection'` の待ちが > 0。

### E.5 そのほか

- 平行滑走路: 従来どおり独立（間隔の警告は検証だけ。D.5）。近接平行を運航上も従属にする機能は Phase 12 では作らない（docs/10 に記録）。
- 方位: 機体の進入方向・位置（`placeAirborne`）はネットワーク上の位置から計算しているので、任意の角度で動く。
- UI（OpsPanels）: `RunwayRow` は `designatorsOf` を使う（`layoutRunway.heading` の型を外す）。交差点ごとの行「交差 09/27 × 14/32: 従属（同時使用しない）/ 交差点予約」を、交差点があるときだけ表示する。
  操作 `setRunwayCrossingMode(sim, crossingId, mode)` は、`runwayCrossingModes` が無ければここで作る。

---

## F. エディタ・UI

### F.1 滑走路ツール（`editor/tools.ts`・`input.ts`・`store.ts`・`ui/Toolbox.tsx`）

- ストア: `hoverW: WorldPoint | null` を追加する（Map → World の丸めない値。既存の `hover: Tile` は残す）。
  ツールのオプション: `runwayAlignment: 'grid8' | 'free'`（**既定 `'grid8'`**。既存の e2e の期待を変えないため。既定を変えるかは PO に確認する: Q-B）、`gridSnap: 'tile' | 'half' | 'off'`（既定 tile）、`angleSnapDeg: 0 | 1 | 5 | 10 | 15 | 45`（既定 1）、`lengthSnapM: 0 | 10 | 50 | 100`（既定 10）。いずれもゲーム UI の値。
- 自由形の配置:
  - (a) 始点 → 終点のクリックまたはドラッグ。`freeRunwayFromDrag(startW, cursorW, opts) → { headingDeg, lengthM }`。始点は格子に吸着し、方位は `angleSnapDeg` に、長さは `lengthSnapM` に丸める。
  - (b) 数値の入力: Toolbox に「方位（真）°」「長さ m」と基準点（始点 / 中点）を入力し、マップをクリックして置く。
  - プレビューは既存どおり、確定と同じ操作の結果を描く。表示は方位（真・磁）・番号・長さ。
- 選択中の自由形のハンドル（select ツール）:
  - 中点: 移動（既存の move の draft）。
  - 端: ドラッグで **中点まわりに回転**（長さは保つ、`angleSnapDeg` で吸着）。Shift + ドラッグで反対の端を固定して、方位と長さを変える。
  - R キー: 中点まわりに `angleSnapDeg`（0 のときは 15°）だけ回転。
  - 従来形には端のハンドルを出さない（R キーは従来どおり 45°）。
- 誘導路ツールの吸着: 直前の点から 8 方向の線を引き、その線が自由形の中心線とカーソルの近く（0.5 タイル以内）で交わるなら、その交点（実数）を次の点にする。誘導路を 8 方向に保ったまま、滑走路上に入口を作れる。

### F.2 PropertiesPanel（自由形）

- 編集できる項目: 名前。方位（真、数値 0〜359.99、0.1 刻み）と、読み取り専用の磁方位（`magneticVariationDeg` の表示つき）。長さ m。舗装幅 30/45/60。番号（自動。接尾辞の上書き: 自動 / L / C / R / なし）。始点・終点（タイル座標と m）。
- 「実寸（ゲーム既定値 ・ 上書き）」の欄: 肩、着陸帯の半幅・端部延長、RESA の長さ・幅、停止位置、標高（始点・終点）と勾配（表示のみ）。各欄に採用元の参考値のツールチップと、定型文（A.3）を付ける。
- 操作: 「グリッドに合わせる（従来形に変換）」。
- 従来形: 既存の欄のまま（e2e の `prop-heading` などは不変）。バッジ「判定: 従来（ゲームの簡易判定）」と、ボタン「自由形に変換（実寸の判定に切り替え）」を加える。変換の確認ダイアログには A.6 の「変わるもの」を出す。

### F.3 空港の設定と Q5 の区別

- **実寸ルールの切替（Q2）の置き場所**: `AirportLayout.ruleSet`（空港ごとに保存。Undo できる）。何も選択していないときの PropertiesPanel に「空港の設定」の節を出す。
  - 磁気偏角: 数値。東を正とし、「10°E」「5°W」の形で表示する。出典として NOAA の計算機の名前を表示する（Q4）。
  - 判定ルール: 「従来（既定）」/「実寸（参考値に基づく追加の警告）」。
  - 説明文: 「Phase 12 では平行滑走路の間隔・番号の警告が従来形にも適用されます。今後の版で判定が追加されます」。
- Q5 の区別:
  - 滑走路の一覧と PropertiesPanel に「従来」/「実寸」のバッジを付ける。
  - IssuesPanel では `criterion: 'real'` の issue に「実寸」のタグを付ける。
  - 2D で自由形を選択したときは、着陸帯と RESA の実寸の輪郭を表示する。従来形を選択したときは、ゲームの占有範囲（`runwayPolygon` / `runwayStripPolygon`）を破線で表示する。

---

## G. 描画（2D・3D は同じ面のデータを使う）

- core: `layout/surfaces.ts` に `runwaySurfaces(r, layout)` を追加する。返す面はすべて World フレーム。
  - `paved`・`pavement`・`strip`・`resa`
  - `centrelineDashes: [WorldPoint, WorldPoint][]`
  - `thresholdBars: WorldPoint[][]`
  - `designators: { pos: WorldPoint; text: string; bearingDeg: number }[]`（`designatorsOf` を使う。位置は滑走路端から内側へ `min(0.1 × L, 150 m)`。ゲーム値）
- 既存の `runwayPavementSurface` / `runwayStripSurface` は **残す**（`surfaces.test.ts` の期待値「占有の多角形と一致」を変えないため）。描画側だけを `runwaySurfaces` に移す。
- 従来形の舗装（Q3、表示のみ、D8 の独立コミット）: `pavement = rectAlongDir(start, end, dir, (surfaceWidthM / 2) / 25, 0)`（30/45/60 m → 1.2/1.8/2.4 タイル。従来の描画は 3 タイル幅で、端が 0.5 タイル延びていた）。
  従来形の着陸帯の表示はゲームの占有のまま（判定と一致させる）。肩と RESA は描かない。
- 自由形: 着陸帯（薄い面と輪郭）→ RESA（斜線の面）→ 舗装 + 肩（明るい灰）→ 舗装 → 中心線の破線・進入端の帯・番号の順で描く。
  2D の番号のラベルは、既存の `label()`（画面に正対）の位置だけを変える。3D は Phase 12 では舗装・肩・着陸帯（任意）・中心線・進入端の帯を平面で描き、番号の文字は描かない（Phase 16 に送る）。
- 3D の高さは Phase 12 では平坦（標高 `dims.elevation*` は表示だけ。docs/10 に記録）。
- 2D と 3D の一致: 新しい面について `surfaces.frames` 型のテストを追加する。テストは `worldPolyToMap` / `worldPolyToScene` を経た頂点を比較する（review §3 の「同語反復のテスト」の指摘を踏まえ、レンダラーが使う関数そのものを対象にする）。

---

## H. 経済

### H.1 建設費（`economy/construction.ts layoutItems`）

- 従来形: 現行の式のまま（`r.length * (r.heading % 90 === 0 ? 1 : Math.SQRT2)`）。
- 自由形: `Math.round((r.lengthM / TILE_M) * C.runwayPerTile * (r.surfaceWidthM / 30))`。従来形を変換したときの費用は、浮動小数点の 1 ulp の差を除いて同じになる。肩の費用は加えない（ゲームの単純化。balance の表を増やさない）。

### H.2 拡張の同一性キー（`economy/expansion.ts geometry`）

- 従来形: 現行のキー文字列のまま。
- 自由形: `JSON.stringify(['free', r.start, r.headingDeg, r.lengthM, r.surfaceWidthM, dims.shoulderWidthM ?? null])`。着陸帯・RESA・停止位置・標高・名前・接尾辞は工事ではないので含めない。
- 変換は改修として扱わない: 「旧が従来形・新が自由形で、`runwayAxis` の始点・終点がそれぞれ `POS_EPS_T` 以内」なら、形状は変わっていないものとする（逆向きの変換も同じ）。この例外を `expansion.ts` に明示的に書き、テストで確認する。

---

## I. 実装ステップ（小さく、個別にテストできる単位）

凡例: 「G=」は、そのステップで **一致していなければならない** ゴールデン。「全」は `tests/golden` の差分が空であること。

| # | 内容 | 主なファイル | テスト | G= |
|---|---|---|---|---|
| S0 | 型の判別共用体化（`RunwayGrid8`/`RunwayFree`/`isFreeRunway`）。`runwayAxis` などのアクセサに自由形の分岐を追加。直接参照をコンパイルエラーに従って置換（従来形の式は不変） | types, runway, operations, construction, expansion, compat, PropertiesPanel, OpsPanels, MapRenderer, Scene3D, tools | 既存全件。`runwayAxis` の自由形（0〜359° の整数と 0.25° 刻みで、終点と長さ） | 全 |
| S1a | ゴールデンの D10 保護に、版に敏感なキーだけの変更を許す例外を追加（B.4） | tests/golden/io.ts | 例外の単体テスト（正規化が同じなら許可、違えば拒否） | 全 |
| S1 | `SCHEMA_VERSION = 3`、`migrate.ts` の v2 → v3 の no-op、`checkLayout` の追加（B.2）、`versions.layoutSchema` の上限の検査 | types, migrate, project, serialize | 移行（v1 → v2 の既存テストは不変、v2 → v3 は恒等、v3 で自由形入りを往復、未知の `alignment`・不正な値の拒否） | **1 回だけ再採取**（B.4）。`normalized-hashes` と各 `normalizedSha256` は一致 |
| S2 | 番号: `designatorsOf`、逆向きの番号（+18）、磁方位、接尾辞 L/C/R、上書き | designators.ts（新） | **0〜359°**、境界（0, 4.999999, 5, 354.999999, 355, 359.999999, 360 → 0, −0、NaN・Infinity の拒否）、逆向きが常に 18 差、**真方位と磁方位**（真 090・10°E → 08/26、10°W → 10/28）、平行 2/3/4 本、上書き、従来形の全 8 方位で `runwayDesignators` と一致 | 全 |
| S3 | 参考値の表とゲーム既定値（A.3）、`runwayAreas`、`tilesOverlappingPolygon` | runwayReference.ts（新）, runwayAreas.ts（新）, raster.ts | **幅** 30/45/60（舗装・肩・着陸帯・RESA の寸法を任意の角度で確認）。出典キーの存在 | 全 |
| S4 | 操作: `placeFreeRunway` / `ByEnds` / `setFreeRunwayGeometry` / 変換 2 種 / `updateLayoutSettings`、既存の move・rotate・duplicate・update の自由形の分岐 | operations | **中点まわりの回転**（中点と長さの保存、360 × 1° で元に戻る）、**任意の角度の長さ**（\|end − start\| × 25 = lengthM、相対誤差 1e-12）、始点・終点からの配置、**従来形からの変換**（8 方位 × 長さで、既存の入口ノードが滑走路上に残る）、Undo、従来形の操作の既存テストは不変 | 全 |
| S5 | ネットワーク: `positionOnRunway` の自由形の分岐、`addPath` 2c の自由形の分岐（実数のノード）、滑走路の交差点ノード、自由形の端の吸着 | network.ts (layout/airside) | 斜めの自由形 × 8 方向の誘導路で実数の入口ができ、同じ点で再度引いても重複しない。**交差** 30°/60°/90°/T 字/同一直線（ノードなし）。従来形の network.test は不変 | 全 |
| S6 | 検証: `FootprintPart.poly`、多角形による判定、交差の免除、`IN_RUNWAY_RESA`、平行間隔、番号の重複、`ruleSet` | footprint, validate | 自由形の着陸帯に施設 → `IN_RUNWAY_STRIP`、RESA → `IN_RUNWAY_RESA`、**平行**（150 m → warning、300 m → info は realistic だけ）、交差する自由形の組はエラーなし、従来形どうしの交差は `OVERLAP`（既存）、混在（従来形の施設と自由形の着陸帯）、自由形の舗装の外にある誘導路は `OVERLAP` にならない | 全 |
| S7 | 運航: `holdShortDistanceAt`、`ctx.crossings`、`dependent` モード、交差点での両方の滑走路の横断予約、不変条件 R2 の拡張と R6 | routes, context, simulation, invariants, types | 交差する 2 本の運航テスト（E.4）、自由形の停止位置（垂直距離 90 m を角度ごとに）、保存 → 復元の一致（交差モードを変更した状態を含む） | 全（特に運航 4 種と routes） |
| S7b | （任意）`intersection` モード | simulation | 交差点を通らない運用の同時許可、通る運用の排他 | 全 |
| S8 | 経済: 建設費、同一性キー、変換を改修としない例外 | construction, expansion | 費用（自由形 = 等価な従来形と一致）、変換で工事が発生しない | 全 |
| S9 | エディタ: `hoverW`、自由形ツール、吸着、数値の配置、ハンドル、R キー、誘導路の中心線への吸着 | store, tools, input | `freeRunwayFromDrag`（角度・長さ・格子の吸着の各設定）、ハンドルによる回転 | 全 |
| S10 | UI: PropertiesPanel（F.2）、Toolbox、空港の設定（F.3）、OpsPanels の交差の行、IssuesPanel のタグと文言 | ui/* | コンポーネントのテスト・e2e（自由形の配置 → 数値の編集 → 番号の表示） | 全 |
| S11 | 描画: `runwaySurfaces`、2D・3D の自由形（新しいデータだけに影響） | surfaces, MapRenderer, Scene3D | 2D/3D の頂点の一致、e2e のスクリーンショット（自由形のみ） | 全 |
| S12 | **表示のみ（D8、独立コミット、PO の確認が取れるまで保留可）**: 従来形の舗装を実寸幅で描く（Q3）、従来形の平行滑走路への L/R の自動表示（Q-A） | MapRenderer, Scene3D, OpsPanels, PropertiesPanel | 表示の e2e の更新（運航・検証は不変） | 全 |
| S13 | 追加のゴールデン（**新しいファイルのみ**、既存は変えない）: `free-runways.layout.json`（自由形の平行・斜め・交差・混在）の geometry と routes、交差する滑走路の運航（`crossing-sim.golden.json`。台帳 `sim-versions.json` に追加。着陸復行 > 0 を目標にする: L5） | tests/golden | 新しい基準値 | 既存は全 |
| S14 | ドキュメント: docs/22 §6 を実装済みに更新、03（データモデル）、07、08（テスト一覧）、10（L6・L7 を閉じ、新しい制限を追加）、11（交差の運用ルール）、21（v3 と `layout.schemaVersion` の意味） | docs | — | 全 |

コミットのまとめ方: S0 / S1a / S1 / S2〜S3 / S4 / S5 / S6 / S7 / S7b / S8 / S9〜S10 / S11 / **S12（表示のみ・単独）** / S13 / S14。どのコミットでも `npx vitest run`・lint・型検査が通ること。S1 以外では `git diff tests/golden` が空であること（S13 は新しいファイルの追加だけ）。

PO が求めたテストの対応: 0〜359° → S0/S2。角度の境界 → S2。中点まわりの回転 → S4。任意の角度の長さ → S4。幅 → S3。平行 → S2/S6。交差 → S5/S6/S7。番号 → S2。真方位と磁方位 → S2。従来データの移行 → S1（とゴールデン全件）。

---

## J. リスクと承認判定

| # | リスク | 深刻度 | 検知 | 対策 |
|---|---|---|---|---|
| P1 | 判別共用体化の置換で、従来形の演算順が変わる | 高 | 全ゴールデン、旧式のオラクルとの `===` 比較 | 従来形の分岐は既存コードを移すだけ。S0 を単独のコミットにする |
| P2 | 新しい処理が従来形のレイアウトで動き、検証の issue の順序・状態のハッシュが変わる | 高 | geometry・運航のゴールデン | 新しい処理は「自由形あり」で囲む。常に付くキーを作らない（B.3） |
| P3 | S1 の再採取で、版以外の変化を見逃す | 中 | `normalized-hashes`・`normalizedSha256` の不変、許したキー以外の差分の検査スクリプト | B.4 の手順 |
| P4 | `layout.schemaVersion` を書き換えない方針による混乱 | 低 | レビュー | docs/21 に意味を明記。外側の版が正である |
| P5 | 旧アプリが v3 のプロジェクトを開いて壊れる | 中 | — | 直せない（旧アプリ）。docs/21 の既知の制限。新しいアプリには上限の検査を追加 |
| P6 | 実数の位置のノードの重複・誤った分割 | 中 | S5 のテスト、`DUPLICATE_NODE` | `POS_EPS_T` で併合、`findNodeNear`。従来の分岐は厳密一致のまま |
| P7 | 交差滑走路の運航で取りこぼし（同時使用・デッドロック・飢餓） | 高 | 不変条件 R6、2 シードの運航テスト、交差の運航ゴールデン | `dependent` を既定（保守的）、接地時の着陸復行が最終防壁、飢餓防止を組全体に拡張 |
| P8 | 実寸の着陸帯（140 m）が広く、変換した既存空港がエラーだらけになる | 中 | 変換の確認ダイアログ | 明示操作のみ・Undo 可能・変わるものを列挙（A.6） |
| P9 | 参考値を安全基準への適合と誤解される | 中 | レビュー | 定型文、参考値とゲーム値の 2 表、出典と状態の表示 |
| P10 | 多角形の判定のコスト | 低〜中 | 性能テスト（自由形 10 本 × 施設 300） | bbox での前段判定、凸の SAT |
| P11 | 表示の変更（Q3・L/R の自動表示）への違和感 | 低 | e2e | S12 を独立させ、保留できるようにする |
| P12 | 停止位置の角度補正で、浅い角度の停止位置がエッジの 0.6 倍に張り付く | 低 | テスト | `SIN_MIN`、ゲーム値として docs に書く |
| P13 | 自由形の終点の浮動小数点の誤差で、端のノードが滑走路上と認識されない | 中 | 変換・端点のテスト | 長さを丸めない（D2）、`POS_EPS_T` で判定 |

### 承認判定: **条件付き承認（Phase 12 の実装開始可）**

条件:

1. S0 と S1 をそれぞれ単独のコミットにする。S1 以外のすべてのステップで `tests/golden` の差分が空であること。S1 では B.4 の範囲の再採取だけを行い、`normalized-hashes.golden.json` と `normalizedSha256` が不変であることをスクリプトの出力で示す。
2. `SIM_MODEL_VERSION`・`PROJECT_FORMAT_VERSION`・`CATALOG_VERSION` を上げない。上げる必要が生じたら実装を止め、設計の見直しを依頼する。
3. 既存のテストの期待値を変えない（`migrate.test.ts`・`surfaces.test.ts`・e2e を含む）。期待値と衝突する場合は、新しい関数を追加して回避する（本書の `runwayPavementSurface` の扱いと同じ）。
4. 参考値はすべて出典キーを持つこと。参考資料で NOT FOUND の項目（0.5 の丸め、0 と 36、コード文字ごとの幅、勾配）は、ゲーム値またはゲームの規則として表示すること。新しい値を出典なしに作らない。
5. S12（表示のみ）は単独のコミットにし、Q-A について PO の確認が取れるまで保留できる形にする。

### PO への確認事項

- **Q-A**: 従来形の平行滑走路（例: ストレスレイアウトの 2 本）に、表示上だけ L/R を自動で付けてよいか（運航・検証は不変）。
- **Q-B**: 新規の滑走路を置くときの既定を、従来形（8 方向）にするか自由形にするか。e2e の期待値を変えないため、推奨は「従来形のまま、ツールのオプションで自由形を選ぶ」。
- **Q-C**: ゲーム既定値（着陸帯の半幅 140 m、RESA 90 m、停止位置 90/107.5 m。EASA の値を採用）でよいか。着陸帯が従来（87.5 m）より広くなるので、自由形の平行滑走路の最小間隔は約 160 m 以上になる。

## K. PM の暫定判断（PO 回答待ち、変更可能な既定）
- Q-A: 従来形の平行滑走路への L/R 自動付与は**しない**（表示・データとも従来どおり。自由形と、明示的に設定した designatorSuffix にのみ適用）。
- Q-B: 滑走路ツールの既定は **grid-8（従来）** のまま。自由形はツールのオプションで選択（e2e 不変）。
- Q-C: EASA 由来のゲーム既定値（着陸帯半幅 140 m・端部延長 60 m・RESA 90 m×滑走路幅2倍・停止位置 90/107.5 m・路肩 0/7.5/7.5 m）を採用。滑走路ごとに dims で変更可能。
