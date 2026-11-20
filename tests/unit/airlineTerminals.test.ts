import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  addContract,
  allowedTerminalsFor,
  createSandboxCompany,
  importCompany,
  setAirlineTerminals,
  sortContracts,
  type CompanyState,
  type Contract,
} from '../../src/core/economy/company';
import { analyzeDayPlan, planDay, type DayPlan } from '../../src/core/economy/planning';
import { validateProject } from '../../src/core/io/project';
import { placeFacility, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import type { AirportLayout, TerminalAreaKind } from '../../src/core/model/types';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { addTurnaround, createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { standTerminalId } from '../../src/core/terminal/standTerminal';
import { must } from './helpers';
import { runUntil } from './sim/helpers';

const manual = { autoSchedule: false };

/** サンプル空港にもう 1 つターミナル棟（全エリア複製＋ゲート 1 つを付け替え）を足した 2 ターミナル空港 */
function twoTerminalAirport(): { layout: AirportLayout; first: string; second: string; standA: string; standB: string } {
  let layout = createSampleAirport();
  const first = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const originalAreas = Object.values(layout.terminalAreas).filter((area) => area.terminalId === first);
  layout = must(placeFacility(layout, 'terminal', { x: 106, y: 70 }, { w: 48, h: 8, name: 'ターミナルB', props: { levels: 2 } })).layout;
  const second = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
  for (const area of originalAreas) {
    layout = must(placeTerminalArea(layout, second, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + 60, y: area.origin.y + 21 }, {
      w: area.w,
      h: area.h,
      name: `${area.name} B`,
      props: structuredClone(area.props),
    })).layout;
  }
  const gates = Object.values(layout.facilities).filter((f) => f.kind === 'gate').sort((a, b) => a.id.localeCompare(b.id));
  const gateB = gates[0]!;
  layout = must(updateEntity(layout, gateB.id, { props: { connectedTo: second } })).layout;
  return { layout, first, second, standA: String(gates[1]!.props.standId), standB: String(gateB.props.standId) };
}

describe('航空会社の使用ターミナル制限（設定と判定）', () => {
  it('未設定は無制限、設定は路線種別ごとに独立し、解除でキーが消える', () => {
    const c = createSandboxCompany('terminals-unit');
    expect(allowedTerminalsFor(c, 'SK', 'domestic')).toBeNull();
    setAirlineTerminals(c, 'SK', 'domestic', ['fac_9', 'fac_2', 'fac_9']);
    // 重複は除かれ ID 順に正規化される
    expect(c.airlineTerminals).toEqual({ SK: { domestic: ['fac_2', 'fac_9'] } });
    expect(allowedTerminalsFor(c, 'SK', 'domestic')).toEqual(new Set(['fac_2', 'fac_9']));
    // 国際線は未設定のまま無制限
    expect(allowedTerminalsFor(c, 'SK', 'international')).toBeNull();
    setAirlineTerminals(c, 'SK', 'international', ['fac_2']);
    expect(allowedTerminalsFor(c, 'SK', 'international')).toEqual(new Set(['fac_2']));
    // 国内線だけ解除しても国際線は残る
    setAirlineTerminals(c, 'SK', 'domestic', null);
    expect(c.airlineTerminals).toEqual({ SK: { international: ['fac_2'] } });
    // 両方解除すると airlineTerminals 自体が消える（旧セーブと同じ形）
    setAirlineTerminals(c, 'SK', 'international', []);
    expect(c.airlineTerminals).toBeUndefined();
    expect(allowedTerminalsFor(null, 'SK', 'domestic')).toBeNull();
    expect(allowedTerminalsFor(c, null, 'domestic')).toBeNull();
  });

  it('セーブ/ロードで往復し、不正な項目は捨てられる', () => {
    const c = createSandboxCompany('terminals-roundtrip');
    setAirlineTerminals(c, 'NP', 'domestic', ['fac_1']);
    setAirlineTerminals(c, 'NP', 'international', ['fac_1', 'fac_2']);
    const back = importCompany(JSON.stringify(c));
    expect(back).not.toBeNull();
    expect(back!.airlineTerminals).toEqual({ NP: { domestic: ['fac_1'], international: ['fac_1', 'fac_2'] } });
    // 形が不正な項目（配列でない・数値混じり・空）は寛容読み込みで捨てられる
    const dirty = JSON.parse(JSON.stringify(c)) as CompanyState;
    (dirty.airlineTerminals as unknown) = { NP: { domestic: 'fac_1', international: [42, ''] }, RJ: { domestic: [] }, AQ: 'x' };
    const cleaned = importCompany(JSON.stringify(dirty));
    expect(cleaned).not.toBeNull();
    expect(cleaned!.airlineTerminals).toBeUndefined();
    // 項目自体がない旧セーブは未設定として読み込める
    const legacy = JSON.parse(JSON.stringify(c)) as CompanyState;
    delete legacy.airlineTerminals;
    const old = importCompany(JSON.stringify(legacy));
    expect(old).not.toBeNull();
    expect(old!.airlineTerminals).toBeUndefined();
  });
});

describe('契約一覧のソート', () => {
  const base = { typeId: 'A320neo' as const, feeDiscount: 0.1, endDay: 100, offerExpiresDay: 0, numberBase: 100 };
  const mk = (id: string, over: Partial<Contract>): Contract => ({
    id, airlineId: 'NH', destinationId: 'TYO', perDay: 1, window: 'any', startDay: 0, status: 'active', ...base, ...over,
  });
  const list: Contract[] = [
    mk('ct_b', { airlineId: 'JL', destinationId: 'FUK', perDay: 2, window: 'evening', startDay: 5, status: 'offered' }),
    mk('ct_a', { airlineId: 'NH', destinationId: 'OKA', perDay: 4, window: 'morning', startDay: 3, status: 'active' }),
    mk('ct_c', { airlineId: 'NH', destinationId: 'TYO', perDay: 4, window: 'daytime', startDay: 1, status: 'ended' }),
  ];

  it('航空会社・行き先・時間帯・状態・便数・開始日で決定的に並ぶ', () => {
    const ids = (key: Parameters<typeof sortContracts>[1]) => sortContracts(list, key).map((k) => k.id);
    // 航空会社名順（ANA < JAL）。同社は ID 順
    expect(ids('airline')).toEqual(['ct_a', 'ct_c', 'ct_b']);
    // 行き先: 登録名の照合順で決定的に並び、全件が残る（照合順そのものは ICU の日本語照合に委ねる）
    expect(ids('destination')).toEqual(ids('destination'));
    expect(new Set(ids('destination'))).toEqual(new Set(['ct_a', 'ct_b', 'ct_c']));
    expect(sortContracts([...list].reverse(), 'destination').map((k) => k.id)).toEqual(ids('destination'));
    // 時間帯: morning < daytime < evening
    expect(ids('window')).toEqual(['ct_a', 'ct_c', 'ct_b']);
    // 状態: active < offered < ended
    expect(ids('status')).toEqual(['ct_a', 'ct_b', 'ct_c']);
    // 便数: 多い順、同数は開始日順
    expect(ids('perDay')).toEqual(['ct_c', 'ct_a', 'ct_b']);
    // 開始日順
    expect(ids('startDay')).toEqual(['ct_c', 'ct_a', 'ct_b']);
    // 元の配列は変更しない
    expect(list.map((k) => k.id)).toEqual(['ct_b', 'ct_a', 'ct_c']);
  });
});

describe('計画（analyzeDayPlan）への制限の反映', () => {
  const planFor = (over: Partial<DayPlan['flights'][number]> = {}, airlineTerminals?: CompanyState['airlineTerminals']): DayPlan => ({
    day: 0,
    dropped: [],
    ...(airlineTerminals ? { airlineTerminals } : {}),
    flights: [{
      key: 'f1', contractId: 'test', airlineId: 'SK', destinationId: 'north', typeId: 'narrow180',
      arrNumber: 'SK001', depNumber: 'SK002', arrivalAt: 3600, departureAt: 7200,
      arrPax: 80, depPax: 80, seats: 180, inboundDelaySec: 0, ...over,
    }],
  });

  it('スポットの所属ターミナルが計画の決定規則と一致する', () => {
    const { layout, first, second, standA, standB } = twoTerminalAirport();
    const ctx = createContext(layout);
    expect(standTerminalId(ctx, standA)).toBe(first);
    expect(standTerminalId(ctx, standB)).toBe(second);
  });

  it('許可ターミナルにだけ仮割り当てされ、範囲内スポットがないと TERMINAL_RESTRICTED になる', () => {
    const { layout, first, second } = twoTerminalAirport();
    const ctx = createContext(layout);
    // 制限なし: 従来どおり割り当たる
    const free = analyzeDayPlan(planFor(), ctx);
    expect(free.assignments.f1!.standId).not.toBeNull();
    // 第2ターミナルだけ許可: 割り当ては第2ターミナルのスポットになる
    const onlyB = analyzeDayPlan(planFor({}, { SK: { domestic: [second] } }), ctx);
    expect(onlyB.assignments.f1!.terminalId).toBe(second);
    // 第1ターミナルだけ許可: 第1ターミナルのスポットになる
    const onlyA = analyzeDayPlan(planFor({}, { SK: { domestic: [first] } }), ctx);
    expect(onlyA.assignments.f1!.terminalId).toBe(first);
    // 実在しないターミナルだけ許可: 置けるスポットはあるのに制限で置けない
    const none = analyzeDayPlan(planFor({}, { SK: { domestic: ['fac_999'] } }), ctx);
    expect(none.assignments.f1!.standId).toBeNull();
    expect(none.issues.some((i) => i.code === 'TERMINAL_RESTRICTED' && i.keys.includes('f1'))).toBe(true);
    // 国際線の設定は国内線の便に効かない
    const intlOnly = analyzeDayPlan(planFor({}, { SK: { international: ['fac_999'] } }), ctx);
    expect(intlOnly.assignments.f1!.standId).not.toBeNull();
  });

  it('planDay が会社の設定を計画へ引き継ぐ', () => {
    const c = createSandboxCompany('terminals-planday');
    setAirlineTerminals(c, 'NP', 'domestic', ['fac_1']);
    const plan = planDay(c, 0);
    expect(plan.airlineTerminals).toEqual({ NP: { domestic: ['fac_1'] } });
    const unset = planDay(createSandboxCompany('terminals-planday-2'), 0);
    expect(unset.airlineTerminals).toBeUndefined();
  });
});

describe('運航（assignStand）への制限の反映', () => {
  it('許可ターミナルのスポットにだけ割り当たり、空きがあっても他へ回らない', { timeout: 120_000 }, () => {
    const { layout, second, standB } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim');
    setAirlineTerminals(c, 'SK', 'domestic', [second]);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { airline: 'SK' });
    runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
    expect(ac.standId).toBe(standB);
  });

  it('許可ターミナル内にスポットがない場合は terminalRestricted で待機する', { timeout: 120_000 }, () => {
    const { layout } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim-hold');
    setAirlineTerminals(c, 'SK', 'domestic', ['fac_999']);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { airline: 'SK' });
    runUntil(sim, () => ac.state === 'holding', 3600);
    expect(ac.holdReason).toBe('terminalRestricted');
    expect(ac.standId).toBeNull();
    expect(sim.state.flights[ac.arrivalFlightId]!.delayCauses).toContain('noStand');
  });

  it('未設定の会社は従来どおり割り当たる', { timeout: 120_000 }, () => {
    const { layout } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim-free');
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { airline: 'SK' });
    runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
    expect(ac.standId).not.toBeNull();
    expect(ac.holdReason).not.toBe('terminalRestricted');
  });

  it('国内線と国際線で別設定が効く（国際線は国際線の設定だけを見る）', { timeout: 120_000 }, () => {
    const { layout, second, standB } = twoTerminalAirport();
    // 第2ターミナルのゲートを国際線専用にする
    const gateB = Object.values(layout.facilities).find((f) => f.kind === 'gate' && f.props.standId === standB)!;
    layout.facilities[gateB.id]!.props = { ...gateB.props, routeType: 'international' };
    const c = createSandboxCompany('terminals-sim-intl');
    // 国内線は実在しないターミナルに制限（国内便なら待機するはず）、国際線は第2ターミナルを許可
    setAirlineTerminals(c, 'SK', 'domestic', ['fac_999']);
    setAirlineTerminals(c, 'SK', 'international', [second]);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, { airline: 'SK' });
    sim.state.flights[ac.arrivalFlightId]!.routeType = 'international';
    runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
    expect(ac.standId).toBe(standB);
  });

  it('制限つきでも到着→折り返し→出発が完了し、制限のない会社は通常運航する', { timeout: 120_000 }, () => {
    const { layout, second, standB } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim-complete');
    setAirlineTerminals(c, 'SK', 'domestic', [second]);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const t = sim.state.now + 20 * 60;
    const a = addTurnaround(sim, 'narrow180', t, { airline: 'SK', departureAt: t + 3 * 3600 });
    const b = addTurnaround(sim, 'narrow180', t + 10 * 60, { airline: 'NP', departureAt: t + 3.5 * 3600 });
    for (let i = 0; i < 5 * 3600 && (sim.state.flights[a.departureFlightId]!.status !== 'completed' || sim.state.flights[b.departureFlightId]!.status !== 'completed'); i++) {
      stepSimulation(sim);
    }
    // 制限つきの便は許可ターミナルのスポットで折り返して出発まで完了する
    expect(sim.state.flights[a.arrivalFlightId]!.standId).toBe(standB);
    expect(sim.state.flights[a.departureFlightId]!.status).toBe('completed');
    expect(sim.state.flights[b.departureFlightId]!.status).toBe('completed');
    expect(sim.state.flights[b.arrivalFlightId]!.standId).not.toBeNull();
  });

  it('貨物便は制限の対象外', { timeout: 120_000 }, () => {
    const { layout } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim-cargo');
    setAirlineTerminals(c, 'SK', 'domestic', ['fac_999']);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, {
      airline: 'SK',
      plan: { contractId: 'cargo-1', destinationId: 'north', arrPax: 0, depPax: 0, standId: null, cargo: { volumeM3: 10 } },
    });
    runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
    expect(ac.standId).not.toBeNull();
    expect(ac.holdReason).not.toBe('terminalRestricted');
  });

  it('契約の専用スポットは制限より優先する', { timeout: 120_000 }, () => {
    const { layout, second, standA } = twoTerminalAirport();
    const c = createSandboxCompany('terminals-sim-dedicated');
    const k = addContract(c, {
      airlineId: 'SK', destinationId: 'TYO', typeId: 'A320neo', perDay: 1, window: 'any',
      feeDiscount: 0, startDay: 0, endDay: 9999, status: 'active', offerExpiresDay: 0, dedicatedStandId: standA,
    });
    // 制限は第2ターミナルだけだが、専用スポット（第1ターミナル）が優先される
    setAirlineTerminals(c, 'SK', 'domestic', [second]);
    const sim = createSimulation(layout, { company: c, settings: manual });
    const ac = addTurnaround(sim, 'narrow180', sim.state.now + 20 * 60, {
      airline: 'SK',
      plan: { contractId: k.id, destinationId: 'TYO', arrPax: 100, depPax: 100, standId: null },
    });
    runUntil(sim, () => ac.standId !== null || ac.state === 'holding', 3600);
    expect(ac.standId).toBe(standA);
  });
});

