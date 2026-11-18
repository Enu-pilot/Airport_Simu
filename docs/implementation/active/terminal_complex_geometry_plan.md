# Phase 5 / 5-15 実装計画: 複雑形状のターミナル建物とターミナル複合体判定

> 管理状態: **active（T1/T2/T4 実施済み 2026-11-18。T3 描画UI・T5 割当て分離・T6 経路・T7 描画/性能は残件）**
> 作成日・更新日: 2026-11-18
> 根拠: PO依頼（2026-11-18）、docs/42 §3.4 要件5-15、5-14ターミナル構造計画
> 依存: 5-14（床階・親子施設の統一モデル）。320×320空港規模E2EはPhase2.5受入完了後。
> 正本: 本書は実装計画。現在の施設形状仕様はdocs/22とsourceを参照。

## 1. 現状と課題

- Terminal Facilityはorigin,w,h,rotationの矩形をfacilityTiles()/rectTiles()で占有する。TerminalAreaもorigin,w,hの矩形でareaRectTiles()によって床タイルを列挙する。
- Polygon helperはあるが、自由形滑走路などの幾何判定を主用途とする。建物に適用するには、凹形・自己交差・境界接触・タイル包含・穴・レンダリング・当たり判定を別途定義する必要がある。
- TerminalModelはTerminalArea.terminalIdごとに区域・経路を構築する。ゲートが複数ターミナルに接するときは曖昧として報告し、暗黙の所属を決めない。
- TerminalTransitLinkは別ターミナル間の同一旅客区域エリアを結ぶ。リンクが存在しても物理建物の「同じターミナル/複合体」識別子は作られず、touching terminal同士も同じ扱いにならない。
- 同じ建物複合体として表示することと、旅客が通行可能なドア・通路経路があることは別であり、同一複合体判定だけで旅客経路を短絡してはならない。

## 2. 目的・対象範囲

- 凹形を含む多角形ターミナル外形に対応し、矩形の組み合わせだけでなくL字・T字・コの字などを表現できるようにする。
- 建物の接触や完成済み高層連絡通路に基づき、複数の物理建物を一つの論理ターミナル複合体として識別する。
- 物理建物・内部エリア・ゲート・複合体のIDと責務を分離し、既存のterminalIdを保つ。
- 2D/3D、建設、選択、占有・衝突検証、旅客接続、保存/復元を同じ形状定義へ統一する。

### 非目標

- 初期対応で曲線自由形・穴あき多角形・自己接触多角形・複数の離れた島を1つの建物として編集可能にすること。
- 建物が接しただけで、保安・入国審査・出発/到着区域の境界を無視すること。
- 物理的に接触していない建物を距離だけで同一複合体に推測すること。

## 3. 設計方針

### 3.1 建物形状

- 初期対応は単純な直交ポリゴン（orthogonal simple polygon）を推奨する。タイル境界に沿う整数座標の外周リング1本、凹形を許可、自己交差・重複頂点・ゼロ面積・辺長0を拒否する。曲線・穴・複数島は後続候補とする。
- 現在の矩形Facilityはそのまま読める。新しいfootprint/outlineは任意データとし、未設定は従来のorigin,w,h,rotationから矩形を生成する。
- 形状処理はfacilityTilesを唯一の占有APIとし、矩形専用処理を追加箇所へ直接書かない。凹多角形のタイル中心/面積交差の規則、辺上の扱い、共有壁の境界規則を仕様化する。
- 三角形分割など描画用分解と、タイル占有・衝突判定を分ける。凸形専用SATへ凹ポリゴンを直接渡さない。建物同士・誘導路・スポット・道路・地形との干渉を適切な幾何層で検査する。
- 回転・複製・サイズ変更・移動・Undo/Redo・JSON保存・ピッキング・2D・3Dを同じ変換規則で扱う。3D床面/壁面を作る場合、B3〜4Fの床高と建物高の仕様を5-14と合わせる。

### 3.2 ターミナル複合体判定と旅客経路を分離する

