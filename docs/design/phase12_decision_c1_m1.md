# Decision memo: C1 (runway crossing occupancy leak) and M1 (free-runway hold-short distance)

Base: 57cb0f9 (core sim). Repo files not modified.
I built a prototype in a scratch copy (`git archive 57cb0f9`):
`/tmp/claude-0/-home-user-Airport-Simu/a4f16f36-f020-5cf5-899c-b7c07e025068/scratchpad/phase12/proto`
(full diff: `.../scratchpad/phase12/c1_proto.patch`. Drop the `globalThis.__leak` counter lines before using it.)

Prototype evidence (C1 parts A to D below, without M1 and without the load repair):
- `tests/unit/golden/**`: all 22 golden tests pass with no change (sim, stress-sim, sim-midrun, routes, project-sim).
  A throw-instrumented run showed that the takeoff and docking safety nets are never reached in any golden run.
- Full unit suite: 49 files and 518 tests pass. One run hit a 30 s timeout in simulation.test under load; it passed on rerun.
- Legacy twin (audit `legacy2`, 12 h, seeds a/b/c at 80/day):
  - Before: orphan ticks 27k–35k; departures 34/9/9; diversions 17/41/43.
  - After: orphan ticks 0; departures 54/54/54; diversions 0/0/0.
- B-20deg (free, 8 h):
  - Invariants: R* violations 0 (before: about 1,000–1,300 sampled hits).
  - Rate 80: 0 diversions.
  - Rate 150: about 44 departures and 17–18 diversions, in line with A-90deg.
  - Aircraft stopped between runways while still occupying one: 0. The list-only variant had up to 149 s.

---

## 1. C1: decision

### 1.1 Root causes (three, not one)
1. **Overwrite.** The grant at simulation.ts:665–667 replaces `ac.crossing`. After the aircraft passes node k, `pendingCrossing` returns the next runway node j. If j is within 100 m and free, it is granted and k's grant is lost, so runway k never gets freed. This is the audit's finding.
2. **Chained geometry.** In this case the hold point of j lies before k's release point: `cum[j] − hold(j) < cum[k] + max(hold_after(k), lengthM)`. The aircraft cannot stop clear of k. Today such a route triggers bug 1 on every use. With a plain "list" fix the aircraft would instead wait on runway k for j. I measured waits of up to 149 s in B-20deg, and opposite-direction traffic could deadlock.
3. **Route end inside the release zone (new finding, also pre-existing).** Suppose the departure runway's hold point (pushback route, last node) or the stand lies before the last crossing's release point. Then `moveTaxi` stops being called (holdShort, lineUp, takeoff) or the route is set to null (docking end). The grant stays open forever and the occupant is never freed.
   - R2 does not detect this, because `ac.crossing` still matches the occupant.
   - B-20deg seed c at 150/day hit it: departures went from 14 to 45 once the safety net was added.

### 1.2 Data shape (persistence-compatible)
```ts
// types.ts
export interface CrossingGrant { index: number; runwayId: string; alsoRunwayIds?: string[] }
crossing: CrossingGrant | null;          // unchanged meaning: the furthest (latest-index) open grant
heldCrossings?: CrossingGrant[];         // NEW, optional: other still-open grants, ascending index.
                                         // Key ABSENT when empty (delete, never [] or undefined)
```
- `state.version` stays 1 and the `crossing` shape is unchanged. Old saves load unchanged because the key is absent.
- In a run where the bug never triggers, `heldCrossings` is never created. The serialized state is therefore byte-identical and the golden hashes cannot move.
- Do not convert `crossing` into an array. That would change the persisted shape of every aircraft.

### 1.3 Semantics (exact)
- **A. Chained atomic grant** (in `runwayControl`):
  - `chain = crossingChain(ac, req.index)` = [k], extended with the next runway node j while `hold(j) < release(k)`, transitively. `release` uses the aircraft type's `lengthM`.
  - Every runway in the chain, including `crossingNodeRunways` groups, must pass today's `free` test. All are then occupied at once, all-or-nothing.
  - The last grant goes into `crossing`. The earlier grants are appended to `heldCrossings`.
  - Stop the chain if j's runway IDs overlap IDs already in the chain. This is degenerate geometry, and a guard for it is needed anyway.
  - When the chain is [k] (every non-chained geometry), this is exactly today's code.
- **B. No overwrite.** If `ac.crossing` is non-null at grant time, push it to `heldCrossings` first. This covers the non-chained case where j is granted inside the 100 m window while k is still open.
- **C. Release** (in `moveTaxi`):
  - Release each grant in `heldCrossings` independently with today's predicate (`dist ≥ cum[k] + max(holdAfter, lengthM)`), using a helper `releaseCrossingIfClear`. Then release `crossing` exactly as today.
  - Only free an occupant if `occupant.aircraftId === ac.id` and no other open grant of the same aircraft lists that runway.
