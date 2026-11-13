# Phase 11 設計書 — 幾何基盤（Geometry Foundation）

作成: 設計リード（Opus） / 対象ブランチ: `claude/phase11-16-realism` / 状態: **設計のみ（リポジトリ未変更）**

前提資料: `audit_code.md`, `audit_tests.md`（同ディレクトリ）。本書の file:line は 2026-11-11 時点のコードで確認済み。

---

## 0. 要約（決定事項）

| # | 決定 | 理由 |
|---|------|------|
| D1 | **`WorldPoint` = タイル単位の実数座標、原点は「ノードフレーム」（整数 = タイル中心）**。メートル座標にはしない | 既存の全コア計算（ノード位置・滑走路端・機体 x/y・保存済み運航状態）がこのフレーム。`Tile` がそのまま `WorldPoint` の部分集合になり、データ移行ゼロ・ビット同一性を保てる |
| D2 | フレームは 4 つに名前を付け、変換は `src/core/geometry/frames.ts` の 1 か所のみ（2D・3D とも import） | `+0.5` のばらつき・3D 滑走路の半タイルずれ（後述 §A.5 の既存バグ）を構造的に防ぐ |
| D3 | 角度: データは **度・真方位（0 = 北 = −y、時計回り、[0,360)）**、内部計算はラジアン。8 方位は整数ステップ表 `GRID8_STEP` で厳密に扱う | 既存 `headingVector` の `Math.round(sin)` は 45° の倍数以外で黙って誤る |
| D4 | 既存の幾何述語（`segmentIntersection`, `pointOnSegmentInterior`, `rasterize*`, `distance`, `isIntegerPoint`）は **一切変更しない**。新ライブラリは別関数・別ファイル | 既存結果のビット同一性。新旧の許容誤差の混在を防ぐ |
| D5 | Phase 11 は **バージョンを一つも上げない**（SCHEMA_VERSION=2, PROJECT_FORMAT_VERSION=1, SIM_MODEL_VERSION=`skyport-sim-10.0` のまま） | データ・運航計算を変えないため |
| D6 | SCHEMA_VERSION 3 は **Phase 12（自由方位滑走路を初めて保存できる時点）** で導入。v2→v3 は恒等移行（追加フィールドはすべて任意、欠落 = 従来の意味） | 既存データ無変更で読める |
| D7 | 滑走路は Phase 12 で判別共用体にする: 従来形 `grid8`（`alignment` 欠落）と `alignment: 'free'`（`headingDeg` 任意・`lengthM` 正）。従来形の意味は永久に不変 | 8 方位滑走路の端点・長さ（√2 含む）を完全一致させる唯一の安全策 |
| D8 | 「占有フットプリント（検証用・ゲーム値）」と「舗装・着陸帯・RESA の実寸形状（表示・クリアランス用）」を分離。従来滑走路は `dims` を持たない限り従来フットプリント | 既存の検証結果（OVERLAP 等）を変えない |
| D9 | 誘導路エッジは任意フィールド `geometry?: EdgeGeometry`（欠落 = 直線）。論理ネットワーク（from/to/lengthM）と描画形状を分離 | 既存データ無変更 |
| D10 | SIM_MODEL_VERSION は「**既存（v2 で表現可能な）レイアウトの運航結果が変わるとき**」だけ上げる。これをゴールデンテストで機械的に強制 | 版の変更 = 保存中の運航状態が復元されなくなる（project.ts:323）ため、安易に上げない |
| D11 | Phase 11 の最初の作業は **ゴールデン基準値の採取**（リファクタ前の出力を固定）。以後の全ステップはこれと完全一致を要求 | 「変えていないこと」の証明手段 |

---

## A. 座標系設計

### A.1 フレーム（4 種類）

| フレーム | 型名（TS） | 単位 | 原点・向き | 使う場所 |
|---|---|---|---|---|
| **タイル** | `Tile`（既存、整数） | タイル番号 | タイル (i,j) | 地形・施設 origin・占有ラスタ |
| **World（ノードフレーム）** | `WorldPoint`（新、実数） | タイル（1 = 25 m） | 整数 = タイル中心。+x = 東、+y = 南（画面下） | core 全般：ノード、滑走路端、機体 x/y、多角形、曲線制御点 |
| **Map（2D 描画フレーム）** | `MapPoint`（新） | タイル | タイル (i,j) は [i,i+1)×[j,j+1)、すなわち `Map = World + 0.5` | Pixi の world コンテナ、`camera.ts`（現在「世界座標」と呼んでいるもの） |
| **Scene（3D）** | `ScenePoint`（新、`{x,y,z}`） | m | X = Map.x × 25, Z = Map.y × 25, Y = 上（標高 m） | three.js |
| （画面） | `Vec2` | px | `camera.ts` の `worldToScreen` | 入力・描画 |

