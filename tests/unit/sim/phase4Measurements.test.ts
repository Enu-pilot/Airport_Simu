import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../../src/core/sample/sampleAirport';
import { addTerminalTransitLink, placeFacility, placeTerminalArea, updateEntity, updateLayoutSettings } from '../../../src/core/layout/operations';
import { type AreaLink, type AreaNode, type TerminalModel } from '../../../src/core/terminal/model';
import { analyzeHub } from '../../../src/core/terminal/hub';
import { buildLandsideNetwork } from '../../../src/core/access/landside';
import { analyzeSegments } from '../../../src/core/access/segments';
import { addContract, createSandboxCompany, type CompanyState } from '../../../src/core/economy/company';
import { addTurnaround, createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import { morningWave } from '../../../src/core/sim/overnight';
import { DAY_SEC } from '../../../src/core/sim/rules';
import type { AirportLayout, TerminalAreaKind } from '../../../src/core/model/types';
import { domTransferAirport } from '../transferLayout';
import { emptyLayout, must } from '../helpers';
import { runUntil } from './helpers';

/**
 * フェーズ 4 の未検証計測（docs/44 §6・§8）の実施:
 * 1. MCT 解析の大規模計測（ゲート 80・エリア 500、予算 100 ms）
 * 2. 区間解析の大規模計測（辺 約 2,000、予算 20 ms）
 * 3. 2 ターミナル乗継の波（連絡リンク経由の接続完了と hubStats.byLink の蓄積）
 * 4. 朝の波・バンクの、区間走行（taxiMode 'block'）での再計測
 * 計測値はこの VM（共有 1.5 CPU）の参考値として出力に残す。閾値は桁違いの退行検出用。
 */
const manual = { autoSchedule: false };
const median = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('Phase 4 計測 1: MCT 解析（ゲート80・エリア500）', () => {
  it('予算規模でも解析でき、決定的で、実測値を記録する', () => {
    const areas: Record<string, AreaNode> = {};
    const links: Record<string, AreaLink[]> = {};
    const gates: TerminalModel['gates'] = {};
    const layoutAreas: AirportLayout['terminalAreas'] = {};
    const addArea = (id: string, kind: AreaNode['kind']) => {
      areas[id] = { id, terminalId: 'T', level: 1, kind, zone: 'departure', x: 0, y: 0, w: 4, h: 2, center: { x: 0, y: 0 }, capacity: 100 };
      links[id] = [];
      layoutAreas[id] = { id, terminalId: 'T', level: 1, kind: kind as TerminalAreaKind, name: id, origin: { x: 0, y: 0 }, w: 4, h: 2, zone: 'departure', props: kind === 'transferSecurity' ? { lanes: 2 } : {} };
    };
    const link = (a: string, b: string) => {
      links[a]!.push({ to: b, lengthM: 40, travelSec: 0, via: { x: 0, y: 0 } });
      links[b]!.push({ to: a, lengthM: 40, travelSec: 0, via: { x: 0, y: 0 } });
    };
    addArea('ts', 'transferSecurity');
    const chain: string[] = [];
    for (let i = 0; i < 339; i++) { addArea(`w${i}`, 'waiting'); chain.push(`w${i}`); }
    link('ts', 'w0');
    for (let i = 0; i + 1 < chain.length; i++) link(chain[i]!, chain[i + 1]!);
    for (let g = 0; g < 80; g++) {
      addArea(`d${g}`, 'waiting');
      addArea(`b${g}`, 'waiting');
      link(`d${g}`, 'ts');
      link('w338', `b${g}`);
      gates[`gate${g}`] = { terminalId: 'T', boarding: `b${g}`, deplane: `d${g}` };
    }
    expect(Object.keys(areas)).toHaveLength(500);
    const model: TerminalModel = { areas, links, gates, byTerminal: { T: Object.keys(areas) } };
    const layout = { terminalAreas: layoutAreas } as unknown as AirportLayout;
    const times: number[] = [];
    let hub: ReturnType<typeof analyzeHub> | undefined;
    for (let i = 0; i < 3; i++) {
      const m2: TerminalModel = { areas, links, gates, byTerminal: model.byTerminal };
      const t0 = performance.now();
      hub = analyzeHub(layout, m2);
      times.push(performance.now() - t0);
    }
    console.log(`[phase4] MCT gates=80 areas=500 median=${median(times).toFixed(1)}ms (budget 100ms on a fast machine)`);
    expect(hub!.byKind.DD.pairs).toBe(80 * 80);
    expect(hub!.mct.DD).not.toBeNull();
    expect(median(times)).toBeLessThan(20000);
  });
});

describe('Phase 4 計測 2: 区間解析（辺約2,000）', () => {
  it('格子状道路網でも解析でき、実測値を記録する', () => {
    let l: AirportLayout = emptyLayout(400, 400);
    l = must(placeFacility(l, 'terminal', { x: 30, y: 22 }, { w: 20, h: 8, name: 'T' })).layout;
    const nodes: AirportLayout['roadNodes'] = {};
    const roads: AirportLayout['roads'] = {};
    const N = 32;
    const nid = (i: number, j: number) => `rn_${i}_${j}`;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      nodes[nid(i, j)] = { id: nid(i, j), pos: { x: 30 + i * 8, y: 30 + j * 8 }, name: '', level: 0, holdShort: false };
    }
    let e = 0;
    const addEdge = (a: string, b: string) => {
      const id = `rd_${e++}`;
      roads[id] = { id, from: a, to: b, name: '', roadClass: 'public', oneWay: false, buildState: 'operational' };
    };
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      if (i + 1 < N) addEdge(nid(i, j), nid(i + 1, j));
      if (j + 1 < N) addEdge(nid(i, j), nid(i, j + 1));
    }
    l = { ...l, roadNodes: nodes, roads };
    expect(e).toBeGreaterThanOrEqual(1900);
    const times: number[] = [];
    let segs: ReturnType<typeof analyzeSegments> | undefined;
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      segs = analyzeSegments(l, buildLandsideNetwork(l));
      times.push(performance.now() - t0);
    }
    console.log(`[phase4] segments edges=${e} median=${median(times).toFixed(1)}ms (budget 20ms on a fast machine)`);
    expect(segs).toBeDefined();
    expect(median(times)).toBeLessThan(20000);
  });
});