- **D. pendingCrossing:** `if (ac.crossing?.index === i || ac.heldCrossings?.some(c => c.index === i)) return null;`
- **E. Safety net:** call `releaseOpenCrossings(ac)` at the top of `startTakeoff` and at docking completion, before `releaseAll`. `releaseEverything` also deletes `heldCrossings`.
- **F. Invariant R2 (tightened):**
  - A crossing occupant is valid only if the aircraft has a route, is in one of {vacating, taxiIn, docking, taxiOut, holdShort, lineUp}, and some grant in `{crossing} ∪ heldCrossings` lists the runway.
  - Add **R2b**: every runway listed in any open grant has `occupant.aircraftId === ac.id`.
- **G. Load:**
  - `checkSim` also validates `heldCrossings` when present: it must be an array of `{index: number, runwayId ∈ layout, also ⊂ layout}`.
  - Add `repairCrossingState(state)` in core/sim and call it in `restoreSimulation` before `checkInvariants`. It clears crossing occupants that the tightened R2 rejects, and clears grants held by aircraft that are not taxiing.
  - It changes nothing in a consistent state (the midrun golden has violations = []).
  - Today such a save fails `validateProject` entirely (project.ts:355 turns violations into errors). With the repair it becomes loadable. Return the repaired items as a warning, not as an error.

### 1.4 Identity argument (why no non-triggering run changes)
Each change only diverges from today's code when one of these holds:
- **A:** the chain length is greater than 1. That happens only when `hold(j) < release(k)`, and such a crossing always overwrites today, so the bug triggers on every use.
- **B:** `ac.crossing` is non-null at grant time. This is the overwrite itself.
- **C and F:** `heldCrossings` is non-empty, or the state was leaking.
- **D:** a held index is never the first pending node unless A applied.
- **E:** a grant is still open at takeoff or docking end, which is the leak itself.
- **G:** the state already violated R2.

Every one of these conditions is a run in which the leak happens. The goldens confirm this: unchanged, and E is never reached in them.

### 1.5 Version decision: NO SIM_MODEL_VERSION bump (bug fix). PO sign-off still needed (4.6)
- Results change only in runs where the occupancy leak actually happens. Those runs are detectable: R2 hits today, or a grant still open at takeoff or docking end.
- A bump would throw away every saved running state (project.ts:324). The healthy ones are almost all of them.
- The golden guard (D10) stays satisfied: no golden changes.
- This fits the doc rule in spirit: no change to correct results; incorrect ones are repaired.
- Record it in docs/21 §versions and docs/22 §5: "Phase 12 C1: fixes a crossing-occupancy leak in place since Phase 2. Only runs in which it occurred change. SIM_MODEL_VERSION unchanged. Saved states with an orphaned crossing are repaired on load."
- Saved scenarios are affected only if their recorded result came from a leaking run (twin-type layouts). On re-run they will differ under the same version label. Note this in docs/18.
- Forward compatibility: an older build loading a new save with `heldCrossings` would ignore it and leak as before. Acceptable, because format compatibility is one-way.

## 2. M1: decision (free runways only; legacy byte-identical)

