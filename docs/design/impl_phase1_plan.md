# フェーズ 1 実装計画・要件

- 根拠: docs/42 §2・§4・§5、docs/39 §4.1・§4.2・§6.1・§10.2〜10.3・§11.4・§12.8。各再現テスト（`tests/audit/known-issues/*`、`tests/audit/e2e-known/*`）を「完了の定義」とする。
- 共通の約束:
  - ゴールデンはフェーズ中に更新しない。`SIM_MODEL_VERSION`（`src/core/scenario/scenario.ts:21`、現在 10.3）は両トラックとも変更しない。版の扱いは 1-23 で決める。
  - 既存テストの期待値は変えない。
  - `HANDOFF_PROMPT.md` と docs/42 の状況欄は**コーディネーターだけ**が更新する（同時編集を避けるため）。
- 調査中に**新たに見つけた不具合（Z-1）**: `updateEntity` の stand ケース（`src/core/layout/operations.ts:1032-1043`）の検証項目が `name/size/buildState/codeF` だけしかない。
  - そのため、プロパティ画面の `prop-remoteBoarding`・`prop-busGateId`（`src/ui/PropertiesPanel.tsx:578,590`）を変更すると、必ず「値が不正です」で失敗する。
  - これを検出するテストは存在しない。1-11 で一緒に直す（U8）。

---

## 0. 着手前の共通作業 C0（コーディネーター、S サイズ、両トラック開始前に 1 コミット）

両トラックが参照する型・文言を先に入れておき、途中で型検査が赤くならないようにする。

| ファイル | 追加内容 |
|---|---|
| `src/core/model/types.ts` `Stand` | `/** 所属ターミナル（K-1）。欠落=従来の自動 */ terminalId?: string;` |
| `src/core/terminal/model.ts` `GateAccess` | `/** 2 つ以上のターミナルに接し所属を決められない（T-1） */ ambiguousTerminalIds?: string[];` |
| `src/core/economy/planning.ts` `PlanIssueCode` | `'GROUND_SUPPORT_MISSING'` を追加 |
| `src/core/sim/types.ts` `Aircraft` | `/** 運航者が指定したスポット（reassignStand, E-3） */ requestedStandId?: string;` |
| `src/i18n/ja.ts` `PLAN_ISSUE_LABEL` | `GROUND_SUPPORT_MISSING: '燃料施設・整備士・トーイングカーのいずれかがなく、折り返し（給油・点検・プッシュバック）ができない'` |

確認: `npm run typecheck`

---

## 1. ファイルの持ち主（両トラックで同じファイルを触らない）

| 対象 | 持ち主 | 他方のトラックが必要なとき |
|---|---|---|
| `src/core/sim/**`、`src/core/economy/**`、`src/core/access/**`、`src/core/aircraft/**`、`src/core/terminal/**`、`src/core/analytics/**` | **S** | U は「関数のシグネチャ・戻り値」の追加を S に依頼する |
| `src/core/layout/**`、`src/core/validation/**`、`src/core/model/**`（C0 以降）、`src/core/io/**`、`src/editor/**`、`src/ui/**`、`src/render/**`、`src/i18n/ja.ts`（C0 以降） | **U** | S は検証コード・文言・保存時の検証の追加を U に依頼する（本書に事前に記載済み） |
| `tests/unit/sim/**`、`tests/unit/economy*.test.ts`、`tests/unit/capacity.test.ts`、`tests/unit/regression/s_*.test.ts`、`tests/audit/*` のうち sim・経済系 | S | — |
| `tests/unit/{operations,validation,editor*,project}*.test.ts`、`tests/unit/regression/u_*.test.ts`、`tests/e2e/**` | U | — |
| docs: 13, 15, 17, 19, 31, 33, 36, 41 | S | — |
| docs: 21, 26, 29, 32, 34, 35, 37, 39 §6.2 の該当行, 09, 10, 11, 08 | U | 1-11 の運航側の挙動は S が U に文案を渡す |
| docs/22・23・42、`HANDOFF_PROMPT.md` | コーディネーター | — |

- 再現テストは、修正後に `tests/unit/regression/`（Vitest の include `tests/unit/**` に入る）または `tests/e2e/` へ移し、元のファイルは削除する（docs/42 §4.3）。
- `tests/audit/*_helpers.ts` は複製せず、`../../audit/b_helpers` のように相対パスで import する。
- 同じ作業ツリーで並行して作業するときの注意:
  - 各タスクの後は**対象を絞ったテスト**だけを実行する。
  - `npm test` 全件・`npm run build`・`npm run test:e2e` は、同期点（S・U の各ブロック終了時）にコーディネーターがまとめて実行する。
  - E2E（ポート 4173）と `vite build` は U だけが実行する。

---

## 2. 項目ごとの設計

### 1-01 道路・交通網ツールが既定値で引ける（V-1）— U
- **原因**:
  - 既定値 `roadCapacityPerHour: 0`（`src/editor/store.ts:273`）が、そのまま `addRoadPath` に渡されている（`src/editor/tools.ts:286`、`src/editor/input.ts:80`）。
  - `addRoadPath` は 0 以下を `INVALID_VALUE` として拒否する（`src/core/layout/operations.ts:552`）。
- **変更**: 2 か所の呼び出しで、`...(o.roadCapacityPerHour > 0 ? { capacityPerHour: o.roadCapacityPerHour } : {})` のように 0 のときは渡さない。
  - コアの「明示した 0 は不正」という規則は変えない（既存テストを保つため）。
  - 接続設備（`PropertiesPanel.tsx:349`）はすでに同じ書き方で正しい。
- **互換性**: エディタだけの修正。保存形式・運航結果は変わらない。
- **テスト**:
  - `tests/e2e/levels.spec.ts` に V-1 の 5 種類を移す。
  - 通常の E2E に「道路を引くと建設費が引かれる」テストを追加する。
  - 単体テスト `tests/unit/regression/u_roadDefaultCapacity.test.ts`: `computePreview` で能力 0 → 成功（キー `capacityPerHour` なし）、能力 600 → 値が入る、能力 -1 → 入力欄の側で 0 に丸められる。

### 1-02 階層接続設備が重なりエラーにならない（V-2）— U
- **原因**:
  - 接続設備の辺は、同じ位置の端点タイルで、上下の階をまたぐ高さ（`src/core/layout/footprint.ts:135-140`）を占有する。
  - そのため、両側の階の通路と高さの範囲が交わる。`walkway|walkway` は両立する組（`COMPATIBLE`）に入っていないので `OVERLAP` になる（`src/core/validation/validate.ts:378`）。
- **変更**: `validate.ts` の `judge()` の先頭に `roadJunction(aId, bId, at)` の判定を加える。次の 3 つをすべて満たすとき、重なりを報告しない。
  - (a) 両方が `layout.roads` の辺である。
  - (b) 共有するノード n がある。
  - (c) 少なくとも一方が接続設備（`connectorKind` があるか、両端の階が異なる）で、かつ `at` が n のタイル。
