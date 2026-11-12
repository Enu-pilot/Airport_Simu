# 26. 検証ルール（滑走路に関するもの）

実装: `src/core/validation/validate.ts`（`analyzeLayout`）、占有の多角形は `src/core/layout/footprint.ts`・`runwayAreas.ts`。文言は `src/i18n/ja.ts`（`ISSUE_TEXT`）。
本書は滑走路・誘導路と滑走路の関係の検証コードを、旧（Phase 11 まで）と新（Phase 12）に分けて、いつ適用されるかを整理する。全コードの網羅は `IssueCode`（`validate.ts`）を参照。
ここにある数値はすべて **ゲーム内の判定** で、参考値は [23](23_runway_design.md) §4。**実際の安全基準への適合を保証しません。**

## 1. 判定基準（従来 / 実寸）と ruleSet

| 用語 | 意味 |
|---|---|
| 従来（classic） | 従来形（8 方位）の滑走路の判定。幅 3 タイル + 保護区域（半幅 3.5 タイル、両端 2.5 タイル延長）の整数ラスタ。結果は Phase 11 から 1 ビットも変わらない（ゴールデンで固定） |
| 実寸（real） | 自由形の滑走路の判定。舗装 + 肩・着陸帯・RESA の多角形。issue の `params.criterion = 'real'`（UI で「実寸」タグ） |
| `layout.ruleSet` | `'classic'`（既定・欠落）/ `'realistic'`。空港ごとの切替。`realistic` のとき、平行間隔・番号の重複の判定が従来形どうしにも適用される（Phase 12 ではこの 2 種のみ。実寸の判定の拡大は今後の版） |

混在する空港（従来形と自由形）は滑走路ごとに基準が決まる。組の判定は「関与する自由形の多角形 × 相手の占有（相手が従来形ならゲームの占有）」で、この非対称は仕様。
issue が出るのは、少なくとも一方が自由形の組、または `ruleSet = 'realistic'`（平行間隔・番号の重複のみ）のとき。従来形だけで `classic` のレイアウトでは、新しいコードはすべて空ループになる。

## 2. 旧コード（Phase 11 まで。意味は不変）

| コード | 重大度 | いつ | 備考 |
|---|---|---|---|
| `OUT_OF_BOUNDS` / `UNBUILDABLE_TERRAIN` | error | 滑走路の占有タイル（舗装。自由形は舗装 + 肩がかかるタイル）が敷地外・建設不可の土地にある | 着陸帯・RESA は対象外 |
| `OVERLAP` | error | 占有が重なる（従来形どうしは従来のラスタ判定）。**従来形どうしの滑走路の交差も `OVERLAP`**（交差点を作らない） | 自由形が関与する場合の扱いは §3 |
| `IN_RUNWAY_STRIP` | error | 誘導路・着陸帯以外の施設が着陸帯の中にある | 従来形は 87.5 m、自由形は半幅 140 m（既定） |
| `RUNWAY_TOO_SHORT` | error | `runwayMaxSize` が無い（長さ 1,200 m 未満で、どの区分の機体も使えない）。自由形は `round(lengthM)` で判定 | 長さ・幅の区分は従来どおり |
| `RUNWAY_NO_TAXIWAY` | error | 滑走路に誘導路が接続していない | 自由形は実数の位置のノードでも接続とみなす |
| `TAXIWAY_ON_RUNWAY` | error | 誘導路の両端が滑走路の中心線上にある（滑走路の上を走る） | 自由形は中心線への射影の距離 ≤ `POS_EPS_T` |
| `TAXIWAY_CROSSES_RUNWAY_NO_ENTRY` | error | 誘導路が滑走路を入口ノードなしで横切る | 自由形は内部の交差だけ（端点が中心線上の場合を除く） |
| `NO_RUNWAY` | error | 滑走路が 1 本もない | |

## 3. 新コード（Phase 12。自由形が関与するとき、または `realistic`）