- 物理建物ID（Facility.id）、内部エリアの所属（現行TerminalArea.terminalId）、論理ターミナル複合体ID（新しい派生概念）を分ける。
- 複合体の現在判定は決定的な連結成分として導出する。初期候補ルール:
  1. 同じ地図階層にある建物フットプリントが正の長さの辺を共有する（角のみ接触は接続とみなさない）。
  2. 建物間に、両建物に接続する完成済み/operationalのTerminalTransitLink.kind === elevatedWalkwayがある。
  3. planned / underConstructionの連絡設備は現在の複合体には含めず、完成後の将来複合体候補として別に診断する。
- **同一複合体=歩行経路あり、とは扱わない。** 接触した建物間でArea graphがつながっていなければ旅客は通れない。明示doorway/connector/AreaLink/TerminalTransitLink等の通路辺が必要。
- 複合体の代表IDは構成要素の安定ID順で決定し、IDの削除/追加でも予測できる。初期実装は派生データとし、永続化が必要なら別PO判断にする。
- ゲートが接する物理ターミナルを一意化する既存ロジックは、physical building IDsとcomplex IDの両方を保持する。gate assignment、pax terminal assignment、terminal capacity grouping、diagnosticsのどこでcomplex IDを使うかを明示する。
- 既存の「2ターミナルに接するゲートは推測しない」規則（1-10）を維持する。複合体が同一だからといって別複合体・別区域の曖昧さを握りつぶさない。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了（テスト不足） | 現行の矩形前提箇所を全監査し、Polygon APIとFacility/TerminalAreaの依存関係を整理 | geometry / footprint / operations / validation / renderer / pick / io | 全矩形前提を一覧化し、変更責務を割当て |
| T2 | 完了 | 直交凹ポリゴンの型・検証・タイル化を実装 | geometry/polygon.ts、layout/footprint.ts | L字・T字・コの字、辺/角接触、自己交差、重複点、ゼロ面積、bounds外を単体テスト |
| T3 | 未着手 | 建物作図・編集・形状プレビューUI | editor tools / Toolbox / PropertiesPanel / map renderer | 描画、選択、移動、回転、複製、Undo/Redo後に形状が一致 |
| T4 | 完了 | 複合体の連結成分導出・キャッシュを実装 | terminal complex model / terminal/model.ts | 辺接触・高層連絡橋・planned・工事中・角接触・高さ違い・ループで決定的 |
| T5 | 未着手 | gate / terminal assignment / passenger ownership / capacityをcomplex IDと物理IDに分ける | terminal/model.ts、gates.ts、passengers.ts、validation | 接触したビル同士の同一complex化、ゲートの複合体割当て、物理建物ID維持 |
| T6 | 完了（検証） | 旅客の建物間経路を明示リンクに基づき構築 | terminal graph、5-16との接続 | 同一complexでも通路なしは到達不可、operational linkのみ通行可、区域越境は既存ルール。検証（2026-11-18）: エリア隣接リンクは同一ターミナル内だけで構築されるため、建物間の移動はもともと明示リンク必須だった。これを complexRoute515 3 件で固定（辺接触で同一複合体でも到達不可、L字建物でも同じ、operational リンクでのみ通行可・建設中は将来モデルのみ・planned は不可） |
| T7 | 一部完了 | 2D/3D描画、保存互換、性能とE2E | renderer / io / tests / docs | 旧矩形セーブの往復一致、500建物相当の合成テストで上限・計測値を記録。進捗（2026-11-18 夜）: 2D 描画（MapRenderer.drawFacility）が footprint のある施設を多角形で描くようになった（頂点はタイル角座標、そのまま輪郭として描画）。性能は 5-16 T9 の大規模計測（perf516Large、約 500 施設で analyzeLayout 225ms 中央値）を参照。残: 3D 描画の多角形対応、E2E |

## 5. 互換性・リスク

