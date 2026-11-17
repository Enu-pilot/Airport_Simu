# ゴールデンの差の原因の特定と更新（2026-11-17）

- `actual/` … 副作用の修正（コミット eeba67f）後に採取した実測値（2 回の採取が完全に一致）。
- 比較: `python3 tests/golden-baseline/compare.py tests/golden-baseline/2026-11-16_pre-phase1/actual tests/golden-baseline/2026-11-17_post-phase1-fix/actual`

## 原因の特定の方法

隔離した複製で、フェーズ 1 の変更を 1 つずつ修正前に戻して採取し、どの変更がどの差を消すかを調べた。

| 差 | 戻すと消えた変更 | 判断 |
|---|---|---|
| 通常の運航の旅客の歩行・待ち（24 時間運航の平均歩行 9.9 → 9.5 分など）、バス運航の乗り遅れ・ダイバート数 | `src/core/sim/passengers.ts` の付け直し条件（1-07） | 副作用 → 修正 |
| 積み残し手荷物の指標 0 → 1,747 / 766 / 184 | `src/core/analytics/kpi.ts`・`records.ts` の数え方（1-09 の結果を数えていた） | 副作用 → 修正 |
| 欠航・ダイバートを含む運航の状態ハッシュ・状態の大きさ | `src/core/sim/passengers.ts` closeBoarding と `baggage.ts`（1-09） | 正当（不具合修正の直接の結果） |

修正後、修正前の採取と異なるのは bus-sim（plain-seed）・game-weather（bad-winter-normal）・legacy-remote-sim（plain-seed）・stress-sim（stress-a）の状態ハッシュと状態の大きさだけ。

更新の判断と版の扱いは docs/42 §5.1。
