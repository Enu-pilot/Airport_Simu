# 22. 幾何基盤の設計（Phase 11）

実装: `src/core/geometry/`（フレーム・角度・許容誤差・曲線・交差・多角形・ストローク）、`src/core/layout/surfaces.ts`（描画用の面）、
`src/core/layout/runway.ts`（`runwayAxis`）、`src/core/io/migrate.ts`（レイアウト版の移行）。テストの一覧は [08](08_test_plan.md) §17、
既知の制限は [10](10_open_issues.md) §L。

Phase 11 の目的は、Phase 12〜16（自由方位の滑走路・曲線誘導路・機体の実寸と運動・3D アセット）が依存する **幾何の土台** を、
**既存の運航・検証の結果を 1 ビットも変えずに** 導入することである。ここに書く内容のうち、実装済みなのは「座標フレーム」から「ゴールデン」まで。
「データモデルの計画」と「版の方針（将来）」は **計画であり未実装** である（実装時期を各項に示す）。

## 1. 座標フレーム

| フレーム | 型（`geometry/frames.ts`） | 単位 | 原点・向き | 使う場所 |
|---|---|---|---|---|
| Tile | `Tile`（整数） | タイル番号 | タイル (i, j) | 地形・施設の origin・占有ラスタ |
| World | `WorldPoint`（実数） | タイル（1 = 25 m） | **整数 = タイル中心**。+x = 東、+y = 南（画面下） | core 全般: ノード、滑走路端、機体の x/y、多角形、曲線の制御点 |
| Map | `MapPoint`（実数） | タイル | タイル (i, j) は [i, i+1) × [j, j+1)。**Map = World + 0.5** | 2D 描画（Pixi の world コンテナ）、`camera.ts`（コード上は「世界座標」と呼ぶ） |
| Scene | `ScenePoint`（`{x, y, z}`） | m | X = Map.x × 25、Z = Map.y × 25、Y = 上（標高 m） | 3D（three.js） |
| 画面 | `Vec2` | px | `camera.ts` の `worldToScreen` | 入力・描画 |

- ノードや滑走路端は **整数のタイル番号として保存** され（= World フレームの整数点）、描画のときだけ +0.5 してタイルの中心に置く。
  docs/03 §4.1 の旧記述「ノードはタイル中心」は、この「整数で保存・描画時に +0.5」の意味である。
- **メートルは長さ・幅・半径にだけ使い、位置には使わない。** 位置 × 25 を経由すると `hypot(25dx, 25dy) ≠ 25·hypot(dx, dy)`（1 ulp 差）が生じ、
  保存済みの `Route.cum` のビット同一性（運航の再開一致）が崩れるため。
- 変換は `frames.ts` の関数だけで行う: `tileToWorld` `worldToTile`（`Math.round`、.5 は +∞ 側）`worldToMap` `mapToWorld` `mapToTile` `worldToScene` `tilesToM` `mToTiles`
  `bearingToSceneYawRad`、多角形用の `worldPolyToMap` `worldPolyToScene`。演算順は既存コードと同一（`(x + 0.5) * 25`、`x - 0.5`）で、置換が恒等であることをテストで `===` 確認している。
- 命名規約: 位置の変数に `w` / `map` / `scene` の接頭辞、長さは `…M`（m）/ `…T`（タイル）の接尾辞、角度は `…Deg` / `…Rad`。
- `camera.ts` の `worldToScreen` などの関数名は互換のため残した。ここでいう「世界座標」は **Map フレーム** である（改名は Phase 16 以降の任意作業）。
- **機械的な防止**: `tests/unit/geometry/frames.lint.test.ts` が `src/render`・`src/ui`・`src/editor`・`src/core/geometry/camera.ts` の座標の ±0.5 の生リテラルを検出して失敗する
  （`+ .5`、テンプレート内の式、`*` で始まる継続行も検出。単項の `-0.5`、`x * 0.5 - y` は対象外）。
  座標ではない 0.5（線幅・半径・比率）は、その行に `frames-allow-0.5: <理由>` のコメントを付けて許可する。
  `src/core` の他の部分（sim・airside・layout など）は走査していない（S10 で frames に集約したが、lint での強制はしていない。[10](10_open_issues.md) L3）。

## 2. 角度の規約（`geometry/angle.ts`）

