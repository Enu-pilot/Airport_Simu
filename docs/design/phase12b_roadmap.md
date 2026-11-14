# Phase 12B 設計: 運営体験の改善（ロードマップ）

作成: 設計リード（2026-11-12）。対象ブランチ: `claude/phase12-runway-design` の次。**設計のみ**（リポジトリは未変更）。
入力: `scratchpad/phase12b/po_request.md`（要望 1〜9）。識別子は英語、本文は日本語。

範囲が大きいので、1 つのフェーズではなく **段階的に届けるロードマップ** にする。

| 段階 | 内容 | シミュレーションへの影響 | 規模 | 詳細度 |
|---|---|---|---|---|
| **12B-1** | 運航モードの画面の作り直し・案内板風の運航表＋直接操作・アラート・あまり使わないパネルのオーバーレイ化・航空会社評価カード（既存データから導出） | **なし**（UI のみ） | M〜L（約 8 コミット） | 作業分解まで |
| **12B-2** | 1 日のループ（振り返り画面・1 日スキップ・日締めごとのオートセーブ＋日ごとの履歴） | **なし**（コアは読み取り専用の補助関数を足すだけ） | M（約 7 コミット） | 作業分解まで |
| **12B-3a** | 天候 5 段階・予報・難易度／航空会社の評価要素と不満（コア）／目標とマイルストーン | 選択した場合のみ（opt-in） | L | 設計＋バックログ |
| **12B-3b** | 都市モデル・アクセス鉄道の種別／騒音と夜間制限／イベント | 選択した場合のみ | L | 設計＋バックログ |
| **12B-4** | 時間帯の表現（2D/3D）／マニア向け（スポッティング記録・記録）／パイロット目線（追従カメラ・経路表示） | なし（表示）＋保存項目のみ | M | 設計＋バックログ |
| **U（後で）** | 地下レイヤ（道路・鉄道のトンネル・燃料ハイドラント・地下駅） | 選択した場合のみ（新しい施設を置いたときだけ） | XL | 実現性の素描 |

共通の厳守事項（全段階）:

- 既存の保存データは読める。**既存のプロジェクト・レイアウトの運航結果は、プレイヤーが選ばない限り完全一致**。`tests/golden/*` は 1 バイトも変えない。`SIM_MODEL_VERSION` は上げない。
- 新しい仕組みは会社（`CompanyState`）・プロジェクトに保存する **任意の項目** で有効化し、欠落 = 従来の挙動。**`createCompany` / `createCareerCompany` / `createSandboxCompany` の出力は変えない**（ゴールデンが使っている）。新しいゲームの既定値は UI 側の `newGame()` で付ける。
- 既存の e2e の期待は変えない（testid を保つ。§A.6 に対応表）。
- core は ui/render を import しない。決定性（シード付き乱数・core で `Date.now` を使わない）。
- 実在値とゲーム値を区別して表示し、実際の安全基準への適合をうたわない（天候の倍率・騒音・都市の数値はすべてゲーム値）。

---

## 0. ゲーム性の全体像（要望 8: PM としての方針）

「空港を拡張して、たくさん離発着させる」という一本の成長軸に、4 つの視点の楽しみを掛ける。どの段階も、どれかの視点の「やること」を増やすか、「結果が見える」ようにする。

| 視点 | 中心になる遊び | 主な段階 |
|---|---|---|
| 経営者 | 日々の収支・投資判断・契約・評判。振り返り画面で「今日どうだったか → 明日何に投資するか」 | 12B-2 振り返り、12B-1/3a 航空会社評価、3a 目標、3b 都市・鉄道 |
| 運航管理者 | 時間に追われる判断: 遅延・スポット変更・優先・天候への対応 | 12B-1 運航表の直接操作・アラート、3a 天候・予報、3b イベント・夜間制限 |
| パイロット | 自機の経路・待機・割り当て滑走路が見えて納得できる | 12B-4 追従カメラ・経路表示・「なぜ待っているか」 |
| マニア | 実在機種・記録・統計・珍しい機体 | 12B-4 スポッティング記録・記録・統計、Phase 16 塗装 |

テンポの設計: 小さい空港では **1 日スキップ** で早く回し、大きな日・悪天候の日は **ライブで介入** する。毎日の終わりに **振り返り** があり、**明日の見通し（予報・便数・工事完成）** が次の判断を促す。目標（マイルストーン）が中期の方向を与える。

「現在の修正も行いながら」: 実装者が進めている交差の不具合修正（C1）は Phase 12 の範囲で先に完了させる。12B-1/12B-2 はシミュレーションに触れないので並行して衝突しない。12B-3 はシミュレーションを触るので C1 の取り込み後に始める。

---

## A. 運航モードの画面（12B-1）

### A.1 方針

- 建設モードは **現状維持**（`BuildBottom`・左ツールボックス・右プロパティ）。`App` で `mode` により `BuildLayout` / `OperateLayout` を切り替える。
- 運航モードは「マップ中心＋左右の常設カード列＋マップ右上の運航表＋下部は選択中の詳細」。タブ切り替えはやめ、**常設カード** にする。
- 既存のパネル部品（`FlightBoard`・`TerminalBoard`・`GroundBoard`・`BaggageBoard`・`EventLog`・`DisruptionBoard`・`FinancePanel`・`PlanPanel`・`AccessPanel`・`ExpansionPanel`・`AnalyticsPanel`・`ScenarioPanel`・`CatalogPanel`・`ProjectPanel`・`IssuesPanel`）は **中身を変えずに再利用**し、「大きなオーバーレイ（詳細表示）」の中に置く。常設カードは **新規の小さい要約部品** で、見出しから同じ詳細オーバーレイを開く。
- これにより既存の e2e の testid（`tab-*` から開く中身）は同じ部品の同じ要素のまま残る。

### A.2 部品の木

```
App
├─ TopBar                         … 既存（建設/運航で中身が分岐。運航時は下記を追加）
│   ├─ start-ops / restart-ops / stop-ops（既存のまま）
│   ├─ skip-day（12B-2）・history（12B-2）
│   └─ OpsNav（運航時のみ。2 行目の小さなボタン列） … data-testid="tab-<k>"（§A.6）
├─ BuildLayout（既存の left / center / right / bottom をそのまま移す）
└─ OperateLayout（新規 src/ui/operate/OperateLayout.tsx）
    ├─ aside.ops-left（幅 280px、縦スクロール）
    │   ├─ OpsControls（既存。data-testid="ops-controls"。時計・倍率・運航状況・便の追加。滑走路行だけ RunwayCard へ移す）
    │   ├─ TodayKpiCard（新）        本日の KPI（暫定値）: 発着・定時率・平均遅延・旅客・収支
    │   ├─ RunwayCard（新・RunwayRow を再利用）  滑走路の状態と運用（runway-<id>・runway-mode-<id>・crossing-<id>）
    │   ├─ GoalsCard（12B-3a、未設定時は非表示）
    │   └─ WeatherCard（新）          天候・障害と対応（現在の天候、発生中の障害、対応ボタン。12B-3a で予報）
    ├─ main.ops-center
    │   ├─ Viewport（既存。2D/3D）
    │   ├─ FidsOverlay（新）          マップ右上の運航表（§A.3）
    │   ├─ AlertStack（新）           上部中央の重要通知（§A.4）
    │   ├─ DetailOverlay（新）        tab-* で開く大きなオーバーレイ（§A.5）
    │   ├─ StatusBar・Toast（既存）
    ├─ aside.ops-right（幅 300px、縦スクロール）
    │   ├─ TerminalCard（新）         処理施設の待ち（上位 4 施設）・館内人数・乗り遅れ
    │   ├─ GroundCard（新）           作業員・車両の稼働/故障、手荷物（仕分け・積み残し）
    │   ├─ AccessCard（新）           手段別の旅客、駐車場の満車率、乗り場の待ち
    │   ├─ ConstructionCard（新）     工事中の施設と残り日数（company.projects）
    │   ├─ AirlineCard（新、§A.7）    航空会社の評価（要約）
    │   └─ EventsCard（新）           最近のイベント 8 件（クリックで機体選択）
    └─ footer.ops-detail（高さ 200px、折りたたみ可）
        └─ 選択中: AircraftPanel（既存）/ PropertiesPanel（施設を選択したとき、既存）/ 何もなければ操作のヒント
```

