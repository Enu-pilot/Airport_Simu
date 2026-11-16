/**
 * 監査 d / 誘導路の部分進行（全区間一括予約）の事実確認と周辺の運用検査。
 *
 * 製品オーナーの問い: 「連続した空き経路を滑走路まで引けない（他機と交差する）とき、機体は途中までなら進めるか」
 * 事実（docs/11 §7.2・F-01 で文書化済みの仕様どおり）: 進めない。出発は stepReadyForPushback が経路全体
 * （スポット入口〜滑走路進入ノード）を isFree で一括確認でき、到着も進入許可の時点で離脱ノード〜スポットを一括確認する。
 * 部分的に進むのは「すでに全区間を予約した経路の内側」（滑走路横断の手前の停止位置など）だけ。
 * 本ファイルは特性化テスト（測定値を [audit-d] 行に出す）と不変条件の検査。仕様に矛盾する挙動は known-issues/ に置く。
 * 参照: src/core/sim/simulation.ts stepReadyForPushback / stepInbound / movementLimit / moveTaxi / runwayControl、src/core/sim/routes.ts
 */
import { describe, expect, it } from 'vitest';
import { createStressLayout } from '../golden/layouts';
import { Rng } from '../../src/core/rng';
import { resolveType } from '../../src/core/sim/aircraftTypes';
import { setManualResourceClosure } from '../../src/core/sim/disruptions';
import { reservableParts } from '../../src/core/sim/routes';
import { HOLD_DIVERT_SEC, SEPARATION_SEC } from '../../src/core/sim/rules';
import { addTurnaround, createSimulation, type Simulation } from '../../src/core/sim/simulation';
import type { Aircraft } from '../../src/core/sim/types';
import { crossingAirport } from '../unit/sim/helpers';
import { allDone, linearLayout, logD, manual, runwayIntrusions, takeoffTimes, traceRun } from './d_helpers';

const SEEDS = ['d1-s1', 'd1-s2', 'd1-s3'];

/** n 機を同時刻に出発させる（到着は 60 秒刻み。出発は全機 t0 + 3600 に予定） */
function simultaneousDepartures(sim: Simulation, n: number, seed: string, typeId = 'narrow180'): Aircraft[] {
  const t0 = sim.state.now + 20 * 60;
  const rng = new Rng(`${seed}:arr`);
  return Array.from({ length: n }, (_, i) => addTurnaround(sim, typeId, t0 + i * 60 + rng.int(0, 120), { departureAt: t0 + 3600 }));
}

const stats = (xs: number[]) => (xs.length === 0 ? { n: 0 } : { n: xs.length, min: Math.min(...xs), max: Math.max(...xs), mean: Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) });

describe('ID-d1a 共通誘導路 1 本・滑走路進入ノード 1 つ: 後続機は先行機の経路が空くまで部分的にも進めない', () => {
  for (const n of [3, 4]) {
    for (const seed of SEEDS) {
      it(`${n} 機同時出発 seed=${seed}: 後続のプッシュバック開始時に他機が経路区間を保持していない／離陸間隔は SEPARATION_SEC を大幅に上回る／待機はスポット上`, () => {
        const sim = createSimulation(linearLayout({ stands: n }), { seed, settings: manual });
        const acs = simultaneousDepartures(sim, n, seed);
        const tr = traceRun(sim, 5 * 3600);
        expect(tr.violations, seed).toEqual([]);
        expect(allDone(sim), seed).toBe(true);
        expect(acs.every((a) => a.state === 'departed'), seed).toBe(true);
        expect(sim.state.stats.conflicts, seed).toBe(0);
        // (i) 後続が、他機の未解放区間を持つ経路で動き出したことは一度もない
        expect(tr.pushbackStarts.length, seed).toBe(n);
        for (const p of tr.pushbackStarts) expect(p.foreignOnRoute, `${seed} ${p.id}@${p.t}`).toEqual([]);
        // (i') 先行機（先に離陸を開始した機）の離陸開始より前に、後続機が pushback → taxiOut に入っていない
        const tk = takeoffTimes(acs);
        for (let i = 1; i < tk.length; i++) {
          const f = tr.firstAt[tk[i]!.id]!;
          expect(f.pushback!, `${seed} ${tk[i]!.id} は先行 ${tk[i - 1]!.id} の離陸開始後にプッシュバック`).toBeGreaterThanOrEqual(tk[i - 1]!.t);
        }
        // (ii) 同一滑走路向けに taxiOut/holdShort/lineUp にいる機体の同時最大数（単一進入ノードなので 1）
        expect(tr.maxConcurrentTowardRunway, seed).toBe(1);
        // (iii) 離陸間隔と最小間隔
        const gaps = tk.slice(1).map((x, i) => x.t - tk[i]!.t);
        const minSep = SEPARATION_SEC.M.M;
        for (const g of gaps) expect(g, seed).toBeGreaterThanOrEqual(minSep);
        // (iv) 待機はスポット上（readyForPushback / routeBusy）。滑走路手前以外の誘導路上では止まらない
        const waitAtStand = tk.slice(1).map((x) => tr.holdSec[x.id]?.['readyForPushback/routeBusy'] ?? 0);
        for (const w of waitAtStand) expect(w, seed).toBeGreaterThan(0);
        for (const x of tk) {
          const hs = tr.holdSec[x.id] ?? {};
          for (const k of Object.keys(hs)) expect(k.startsWith('taxiOut/'), `${seed} ${x.id} ${k}`).toBe(false);
        }
        logD('d1a', {
          layout: 'linear(single entry)', n, seed, takeoffAt: tk.map((x) => x.t), gapsSec: gaps, minSeparationSec: minSep,
          gapOverSeparation: gaps.map((g) => Math.round((g / minSep) * 10) / 10), maxConcurrentTowardRunway: tr.maxConcurrentTowardRunway,
          standWaitRouteBusySec: waitAtStand, pushbackStarts: tr.pushbackStarts.map((p) => p.t),
          depDelaySec: acs.map((a) => (sim.state.flights[a.departureFlightId]!.block ?? 0) - sim.state.flights[a.departureFlightId]!.scheduled),
          holdReasons: [...tr.holdReasons],
        });
      });
    }
  }
});