- データは **度・真方位**: 0 = 北 = −y、時計回り、[0, 360)。内部計算はラジアン。保存データは度のみ。
- 円弧の内部パラメータは数学角 θ（`p = c + r(cos θ, sin θ)`）。World フレームは y が下向きなので θ の増加は画面上の時計回り。方位との関係は `θ = 方位(rad) − π/2`。
  両者を混ぜないよう、円弧の API は θ を外に出さず「始点・終点・接線・方位」で受け渡す。
- **磁方位 = 真方位 − 東偏差**（東偏差を正）。例: 真 090°・偏差 10°E → 磁 080° → 滑走路番号 "08"（`magneticFromTrue`）。偏差の入力・保存は Phase 12 で実装済み（空港の設定、[23](23_runway_design.md) §3）。
- 主な関数: `normalizeDeg`（-0 は 0）、`bearingToDir`（90° の倍数は厳密値、45° の奇数倍は ±√½）、`dirToBearing`（旧 `routes.ts headingOf` と同一式）、
  `turnAngleDeg`（旧 `turnAngleAt` の式）、`signedAngleDiffDeg`、`magneticFromTrue`、`designatorNumber`（1e-6 度に丸めてから 10° 単位に四捨五入。非有限は `RangeError`）。
- `GRID8_STEP`: 8 方位 → 1 ステップのタイル差分（整数表）。`Object.freeze` 済みで、各エントリも凍結。**-0 の成分を持たない**
  （`headingVector` が共有オブジェクトを返すため。旧実装は方位 90° の `y` が -0 だった）。`isGrid8Heading`。
- 旧式（`Math.round(Math.sin)` による `headingVector`）は 45° の倍数以外で黙って誤るため廃止し、表引きにした。旧式との一致は全 8 方位で `===` 検証している。

## 3. 許容誤差・限界値の方針（`geometry/tolerance.ts`）

| 定数 | 値 | 用途 |
|---|---|---|
| `EPS`（`vec.ts`、既存） | 1e-9 | 既存述語のパラメータ判定。**変更禁止**。新コードでは使わない |
| 既存の `1e-7 × 長さ` | — | `pointOnSegmentInterior` の共線判定・`isIntegerPoint`。**変更禁止** |
| `POS_EPS_T` | 1e-6 タイル（25 µm） | 新コードの点の一致・ノード併合・交点の重複除去 |
| `PARAM_EPS` | 1e-9 | 曲線パラメータ t の端点判定 |
| `ANGLE_EPS_RAD` | 1e-9 | 平行判定（長さで正規化した外積） |
| `LENGTH_REL_TOL` | 1e-10 | 弧長積分の相対誤差 |
| `FLATTEN_TOL_RENDER_T` | 0.01 タイル（0.25 m） | 描画用の折れ線化の弦高誤差 |
| `FLATTEN_TOL_CHECK_T` | 0.002 タイル（5 cm） | クリアランス・干渉判定用（Phase 14 で使う予定） |
| `MAX_SUBDIV_DEPTH` | 48 | 曲線交差の再帰上限（決定性のため固定） |
| `MAX_FLATTEN_POINTS` | 4096 | 折れ線化・円弧の帯が返す区間数の上限 |

**境界・非有限入力の方針**（独立監査の指摘を反映済み）:

- 交差・包含は「端点・接触・共線の重なり」を **分類して返す**（捨てない）。`classifySegmentIntersection` は `none / point / overlap`、曲線は `point`（`tangent` 付き）/ `overlap`。
  既存の「内部のみ」の意味論は既存関数（`segmentIntersection` など）に残っている。
- 非有限（NaN / ±Infinity）の入力: `classifySegmentIntersection` は交差なし、`bboxOf` は `null`、`bezierBbox` は NaN の箱、`polygonMinDistance` は NaN、
  `integrateAdaptive` は有限時間で NaN、`flatten` は有限回で終わり NaN を含む点列を返す、`designatorNumber` は `RangeError`。無限ループ・巨大な配列は作らない。
- 折れ線化・円弧の区間数は `MAX_FLATTEN_POINTS` で打ち切る（巨大な半径でも有限）。
- 曲線の一般交差の細分には予算（候補 4096、ノード 100,000）があり、使い切ると **黙って捨てず**、`intersectCurvesDetailed` の `truncated: true` で知らせる。
  共線の線分・同一円上の円弧の重なりは細分の前に解析的に検出し `overlap` で返す。一般の Bezier の **部分的な重なりは検出しない**
  （制御点が完全に一致する場合などだけ `overlap`。[10](10_open_issues.md) L2）。