- **メートルは「長さ・幅・半径」にだけ使い、位置には使わない**。位置×25 を経由すると `hypot(25dx,25dy) ≠ 25·hypot(dx,dy)`（1ulp 差）が生じ、`Route.cum` のビット同一性（project.test.ts の再開一致）が崩れるため。
- `WorldPoint` は `Vec2` の型エイリアス（ブランド型にしない）。`Tile` はそのまま `WorldPoint` として渡せる。命名規約で単位を明示する: 位置の変数名に `w`/`map`/`scene` 接頭辞、長さは `…M`（m）/`…T`（タイル）接尾辞、角度は `…Deg`/`…Rad`。
- 用語整理: docs/03 §4.1 と camera.ts は Map フレームを「世界座標」と呼んでいる。**コード上の関数名（`worldToScreen` 等）は互換のため残し**、ドキュメントで「camera の world = Map フレーム」と明記する（改名は Phase 16 以降の任意作業）。

### A.2 変換関数（`src/core/geometry/frames.ts`）

```ts
export const TILE_M = 25;                       // catalog.ts は re-export に変更（値・名前は同一）
export type WorldPoint = Vec2; export type MapPoint = Vec2;
export interface ScenePoint { x: number; y: number; z: number }

export const tileToWorld = (t: Tile): WorldPoint => ({ x: t.x, y: t.y });
export const worldToTile = (p: WorldPoint): Tile => ({ x: Math.round(p.x), y: Math.round(p.y) }); // = floor(p+0.5)
export const worldToMap  = (p: WorldPoint): MapPoint => ({ x: p.x + 0.5, y: p.y + 0.5 });
export const mapToWorld  = (p: MapPoint): WorldPoint => ({ x: p.x - 0.5, y: p.y - 0.5 });
export const mapToTile   = (p: MapPoint): Tile => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
export const worldToScene = (p: WorldPoint, elevM = 0): ScenePoint =>
  ({ x: (p.x + 0.5) * TILE_M, y: elevM, z: (p.y + 0.5) * TILE_M });   // 現行 Scene3D の w(a.x + 0.5) と同じ演算順
export const tilesToM = (t: number): number => t * TILE_M;
export const mToTiles = (m: number): number => m / TILE_M;
export const bearingToSceneYawRad = (deg: number): number => ((90 - deg) * Math.PI) / 180; // Scene3D 既存規約「Y 軸まわりに 90° − h」
```

- **演算順は既存コードと同一にする**（`(x + 0.5) * 25`, `x - 0.5`）。置換が浮動小数点的に恒等であることをテストで `===` 確認する。
- 丸め境界: `worldToTile` は `Math.round`（JS は .5 を +∞ 側）で、`mapToTile(worldToMap(p))` と一致する（`rasterizeSegment` の既存挙動と同じ）。

### A.3 角度規約（`src/core/geometry/angle.ts`）

- **データ**: 度。真方位 `trueBearingDeg ∈ [0,360)`、0 = 北 = −y、時計回り。保存データは度のみ。
- **内部**: ラジアン。円弧の内部パラメータは数学角 θ（`p = c + r(cosθ, sinθ)`、World フレームは y 下向きなので **θ 増加 = 画面上で時計回り**）。方位との関係 `θ = bearingRad − π/2`。この 2 種を混ぜないため、円弧 API は θ を外に出さず「始点・終点・接線・方位」で受け渡す。
- 関数:
  - `normalizeDeg(d)` → [0,360)（`-0` を 0 に正規化）
  - `bearingToDir(deg): Vec2` = `{x: sin, y: −cos}`。**90° の倍数は厳密値**（`sin(π)≈1.2e-16` を避ける）、45° の奇数倍は `±Math.SQRT1_2`。
  - `dirToBearing(dx, dy)` = 既存 `routes.ts headingOf` と **同一式**（`((atan2(dx,−dy)·180/π)+360)%360`、(0,0)→0）。`headingOf` は後でこれに委譲（ビット同一を全 8 方位＋乱数入力で `===` 検証）。
  - `turnAngleDeg(h1,h2)` = 既存 `turnAngleAt` の式（`|h2−h1| % 360`、>180 は 360−d）。
  - `signedAngleDiffDeg(a,b)` ∈ (−180,180]
  - `GRID8_STEP: Record<Heading, Tile>`（整数表。`{0:(0,−1),45:(1,−1),…}`）と `isGrid8Heading(n)`。
  - 磁方位: `magneticFromTrue(trueDeg, variationEastDeg) = normalizeDeg(true − varE)`（東偏差を正。例: 真 090°, 偏差 10°E → 磁 080° → "08"）。
  - 滑走路番号: `designatorNumber(magDeg)` = 既存式 `Math.round(deg/10) % 36, 0→36`。ただし入力を `Math.round(deg·1e6)/1e6` で安定化（整数入力では恒等、浮動小数点の 22.4999999 問題を防ぐ）。

### A.4 許容誤差（`src/core/geometry/tolerance.ts`）