describe('ID-d1b 代替経路（第 2 の進入ノードと独立した誘導路）がある配置: 後続は迂回するか', () => {
  for (const seed of SEEDS) {
    it(`4 機同時出発 seed=${seed}: single と dual を比較。dual は同時移動数が増え、離陸間隔が縮む。いずれも他機区間の重複予約なし`, () => {
      const res: Record<string, { gaps: number[]; conc: number; entries: number[]; lastTakeoff: number; used2nd: number; routeLenM: number[] }> = {};
      for (const dual of [false, true]) {
        const sim = createSimulation(linearLayout({ stands: 4, dual }), { seed, settings: manual });
        const acs = simultaneousDepartures(sim, 4, seed);
        const tr = traceRun(sim, 5 * 3600);
        expect(tr.violations, `${seed} dual=${dual}`).toEqual([]);
        expect(allDone(sim), `${seed} dual=${dual}`).toBe(true);
        expect(sim.state.stats.conflicts).toBe(0);
        for (const p of tr.pushbackStarts) expect(p.foreignOnRoute, `${seed} dual=${dual} ${p.id}`).toEqual([]);
        const tk = takeoffTimes(acs);
        const entries = acs.map((a) => tr.routeEnds[a.id]!.x);
        res[dual ? 'dual' : 'single'] = {
          gaps: tk.slice(1).map((x, i) => x.t - tk[i]!.t), conc: tr.maxConcurrentTowardRunway, entries, lastTakeoff: tk[tk.length - 1]!.t,
          used2nd: entries.filter((x) => x > 50).length,
          routeLenM: acs.map((a) => tr.routeEnds[a.id]!.lengthM),
        };
      }
      // 迂回路があると同時移動数は増え、最後の離陸は遅くならない（単一より遅れたら迂回が逆効果＝要調査）
      expect(res.single!.used2nd, seed).toBe(0);
      expect(res.dual!.used2nd, `${seed} 迂回（第 2 進入ノード (95,30) 経由）が発生`).toBeGreaterThanOrEqual(1);
      expect(res.dual!.conc, seed).toBeGreaterThanOrEqual(res.single!.conc);
      expect(res.dual!.lastTakeoff, seed).toBeLessThanOrEqual(res.single!.lastTakeoff);
      logD('d1b', { seed, single: res.single, dual: res.dual });
    });
  }
});

/** 出発機 1 機（先に着陸・駐機・出発）と、その出発の準備時間帯に到着する機体 1 機（到着時刻を offset 秒ずらして走査） */
function headOn(layoutOpts: Parameters<typeof linearLayout>[0], seed: string, offsetSec: number) {
  const sim = createSimulation(linearLayout(layoutOpts), { seed, settings: manual });
  const t0 = sim.state.now + 20 * 60;
  const dep = addTurnaround(sim, 'narrow180', t0, { departureAt: t0 + 3000 });
  const depAt = t0 + 3000;
  const arr = addTurnaround(sim, 'narrow180', depAt + offsetSec, { departureAt: depAt + offsetSec + 3600 });
  return { sim, dep, arr };
}