- カードの共通部品 `Card({ title, testid, onOpen, children })`: 見出しクリックで詳細オーバーレイ、折りたたみ（`localStorage` に開閉状態だけ保存。シミュレーションに無関係）。
- 要約カードは `useOps()`（uiVersion 約 10Hz）で再描画。重い集計（`computeKpi` 相当）は **1 秒に 1 回** に間引く（`useThrottledMemo`）。
- `TodayKpiCard` は `computeKpi(sim, company)`（economy/ops.ts）を使う。これは読み取りのみであることを確認済み（`legsInPeriod`・統計の差分の計算だけ）。実装時に単体テストで「呼び出し前後で `JSON.stringify(sim.state)` が不変」を確認する。
- カードには `table.board` を使わない（e2e の `table.board tbody tr` が運航表を指すため）。カードは `div.card-rows`。
- 下部の詳細: `AircraftPanel` は CSS だけで横 3 列（状態・履歴 | 折り返し作業 | 対応）に並べる（`.ops-detail .properties { display:grid; grid-template-columns: … }`）。部品の中身・testid は不変。

### A.3 運航表のオーバーレイ（FIDS 風）

- 位置: マップ右上（`position:absolute; top:8px; right:8px`）。幅 `clamp(420px, 46%, 620px)`、高さ最大 `60%`。暗い背景・琥珀色の等幅文字・状態の色（定刻=白、遅延=琥珀、搭乗中=緑、欠航/ダイバート=赤）。「表示のみの演出で実在の案内板の再現ではない」。
- 切り替え: `出発 | 到着 | すべて`（既定: すべて）。`完了を隠す`。折りたたみ（見出しだけ残す）。`tab-flights` で **列の多い表示（従来の全列）** に切り替える（別の運航表を開かない＝testid の重複を作らない）。
- 列（標準）: 時刻（予定）/ 便名 / 行先・出発地 / 機種 / スポット / 状態（`AIRCRAFT_STATE_LABEL`＋待機理由）/ 遅延 / 操作。全列表示で従来の列（滑走路・旅客・遅延理由・予想/実績）を加える。
- e2e 互換の条件（必須）:
  - 表は `<table className="board fids">`、行は `tbody tr`、行に **機体の状態の文言（例: 到着処理中）** を含める。
  - `data-testid="flight-board"`（外枠）、`flight-${number}`、`pax-${number}`（全列表示時。標準表示でも非表示セルとして残すか、全列表示のみ — e2e では未使用なので全列表示のみでよい）。
  - 行クリック = 既存の `select()`（`ops.selectAircraft` + `actions.focus`）。
- **直接操作**（行の右端の `⋯` ボタン → 小さなメニュー。行クリックとは別のボタンなので選択と衝突しない）:
  - 遅延 +15 / +30 分 → `disruptionActions.delay(flightId, m)`（既存）
  - スポット変更 → 適合する空きスポットの選択 → `disruptionActions.reassignStand`（既存。候補は既存の `ResponseSection` と同じ計算を関数に切り出して共有）
  - 優先 → `disruptionActions.prioritize`（既存）
  - 機体へ移動 → `actions.focus`
  - testid: `fids-menu-${number}`、`fids-delay15-${number}`、`fids-delay30-${number}`、`fids-stand-${number}`、`fids-prio-${number}`。
  - 使えない操作は無効表示（`TOO_LATE` 等は既存の判定で、押すと既存のトーストを出す）。
- 行数は表示中の 40 行まで（スクロール）。全列表示は従来の 150 行。

### A.4 アラート（重要な出来事の整理）

- 純関数 `deriveAlerts(state, ctx, company, cursor) → { alerts: Alert[], cursor }` を `src/ui/operate/alerts.ts` に置く（UI 側。読み取り専用）。
  ```ts
  interface Alert { key: string; severity: 'critical' | 'warning'; t: number; title: string; count: number;
    target: { kind: 'aircraft' | 'runway' | 'stand' | 'area' | 'unit' | 'none'; id: string | null };
    actions: AlertAction[] }   // 'focus' | 'repair' | 'delay15' | 'reassign' | 'openPanel:<tab>'
  ```
- 対象: 重大（滑走路閉鎖・ダイバート・運航不能・競合検知・経営破綻の警告・悪天候 Lv4〔12B-3a〕）、注意（10 分以上の待機・保安検査の待ち 20 分超・積み残し・設備故障）。
- `key`（種類＋対象）で **まとめる**（同じ滑走路の閉鎖が続いても 1 件、`count` を増やす）。表示は最大 3 件、残りは「他 n 件」→ EventsCard。
- クリック → 対象へカメラ移動（＋機体なら選択）。ボタン → 既存の対応（修理 `disruptionActions.resolve`、遅延、スポット変更はメニューを開く、パネルを開く）。
- 既存のトースト（`toast`）は操作の結果表示として残す（アラートとは別）。
- testid: `alert-stack`、`alert-${key}`、`alert-focus-${key}`、`alert-act-${action}-${key}`、`alert-dismiss-${key}`。
- 閉じたアラートの key は UI の状態に持つ（保存しない）。

### A.5 大きなオーバーレイ（詳細表示・あまり使わないパネル）

- `DetailOverlay`: マップ中央と右列の上に重ねる（`grid-area: center / right`）。**上部バー・左列（ops-controls・倍率ボタン）は覆わない**（e2e で時計・倍率・stop-ops を押し続けるため）。
- 開く: `OpsNav` のボタン（`tab-<k>`）またはカードの見出し。閉じる: `×`（`overlay-close`）、Esc（入力欄にフォーカスがないとき。既存の `onKeyDown` より先に処理）、同じボタンをもう一度。
- モードが変わったら閉じる（`mode` の変化で `overlay = null`）。
- 中身は既存部品そのもの。

### A.6 e2e 互換の表（既存の testid → 新しい配置）

| testid（既存） | 現在 | 12B-1 後（運航モード） | 備考 |
|---|---|---|---|
| `start-ops` / `stop-ops` / `restart-ops` | 上部バー | 上部バー（不変） | stop-ops の確認ダイアログ・途中締めの挙動も不変 |
| `ops-controls` | 左（OpsControls） | 左列の先頭カード（同じ部品） | 滑走路行だけ RunwayCard へ |
| `sim-clock`・`speed-*`・`stat-*`・`add-arrival` | ops-controls 内 | ops-controls 内（不変） | |
| `runway-<id>`・`runway-mode-<id>`・`crossing-<id>` | ops-controls 内 | 左列 RunwayCard 内（同じ `RunwayRow`） | `runway.spec` は `runway-rwy_1` の文言のみ確認 |
| `toolbox` | 建設のみ | 建設のみ | 運航中は 0 件のまま（operations.spec） |
| `flight-board`・`flight-<n>`・`table.board tbody tr` | 下部タブ「運航表」 | マップ右上 FidsOverlay | 行に状態の文言を含める（§A.3） |
| `aircraft-panel`・`aircraft-history`・`aircraft-state`・`aircraft-model`・`aircraft-response`・`reassign-stand`・`prioritize`・`turnaround`・`task-*` | 右（AircraftPanel） | 下部 ops-detail（同じ部品） | |
| `tab-flights` | 下部タブ | OpsNav: 運航表の全列表示に切り替え | |
| `tab-terminal` → `terminal-board`・`close-<id>`・`pax-missed` | 下部タブ | OpsNav → DetailOverlay（TerminalBoard） | terminal.spec: その後 `tab-events` が見えること → OpsNav に常に表示 |
| `tab-ground` → `ground-board`・`units-*`・`break-*`・`random-failures`・`equipment-*` | 下部タブ | OpsNav → DetailOverlay（GroundBoard） | |
| `tab-baggage` → `baggage-board`・`bag-search` | 下部タブ | OpsNav → DetailOverlay（BaggageBoard） | ground.spec: 行クリック後に押す。オーバーレイは左列を覆わない |
| `tab-events` → `event-log` | 下部タブ | OpsNav → DetailOverlay（EventLog 全件） | EventsCard は要約（testid `card-events`） |
| `tab-disruptions` → `disruption-board`・`weather-now`・`disruption-*` | 下部タブ | OpsNav → DetailOverlay（DisruptionBoard） | WeatherCard の天候表示は `card-weather`（`weather-now` を重複させない） |
| `tab-plan`・`tab-finance`（`today-ledger`・`reports`・`kpi-*`）・`tab-access`・`tab-expansion`・`tab-analytics`・`tab-scenarios`・`tab-catalog`・`tab-project`（`project-*`）・`tab-issues` | 下部タブ | OpsNav → DetailOverlay（同じ部品） | management.spec / project.spec: 開いたまま `stop-ops` を押す → 上部バーは覆わない |
| 建設モードの `tab-*` | 下部タブ | **不変** | |
| `company-badge`・`cash`・`company-day`・`view-toggle`・`overlay-*`・`status`・`toast` | 上部バー・中央 | 不変 | |

既存の e2e で **変わる操作はない**（すべて同じ testid・同じ部品で到達できる）。唯一の注意: `kpi-otp` は FinancePanel 内のみ（TodayKpiCard は `today-kpi-*` という別の testid を使い、重複させない）。