- **New function** in routes.ts: `holdShortOnRoute(ctx, r, i, dir: -1 | 1): number`. It returns the along-route distance from `cum[i]` to the stop point (dir −1) or the clear point (dir +1). Replace every call site with it: pendingCrossing, movementLimit, taxiOut `holdAt`, vacating release, crossing release, and `crossingChain`.
  1. If node i has no free runway, return `holdShortDistance(edgeLen)`. This is the legacy path, untouched.
  2. Compute today's free value d0. If it is not clamped (`sinθ ≥ sin15°` for every free runway and `H/sinθ ≤ 0.6·edge`), return d0. This keeps currently correct free cases identical.
  3. Otherwise **walk the route** away from node i, segment by segment. Find the smallest s where `g(s) = min_R(distToCentrelineSegment_R(p(s))·TILE_M − H_R) ≥ 0`.
     - R ranges over the node's free runways plus its `crossingNodeRunways` group.
     - Use distance to the centreline **segment**, not the infinite line, so that entries at runway ends and on the extended centreline work.
     - If the far end of a segment satisfies g, bisect (fixed 40 iterations, deterministic) between that segment's start and end.
     - Stop the walk at: another runway node on the route; `runwayEnd`; route index 0; a standLink edge; or a total walk of more than `max(3·H, 300 m)`.
  4. If no point is found, fall back to d0 (today's value).
- Add `a` and `b` (centreline endpoints, tiles) to `FreeRunwayInfo`.
- Optionally memoize results per route object in a WeakMap. The values are derived and deterministic.
- **Validation:** add `HOLD_SHORT_TOO_CLOSE` (warning, free runways only). For each free-runway node and each incident taxiway edge, walk outward by DFS over taxiway edges under the same stop rules. Warn if any branch cannot reach H.
  - Params: `{ runwayId, achievedM, requiredM }`; `at` is the node position.
  - This also covers the C1 chain geometry and the departure-hold-inside-another-runway case, so it is the user-facing explanation of 1.1(2) and 1.1(3).
  - Legacy layouts never trigger it, so validation goldens are unchanged. Add an i18n string and an IssuesPanel entry (implementer is in ui).
- Mixed node (legacy and free runway at one node): use `max(free result, legacy holdShortDistance(edgeLen))`.

## 3. Tests

Keep all of these identical, with no `GOLDEN_UPDATE`: sim, stress-sim, sim-midrun, project-sim, routes, project, normalized-hashes, and all geometry goldens. `sim-versions.json` stays at skyport-sim-10.0.

New tests:
1. `crossing.chain.test.ts`, legacy twin (the audit `legacy2` layout; 6 h, seed a, 80/day):
   - every 10 ticks `checkInvariants` returns [] (tightened R2 and R2b);
   - no crossing occupant exists without a matching grant;
   - departures ≥ 45, diversions ≤ 2.
2. Free runways crossing at 23° (or audit B-20deg): same assertions, plus "no taxiing aircraft has speed 0 with an open grant for more than 0 ticks while outside hold points". The simpler form: R* violations 0, and `maxWaitOcc` = 0.
3. Unit test with a forced overwrite (grant k, step past k, grant j within the window): k is released at its own release point and `heldCrossings` is deleted afterwards.
4. Takeoff and docking safety net: a constructed layout whose departure hold lies inside the previous crossing's release zone. After `startTakeoff`, the crossed runway is free.
5. io: a save whose `heldCrossings` points at an unknown runway fails `checkSim`. A save with an orphaned crossing occupant loads, is repaired, and carries a warning. A save without the key round-trips byte-identically.
6. M1:
   - θ = 5°, H = 90: the stop point's perpendicular distance is ≥ 90 m.
   - A 50 m edge at 90° with a long previous edge: the stop point is on the previous edge, at H.
   - The infeasible case falls back to d0 and raises the `HOLD_SHORT_TOO_CLOSE` warning.
   - Legacy nodes: `holdShortOnRoute` equals `holdShortDistance` over all fixture routes (property test over the routes golden).
7. Re-run the audit stress matrix (A–F, seeds a/b/c, 80/150) as a non-CI check. Expect R* = 0 and no orphan ticks.

## 4. Other unsafe points in the crossing model (follow-ups, not in this fix)
1. **A crossing near an intersection is not grouped.** Only a crossing exactly at the intersection node reserves both runways. A taxiway crossing S within H of the intersection X stands in R's protected area. Partner checks ignore `purpose === 'crossing'`, so R may operate meanwhile.
   - Fix (free layouts only): add to the group any free runway whose centreline segment lies within its H of the crossing node.
   - The M1 walk then uses the same set.
2. **Dependent mode relies on time gaps after liftoff.** The takeoff occupant is released at `takeoffDistanceM`. Partner ops are then separated only by `SEPARATION_SEC` and `ARRIVAL_AFTER_DEPARTURE_SEC`, counted from roll start. If X lies beyond the liftoff point, a partner roll through X can start while the departing aircraft is still climbing over X.
   - Acceptable as a game abstraction. Document it, and consider holding the partner while the departure is airborne within the threshold-to-X distance.
   - R6 ignores crossings and airborne aircraft. Low risk.
3. **Vacating into an immediate crossing.** If the hold point for j lies before the landing runway's vacate release, the aircraft waits on the landing runway. Two aircraft doing this crosswise, A on R toward S and B on S toward R, deadlock.
   - This is pre-existing and rare. `HOLD_SHORT_TOO_CLOSE` flags it for free layouts. For legacy, consider a later chained landing-vacate reservation, which needs a version decision.
4. **The 100 m request window is a fixed distance.** It is independent of taxi speed. Keep it as is (changing it would affect goldens).
5. **`crossing` grants pin the route.** Any future reroute while taxiing must call `releaseOpenCrossings` first, or indices become stale. Add a comment or assert.
6. **PO confirmation needed:** "bug fix without a version bump; only leak-affected runs change" (1.5).