describe('ID-d1c 正面衝突（同じ誘導路を逆向きに使う到着と出発）・行き止まりのエプロン', () => {
  for (const seed of SEEDS) {
    it(`単一誘導路 1 本・スポット 2（行き止まり）seed=${seed}: 到着を出発の前後 -12..+12 分でずらす 25 通り。競合・デッドロックなし、全機が終端、待機の内訳を記録`, { timeout: 300_000 }, () => {
      let maxAirborneHold = 0;
      let routeBusyArr = 0;
      let routeBusyDep = 0;
      let goArounds = 0;
      let diverted = 0;
      let worst: { off: number; holdSec: number } = { off: 0, holdSec: 0 };
      const rows: { off: number; arrHold: number; depStandWait: number; arrFirst: boolean }[] = [];
      const rng = new Rng(`${seed}:off`);
      for (let k = -12; k <= 12; k++) {
        const off = k * 60 + rng.int(0, 59);
        const { sim, dep, arr } = headOn({ stands: 2 }, seed, off);
        const tr = traceRun(sim, 4 * 3600, { every: 20 });
        expect(tr.violations, `${seed} off=${off}`).toEqual([]);
        expect(sim.state.stats.conflicts, `${seed} off=${off}`).toBe(0);
        expect(allDone(sim), `${seed} off=${off}: ${[dep, arr].map((a) => `${a.id}:${a.state}/${a.holdReason}`)}`).toBe(true);
        const arrHold = (tr.holdSec[arr.id]?.['holding/routeBusy'] ?? 0) + (tr.holdSec[arr.id]?.['inbound/routeBusy'] ?? 0);
        const depWait = tr.holdSec[dep.id]?.['readyForPushback/routeBusy'] ?? 0;
        maxAirborneHold = Math.max(maxAirborneHold, Object.entries(tr.holdSec[arr.id] ?? {}).filter(([k2]) => k2.startsWith('holding/')).reduce((a, [, v]) => a + v, 0));
        routeBusyArr += arrHold > 0 ? 1 : 0;
        routeBusyDep += depWait > 0 ? 1 : 0;
        goArounds += sim.state.stats.goArounds;
        diverted += sim.state.stats.diverted;
        const total = Object.entries(tr.holdSec[arr.id] ?? {}).filter(([k2]) => k2.startsWith('holding/')).reduce((a, [, v]) => a + v, 0);
        if (total > worst.holdSec) worst = { off, holdSec: total };
        rows.push({ off, arrHold, depStandWait: depWait, arrFirst: (tr.firstAt[arr.id]?.approach ?? Infinity) < (tr.firstAt[dep.id]?.pushback ?? Infinity) });
      }
      expect(maxAirborneHold, seed).toBeLessThan(HOLD_DIVERT_SEC);
      expect(diverted, seed).toBe(0);
      logD('d1c-headon', {
        seed, cases: rows.length, arrivalsHeldAirborneRouteBusy: routeBusyArr, departuresHeldAtStandRouteBusy: routeBusyDep,
        maxAirborneHoldSec: maxAirborneHold, worst, goArounds, diverted,
        sample: rows.filter((_, i) => i % 4 === 0),
      });
    });
  }
});

