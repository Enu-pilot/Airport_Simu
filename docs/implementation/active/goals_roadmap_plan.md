# 実装計画: 経営目標ページの格ロードマップ（2026-GOALS）

> 管理状態: active（実装開始済み）
> 作成日: 2026-11-22
> 更新日: 2026-11-22
> 根拠: docs/42 §3.11（2026-GOALS）、PO 指示 2026-11-22「経営の目標のページに何もないのが気になるので、格ごとの達成要件と現在の達成状況をすべてロードマップとして実装してほしい。現在の連続達成日数と最長の達成記録も表示してほしい」
> 正本: 本書は実装計画。現行機能仕様は docs/30 §4 を参照（本作業で記録項目と表示を追記する）。

## 1. 現状と課題

- 現行の実装・テスト・仕様:
  - 格の要件は `src/core/economy/goals.ts` の `TIER_REQ`（格 1〜7。発着・旅客・評価・大型機可否・連続日数、格 5 は国際線実績、格 6 は乗継実績を追加）。日次評価 `evaluateGoals` が次の格の条件を満たす日を `goals.streaks.tier` に数え、`streakDays` 日続くと昇格する（降格なし）。
  - 表示は `nextTierProgress`（次の格のみ・表示専用、5-20 T6）が正本で、上部バー・拠点パネル・目標カード・目標パネル（`GoalsPanel`）が使う。
- 実装済み:
  - 次の格の要件ごとの到達度（現在値・不足分）と連続達成 `current/required` の表示。
- 不具合・未実装:
  - **目標ページが実質空**: `GoalsPanel` が運航中のみ存在する `useOps()` から会社を引くため、建設モード（運航していない状態）では会社データを取得できず「すべての目標を達成しました」の 1 行だけになる。経営ボードの「目標」タブは建設モードで開くのが通常のため、プレイヤーには何もないページに見える。
  - **全格のロードマップがない**: 表示は常に「次の格」だけで、達成済みの格・先の格の要件と現在の達成状況を一覧できない。
  - **最長記録がない**: `GoalState` は現在の連続（`streaks`）だけを保持し、過去最長の連続達成日数は記録されていない。
- 調査したコード・テスト:
  - `src/core/economy/goals.ts`（GoalState・evaluateGoals・nextTierProgress・checkGoals）、`src/core/economy/company.ts`（importCompany の読み込み時移行・検証で goals を捨てる条件）、`src/ui/operate/cards/GoalsCard.tsx`（GoalsCard・GoalsPanel・NextTierView）、`src/ui/ManagementPanels.tsx`（useCompany: 運航中は sim の会社、建設中はストアの会社）、`tests/unit/nextTierProgress.test.ts`・`tests/unit/goalsEvents507.test.ts`。

## 2. 目的・対象範囲

### 目的
- 経営の目標ページに、格 0〜7 のすべてをロードマップとして表示する（格ごとの達成要件・現在の達成状況・達成済み／現在／次の格の区別）。
- 次の格について、現在の連続達成日数（必要日数つき）と最長の達成記録（過去最長連続日数）を表示する。
- 目標ページを建設モードでも表示できるようにする（会社データの取得経路の修正）。

### 対象
- `src/core/economy/goals.ts`: 最長記録 `bestStreaks` の保持と日次評価での更新、ロードマップ組み立て `tierRoadmap`（表示専用）、`checkGoals` の検証追加。
- `src/core/economy/company.ts`: 読み込み時（importCompany）に旧セーブの `bestStreaks` を現在の `streaks` から種付けする。
- `src/ui/operate/cards/GoalsCard.tsx`: `GoalsPanel` のデータ取得を `useCompany` に切り替え、ロードマップ表示を追加する。
- `src/i18n/ja.ts`: ロードマップ表示の文言。
- テスト・Docs（本書、docs/42 §3.11、docs/30 §4、HANDOFF）。

### 非目標
- 昇格ロジック・要件値・報酬の変更（判定は従来どおり。表示と記録のみ）。
- 過去の各格の昇格日の遡及（保持しているのは現在の格の `tierDay` のみ。過去分は表示しない）。
- 連鎖目標（chain）のロードマップ化（対象は格のみ。連鎖の最長記録は `bestStreaks` に同じ仕組みで残すが、表示は格を正とする）。

## 3. 設計方針

- **最長記録**: `GoalState.bestStreaks?: Record<string, number>`（任意項目。キーは `streaks` と同じ: 目標 ID・`tier`・`chain`）。`evaluateGoals` が連続を更新する箇所すべてで `best = max(best, 現在の連続)` を保つ。値が 0 のキーは書かない（保存データを汚さない）。
- **旧セーブ互換**: 項目がない旧セーブは、読み込み時に `bestStreaks = { ...streaks }`（現在の連続からの開始）として種付けする。`checkGoals` は項目がある場合だけ形を検証する（`streaks` と同じく非負整数の値）。SCHEMA・SIM_MODEL_VERSION は上げない（任意項目の追加のみで、運航結果・判定に影響しない）。
- **ロードマップ組み立て**: `tierRoadmap(c, facts?)` を表示専用に新設する。要件ごとの到達度は `nextTierProgress` と同じ定義（発着・旅客は直近の日報、評価は現在の会社評価、大型機・国際線・乗継は facts）で全格分を組み立てる。到達度の部品生成は内部関数に切り出して `nextTierProgress` と共有し、既存表示の挙動は変えない。各格の状態は `achieved`（現在より下）／`current`（現在の格）／`next`（次の格）／`locked`（それより先）。連続の要約（現在・必要・最長）は次の格に対するものだけを持つ。
- **UI**: `GoalsPanel` は `useCompany()`（ManagementPanels。運航中は sim の会社・建設中はストアの会社）で会社を取り、運航中だけ得られる facts（大型機の運航可否・直近の締め日の記録）は従来どおり `useOps()` から補う（なければ「—」＝不明。拠点パネルの既存表示と同じ扱い）。会社に目標設定がない場合は、達成済みと誤認させる従来文言ではなく「目標が設定されていない」旨を表示する。
- **決定性**: 記録は日次評価の決定的な更新のみ。乱数の消費順序・昇格判定には一切触れない。