- 決定性: ループ順・再帰順は固定、`Math.random` / `Date.now` は使わない（core の ESLint 規則）。

保存精度: JSON の数値は JavaScript の最短表記で往復厳密（有限の double は `JSON.parse(JSON.stringify(x)) === x`）なので、実数座標の量子化は不要。
スナップ（グリッド・半タイル・自由）はエディタ側の機能とする。

## 4. 幾何ライブラリの構成と API の概要（`src/core/geometry/`、依存なし）

| ファイル | 内容 |
|---|---|
| `vec.ts` | 既存（`Vec2` / `Tile`、`distance`、`segmentIntersection`、`pointOnSegmentInterior`、`isIntegerPoint`、`snapToOctant` ほか）。**既存関数は変更せず**、追加のみ。`rasterizePolygon` / `rasterizeSegment` は `raster.ts` へ移し、`vec.ts` から再エクスポート |
| `frames.ts` | §1 |
| `angle.ts` | §2 |
| `tolerance.ts` | §3 |
| `bbox.ts` | `bboxOf`、`bboxUnion`、`bboxExpand`、`bboxIntersects`、`bboxContainsPoint` |
| `segment.ts` | `classifySegmentIntersection`（端点・共線を分類）、`closestPointOnSegment` |
| `curve.ts` | `Curve`（`line` / `arc` / `quad` / `cubic`）と共通ディスパッチ: `evaluate` `derivative` `tangentBearingDeg` `curvature`（符号付き）`length` `reverse` `split` `bbox` `flatten`（弦高誤差を保証）`closestPoint` `arcLengthTable` `tAtLength` `pointAtLength` `rasterizeCurve`。`Path = readonly Curve[]` は型だけで、**Path に対する操作は未実装** |
| `arc.ts` | 円弧: `arcFromBulge` `arcFromThreePoints` `arcFromTangent` `fillet`（直線 2 本と半径からのフィレット） |
| `bezier.ts` | de Casteljau、導関数・曲率・分割、導関数の根による厳密な bbox |
| `integrate.ts` / `arclength.ts` | 適応ガウス–ルジャンドル（5 点）、累積長の表と Newton 補正（二分法フォールバック）による s → t |
| `intersect.ts` | 曲線同士の交差: line–line / line–arc / arc–arc は解析解、一般（Bezier）は bbox の細分 + Newton。結果は t1 昇順・重複除去。`intersectCurvesDetailed` は `truncated` を返す |
| `polygon.ts` | `signedArea` `orientation` `isConvex` `satOverlapConvex`（凸、接触は重ならない）`polygonContains` `polygonsOverlap`（単純多角形、境界の接触は false）`polygonMinDistance` |
| `stroke.ts` | `rectAlong` / `rectAlongDir`（旧 `runwayRect` と同一の演算順・頂点順）、`strokePolyline`（join / cap / miterLimit）、`offsetCurve`。自己交差はクリップしない（仕様） |
| `raster.ts` | `rasterizePolygon` / `rasterizeSegment`（本体は 1 文字も変えずに移動）、`rasterizeCurve` |
| `camera.ts` | 画面 ↔ Map の変換（既存。`tileCenter` のみ `worldToMap` 経由に変更、ビット同一） |
| `index.ts` | 公開 API の集約（`camera.ts` は別系統のため含めない） |

Phase 11 で既存コードに適用した載せ替え（すべてゴールデンと一致を確認済み）:

- `layout/runway.ts`: `headingVector` を `GRID8_STEP` の表引きに、`runwayRect` を `rectAlongDir` に。`runwayAxis(r)` を追加（下記）。
- `sim/routes.ts`: `headingOf` → `dirToBearing`、`turnAngleAt` → `turnAngleDeg`（式は同一）。
- `±0.5` の置換: `sim/query.ts`、`sim/context.ts`、`sim/ground.ts`、`airside/network.ts`、`layout/pick.ts`、エディタ入力（演算が同一になる箇所のみ）。演算順が変わる箇所は置換していない。
- `io/migrate.ts`: レイアウト版の移行（v1 → v2）を 1 か所に集約（`serialize.ts` と `project.ts` の 3 か所から呼ぶ）。