### A.7 航空会社の評価カード（要望 9 の前半: 既存データのみ）

純関数 `airlineScorecard(input) → AirlineScore[]` を `src/core/economy/airlineScore.ts` に置く（読み取り専用。シミュレーションも会社も変更しない → コアに置いてよい）。

入力: `company`、`ctx`（運航中は `sim.ctx`、建設中は `createContext(layout)`）、`records`（運航中のみ `state.analytics.records`。建設中は空）、`plan = analyzeDayPlan(planDay(company, company.day, access, types), ctx)`。

| 要素 | 既存データからの算出 | 「足りないもの」の表示例 |
|---|---|---|
| 定時性 | records の航空会社別 OTP（なければ最新の日報の全体 OTP）vs `AirlineDef.minOtp` | 「定時率 72%（要求 85%）。主な遅延理由: 地上作業」 |
| 折り返し | records の平均折り返し vs 機種の標準折り返し時間 | 「折り返しが標準より 12 分長い」 |
| スポット・ゲート | records の原因 `noStand`・計画の `STAND_CONFLICT`/`NO_GATE`（その航空会社の便） | 「明日 2 便でスポットが不足」 |
| 料金 | `(landing+terminal+parking)/3` と `priceSensitivity` | 「料金が高いと感じている（倍率 1.4）」 |
| 枠（時間帯） | 計画の `OUTSIDE_HOURS`・`RUNWAY_OVERLOAD`・`dropped` | 「希望の夕方の枠に入らない便が 1」 |
| 機材の対応 | 保有機材・提案の機種のうち `operableTypes(ctx)` にないもの | 「A350-900 に対応するスポットがない」 |
| 旅客体験 | records の乗り遅れ・積み残し | 「乗り遅れ 3%」 |

各要素は `good | warn | bad | n/a` と短い文。総合は既存の `satisfaction`（変更しない）。表示: 右列 AirlineCard（航空会社ごとに満足度バー＋最も悪い 2 要素）、PlanPanel の上に詳細表（オーバーレイ内に追加の部品 `AirlineScoreTable`、testid `airline-score-<id>`）。
**計算規則は変えない**（満足度の増減は従来どおり）。12B-3a で要素をコアの満足度計算に使う（opt-in）。

### A.8 画面幅 1400〜1920px

CSS grid: `grid-template-columns: 280px 1fr 300px; grid-template-rows: auto 1fr 200px`。

| 幅 | 左 | 右 | 中央 | 運航表 |
|---|---|---|---|---|
| ≥1760 | 300 | 320 | ≥1140 | 620px・標準列 |
| 1600（e2e の既定） | 280 | 300 | 1020 | 約 470px・標準列 |
| 1400〜1599 | 260 | 260 | 880〜1080 | 420px・機種/遅延の列を省略 |
| <1400 | 右列を左列の下に畳む（1 列でスクロール） | — | — | 420px |

下部の詳細は 160〜240px（ドラッグで高さ変更は不要。折りたたみのみ）。e2e の 1600×900 で、運航表・ops-controls・下部の詳細がすべて画面内に入ること（新しい e2e で `boundingBox` を確認）。

---

## B. 1 日のループ（12B-2）

### B.1 状態遷移

```
            start-ops                    0:00 の締め（自動で一時停止）
  build ───────────────▶ operate ───────────────────────────▶ review
    ▲                      │  ▲  skip-day（ヘッドレス）          │
    │      stop-ops（途中締め）│  └──── 途中で重大な障害 → 一時停止 ◀─┤（自動停止した場合は operate に戻る）
    └──────────────────────┘                                  │
    ▲                                                          │ review-next: 同じ運航を続ける（夜間を早送り）
    └──────────────── review-build: 建設モードへ（締めは済み）◀──┘
```

- `EditorState` に `dayFlow: { phase: 'none' | 'skipping' | 'review'; review: DayReview | null; skip: { progress: number; stopReason: string | null } | null }` を追加（UI の状態。保存しない）。
- **0:00 の締め** は既存どおり `stepSimulation` → `stepEconomy` → `settleDay(sim, false)` が行う（コアは不変）。UI はそれを検出して止まる。
- `stop-ops`（途中で建設に戻る）は **従来と完全に同じ**（確認ダイアログ → `settleDay(sim, true)` → トースト「n日目を締めました」）。management.spec の期待を保つ。
- `review-build`（締めの直後に建設へ）: 既に締め済みなので **`settleDay` を呼ばない**。判定: `sim.state.now - economy.periodStart <= 1`（締めた tick の直後）。`company = sim.company` をそのまま戻す（0:00 の tick で生じた端数の収支は翌日分として `today` に残る＝会計として正しい）。`simRunner.endOps` に `{ atDayClose: boolean }` を足すだけで、コアは変えない。
- `review-next`: 同じ `sim` を続ける。夜間（0:00〜開場 30 分前）は何も起きないので、ヘッドレスで早送りしてから元の倍率で再開する（決定性は §B.3 と同じ理由で保たれる）。
- 自動停止と振り返りの表示は設定 `opsPrefs.pauseAtDayClose`（既定 ON、UI の設定。`localStorage`）。OFF なら従来どおり日をまたいで走り続け、振り返りは「前日の振り返り」ボタンから見る。

### B.2 ティックの進め方を 1 か所にまとめる（core の読み取り補助）

新規 `src/core/sim/dayloop.ts`:

```ts
/** 締めの検出: 会社があれば company.day の増加、なければ日付の変化 */
export function dayMarker(sim: Simulation): number;   // company ? company.day : Math.floor((state.now - 1) / DAY_SEC)
export interface StepResult { ticks: number; stop: 'dayClose' | 'predicate' | 'bankrupt' | null }
/** 最大 maxTicks 進める。各 tick の後で止める条件を調べる（条件は読み取りのみ） */
export function stepTicks(sim: Simulation, maxTicks: number, opts?: { stopAtDayClose?: boolean; stopWhen?: (sim: Simulation) => boolean }): StepResult;
```

- 中身は `for (…) { stepSimulation(sim); if (…) return …; }` だけ。`stepSimulation` 以外にシミュレーションを変更しない。
- `simRunner.frame()` と skip-day の両方がこれを使う（現在の frame は bankrupt の判定をループ内で行っている → `stop: 'bankrupt'` に置き換え。挙動は同じ）。
- `stopWhen` の例（重大な障害での自動停止）: 新しく発生した障害のうち `runwayClosed`／`maintenance`（滑走路）、ダイバートの増加、（12B-3a）天候 Lv4。発生数・統計を **読むだけ**。

### B.3 1 日スキップ（ヘッドレス）と決定性の証明

- `ops.skipDay({ autoStop })`: 現在の `sim` に対して、`setTimeout(0)` ごとに **時間予算 12ms**（UI 側で `performance.now()`。core には入れない）ぶん `stepTicks(sim, 2000, { stopAtDayClose: true, stopWhen })` を繰り返す。進捗 = `(now − start) / (締めの時刻 − start)`。描画は止め（`raf` を止める）、プログレスバー（`skip-progress`）と「中止」（`skip-cancel`。中止しても状態は途中の時刻で一時停止の運航になるだけ）。
- 建設モードから押した場合は `ops.start()` → 直後に skipDay。
- 終了: `dayClose` → 振り返り。`predicate`（重大な障害）→ 一時停止のライブ運航に戻り、アラートを出す。`bankrupt` → 既存の破綻処理。
- **決定性の証明**: 
  1. シミュレーションの状態遷移は `stepSimulation(sim)` だけが行い、入力は `sim`（ctx・state・company）だけ。実時間・描画・UI の状態を読まない（core に `Date.now`・`Math.random` なし。既存の方針）。
  2. ライブ運航は「フレームごとに k 回 `stepSimulation`」、スキップは「チャンクごとに m 回 `stepSimulation`」。プレイヤーの操作がなければ、どちらも同じ関数を同じ回数だけ同じ順に適用するので、締めの時点の状態は一致する（関数の合成は分割の仕方に依存しない）。
  3. 停止条件・進捗・アラートの導出は状態を読むだけ。
  4. 止まる位置は両方とも「締めを行った tick の直後」（`dayMarker` の変化を tick ごとに調べる）で同一。
  - テスト（`tests/unit/dayloop.test.ts`）: 同じ入力から (a) 1〜5000 のランダムなチャンク（シード固定）で `stepTicks`、(b) 1 回の `stepTicks(∞, stopAtDayClose)`、(c) `runScenario` 相当の連続実行 — 締めの時点で `JSON.stringify(state)` と `company` が一致。サンプル空港＋サンドボックス会社、キャリア初期、`randomDisruptions` ON の 3 条件。さらに `stopWhen` を付けても付けなくても結果が一致すること。
