# 12B review (5e638f1..96e0ee8) — design lead notes
Verdict: acceptable after 1 required fix (R1) + 2 small required consistency fixes (R2, R3).

## Opt-in isolation — verified by reading
- simulation.ts: settings spread only with company.game; state.wx only game.weather==='levels'; state.bus only ctx.busGates>0; goAround reason spread only if given; cancelTurnaround only via wx or cancelFlightEarly (needs game); apronBus delay cause only p.bus.
- passengers.ts: all branches gated on state.bus / p.bus / gateMode; hasBridge unchanged for non-bus; missGroups delete busTrip no-op.
- ground.ts: apronBus appended last, units only if apronBuses>0 -> same gu_n ids & rng draws; lightningStop short-circuits on state.wx.
- disruptions.ts: weatherEffects legacy table w/o wx; p*scale with scale=1 identical; weather random pick drawn same.
- economy: otpAddOf 0, offerBoost 1, aircraftIsLow false (rng.next short-circuit order unchanged), tierBonus 0, cancelPenalty identical, ev undefined -> legacy path. settleDay eval/goals gated on c.game flags.
- terminal/model: links re-sort is a no-op for legacy (already sorted; gates add no links). connectors:[] key always present (audit #3).
- goldens: only new files + capture.ts additions + 4 new sim-versions lines.

## Findings
R1 (MAJOR-ish, bug): early cancel double penalty. simulation.ts cancelTurnaround 'early' does rel.satisfaction -= 1 immediately AND computeKpi counts earlyCancelled (both legs) -> cancelPenalty 2*0.1*5 = 1 at close. Measured: sandbox, game(legacy wx, eval/goals off), airline RJ: 62 vs 60 (−2). docs/30 & toast say −1. Fix: drop the immediate decrement (keep close-time) or drop ec from cancelPenalty; add a test asserting total −1 over a day.
R2: report.cashEnd taken before goal grants (ops.ts settleDay) -> cashEnd(N+1) − cashEnd(N) ≠ profit+construction; also kpi.rating pre-reward and checkBankruptcy before grant. Either include grants in cashEnd (and document) or document explicitly in docs/30 §4 / docs/14; review screen should show grants line.
R3: evalRules effects (offerBoost/complaintCount/tierBonus/aircraftIsLow/relief) gate on presence of c.airlineEval/c.goals, not c.game flags. importCompany/checkGameFields don't enforce "airlineEval only if game.airlineEval". Hand-edited/legacy-with-keys companies get effects w/o game. Fix: strip in importCompany/validate or gate on c.game?.airlineEval / c.game?.goals.
Minor:
- stepWeather runs after stepDisruptions (design said before) — after is better (override sees same-tick disruptions); update design/docs.
- weather.ts comment says "×0.9" but UP_FACTOR 0.55 (docs/30 says 0.55).
- LCC weights: design row summed to 1.05; impl stand .10 -> sums to 1. Accept, docs/30 matches.
- Weather cancel penalty: design "−2.5/便", impl 1.25/便 (2.5/turnaround). docs/30 matches impl. Accept.
- ProjectPanel shows "保存形式 v{PROJECT_FORMAT_VERSION}" = v1 even for v2 projects.
- docs/21 day-history says projectJson formatVersion 1 — now 2 for game companies.
- BU3 "one tick" relaxation: invariant never checks broken-with-trip at all; advance() fixes next tick deterministically. Acceptable; document that a save on that tick restores fine (advance runs first).
- Arrival 1h give-up inside createRequests sits after `if (!ac?.standId) continue` -> once aircraft leaves stand, waiting arrival pax never strand (this is audit #1).
- Apron buses move straight-line, ignoring runways/taxiways (no crossing control). Fine as game abstraction; label in docs/29 and revisit with Phase 13.
- cancelTurnaround: scheduled aircraft hold no stand/tasks/crossings; departure pax closed via existing f.status==='cancelled' path (bags same as divert). OK.
- Persistence: PROJECT_FORMAT_VERSION=1 + _VERSION_2 is sound (writes 1 when no new fields, project.golden unchanged; old apps reject v2). v1-with-new-fields acceptance is audit #2.
- Day loop: live frame & skip both use stepTicks with stopAtDayClose; night FF ends ≤ close; endOps atClose avoids second report; restoreHistory -> validateProject. OK.
- UI: no direct sim mutation, no core->ui imports; wording labels game values.