| 定数 | 値 | 用途 | 備考 |
|---|---|---|---|
| `EPS`（既存） | 1e-9 | 既存述語のパラメータ判定 | **変更禁止**。新コードでは使わない |
| 既存 `1e-7·len` | — | `pointOnSegmentInterior` 共線判定・`isIntegerPoint` | 変更禁止 |
| `POS_EPS_T` | 1e-6 タイル（25 µm） | 新コードの点一致・ノード併合（Phase 13） | サイト規模 ≲ 1e3 タイルで double 精度に十分余裕 |
| `PARAM_EPS` | 1e-9 | 曲線パラメータ t の端点判定 | |
| `ANGLE_EPS_RAD` | 1e-9 | 平行判定（単位ベクトル外積） | 長さで正規化してから比較 |
| `LENGTH_REL_TOL` | 1e-10 | 弧長積分の相対誤差 | |
| `FLATTEN_TOL_RENDER_T` | 0.01 タイル（0.25 m） | 描画用の折れ線化 | |
| `FLATTEN_TOL_CHECK_T` | 0.002 タイル（5 cm） | クリアランス・干渉判定（Phase 14） | |
| `MAX_SUBDIV_DEPTH` | 48 | 曲線交差の再帰上限 | 決定性のため固定 |

境界の振る舞い（新 API 共通）: 交差・包含は「端点・接触・共線重なり」を**分類して返す**（フィルタしない）。呼び出し側が意味を決める。既存の「内部のみ」意味論は既存関数に残る。

保存精度: JSON の数値は JS の最短表記で往復厳密（有限 double は `JSON.parse(JSON.stringify(x)) === x`）。よって実数座標の量子化は不要。エディタのスナップ（グリッド/半タイル/自由）は UI 側の機能とする。

### A.5 2D と 3D がずれない仕組み

現状の不整合（コード確認済み）:
1. 誘導路幅: 2D `MapRenderer.ts:232` `{S:.55,M:.75,L:.95}` タイル（=13.75/18.75/23.75 m、codeF 無視） vs 3D `Scene3D.ts:188-192` `{S:15,M:23,L:30}` m + codeF 38 m。
2. **既存バグ**: `Scene3D.ts:171` の滑走路は `flat(runwayPolygon(r))` → `w(p.x)` で **+0.5 を足していない**。誘導路（:175-178）と機体（:270）は +0.5 しているので、3D では滑走路だけが北西に 12.5 m ずれている。

方針:
- 位置変換は `frames.ts` のみ（2D は `worldToMap`、3D は `worldToScene`）。描画コードに `± 0.5` の生リテラルを書かない。`tests/unit/frames.lint.test.ts` で `src/render/**` を走査し、座標の `± 0.5` リテラルを検出したら失敗（許可リスト方式）。
- 形状（多角形・帯）は core の `src/core/layout/surfaces.ts` が **World フレーム・タイル単位**で生成し、2D/3D は変換して描くだけにする（Phase 11 は滑走路・着陸帯・誘導路帯・道路帯の直線版）。
- 幅の表は core のカタログに **m 単位**で 1 つ: `TAXIWAY_DRAW_WIDTH_M = { S: 15, M: 23, L: 30, codeF: 38 }`（`status: game` 相当のコメント。実寸の ICAO 値は Phase 12/13 で別表・出典付き）。2D は `mToTiles()` で使う。
- 上記 2 点は **表示だけの変化**（運航・検証に影響なし）。Phase 11 の独立コミットにし、PO の確認を条件とする（未承認ならこのステップだけ保留可能な構成にする）。

---

## B. 幾何ライブラリ API（Phase 11、依存ゼロ）

### B.1 モジュール構成（`src/core/geometry/`）

```
vec.ts         既存（変更しない。追加のみ: lerp, normalize, perp, rotate, nearlyEqual）
frames.ts      §A.2
angle.ts       §A.3
tolerance.ts   §A.4
bbox.ts        AABB: of(points), union, expand, intersects, containsPoint
segment.ts     classifySegmentIntersection（端点・共線を分類）, closestPointOnSegment
curve.ts       Curve 共用体と共通ディスパッチ（evaluate/tangent/curvature/length/split/reverse/bbox/flatten/closestPoint/pointAtLength）
arc.ts         円弧: fromBulge, fromThreePoints, fromTangent(start, bearing, radius, sweep), fillet(line1, line2, r)
bezier.ts      2次/3次 Bezier: de Casteljau, 微分, 曲率, 分割, 極値による bbox
integrate.ts   適応 Gauss–Legendre（5 点、区間二分）
arclength.ts   ArcLengthTable（累積長 LUT + Newton 補正で s→t）
intersect.ts   line–line, line–arc, arc–arc（解析解）, 一般 curve–curve（bbox 細分 + Newton 仕上げ）
polygon.ts     signedArea, orientation, isConvex, satOverlapConvex, polygonsOverlap（一般）, polygonContains, minDistance
stroke.ts      rectAlong(a,b,halfW,extend)（runwayRect の一般化）, strokePolyline(pts, halfW, {join, cap, miterLimit}), offsetCurve(curve, d, tol)
raster.ts      既存 rasterizePolygon/rasterizeSegment を移動（vec.ts から re-export を維持）+ rasterizeCurve（Phase 13 用）
index.ts       公開 API の集約
```

### B.2 型

```ts
export type Curve =
  | { kind: 'line';  p0: WorldPoint; p1: WorldPoint }
  | { kind: 'arc';   c: WorldPoint; r: number; theta0: number; sweep: number } // 内部表現（θ ラジアン, sweep≠0, |sweep|<2π）
  | { kind: 'quad';  p0: WorldPoint; p1: WorldPoint; p2: WorldPoint }
  | { kind: 'cubic'; p0: WorldPoint; p1: WorldPoint; p2: WorldPoint; p3: WorldPoint };
export interface CurvePoint { p: WorldPoint; t: number; s?: number }
export type Path = readonly Curve[];   // 連続（G0）を前提とした複合曲線
```