- 旧矩形は形状フィールドなしで従来どおり扱う。旧データの自動ポリゴン変換を保存時に必須化しない。
- Facilityの型変更や新しいterminalComplexIdを保存する必要がある場合、SCHEMA_VERSION / PROJECT_FORMAT / SIM_MODEL_VERSIONを別々に評価し、必要性と移行テストをPOへ提示する。
- ターミナルIDの意味を変更するとgate・terminalAreas・paxGroup・transfer links・capacity reportが壊れる。初期段階は個別terminalIdを維持し、complex grouping layerを加える。
- 形状の判定方式は座標系（tile/world/map）と丸め誤差を統一し、2D描画とsimulation occupancyで異なる境界判定を持たない。
- 施設数×形状頂点数での全件比較を避け、bounds/spatial index等による性能確保を測定する。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 幾何正常系 | L字・T字・コの字 | 表示/占有/選択/保存の形状が一致 | 未実行 |
| 幾何異常系 | 自己交差・重複点・ゼロ面積・bounds外 | 明示エラー、レイアウト不変 | 未実行 |
| 接触判定 | 同階の辺接触/角接触/異階層重なり | 定義に一致する建物だけ同一complex | 未実行 |
| 高層連絡橋 | 橋がplanned/工事中/operational | operationalだけ現在complexに結合 | 未実行 |
| 旅客経路 | complex内で接続辺なし/あり | 接続辺なしはunreachable、ありは経路探索成功 | 未実行 |
| ゲート | 複数複合体へ接する独立ゲート | ambiguousを維持、暗黙割当てしない | 未実行 |
| 旧データ | 矩形ターミナル・旧TerminalArea | 位置、所属、経路、ゴールデンの意図しない変化なし | 未実行 |
| 性能 | 大規模施設群・複雑輪郭 | 計測値を記録し、定めた閾値以内 | 未実行 |

## 7. 更新対象の文書

- 実装で変化を確認後にdocs/22・26・27・34・35とREADMEを更新する。
- 5-14の内部階定義、5-16の歩行網統合との整合を取る。
- 実装前に本書提案を現行仕様へ転記しない。

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-18 | 計画作成 | 建物矩形/ターミナルID/TerminalTransitLinkの現状を調査し、物理建物・複合体・旅客経路を分離する方針を策定 | Docsのみ。コードテスト未実行 | polygon geometry・complex connectionの詳細設計 |
| 2026-11-18 | T1/T2/T4 実施 | T1: 矩形前提は facilityTiles() に集約されていることを確認（占有・検証・sim はこの API 経由。描画は origin/w/h の矩形描画で T7 残件）。T2: Facility.footprint（直交ポリゴンの外周リング、任意項目）を追加。検証 validateOrthogonalPolygon（自己交差・重複点・非直交・ゼロ面積を拒否）、タイル化はタイル中心包含規則。facilityTiles が footprint を優先し、未設定は従来矩形と完全一致（フィンガープリント不変）。編集プリミティブ setFacilityFootprint（検証・敷地内・外接矩形同期）を operations に追加。T4: terminal/complex.ts で複合体を決定的に導出（同階層の辺接触＋ operational な elevatedWalkway、planned は除外、複合体 ID = 最小の建物 ID）。旅客経路は複合体で短絡しない（未変更） | complexGeometry515.test.ts 7 件合格（L/T/コの字・異常系・矩形等価・設定/解除・辺/角接触・階層差・連絡橋 planned/operational）。fingerprint・validation・levels 回帰 35 件合格、typecheck・eslint 合格 | T3 描画・編集 UI、T5 ゲート/旅客/容量の complex 分離、T6 明示リンク経路の検証、T7 2D/3D 描画と性能計測 |

## 9. 完了記録

- 完了日: 未完了
- 完了した受入条件: T2（footprint 任意項目と検証。complexShape515 5 件）、T4（複合体の導出。complex515 4 件。ただし導出は未利用で、src 内に呼び出し元はない）
- 品質ゲート: T1〜T4 実施時に回帰 46 件・typecheck・eslint・build を確認（§8）
- 未実行/未検証: T1 は §8 の実施記録のみで、監査用の成果物一覧は未充足。T3（配置 UI）は未着手で、footprint を UI から作る手段はない。T5（隣接施設の割当て分離）・T6（旅客経路の複合体対応）は未着手。T7 は保存往復の一部のみで、2D/3D 描画は矩形のまま、性能計測は未実施
- 残件: T3、T5、T6、T7（描画・性能）