- 性能: サンプル空港の 1 日（86,400 tick）の所要時間を実装時に計測し、docs に記録する。目安 15 秒以内（CI のヘッドレス Chromium）。超える場合はバックログの「Web Worker で実行」（状態を `structuredClone` で往復。決定性は同じ）に回す。

### B.4 振り返り画面

`src/core/analytics/review.ts`（純関数、読み取りのみ）:

```ts
export interface DayReview {
  day: number;                       // 締めた日（0 始まり）
  report: DailyReport;               // c.reports の最後（既存）
  prev: DailyReport | null;          // その前（既存）
  compare: { metric: string; a: number | null; b: number | null; verdict: 'improved' | 'worse' | 'same' | 'n/a' }[];  // compareResults と同じ判定方向の表
  delayCauses: { cause: string; flights: number }[];  // analytics.records のうちその日の便の causes を集計（既存データ）
  disruptions: { id: string; kind: string; target: string | null; start: number; end: number | null; resolvedBy: 'time' | 'player' | null }[]; // state.disruptions のうち期間内（既存）
  responses: { delays: number; reassigns: number; priorities: number; repairs: number };  // UI の操作の集計（下記）
  airlines: { id: string; before: number; after: number; delta: number; worst: string[] }[]; // 満足度の前後（before は UI が日の初めに記録）＋ scorecard の悪い要素
  tomorrow: { flights: number; issues: PlanIssue[]; completing: { id: string; kind: string }[]; weather: WeatherForecast | null };
}
export function buildDayReview(input: { sim: Simulation; company: CompanyState; dayStart: number; airlinesBefore: Record<string, number>; responses: DayReview['responses']; access: number }): DayReview;
```

- 収入・費用の内訳、定時率と主な遅延理由、旅客数と満足度、障害と対応、前日比（改善/悪化）、航空会社の評価の変化、明日の見通し（便数＝`planDay(company, company.day, access, types)`、完成する工事＝`projects` で `remaining === 1` かつ `kind !== 'closure'`、天候予報＝12B-3a 未設定なら「予報なし」）。
- 新しく必要なデータは 2 つだけで、どちらも **UI 側で保持**（シミュレーションに入れない）:
  - `airlinesBefore`: その日の初め（運航開始時・前の締めの直後）の `company.airlines[*].satisfaction`。
  - `responses`: `disruptionActions` の成功回数（既存の `respond()` で数える）。
- 画面: 全画面のオーバーレイ（上部バーは残す）。testid: `day-review`、`review-revenue`、`review-cost`、`review-otp`、`review-causes`、`review-compare`、`review-airlines`、`review-tomorrow`、`review-next`、`review-build`。
- 振り返りのデータ自体も履歴（§B.5）に保存して、後から見られる（`history` オーバーレイ）。

### B.5 オートセーブと日ごとの履歴

- **既存のオートセーブ**（`skyport.layout.v2`・`skyport.company.v1`・`skyport.projectMeta.v1`）はそのまま。締めのときに `store.company` を `sim.company` の複製で **保存キーにだけ** 書く（運航中のストアの会社は変えない）。
- **日ごとの履歴は IndexedDB**（`localStorage` は約 5MB で、運航状態入りの 1 件が数百 KB〜1MB になるため不足）。
  - DB `skyport`、ストア `dayHistory`、キー `${projectKey}:${day}`（`projectKey` = 保存スロット ID、未保存は `"unsaved"`）。
  - 値 = `{ day, savedAt, cash, rating, review: DayReview, project: ProjectFile }`。`project` は **建設モードの復元点**（`sim: null`、`scenarios: []`）= 「その日の朝（締めの直後）」。運航状態は入れない（大きく、復元しても夜中の状態に意味が薄い）。シナリオは履歴に入れず、戻っても現在のシナリオを保つ（明記する）。
  - 保持: 直近 7 日はすべて、それより古いものは 7 日ごとに 1 件・最大 8 件、プロジェクトあたり最大 15 件。書き込みのたびに整理。サイズの目安: サンプル空港で 1 件 100〜300KB（実装時に計測して記録）。
  - 抽象化: `interface DayHistoryStore { put; list(projectKey); get; prune }`。実装は `IndexedDbHistoryStore`（ブラウザ）と `MemoryHistoryStore`（単体テスト・IndexedDB が使えない環境）。使えないときは 1 回だけトースト「履歴はこのタブを閉じると消えます」。
  - 書き出し（JSON）には履歴を含めない（端末ごと。docs/21 に追記）。
- 「3 日前に戻る」: 上部バー `history`（testid `open-history`）→ 一覧（`history-row-<day>`: 日・資金・評価・営業利益）→「この日の朝に戻る」（`history-restore-<day>`、確認あり）→ `validateProject` → 建設モードで適用（既存の読み込みと同じ経路。検証に失敗したら何も変えない）。運航中は使えない（建設モードで有効）。
- 12B-2 では **保存形式の版を変えない**（履歴の中身は既存の `ProjectFile` v1）。

### B.6 12B-2 で変えないもの

`settleDay`・`stepSimulation`・`createSimulation`・会社の構造。振り返りに必要なデータは既存の日報・分析記録・障害の記録から作る。

---

## C. 天候 5 段階・予報・難易度（12B-3a）

### C.1 有効化（opt-in）の仕組み

`CompanyState` に任意の項目を追加:

```ts
interface GameSettings {
  version: 1;
  difficulty: 'normal' | 'hard' | 'expert';
  weather: 'levels' | 'legacy';   // levels = 5 段階モデル
  airlineEval: boolean;           // §C.6
  goals: boolean;                 // §E.1
  events: boolean;                // §E.4（12B-3b）
  climate: 'temperate' | 'snowy' | 'humid';   // 予報の傾向
}
interface CompanyState { …; game?: GameSettings }
```

- `company.game` が **ない** = 従来のすべて（既存の保存・ゴールデン・初回起動のサンドボックス）。
- 新しいゲーム（`newGame('career' | 'sandbox')`、UI 側）は `game = { difficulty: 'normal', weather: 'levels', airlineEval: true, goals: true, events: true, climate: 'temperate' }` を付ける。`new-career` の流れ（確認ダイアログ → 開始）は不変。難易度・都市を選ぶ場合は別ボタン「新しいゲーム（設定）」（testid `new-game-setup`）のオーバーレイで選ぶ。
- 既存の会社: 「ゲーム設定」オーバーレイ（`tab-settings`、建設モード）で「新しいルールを使う」を選べる（以後の運航から。確認文「運航の結果が変わります」）。戻すこともできる（項目を消す）。
- 初回起動（保存なし）は従来どおり `createSandboxCompany()`（`game` なし）。e2e の多くがここから始まるので **既存 e2e は新モデルの影響を受けない**。`new-career` を使う e2e（management.spec・access.spec の一部）は新モデルで動くが、§C.4 の「初日は晴れ」「normal の資金・建設費は従来と同じ」で期待値（資金 4,000,000 cr・塔の建設費・計画 3 便・着陸料の計上）を保つ。

### C.2 データ（シミュレーション）

```ts
interface WeatherRuntime {              // SimState.wx?（任意）
  level: 0 | 1 | 2 | 3 | 4;
  type: 'clear' | 'cloud' | 'rain' | 'snow' | 'fog' | 'storm';
  plan: { day: number; hours: { level: number; type: string }[] };   // その日の 24 時間分（純関数から作る）
  override: { level: number; type: string; until: number } | null;   // 手動・シナリオの天候の障害
  rng: RngState;                        // 天候専用の乱数（`${seed}:wx`）。既存の state.rng を消費しない
}
```

- `createSimulation` は `opts.company?.game?.weather === 'levels'` のときだけ `state.wx` を作る。ない場合はキー自体を作らない（`JSON.stringify` が従来と一致）。
- `weatherEffects(state)`: `state.wx ? LEVEL_EFFECTS[state.wx.level] : WEATHER_EFFECTS[state.weather.kind]`。`state.weather.kind` は表示と既存 UI のため、level/type から写像して更新（clear/cloud→clear、rain→rain、snow→snow、fog→fog、storm→rain）。
- 1 時間ごと（`now % 3600 === 0`）に `plan` の値へ更新。日付が変わったら `plan` を作り直す。
- 天候の計画は純関数 `weatherPlan(companySeed, day, climate, difficulty)`。**同じ関数で翌日の予報も作れる**（会社のシードと日から決まり、プレイヤーの操作に依存しない）。
- 予報（表示）: `forecast(plan, accuracy, seed)` = 各時間の段階を確率 `1 − accuracy` で ±1 ずらしたもの（決定的）。振り返り・WeatherCard・計画パネルに「明日の予報（6〜12 / 12〜18 / 18〜24 の最大段階）」を出す。