### `runwayAxis`（`layout/runway.ts`）

```ts
interface RunwayAxis {
  start: WorldPoint; end: WorldPoint;
  dir: Vec2;            // 始点 → 終点の単位方向
  trueHeadingDeg: number; // 真方位 [0, 360)
  lengthT: number;      // 長さ（タイル）。丸めなし。斜めは √2 倍
  lengthM: number;      // 実長（m、四捨五入）。runwayLengthM と同じ
}
```

Phase 11 時点は従来形（8 方位）のみ対応だった。**Phase 12 で滑走路を判別共用体（`RunwayGrid8 | RunwayFree`）にし、`runwayAxis` は自由形にも対応した**（`r.length` / `r.heading` の直接参照はコンパイルエラーに従ってすべてこのアクセサへ。従来形の式は不変）。

### 描画用の面（`layout/surfaces.ts`）と 2D/3D の整合

- 形状（滑走路の舗装・着陸帯、誘導路・道路の帯）は core の `surfaces.ts` が **World フレーム・タイル単位** で生成し、2D は `worldPolyToMap`、3D は `worldPolyToScene` で変換して描く。
  形状を 2D と 3D で別々に作らない。Phase 11 時点の滑走路の面は従来の占有フットプリントと同じ形だった。**Phase 12 で `runwaySurfaces(r, layout)`（舗装・肩・着陸帯・RESA・標示・番号）を追加**し、2D/3D の滑走路はこれを使う（従来形の舗装は実寸の幅で表示）。既存の `runwayPavementSurface` / `runwayStripSurface` は占有の多角形のまま残している（[23](23_runway_design.md) §9）。
- 幅は m の表を 1 つだけ持つ: `TAXIWAY_DRAW_WIDTH_M = { S: 15, M: 23, L: 30, codeF: 38 }`、`ROAD_DRAW_WIDTH_M = { road: 12, rail: 8 }`（`model/catalog.ts`。ゲームの表示用の値）。
- S13 で修正した差異（PO 承認済み、表示のみ・運航と検証に影響なし）: 3D の滑走路だけ +0.5 タイルが抜けて北西に 12.5 m ずれていた／誘導路の幅が 2D（タイル単位の固定値・コード F 無視）と 3D（m・コード F 反映）で違った。
  2D の誘導路は 3D と同じ帯の形状で描き（節点に半幅の円を置いて角の隙間を埋める）、道路・鉄道の幅も m の表に統一した（以前より細くなる）。
  2D の混雑度ラベルの位置が World 座標のまま渡されて半タイルずれていた点も修正した。

## 5. ゴールデン基準値と再採取の方法

目的: 幾何基盤の導入や Phase 12 以降の変更が、既存レイアウトの検証・経路・運航の結果を **黙って変えない** ことを機械的に確認する。
`tests/golden/` に基準値、`tests/unit/golden*.test.ts` が照合する。

**入力レイアウトは JSON として凍結** している（`tests/golden/fixtures/*.layout.json`: `sample` / `starter` / `all-headings` / `stress`）。
編集操作（Phase 12/13 で挙動が変わりうる）が変わっても、ゴールデンの入力は変わらない。フィクスチャの生成関数は `tests/golden/layouts.ts`（編集操作の失敗は例外にする）。

| 基準値ファイル | 内容 | 運航に依存 |
|---|---|---|
| `geometry-{sample,starter,all-headings}.golden.json` | ネットワーク全体、検証の issue 一覧、全フットプリント、滑走路の多角形頂点・番号、`exportLayout` のハッシュ | — |
| `runway-table.golden.json` | 8 方位 × 長さ 8 通りの端点・実長・多角形 | — |
| `project.golden.json` | 固定プロジェクト（運航状態なし）の `serializeProject` のハッシュ | — |
| `sim.golden.json` | サンプル空港 × サンドボックス会社の 24 時間運航（状態ハッシュ・KPI） | ○ |
| `sim-midrun.golden.json` | +3 時間で保存 → 検証 → 復元し、元と復元後を +2 時間進めた状態が一致（ハッシュ） | ○ |
| `stress-sim.golden.json` | **ストレス運航**: 平行 2 滑走路・斜め（45°）誘導路・滑走路横断（南の滑走路を横切って北の滑走路へ）・12 スポットのレイアウトを、会社なし・1 日 120 往復で 2 シード × 3 時間。状態ハッシュ・統計・横断回数・ホールドショート待ち ティック数。**横断 > 0 をテストで検査** | ○ |
| `routes.golden.json` | 各スポット × 滑走路 × 滑走路上ノードの出発・到着経路の `nodes`・`cum`・各頂点の `turnAngleAt`・滑走路ノード手前の停止位置（`holdShortDistance`）。サンプルとストレスのレイアウト | — |
| `project-sim.golden.json` | 運航状態入り（サンプル +2 時間）の `serializeProject` のハッシュ | ○ |
| `normalized-hashes.golden.json` | **版に依存しないハッシュ**（下記） | — |
| `sim-versions.json` | 運航ゴールデンを採取したときの `SIM_MODEL_VERSION`（再採取の保護用） | — |