全関数は純関数・入力非破壊・決定的（ループ順・再帰順固定、`Math.random` なし）。

### B.3 主な関数と仕様

| 関数 | 仕様 |
|---|---|
| `evaluate(c,t)`, `derivative(c,t)`, `tangentBearingDeg(c,t)` | t∈[0,1]。arc は t→θ0+sweep·t |
| `curvature(c,t)` | 符号付き（1/タイル、正 = 画面時計回り）。line は 0、arc は ±1/r 厳密 |
| `length(c)` | line: `Math.hypot`、arc: `r·|sweep|`（厳密）、bezier: 適応 GL5 で `LENGTH_REL_TOL` |
| `arcLengthTable(c, n=64)` / `tAtLength(tbl, s)` / `pointAtLength(c, s)` | LUT で区間特定 → Newton（最大 8 回、二分法フォールバック）。s は [0,L] にクランプ |
| `split(c, t)` → `[Curve, Curve]` | Bezier は de Casteljau、arc は sweep 分割、line は lerp。**ID 保持付き分割（Phase 13）の基礎** |
| `reverse(c)` | 逆向き。`evaluate(reverse(c),1−t) ≈ evaluate(c,t)` |
| `bbox(c)` | Bezier は導関数の根で厳密、arc は軸方向極値を含める |
| `flatten(c, tol)` → `CurvePoint[]` | 弦高（sagitta）誤差 ≤ tol を保証。arc は角度刻みを解析的に決定、Bezier は再帰細分（平坦性判定）。端点は必ず含む |
| `closestPoint(c, p)` → `{t, p, dist}` | line 厳密、arc 解析（角度クランプ）、Bezier は flatten 初期値 + Newton。同距離は小さい t を返す |
| `classifySegmentIntersection(a,b,c,d)` | `{kind:'none'} | {kind:'point', p, t, u, atEndA, atEndB} | {kind:'overlap', t0,t1,u0,u1}` |
| `intersectCurves(c1, c2, tol)` | 解析解がある組は解析、それ以外は bbox 細分 + Newton。結果は t1 昇順・重複除去（距離 `POS_EPS_T`）。接触（重根）は `tangent: true` を付けて 1 点。重なり区間（同一円上の arc 等）は `overlap` として返す |
| `rectAlong(a,b,halfW,extend)` | `runway.ts runwayRect` と**同一演算順**（`v/len` → `n=(−u.y,u.x)` → 4 頂点、順序も同一） |
| `strokePolyline` / `offsetCurve` | 帯の外形（Phase 13 の曲線誘導路帯・フィレット用）。自己交差は Phase 11 ではクリップしない（仕様として明記、Phase 13 で必要なら追加） |
| `satOverlapConvex(A,B)` | 凸多角形。接触（距離 0）は「重ならない」（`> POS_EPS_T` の貫入のみ true） |
| `polygonsOverlap(A,B)` | 一般（非凸可、単純多角形）: bbox → 辺交差 → 包含判定。境界の接触は false |
| `polygonMinDistance(A,B)` | クリアランス用（Phase 14） |

設計上の注意:
- Bezier の弧長は 3 次でも閉形式がないので GL 積分。**弧長の値は決定的**（同一入力→同一ビット）なので、保存済み `Route.cum` と再計算値は一致する。
- `fillet(lineA, lineB, r)`（Phase 13 の交差部フィレットの基礎）は Phase 11 で関数として実装・テストのみ。
- 精度保証（exact predicates 等）は過剰設計として採用しない。代わりに「長さで正規化した外積 + 許容誤差」と「分類を返す」方針で、退化ケースをテストで網羅する。

### B.4 テスト方針
- 解析解との比較（円弧長 = rθ、円弧曲率 = 1/r、直線に退化した Bezier の長さ = 弦長、4 分円の 3 次近似の半径誤差 ≈ 2.7e-4）。
- 性質テスト: シード付き乱数（`src/core/rng.ts` を流用、fast-check は導入しない）で 1,000 ケース: `split` 後の長さの和 = 元の長さ、`flatten` 点の真の曲線からの距離 ≤ tol（密サンプリングで検証）、`intersectCurves` の結果点が両曲線上にある、`reverse` の対称性、SAT と点サンプリング総当たりの一致。
- 退化: 長さ 0 の線分、r→0 の円弧、全制御点一致の Bezier、平行・共線・接線交差、端点接触。

---

## C. データモデル拡張計画（Phase 12〜16 が依存する決定）

### C.1 滑走路（Phase 12 で導入、Phase 11 は型を変えない）

```ts
interface RunwayBase { id; name; surfaceWidthM: 30 | 45 | 60; buildState; dims?: RunwayDims; }
/** 従来形（v1/v2 のデータはすべてこれ）。意味は永久に不変 */
interface RunwayGrid8 extends RunwayBase { alignment?: undefined; start: Tile; heading: Heading; length: number /* ステップ数 */ }
/** 自由方位（Phase 12〜） */
interface RunwayFree  extends RunwayBase { alignment: 'free'; start: WorldPoint; headingDeg: number /* 真方位 [0,360) */; lengthM: number /* 正 */ }
type Runway = RunwayGrid8 | RunwayFree;
interface AirportLayout { …; magneticVariationDeg?: number /* 東偏差を正、既定 0 */ }
```

