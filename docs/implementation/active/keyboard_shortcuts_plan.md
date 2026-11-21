# 実装計画: キーボードショートカットの追加（階・サイズ・切り替え系）

> 管理状態: **active（実装完了。作業コピーで検証済み、PR 化は PO 指示待ち）**
> 作成日・更新日: 2026-11-21
> 根拠: PO 依頼（2026-11-21）「誘導路やエプロンなどのサイズを S/M/L/F キーで変更」「階層選択を数字キーで（8=地下3階、0=地下1階）」＋追加指示「その他の切り替え操作も追加できそうであれば追加」
> 正本: 仕様（キー対応表・一般原則）は [docs/06 §4.1.1](../../06_ui_design.md)。本書は監査・設計判断・実装記録を持つ。

## 1. 監査結果（実装前の現行状態）

### 1.1 既存のキー割当て（`src/editor/input.ts` の onKeyDown / onOperateKey）

- 建設モード: Space（パン）、Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y（取り消し・やり直し）、Ctrl+D（複製）、Esc（取消し・終了・選択解除）、Enter（経路確定）、Delete / Backspace（削除）、R（回転）、V（選択ツール）、矢印（移動 / カメラ）。
- 運航モード: Space（一時停止）、数字 1〜5（時間倍率。SPEED_LEVELS の添字 1〜5）、Esc（選択解除）、矢印（パン）。
- 配線（`src/ui/App.tsx`）: input / select / textarea / summary にフォーカスがある間はエディタ系キーを発動しない仕組みが既にある。ATC モード中は経営側のキー処理自体が届かない。FIDS オーバーレイと経営ボードは Esc のみを capture で先取りする。
- 結論: 建設モードの英字（s/m/l/f・a・b・c・e・g・i・n・p・t）と数字（0〜9）はすべて未使用で、新規割当てと衝突しない。運航モードの数字は速度と衝突するため、階の割当ては建設モード限定にする。

### 1.2 サイズ段階を持つツール

| ツール | オプション | 実態 |
|--------|-----------|------|
| 誘導路 | taxiWidth: SizeClass | S/M/L の3段階（Toolbox の SizeSelect） |
| 駐機スポット | standSize: SizeClass | S/M/L の3段階（STAND_DIMS と連動） |
| 滑走路 | runwayWidth: 30/45/60 | 3段階。RUNWAY_WIDTH_CLASS で S/M/L 級に対応 |
| エプロン | （なし） | 施設のドラッグ矩形で大きさが決まる。段階パラメータを持たない |
| PBB | pbbType: tunnel1/tunnel2/tunnel2Upper | 型式であってサイズではない |
| 道路 | roadClass | 種別（カテゴリ）であってサイズではない |

SizeClass 自体が 'S' | 'M' | 'L' の3段階（`src/core/model/types.ts`）であり、F という段階は存在しない。

### 1.3 階層の実態

- 表示階は絶対地図階層で管理され、B3F=−3 〜 4F=+3（建物内階 = 地図階層 + 1、floorDisplay が唯一の換算）。
- 階ボタン（Toolbox・OpsPanels）は `actions.setInteriorLevel(level)` を使い、interiorLevel・mapLevel・roadLevel・内部表示が同期する（PR #62）。「全レイヤ」は `setMapLevel('all')` で、配置先の階を維持する別経路。
- 階ボタンの範囲は FLOOR_SELECTOR_LEVELS = [−3..3]（B3〜4F）。

## 2. 設計判断