- **互換性**: 検証の結果だけが変わる（運用可否 → 階層をまたぐ通路が「運用可能」になる）。サンプルやスターター空港には接続設備がないので、ゴールデンは変わらない。
- **テスト**: `known-issues/v_connectorOverlap` → `tests/unit/regression/u_connectorOverlap.test.ts`（3 種類）。回帰として次を追加する。
  - 同じ階で 2 本の通路が交差 → `OVERLAP` のまま。
  - 接続設備の途中のタイルが、無関係な第 3 の通路と交わる → `OVERLAP`。
  - スロープ（ramp、端点の距離 > 0）の端点 → エラーにならない。

### 1-03 クリックでの選択を表示と一致させる（V-3・V-4）— U
- **原因**:
  - `pickAt`（`src/core/layout/pick.ts:13`）が、階層・建物内設備（`parentFacilityId`）・内部表示の状態を見ていない。
  - 描画は `src/render/MapRenderer.ts:231`（`!f.parentFacilityId && level===mapLevel`）と `:784` で絞っている。
  - `src/editor/input.ts:104,119` では、ターミナルのエリアが内部設備より先に選ばれる。
- **選択の規則**（描画と同じ条件にする）:
  1. 内部表示がオンのとき: 階 `floorIndex === interiorLevel` の内部設備（親の種類は問わない）→ `pickTerminalArea`（その階）→ 以下の通常候補、の順。
  2. 通常候補: ノードは `mapLevel==='all' || (n.level??0)===mapLevel`。独立施設は `!parentFacilityId && (mapLevel==='all' || facilityLevel(f)===mapLevel)`。道路の辺はどちらかの端が表示中の階にあるもの。滑走路・誘導路・スポットは常に描画されているので常に候補にする。
  3. 内部表示がオフのとき、内部設備は候補にしない。親のプロパティに出す子の一覧から選ぶ。
  4. 重なった候補を選び分ける方法: 候補が 2 つ以上なら、プロパティ画面の先頭に小さな選択欄を出す。クリックのたびに循環させる方式は、ドラッグで移動する操作と衝突するので採らない。
- **変更**:
  - `pick.ts` に次を追加する。`view` を省略したときは従来の結果と完全に同じにする（既存の呼び出し・テストを保つ）。
    - `export interface PickView { mapLevel: number | 'all'; interior: { shown: boolean; level: number } }`
    - `pickCandidatesAt(layout, world, view?): string[]`
    - `pickAt(layout, world, view?)`
  - `input.ts:104,119` を `pickCandidatesAt` に置き換え、先頭の候補を選ぶ。
  - `store.ts` に `pickCandidates: string[]` を追加する。
  - `PropertiesPanel.tsx`:
    - 候補の選択欄 `data-testid="pick-candidates"`、各ボタン `pick-candidate-<id>`。
    - 施設の子の一覧 `data-testid="interior-children"`、各項目は既存の `EntityLink`。
- **互換性**: UI だけの変更。保存・運航に影響しない。
- **テスト**:
  - `e2e-known/levels.repro` の V-3・V-4 → `tests/e2e/levels.spec.ts`。
  - 単体テスト `tests/unit/regression/u_pick.test.ts`:
    - 同じ位置に地上と地下 1 のノード → 表示中の階のノードだけが選ばれる。
    - 内部表示オン・階が一致 → 内部設備がエリアより優先される。
    - 階が不一致 → 選ばれない。
    - `mapLevel 'all'` → 従来どおり。
    - `view` 省略 → 従来の結果と一致する。
    - 重なりの候補の順序。
  - E2E: 選択欄で候補を切り替えられる。格納庫の子の一覧から内部設備を選べる。

### 1-04 置けない階の理由を出す・内部設備の階を後から変える（V-5・V-6・W-6・W-10）— U
- **原因**:
  - プレビューが失敗すると `wrap` が `null` を返す（`src/editor/tools.ts:252-253`）ので、`commitPreview`（`input.ts:64-68`）は何も表示せずに終わる。
  - 階の選択肢は、親の階数に関係なく固定（`src/ui/Toolbox.tsx:126` は -5〜2、`:134` は 0〜2）。
- **制約**: 既存のテスト（`tests/audit/a_levels.audit.test.ts:108-115`、`tests/unit/operations.test.ts:94`）が `{ok:false, reason:'INVALID_VALUE'}` を厳密に固定している。
  - そのため、コアの失敗コードや戻り値の形は変えず、理由は**エディタ側で導く**。
- **変更**:
  - 新しいファイル `src/core/layout/levelRules.ts`（純粋関数）:
    - `interiorPlacementProblem(layout, parentId, floorIndex, tiles): 'floorOutOfRange' | 'outsideParent' | null`
    - `terminalAreaLevelProblem(layout, terminalId, level): 'floorOutOfRange' | null`
    - `levelsInUse(layout, facilityId, newLevels): boolean`（範囲外の階に、エリア `terminalAreas` または子の設備がある）
  - `tools.ts`: 内部の分岐を `computeOp(s) → {result, extra} | null` に切り出す。
    - `computePreview` は成功したときだけ返す（従来どおり）。
    - `input.ts` の `commitPreview` は `computeOp` を使い、失敗したときは `showToast(PLACEMENT_PROBLEM_LABEL[problem] ?? OP_FAILURE_LABEL[reason], 'error')`（`quietNoChange` は従来どおり）。
  - `ja.ts` に `PLACEMENT_PROBLEM_LABEL` を追加:
    - `floorOutOfRange: '選んだ階はこの建物にありません（建物の階数の範囲外です）'`
    - `outsideParent: '建物の範囲の外には置けません'`
    - `levelsInUse: '上の階にエリアや設備があるため、階数を減らせません'`
  - `Toolbox.tsx:126,134`: 選択肢は残す（再現テストが `selectOption('1')`・`level-2` を使うため）。親の階数を超える階には「（この建物にはありません）」と表示し、`title` に理由を入れる。
  - `PropertiesPanel.tsx:676`: 内部設備の階を `<select data-testid="prop-floorIndex">` に変える。選択肢は -5〜親の階数−1。`updateEntity({floorIndex})` は既存の機能を使う（`operations.ts:1091`）。
  - ターミナルの階数を入力するとき、`levelsInUse` が真なら変更する前に理由を表示する（W-10）。
- **互換性**: なし（UI だけ）。
- **テスト**:
  - V-5・V-6 → `tests/e2e/levels.spec.ts`。E2E に階の変更を追加する。
  - 単体テスト `tests/unit/regression/u_levelRules.test.ts`: 境界値（階数−1 は可、階数は不可、-5 は可、-6 は不可）、親の外、エリアがある階を減らす。

