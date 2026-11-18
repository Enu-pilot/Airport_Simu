# Phase 5 / 5-17 実装計画: 誘導路の実幅・機体適合・高速離脱誘導路

> 管理状態: **planned（計画済み・実装未着手）**
> 作成日・更新日: 2026-11-18
> 根拠: PO依頼（2026-11-18）、docs/42 §3.4 要件5-17、docs/22、docs/design/research_ground_geometry.md
> 正本: 本書は実装計画。実寸資料は引用元と出典管理方針に従って確認する。

## 1. 現状と課題

- TaxiwayEdgeはwidthClass: S | M | LとcodeF?を持ち、buildAirsideNetwork()はmaxSize=widthClass・codeFへ変換する。機体側の適合は主にサイズ階級/Code Fで判定し、実舗装幅や主脚外幅・翼端余裕を直接評価しない。
- TAXIWAY_DRAW_WIDTH_M = {S:15, M:23, L:30, codeF:38} は描画用ゲーム値で、実寸の安全設計値ではない（catalog.tsのコメントにも明記）。
- TaxiwayEdgeは端点ノード間の直線区間が基本で、曲線半径・フィレット・肩幅・高速離脱ロールなどは独立した設計データとして保持していない。
- docs/design/research_ground_geometry.mdはB737-800、B777-300/300ER、E190等のメーカー特性を整理しているが、そこにあるgear trackをOMGWSと同一視してはならない。A380-800の該当メーカー資料は現時点で未取得。未確認値を推測で補完しない。
- 現在の自由形滑走路geometryは滑走路の中心線・幅・保護区域のためにあり、誘導路の曲線/幅/フィレットを同じ形状として流用できるわけではない。

## 2. 目的・対象範囲

- 描画幅と、機体が通れるかを判定する実寸舗装幅・肩幅・翼端余裕・主脚クリアランスを分離する。
- FAA Taxiway Design Group (TDG) またはEASA/ICAO系OMGWS区分のいずれかを、混ぜずに選択可能な設計プロファイルとして扱う。
- 曲線・合流・交差・スポット接続を機体の旋回/クリアランス特性で検証する。
- 高速離脱誘導路（Rapid Exit Taxiway, RET）を種別として設定し、角度・曲線半径・喉部拡幅・離脱後直線・滑走路占有時間に反映する。

### 非目標

- 実際の空港の設計・認証・安全審査に使えるCAD/航空保安適合保証。
- 出典のないA380旋回半径やOMGWSを推定して搭載すること。
- 既存の幅区分を一斉に削除し、旧レイアウトを読めなくすること。

## 3. 設計方針

### 3.1 標準プロファイルを混ぜない

参考基準として以下を個別に扱う。

- FAA AC 150/5300-13B Change 1（現行ACの改訂日は2024-08-16）: TDGに応じた舗装幅はTDG 1A/1B=7.6m、2A/2B=10.7m、3/4=15.2m、5/6=22.9m。さらにedge safety marginとshoulder幅が別に示される。ADG翼端保護・分離基準は別の表であり、幅だけで適合判定を完結させない。
- EASA Easy Access Rules for Aerodromes, March 2026: OMGWS <4.5m=7.5m、4.5〜<6m=10.5m、6〜<9m=15m、9〜<15m=23m。曲線では通常走行時の主脚と舗装端の必要余裕を保つフィレット設計が必要。
- これは異なる制度の基準区分であり、TDGとOMGWSを1つの表に混ぜない。ゲーム設定でfaa-tdg / easa-omgws / legacy-gameのように明示選択し、保存時にも選択を残す。
- いずれのプロファイルもゲーム内参考値であり、実設計・法令適合・安全保証を行うものではない。

### 3.2 機体の寸法データと適合

- aircraft catalogにouterMainGearWheelSpanM（OMGWSに相当する外側主脚車輪間隔を、出典・定義付きで格納）、翼幅、wheelbase、nose wheel steering/turning data等を整理する。
- 既存mainGearTrackM等とOMGWSを同義に扱わない。メーカー図の寸法定義と画像を確認し、測定点・タイヤ外面/中心線・派生計算かどうかをデータごとに記録する。
- 資料が存在しない機体はunknownとし、機体の通行可否を広い機体区分から推測しない。必要に応じて警告またはPO承認済みの互換fallbackを使う。
- 判定では幅だけでなく、主脚と舗装端の余裕、翼端と物体/隣接誘導路の余裕、肩幅/路面逸脱時領域を分ける。

### 3.3 TaxiwayEdgeの新しい設計データ

- 候補の追加項目: pavementWidthM、shoulderWidthM、designProfile、designGroup、role: normal | rapidExit、curveGeometry/centerline arcs、必要なら通行可能機種の制限。
- widthClass / codeFは旧データ読込と旧機体の互換層として維持する。新しい設計属性がない旧エッジは、現在の通行可否とゴールデン結果を変えない。
- 機体が通過可能かは、エッジの実幅・肩幅・曲線・周辺物体・隣接通路と機体寸法から判定する。2D描画の太さだけを幅判定へ流用しない。
- 曲線半径/filletは中心線と機体の主脚軌跡・翼端軌跡が舗装/clearance区域内に収まるかを検証する。直線幅だけでS/M/Lを決めない。

### 3.4 高速離脱誘導路 (RET)