1. **数字キー → 階**: PO の例どおり 8=B3F・9=B2F・0=B1F・1=1F・2=2F・3=3F・4=4F の連続配置。作用は階ボタンと同一の setInteriorLevel に統一（同期の二重実装を避ける）。5〜7 は範囲外のため未割当て。
2. **S/M/L/F → サイズ**: 段階リストへの一般規則（S=最小、F=最大、M/L は 1/3・2/3 の位置を切り上げ）として仕様化し、3段階では S/M/L が 1 対 1、F は最大（Full）の別名になる。F を独立の第4段階にしないのは、SizeClass・STAND_DIMS・スポット占有まで波及するモデル変更になるため（PO の「太さ・大きさを変更できるように」の範囲を超える）。
3. **文脈**: サイズキーは現在のツールにだけ効く（Toolbox にセレクトが出る文脈と一致）。対象外ツールでは素通りさせ、他の意味を持たせない（L = ラベル等の文脈依存の二重割当てを避ける）。
4. **切り替え系の追加範囲**: ストアの既存アクション（setTool / setMapLevel / toggleOverlay）で完結するものだけを割り当てた。頭文字の自然さと衝突回避を基準に、ツールは T（誘導路）・P（スポット）、全レイヤは A、レイヤは G/I/N/E/B/C（両モード共通）＋運航専用の F（便名）・P（バスの人数）・K（貨物数）・D（昼夜表現）。P のモード別割当ては数字キー（階 / 速度）の前例に倣う。
5. **見送り**: モード・ページ切替（状態は App 側＋開始・終了は専用フロー）、2D/3D（自然な空きキーなし）、滑走路・道路・土地・PBB・AGT のツールキー（頭文字が既存と衝突）、ラベル（L はサイズ専用）、施設・エリア各ツール（30種超）。理由は docs/06 §4.1.1 に集約。
6. **フィードバック**: 階・サイズ・レイヤはトーストで結果表示。あわせて既存 UI の表示がそのまま連動する（階ボタン・セレクト・ポップオーバーのチェック）。発見可能性のため、レイヤーポップオーバーと階ボタン・サイズセレクトにキー表示を追加した。

## 3. 実装

| ファイル | 内容 |
|----------|------|
| `src/editor/shortcuts.ts`（新規） | 純粋な対応表: LEVEL_FOR_DIGIT_KEY、sizeStageIndex の一般規則、sizeClassForKey / runwayWidthForKey、sizeOptionForTool（ツール文脈）、TOOL_FOR_KEY、ALL_LAYERS_KEY、BUILD/OPERATE_OVERLAY_TOGGLES、UI 表示用の逆引き（digitKeyForLevel / keyForOverlayToggle） |
| `src/editor/input.ts` | onKeyDown（建設）: 数字→setInteriorLevel、S/M/L/F→setOption、A→setMapLevel('all')、レイヤ→toggleOverlay、T/P→setTool を既存 switch の前段に追加（Ctrl 併用時は従来どおり素通り）。onOperateKey: レイヤ切替を先頭に追加 |
| `src/ui/shell/Rail.tsx` | レイヤーポップオーバーにキー表示（例: 「グリッド（G キー）」） |
| `src/ui/Toolbox.tsx` | 誘導路・スポットのヒントにキー併記、階ボタンの title に数字キー、SizeSelect・舗装幅セレクトの title に S/M/L/F の案内 |
| `docs/06_ui_design.md` | §4.1.1 を新設（仕様の正本: 一般原則・対応表・一般規則・既存キー・見送り理由） |
| `docs/42_implementation_roadmap.md` | §3.11 の PO 追加要望バッチに 2026-KEY を追加 |
| `tests/unit/keyboardShortcuts.test.ts`（新規） | 対応表の固定（階・サイズ一般規則・文脈・切替）、既存キーとの非競合、ストア経由の発動（階の同期・サイズ変更・トグル・運航モード）: 20 件 |

- セーブ形式・SIM_MODEL_VERSION は変更しない（UI 状態のみ）。ゴールデン全件不変が受入条件。
- 実ブラウザでの目視確認は未実施（検証はロジック・DOM 構造ベース）。

## 4. 検証結果（2026-11-21、作業コピー shortcuts-work）

- 新規テスト `keyboardShortcuts.test.ts`: **20/20 通過**。
- 関連する既存テスト: editor.free / terminalLevels / levels509 / overlayLayers / floorUnificationJ1（J-1）・shellPhase1 / 2 / 4 / 7a・terminalWorkspace・undergroundTerminalG（G）・serviceModesUi・siteSizes・回帰 u_levelSync / u_roadDefaultCapacity はすべて通過。
- **ゴールデン: 10 ファイル 30 件全件不変で通過**（再採取なし）。SIM_MODEL_VERSION は上げていない。
- `npx tsc --noEmit`・変更ファイルの eslint・`npm run build`: 通過。
- 既存の失敗（本変更と無関係であることをベースツリーとの対照で確認済み）: shellPhase7b の 2 件（就航範囲の表示・B7 複合体表示。現行 main でも同一に失敗）、実セーブ参照の ENOENT 系、重量級テストの制限時間タイムアウト等。
- 全ユニットテスト（約 270 ファイル）のうち約 145 ファイルは実行完了し上記以外の新規失敗なし。残りの重量級 sim テスト群は実行環境の再起動・競合で完走できなかったが、変更モジュール（editor/input・shortcuts・Toolbox・Rail）を参照するテストは全て実行済みで、sim 本体には変更がない。