### 1-05 階層表示の整理（W-1・W-2・W-8）— U
- **変更**:
  - `MapRenderer.ts:735` の施設ラベルに、表示中の階の条件（`mapLevel!=='all' && facilityLevel(f)!==mapLevel` なら出さない）を加える（W-1）。
  - `drawInterior`（`MapRenderer.ts:780-790`）:
    - 内部設備の描画をエリアのループの外へ出す。現状はエリアの数だけ重ねて描かれ、その階にエリアがないと描かれない。
    - すべての親（格納庫なども）の内部設備を、`floorIndex===interiorLevel` のときに描く（W-2）。1-03 の選択の規則と一致させる。
  - 表示条件は `src/render/labels.ts` に純粋関数 `visibleFacilityLabelIds(layout, mapLevel, interiorShown)` と `visibleInteriorFacilityIds(layout, interiorLevel)` として切り出し、単体テストする。
  - W-8:
    - `ja.ts` に `CONNECTOR_KIND_LABEL`（stairs 階段 / escalator エスカレーター / elevator エレベーター / ramp スロープ / railRamp 鉄道の勾配区間 / pipeRiser 燃料管の立ち上がり）を追加する。
    - `displayName` の road 分岐（`ja.ts:145`）: `connectorKind` があり、名前が空か種別の内部名と同じなら、和名と番号で表示する。
    - `Toolbox.tsx:118` の `f.name || f.kind` を `f.name || FACILITY_LABEL[f.kind]` に変える。
    - 保存データ（`operations.ts:588` の `name`）は変えない。
- **テスト**:
  - 単体テスト `tests/unit/regression/u_labels.test.ts`。
  - E2E（`levels.spec.ts`）: `facility-parent` の選択肢に `baggageSort` が出ず「手荷物仕分け場」と出る。接続設備を選ぶと `prop-title` に「階段」と出る。

### 1-06 建設ツール箱が低い画面でもスクロールできる（U-1）— U
- **原因**: `.toolbox { flex: none }`（`src/ui/styles.css:91`）で、`.left` に overflow の指定がない（`styles.css:79`）。
- **変更**: `.left > .toolbox { flex: 0 1 auto; min-height: 0; overflow-y: auto; }` を追加する。運航画面の `.toolbox.ops` には影響しない。
- **テスト**: `e2e-known/toolbox.repro` → `tests/e2e/toolbox.spec.ts`（1280×720・1600×900）。1920×1080 で、スクロールしなくても従来どおり表示されることを回帰として確認する。

### 1-07 バスゲート一時閉鎖後の旅客の取り残し（P-1）— S（1-11 と同じタスク）
- **原因**:
  - 明示バスゲートが閉鎖されると、`applyBusDeparture`（`src/core/sim/apronBus.ts:96-114`）が、搭乗開始前のたびに選び直して `p.gateId=null` にする。
  - `reconcileDepartureGate(null)`（`passengers.ts:349-357`）が、まだ来ていないグループの `terminalId` を null にする。
  - 再開後は `previousGateId` が null なので、`passengers.ts:227` の条件が偽になり、ゲートを付け直さない。
  - 来たグループは `stranded/noGate`（`:570-573`）になる。`stranded` で `area` がないグループは、復帰する分岐がない（`:660-666`）。
- **変更**（1-11 のゲート固定と合わせて行う）:
  1. 旅客を生成した後のバスゲートは固定する（1-11）。そのため、閉鎖されても `p.gateId` を null にしない。グループはゲート工程で `waitingFacility` として待ち（既存 `:713`）、再開すれば搭乗する。
  2. `passengers.ts:227` を `if (p.generated && p.gateId && previousGateId !== p.gateId) reconcileDepartureGate(...)` にする。null から新しいゲートへ変わったときも付け直し、null へは付け直さない。
  3. 防御: `stepGroup` の `case 'stranded'` で、`!g.area && g.reason==='noGate' && g.terminalId` のときは `toAirport` に戻し、`reason` を消す。旧版の進行中データにも効く。
- **締切までに再開しなかったとき**: 既存どおり、締切で `facilityClosed`（待機中）または `late` として乗り遅れにする。別のターミナルへ回すことも、取り残すこともしない。
- **テスト**: `known-issues/b_busGateReopen` → `tests/unit/regression/s_busGateReopen.test.ts`。追加するケース:
  - 締切まで閉鎖が続く → 全員 `facilityClosed`、`checkInvariants`・`checkPaxInvariants` が空、人数が保存されている。
  - 閉鎖が搭乗開始後 → 従来どおり。
  - 生成前に閉鎖・再開 → 生成が再開まで待つ。
  - 保存 → 復元 → 継続した結果が、続けて運航した結果と一致する。

### 1-08 重なった滑走路閉鎖が解除されない（R-1）— S
- **原因**: `closeRunway`（`src/core/sim/disruptions.ts:285-291`）が、すでに閉鎖中のときも `d.prev = 'closed'` を記録する。
- **変更**: すでに閉鎖中で、同じ滑走路に有効な `runwayClosed`・`maintenance` の障害 x があるときは、`d.prev = x.prev` を引き継ぐ。`reopenRunway` は変えない。手動で閉鎖していた場合（有効な障害がない）は、従来どおり `'closed'` を記録する。
- **結果への影響**: 同じ滑走路に閉鎖が重なったときだけ変わる（ランダムな障害がある運航では起こり得る）。
- **テスト**: `known-issues/c_runwayOverlap` → `s_runwayOverlap.test.ts`。A と B の終わる順序を逆にした場合、3 つ重ねた場合、手動閉鎖 + 障害（障害が終わっても閉鎖のまま）。

### 1-09 欠航・ダイバート便の手荷物が最終状態にならない（B-1）— S
- **原因**: `reconcileDepartureBags`（`src/core/sim/baggage.ts:186`）は、地上作業（`ground.ts:419,577`）からしか呼ばれない。
- **変更**:
  - `closeBoarding`（`passengers.ts:302`）で `forced === 'cancelled'` のとき、`missGroups` の後に `reconcileDepartureBags(sim, f.id, true)` を呼ぶ。
  - 手荷物の旅客グループが `cancelled` のときは、`groundStats.bagsLeftBehind` を加算せず、`onBagLeftBehind` の罰金もかけない（欠航の補償は別にある）。状態は `leftBehind`（未積載）または `offloaded`（積載済み）にする。
- **結果への影響**: 欠航が出る日は、仕分け場・積み込みの負荷が減るので結果が変わり得る（stress / game-weather 系）。
- **テスト**: `known-issues/b_bagsCancelled` → `s_bagsCancelled.test.ts`（600 秒の上限は維持）。追加: 積み込み後の欠航 → `offloaded`。欠航で `bagsLeftBehind` が増えない。乗り遅れ（missed）は従来どおり数える。`activeBags` が単調に増えない。