- **従来形の写像**（完全一致）: `end = start + GRID8_STEP[heading]·length`（整数）、`lengthM = round(length·|step|·25)`（斜めは √2）。Phase 11 で `headingVector` を表引きに変え、旧式との一致を全 8 方位で `===` 検証。
- 自由形: `dir = bearingToDir(headingDeg)`、`end = start + dir·(lengthM/25)`。端点は保存しない（`headingDeg` と `lengthM` が正。番号は保存した方位から決まるので atan2 の丸め誤差で番号が変わらない）。
- **アクセサ必須**: `runwayAxis(r) → { start, end, dir, lengthT, lengthM, trueHeadingDeg }` を Phase 11 で追加（従来形のみ対応）。Phase 12 で判別共用体にした際、`r.length`/`r.heading` 直接参照はコンパイルエラーになり、全箇所がアクセサに寄る（既知の直接参照: MapRenderer:192 付近, operations.ts:187/433/440-445/585, expansion.ts:61, PropertiesPanel:203-225, OpsPanels:157, tools.ts:40-60）。
- 正規化規則: 従来形への操作（+45° 回転、端点ドラッグ）は従来形のまま。自由形→従来形への自動変換はしない（斜めの √2 長は自由形で厳密に表せないため）。UI の「グリッドに合わせる」で明示的にのみ変換。
- 番号: `designators(r, layout.magneticVariationDeg ?? 0)`。偏差 0 の従来形は現行 `runwayDesignators(heading)` と完全一致。平行滑走路の L/C/R は Phase 12。
- `expansion.ts:61` の同一性キー（`[start,heading,length,surfaceWidthM]`）は Phase 12 で `alignment` 別のキーに拡張（従来形のキー文字列は不変）。

### C.2 舗装の実寸とフットプリントの分離

| 形状 | 関数 | 単位・出典 | 用途 |
|---|---|---|---|
| 占有フットプリント（ゲーム値） | `runwayPolygon` / `runwayStripPolygon`（既存） | タイル。半幅 1.5 / 3.5、端 +0.5 / +2.5 | 占有・OVERLAP・IN_RUNWAY_STRIP・ピック |
| 舗装（実寸） | `runwayPavementPolygon`（Phase 12 新） | m→タイル。`surfaceWidthM` + 肩 | 描画、Phase 14 クリアランス |
| 着陸帯・RESA（参考値） | `runwayStripRealPolygon`, `resaPolygon`（Phase 12 新） | ICAO Annex 14 の参考値（版により異なる、`Sourced` で出典・状態を持つ） | 表示・自由形の検証 |

- **`dims` を持たない従来形 = 従来フットプリントのまま**（OVERLAP、平行誘導路 y=21 vs 滑走路 y=20 が OVERLAP のテスト等、既存検証結果は不変）。
- 自由形・新規作成の滑走路は `dims`（実寸）を既定で持ち、検証にも実寸を使う。従来形に `dims` を付けるのはプレイヤーの明示操作（「実寸に更新」、検証結果が変わる旨を表示）。
- 表示: 従来形でも舗装を実寸で描くかは表示のみの問題（Open Question Q3）。
- 実寸値は `catalog.ts` に `Sourced` 形式で持ち、UI では「参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません」と明示（制約 4・5）。
- `HOLD_SHORT_M = 87.5`（rules.ts:43, = 3.5 タイル×25）は従来形の値として固定。自由形の停止位置距離は Phase 12/15 で `dims` から導出。

### C.3 誘導路エッジの形状（Phase 13 で導入）

```ts
interface TaxiwayEdge { …既存…; geometry?: EdgeGeometry }   // 欠落 = from→to の直線
type EdgeGeometry =
  | { kind: 'arc'; bulge: number }                              // tan(中心角/4)、符号 = 向き（DXF 方式）。ノード移動に追従
  | { kind: 'cubic'; h0: Vec2; h1: Vec2 }                       // 端点からの相対ハンドル（タイル）。ノード移動に追従
  | { kind: 'compound'; parts: { via: WorldPoint; shape: 'line' | { bulge: number } | { h0: Vec2; h1: Vec2 } }[] };
```
- 向きは常に from→to。逆走は `reverse(curve)`。論理長 `lengthM = round(arcLength·25)`（直線は既存式 `round(distance·25)` をそのまま使う分岐）。
- フィレットは保存しない派生形状（接続角と幅から生成）。上書きが必要なら Phase 13 でノードに `filletRadiusM?` を追加。
- 分割時の ID 保持: 既存 `splitEdge` と同じ規則（前半が元 ID、後半が新 ID）。形状は `split(curve, t)` で前後に分配。
- 既存の「交点がタイル中心のときだけ交差点を作る」（network.ts:137,146）は**既存データの検証結果に関わる**ので、Phase 13 で変える場合も既存データの検証（TAXIWAY_CROSSING_NO_JUNCTION）が変わらないことを確認する（編集操作の挙動は変えてよいが network.test.ts の期待値は変えない）。