### C.3 効果の表（ゲーム値）

| 段階 | 表示 | 離着陸間隔 | 走行速度 | 着陸復行の確率（着陸の瞬間） | 欠航（1 時間ごと、2 時間以内の未到着便） | その他 |
|---|---|---|---|---|---|---|
| 0 | 晴れ | ×1.0 | ×1.0 | 0 | 0 | |
| 1 | 曇り・小雨 | ×1.1 | ×0.95 | 0.5% | 0 | |
| 2 | 雨 | ×1.25 | ×0.9 | 1.5% | 0 | 到着の遅れ +0〜10 分（確率 20%） |
| 3 | 荒天（大雨・雪・霧） | ×1.5 | ×0.75 | 4% | 2%/便 | 雪: 走行 ×0.7、除雪の対応が可能 |
| 4 | 悪天（暴風雪・濃霧・雷雨） | ×1.9 | ×0.6 | 10% | 8%/便 | 雷雨: 地上作業を 20 分ごとに 5 分停止（作業の進捗 ×0.75 で近似） |

- 従来の `WEATHER_EFFECTS`（clear/rain/snow/fog）は変更しない。
- **着陸復行**: `approach` で滑走路が空いて着陸する瞬間に、`state.wx` があり段階 ≥1 のとき `wx.rng` で判定 → 既存の `goAround()`（イベントに `reason: 'weather'`）。`wx` がなければ乱数を引かない。
- **欠航**: 段階 ≥3 の時間の始めに、到着予定が 2 時間以内で機体が `scheduled` の便を `wx.rng` で判定 → 新しい関数 `cancelTurnaround(sim, ac, 'weather')`（到着・出発とも `cancelled`、`stats.cancelled++`、`onFlightLost`、機体は `cannotOperate`（理由 `weather`）。`HoldReason` に `'weather'` を追加 — 型の追加のみで既存の値は不変）。航空会社の満足度の欠航ペナルティは天候欠航では半分（`AirlineDayResult.weatherCancelled` を追加。`game.weather === 'levels'` のときだけ数える）。
- プレイヤーの対応: (1) **先行欠航**（運航表の行メニュー。補償なし・満足度 −1 のみ。直前の欠航より安い）、(2) **除雪**（雪で段階 ≥3: 滑走路を 30 分閉鎖 → 以後 3 時間その滑走路の走行の倍率を 1 段階良くする。費用 60,000 cr。既存の `maintenance` の障害を使う）、(3) 既存の滑走路の運用変更。
- 手動・シナリオの天候の障害（`kind: 'weather'`）: `wx` があれば `override` に写像（rain→2、snow→3、fog→3）。ないときは従来どおり。
- ランダムな障害の天候（`RANDOM_PROB_PER_HOUR.weather`）: `wx` があるときは **乱数は従来どおり引いたうえで** 天候の障害だけ登録しない（他の障害の乱数の並びを変えないため）。

### C.4 季節・時間帯・難易度

- ゲームの暦: 1 年 = 120 日（30 日 × 4 季）。`season = floor((day % 120) / 30)`（春・夏・秋・冬）。
- 計画の作り方: 時間ごとのマルコフ連鎖（前の時間の段階 ±1 に動きやすい）。基準の悪天の出やすさ `base[climate][season]`、時間帯の補正（霧: 5〜9 時 ×2、雷雨: 夏の 14〜19 時 ×2、雪: 冬の夜 ×1.5）。
- **初日（day 0）は晴れ〜曇り（段階 ≤1）に固定**（ゲームの導入として。e2e の安定にも寄与）。

| 難易度 | 悪天の頻度 | ランダムな障害 | 航空会社の要求 OTP | 初期資金 | 予報の的中率 | 建設費 |
|---|---|---|---|---|---|---|
| normal | ×1.0 | ON・頻度 ×0.6 | 従来の `minOtp` | 従来（4,000,000 cr） | 90% | ×1.0 |
| hard | ×1.5 | ON・×1.0 | +0.05 | ×0.75 | 80% | ×1.1 |
| expert | ×2.0 | ON・×1.5 | +0.10 | ×0.5 | 65% | ×1.2 |

- ランダムな障害の頻度の倍率は `SimSettings.randomDisruptionScale?`（任意、既定 1 = 従来）。normal で ON にするかは要確認ではなく既定 ON（×0.6）とする。
- 要求 OTP の補正は `updateContracts` の中で `c.game` があるときだけ足す。建設費の倍率は `constructionCost` の呼び出し側（UI の支払い）で `c.game` があるときだけ掛ける（normal は ×1.0 なので従来の値と一致）。

### C.5 既存の障害との関係

- 障害の仕組み（`addDisruption`・閉鎖・修理）は変更しない。天候は `wx` の時だけ別の流れ（計画と override）で決まる。
- シナリオ: シナリオの `company` に `game` があれば同じモデルで実行（`createSimulation` に会社を渡しているので自然にそうなる）。結果には `models: { weather }` を記録して比較画面で区別する。

### C.6 航空会社の評価要素と不満（コア、要望 9 の後半）

- `game.airlineEval` のとき、会社に `airlineEval?: Record<airlineId, { scores: Record<Component, number>; complaints: Complaint[]; requests: Request[] }>` を持つ（`Component` = otp / turnaround / stands / fees / slots / compat / pax、各 0〜100 の指数移動平均 α=0.3）。
- 日次締め（`settleDay` → `updateContracts`）で要素を更新し、満足度の変化を **要素から** 計算する: `delta = Σ wᵢ × (scoreᵢ − 60) / 10`（重み: otp 0.3、turnaround 0.1、stands 0.15、fees 0.15、slots 0.1、compat 0.1、pax 0.1。航空会社の種類で重みを変える: LCC は fees↑・turnaround↑、フルサービスは pax↑・compat↑）。
- 不満（complaint）: 要素 < 45 が 2 日続くと発生、`{ component, text, sinceDay }`。改善で解消。
- 要望（request）: 「夕方に 1 便増やしたい（枠）」「A350 に対応するスポットを」など。満たすと満足度 +5・提案の確率 ↑。
- 契約の更新・提案: 不満が 2 件以上あると更新時の増便なし、`compat` が低いと大型機の提案が減る、`slots` が高いと増便依頼に応じやすい。
- `game.airlineEval` がなければ従来の `updateContracts` のまま（関数の入口で分岐）。

---

## D. 都市とアクセス（12B-3b）

### D.1 データ

```ts
interface CityConfig {                 // CompanyState.city?（任意）
  version: 1;
  type: 'regional' | 'core' | 'metropolitan';
  population: number;                  // 人（ゲーム値）
  distanceKm: number;                  // 空港〜都心
  roadQuality: 1 | 2 | 3 | 4 | 5;
  railQuality: 0 | 1 | 2 | 3 | 4 | 5;  // 都市側の鉄道の整備度（0 = 鉄道なし）
  residents: number;                   // 住民の満足度 0〜100（騒音、§E.2）
}
```

| 種類 | 人口 | 距離 | 道路 | 鉄道 | 旅行率（人/日/人口） |
|---|---|---|---|---|---|
| regional（地方都市） | 30 万 | 25 km | 2 | 0 | 0.004 |
| core（中核都市） | 120 万 | 18 km | 3 | 2 | 0.006 |
| metropolitan（大都市） | 600 万 | 30 km | 4 | 4 | 0.009 |

新しいゲームで選ぶ（既定 regional＝キャリアの小さな飛行場に合う）。既存の会社は「ゲーム設定」で都市を設定したときだけ有効。

### D.2 式（ゲーム値）

- **需要の上限**（旅客/日、出発＋到着）: `ceiling = population × tripRate × exp(−max(0, distanceKm − 15) / 60) × (0.7 + 0.3 × accessFactorNorm)`、`accessFactorNorm = (factor − 0.3) / 0.8`。
- **都市係数**: `cityFactor = min(1.1, ceiling / max(1, expected))`、`expected = Σ(座席 × 基本搭乗率) × 2`（その日の計画）。`generateContractSchedule` で `planDay(c, day, access × cityFactor, types)` に渡す（`planDay` の引数は不変。都市がなければ ×1 で従来と一致）。計画パネルのプレビューも同じ値を使う。
- **アクセスの所要時間**: `analyzeAccess(layout, { fees, feedback, city })` に任意の `city` を追加。ある場合だけ `externalMin` を置き換える:
  - 車・送迎・タクシー: `distanceKm / (20 + 8 × roadQuality) × 60`
  - バス: 車 × 1.3
  - 鉄道: `distanceKm / speed[service] × 60`、`speed`: 各停 45・快速 65・特急 90 km/h。特急は `railQuality ≥ 3`、快速は `≥ 2` のときだけ選べる。