describe('ID-d1d 到着の連続流入 × 出発が誘導路を占有: 空中待機・ゴーアラウンド・ダイバート', () => {
  for (const seed of SEEDS) {
    for (const n of [8, 12]) {
      it(`線形配置・スポット 8 に ${n} 機（スポット不足を避け、経路競合を主因にする） seed=${seed}: 全機終端、占有・予約が残らない、空中待機時間・ゴーアラウンド・ダイバートを記録`, { timeout: 300_000 }, () => {
        const sim = createSimulation(linearLayout({ stands: 8 }), { seed, settings: manual });
        const rng = new Rng(seed);
        const t0 = sim.state.now + 20 * 60;
        const acs: Aircraft[] = [];
        for (let i = 0; i < n; i++) {
          const arr = t0 + Math.round(rng.next() * 30 * 60);
          acs.push(addTurnaround(sim, (['regional70', 'narrow180', 'narrow180'] as const)[rng.int(0, 2)]!, arr, { departureAt: arr + (40 + rng.int(0, 20)) * 60 }));
        }
        const tr = traceRun(sim, 8 * 3600, { every: 10 });
        expect(tr.violations, seed).toEqual([]);
        expect(sim.state.stats.conflicts, seed).toBe(0);
        expect(allDone(sim), `${seed} ${acs.filter((a) => !['departed', 'diverted', 'cannotOperate'].includes(a.state)).map((a) => `${a.id}:${a.state}`)}`).toBe(true);
        expect(sim.state.nodeReservations).toEqual({});
        expect(sim.state.edgeReservations).toEqual({});
        expect(sim.state.standAssignments).toEqual({});
        const airborne = acs.map((a) => Object.entries(tr.holdSec[a.id] ?? {}).filter(([k]) => k.startsWith('holding/')).reduce((s, [, v]) => s + v, 0));
        const byReason: Record<string, number> = {};
        for (const a of acs) for (const [k, v] of Object.entries(tr.holdSec[a.id] ?? {})) if (k.startsWith('holding/')) byReason[k] = (byReason[k] ?? 0) + v;
        const diverted = acs.filter((a) => a.state === 'diverted');
        for (const a of diverted) expect(a.history.some((h) => h.state === 'parked'), `${seed} ${a.id}`).toBe(false);
        // 空中待機がダイバート上限（45 分）を超えた機体は必ずダイバートしている
        for (const [i, a] of acs.entries()) if (airborne[i]! > HOLD_DIVERT_SEC + 60) expect(a.state, `${seed} ${a.id}`).toBe('diverted');
        expect(sim.state.stats.diverted, seed).toBe(diverted.length);
        logD('d1d', {
          seed, n, airborneHoldSec: stats(airborne), airborneHoldMin: Math.round(Math.max(...airborne) / 60), byReasonSec: byReason,
          goArounds: sim.state.stats.goArounds, diverted: diverted.length, divertReasons: sim.state.events.filter((e) => e.kind === 'diverted').map((e) => e.reason), departed: acs.filter((a) => a.state === 'departed').length,
          maxDepDelayMin: Math.max(...acs.filter((a) => a.state === 'departed').map((a) => Math.round(((sim.state.flights[a.departureFlightId]!.block ?? 0) - sim.state.flights[a.departureFlightId]!.scheduled) / 60))),
          maxConcurrentTowardRunway: tr.maxConcurrentTowardRunway,
        });
      });
    }
  }
});