### C.4 版の方針

| 版 | Phase 11 | 上げる時点 | 移行 |
|---|---|---|---|
| `SCHEMA_VERSION` | 2 のまま | Phase 12（`alignment`/`dims`/`magneticVariationDeg` を保存可能になる時）→ 3。Phase 13 の `geometry` は任意フィールドなので 3 に含める（未実装の間は書かれないだけ）か 4 にするかは Phase 13 で判断（推奨: Phase 12 リリース前に Phase 13 の型も入れて 3 にまとめる） | v2→v3 恒等（`schemaVersion` のみ更新）。旧アプリは v3 を「未対応の版」で拒否（既存処理） |
| `PROJECT_FORMAT_VERSION` | 1 | ファイル構造が変わるときだけ（Phase 11〜15 では予定なし） | — |
| `CATALOG_VERSION` | 不変 | Phase 14（脚配置・操向角などを機種に追加） | 保存済みスナップショットに新項目が無い場合は `status:'unset'` + ゲーム推定値で補う |
| `ASSET_VERSION` | 不変 | Phase 16 | 表示のみ |
| `SIM_MODEL_VERSION` | 不変 | **既存（v2 表現可能）レイアウトで運航結果が変わる時のみ** | 変われば保存中の運航状態は復元されず建設モード（project.ts:323）。曲線レイアウト専用の新挙動は版を上げずに追加できる（既存レイアウトの結果が同一である限り） |

- 移行コードの一元化: 現在 v1→v2 が 3 か所に重複（serialize.ts:45-48, project.ts:244-247, :277-279）。Phase 11 で `src/core/io/migrate.ts` の `migrateLayout(raw)` に集約（挙動同一）。v3 の追加はここ 1 か所で済む。
- 保存済み運航状態: `Route.cum`（m）・`x/y`（World フレーム）・`dist` はネットワークから決定的に再計算できる値。Phase 11 はネットワーク・長さを変えないので有効。曲線エッジ導入後も「直線エッジは既存式」の分岐を守る限り既存セーブの cum は一致する。
- ゴールデンテストで強制: `tests/golden/sim.golden.json` に `{ simModelVersion, digest }` を保存し、ダイジェストが変わったのに版が同じならテスト失敗。

### C.5 Phase 14/15 への含意（今決めておくこと）
- 機体の実寸（`Sourced` の official）とゲーム値（`profile`、`game`）の区別は既存方式を踏襲。脚配置等も `Sourced` で持ち、未調査は `unset` + 推定。
- 曲線上の運動（Phase 15）: 直線エッジのみの経路では現行の `pointAt`/`turnAngleAt`/`TURN_SPEED` ロジックをそのまま使う（角の内側を切る「コーナーカット」は導入しない）。曲率による速度制限は `geometry` を持つエッジにのみ適用 → 既存結果は不変。
- 「実寸に基づく厳しい判定（翼端クリアランス等）を既存レイアウトにも適用したい」という要求は制約 2 と衝突する → Q2 で PO 判断。

---

## D. Phase 11 実装タスク（小さく、個別にテスト可能）

全ステップ共通の完了条件: `npm run typecheck && npm run lint && npm test` 緑、**既存テストの期待値変更ゼロ**（`git diff tests/unit tests/integration tests/e2e` は追加のみ）、ゴールデン完全一致、e2e（view3d/editor）緑。

