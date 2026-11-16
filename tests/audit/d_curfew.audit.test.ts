/**
 * 監査 d / 都市の夜間騒音規制（docs/31 §騒音・夜間制限: 夜間 = 22:00 以上 06:00 未満。都市設定がある便計画は 06:00〜22:00。
 * 遅延で夜間にかかった着陸は次の 06:00 まで待機。離陸も滑走路上の予測時刻が夜間なら滑走路手前で待機）。
 * 実装: src/core/economy/city.ts（CITY_NIGHT_CURFEW, isCityNightMovement, nextCityMovementTime, cityOperatingHours）、
 *       src/core/sim/simulation.ts stepInbound（着陸側）/ departureBlocked・runwayControl（離陸側）、src/core/economy/ops.ts cityNoiseMetrics。
 * 仕様に矛盾する挙動（2 機以上の夜間待機機が 06:00 にまとめてダイバートする件）は known-issues/d_curfewDivert.repro.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { Rng } from '../../src/core/rng';
import { aircraftNoisePoints, applyCityNoiseImpact, CITY_TYPES, defaultCity, nextCityMovementTime } from '../../src/core/economy/city';
import { planDay, planDayWithDemand } from '../../src/core/economy/planning';
import { resolveType } from '../../src/core/sim/aircraftTypes';
import { checkInvariants } from '../../src/core/sim/invariants';
import { HOLD_DIVERT_SEC } from '../../src/core/sim/rules';
import { stepTicks } from '../../src/core/sim/dayloop';
import { addTurnaround, stepSimulation, flightDelayMin, type Simulation } from '../../src/core/sim/simulation';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addWindowContracts, cityCompany, citySim, DAY_SEC, H, hms, isNight, linearLayout, logD } from './d_helpers';

const SEEDS = ['d2-s1', 'd2-s2', 'd2-s3'];

/** t（絶対秒）から maxSec 進める。cond が真になったら止める。invariants を every ごとに確認し、違反は例外 */
function runUntil(sim: Simulation, maxSec: number, cond: (s: Simulation) => boolean, every = 120, label = ''): void {
  for (let i = 0; i < maxSec; i++) {
    stepSimulation(sim);
    if (i % every === 0) {
      const v = checkInvariants(sim);
      if (v.length) throw new Error(`${label} t=${hms(sim.state.now)}: ${v.slice(0, 4).join(' / ')}`);
    }
    if (cond(sim)) return;
  }
}

describe('ID-d2a 計画: 都市設定ありの便計画は 06:00〜22:00 に収まり、都市なしは従来の計画と一致', () => {
  for (const type of CITY_TYPES) {
    for (const seed of SEEDS) {
      it(`${type} seed=${seed}: 契約（morning/daytime/evening/any・大型含む）× 40 日。到着・出発とも夜間（22:00〜06:00）に 1 便もない`, () => {
        const c = cityCompany(seed, type);
        addWindowContracts(c);
        let n = 0;
        let maxDep = 0;
        let minArr = Infinity;
        for (let day = 0; day < 40; day++) {
          const plan = planDayWithDemand(c, day);
          for (const f of plan.flights) {
            n++;
            maxDep = Math.max(maxDep, f.departureAt);
            minArr = Math.min(minArr, f.arrivalAt);
            expect(isNight(f.arrivalAt), `${type}/${seed} day${day} ${f.key} arr ${hms(f.arrivalAt)}`).toBe(false);
            expect(isNight(f.departureAt), `${type}/${seed} day${day} ${f.key} dep ${hms(f.departureAt)}`).toBe(false);
            expect(f.arrivalAt).toBeGreaterThanOrEqual(6 * H);
            expect(f.departureAt).toBeLessThan(22 * H);
          }
        }
        expect(n).toBeGreaterThan(300);
        logD('d2a-plan', { type, seed, flights: n, earliestArr: hms(minArr), latestDep: hms(maxDep), slackToCurfewMin: Math.round((22 * H - maxDep) / 60) });
      });
    }
  }

  it('都市なし（seed=d2-s1, 契約は同上）: planDayWithDemand は planDay と完全一致し、22:00 以降の出発が従来どおり存在する（夜間規制を勝手に掛けない）', () => {
    const c = cityCompany('d2-s1', null);
    addWindowContracts(c);
    let lateDeps = 0;
    for (let day = 0; day < 40; day++) {
      const a = planDayWithDemand(c, day);
      const b = planDay(c, day);
      expect(JSON.stringify(a), `day ${day}`).toBe(JSON.stringify(b));
      lateDeps += a.flights.filter((f) => f.departureAt >= 22 * H).length;
    }
    expect(lateDeps).toBeGreaterThan(0);
    logD('d2a-nocity', { departuresAfter22h_40days: lateDeps });
  });

  it('実際の運航スケジュール（会社の契約から毎日 23:00 に生成）も、都市ありなら予定時刻 scheduled が夜間にない（seed=d2-s1, 3 日, sample 空港）', { timeout: 300_000 }, () => {
    const c = cityCompany('d2-s1', 'core');
    const sim = citySim(createSampleAirport(), c, { seed: 'd2-s1', settings: { autoSchedule: true, inboundDelayProb: 0 } });
    runUntil(sim, 2 * DAY_SEC + 8 * H, () => false, 600, 'sched');
    const fl = Object.values(sim.state.flights);
    expect(fl.length).toBeGreaterThan(30);
    const nightScheduled = fl.filter((f) => isNight(f.scheduled));
    expect(nightScheduled.map((f) => `${f.number} ${hms(f.scheduled)}`)).toEqual([]);
    logD('d2a-schedule', { flights: fl.length, nightScheduled: nightScheduled.length });
  });
});