describe('Phase 4 計測 3: 2ターミナルの乗継の波', () => {
  it('到着バンク（A）→連絡リンク→出発バンク（B）が全員接続し、byLink に蓄積される', { timeout: 600000 }, () => {
    let layout = domTransferAirport();
    const first = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    const originalAreas = Object.values(layout.terminalAreas).filter((a) => a.terminalId === first);
    layout = must(placeFacility(layout, 'terminal', { x: 106, y: 70 }, { w: 48, h: 8, name: 'ターミナルB', props: { levels: 2 } })).layout;
    const second = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
    let bTransferWaiting = '';
    for (const area of originalAreas) {
      const placed = must(placeTerminalArea(layout, second, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + 60, y: area.origin.y + 21 }, {
        w: area.w, h: area.h, name: `${area.name} B`, props: structuredClone(area.props),
      }));
      layout = placed.layout;
      if (area.id === 'ta_t3') bTransferWaiting = placed.created[0]!;
    }
    const gates = Object.values(layout.facilities).filter((f) => f.kind === 'gate').sort((a, b) => a.id.localeCompare(b.id));
    const gateB = gates[0]!;
    layout = must(updateEntity(layout, gateB.id, { props: { connectedTo: second } })).layout;
    // 到着は A の別々のスポットへ（同一スポットの重なりはスポット競合・ゲート付け替えを招くため）
    const standsA = [String(gates[1]!.props.standId), String(gates[2]!.props.standId), String(gates[3]!.props.standId)];
    const standB = String(gateB.props.standId);
    const linkRes = must(addTerminalTransitLink(layout, {
      kind: 'walkway', fromAreaId: 'ta_t3', toAreaId: bTransferWaiting, distanceM: 700, travelSec: 120,
      bidirectional: true, allowedZones: ['departure'], buildState: 'operational',
    }));
    layout = linkRes.layout;
    const linkId = linkRes.created[0]!;

    const sim = createSimulation(layout, { seed: 'xfer-2term-wave', settings: manual });
    const t = sim.state.now + 20 * 60;
    const pairs: { arr: string; dep: string }[] = [];
    // 波は 150 分間隔: B のスポットに先行機がいる間の到着重なりを避ける
    for (let k = 0; k < 3; k++) {
      const base = t + k * 150 * 60;
      const a = addTurnaround(sim, 'narrow180', base, {
        departureAt: base + 300 * 60,
        plan: { contractId: 'k-arr', destinationId: 'TYO', arrPax: 90, depPax: 0, standId: standsA[k]! },
      });
      const b = addTurnaround(sim, 'narrow180', base + 40 * 60, {
        departureAt: base + 170 * 60,
        plan: { contractId: 'k-dep', destinationId: 'OSA', arrPax: 0, depPax: 0, standId: standB },
      });
      const arrF = sim.state.flights[a.arrivalFlightId]!;
      const depF = sim.state.flights[b.departureFlightId]!;
      arrF.transferPlan = [{ depFlightId: depF.id, pax: 30, kind: 'DD' }];
      depF.plannedTransferIn = 30;
      pairs.push({ arr: a.arrivalFlightId, dep: b.departureFlightId });
    }
    const depAircraft = pairs.map((p) => sim.state.flights[p.dep]!.aircraftId);
    runUntil(sim, () => depAircraft.every((id) => sim.state.aircraft[id]!.state === 'departed'), 16 * 3600);
    expect(sim.state.hubStats?.spawned).toBe(90);
    expect(sim.state.hubStats?.connected).toBe(90);
    expect(sim.state.hubStats?.missed).toBe(0);
    // byLink は「通過回数×人数」の利用実績: 全員が少なくとも 1 回はリンクを通る。
    // ゲート付け替えが起きた便のグループは戻り方向にもう 1 回通るため、90 以上になりうる
    // （実測では 1 便分が付け替えられ 120 になった）
    expect(sim.state.hubStats?.byLink[linkId]).toBeGreaterThanOrEqual(90);
    for (const p of pairs) {
      expect(sim.state.flights[p.dep]!.pax.boarded).toBe(30);
      expect(sim.state.flights[p.arr]!.pax.exited).toBe(60);
    }
  });
});