- **鉄道の種別と本数**: 駅の施設の任意の props `railService?: 'local' | 'rapid' | 'express'`（既存の `trainsPerHour` はそのまま）。運賃の上乗せ: 快速 +0・特急 +500 cr、駅の運営費の倍率: 1.0 / 1.4 / 2.2。props を持たない駅は各停扱い（＝都市がなければ従来の計算そのもの）。
  - 実装時の確認: `validateLayoutData` が未知の props の文字列値を拒否しないか。拒否する場合は `CityConfig.railServices: Record<stationId, service>` に置く（レイアウトを変えない）。どちらでも `SCHEMA_VERSION` は上げない方針。
- **国内線/国際線の比率**: 安くは入らないのでバックログ（行き先の区分と店舗収入の係数が要る）。
- **都市の成長**（日次締め、都市があるときだけ）: `population ×= 1 + base[type] + 0.0005 × min(1, paxDay / (0.8 × ceiling)) × (residents / 70 を 1 で上限)`、`base` = 0.0002 / 0.0003 / 0.0002。人口がしきい値（×1.5、×2）を越えると道路の整備度 +1（イベントとして通知）。鉄道の整備度はマイルストーンの報酬・投資（「鉄道会社との協定」: 一時金で +1）で上がる。

### D.3 移行

`city` がない会社は従来の式そのもの（`analyzeAccess` の既定の引数・`planDay` の `access` は不変）。ゴールデンは不変。

---

## E. 目標・騒音・時間帯の表現・イベント・視点別の機能

### E.1 目標とマイルストーン（12B-3a）

- 登録表 `src/core/economy/goals.ts`: `{ id, tier, title, check(c, report, layout) → boolean, streak?, reward }`。
  例: 「1 日 10 便を完了」（30 万 cr）、「定時率 85% を 3 日連続」（評価 +2）、「1 日 50 発着」（100 万 cr・都市の成長 ↑）、「鉄道アクセスの開業」（鉄道の整備度 +1）、「大型機の初就航」（大型機の提案 ↑）、「1 日 200 / 500 発着」「旅客 1 万人/日」「評価 80」。
- 空港の格（キャリアの段階）: 飛行場 → 地方空港 → 拠点空港 → 国際ハブ（発着・旅客で判定）。上部バーの表示と、提案の機種・都市の成長に使う。
- 会社に `goals?: { done: Record<id, day>; streaks: Record<id, number>; tier: number }`。`settleDay` の最後で `c.goals` があるときだけ評価（決定的）。報酬の現金は「営業外」の記録（`goals.grants`）として日報と分けて表示。
- UI: 左列 GoalsCard（次の 3 つ）、振り返りに「達成」。

### E.2 騒音と夜間制限（12B-3b）

- 会社に `noise?: { enabled: true; curfew: { fromMin: number; toMin: number } | null }`、住民の満足度は `city.residents`（都市がなければ `noise.residents`）。
- 夜間帯 22:00〜06:00（ゲーム値）。騒音単位: 小型 1・中型 2・大型 4（23〜05 時は ×1.5）。
- 日次: `residents += 1.5 − 0.08 × 夜間の騒音単位 − 0.005 × max(0, 昼間の騒音単位 − 200)`、0〜100。
- 夜間の便の収入: 夜間帯の着陸料 ×1.3（`noise` があるときだけ）。夜間帯の契約（`TimeWindow` に `'night'` を追加、提案は `noise` があるときだけ生成）は料金の割引が負（割増）。
- 住民の満足度の影響: `< 50` で空港評価の日次値から `(50 − residents) × 0.1`、`< 30` で工事の日数 ×1.2（反対運動）と都市の成長の低下。
- 門限（curfew）: その時間帯は離着陸しない。到着は進入の計画の時点で門限に入るならダイバート、出発は門限開始までに離陸できなければ欠航（補償あり）。計画の分析に `CURFEW` の警告を追加（`noise` があるときだけ）。
- UI: 右列 NoiseCard（住民の満足度・今夜の夜間便数）、計画パネルの夜間便の印。

### E.3 時間帯の表現（12B-4、表示のみ）

- 純関数 `daylight(tSec, dayOfYear) → { phase: 'night' | 'dawn' | 'day' | 'dusk'; light: 0..1; tint: [r, g, b, a] }`（日の出 5:30〜6:30、日没 17:00〜19:00 を季節で変える）。`src/render/daylight.ts`（core でなく render。シミュレーションに無関係）。
- 2D: 世界の描画の後に tint を一度塗る。夜は滑走路・誘導路の中心線に小さな光点（最大 240 点）。オーバーレイ `daylight`（既定 ON、運航中のみ有効）。
- 3D: `HemisphereLight`・`DirectionalLight` の強さと色、背景・霧の色を補間。機体の灯火・照明塔は Phase 16 で（ここでは光を足さない）。
- 費用: 2D は 1 回の塗りと点、3D はライトの値の更新のみ。性能の e2e（`perf-3d`）の FPS が落ちないことを確認。

### E.4 イベント（12B-3b、`game.events`）

- 日の初めに `Rng(`${seed}:events:${day}`)` で 0〜2 件。既存の障害・提案の仕組みの上に作る:
  チャーター便の依頼（期限つきの提案。受けると今日 1 便追加・高い料金）、VIP 便（優先・定時なら評価 +）、ストライキ（作業員の欠勤・大）、祭り（需要急増、都市の旅客）、滑走路の点検（予定された閉鎖。事前に通知）、バードストライク（滑走路 20 分閉鎖）、燃料の供給遅れ（給油作業 ×1.3）、スポッターの日（店舗収入 ↑、マニア向け）。
- 予定されたイベントは振り返りの「明日の見通し」に出る。

### E.5 パイロット目線（12B-4、UI のみ）

- 追従カメラ: 選択中の機体にカメラが追従（2D は中心を合わせる、3D は追跡カメラ）。`follow` ボタン（`follow-aircraft`）。
- 経路の表示: 選択中の機体の `ac.route` を線で描く。待機点・滑走路の横断点に印。
- 「管制の指示」風の要約: 「RWY 34R へ、経由 A → B。滑走路の横断待ち」（ルートのエッジの誘導路名から作る。ゲーム上の表示で実際の管制用語の再現ではない）。
- 待機理由の説明を下部の詳細に（既存の `HOLD_REASON_LABEL` に説明文を足す）。

実装済み: 2D/3D の昼夜表示、季節に応じた概算の日の出・日没、2D/3D の追従切替、誘導路名による走行案内、待機理由の説明、日次締めで更新する `journal` と運航記録 UI。未実装: 機種別操縦席位置・視野、塗装ごとのスポッティング、詳細な実機マニアデータ。季節計算は緯度・暦を持たないゲーム内の表示近似。

### E.6 マニア目線（12B-4）

- スポッティング記録: 初めて来た機種・航空会社・塗装（Phase 16 で塗装）、日付、珍しさ（契約外の手動追加・大型機）。
- 記録: 最多発着の日・最も混んだ 1 時間・最大の機体・最長の遅延・連続定時の日数。
- 統計: 機種別の累計発着（既存の分析を日をまたいで集計）。
- 保存: プロジェクトの任意の項目 `journal?: { spotted: …; records: … }`（シミュレーションと無関係。締めのときに UI が更新）。

---

## F. 保存と版

| 版 | 方針 |
|---|---|
| `SCHEMA_VERSION`（3） | **上げない**（12B ではレイアウトの構造を変えない。鉄道の種別は §D.2 の確認次第で会社側へ）。地下レイヤ（U）で上げる見込み |
| `SIM_MODEL_VERSION` | **上げない**。既存のレイアウト・会社の結果は不変。新モデルは opt-in の項目で区別する |
| `PROJECT_FORMAT_VERSION` | 定数を **2** にする（12B-3a の最初のコミットで）。`buildProject` は **新しい項目を使っているときだけ `formatVersion: 2`**、それ以外は 1 を書く（`usesFormat2(p)` = `company.game/city/noise/goals/airlineEval`・`journal`・`sim.state.wx` のいずれかがある）。→ 既存のゴールデン（`project.golden.json` 等）はサンドボックスの会社なので 1 のまま＝不変。古いアプリは v2 を「新しい版」として拒否する（新モデルの会社を従来の計算で黙って遊ぶことを防ぐ） |
| `CompanyState.version` | 1 のまま（項目の追加は任意・欠落 = 従来）。`importCompany` で各項目の形を検証し、不正なら項目ごと捨てて警告 |
| `SimState.version` | 1 のまま。`checkSim` で `wx` があれば形を検証 |