/** 夜間に着陸・離陸した（実績時刻が夜間の）便 */
const nightActuals = (sim: Simulation): string[] =>
  Object.values(sim.state.flights).filter((f) => f.actual !== null && isNight(f.actual)).map((f) => `${f.number} ${f.direction} ${hms(f.actual!)}`);

describe('ID-d2b 遅延で夜間にかかる到着: 空中で待機し、06:00 以降に着陸する', () => {
  for (const seed of SEEDS) {
    it(`1 機 seed=${seed}: 到着予定 21:40 + 遅延 40〜50 分 → 夜間。noiseCurfew で待機（ダイバートしない）、着陸は翌 06:00 以降、遅延理由 noiseRestriction、夜間の離着陸なし`, { timeout: 240_000 }, () => {
      const rng = new Rng(seed);
      const delayMin = 40 + rng.int(0, 10);
      const c = cityCompany(seed, 'core');
      const sim = citySim(linearLayout({ stands: 4 }), c, { seed, startTime: 21 * H });
      const a = addTurnaround(sim, 'narrow180', 21 * H + 40 * 60, { inboundDelaySec: delayMin * 60, departureAt: 23 * H });
      const arr = sim.state.flights[a.arrivalFlightId]!;
      const dep = sim.state.flights[a.departureFlightId]!;
      let curfewSec = 0;
      let maxWaitWhileCurfew = 0;
      let divertAttempt = false;
      runUntil(sim, 14 * H, (s) => {
        if (a.holdReason === 'noiseCurfew') {
          curfewSec++;
          maxWaitWhileCurfew = Math.max(maxWaitWhileCurfew, s.state.now - (a.waitSince ?? s.state.now));
        }
        if (a.state === 'diverted') divertAttempt = true;
        return a.state === 'departed';
      }, 120, seed);
      expect(divertAttempt, seed).toBe(false);
      expect(a.state, seed).toBe('departed');
      expect(arr.actual!, seed).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
      expect(isNight(arr.actual!), seed).toBe(false);
      expect(isNight(dep.actual!), seed).toBe(false);
      expect(arr.delayCauses, seed).toContain('noiseRestriction');
      expect(nightActuals(sim), seed).toEqual([]);
      // 夜間待機は HOLD_DIVERT_SEC（45 分）を大きく超えてもダイバートしない（noiseCurfew は上限の対象外）
      expect(maxWaitWhileCurfew, seed).toBeGreaterThan(HOLD_DIVERT_SEC);
      // 履歴: 夜間に landing/takeoff 状態へ入っていない
      for (const h of a.history) if (['landing', 'takeoff', 'lineUp'].includes(h.state)) expect(isNight(h.t), `${seed} ${h.state}@${hms(h.t)}`).toBe(false);
      const heldFrom = a.history.find((h) => h.state === 'inbound')!.t;
      logD('d2b-late-arrival', {
        seed, delayMin, estimatedBeforeHold: hms(arr.scheduled + delayMin * 60), airborneHeldHours: Math.round((curfewSec / H) * 100) / 100,
        stateWhileHeld: 'inbound（holding にはならない）', inboundSince: hms(heldFrom), landedAt: hms(arr.actual!), takeoffAt: hms(dep.actual!),
        arrivalDelayMin: flightDelayMin(arr, sim.state.now), depBlockDelayMin: flightDelayMin(dep, sim.state.now), depActualVsScheduledMin: Math.round((dep.actual! - dep.scheduled) / 60),
        causes: arr.delayCauses,
      });
    });
  }

  it('境界（seed=d2b-edge）: 着陸時刻 21:59:59 は許可、22:00:00 は夜間で待機。05:59:58/05:59:59 は待機して 06:00:00 に着陸、06:00:00/06:00:01 はそのまま着陸（ゴーアラウンドなし）', { timeout: 300_000 }, () => {
    const land = (startTime: number, estimated: number): { actual: number; held: boolean; arrState: string } => {
      const c = cityCompany('d2b-edge', 'core');
      const sim = citySim(linearLayout({ stands: 2 }), c, { seed: 'd2b-edge', startTime });
      const a = addTurnaround(sim, 'narrow180', estimated, { departureAt: estimated + 3 * H });
      const arr = sim.state.flights[a.arrivalFlightId]!;
      let held = false;
      runUntil(sim, 12 * H, () => {
        if (a.holdReason === 'noiseCurfew') held = true;
        return arr.actual !== null;
      }, 60, 'edge');
      expect(sim.state.stats.goArounds).toBe(0);
      return { actual: arr.actual!, held, arrState: a.state };
    };
    const rows: Record<string, unknown> = {};
    for (const est of [22 * H - 2, 22 * H - 1, 22 * H, 22 * H + 1]) {
      const r = land(21 * H + 20 * 60, est);
      rows[hms(est)] = { landedAt: hms(r.actual), held: r.held };
      expect(isNight(r.actual), `est ${hms(est)} → landed ${hms(r.actual)}`).toBe(false);
      if (est < 22 * H) {
        expect(r.actual, `est ${hms(est)}`).toBe(est);
        expect(r.held).toBe(false);
      } else {
        expect(r.held, `est ${hms(est)} は夜間なので待機`).toBe(true);
        expect(r.actual).toBe(DAY_SEC + 6 * H);
      }
    }
    for (const est of [6 * H - 2, 6 * H - 1, 6 * H, 6 * H + 1]) {
      const r = land(5 * H + 20 * 60, est);
      rows[hms(est)] = { landedAt: hms(r.actual), held: r.held };
      expect(isNight(r.actual), `est ${hms(est)} → landed ${hms(r.actual)}`).toBe(false);
      expect(r.actual).toBe(Math.max(est, 6 * H));
      expect(r.held).toBe(est < 6 * H);
    }
    expect(nextCityMovementTime(22 * H)).toBe(DAY_SEC + 6 * H);
    expect(nextCityMovementTime(5 * H)).toBe(6 * H);
    logD('d2b-edge', rows);
  });
});