## 4. タスク分割と受入条件

| ID | 状態 | 変更内容 | 主な対象 | テスト・受入条件 |
|---|---|---|---|---|
| T1 | 完了 | bestStreaks の保持・更新・検証・旧セーブ種付け | goals.ts・company.ts | 新規テスト 13 件中の該当分が合格（連続の増加・途切れ・昇格・検証・種付け・往復） |
| T2 | 完了 | tierRoadmap の組み立て（全格・状態・到達度・連続要約） | goals.ts | 新規テスト合格（状態・met/不足分・facts 判定・最長フォールバック・最高格 null・昇格日） |
| T3 | 完了 | 目標ページのロードマップ表示とデータ取得の修正 | GoalsCard.tsx・ja.ts | GoalsPanel を useCompany 化し TierRoadmapView を追加。ブラウザ E2E は環境なしのため未検証 |
| T4 | 完了 | Docs 登録と仕様追記 | docs/42・docs/30・本書・HANDOFF | 2026-GOALS を §3.11 に登録、docs/30 §4 に記録・表示仕様を追記 |

## 5. 互換性・リスク

- 保存形式／スキーマ: 任意項目 `bestStreaks` の追加のみ。SCHEMA_VERSION は据え置き。旧データは検証を通り、読み込みで種付けされる。
- シミュレーションモデル版・ゴールデン: SIM_MODEL_VERSION は据え置き（判定・運航結果は不変）。保存ペイロードに項目が現れる場合、ゴールデンのハッシュが変わりうるため、変更前後で差分が当該項目だけであることを JSON 差分で証明してから扱う。
- 既存データ・既存シードの結果: 昇格・報酬・評価の結果は不変。最長記録は旧セーブでは現在の連続が初期値になる（過去分の遡及はしない）。
- 性能・決定性・不変条件: 日次評価に最大値の更新が加わるだけ。決定的。
- 失敗時の切り戻し・影響範囲: 表示と記録のみのため、切り戻してもセーブは読める（追加項目は無視される）。

## 6. テスト計画

| 対象 | テスト | 合格条件 | 実行結果 |
|---|---|---|---|
| 正常系 | tests/unit/goalsRoadmap.test.ts（新規） | bestStreaks の更新・tierRoadmap の組み立てが仕様どおり | 合格（13 件。新規ファイル単体） |
| 境界値・異常系 | 同上（最高格・目標なし会社・不正な bestStreaks の検証） | null・拒否が正しく返る | 合格（同上） |
| 回帰・互換性 | nextTierProgress・goalsEvents507・airlineEvalGoals 等の関連テストとゴールデン | 既存の合格が維持される。ゴールデンの差は bestStreaks 項目だけと証明できる場合のみ扱う | 関連 40 件合格。ゴールデン 30 件中 25 件合格・5 件失敗（幾何 4 件は pristine でも失敗する既存不一致。残る game-models は下記）。gameSave は 1 件失敗するが、pristine でも同一の失敗（tier=7 の検証期待）が再現する既存失敗で本変更と無関係（A/B 確認済み）。gameModels.test 19 件は合格。全ユニットスイートは共有 VM の混雑で完走せず打ち切り（実行分に本変更起因の失敗なし） |
| E2E・性能（該当時） | 目標ページの表示はユニット（組み立て）と型検査で担保し、ブラウザ E2E は環境（Playwright ブラウザ未導入）のため未検証として扱う | — | 未検証（E2E。testid は既存の goals-panel・goal-row-* を維持） |

### ゴールデン game-models の差の帰属（2026-11-22 実施）
- `game-models.golden.json` は採取に `goals` の全量を含むため、bestStreaks の記録開始で内容が変わった。SIM_MODEL_VERSION は変えていない（運航結果を変える変更ではない）ため、台帳ガードにより GOLDEN_UPDATE は拒否される設計。そこで A/B の全量比較で帰属を証明した上で、採取テキストを手動で差し替えた（台帳の版記録は 10.13 のままで正しい。前例: 2026-DEMAND の project-sim 指紋の手動差し替え）。
- 証明: pristine（変更前コード）の採取は保存済みゴールデンとバイト一致（採取の再現性を確認）。変更後の採取との構造 diff は **2 件だけ**で、いずれも `runs.*.goals.bestStreaks` の追加（day0-normal: `{otp85x3: 1, otp95x7: 1, tier: 1}`、bad-winter-hard: `{otp85x3: 1, tier: 1}`）。KPI・現金・評価・airlineEval・goals の done/streaks/tier/grants は完全一致し、運航状態は不変。
- 差し替え後に golden.gameModels は合格。