### 1-10 2 つのターミナルに接するゲートを推測しない（T-1）— S（モデル）、U（検証）
- **原因**: `src/core/terminal/model.ts:171` の `.find` が、最初に見つかったターミナルを採用する。
- **変更（S）**:
  - 隣接するターミナルを `filter` ですべて集める。
  - 接続先の明示（`connectedTo`）があるときは、従来どおりの扱い（`:174-178`、変えない）。
  - 明示がなく隣接が 2 つ以上のとき: `{terminalId:null, boarding:null, deplane:null, ambiguousTerminalIds:[...]}` とする。
- **変更（U）**:
  - `validate.ts` に `GATE_TERMINAL_AMBIGUOUS`（error）。targets はゲート、related はターミナル群。
  - `ja.ts` の `ISSUE_TEXT`: `${n[0]} が複数のターミナル（${n.slice(1).join('・')}）に接しています。「接続先ターミナル」を指定してください`。
- **結果への影響**: 該当するゲートがあるレイアウトだけ（そのゲートは使えなくなる）。サンプル・スターターは 1 ターミナルなので影響なし。
- **テスト**: `known-issues/b_gateTwoTerminals` → `u_gateTwoTerminals.test.ts`（U、S の変更が入った後）。追加: `connectedTo` を指定すれば null にならない。1 つのターミナルにだけ接するゲートは従来どおり。

### 1-11 リモートスポットのターミナル属性と、旅客生成後のゲート固定（K-1）— S（運航・決定規則）、U（データ・検証・画面・保存・文書）

**データ（C0 で追加済み）**: `Stand.terminalId?: string`。
- 名前は、既存の `GateAccess.terminalId`・`PaxGroup.terminalId` に合わせた。
- 欠落 = 従来の自動。null は保存しない（キーを削除する）。

**決定規則（S、`src/core/terminal/busGateAssignment.ts` の `resolveBusGateForStand`）**。計画・検証・画面・運航がこの 1 つの関数を共有するので、すべてに同時に反映される。

| remoteBoarding | terminalId | 結果 |
|---|---|---|
| `'none'` | 任意 | 従来どおりバスなし。terminalId は無視（検証は info） |
| `'bus'` + busGateId | 未設定 | 従来どおり |
| `'bus'` + busGateId | 設定あり | ゲートの所属が terminalId と一致するときだけ使う。不一致は `failure:'invalidGate'`（代わりのゲートは探さない） |
| `'auto'` / 欠落 | 未設定 | 従来どおり、最も近い使えるゲート |
| `'auto'` / 欠落 | 設定あり | 候補を `status.terminalId === terminalId` のゲートに絞り、その中で最も近いもの。なければ `failure:'unconfigured'`（別のターミナルへは移さない） |
| 固定スポット（ゲート付き） | 任意 | ゲートで決まる（属性は無視、検証は info） |

**ゲートの固定（S、`apronBus.ts:applyBusDeparture`）**:
- 搭乗開始前の選び直しを、`p.generated` が真になった後はやめる。
- 固定したゲートを使い続ける条件: `p.generated && priorGate` で、かつ priorGate が現在のスポットの設定を満たすこと（`'bus'` なら `priorGate===stand.busGateId`、そうでなければ `!stand.terminalId || 所属===stand.terminalId`）。この判定では閉鎖を無視する。状態を持たない判定なので、保存する項目は増えない。
- 固定したゲートが閉鎖されたとき: `p.gateId` は維持し、旅客はゲート工程で待つ。再開すれば搭乗する。締切までに再開しなければ `facilityClosed` で乗り遅れる（1-07 と一致）。
- 機体のスポットが変わり、上の条件を満たさないとき: 選び直し、既存の `reconcileDepartureGate`（ターミナル間の移動・連絡設備）に任せる。
- 到着側（`applyBusArrival`）は、生成済みならすでに固定されているので変更しない。

**旧データ**:
- `terminalId` のない旧データは、決定規則は従来どおり。変わるのは「生成後の固定」だけ。
- 影響するのは、生成後にバスゲートが閉鎖される場合と、スポットが変わる場合。ランダムなゲート故障の候補はコンタクトゲート（`standGate`）だけなので（docs/29 §2）、障害のない旧レイアウトの結果は変わらない。

**検証（U、`validate.ts:1043` 付近のリモートスポットのループと、固定スポットの処理）**:

| コード | 重大度 | 条件 | ja 文言 |
|---|---|---|---|
| `STAND_TERMINAL_INVALID` | error | terminalId の施設がない、またはターミナルでない | `${n[0]} の所属ターミナルが見つからないか、ターミナルではありません` |
| `STAND_TERMINAL_NO_BUS_GATE` | error | auto かつ terminalId があり、そのターミナルに両方向とも使えるバスゲートがない | `${n[0]} の所属ターミナル ${n[1]} に、搭乗口・降機口の両方へ接続した使えるバスゲートがありません` |
| `STAND_TERMINAL_MISMATCH` | error | `'bus'` の busGateId の所属が terminalId と異なる | `${n[0]} の接続バスゲート ${n[1]} は所属ターミナルと別のターミナルにあります` |
| `STAND_TERMINAL_IGNORED` | info | 固定スポット、または `'none'` に terminalId がある | `${n[0]} の所属ターミナルは使われません（${固定スポット/バス不使用}）` |

terminalId を指定した auto スポットについては、既存の `STAND_BUS_NO_GATE` の判定を、そのターミナルのゲートに絞った一覧で行う。

**操作・保存（U）**:
- `operations.ts` の `finalize`（`:124` 付近）: terminalId の施設がない・ターミナルでないときはキーを削除する（`connectedTo` と同じ扱い）。
- `updateEntity` の stand に検証項目を追加する（Z-1 の修正を含む）:
  - `remoteBoarding ∈ {'auto','bus','none'}`
  - `busGateId`: null またはバスゲート
  - `terminalId`: null ならキーを削除、文字列ならターミナル
- `src/core/io/project.ts`:
  - `:261` 付近に検証を追加: `スポット ${s.id} の所属ターミナル（terminalId）が不正です`。
  - `layoutUsesFormat2`（`:44`）に `s.terminalId !== undefined` を追加する。
  - **保存形式の版は上げない**（既存の 2 で書く）。

**画面（U、`PropertiesPanel.tsx:575-605`）**:
- リモートスポットで `remoteBoarding!=='none'` のとき、`<select data-testid="prop-standTerminal">` を出す（「自動（バスゲートで決定）」と各ターミナル）。
- terminalId を指定したときは、`prop-busGateId` の候補をそのターミナルのゲートに限る。
- 運航中は注記を出す: 「旅客を生成した後は搭乗ゲートを固定します（閉鎖中は再開を待ちます）」。