/** 到着 20:55 → 出発 depSec（21:5x）を 1 機流す。地上で待つ間の状態を記録して返す */
function lateEveningDeparture(depSec: number, seed = 'd2c') {
  const c = cityCompany(seed, 'core');
  const sim = citySim(linearLayout({ stands: 4 }), c, { seed, startTime: 20 * H + 30 * 60 });
  const a = addTurnaround(sim, 'narrow180', 20 * H + 55 * 60, { departureAt: depSec });
  const dep = sim.state.flights[a.departureFlightId]!;
  let holdShortAt: number | null = null;
  let curfewHoldSec = 0;
  const reasons = new Set<string>();
  runUntil(sim, 14 * H, () => {
    if (a.state === 'holdShort' && holdShortAt === null) holdShortAt = sim.state.now;
    if (a.holdReason === 'noiseCurfew' && a.state === 'holdShort') curfewHoldSec++;
    if (a.holdReason) reasons.add(`${a.state}/${a.holdReason}`);
    return a.state === 'departed' && sim.state.now > (dep.actual ?? Infinity) + 2;
  }, 120, `dep ${depSec}`);
  return { sim, a, dep, holdShortAt, curfewHoldSec, reasons: [...reasons] };
}

describe('ID-d2c 夜間にかかる出発: 滑走路手前（ホールドショート）で待機する', () => {
  it('境界の走査（seed=d2c）: 出発予定を 21:56:30〜21:57:00 付近で刻むと、離陸予測が 22:00:00 を超えた機から 06:00:00 まで待機。離陸時刻が 22:00:00 以降 06:00:00 前になる機はない', { timeout: 400_000 }, () => {
    const rows: { depSec: number; actual: number; held: boolean }[] = [];
    const take = (d: number) => {
      const r = lateEveningDeparture(d);
      rows.push({ depSec: d, actual: r.dep.actual!, held: r.curfewHoldSec > 0 });
      return r;
    };
    // 粗い走査（10 秒刻み）で境目を見つけ、境目の前後を 1 秒刻みで確かめる
    let lastFree = 0;
    let firstHeld = 0;
    for (let d = 78790; d <= 78850; d += 10) {
      const r = take(d);
      if (!r.curfewHoldSec) lastFree = d;
      else if (!firstHeld) firstHeld = d;
    }
    expect(lastFree).toBeGreaterThan(0);
    expect(firstHeld).toBeGreaterThan(lastFree);
    for (let d = lastFree + 1; d < firstHeld; d++) take(d);
    rows.sort((p, q) => p.depSec - q.depSec);
    for (const r of rows) {
      expect(isNight(r.actual), `dep ${hms(r.depSec)} → takeoff ${hms(r.actual)}`).toBe(false);
      expect(r.actual).not.toBe(22 * H); // 22:00:00 ちょうどの離陸は規制違反
    }
    // 単調: 待機に入る境目は 1 か所だけ
    const flips = rows.slice(1).filter((r, i) => r.held !== rows[i]!.held).length;
    expect(flips).toBe(1);
    const lastFreeRow = rows.filter((r) => !r.held).pop()!;
    const heldRows = rows.filter((r) => r.held);
    expect(lastFreeRow.actual).toBeLessThan(22 * H); // 例: 21:59:59 まで許可される
    for (const r of heldRows) expect(r.actual, `held dep ${hms(r.depSec)}`).toBe(DAY_SEC + 6 * H); // 06:00:00 ちょうど（05:59:59 には離陸しない）
    logD('d2c-edge', { lastNonHeldDepSched: hms(lastFreeRow.depSec), lastNonHeldTakeoff: hms(lastFreeRow.actual), firstHeldDepSched: hms(heldRows[0]!.depSec), heldTakeoff: hms(heldRows[0]!.actual), casesRun: rows.length });
  });

  it('夜間待機の詳細（seed=d2c, 出発予定 21:58）: 誘導は夜間でも行う → 滑走路手前で約 8 時間待機（noiseCurfew・遅延理由 noiseRestriction）。06:00:00 に離陸。遅延の指標（flightDelayMin）はブロックアウト基準で 0 分のまま', { timeout: 300_000 }, () => {
    const r = lateEveningDeparture(21 * H + 58 * 60);
    expect(r.a.state).toBe('departed');
    expect(r.reasons).toContain('holdShort/noiseCurfew');
    expect(r.dep.delayCauses).toContain('noiseRestriction');
    expect(r.dep.actual).toBe(DAY_SEC + 6 * H);
    // プッシュバック（ブロックアウト）は夜間規制と無関係に定刻に行われ、そのまま誘導路を走って滑走路手前に居続ける
    expect(r.dep.block).toBe(r.dep.scheduled);
    const waitH = r.curfewHoldSec / H;
    expect(waitH).toBeGreaterThan(7.5);
    const pushedAt = r.a.history.find((h) => h.state === 'pushback')!.t;
    logD('d2c-detail', {
      pushbackAt: hms(pushedAt), holdShortAt: hms(r.holdShortAt!), takeoffAt: hms(r.dep.actual!), holdAtRunwayHours: Math.round(waitH * 100) / 100,
      flightDelayMin_blockBased: flightDelayMin(r.dep, r.sim.state.now), actualDelayMin: Math.round((r.dep.actual! - r.dep.scheduled) / 60),
      note: '旅客は搭乗済みのまま滑走路手前で約 8 時間待機する（仕様に待機中の旅客の扱いの記述なし）',
    });
  });

  it('後続機への影響（seed=d2c-q）: 夜間待機中の出発機 A の後ろの出発機 C は、スポット上で routeBusy のまま夜通し待つ。朝の到着 D は 06:00 以降に着陸し、全機が終端。夜間の離着陸なし', { timeout: 400_000 }, () => {
    const c = cityCompany('d2c-q', 'core');
    const sim = citySim(linearLayout({ stands: 2 }), c, { seed: 'd2c-q', startTime: 20 * H + 30 * 60 });
    const a = addTurnaround(sim, 'narrow180', 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
    const b = addTurnaround(sim, 'narrow180', 21 * H + 1 * 60, { departureAt: 21 * H + 59 * 60 });
    const d = addTurnaround(sim, 'narrow180', DAY_SEC + 5 * H + 30 * 60, { departureAt: DAY_SEC + 8 * H });
    const standHold: Record<string, number> = {};
    runUntil(sim, 16 * H, () => {
      for (const x of [a, b, d]) if (x.holdReason && ['readyForPushback', 'holdShort', 'inbound', 'holding'].includes(x.state)) standHold[`${x.id}:${x.state}/${x.holdReason}`] = (standHold[`${x.id}:${x.state}/${x.holdReason}`] ?? 0) + 1;
      return [a, b, d].every((x) => x.state === 'departed') && sim.state.now > DAY_SEC + 9 * H;
    }, 120, 'queue');
    for (const x of [a, b, d]) expect(x.state, x.id).toBe('departed');
    expect(nightActuals(sim)).toEqual([]);
    const bWaitStandH = (standHold[`${b.id}:readyForPushback/routeBusy`] ?? 0) / H;
    const bNoise = (standHold[`${b.id}:holdShort/noiseCurfew`] ?? 0) / H;
    logD('d2c-queue', { standHoldSec: standHold, B_routeBusyAtStandHours: Math.round(bWaitStandH * 100) / 100, B_curfewAtRunwayHours: Math.round(bNoise * 100) / 100, takeoffs: [a, b, d].map((x) => hms(sim.state.flights[x.departureFlightId]!.actual!)), dLanded: hms(sim.state.flights[d.arrivalFlightId]!.actual!) });
  });

  it('日締め（00:00）をまたぐ待機（seed=d2c-close）: 00:00 の締めで機体は holdShort/noiseCurfew のまま。日報の nightMovements は 0。待機機は翌日 06:00 に離陸し、翌日の日報に反映される', { timeout: 400_000 }, () => {
    const c = cityCompany('d2c-close', 'core');
    const sim = citySim(linearLayout({ stands: 2 }), c, { seed: 'd2c-close', startTime: 20 * H + 30 * 60 });
    const a = addTurnaround(sim, 'narrow180', 20 * H + 55 * 60, { departureAt: 21 * H + 58 * 60 });
    const r = stepTicks(sim, 6 * H, { stopAtDayClose: true });
    expect(r.stop).toBe('dayClose');
    expect(sim.state.now).toBe(DAY_SEC + 1); // 締めは now=00:00:00 の tick の中で行われ、その後 now が 1 進む
    expect(a.state).toBe('holdShort');
    expect(a.holdReason).toBe('noiseCurfew');
    expect(c.reports.length).toBe(1);
    const day0 = c.reports[0]!;
    expect(day0.city?.nightMovements).toBe(0);
    runUntil(sim, 8 * H, () => a.state === 'departed' && sim.state.now > DAY_SEC + 6 * H + 120, 120, 'close');
    const r2 = stepTicks(sim, 2 * DAY_SEC, { stopAtDayClose: true });
    expect(r2.stop).toBe('dayClose');
    const day1 = c.reports[1]!;
    expect(day1.city?.nightMovements).toBe(0);
    expect(a.state).toBe('departed');
    logD('d2c-dayclose', {
      day0: { flights: day0.kpi.flights, movements: day0.city?.noiseMovements, otp: day0.kpi.otp, avgDelayMin: day0.kpi.avgDelayMin, actualAvgDelayMin: day0.kpi.actualAvgDelayMin, night: day0.city?.nightMovements },
      day1: { flights: day1.kpi.flights, movements: day1.city?.noiseMovements, otp: day1.kpi.otp, avgDelayMin: day1.kpi.avgDelayMin, actualAvgDelayMin: day1.kpi.actualAvgDelayMin, night: day1.city?.nightMovements },
      takeoffAt: hms(sim.state.flights[a.departureFlightId]!.actual!),
    });
  });
});

describe('ID-d2d 夜間移動の集計（日報の nightMovements / noisePoints）', () => {
  /** 都市設定を後から付けて（規制なしで運航した夜間の移動を）日報に集計させる。集計式の検証用 */
  function nightOpsWithoutCurfew(seed: string, attachCityBeforeClose: boolean) {
    const c = cityCompany(seed, null);
    const sim = citySim(linearLayout({ stands: 4 }), c, { seed, startTime: 20 * H });
    // 昼 2 機（20:30 着 / 21:30 発）、夜 2 機（22:30 着 / 23:30 発、地方機と大型寄りでない機種を混ぜる）
    const acs = [
      addTurnaround(sim, 'narrow180', 20 * H + 30 * 60, { departureAt: 21 * H + 30 * 60 }),
      addTurnaround(sim, 'regional70', 20 * H + 40 * 60, { departureAt: 21 * H + 40 * 60 }),
      addTurnaround(sim, 'narrow180', 22 * H + 30 * 60, { departureAt: 23 * H + 40 * 60 }),
      addTurnaround(sim, 'regional70', 22 * H + 50 * 60, { departureAt: 23 * H + 45 * 60 }),
    ];
    runUntil(sim, DAY_SEC - 120 - sim.state.now, () => false, 300, seed);
    if (attachCityBeforeClose) c.city = defaultCity('core');
    const before = c.city ? { ...c.city } : null;
    stepTicks(sim, 600, { stopAtDayClose: true });
    return { sim, c, acs, before };
  }

  it('都市なしで運航した夜間移動を、日締め直前に都市設定を付けて集計（seed=d2d-a）: nightMovements・noisePoints・movements は実績時刻から数えた値と一致し、住民満足度の変化は式どおり', { timeout: 200_000 }, () => {
    const { sim, c, acs, before } = nightOpsWithoutCurfew('d2d-a', true);
    const rep = c.reports[0]!;
    expect(rep.day).toBe(0);
    const actuals = acs.flatMap((a) => [sim.state.flights[a.arrivalFlightId]!, sim.state.flights[a.departureFlightId]!]).map((f) => ({ at: f.actual, type: resolveType(sim.ctx.types, sim.state.aircraft[f.aircraftId]!.typeId) }));
    expect(actuals.every((x) => x.at !== null && x.at < DAY_SEC)).toBe(true);
    const night = actuals.filter((x) => isNight(x.at!)).length;
    const pts = Math.round(actuals.reduce((s, x) => s + aircraftNoisePoints(x.type.size, x.type.engines), 0) * 10) / 10;
    expect(rep.city?.noiseMovements).toBe(actuals.length);
    expect(rep.city?.nightMovements).toBe(night);
    expect(rep.city?.noisePoints).toBe(pts);
    expect(night).toBeGreaterThanOrEqual(3);
    const expectedDelta = applyCityNoiseImpact({ ...before! }, pts, night);
    expect(rep.city?.residentDelta).toBe(expectedDelta);
    logD('d2d-count', { movements: actuals.length, night, noisePoints: pts, residentDelta: rep.city?.residentDelta, actualsTod: actuals.map((x) => hms(x.at!)) });
  });

  it('都市なしの会社（seed=d2d-b）: 日報に city が付かず、夜間移動は規制されずそのまま行われる（夜間の実績が存在する）', { timeout: 200_000 }, () => {
    const { sim, c } = nightOpsWithoutCurfew('d2d-b', false);
    expect(c.reports[0]!.city).toBeUndefined();
    expect(nightActuals(sim).length).toBeGreaterThanOrEqual(3);
  });

  it('都市あり（seed=d2d-c）で同じ 4 機: 夜間の到着・出発は規制で待機し、日報の nightMovements は 0。翌朝 06:00 以降にまとめて運航される（07:00 の締めまでで確認）', { timeout: 300_000 }, () => {
    const c = cityCompany('d2d-c', 'core');
    const sim = citySim(linearLayout({ stands: 4 }), c, { seed: 'd2d-c', startTime: 20 * H });
    const acs = [
      addTurnaround(sim, 'narrow180', 20 * H + 30 * 60, { departureAt: 21 * H + 30 * 60 }),
      addTurnaround(sim, 'regional70', 20 * H + 40 * 60, { departureAt: 21 * H + 40 * 60 }),
      addTurnaround(sim, 'narrow180', 22 * H + 30 * 60, { departureAt: 23 * H + 40 * 60 }),
    ];
    runUntil(sim, DAY_SEC - sim.state.now + 3, () => false, 300, 'd2d-c');
    const rep = c.reports[0]!;
    expect(rep.city?.nightMovements).toBe(0);
    runUntil(sim, 12 * H, () => acs.every((a) => a.state === 'departed' || a.state === 'diverted'), 300, 'd2d-c2');
    expect(nightActuals(sim)).toEqual([]);
    logD('d2d-curfew-on', { day0Movements: rep.city?.noiseMovements, night: rep.city?.nightMovements, states: acs.map((a) => a.state), lateOneLanded: hms(sim.state.flights[acs[2]!.arrivalFlightId]!.actual ?? 0) });
  });
});

describe('ID-d2e 手動の便（addTurnaround）を夜間に入れた場合', () => {
  it('seed=d2e: 都市ありで 23:30 着 / 00:30 発（予定が夜間）の便を直接追加できる（コアは検証しない）が、運航は 06:00 以降まで待機して夜間の離着陸は起きない', { timeout: 300_000 }, () => {
    const c = cityCompany('d2e', 'core');
    const sim = citySim(linearLayout({ stands: 2 }), c, { seed: 'd2e', startTime: 22 * H + 30 * 60 });
    const a = addTurnaround(sim, 'narrow180', 23 * H + 30 * 60, { departureAt: DAY_SEC + 30 * 60 });
    const arr = sim.state.flights[a.arrivalFlightId]!;
    const dep = sim.state.flights[a.departureFlightId]!;
    expect(isNight(arr.scheduled) && isNight(dep.scheduled)).toBe(true); // 計画外の手動便は夜間の予定になりうる（仕様の隙間として記録）
    runUntil(sim, 14 * H, () => a.state === 'departed' && sim.state.now > (dep.actual ?? Infinity) + 2, 300, 'd2e');
    expect(a.state).toBe('departed');
    expect(isNight(arr.actual!)).toBe(false);
    expect(isNight(dep.actual!)).toBe(false);
    expect(arr.actual!).toBeGreaterThanOrEqual(DAY_SEC + 6 * H);
    expect(nightActuals(sim)).toEqual([]);
    logD('d2e-manual', { arrSched: hms(arr.scheduled), arrActual: hms(arr.actual!), depSched: hms(dep.scheduled), depActual: hms(dep.actual!), causes: arr.delayCauses });
  });
});

describe('ID-d2f 複数日運航: 都市あり・夕方の契約・ランダムな到着遅延で、毎日の夜間移動ゼロ・停滞なし', () => {
  for (const seed of SEEDS) {
    it(`sample 空港 3 日 + 翌朝 seed=${seed}: 夜間の離着陸ゼロ、日ごとの最終着陸・最終離陸・夜間待機便数・日の最終出発便の遅延（分）を記録。不変条件違反なし`, { timeout: 900_000 }, () => {
      const c = cityCompany(seed, 'core');
      addWindowContracts(c);
      const sim = citySim(createSampleAirport(), c, { seed, settings: { autoSchedule: true, inboundDelayProb: 0 } });
      const rng = new Rng(`${seed}:late`);
      const injected = new Set<string>();
      let injectedN = 0;
      const END = 3 * DAY_SEC + 8 * H;
      for (let t = 0; sim.state.now < END; t++) {
        stepSimulation(sim);
        // 毎日 17:00 に、18:00〜21:30 着予定の（まだ現れていない）到着便へ追加の到着遅延（20〜120 分）を乱数で与える（外乱の注入。運航側の遅延理由 inboundLate と同じ扱い）
        if (sim.state.now % DAY_SEC === 17 * H) {
          for (const f of Object.values(sim.state.flights)) {
            if (f.direction !== 'arrival' || f.status !== 'scheduled' || injected.has(f.id)) continue;
            const tod = f.scheduled % DAY_SEC;
            if (tod < 18 * H || tod > 21 * H + 30 * 60 || Math.floor(f.scheduled / DAY_SEC) !== Math.floor(sim.state.now / DAY_SEC)) continue;
            if (rng.next() > 0.6) continue;
            const ac = sim.state.aircraft[f.aircraftId]!;
            if (ac.state !== 'scheduled') continue;
            const dly = rng.int(20, 120) * 60;
            f.estimated += dly;
            f.delayCauses.push('inboundLate');
            const dep = sim.state.flights[ac.departureFlightId]!;
            dep.estimated = Math.max(dep.scheduled, f.estimated + resolveType(sim.ctx.types, ac.typeId).turnaroundSec);
            injected.add(f.id);
            injectedN++;
          }
        }
        if (t % 60 === 0) {
          const v = checkInvariants(sim);
          if (v.length) throw new Error(`${seed} t=${hms(sim.state.now)}: ${v.slice(0, 4).join(' / ')}`);
        }
      }
      const flights = Object.values(sim.state.flights);
      expect(flights.length, seed).toBeGreaterThan(100);
      // 夜間の離着陸は、既知の不具合（known-issues/d_curfewTakeoffEarly.repro.test.ts: L 級機が 06:00 の解除時に 1 秒早く 05:59:59 に離陸する）だけ。
      // それ以外（着陸・M/S 級機の離陸）の夜間移動はゼロでなければならない。
      const nightList = flights.filter((f) => f.actual !== null && isNight(f.actual));
      const unexplained = nightList.filter((f) => !(f.direction === 'departure' && f.actual! % DAY_SEC === 6 * H - 1 && resolveType(sim.ctx.types, sim.state.aircraft[f.aircraftId]!.typeId).size === 'L'));
      expect(unexplained.map((f) => `${f.number} ${f.direction} ${hms(f.actual!)}`), seed).toEqual([]);
      for (const a of Object.values(sim.state.aircraft)) for (const h of a.history) {
        if (h.state === 'landing') expect(isNight(h.t), `${seed} ${a.id} ${h.state}@${hms(h.t)}`).toBe(false);
      }
      // 停滞なし: 翌朝 08:00 時点で、出発予定が前日までの機体はすべて終端
      const stuck = Object.values(sim.state.aircraft).filter((a) => a.state !== 'scheduled' && !['departed', 'diverted', 'cannotOperate'].includes(a.state) && sim.state.flights[a.departureFlightId]!.scheduled < 3 * DAY_SEC + 6 * H);
      expect(stuck.map((a) => `${a.id}:${a.state}/${a.holdReason}`), seed).toEqual([]);
      expect(sim.state.stats.conflicts, seed).toBe(0);
      // 日報の夜間移動数は、実績から数えた夜間の移動数（上記の既知の 05:59:59 離陸だけ）と一致する
      const nightByDay = (d: number) => nightList.filter((f) => f.actual! >= d * DAY_SEC && f.actual! < (d + 1) * DAY_SEC).length;
      for (const r of c.reports) expect(r.city?.nightMovements ?? 0, `${seed} report day ${r.day}`).toBe(nightByDay(r.day));
      const perDay: Record<string, unknown>[] = [];
      for (let day = 0; day < 3; day++) {
        const inDay = (t: number | null) => t !== null && t >= day * DAY_SEC && t < (day + 1) * DAY_SEC;
        const landings = flights.filter((f) => f.direction === 'arrival' && inDay(f.actual)).map((f) => f.actual!);
        const takeoffs = flights.filter((f) => f.direction === 'departure' && inDay(f.actual)).map((f) => f.actual!);
        const deps = flights.filter((f) => f.direction === 'departure' && inDay(f.scheduled));
        const last = deps.sort((p, q) => q.scheduled - p.scheduled)[0];
        const held = flights.filter((f) => inDay(f.scheduled) && f.delayCauses.includes('noiseRestriction')).length;
        const divertedToday = flights.filter((f) => f.status === 'diverted' && inDay(f.scheduled)).length;
        perDay.push({
          day, lastLanding: landings.length ? hms(Math.max(...landings)) : null, lastTakeoff: takeoffs.length ? hms(Math.max(...takeoffs)) : null,
          flightsHeldByCurfew: held, diverted: divertedToday,
          lastDepartureOfDay: last ? { sched: hms(last.scheduled), actual: last.actual ? hms(last.actual) : null, status: last.status, delayMinActual: last.actual ? Math.round((last.actual - last.scheduled) / 60) : null, delayMinBlockBased: flightDelayMin(last, sim.state.now) } : null,
        });
      }
      logD('d2f-multiday', { seed, flights: flights.length, injectedLateArrivals: injectedN, diverted: sim.state.stats.diverted, cancelled: sim.state.stats.cancelled, perDay, reportNight: c.reports.map((r) => r.city?.nightMovements), knownIssueNightTakeoffsL: nightList.length, divertedAtCurfewRelease: Object.values(sim.state.aircraft).filter((a) => a.state === 'diverted' && a.stateSince % DAY_SEC >= 6 * H - 300 && a.stateSince % DAY_SEC <= 6 * H + 300).length });
    });
  }
});