describe('ID-d1e 滑走路横断: 部分的に進むのは「全区間を予約済みの経路の内側」だけ（停止位置まで進み、待機して、再開する）', () => {
  for (const seed of ['d-c1', 'd-c2', 'd-c3']) {
    it(`stress layout 30 機 / 2h seed=${seed}: 'crossing' 待機は停止位置（dist>0・speed 0・経路の途中）で、残りの経路を自機が予約済み。待機後に継続して全機が終端。滑走路上に他機がいない`, { timeout: 300_000 }, () => {
      const sim = createSimulation(createStressLayout(), { seed, settings: manual });
      const rng = new Rng(seed);
      const t0 = sim.state.now + 20 * 60;
      const acs: Aircraft[] = [];
      const types = ['narrow180', 'regional70'] as const;
      for (let i = 0; i < 30; i++) {
        const arr = t0 + Math.round(rng.next() * 120 * 60);
        acs.push(addTurnaround(sim, types[rng.int(0, 1)]!, arr, { departureAt: arr + (35 + Math.round(rng.next() * 40)) * 60 }));
      }
      const intrusions: string[] = [];
      const notOwned: string[] = [];
      const badHold: string[] = [];
      let holdTicks = 0;
      const heldIds = new Set<string>();
      const resumed = new Set<string>();
      const tr = traceRun(sim, 10 * 3600, {
        every: 15,
        onTick: (s) => {
          for (const m of runwayIntrusions(s)) if (intrusions.length < 10) intrusions.push(m);
          for (const ac of Object.values(s.state.aircraft)) {
            if (ac.holdReason === 'crossing' && ac.route) {
              holdTicks++;
              heldIds.add(ac.id);
              const r = ac.route;
              const total = r.cum[r.cum.length - 1]!;
              if (!(ac.dist > 0 && ac.dist < total && ac.speed === 0)) badHold.push(`${ac.id}@${s.state.now} dist=${ac.dist}/${total} v=${ac.speed}`);
              // 残りの経路（未解放部分）の誘導路ノード・エッジは、すべて自機が予約している（他機の区間には入っていない）
              const parts = reservableParts(s.ctx, r, r.released);
              for (const n of parts.nodes) if (s.state.nodeReservations[n] !== ac.id) notOwned.push(`${ac.id}@${s.state.now} node ${n} owner=${s.state.nodeReservations[n]}`);
              for (const e of parts.edges) if (s.state.edgeReservations[e] !== ac.id) notOwned.push(`${ac.id}@${s.state.now} edge ${e} owner=${s.state.edgeReservations[e]}`);
            } else if (heldIds.has(ac.id) && ac.speed > 0 && ac.state !== 'scheduled') resumed.add(ac.id);
          }
        },
      });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts, seed).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      expect(holdTicks, `${seed}: 横断待機が発生する負荷であること`).toBeGreaterThan(0);
      expect(badHold, seed).toEqual([]);
      expect(notOwned.slice(0, 5), seed).toEqual([]);
      expect(intrusions, seed).toEqual([]);
      expect(resumed.size, `${seed} 待機した機体は動き出している`).toBe(heldIds.size);
      logD('d1e', { seed, crossingHoldTicks: holdTicks, aircraftHeld: heldIds.size, flights: acs.length, departed: acs.filter((a) => a.state === 'departed').length, diverted: sim.state.stats.diverted, conflicts: sim.state.stats.conflicts });
    });
  }

  it('単一滑走路・滑走路を横切るエプロン配置（crossingAirport）で、横断前後の走査（到着を ±10 分ずらす 21 通り, seed=d1e-x）: 滑走路上に他機がいない・競合なし・全機終端', { timeout: 300_000 }, () => {
    let intrusionN = 0;
    let holds = 0;
    for (let off = -600; off <= 600; off += 60) {
      const sim = createSimulation(crossingAirport(), { seed: 'd1e-x', settings: manual });
      const t0 = sim.state.now + 20 * 60;
      addTurnaround(sim, 'narrow180', t0, { departureAt: t0 + 3000 });
      addTurnaround(sim, 'narrow180', t0 + 3000 + off, { departureAt: t0 + 3000 + off + 3600 });
      const tr = traceRun(sim, 4 * 3600, { every: 20, onTick: (s) => { intrusionN += runwayIntrusions(s).length; } });
      holds += tr.crossingHolds.length;
      expect(tr.violations, `off=${off}`).toEqual([]);
      expect(sim.state.stats.conflicts, `off=${off}`).toBe(0);
      expect(allDone(sim), `off=${off}`).toBe(true);
    }
    expect(intrusionN).toBe(0);
    logD('d1e-x', { crossingHoldTicks: holds, note: '2 機・単一滑走路ではスポット側の経路が全機共通のため、横断待機は発生しない（横断待機は 2 本滑走路の stress layout で検査）' });
  });
});

const twyId = (sim: Simulation, name: string): string => Object.values(sim.ctx.layout.taxiways).find((t) => t.name === name)!.id;