- 検証: `validateProject` に `game`・`city`・`noise`・`goals`・`airlineEval`・`journal`・`wx` の形の検査を追加（不正 → エラーで読み込まない。docs/21 の方針どおり）。
- 移行: v1 → v2 は恒等（項目がなければ従来）。
- 12B-1・12B-2 は版を変えない。

### F.1 ゴールデンの方針

- 既存のゴールデン（`sim`・`sim-midrun`・`stress-sim`・`project-sim`・`crossing-sim`・`project`・`free-runways` ほか）は **一切再採取しない**。既存の「版を上げずに内容を変える再採取を拒否する」保護がそのまま効く。
- 新しいゴールデンは新しいファイルだけ: `tests/golden/game-models.golden.json`（サンプル空港＋サンドボックス会社＋`game`（normal / expert）で 1 日、天候の計画・予報、締めの KPI）、`city-access.golden.json`（3 種類の都市の `analyzeAccess` と計画）、`noise.golden.json`。`sim-versions.json` に新しいファイルの項目を追加（既存の項目は不変）。
- 保護のテスト: 「`game` のない会社では `state.wx` が作られず、`analyzeAccess`・`planDay`・`updateContracts` の結果が従来と同一」（既存の関数の出力と比較）。

---

## G. 段階ごとの計画と作業分解

### G.1 12B-1（UI のみ）— 詳細

目的: 運航中の情報を常に見えるようにし、運航表から直接操作できるようにする。シミュレーションは不変（ゴールデン・単体テストは触らない）。

| # | 作業 | 主なファイル | テスト |
|---|---|---|---|
| S1 | 骨組み: `BuildLayout`（既存をそのまま移動）/ `OperateLayout`、CSS grid、`OpsNav`（運航時の `tab-*`）、`DetailOverlay`（既存部品を表示、Esc・×・モード変更で閉じる）。`OpsBottom` を削除 | `ui/App.tsx`、`ui/operate/OperateLayout.tsx`、`ui/operate/DetailOverlay.tsx`、`styles.css` | **既存 e2e 全件が通る**（この時点で互換の要件を満たす）。新 e2e: 各 `tab-*` でオーバーレイが開閉し、`ops-controls` が覆われない |
| S2 | 左右のカード: `Card` 共通部品、TodayKpi・Runway（`RunwayRow` を export して移動）・Weather・Terminal・Ground・Access・Construction・Events。重い集計は 1 秒間引き | `ui/operate/cards/*.tsx`、`ui/OpsPanels.tsx`（`RunwayRow` の export のみ） | 単体: `computeKpi` が状態を変えない。e2e: 各カードが表示され、見出しで詳細が開く |
| S3 | 運航表のオーバーレイ（FIDS 風、出発/到着/すべて、完了を隠す、折りたたみ、全列表示=`tab-flights`） | `ui/operate/FidsOverlay.tsx`、`OpsPanels.tsx`（`FlightBoard` の行の描画を共有化） | 既存 e2e（`table.board tbody tr` の行クリック）が通る。新 e2e: 切り替え・折りたたみ |
| S4 | 運航表の直接操作（行メニュー: 遅延・スポット変更・優先・移動）。スポット候補の計算を `ResponseSection` と共有 | `FidsOverlay.tsx`、`ui/operate/flightActions.ts` | 新 e2e: 到着便を追加 → 行メニューで +15 分 → トースト「15分遅らせました」、スポット変更 → トースト |
| S5 | 下部の詳細（AircraftPanel・施設の PropertiesPanel を横並び、折りたたみ） | `OperateLayout.tsx`、`styles.css` | 既存 e2e（aircraft-panel・turnaround）が通る |
| S6 | アラート: `deriveAlerts`（純関数）・`AlertStack`（まとめ・移動・対応ボタン・閉じる） | `ui/operate/alerts.ts`、`AlertStack.tsx` | 単体: 同じ種類＋対象をまとめる、重大度、閉じた key を除く。新 e2e: 滑走路閉鎖の障害を追加 → アラート → 移動 → 修理ボタンで解除 |
| S7 | 航空会社の評価カード（`airlineScorecard` 純関数＋ AirlineCard・`AirlineScoreTable`） | `core/economy/airlineScore.ts`、`ui/operate/cards/AirlineCard.tsx`、`ManagementPanels.tsx`（表を追加） | 単体: 各要素の判定（料金倍率・機材の非対応・計画のスポット不足）、入力を変更しない。e2e: キャリアで評価表が出る |
| S8 | 幅 1400〜1920 の調整、docs/06_ui_design の更新（画面構成・testid 表） | `styles.css`、`docs/06_ui_design.md` | 新 e2e: 1400・1600・1920 で運航表・ops-controls・詳細が画面内（`boundingBox`） |

- 新しい e2e は `tests/e2e/ops-layout.spec.ts` にまとめる（既存の spec は編集しない）。
- コミット: S1、S2、S3+S5、S4、S6、S7、S8 の 7 つ程度。各コミットで `npm test`・`npm run test:e2e`・`tsc` を通す。

### G.2 12B-2（1 日のループ）— 詳細

目的: 毎日の締めで振り返り、1 日をスキップでき、日ごとに戻れる。コアは読み取りの補助関数のみ追加。

| # | 作業 | 主なファイル | テスト |
|---|---|---|---|
| D1 | `stepTicks`・`dayMarker`（core） | `core/sim/dayloop.ts` | 単体: §B.3 の分割の一致（3 条件）、`stopWhen` の有無で結果一致、締めの直後で止まる |
| D2 | ライブ運航を `stepTicks` に置き換え、締めで一時停止（設定で無効化可）。`endOps({ atDayClose })` で二重の締めをしない。日の初めの航空会社の満足度と対応回数を UI に記録 | `editor/simRunner.ts`、`editor/store.ts`（`dayFlow`） | 単体（simRunner はロジックを関数に切り出して node でテスト）: 締めの直後に建設へ戻っても日報が 1 件だけ・`company.day` が 1 だけ進む。既存 e2e（stop-ops の途中締め）が通る |
| D3 | `buildDayReview`（core 純関数）と振り返り画面 | `core/analytics/review.ts`、`ui/DayReview.tsx` | 単体: 前日比の判定方向（KPI_DIRECTION と同じ）、遅延理由の集計、明日の便数＝`planDay` の便数、完成する工事 |
| D4 | 1 日スキップ（時間予算のチャンク・進捗・中止・重大な障害で自動停止） | `simRunner.ts`、`ui/SkipDayOverlay.tsx`、上部バー `skip-day` | 単体: 自動停止の条件。e2e: キャリアで start → skip-day → 振り返り → review-next で 2 日目の時計 |
| D5 | 「次の日へ」: 夜間の早送り（開場 30 分前まで、ヘッドレス）→ 元の倍率で再開 | `simRunner.ts` | 単体: 早送りしても締め以外の状態が通常の進行と一致 |
| D6 | オートセーブ（締めのときに既存キー＋履歴）、`DayHistoryStore`（IndexedDB / メモリ）、保持の整理、履歴のオーバーレイと「この日の朝に戻る」 | `editor/dayHistory.ts`、`ui/HistoryPanel.tsx`、`docs/21` | 単体（メモリ実装）: 保持の規則（直近 7 日＋週ごと 8 件）、戻すと `validateProject` 経由で適用・失敗時は不変。e2e: 2 日運航（skip ×2）→ 履歴に 2 件 → 1 日目の朝に戻る → `company-day` が戻る |
| D7 | 性能の計測（サンプル空港の 1 日スキップの時間・履歴 1 件のサイズ）を docs に記録、docs/14 に日のループを追記 | docs | — |

- 新 e2e: `tests/e2e/dayloop.spec.ts`。
- コミット: D1、D2、D3、D4+D5、D6、D7。

### G.3 並行作業のトラック（ファイルの衝突を避ける）

- **UI トラック**（12B-1 → 12B-2 の UI 部分）: `src/ui/**`、`styles.css`、`App.tsx`、`editor/simRunner.ts`・`store.ts`（12B-2）。
- **コアトラック**（12B-3a の天候・難易度・評価・目標）: `core/sim/weather.ts`（新）、`disruptions.ts`、`simulation.ts`（着陸復行・欠航の呼び出し 2 か所）、`economy/company.ts`・`ops.ts`、`io/project.ts`。**C1（交差の不具合修正）の取り込み後** に開始。
- 12B-1 の S1 が入った後なら、2 つのトラックは並行できる（共有するのは `i18n/ja.ts` の追記のみ。追記は末尾の別ブロックにする）。

### G.4 12B-3a / 3b / 4 / U の概要