**文書（U、S が運航側の文案を渡す）**:
- docs/29: §2 の表にスポットの `terminalId` 行。§3.1 に選択の規則と固定。§7 の「ゲートの故障」行を「旅客生成前なら選び直す／生成後は固定し待機、締切までに再開しなければ facilityClosed」に変える。
- docs/32: §3・§4。
- docs/35: §2.1・§2.3・§7（「1 便の出発旅客は 1 ターミナル」が、生成後は保証されること）。
- docs/26 §6（検証コード）、docs/21（v2 の項目）、docs/39 §6.1（決定済み K-1）。

**テスト**:
- S: `tests/unit/sim/standTerminal.test.ts`（新規）。
  - 正常: auto + T2 指定 → T2 のゲートだけを使う。到着・出発とも T2。
  - 境界: T2 のゲートがすべて閉鎖 → 生成しない・busFailure。生成後に閉鎖 → 待機 → 再開後に搭乗。
  - 異常: 不一致の bus 指定 → 生成しない。
  - 回帰: terminalId なしの旧レイアウトで、障害なしなら結果が完全一致（ハッシュを比較）。
  - 決定性、保存 → 復元 → 継続の一致。
- **監査テストの更新（意図した変更）**: `tests/audit/b_multiTerminal.audit.test.ts:164`（「到着後に閉鎖 → 別ターミナルへ再選択」を固定しているテスト）を、K-1 の挙動（固定して待機）に更新し、理由を記録する。`:79` は生成前の再選択なので変わらない見込み（実行して確認する）。
- U:
  - `u_standTerminal.test.ts`: `updateEntity` の 3 項目（Z-1 の回帰を含む）、`finalize` でターミナルを削除したときの掃除、検証 4 コード、保存の往復、版が 2 になること、不正な terminalId の読み込みエラー。
  - E2E `tests/e2e/standTerminal.spec.ts`: スポットで所属ターミナルを選ぶ → 表示に反映される。`prop-remoteBoarding` を変更できる（Z-1）。

### 1-12 夜間待機後の到着がダイバートされない（D-1）— S
- **原因**:
  - `setHold`（`src/core/sim/simulation.ts:231-240`）が、待機の理由が変わっても `waitSince` を更新しない（`??=`）。
  - ダイバートの判定（`:1100`）は、今の理由が `noiseCurfew` でないかだけを見る。
- **変更**: `setHold` で前の理由を保持し、`prev === 'noiseCurfew'` から別の理由に変わったときは `waitSince = now` にする（夜間待機の時間を、45 分の上限から除く）。
- **結果への影響**: 都市設定（夜間制限）のある運航だけ。
- **テスト**: `known-issues/d_curfewDivert` → `s_curfewDivert.test.ts`。追加:
  - 夜間待機 → 通常の待機が 45 分を超えた → ダイバートする（上限は生きている）。
  - 待機アラートの待ち分数が、夜間明けから数えられる。

### 1-13 大型機が 06:00 より前に離陸しない（D-2）— S
- **原因**:
  - 予測（`simulation.ts:756-758`）は連続式 `sqrt(2D/a)`。
  - 実際の積分（`:1017-1018`、`speed+=a; dist+=speed`）は離散で 1 tick 先行する。
- **変更**: `takeoffRollSec(type)` = 1 tick ずつの積分で `D` に届く最小の tick 数 × `TICK_SEC` とし、`departureBlocked` の予測をこれに置き換える。`startTakeoff` の tick とのずれ（0 か 1）は単体テストで確定させる。
- **結果への影響**: 夜間制限のある運航だけ。
- **テスト**: `known-issues/d_curfewTakeoffEarly` → `s_curfewTakeoff.test.ts`。追加: カタログの全機種で、予測した離陸時刻と実際の `dep.actual` が一致する（機種ごとにループ）。M・S 級の回帰（06:00:00）。

### 1-14 スポット変更が割当済みの到着機にも効く（E-3）— S（運航）、U（保存時の検証）
- **原因**: 並び順の `homeSet` 優先（`simulation.ts:607-612`）が、計画スポットより先に評価される。
- **変更**:
  - `reassignStand`（`disruptions.ts:324-345`）で `ac.requestedStandId = standId` を設定する。
  - `assignStand` の並び順の先頭キーに `Number(b.id===ac.requestedStandId) - Number(a.id===ac.requestedStandId)` を加える。
  - そのスポットへ割り当てに成功したら `delete ac.requestedStandId`。
- **保存（S → U へ依頼）**: `project.ts:340` 付近（heldCrossings の検証の隣）に、`requestedStandId` は任意の文字列で、存在するスポットを指すことの検証を追加する。キーは値があるときだけ書く。版は上げない。
- **結果への影響**: `reassignStand` を使ったときだけ。監査テスト `e_hub`・`c_fuzz` は使っているので、実行して確認する（変わったら理由を記録して監査テストを更新）。
- **テスト**: `known-issues/e_reassignHome` → `s_reassignHome.test.ts`。追加: 割当前の変更（従来どおり）、変更先が閉鎖 → `CLOSED`、保存 → 復元 → 継続の一致、`requestedStandId` を割当後に削除。

### 1-15 燃料施設・整備士・トーイングカーがないと計画でエラー（E-2）— S
- **原因**: `analyzeDayPlan`（`planning.ts:252`）は `canOperate`（`compat.ts:220`、地上支援を見ない）だけを使う。一方、運航は `ground.ts:380`（noFuelFarm）・`:465`（noEngineer）で止まり続ける。
- **変更**: `analyzeDayPlan` の便のループ内で、`groundBlockers(ctx, type)` を 1 回だけ計算する。不足があれば `add('GROUND_SUPPORT_MISSING','error',f.key, detail)` とする。detail は不足の一覧を並べた文字列（例: `燃料施設・整備士`）。
  - 燃料施設なし: `!ctx.hasFuelFarm`
  - 整備士 0: `ctx.bases` の units で `engineer` が 0
  - トーイングカー 0: 同じく `tug` が 0
  - 給油車 0: ハイドラントにつながったスポット（`ctx.hydrantStands`）がないとき
  - `operableTypes` と `canOperate` は変えない（重複判定を避ける）。
- **結果への影響**: 運航結果は変わらない。計画分析の出力が変わる。`ManagementPanels.tsx:269` などは既存の表示のまま出る。
- **テスト**: `known-issues/e_noFuelFarmPlan` → `s_noGroundSupportPlan.test.ts`。整備施設なし・トーイングカー 0・ハイドラントあり＋給油車 0（エラーなし）・サンプル空港（エラーなし）。

