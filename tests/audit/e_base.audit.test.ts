/**
 * 監査 e / PART 4: 基地空港としての機能（整備施設・格納庫・夜間駐機・所属機）。
 * 文書: docs/09_roadmap.md:155「ハブ航空会社、航空機配置/夜間滞泊、整備サイクル、乗継旅客、貨物の荷役・収支は未実装」、
 *       docs/11_operations_rules.md:186「牽引移動（格納庫への牽引）| 後続」、docs/39 T6「格納庫・消防施設は費用だけで効果がない」/ A2「夜間滞泊と朝の出発の波」。
 * 方針: grep（静的）＋同一日の with/without 比較で、施設が何を変えるかを測る。分類 D = 文書で未実装、E = 仕様・モデルなし。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createSandboxCompany } from '../../src/core/economy/company';
import { planDay } from '../../src/core/economy/planning';
import { deleteEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { operableTypes } from '../../src/core/sim/context';
import { createSimulation, addTurnaround, stepSimulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { analyzeLayout } from '../../src/core/validation/validate';
import { checkAirport } from '../../src/core/aircraft/compat';
import type { AirportLayout } from '../../src/core/model/types';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import { sha } from './c_helpers';
import { logE, manual, H } from './e_helpers';
import { must } from '../unit/helpers';

const without = (l: AirportLayout, kind: string): AirportLayout => {
  let out = l;
  for (const f of Object.values(l.facilities)) if (f.kind === kind) out = must(deleteEntity(out, f.id)).layout;
  return out;
};

function grepSrc(dir: string, re: RegExp): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) readFileSync(p, 'utf8').split('\n').forEach((line, i) => { if (re.test(line)) hits.push(`${p.replace(process.cwd() + '/', '')}:${i + 1}`); });
    }
  };
  walk(join(process.cwd(), dir));
  return hits;
}

describe('ID-e4 静的調査: 基地機能に関する語が運航・経済・検証のロジックに現れるか', () => {
  it("'hangar' は費用（balance.ts）・工期（expansion.ts）・カタログ/型/サンプル配置だけ。sim / validation / 計画には現れない。'overnight'・'nightStay'・'based'・'spare' なども無い (D/E)", () => {
    const hangar = grepSrc('src/core', /hangar/i);
    const logic = hangar.filter((h) => /src\/core\/(sim|validation|economy\/(planning|capacity|ops|company|registry))/.test(h));
    logE('e4-grep-hangar', { all: hangar, inLogicDirs: logic });
    expect(logic).toEqual([]);
    expect(hangar.some((h) => h.startsWith('src/core/economy/balance.ts'))).toBe(true);
    expect(hangar.some((h) => h.startsWith('src/core/economy/expansion.ts'))).toBe(true);
    for (const w of [/overnight/i, /night.?stay/i, /basedAircraft|homeBase|baseAirport|aircraft.?based/i, /spareAircraft|spare\s*aircraft/i, /maintenanceCycle|checkInterval|aCheck|cCheck/i]) expect(grepSrc('src/core', w), String(w)).toEqual([]);
  });

  it('航空機（Aircraft）と機種（AircraftType）に「所属・登録・整備時間・予備」の項目がない（E）', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'e4-keys', settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 600);
    const acKeys = Object.keys(ac);
    const typeKeys = Object.keys(AIRCRAFT_TYPES.narrow180!);
    logE('e4-keys', { aircraft: acKeys, type: typeKeys });
    for (const k of [...acKeys, ...typeKeys]) expect(k, k).not.toMatch(/home|based|tail|registration|overnight|maintenanc|hangar|spare/i);
  });
});

describe('ID-e4 格納庫: 有無で運航結果は同一、費用だけ変わる（docs/39 T6 の再確認）', () => {
  const day = (l: AirportLayout) => {
    const sim = createSimulation(l, { seed: 'e4-hangar', company: createSandboxCompany('e4-hangar') });
    for (let i = 0; i < 18 * H - 60; i++) stepSimulation(sim);
    return sim;
  };
  it('サンプル空港の格納庫を撤去して 1 日（06:00〜23:59）: sim.state（機体・旅客・統計）は完全一致。日報は費用の列だけが違う（維持費）。validation / 能力ダッシュボードは格納庫を参照しない', () => {
    const base = createSampleAirport();
    const noHangar = without(base, 'hangar');
    expect(Object.values(noHangar.facilities).some((f) => f.kind === 'hangar')).toBe(false);
    const a = day(base);
    const b = day(noHangar);
    // 運航の状態（機体・旅客・統計・乱数）は 1 ビットも違わない。違うのは economy（日次固定費の見積もり）だけ
    const strip = (sim: ReturnType<typeof day>) => { const { economy, ...rest } = sim.state as unknown as Record<string, unknown>; void economy; return rest; };
    expect(sha(JSON.stringify(strip(b)))).toBe(sha(JSON.stringify(strip(a))));
    const fa = JSON.stringify(a.state.economy!.fixedDaily);
    const fb = JSON.stringify(b.state.economy!.fixedDaily);
    const ra = a.company!.today;
    const rb = b.company!.today;
    const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
    const diff = [...keys].filter((k) => (ra as Record<string, number>)[k] !== (rb as Record<string, number>)[k]);
    logE('e4-hangar-ab', { stateIdenticalExceptEconomy: true, fixedDailyWith: a.state.economy!.fixedDaily, fixedDailyWithout: b.state.economy!.fixedDaily, todayLedgerDiffKeys: diff, flights: a.state.stats.departures });
    expect(fa).not.toBe(fb); // 費用だけが違う
    // 差は費用の勘定科目のみ（収入側は一致）
    const revKeys = ['landing', 'parking', 'terminal', 'groundHandling', 'contract', 'transit', 'carPark', 'hotel'];
    for (const k of revKeys) expect((ra as Record<string, number>)[k] ?? 0, k).toBe((rb as Record<string, number>)[k] ?? 0);
    // validation: 格納庫の有無は NO_HANGAR のような警告を出さない
    const codesA = new Set(analyzeLayout(base).issues.map((i) => i.code));
    const codesB = new Set(analyzeLayout(noHangar).issues.map((i) => i.code));
    expect([...codesB].filter((c) => !codesA.has(c))).toEqual([]);
    // ダッシュボードの施設行にも格納庫は出ない
    const snap = analyzeAirportCapacity(a.company!, a.ctx);
    expect(snap.facilities.some((f) => f.kind.includes('格納庫'))).toBe(false);
  }, 300_000);
});

describe('ID-e4 整備施設（maintenance）: 費用・警告だけではなく「整備士」として点検作業の必要資源になる（先行調査の想定と異なる）', () => {
  it('整備施設を撤去: validation NO_MAINTENANCE（警告）が出るだけでなく、点検作業が整備士を要求するため適合性表示（GSE_NONE=ng）と実運航（出発不能）に影響する。運航可否の判定（operableTypes）・計画は変わらない', () => {
    const base = createSampleAirport();
    const noMaint = without(base, 'maintenance');
    const issue = analyzeLayout(noMaint).issues.find((i) => i.code === 'NO_MAINTENANCE');
    expect(issue?.severity).toBe('warning');
    expect(analyzeLayout(base).issues.some((i) => i.code === 'NO_MAINTENANCE')).toBe(false);
    const ctxA = createSimulation(base, { seed: 'e4-m', settings: manual }).ctx;
    const ctxB = createSimulation(noMaint, { seed: 'e4-m', settings: manual }).ctx;
    const opA = operableTypes(ctxA).length;
    const opB = operableTypes(ctxB).length;
    const typeN = AIRCRAFT_TYPES.narrow180!;
    const compatA = checkAirport(typeN, base, ctxA.network);
    const compatB = checkAirport(typeN, noMaint, ctxB.network);
    // 実運航: 1 機の折り返し
    const run = (l: AirportLayout) => {
      const sim = createSimulation(l, { seed: 'e4-m', settings: manual });
      const ac = addTurnaround(sim, 'narrow180', sim.state.now + 600);
      for (let i = 0; i < 3 * H; i++) {
        stepSimulation(sim);
        if (i % 600 === 0) expect(checkInvariants(sim)).toEqual([]);
      }
      return { departed: ac.state === 'departed', noEngineerSec: sim.state.groundStats.blockedSec.noEngineer ?? 0 };
    };
    const ra = run(base);
    const rb = run(noMaint);
    logE('e4-maintenance-ab', { operableTypes: { with: opA, without: opB }, compatGround: { with: compatA.ground, without: compatB.ground }, flight: { with: ra, without: rb } });
    // 計画・運航可否（operableTypes = canOperate）は整備施設の有無を見ない。適合性表示（checkAirport）だけが GSE_NONE（ng）を示す
    expect(opB).toBe(opA);
    expect(compatA.ground.status).toBe('ok');
    expect(compatB.ground.status).toBe('ng');
    expect(compatB.ground.detail).toContain('engineer');
    expect(ra.departed).toBe(true);
    expect(rb.departed).toBe(false);
    expect(rb.noEngineerSec).toBeGreaterThan(0);
  }, 120_000);

  it('[B] 整備施設の撤去で「運航可能な機種」が減る/なくなるのに、能力ダッシュボードの折り返し能力・NO_MAINTENANCE 以外の警告は変わらない。整備士は職員数（通勤駐車）にも加算される', () => {
    const base = createSampleAirport();
    const noMaint = without(base, 'maintenance');
    const snap = (l: AirportLayout) => { const s = createSimulation(l, { seed: 'e4-dash', settings: manual, company: createSandboxCompany('e4-dash') }); return analyzeAirportCapacity(s.company!, s.ctx); };
    const a = snap(base);
    const b = snap(noMaint);
    const turn = (x: typeof a) => x.summary.find((m) => m.name === '地上支援・折り返し')!.capacity;
    logE('e4-maintenance-dashboard', { turnCapWith: turn(a), turnCapWithout: turn(b) });
    // 計画 1-20 TA-2 で更新: 整備士（整備施設）がなければ折り返し能力は 0（旧: 不変）
    expect(turn(a)).toBeGreaterThan(0);
    expect(turn(b)).toBe(0);
  });
});

describe('ID-e4 夜間駐機・所属機・初便の出発（docs/09:155 で未実装）', () => {
  it('計画（planDay）: すべての便が「到着 → 折り返し → 同日の出発」で閉じる。出発が閉場（23:00）を越える便は計画されず、前日からの在泊機・始発のみの出発・日をまたぐ便はない', () => {
    const c = createSandboxCompany('e4-plan');
    const plan = planDay(c, 0);
    const close = c.hours.closeMin * 60;
    for (const f of plan.flights) {
      expect(f.departureAt, f.key).toBeGreaterThan(f.arrivalAt);
      expect(f.departureAt, f.key).toBeLessThanOrEqual(close);
      expect(f.arrNumber).not.toBe(f.depNumber);
    }
    const lastDep = Math.max(...plan.flights.map((f) => f.departureAt));
    const firstArr = Math.min(...plan.flights.map((f) => f.arrivalAt));
    logE('e4-plan-shape', { flights: plan.flights.length, firstArrival: firstArr / 3600, lastDeparture: lastDep / 3600, closeH: close / 3600, dropped: plan.dropped.length });
    expect(firstArr).toBeGreaterThanOrEqual(c.hours.openMin * 60);
  });

  it('通常の 2 日運航: 日付が変わる 00:00 に、スポット上に機体が残らない（夜間駐機なし）。2 日目の最初の出発は 2 日目の到着機（前日からの在泊機ではない）', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'e4-night', company: createSandboxCompany('e4-night') });
    let onStandAtMidnight = -1;
    const firstDepDay1 = { t: Infinity };
    for (let i = 0; i < 2 * 86400 - 6 * H - 3600; i++) {
      stepSimulation(sim);
      if (sim.state.now === 86400 + 60) {
        onStandAtMidnight = Object.values(sim.state.aircraft).filter((a) => a.standId && !['departed', 'diverted', 'cannotOperate', 'scheduled'].includes(a.state)).length;
      }
      if (sim.state.now > 86400 && firstDepDay1.t === Infinity) {
        const dep = Object.values(sim.state.aircraft).find((a) => a.history.some((h) => h.state === 'takeoff' && h.t > 86400));
        if (dep) firstDepDay1.t = dep.history.find((h) => h.state === 'takeoff' && h.t > 86400)!.t;
      }
      if (i % 900 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    const firstDay2Dep = Object.values(sim.state.aircraft).flatMap((a) => a.history.filter((h) => h.state === 'takeoff' && h.t > 86400).map((h) => ({ id: a.id, t: h.t, landed: a.history.find((x) => x.state === 'landing')?.t ?? null }))).sort((x, y) => x.t - y.t)[0];
    logE('e4-overnight', { aircraftOnStandAfterMidnight: onStandAtMidnight, firstDay2Departure: firstDay2Dep });
    expect(onStandAtMidnight).toBe(0);
    expect(firstDay2Dep).toBeDefined();
    expect(firstDay2Dep!.landed).not.toBeNull();
    expect(firstDay2Dep!.landed!).toBeGreaterThan(86400); // 前日に着陸した機体の翌朝出発はない
  }, 300_000);

  it('手動で夜間滞泊（22:30 着陸 → 翌 01:30 出発）を作ると、会社つき運航でも日締めを挟んで機体はスポットに留まり出発できる（機能としては成立するが、計画は作らない）。不変条件違反なし', () => {
    const sim = createSimulation(createSampleAirport(), { seed: 'e4-manual', settings: manual, company: createSandboxCompany('e4-manual') });
    sim.state.now = 22 * H;
    const ac = addTurnaround(sim, 'narrow180', 22 * H + 1800, { departureAt: 86400 + 1.5 * H });
    let standAtMidnight: string | null = null;
    let dayAtMidnight = -1;
    for (let i = 0; i < 4 * H; i++) {
      stepSimulation(sim);
      if (sim.state.now === 86400 + 60) { standAtMidnight = ac.standId; dayAtMidnight = sim.company!.day; }
      if (i % 300 === 0) expect(checkInvariants(sim)).toEqual([]);
    }
    logE('e4-manual-overnight', { state: ac.state, standAtMidnight, companyDayAfterClose: dayAtMidnight, departedAt: ac.history.find((h) => h.state === 'takeoff')?.t });
    expect(standAtMidnight).not.toBeNull();
    expect(ac.state).toBe('departed');
  }, 120_000);
});