| # | 内容 | ファイル | テスト追加 | 「挙動不変」の確認 |
|---|---|---|---|---|
| **S0** | **ゴールデン基準値の採取**（リファクタ前の main 状態で生成しコミット） | `tests/golden/capture.ts`, `tests/golden/*.golden.json`, `tests/unit/golden.test.ts` | 対象: サンプルレイアウト＋テスト用レイアウト＋「8 方位×数種の長さの滑走路と斜め誘導路」専用レイアウト。採取: `buildAirsideNetwork` 全出力、`validateLayout` の issue 一覧、全エンティティの `footprintOf`、`runwayPolygon/StripPolygon` の頂点（`toString` で 17 桁）、シード固定で 24h 運航した `SimState` の JSON ハッシュ＋KPI、`serializeProject` 出力 | 基準値そのもの。**この時点で他のコード変更を含めない** |
| S1 | `frames.ts`, `tolerance.ts`、`TILE_M` を frames に移し catalog は re-export | `geometry/frames.ts`, `geometry/tolerance.ts`, `model/catalog.ts` | `frames.test.ts`: 往復、`mapToTile(worldToMap(p)) === worldToTile(p)`（.5 境界含む）、`worldToScene` が `(x+0.5)*25` と `===` | ゴールデン一致 |
| S2 | `angle.ts`（normalize, bearingToDir, dirToBearing, turnAngleDeg, GRID8_STEP, 磁方位, designatorNumber） | `geometry/angle.ts` | 旧 `headingVector`/`headingOf`/`runwayDesignators` の式をテスト内に複製した**オラクル**と `===` 比較（8 方位、ランダム 10,000 方向）。磁方位の符号例（10°E, 7°W） | 呼び出し側未変更 |
| S3 | `vec.ts` への追加関数、`bbox.ts`、`segment.ts`（分類付き交差） | 同 | 端点・共線・平行・退化 | 既存関数は diff なし |
| S4 | 曲線: `curve.ts`, `arc.ts`, `bezier.ts`, `integrate.ts`, `arclength.ts`（evaluate/derivative/curvature/length/split/reverse/bbox/flatten/closestPoint/pointAtLength/fillet） | 同 | §B.4 の解析・性質・退化テスト | 未使用（追加のみ） |
| S5 | 交差: `intersect.ts`（line/arc 解析、一般は細分） | 同 | 接線・端点・重なり・決定性（2 回実行で同順同値） | 未使用 |
| S6 | 多角形: `polygon.ts`, `stroke.ts`（`rectAlong`, `strokePolyline`, `offsetCurve`） | 同 | `rectAlong` が旧 `runwayRect`（オラクル）と頂点 `===`（8 方位×長さ 1..120×幅 2 種）。SAT vs 総当たり | 未使用 |
| S7 | `raster.ts` へ `rasterizePolygon/rasterizeSegment` を移動（vec.ts から re-export） | `geometry/raster.ts`, `vec.ts` | 既存 geometry.test.ts がそのまま通る | 関数本体は 1 文字も変えず移動 |
| S8 | `runway.ts` を基盤に載せ替え: `headingVector` → `GRID8_STEP` 表引き、`runwayRect` → `rectAlong`、`runwayAxis(r)` 追加 | `layout/runway.ts` | `runwayAxis` テスト | runway.test.ts（1414 m 等）無変更で緑、ゴールデン一致 |
| S9 | `routes.ts headingOf` → `angle.dirToBearing` に委譲、`turnAngleAt` → `turnAngleDeg` | `sim/routes.ts` | — | project.test.ts の再開ビット一致、ゴールデン（運航ダイジェスト）一致 |
| S10 | `±0.5` の置換（core/editor のみ。式が同一演算になる箇所に限る）: `sim/query.ts:15`, `sim/context.ts:104`, `sim/ground.ts:494`, `airside/network.ts:181`, editor の pick | 各ファイル | — | ゴールデン一致。演算順が変わる箇所は置換しない（コメントで frames を参照） |
| S11 | 移行の一元化 `io/migrate.ts`（v1→v2）。serialize.ts / project.ts の 3 か所から呼ぶ | `io/migrate.ts` ほか | v1 レイアウト・v1 プロジェクト（運航状態入り）フィクスチャで読込結果が従来と deepEqual | project.test.ts 無変更で緑 |
| S12 | `layout/surfaces.ts`（World フレームの描画形状: 滑走路・着陸帯・誘導路帯・道路帯）＋ `TAXIWAY_DRAW_WIDTH_M` | `layout/surfaces.ts`, `model/catalog.ts` | 形状の単体テスト | core のみ・未使用 |
| S13 | **表示のみの変更（PO 確認後、独立コミット）**: MapRenderer / Scene3D を `frames` + `surfaces` 経由に変更、誘導路幅を m 表に統一（2D も codeF 反映）、**3D 滑走路の半タイルずれ修正** | `render/MapRenderer.ts`, `render/three/Scene3D.ts` | `frames.lint.test.ts`（render の生 `±0.5` 禁止）。surfaces の頂点を 2D/3D 両変換で突き合わせる単体テスト | 運航・検証ゴールデン一致。e2e view3d/editor 緑（画素比較があればベースライン更新は PO 承認事項） |
| S14 | ドキュメント: docs/03 §4.1 にフレーム表と +0.5 規約、docs/07 に geometry モジュール構成、docs/21 に版方針（§C.4）。誤記（03 の「ノードはタイル中心」→ 整数保存・描画 +0.5）を修正 | docs | — | — |

推奨順: S0 →（S1〜S7 は並行可）→ S8 → S9 → S10 → S11 → S12 → S13 → S14。S0 と S8/S9 は必ず別コミット。

規模の目安: 新規コード 1,500〜2,000 行（大半はテスト）、既存コードの変更は数十行。

---

## E. リスク表