ストレス運航の統計は、検証した範囲では `goArounds` = 0、`conflicts` = 0 だった（横断・ホールドショート待ちは発生）。
着陸復行・競合を起こすレイアウトの追加は今後の課題（[10](10_open_issues.md) L5）。

### 照合と再採取

```
npx vitest run tests/unit/golden                 # 照合（通常の実行）
GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.test.ts      # 再採取（既存の基準値）
GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.ops.test.ts  # 再採取（ストレス・経路・運航状態入り・版非依存ハッシュ）
GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.midrun.test.ts
GOLDEN_FIXTURES_UPDATE=1 npx vitest run tests/unit/golden.fixtures.test.ts   # 入力フィクスチャの再生成（全基準値の再採取が必要になる）
```

- 再採取は **意図した挙動変更のときだけ**。幾何基盤の導入・リファクタでは更新してはならない（`git diff tests/golden` が空であること）。
- **SIM_MODEL_VERSION の保護（設計 D10）**: 運航に依存するゴールデン（上表の「○」）は、内容が変わるのに `SIM_MODEL_VERSION` が `sim-versions.json` の記録と同じなら、
  `GOLDEN_UPDATE=1` でも **再採取を拒否して例外** にする。既存レイアウトの運航結果を変えるときは、先に `SIM_MODEL_VERSION` を上げる
  （上げると保存済みの運航状態は復元されず建設モードで開く。docs/21）。再採取に成功すると記録を現在の版に更新する。
- **版に依存しないハッシュ**: `exportLayoutSha256`（`geometry-*.golden.json`）と `project.golden.json` は `schemaVersion` を含むため、
  **SCHEMA_VERSION を 3 に上げる版（Phase 12）で 1 度だけ再採取される想定** である（この 2 種は版に敏感）。
  `normalized-hashes.golden.json` は `schemaVersion`（レイアウトの項目と `versions.layoutSchema`）を除いたハッシュなので、
  版の更新だけなら変わらない。**再採取のとき、このファイルが変わらないことが「版番号以外は何も変わっていない」証拠** になる。
  既存の基準値のバイト同一性を保つため、従来のハッシュの形式は変えず、新しいファイルに追加した。

## 6. データモデルの計画（Phase 12〜16）

6.1（滑走路）は **Phase 12 で実装済み**（実装の記録は [23](23_runway_design.md)。下の型は計画時の記述で、実装では `dims` を自由形だけに持たせ、`magneticVariationDeg` に加えて `ruleSet`・`designatorSuffix` を持つ）。
6.2 以降は **未実装**で、Phase 11 では `TaxiwayEdge` を変えていない。

### 6.1 滑走路（Phase 12・実装済み）

```ts
interface RunwayBase { id; name; surfaceWidthM: 30 | 45 | 60; buildState; dims?: RunwayDims }
/** 従来形（v1/v2 のデータはすべてこれ）。意味は永久に不変 */
interface RunwayGrid8 extends RunwayBase { alignment?: undefined; start: Tile; heading: Heading; length: number /* ステップ数 */ }
/** 自由方位 */
interface RunwayFree extends RunwayBase { alignment: 'free'; start: WorldPoint; headingDeg: number /* 真方位 */; lengthM: number /* 正 */ }
type Runway = RunwayGrid8 | RunwayFree;
interface AirportLayout { …; magneticVariationDeg?: number /* 東偏差を正、既定 0 */ }
```