describe('ID-d1f 運航中の閉鎖: 走行中・予約済みの経路上の誘導路、駐機中のスポット', () => {
  for (const seed of SEEDS) {
    it(`共通誘導路 SPUR を先行機の走行中に 20 分閉鎖して再開 seed=${seed}: 先行機は閉鎖後も走り切る／後続は noRoute で待機し再開後に出発／停滞・不変条件違反なし`, () => {
      const sim = createSimulation(linearLayout({ stands: 4 }), { seed, settings: manual });
      const acs = simultaneousDepartures(sim, 4, seed);
      const spur = twyId(sim, 'SPUR');
      let closedAt = -1;
      const seen = new Set<string>();
      const tr = traceRun(sim, 6 * 3600, {
        every: 5,
        onTick: (s) => {
          if (closedAt < 0 && acs.some((a) => a.state === 'taxiOut')) {
            closedAt = s.state.now;
            expect(setManualResourceClosure(s, 'taxiway', spur, true)).toEqual({ ok: true });
          }
          if (closedAt > 0 && s.state.now === closedAt + 20 * 60) setManualResourceClosure(s, 'taxiway', spur, false);
          for (const a of acs) if (a.holdReason) seen.add(`${a.id}:${a.state}/${a.holdReason}`);
        },
      });
      expect(closedAt, seed).toBeGreaterThan(0);
      expect(tr.violations, seed).toEqual([]);
      expect(allDone(sim), seed).toBe(true);
      const lead = acs.find((a) => a.history.some((h) => h.state === 'taxiOut' && h.t <= closedAt))!;
      expect(lead.state, `${seed} 走行中に閉鎖された先行機`).toBe('departed');
      expect(sim.state.nodeReservations).toEqual({});
      expect(sim.state.edgeReservations).toEqual({});
      logD('d1f-close-twy-reopen', {
        seed, closedAt, reopenAt: closedAt + 1200, final: acs.map((a) => a.state), holds: [...seen].filter((x) => x.includes('noRoute')).length,
        reasons: [...tr.holdReasons], depDelayMin: acs.map((a) => Math.round(((sim.state.flights[a.departureFlightId]!.block ?? 0) - sim.state.flights[a.departureFlightId]!.scheduled) / 60)),
      });
    });
  }

  it('共通誘導路 SPUR を先行機の走行中に閉鎖したまま（seed=d1f-perm）: 後続は noRoute のまま 60 分で欠航（cannotOperate）。スポット・予約が解放され、全機終端。到着は経路なしでダイバート', () => {
    const sim = createSimulation(linearLayout({ stands: 4 }), { seed: 'd1f-perm', settings: manual });
    const acs = simultaneousDepartures(sim, 4, 'd1f-perm');
    const late = addTurnaround(sim, 'narrow180', sim.state.now + 2 * 3600, { departureAt: sim.state.now + 3 * 3600 });
    const spur = twyId(sim, 'SPUR');
    let closedAt = -1;
    const tr = traceRun(sim, 8 * 3600, {
      every: 5,
      onTick: (s) => {
        if (closedAt < 0 && acs.some((a) => a.state === 'taxiOut')) {
          closedAt = s.state.now;
          setManualResourceClosure(s, 'taxiway', spur, true);
        }
      },
    });
    expect(tr.violations).toEqual([]);
    expect(allDone(sim)).toBe(true);
    const states = acs.map((a) => a.state);
    expect(states.filter((x) => x === 'departed').length).toBeGreaterThanOrEqual(1);
    expect(states.every((x) => x === 'departed' || x === 'cannotOperate')).toBe(true);
    expect(late.state).toBe('diverted');
    expect(sim.state.standAssignments).toEqual({});
    expect(sim.state.nodeReservations).toEqual({});
    expect(sim.state.edgeReservations).toEqual({});
    logD('d1f-close-twy-perm', { closedAt, final: states, late: late.state, stats: sim.state.stats });
  });

  it('駐機中（turnaround）の機体のスポットを手動閉鎖（seed=d1f-stand）: 機体は退去を強制されず通常どおり出発する。閉鎖スポットに新規到着は割り当てない', () => {
    const sim = createSimulation(linearLayout({ stands: 2 }), { seed: 'd1f-stand', settings: manual });
    const first = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { departureAt: sim.state.now + 20 * 60 + 3000 });
    const second = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60 + 1800, { departureAt: sim.state.now + 20 * 60 + 5400 });
    let closedStand: string | null = null;
    const tr = traceRun(sim, 6 * 3600, {
      every: 5,
      onTick: (s) => {
        if (!closedStand && first.state === 'turnaround' && first.standId) {
          closedStand = first.standId;
          expect(setManualResourceClosure(s, 'stand', closedStand, true)).toEqual({ ok: true });
        }
      },
    });
    expect(closedStand).not.toBeNull();
    expect(tr.violations).toEqual([]);
    expect(allDone(sim)).toBe(true);
    expect(first.state).toBe('departed');
    expect(second.state).toBe('departed');
    expect(sim.state.flights[second.arrivalFlightId]!.standId).not.toBe(closedStand);
    logD('d1f-close-stand', { closed: closedStand, firstState: first.state, secondStand: sim.state.flights[second.arrivalFlightId]!.standId, secondState: second.state });
  });
});