- RETは通常誘導路と別のedge role/design featureとして保持し、接続先runway IDを明確にする。
- FAA AC §4.8.5: 高速離脱誘導路は滑走路中心線に対して30度、滑走路からの曲線半径1,500ft（457m）、可能なら最寄りの平行誘導路に直接接続する構成を扱う。
- EASA CS ADR-DSN.D.295: code number 3/4は半径550m以上で湿潤時93km/h、code1/2は275m以上で65km/hを可能にする設計値。角度25〜45度、望ましくは30度。喉部の内側フィレット拡幅と、離脱後に交差誘導路手前で停止できる直線区間も必要。
- FAAとEASAの数字は混ぜず、選択profileに属する値だけ適用する。基準の範囲・空港クラス・適用するdesign speedは明示する。
- RETの役割は見た目だけでなく、到着機が滑走路を空ける時刻/滑走路占有時間、続く到着の最小間隔、経路探索・誘導路ブロックへ影響させる。シミュレーションへの影響は版とゴールデンの差分を測定する。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 未着手 | FAA TDG / EASA OMGWSの適用profile・用語・表を確定 | design profile / docs/design/research_ground_geometry.md | 異なる標準の値を混ぜず、出典・改訂・定義・参考用途を記録 |
| T2 | 未着手 | aircraft catalogの実寸項目・出典・不明値ルールを整理 | aircraft catalog/types / manufacturer references | 各寸法の定義・測定点が一致。未取得値はunknown |
| T3 | 未着手 | 誘導路の実舗装幅・肩幅・Design Group・legacy変換 | TaxiwayEdge / catalog / io / validation | 新旧エッジが読み書きでき、旧結果はlegacy profileで不変 |
| T4 | 未着手 | 曲線中心線・フィレット・機体旋回/余裕判定 | geometry / footprint / airside network / validation | 直線/曲線/合流/交差で機体の主脚/翼端が条件どおり。範囲外は警告/不可 |
| T5 | 未着手 | RETの役割・角度・半径・throat・離脱後停止距離 | runway/taxiway geometry / editor / validation | FAA・EASAのprofileを個別テスト。profile混在0 |
| T6 | 未着手 | RETを到着経路・滑走路占有時間へ接続 | airside network / arrival simulation / runway occupancy | RETの有無・速度profileで滑走路占有が期待方向へ変化し、他機侵入/デッドロック0 |
| T7 | 未着手 | editor/renderer・保存・回帰テスト・Docs | UI / 2D / 3D / io / tests | 幅・曲線・RETを視認/編集でき、旧レイアウト読み込みとモデル版判断が整合 |

## 5. 互換性・リスク

- 既存widthClass / codeFを即時廃止しない。旧保存レイアウトはlegacy-game等で従来どおりに扱う。
- 既存research_ground_geometry.mdにあるgear trackをOMGWSへ直接移さない。A380等出典未取得は未取得のままにする。
- 幅/曲線判定で機体通行可否が変わる場合、SIM_MODEL_VERSIONと既存レイアウトの結果が変わる。旧データ互換・model version・golden baseline・主要KPIを別計画で実施し、ゴールデンを合格目的で更新しない。
- 高速離脱の追加は到着機の経路探索/滑走路占有に影響するため、通常誘導路のcompatibilityとは別テストする。
- この機能はゲーム内の設計参考シミュレーションであり、FAA/EASA/ICAOの審査・設計基準への適合を保証しない。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 幅 | 標準profileごとの必要幅・margin・shoulder | 表と計算が一致 | 未実行 |
| 機体 | 出典のある737-800/777-300ER/E190 | 車輪幅/wingtip/wheelbaseの値と適合が定義どおり | 未実行 |
| 不明機種 | A380等寸法未確認 | unknownで扱い、通行可と推測しない | 未実行 |
| 曲線 | 小半径・大半径・曲線合流 | 必要クリアランスを満たす機体だけ通行 | 未実行 |
| RET | FAA profile / EASA profile | 角度・半径・throat・stop distanceのprofile要件を別々に検証 | 未実行 |
| 運航 | RETあり/なし複数到着 | 滑走路占有・次便間隔・安全不変条件を記録 | 未実行 |
| 互換 | legacy widthClass only layout | 旧モデルの経路/結果に意図しない差分なし | 未実行 |
| E2E | RET作図・プロパティ変更・表示 | 2D/3D/selection/validationが一致 | 未実行 |

## 7. 更新対象の文書

- docs/22、docs/23、docs/26、docs/27、docs/design/research_ground_geometry.md、docs/42、README。
- 現行のゲーム値と参考基準は表を分け、UI/docsに「参考値。ゲーム内の判定であり、実際の安全基準への適合を保証しません」を表示する。
- FAA AC 150/5300-13B Change 1: https://www.faa.gov/documentLibrary/media/Advisory_Circular/AC-150-5300-13B-Airport-Design-Chg1-w-errata.pdf
- EASA Easy Access Rules for Aerodromes (March 2026): https://www.easa.europa.eu/en/document-library/easy-access-rules/online-publications/easy-access-rules-aerodromes-regulation-eu

## 8. 進捗・計画との差分

| 日付 | タスク | 実施内容・判断 | 検証 | 残件 |
|---|---|---|---|---|
| 2026-11-18 | 計画作成 | 現行幅判定と出典付き航空機寸法を監査し、FAA/EASAを分離する設計を計画 | Docsのみ。コードテスト未実行 | 適用profile・不足データ・機体互換fallbackを実装前に承認 |

## 9. 完了記録

- 完了日: 未完了
- 品質ゲート: 未実行
- 未実行/未検証: すべて未実行
- 残件: T1〜T7