| # | リスク | 深刻度 | 発生条件 | 検知 | 対策 |
|---|---|---|---|---|---|
| R1 | リファクタで浮動小数点のビットが変わり運航結果がずれる | 高 | `Math.hypot`→`sqrt` 置換、演算順変更、位置を m に変換してから距離計算 | S0 ゴールデン、project.test 再開一致、オラクル `===` テスト | 既存述語は不変（D4）。置換は演算順同一の箇所のみ。位置は m にしない（D1） |
| R2 | ゴールデンの網羅不足で差異を見逃す | 中 | 斜め・端部・停止位置などがサンプルに無い | カバレッジ確認 | 8 方位専用レイアウトを S0 に追加、運航ダイジェストは全 SimState の JSON ハッシュ |
| R3 | フレーム混同（+0.5） | 高 | 新コードが Map と World を取り違える | frames.lint テスト、2D/3D 突き合わせテスト | frames.ts 一元化、命名規約、既存 3D バグの修正 |
| R4 | 新旧の許容誤差の混在でノード接続・交差判定が変わる | 中 | 新 `POS_EPS_T` を既存経路で使う | ゴールデン（network/validation） | 既存経路は既存述語のみ。新述語は新データ（自由形・曲線）専用 |
| R5 | 曲線数値計算の不安定（接線交差・退化 Bezier・Newton 発散） | 中 | 特殊配置 | 退化・性質テスト | 再帰深さ固定、二分法フォールバック、分類付き結果 |
| R6 | 方位の丸め境界（x5° の .5）で番号が変わる | 中 | 方位を端点から逆算 | designator テスト | 方位は保存値を使う（端点から逆算しない）、1e-6 丸め |
| R7 | 磁偏差の符号誤り | 中 | 東西の取り違え | 例題テスト（10°E→真 090 は "08"） | 規約を型コメントと docs に明記 |
| R8 | 滑走路の判別共用体化で広範囲の変更（Phase 12） | 中 | 直接参照の取り残し | TypeScript のコンパイルエラー | Phase 11 で `runwayAxis` を先に導入し呼び出し側を寄せておく |
| R9 | 実寸化（Phase 12/14）と「既存結果不変」の衝突 | 高 | 既存レイアウトに実寸判定を適用 | ゴールデン | 実寸は `dims`/自由形/曲線のみに適用、既存へは明示操作（Q2） |
| R10 | SIM_MODEL_VERSION 変更で保存中の運航状態が失われる | 中 | Phase 14/15 で既存結果が変化 | ゴールデン（版とダイジェストの対） | 既存経路を分岐で保持し版を上げない設計 |
| R11 | v3 を旧アプリで開けない | 低 | ダウングレード | 既存エラーメッセージ | 仕様として許容、docs/21 に明記 |
| R12 | 表示変更（誘導路幅統一、3D 滑走路位置）への違和感・e2e 画像差分 | 低〜中 | S13 | e2e | 独立コミット、PO 確認、保留可能 |
| R13 | 実寸・規定値を安全適合と誤解される | 中 | UI 文言 | レビュー | 「参考値・ゲーム内判定・適合を保証しない」の定型文、`Sourced` の状態表示 |
| R14 | 曲線同士の交差判定のコスト（Phase 13 の検証が O(n²)） | 中 | 大規模空港 | 性能テスト | bbox 前段判定、空間ハッシュ（Phase 13） |
| R15 | Phase 11 の範囲拡大（Phase 12 の UI 等に手を出す） | 中 | 実装者の先回り | レビュー | 本書 §D 以外は不可。型（Heading, Runway）は Phase 11 で変えない |

---

## F. 承認判定

**判定: 条件付き承認（Phase 11 実装開始可）**

条件:
1. **S0（ゴールデン基準値）を最初に、他の変更を含まないコミットで作る**。以後の全ステップで完全一致。
2. 既存テストの期待値・既存幾何述語（`segmentIntersection`, `pointOnSegmentInterior`, `rasterize*`, `distance`, `isIntegerPoint`, `snapToOctant`）の本体を変更しない。
3. Phase 11 では SCHEMA_VERSION / PROJECT_FORMAT_VERSION / CATALOG_VERSION / ASSET_VERSION / SIM_MODEL_VERSION をいずれも上げず、`Heading`・`Runway`・`TaxiwayEdge` の型も変えない。
4. S13（表示の変更: 誘導路幅統一・3D 滑走路ずれ修正）は独立コミットにし、PO の確認が得られるまで保留できる形にする。
5. 新モジュールは core 層規則（外部依存なし、`Math.random`/`Date.now` 不使用）を守る。

## G. PO への確認事項（Open Questions）
- **Q1**: S13 の表示変更（3D 滑走路の 12.5 m ずれ修正、誘導路の表示幅を 3D の m 値 S15/M23/L30/codeF38 に統一 → 2D の誘導路が太くなる）を Phase 11 で行ってよいか。
- **Q2**: Phase 14/15 の実寸判定（翼端クリアランス、曲率速度制限）を既存レイアウトに適用したい場合、空港ごとの明示的な「実寸ルール」切替（既定は従来）でよいか。既定で従来ルールなら制約 2 を満たせる。
- **Q3**: 従来形滑走路を Phase 12 以降、**表示上だけ**実寸の舗装幅で描いてよいか（占有・検証は従来のまま）。
- **Q4**: 磁偏差は空港ごとの手入力（地磁気モデルなし、年変化なし）でよいか。
- **Q5**: 自由形滑走路は実寸の着陸帯（従来より広い）で検証される。従来形と自由形が混在する空港で判定基準が異なることを許容するか（UI で区別表示する前提）。

## H. PO の回答（2026-11-11）
Q1〜Q5 すべて推奨案で承認。
- Q1: S13（3D 滑走路ずれ修正、誘導路表示幅を m 表 S15/M23/L30/codeF38 に統一）を Phase 11 で実施（独立コミット）。
- Q2: 実寸判定の既存空港への適用は空港ごとの「実寸ルール」切替（既定は従来）。
- Q3: 従来形滑走路を表示のみ実寸の舗装幅で描画（占有・検証は従来のまま）。
- Q4: 磁気偏角は空港ごとの手入力。
- Q5: 従来形と自由形で判定基準が異なることを許容（UI で区別表示）。