| 段階 | 目的 | プレイヤーに見えるもの | データ・モデル | opt-in / 互換 | テスト | 規模 | 依存 |
|---|---|---|---|---|---|---|---|
| 12B-3a | 毎日違う 1 日・選べる難しさ・航空会社の要求 | 天候 5 段階と予報、難易度、評価要素と不満・要望、目標と空港の格 | `company.game`・`airlineEval`・`goals`、`state.wx`、`HoldReason 'weather'`、`TimeWindow` 変更なし | `company.game` がなければ従来。新しいゲームは既定で有効。`formatVersion 2` は使用時のみ | 新ゴールデン 1 本、単体（計画の決定性・効果の表・要素の式・目標の判定）、e2e（新しいゲーム（設定）→ 予報表示） | L（約 8 コミット） | 12B-2（振り返りに予報を出す）、C1 |
| 12B-3b | 立地と交通の戦略、夜の判断、出来事 | 都市の選択・人口と需要の上限・鉄道の種別、騒音と門限、イベント | `company.city`・`noise`、`analyzeAccess(…, { city })`、駅の `railService` | 都市・騒音・イベントは設定したときだけ | 新ゴールデン 2 本、単体（式）、e2e（都市の設定 → アクセス表の所要時間） | L | 12B-3a（`game` の枠組み） |
| 12B-4 | 見て楽しい・視点を変えて楽しい | 昼夕夜の表現、追従カメラ・経路・指示の要約、スポッティング記録・記録 | `journal`（プロジェクト）、render の `daylight` | 表示のみ／保存は任意項目 | e2e（夜の時刻で描画エラーなし、追従ボタン）、`perf-3d` の確認 | M | 12B-1 |
| U | 大規模空港の地下の機能 | 地下道路・地下鉄道（トンネル）、燃料ハイドラント、地下駅 | §G.5 | 地下の施設を置いたときだけ | 新ゴールデン、検証規則 | XL | Phase 13（形状）、Phase 16（3D の坑口） |

### G.5 地下・高架レイヤ（U）の実装状況

- **データ**: `RoadNode.level?` は -5〜10（欠落 = 地上 0）、`elevationM?` は任意の表示/経路標高。道路エッジは public/service/rail/walkway/fuel とし、階層間は stairs/escalator/elevator/ramp/railRamp/pipeRiser の明示コネクタを必要とする。別概念として `terminalLinks` にターミナル間徒歩通路・動く歩道を保持し、端点エリア、区域、方向、距離、所要時間、任意容量を保存する。
- **シミュレーションの効果**: 運用中の多層歩行路は地下駅からターミナルへの到達経路・所要時間に使い、全区間の明示能力がそろう場合だけ接続能力を算出する。給油施設から燃料管で到達するスポットは給油車要件を外し、給油作業時間を 0.6 倍にする。ターミナル間経路 API は既存 AreaLink と明示 `terminalLinks` を探索するが、現在の便旅客に別ターミナルの行先/乗継情報がないため、既存 `PaxGroup` には接続していない。
- **費用**: 地下道路はゲーム内地上道路費用の 10 倍、高架道路は 2 倍、燃料管は 1,500 cr/タイル。ターミナル間徒歩通路は 4,500 cr/25 m、動く歩道は 12,000 cr/25 m。日次維持費は既存の資産額基準に反映。これらはゲームバランス値で実測工費ではない。
- **編集/表示**: 建設レイヤー切替、道路の種別・明示能力、異階層ノードを選択して接続設備を追加する UI、エリア選択時のターミナル間連絡設備フォーム、2D/3Dレイヤ切替を実装。接続を自動生成しない。
- **検証/保存**: 階層値・標高・コネクタの交通種別・勾配・距離・能力、ターミナル間端点・区域・方向のデータ形状を検証する。これらは `SCHEMA_VERSION = 3` の任意項目として保存し、新しい交通項目を含むプロジェクトは外側形式 v3 とする。階層がないデータは地上として保持する。地下設備なしの既存 sim 結果を変えないため `SIM_MODEL_VERSION` は変更しない。
- **未実装**: 地上道路の車両個別運行と渋滞、列車の個別運行と線路占有、ターミナル間連絡設備を使う既存旅客グループの動的状態遷移・実績人数、階層別混雑履歴。これらは独立した旅程データと運行主体モデルが必要。詳細は [docs/34](../34_vertical_transport.md)。

### G.6 優先順位のバックログ（12B-3 以降、Phase 13〜16 との順序）

推奨の全体順: **12B-1 → 12B-2 → 12B-3a → Phase 13 → 12B-3b → 12B-4 → Phase 14/15 → U-1 → Phase 16（＋U-2・塗装・夜間照明）**

| 優先 | 項目 | 段階 | 理由 |
|---|---|---|---|
| 1 | 天候 5 段階・予報・難易度 | 3a | 毎日の変化と判断。振り返りの「明日」を完成させる |
| 2 | 航空会社の評価要素・不満・要望（コア） | 3a | 要望 9。拡張の動機（何が足りないか）を作る |
| 3 | 目標・空港の格 | 3a | 中期の方向。報酬で成長を加速 |
| 4 | 都市モデル・鉄道の種別 | 3b | 需要の上限＝大規模化の制約と投資先 |
| 5 | イベント | 3b | 運航管理者の「いろいろ起きる」 |
| 6 | 騒音・門限・夜間便 | 3b | 夜の収入と住民のトレードオフ |
| 7 | 時間帯の表現 | 4 | 安く効果が大きい。夜間便と相性 |
| 8 | パイロット目線（追従・経路・指示の要約） | 4 | 待機の納得感（不具合の発見にも役立つ） |
| 9 | マニア向け（スポッティング・記録） | 4 | Phase 16 の塗装で完成 |
| 10 | 1 日スキップの Web Worker 化 | — | 大規模空港で時間がかかる場合のみ |
| 11 | 燃料ハイドラント（U-1） | U | 大規模空港の地上作業の制約を外す |
| 12 | 地下道路・地下鉄道・地下駅（U-2） | U | 3D・編集が重い |
| 13 | 国内線/国際線の比率 | — | 行き先の区分と収入の係数が要る |
| — | 既存の不具合の修正（新しいゲームでの運航シードの日ごとの変化: 建設から運航を始めるたびに `${site.seed}:ops` で同じ乱数の並びになる問題を、`game` があるときだけ `${seed}:ops:${day}` にする） | 3a | 毎日同じ障害の並びになる違和感の解消（opt-in なので既存は不変） |

---

## H. リスクと PO への確認

### H.1 リスク

| リスク | 対策 |
|---|---|
| 運航画面の作り直しで既存 e2e が壊れる | S1 で互換の要件（§A.6）を先に満たし、全 e2e を通してから見た目を変える。オーバーレイは上部バー・左列を覆わない |
| 1 日スキップが遅い（大規模空港） | 計測して記録。時間予算のチャンクで UI は固まらない。必要なら Worker（バックログ 10） |
| IndexedDB が使えない環境 | メモリ実装に切り替えて通知。オートセーブ（既存の localStorage）は従来どおり |
| 新モデルが既存の結果に漏れる | すべて `company.game` 等の有無で分岐。「項目なし＝従来と同一」の保護テストと既存ゴールデンで機械的に検出 |
| 旧アプリで新しいプロジェクトを開いて誤って遊ぶ | 新しい項目を使うファイルだけ `formatVersion 2`（旧アプリは拒否） |
| 天候の乱数が他の乱数を乱す | 天候専用の乱数（`${seed}:wx`）。ランダムな天候の障害は乱数を引いたうえで登録しない |
| 範囲の膨張 | 12B-1/12B-2 だけを次の実装対象とし、以降はバックログの順で 1 段階ずつ PO 確認 |

### H.2 PO への確認（本当に必要なものだけ、推奨の既定つき）

1. **順序**: 12B-1 → 12B-2 → 12B-3a を Phase 13 の前に行い、12B-3b・12B-4 は Phase 13 の後に回す（A 案を一部変更）。→ **推奨: この順**。
2. **毎日の締めでの自動一時停止と振り返り**: ライブ運航でも 0:00 で止めて振り返りを出す（設定で無効化可）。→ **推奨: 既定 ON**。
3. **地下レイヤの位置と範囲**: Phase 14/15 の後に、まず燃料ハイドラント（U-1）、次に地下道路・鉄道・地下駅（U-2、Phase 16 と同時期）。地下ターミナル・旅客用の地下鉄（ピープルムーバー）は範囲外。→ **推奨: この位置と範囲**。

（その他の既定は本書の値で進める: 1 年 = 120 日、normal の資金・建設費は従来どおり、新しいゲームは新モデルが既定、初回起動のサンドボックスは従来、履歴は端末内のみで書き出しに含めない、数値はすべてゲーム値。）