### 1-16 バス・鉄道の定員を超えて受け入れない（E-1）— S
- **原因**: `src/core/access/runtime.ts:195` の `while (h < hour + 6 ...)` が 6 時間で打ち切り、そこで定員を無視して加算する。
- **変更**:
  - 先読みを `hour + 24` にする。
  - `cap <= 0 || g.count > cap` のとき、または 24 時間以内に空きがないときは、満車の駐車場と同じ方式で `choose(acc, r, ['dropoff','taxi','walk'])` へ切り替え、`transitFull++` する。
  - 定員を超えて加算する経路はなくす。
- **結果への影響**: 6 時間を超える繰り延べが出る極端な過負荷のときだけ。
- **テスト**: `known-issues/e_transitOverbook` → `s_transitOverbook.test.ts`。鉄道でも同じ確認、定員 0、24 時間を超える需要では手段を切り替えること。`tests/audit/e_access.audit.test.ts:251` が合格し続けること。

### 1-17 既存 E2E の失敗 3 件・不安定 1 件 — U
- `gamemodels.spec.ts:56,93`:
  - **原因（確定）**: 8582bc1 で `new-game-setup`・`tab-settings` が、折りたたまれたメニュー `settings-menu`（`src/ui/App.tsx:310-311`）の中へ移った。同じファイルの `new-career` はすでに `settingsAction` に移行済み。
  - **変更**: `:57` を `settingsAction(page,'new-game-setup')`、`:96,101` を `settingsAction(page,'tab-settings')` にする。テストを新しい画面構成に合わせるだけで、期待値は変えない。
- `opslayout.spec.ts:111`（修理後もアラートが 1 件残る）:
  - **原因は未確定**。手順: `npx playwright test tests/e2e/opslayout.spec.ts:111 --trace on` で残ったアラートの key を記録する。
  - 候補 (a): `hold:<ac>` のアラート（`alerts.ts:219-231`）。`waitSince` が 1-12 と同じ理由で引き継がれ、閉鎖が終わった後も残る。1-12 の修正後に再確認する。
  - 候補 (b): イベント窓の `diverted`・`paxMissed`（`alerts.ts:189-210`）。
  - 判定: 閉鎖から派生したアラートがすでに不要なのに残る → 製品側を修正する。閉鎖とは無関係の正当なアラート → テストの前提の誤りなので、「障害のアラート `alert-disruption:*` が 0 件」と検査する案にし、**オーナーの承認が必要**とする。
- `dayloop.spec.ts:47`（不安定）:
  - **原因は未確定**。手順: `--repeat-each=10 --trace on` で、`speed-60` が選ばれないときの `ops.clock.speed` と `pausedSpeed` を記録する。
  - 調べる箇所: `src/editor/simRunner.ts:87`（`toReviewPhase`）、`:143-170`（`runHeadless` の `finish('night')`）、`:296-305`（`nextDay`）、モジュール変数の `pausedSpeed`（`:387`）、`frame()` が古い `clock` を書き戻すこと（`:118`）。
  - 製品側の競合であれば修正する。テストの待ち時間を延ばすだけの対応はしない。
- 合格基準: `npx playwright test --repeat-each=3` で 4 件とも安定して合格する。

### 1-18 `economy.test.ts` の 2 件 — S
- **事実**:
  - `DailyKpi.avgDelayMin` は「評価対象の遅延」（`company.ts:114`）。
  - 外部要因の到着遅延を控除し、到着の遅れのうち折り返しの余裕を超えた分を出発遅延から控除している（`src/core/economy/delayEvaluation.ts`、`ops.ts:396-397`）。docs/36 §26-31 の仕様どおり。
  - 実績の遅延は `actualAvgDelayMin`（`company.ts:117`）。
  - 航空会社の定時性の評価は `clamp(otp/minOtp*100)`（`airlineScore.ts:113-120`）なので、OTP が最低基準以上だと 100 で頭打ちになる。
- **手順**:
  1. 2 つのシナリオについて、`avgDelayMin / actualAvgDelayMin / otp / airlineSatisfaction / 航空会社別の評価要素` を一時的なログで採取する（コミットしない）。
  2. 判定:
     - (i) 371 行: busy の `actualAvgDelayMin` が基準より大きく、評価対象の遅延だけが 0 なら、テストの意図（混雑で運航上の遅延が増える）は実績の遅延を指している。→ `busy.kpi.actualAvgDelayMin` を基準の同じ値と比べるよう変更を提案する。
     - (ii) 407・408 行: 両方とも OTP が最低基準以上で、定時性の点数が頭打ちになり満足度が同じなら、テストの前提（作業員不足 → 満足度低下）は現行仕様と合わない。→ 案 A: シナリオの作業員を、OTP が最低基準を下回る値に強める（期待値は変えない）。案 B: 期待を `toBeLessThanOrEqual` にする（弱体化にあたるので採らない）。**A を推奨。**
     - いずれも**オーナーの承認が必要**。採取した値と根拠を docs/design の本書に追記する。
     - 遅延の評価にコード上の誤りが見つかった場合（例: `turnaroundBufferSec` の既定、`dep.block` が null のときの 0 扱い）は、コードを直してテストはそのままにする。

### 1-19 能力ダッシュボードの見やすさ — S（`src/core/economy/capacity.ts`）、U（`src/ui/CapacityPanel.tsx`）
- **S の変更**（`summary` の末尾に追加し、既存の並びは変えない）:
  - AS-4: `スポットの回転数`（movements/h）= 運用中スポット数 ÷ 計画の平均占有時間（`departureAt-arrivalAt+STAND_GAP_SEC`、時間）× 2。計画が空なら null。
  - AS-6: `空港全体の離発着能力`（movements/h）= min（滑走路、スポットの回転数、折り返し能力 × 2 ÷ 平均の折り返し時間）。誘導路は未算出なので除外し、根拠に明記する。`AirportCapacitySnapshot` に `overall: { capacity: number | null; limitedBy: 'runway' | 'stand' | 'turnaround' | null }` を追加する。
  - AS-5: `analyzeAirportCapacity` に 6 番目の任意引数 `live?: { closedRunwayIds: readonly string[]; closedStandIds: readonly string[] }` を追加し、滑走路・スポットの数から除く。根拠に「運航中の閉鎖を反映」と書く。
  - AC-1: `空港アクセス（合計）` pax/h・pax/day = 使える手段の `modes[m].capacityPerHour` の合計。1 つでも null があれば合計は null（未算出）とし、根拠に手段名を挙げる。
  - AC-2: 出入口・車寄せ・駐車場・バス乗り場・タクシー乗り場の行を `facilities` に追加する（容量は既存の分析値。実績は未算出と明記）。
  - HB-7 の一部: `capacity.ts:177` の連絡設備で、能力が未設定なら `terminalLinkCapacityPerHour(link)` を表示し、根拠に「未設定（運航では既定値 N 人/時を使用）」と書く。