- 従来形の端点・長さは完全一致: `end = start + GRID8_STEP[heading] × length`、`lengthM = round(length × |step| × 25)`（斜めは √2）。
- 自由形は端点を保存せず、`headingDeg` と `lengthM` が正（`end = start + bearingToDir(headingDeg) × lengthM / 25`）。番号は保存した方位から決まる（端点からの逆算はしない）。
- 自由形から従来形への自動変換はしない（斜めの √2 長は自由形で厳密に表せないため）。変換は UI の「グリッドに合わせる」で明示的にのみ行う。
- 占有フットプリント（検証・ゲーム値）と舗装・着陸帯・RESA の実寸（表示・クリアランス用・ICAO Annex 14 の参考値を `Sourced` で出典つきに持つ）を分離する。
  `dims` を持たない従来形は従来フットプリントのまま（既存の検証結果は不変）。`HOLD_SHORT_M = 87.5` は従来形の値として固定。
- 実寸表示・UI には「参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません」と明示する。

### 6.2 誘導路エッジの形状（Phase 13）

```ts
interface TaxiwayEdge { …既存…; geometry?: EdgeGeometry }   // 欠落 = from → to の直線
type EdgeGeometry =
  | { kind: 'arc'; bulge: number }                    // tan(中心角/4)、符号 = 向き。ノード移動に追従
  | { kind: 'cubic'; h0: Vec2; h1: Vec2 }             // 端点からの相対ハンドル（タイル）
  | { kind: 'compound'; parts: { via: WorldPoint; shape: 'line' | { bulge: number } | { h0: Vec2; h1: Vec2 } }[] };
```

- 向きは常に from → to（逆走は `reverse`）。論理長は `round(弧長 × 25)`、直線は既存式 `round(distance × 25)` の分岐を守る。
- フィレットは保存しない派生形状（必要になればノードに `filletRadiusM?`）。分割時の ID 保持は既存の `splitEdge` と同じ規則（前半が元 ID）。
- ストア時の変換を担う `edgeCurve(from, to, geometry)` と、`Path` 上の操作（`pathLength`、`pathPointAtLength`、`pathFlatten`、`pathClosestPoint`）は **未実装**（Phase 13/15 の前に追加が必要。[10](10_open_issues.md) L4）。
- 既存の「交点がタイル中心のときだけ交差点を作る」（`layout/network.ts`）は既存データの検証結果に関わるため、変える場合も既存データの検証が変わらないことを確認する。

### 6.3 Phase 14/15/16 への含意

- 機体の実寸（`Sourced` の official）とゲーム値（`game`）の区別は既存方式を踏襲。脚配置・操向角などは Phase 14 でカタログに追加（未調査は `unset` + 推定値）。
- 曲線上の運動（Phase 15）: 直線エッジのみの経路は現行の `pointAt` / `turnAngleAt` / 旋回速度制限をそのまま使う（角の内側を切る「コーナーカット」は導入しない）。
  曲率による速度制限は `geometry` を持つエッジにのみ適用し、既存結果を変えない。
- クリアランス（Phase 14）には、距離ベースの `pathMinDistanceToPolygon` / `pathMinDistanceToPath` を追加する（`polygonsOverlap` などは単純多角形を仮定し、`strokePolyline` / `offsetCurve` は自己交差しうるため）。未実装。

## 7. 版の方針

| 版 | Phase 11 | 上げる時点（計画） | 移行 |
|---|---|---|---|
| `SCHEMA_VERSION` | 2 のまま（**Phase 12 で 3 に更新済み**。[27](27_migration_and_compatibility.md)） | Phase 12（`alignment` / `dims` / `magneticVariationDeg` を保存できる時）→ 3。Phase 13 の `geometry` は任意項目なので同じ 3 に含める案（推奨）か 4 | v2 → v3 は恒等（`schemaVersion` のみ更新）。移行は `io/migrate.ts` の 1 か所。旧アプリは v3 を「未対応の版」として拒否（既存の処理） |
| `PROJECT_FORMAT_VERSION` | 1 | ファイル構造が変わるときだけ（Phase 11〜15 では予定なし） | — |
| `CATALOG_VERSION` | 不変 | Phase 14（脚配置・操向角などを機種に追加） | 保存済みの機種データに新項目が無い場合は `status: 'unset'` + ゲーム推定値で補う |
| `ASSET_VERSION` | 不変 | Phase 16（表示のみ） | — |
| `SIM_MODEL_VERSION` | `skyport-sim-10.0` のまま | **既存の（v2 で表現できる）レイアウトの運航結果が変わるときだけ** | 変えると保存中の運航状態は復元されず建設モードで開く。曲線レイアウト専用の新しい挙動は、既存レイアウトの結果が同一である限り版を上げずに追加できる |