describe('ID-d1g 一方通行・幅区分・離脱ノード選択・待ち行列の公平性', () => {
  for (const seed of SEEDS) {
    it(`一方通行の入口 SPUR_IN（北→南）と出口 SPUR_OUT（南→北）seed=${seed}: 到着は IN だけ、出発は OUT だけを正しい向きで通り、全機が出発する`, () => {
      const sim = createSimulation(linearLayout({ stands: 4, oneWayPair: true }), { seed, settings: manual });
      const rng = new Rng(seed);
      const t0 = sim.state.now + 20 * 60;
      const acs = Array.from({ length: 8 }, (_, i) => addTurnaround(sim, i % 3 === 0 ? 'regional70' : 'narrow180', t0 + i * 400 + rng.int(0, 200), { departureAt: t0 + i * 400 + 3300 + rng.int(0, 600) }));
      const tr = traceRun(sim, 8 * 3600, { every: 10 });
      expect(tr.violations, seed).toEqual([]);
      expect(allDone(sim), seed).toBe(true);
      expect(acs.filter((a) => a.state === 'departed').length, seed).toBeGreaterThanOrEqual(6);
      let inUsed = 0;
      let outUsed = 0;
      for (const a of acs) {
        const r = tr.routes[a.id] ?? {};
        for (const [kind, pts] of Object.entries(r) as [string, [number, number][]][]) {
          for (let i = 1; i < pts.length; i++) {
            const [x0, y0] = pts[i - 1]!;
            const [x1, y1] = pts[i]!;
            if (x0 === 50 && x1 === 50) {
              expect(y1, `${seed} ${a.id} ${kind} は SPUR_IN を南向きにだけ通る`).toBeGreaterThan(y0);
              inUsed++;
            }
            if (x0 === 60 && x1 === 60) {
              expect(y1, `${seed} ${a.id} ${kind} は SPUR_OUT を北向きにだけ通る`).toBeLessThan(y0);
              outUsed++;
            }
          }
        }
        // 到着は OUT を、出発は IN を使わない
        for (const p of tr.routes[a.id]?.landing ?? []) expect(p[0] === 60 && p[1] > 38 && p[1] < 50, `${seed} ${a.id} landing on OUT`).toBe(false);
        for (const p of tr.routes[a.id]?.pushback ?? []) expect(p[0] === 50 && p[1] > 38 && p[1] < 50, `${seed} ${a.id} pushback on IN`).toBe(false);
      }
      expect(inUsed, seed).toBeGreaterThan(0);
      expect(outUsed, seed).toBeGreaterThan(0);
      logD('d1g-oneway', { seed, inEdgesUsed: inUsed, outEdgesUsed: outUsed, departed: acs.filter((a) => a.state === 'departed').length, maxConcurrent: tr.maxConcurrentTowardRunway });
    });
  }

  it('一方通行の共通誘導路（北→南のみ）だけで接続（seed=d1g-ow1）: スポット割り当ては滑走路との往復経路を要求するため、到着は進入せず空中待機→ダイバート（スポットへ入って出発できなくなる状態は作らない）', () => {
    const sim = createSimulation(linearLayout({ stands: 2, spurOneWay: true }), { seed: 'd1g-ow1', settings: manual });
    const a = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { departureAt: sim.state.now + 20 * 60 + 3000 });
    const tr = traceRun(sim, 5 * 3600, { every: 10 });
    expect(tr.violations).toEqual([]);
    expect(allDone(sim)).toBe(true);
    expect(a.state).toBe('diverted');
    expect(a.history.some((h) => h.state === 'taxiIn' || h.state === 'parked')).toBe(false);
    expect(tr.routes[a.id]).toBeUndefined();
    logD('d1g-oneway-deadend', { final: a.state, hist: a.history.map((h) => h.state).join('>'), stats: sim.state.stats });
  });

  for (const [ac, spurW, expectMove] of [['wide300', 'M', false], ['wide300', 'L', true], ['narrow180', 'S', false], ['narrow180', 'M', true]] as const) {
    it(`幅区分: ${ac}（${ac === 'wide300' ? 'L' : 'M'} 級）× 共通誘導路 ${spurW} 幅 seed=d1g-w: ${expectMove ? '走行して出発する' : '幅の足りない誘導路には一度も入らず、動かずに待機→ダイバート'}`, () => {
      const size = ac === 'wide300' ? 'L' : 'M';
      const sim = createSimulation(linearLayout({ stands: 2, standSize: size, baseWidth: 'L', spurWidth: spurW, runwayWidthM: 60, runwayTiles: 150, multiExit: true }), { seed: 'd1g-w', settings: manual });
      const a = addTurnaround(sim, ac, sim.state.now + 20 * 60, { departureAt: sim.state.now + 20 * 60 + 6000 });
      const tr = traceRun(sim, 5 * 3600, { every: 10 });
      expect(tr.violations).toEqual([]);
      expect(allDone(sim)).toBe(true);
      const moved = a.history.some((h) => h.state === 'taxiIn');
      expect(moved, `${ac} on ${spurW}`).toBe(expectMove);
      if (expectMove) expect(a.state).toBe('departed');
      else {
        expect(a.state).toBe('diverted');
        expect(tr.routes[a.id]).toBeUndefined();
        expect(a.history.some((h) => h.state === 'parked')).toBe(false);
      }
      logD('d1g-width', { ac, spurWidth: spurW, final: a.state, holdReasons: [...tr.holdReasons] });
    });
  }

  it('離脱ノードの選択: 複数の出口（500/1000/1500/2000 m）から、機種の接地後の最低滑走距離（landingRollM）以上の出口を使う（regional70 / narrow180 / wide300, seed=d1g-exit）', () => {
    const sim = createSimulation(linearLayout({ stands: 3, standSize: 'L', baseWidth: 'L', multiExit: true, runwayWidthM: 60, runwayTiles: 150 }), { seed: 'd1g-exit', settings: manual });
    const t0 = sim.state.now + 20 * 60;
    const acs = (['regional70', 'narrow180', 'wide300'] as const).map((t, i) => addTurnaround(sim, t, t0 + i * 900, { departureAt: t0 + i * 900 + 7000 }));
    const exits: Record<string, number> = {};
    const tr = traceRun(sim, 6 * 3600, {
      every: 10,
      onTick: () => {
        for (const a of acs) if (a.state === 'vacating' && a.route && exits[a.id] === undefined) exits[a.id] = a.route.cum[a.route.runwayEnd]!;
      },
    });
    expect(tr.violations).toEqual([]);
    expect(allDone(sim)).toBe(true);
    for (const a of acs) {
      const roll = resolveType(sim.ctx.types, a.typeId).landingRollM;
      expect(exits[a.id], `${a.typeId} の離脱位置（接地点から）`).toBeGreaterThanOrEqual(roll);
    }
    logD('d1g-exit', { exitFromThresholdM: Object.fromEntries(acs.map((a) => [a.typeId, Math.round(exits[a.id]!)])), landingRollM: Object.fromEntries(acs.map((a) => [a.typeId, resolveType(sim.ctx.types, a.typeId).landingRollM])) });
  });

  for (const seed of SEEDS) {
    it(`待ち行列の公平性 seed=${seed}: 共通誘導路 1 本・スポット 4・14 往復 / 6h。飢餓なし（全機が出発）、準備完了から出発までの最大待機が全体の中央値と比べて有界、追い越しの記録`, { timeout: 300_000 }, () => {
      const sim = createSimulation(linearLayout({ stands: 4 }), { seed, settings: manual });
      const rng = new Rng(seed);
      const t0 = sim.state.now + 20 * 60;
      const acs: Aircraft[] = [];
      for (let i = 0; i < 14; i++) {
        const arr = t0 + Math.round(((i + rng.next()) / 14) * 4.5 * 3600);
        acs.push(addTurnaround(sim, (['regional70', 'narrow180', 'narrow180'] as const)[rng.int(0, 2)]!, arr, { departureAt: arr + (40 + rng.int(0, 30)) * 60 }));
      }
      const tr = traceRun(sim, 8 * 3600, { every: 15 });
      expect(tr.violations, seed).toEqual([]);
      expect(sim.state.stats.conflicts, seed).toBe(0);
      expect(allDone(sim), seed).toBe(true);
      const dep = acs.filter((a) => a.state === 'departed');
      expect(dep.length + acs.filter((a) => a.state === 'diverted').length, seed).toBe(acs.length);
      // 準備完了（readyForPushback と出発予定の遅い方）から pushback 開始までの待機
      const waits = dep.map((a) => {
        const f = sim.state.flights[a.departureFlightId]!;
        const ready = Math.max(tr.firstAt[a.id]!.readyForPushback!, f.scheduled);
        return tr.firstAt[a.id]!.pushback! - ready;
      });
      const sorted = [...waits].sort((p, q) => p - q);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const max = sorted[sorted.length - 1]!;
      // 追い越し: 準備完了が早いのに離陸が遅い組の数
      const rows = dep.map((a) => ({ ready: Math.max(tr.firstAt[a.id]!.readyForPushback!, sim.state.flights[a.departureFlightId]!.scheduled), takeoff: a.history.find((h) => h.state === 'takeoff')!.t }));
      let overtakes = 0;
      for (const p of rows) for (const q of rows) if (p.ready < q.ready && p.takeoff > q.takeoff) overtakes++;
      // 飢餓の判定: 最大待機は 1 機あたりの滑走路占有・誘導の所要（≈ 6 分）×機数（4 スポット）以内。個別の機体が他機の待機より桁違いに長く待たない
      expect(max, `${seed} 最大待機 ${max}s / 中央値 ${median}s`).toBeLessThanOrEqual(Math.max(4 * 360 + 600, 6 * median));
      logD('d1g-fairness', { seed, departed: dep.length, diverted: acs.length - dep.length, waitSec: stats(waits), medianWaitSec: median, maxWaitSec: max, overtakePairs: overtakes, maxConcurrent: tr.maxConcurrentTowardRunway });
    });
  }
});