- **U の変更**:
  - `CapacityPanel.tsx:43` で、運航中は `live` を渡す（`sim.state.runwayConfig[*].mode==='closed'`、`sim.state.closures.stands`）。
  - 全体のカード `data-testid="capacity-overall"` と、制約名 `capacity-overall-limit` を追加する。
- **テスト**:
  - S: `tests/unit/capacity.test.ts` にケースを追加（閉鎖でスポット数が減る、制約名、アクセスの合計が null になる条件、連絡設備の既定値）。
  - U: `tests/e2e/capacity-nav.spec.ts` に、全体のカードと制約名が表示されることを追加。

### 1-20 折り返し能力に資源を反映（TA-2）— S
- **変更**: `turnaroundCapacity`（`planning.ts:242-250`）:
  - トーイングカー 0・整備士 0・燃料施設なしのいずれかなら 0。
  - 給油の制約を `fuelTruck*2 + ctx.hydrantStands.size` にする。
  - 1 台あたりの処理数は根拠がないので作らない。トーイングカー・整備士は「有無」として扱う。
  - ランプバスは式に入れず、根拠の欄に記載する（今後の課題）。
- **結果への影響**: 運航結果は変わらない。`GROUND_OVERLOAD` と ダッシュボードの値が変わる。
- **テスト**: `capacity.test.ts` に各資源が 0 のとき 0、ハイドラントで給油車 0 でも正の値。既存の値を固定しているテストが落ちる場合は、仕様変更として理由を記録する。

### 1-21 振り返りの天候・全便欠航の罰則・不満の連続日数（S-2〜S-4）— S（必要なら画面は U）。**まず再現テストを書き、再現した場合だけ修正する**
- S-2:
  - `review.ts:384` の障害一覧には `state.wx`（天候 5 段階）の変化が入らない。
  - 再現した場合: レビューに任意項目 `weather?: { maxLevel: WxLevel; changes: { t: number; level: WxLevel }[] }` を追加する。
  - U: `DayReview.tsx:209` で、天候の変化があれば `DAY_LOOP.noDisruptions` を出さず、`review-weather` を表示する。
- S-3: `company.ts:521` の `if (r && r.flights > 0) delta -= cancelPenalty(r)` で、全便欠航なら `flights` が 0 になるか確認する。再現した場合は条件を `(r.flights > 0 || r.cancelled > 0)` にする。
- S-4: `airlineEval.ts:155-167` で、45〜55 の帯では `low[k]` が戻らない。仕様が「連続」なら、帯の中で `low[k]=0` にする（不満そのものは解消しない）。
- **テスト**: `s_reviewWeather.test.ts`、`s_cancelPenalty.test.ts`、`s_complaintStreak.test.ts`。
- **結果への影響**: S-3・S-4 は経営（航空会社の評価）の結果が変わる → game-models 系。

### 1-22 文書の更新（docs/39 §6.2）— U（コーディネーターが担当する docs/22・23 を除く）
- 実装に合わせて次の文書を直す。
  - docs/11 §11: スポットの手動変更は実装済み。
  - docs/09 と README: 都市イベントは実装済み、今後の表から実装済みの項目を除く。
  - docs/10 O6・O7: 実装済み。
  - docs/08: 件数・パスは現状に、fast-check は未導入と記載。
  - docs/06:157: `src/i18n/ja.ts`。
  - docs/14 §9: 工期あり。
  - docs/02 §8: 0〜100。
- 各項目の文書（上の各項目に記載）も更新する。版（10.0 / 10.3）の記述は 1-23 で扱う。

---

## 3. 既存レイアウトの運航結果が変わり得る項目（1-23 への入力）

| 項目 | 変わる条件 | 影響し得るゴールデン・監査テスト |
|---|---|---|
| 1-07 / 1-11 | 旅客生成後にバスゲートが閉鎖、または auto のスポットが変わる | golden.bus・golden.legacyRemote（バスゲートの閉鎖を含む場合）、監査 b_multiTerminal:164 |
| 1-08 | 同じ滑走路に閉鎖が重なる | golden.gameWeather・gameModels・stress（ランダムな障害がある場合） |
| 1-09 | 欠航がある日 | stress-sim・game-weather |
| 1-10 | 2 つのターミナルに接するゲート | 該当なし（サンプルは 1 ターミナル） |
| 1-12 / 1-13 | 都市の夜間制限 | game-models（都市設定がある場合）、監査 d_curfew |
| 1-14 | reassignStand を使った場合 | 監査 e_hub・c_fuzz |
| 1-16 | 6 時間を超える繰り延べ | 監査 e_access（現状の範囲では変わらない見込み） |
| 1-21 S-3・S-4 | 経営・航空会社の評価 | game-models、economy 系 |
| 1-02 / 1-04 | 検証（階層接続の運用可否） | v3 のレイアウトだけ。ゴールデンは対象外 |
| 1-01・03・05・06・15・17・18・19・20 | 運航結果は変わらない（計画分析・表示・テストのみ） | — |

運航結果は変わらないが、計画分析の出力が変わるのは 1-15 と 1-20。保存形式に任意の項目が増えるのは `Stand.terminalId`（版 2 で書く）と `Aircraft.requestedStandId`（運航状態）。どちらも版は上げない。

---

## 4. トラック別のタスク（順序・規模・実行するテスト）

各タスクの後に必ず実行する: `npm run typecheck`、`npx vitest run <対象>`。
各ブロックの終わりに実行する: `npm run lint`、`npx vitest run -c vitest.audit.config.ts`。

### Track S（シミュレーション・経済のコア）
| # | 項目 | 規模 | テスト |
|---|---|---|---|
| S1 | 1-08 滑走路閉鎖の重なり | S | `npx vitest run tests/unit/regression/s_runwayOverlap.test.ts tests/unit/sim/simulation.test.ts` |
| S2 | 1-12 夜間待機 → ダイバート | S | `npx vitest run tests/unit/regression/s_curfewDivert.test.ts`、`npx vitest run -c vitest.audit.config.ts tests/audit/d_curfew.audit.test.ts` |
| S3 | 1-13 離陸時刻の予測 | S〜M | `npx vitest run tests/unit/regression/s_curfewTakeoff.test.ts` |
| S4 | 1-09 欠航便の手荷物 | S | `npx vitest run tests/unit/regression/s_bagsCancelled.test.ts tests/unit/sim/ground.test.ts` |
| S5 | 1-16 バス・鉄道の定員 | S | `npx vitest run tests/unit/regression/s_transitOverbook.test.ts tests/unit/access.test.ts` |
| S6 | 1-10 モデル側（曖昧なゲート） | S | `npx vitest run tests/unit/independentGate.test.ts tests/unit/sim/multiTerminalPassengers.test.ts` → **U9 に引き渡し** |
| S7 | 1-07 + 1-11 運航・決定規則（U8 と並行。C0 の型だけに依存） | M〜L | `npx vitest run tests/unit/sim/standTerminal.test.ts tests/unit/regression/s_busGateReopen.test.ts tests/unit/sim/apronBus.test.ts tests/unit/sim/busGateAssignment.test.ts tests/unit/sim/busSave.test.ts`、監査 b_multiTerminal の更新 |
| S8 | 1-14 スポット変更 | S〜M | `npx vitest run tests/unit/regression/s_reassignHome.test.ts` → **U10 に保存時の検証を依頼** |
| S9 | 1-15 計画のエラー | S | `npx vitest run tests/unit/regression/s_noGroundSupportPlan.test.ts tests/unit/economy.test.ts` |
| S10 | 1-20 折り返し能力 | S | `npx vitest run tests/unit/capacity.test.ts` |
| S11 | 1-19 コアの能力値 | M | `npx vitest run tests/unit/capacity.test.ts` → **U11 に引き渡し** |
| S12 | 1-18 原因の採取と提案（承認待ち） | M | `npx vitest run tests/unit/economy.test.ts --testTimeout=300000` |
| S13 | 1-21 再現 → 修正 | M | 各 `s_*.test.ts`、`tests/unit/review.test.ts` → 画面が必要なら U12 へ |