describe('実セーブ互換', () => {
  it('2048 セーブが読み込め、契約が壊れず、制限は未設定として扱われる', () => {
    const path = '/home/hatch/workspace/user/files/skyport-mainplay1-20261119-2048.skyport.json';
    if (!existsSync(path)) return; // 実セーブのない環境ではスキップ
    const json = readFileSync(path, 'utf8');
    const report = validateProject(json, { fallbackCompany: createSandboxCompany('terminals-fallback') });
    expect(report.ok).toBe(true);
    const save = JSON.parse(json) as { company: CompanyState };
    const imported = importCompany(JSON.stringify(save.company));
    expect(imported).not.toBeNull();
    expect(Object.keys(imported!.contracts).length).toBe(Object.keys(save.company.contracts).length);
    expect(imported!.airlineTerminals).toBeUndefined();
    // 設定を足した会社データも検証を通る（往復）
    const c = importCompany(JSON.stringify(save.company))!;
    const someAirline = Object.values(c.contracts).find((k) => k.status === 'active')!.airlineId;
    const someTerminal = 'fac_50';
    setAirlineTerminals(c, someAirline, 'domestic', [someTerminal]);
    const again = importCompany(JSON.stringify(c));
    expect(again!.airlineTerminals).toEqual({ [someAirline]: { domestic: [someTerminal] } });
  });
});