describe('Phase 4 計測 4: 朝の波の区間走行（block）再計測', () => {
  it('block モードでも滞泊機が翌朝すべて出発し、朝の波が集計される', { timeout: 600000 }, () => {
    const c: CompanyState = createSandboxCompany('ovn-block');
    c.features = { overnight: true };
    addContract(c, {
      airlineId: 'HB', destinationId: 'KTA', typeId: 'B737-800', perDay: 2, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 999, status: 'active', offerExpiresDay: 0, kind: 'overnight',
    });
    const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const sim = createSimulation(layout, { company: c, seed: 'ovn-block' });
    // 06:00 開始 → 翌日 12:00 まで（締めと朝の出発を通る）
    const total = DAY_SEC + 6 * 3600;
    for (let i = 0; i < total; i++) stepSimulation(sim);
    expect(c.day).toBe(1);
    const wave = morningWave(sim, DAY_SEC, 2 * DAY_SEC);
    expect(wave).not.toBeNull();
    expect(wave!.departures).toBeGreaterThanOrEqual(2);
    // 朝の滞泊出発（置き直し分）は正午までにすべて完了している（block モードで詰まらない）
    const morningDeps = Object.values(sim.state.flights).filter(
      (f) => f.overnight && f.direction === 'departure' && f.scheduled >= DAY_SEC && f.scheduled < DAY_SEC + 12 * 3600,
    );
    expect(morningDeps.length).toBeGreaterThanOrEqual(2);
    expect(morningDeps.every((f) => f.status === 'completed')).toBe(true);
  });
});