S の文書（docs/13・15・17・19・31・33・36・41）は、各タスクと同じコミットで更新する。

### Track U（レイアウト・検証・エディタ・画面・描画・E2E）
| # | 項目 | 規模 | テスト |
|---|---|---|---|
| U1 | 1-06 ツール箱の CSS | S | `npx playwright test tests/e2e/toolbox.spec.ts --trace off` |
| U2 | 1-01 道路の既定能力 | S | `npx vitest run tests/unit/regression/u_roadDefaultCapacity.test.ts`、`npx playwright test tests/e2e/levels.spec.ts -g V-1 --trace off` |
| U3 | 1-02 接続設備の重なり | S | `npx vitest run tests/unit/regression/u_connectorOverlap.test.ts tests/unit/validation.test.ts`、監査 a_levels |
| U4 | 1-17 gamemodels の修正、opslayout・dayloop の調査（opslayout は S2 の後に再確認） | S + M | `npx playwright test tests/e2e/gamemodels.spec.ts tests/e2e/opslayout.spec.ts tests/e2e/dayloop.spec.ts --repeat-each=3 --trace off` |
| U5 | 1-03 選択 | M | `npx vitest run tests/unit/regression/u_pick.test.ts`、`npx playwright test tests/e2e/levels.spec.ts -g "V-3\|V-4" --trace off` |
| U6 | 1-04 階の理由・階の変更 | M | `npx vitest run tests/unit/regression/u_levelRules.test.ts tests/unit/operations.test.ts`、E2E V-5・V-6 |
| U7 | 1-05 ラベル・内部設備・和名 | M | `npx vitest run tests/unit/regression/u_labels.test.ts`、`npx playwright test tests/e2e/levels.spec.ts --trace off` |
| U8 | 1-11 データ・検証・保存・画面・文書、Z-1 | M〜L | `npx vitest run tests/unit/regression/u_standTerminal.test.ts tests/unit/project.test.ts tests/unit/projectFormat2.test.ts tests/unit/validation.test.ts`、`npx playwright test tests/e2e/standTerminal.spec.ts tests/e2e/busgate.spec.ts --trace off` |
| U9 | 1-10 検証コード（S6 の後） | S | `npx vitest run tests/unit/regression/u_gateTwoTerminals.test.ts` |
| U10 | 1-14 の保存時の検証（S8 の依頼） | S | `npx vitest run tests/unit/project.test.ts tests/unit/sim/gameSave.test.ts` |
| U11 | 1-19 画面（S11 の後） | S | `npx playwright test tests/e2e/capacity-nav.spec.ts --trace off` |
| U12 | 1-21 S-2 の画面（S13 で再現した場合） | S | `npx playwright test tests/e2e/dayloop.spec.ts --trace off` |
| U13 | 1-22 文書 | M | リンク・パスの確認だけ |

### 同期点（コーディネーター）
1. C0 → S と U を開始する。
2. S6 → U9、S8 → U10、S11 → U11、S13 → U12 の順に引き渡す。
3. 両方が終わったら、`npm run typecheck && npm run lint && npm test && npm run build && npm run test:e2e`、監査テスト 2 種、`AUDIT_KNOWN=1` で各再現テスト（残りがないこと）を実行する。
4. 1-23（ゴールデンの差分と主要 KPI を提示し、承認を得る）。

**リスク**:
- S7 と U8 は同じ機能の両半分。決定規則（S）と検証（U）の条件が食い違わないよう、本書 1-11 の表を唯一の仕様とする。
- U4 の opslayout は 1-12 の修正で変わる可能性があるので、S2 の後に再実行する。
- 1-18 と 1-17 の一部は承認待ちで止まり得る。他のタスクの進行を妨げない順にしてある。

---

## 5. 既定を置いて決めた未決事項（10 件）
1. `Stand.terminalId` を使うファイルは、既存の保存形式 2 で書く。版は上げない（旧版のアプリは属性を無視して従来の自動選択をするだけで、壊れない）。
2. `'bus'` 指定と terminalId が食い違う場合は、検証エラーにし、運航では `invalidGate`（旅客を生成しない）とする。別のゲートへは移さない。
3. 固定したゲートが閉鎖されたまま締切になった場合は `facilityClosed` で乗り遅れとし、別のターミナルへは回さない。固定スポット（コンタクトゲート）の扱いは変えない。
4. 旅客生成後に機体のスポットが変わった場合は、固定したゲートが新しいスポットの設定を満たせば維持し、満たさなければ選び直して既存のターミナル間移動に任せる。
5. 欠航便の手荷物は `leftBehind`・`offloaded` で終わらせ、`bagsLeftBehind` と積み残しの罰金には数えない（乗り遅れの手荷物は従来どおり数える）。
6. T-1: 接続先の明示がなく 2 つ以上のターミナルに接するゲートは、所属を null にして error を出す。明示があるときの挙動は変えない。
7. E-1: 先読みは 24 時間まで。空きがなければ車・タクシー・徒歩へ切り替え、`transitFull` に数える。
8. 1-15 の対象は燃料施設・整備士・トーイングカー。給油車 0 は、ハイドラントにつながったスポットがないときだけエラーにする。
9. TA-2: トーイングカー・整備士・燃料施設は「有無」として扱い、根拠のない 1 台あたりの処理数は作らない。ハイドラントのスポット 1 つを給油能力 1 として加える。ランプバスは式に入れない。
10. 重なった候補は、クリックのたびに循環させず、プロパティの選択欄で選ぶ（ドラッグでの移動を壊さない）。建物内設備は、内部表示がオンで階が一致するときだけクリックで選べ、それ以外は親の子の一覧から選ぶ。