Phase 11 は **どの版も上げていない**（データと運航の計算を変えないため）。詳しい保存形式は [21](21_save_format.md)。

## 8. リスクと対策

| # | リスク | 深刻度 | 検知 | 対策 |
|---|---|---|---|---|
| R1 | リファクタで浮動小数点のビットが変わり運航結果がずれる | 高 | ゴールデン、`project.test` の再開一致、旧式をテスト内に複製したオラクルの `===` 比較 | 既存述語は不変。置換は演算順が同一の箇所のみ。位置は m にしない |
| R2 | ゴールデンの網羅不足で差異を見逃す | 中 | §5 | 8 方位の専用レイアウト、ストレス運航（横断・斜め）、経路、運航状態入りの保存 |
| R3 | フレームの混同（±0.5） | 高 | `frames.lint`、2D/3D の頂点の突き合わせ | `frames.ts` に一元化、命名規約 |
| R4 | 新旧の許容誤差の混在でノード接続・交差判定が変わる | 中 | ゴールデン（network / validation） | 既存経路は既存述語のみ。新しい述語は新データ（自由形・曲線）専用 |
| R5 | 曲線の数値計算の不安定（接線交差・退化 Bezier・Newton の発散） | 中 | 退化・性質テスト、監査テスト | 再帰深さ固定、二分法フォールバック、分類付きの結果、`truncated` の通知 |
| R6 | 方位の丸め境界（x5° の .5）で滑走路番号が変わる | 中 | designator のテスト | 方位は保存値を使う、1e-6 度に丸める |
| R7 | 磁偏差の符号誤り | 中 | 例題テスト（10°E・真 090° → "08"） | 型コメントと本書に明記 |
| R8 | 滑走路の判別共用体化で広範囲の変更（Phase 12） | 中 | TypeScript のコンパイルエラー | `runwayAxis` を先に導入 |
| R9 | 実寸化（Phase 12/14）と「既存結果不変」の衝突 | 高 | ゴールデン | 実寸は `dims` / 自由形 / 曲線のみに適用。既存への適用は明示操作（空港ごとの「実寸ルール」切替、既定は従来） |
| R10 | `SIM_MODEL_VERSION` の変更で保存中の運航状態が失われる | 中 | ゴールデン + 再採取の保護（§5） | 既存経路を分岐で保持し版を上げない設計 |
| R11 | v3 を旧アプリで開けない | 低 | 既存のエラー表示 | 仕様として許容（docs/21） |
| R12 | 表示変更（誘導路幅の統一、3D 滑走路位置）への違和感 | 低〜中 | e2e | 独立コミット（実施済み） |
| R13 | 実寸・規定値を安全適合と誤解される | 中 | レビュー | 「参考値・ゲーム内の判定・適合を保証しない」の定型文、`Sourced` の状態表示 |
| R14 | 曲線同士の交差判定のコスト（Phase 13 の検証が O(n²)） | 中 | 性能テスト | bbox の前段判定、空間ハッシュ（Phase 13） |
| R15 | Phase 11 の範囲拡大 | 中 | レビュー | 型（`Heading` / `Runway`）は変えない |

## 9. PO の決定（2026-11-11）

- Q1: S13（3D の滑走路ずれ修正、誘導路の表示幅を m の表 S15 / M23 / L30 / codeF38 に統一）を Phase 11 で実施（独立コミット）。→ **実施済み**。
- Q2: 実寸判定（翼端クリアランス、曲率速度制限）の既存空港への適用は、空港ごとの「実寸ルール」切替（既定は従来）。→ Phase 14/15 で実装（未実装）。
- Q3: 従来形の滑走路を、表示のみ実寸の舗装幅で描画（占有・検証は従来のまま）。→ **Phase 12 で実施済み**（S12、独立コミット）。
- Q4: 磁気偏角は空港ごとの手入力（地磁気モデル・年変化なし）。→ **Phase 12 で実施済み**（空港の設定）。
- Q5: 従来形と自由形で判定基準が異なることを許容（UI で区別表示）。→ **Phase 12 で実施済み**（「従来」/「実寸」のバッジ・タグ）。