| コード | 重大度 | 条件（ゲームの判定） |
|---|---|---|
| `IN_RUNWAY_RESA` | error | 誘導路・着陸帯・RESA 以外が RESA（着陸帯の両端から外側へ 90 m、全幅 = 舗装幅の 2 倍が既定）の中にある。誘導路・着陸帯・RESA は両立 |
| `RUNWAY_PARALLEL_TOO_CLOSE` | warning | 真方位の差が 1° 以内（逆向きを含む）で、長さ方向に重なる 2 本の中心線間隔が 210 m 未満（参考: EASA CS B.050、非計器・同時使用・コード 3〜4）。`params: { distanceM, refM: 210 }` |
| `RUNWAY_PARALLEL_DEPENDENT` | info | 同じ条件で 210 m 以上 1,035 m 未満（独立した計器運用の参考値 EASA CS B.055 未満）。**`ruleSet = 'realistic'` のときだけ** |
| `HOLD_SHORT_TOO_CLOSE` | warning | 自由形の滑走路のノードから誘導路を経路に沿って外へたどっても、すべての自由形の中心線（線分）から H（実寸の停止位置）以上離れる点に届かない枝がある（浅い角度・短い連絡誘導路・別の滑走路の保護区域の中に停止位置がある連続横断の幾何）。探索は他の滑走路ノード・行き止まり・max(3H, 300 m) で止める。`params: { runwayId, achievedM, requiredM }`。従来形の滑走路は対象外 |
| `RUNWAY_DESIGNATOR_CONFLICT` | warning | 接尾辞まで含めた番号が 2 本以上で同じ（手動の上書きの重複、4 本以上の平行など）。自由形が 1 本も関与しない組は `realistic` のときだけ |

「勾配」の issue（`RUNWAY_SLOPE_INFO`）は作らない（参考値が資料に無い）。標高と勾配は表示のみ。

### 自由形の重なりの判定（`OVERLAP` / `IN_RUNWAY_STRIP` / `IN_RUNWAY_RESA`）

- 自由形の領域（舗装 + 肩 `runway` 層、着陸帯 `strip` 層、RESA `resa` 層）は多角形。別の自由形の領域とは凸多角形の分離軸判定、従来形のタイルとは重なるタイルの正方形との判定。境界の接触は重ならない。
- 層の組の規則: `resa` は `strip` と同じ扱い。誘導路 × 自由形の舗装は、その誘導路が滑走路に接している（端が中心線上 ±`POS_EPS_T`、または中心線と 1 点で交差）なら許す。
- **交差する滑走路の組**（交差点ノードがある組）は、滑走路・着陸帯・RESA の相互の重なりを免除する。同一直線上の重なりと、中心線が交わらない舗装の重なりは `OVERLAP`。
- `at`（マップ上のマーカー）は最初に重なったタイル（自由形どうしは重なりの範囲の中心を丸めたもの）。

## 4. 運用可否

`operability` は既存の仕組み。滑走路に error があると `HAS_ERRORS`（運用不可）。`RUNWAY_PARALLEL_*`・`RUNWAY_DESIGNATOR_CONFLICT` は警告・情報なので運用を止めない。
保存・読込の検査（`checkLayout`）は [27](27_migration_and_compatibility.md) §4。

## 5. 古典（classic）と実寸（realistic）の違いのまとめ

| | classic（既定） | realistic |
|---|---|---|
| 従来形どうし | 従来の判定のみ | + `RUNWAY_PARALLEL_TOO_CLOSE` / `RUNWAY_PARALLEL_DEPENDENT` / `RUNWAY_DESIGNATOR_CONFLICT` |
| 自由形が関与 | 実寸の判定すべて（`ruleSet` に関係なく） | 同左 + `RUNWAY_PARALLEL_DEPENDENT`（情報） |
| 今後 | — | 機体の実寸を使う判定など（Phase 14/15）を追加する予定（**未実装**） |
