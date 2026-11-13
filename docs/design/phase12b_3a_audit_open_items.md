# 12B-2・12B-3a 前半の監査（部分）の指摘 — 12B-3a 後半のあとに修正
再現スクリプト: scratchpad/audit12b3a/tree/tests/unit/audit/{identity,stress,persist}.test.ts, follow.b0.txt
1. MAJOR（設計と照合）: バス 0 台のとき、到着旅客が waitingBus のまま時間切れにならない（6 h・seed s8 で 252 人残る。対応する trip は phase 'waiting'・groups=0・pax=0）。実装者の報告では「1 時間バスが来なければ stranded」のはず → 0 台（バスユニットなし）の経路で giveup が効いていない。到着側も 1 時間で stranded にする（出発側は noBus で正しく乗り遅れ）。回帰テストを追加。
2. MINOR: formatVersion 1 のファイルに 12B-3a の項目（boardingMode 'bus'・connectedTo・apronBuses）があっても受理される → 読み込み時に「新しい項目があるのに版が 1」を拒否、または 2 として扱う（設計の方針に合わせる。旧アプリが誤読しないことが目的）。
3. MINOR: analyzeLayout の結果に `connectors: []` が常に付く（API の形の変化。issue 一覧は同一）。従来データでキーを出さない方がよいか確認（ゴールデンは不変）。
4. 未検証の穴: 連絡通路が滑走路の着陸帯を横切っても検証がない（GATE_CONNECTOR_LONG のみ）→ 警告を追加検討。
5. テストの所要時間: golden.legacyRemote が単独 181 s、全体実行では負荷で 300 s のタイムアウトに達することがある（ほかにも負荷時のタイムアウト 4 件）→ 特性テストの運航時間を短縮する（新規ゴールデンなので再採取可）か、タイムアウト/並列度を調整。
未実施（予算切れ）: バス故障の各段階・修理・保存復元（旅行中）のビット一致、独立ゲートの実行検証、1日ループ、UI（1600/1400）。
確認済み（問題なし）: 既存 7 レイアウトの network/6h sim/sandbox/serializeProject のハッシュは 5e638f1 と一致、state.bus なし、formatVersion 1。バス運用ストレス 9 シナリオで不変条件・例外 0、積載上限 60 を超えない、バスに旅客を残したまま出発する便なし。永続化の不正入力は明確なメッセージで拒否。
