import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createSimulation, stepSimulation } from '../../../src/core/sim/simulation';
import {
  areaOccupancy,
  setAreaClosed,
  setFacilityEventModeForTest,
  setPaxEventModeForTest,
} from '../../../src/core/sim/passengers';
import { PAX_FINAL_STATES } from '../../../src/core/sim/types';
import { setBagEventModeForTest } from '../../../src/core/sim/baggage';
import { buildProject, effectiveModels, restoreSimulation, serializeProject, validateProject } from '../../../src/core/io/project';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { loadFixture } from '../../golden/io';

/**
 * 性能改善 第4弾の影照合（perf4-design.md §6）:
 * イベント経路（グループ睡眠・施設イベント化）と従来経路（全走査）を同じシナリオで走らせ、
 * 状態ハッシュ（state の JSON 全体＝乱数状態・waitSec・統計を含む）が完全一致することを確認する。
 * あわせて、イベント経路での途中保存→復元→継続が、無中断の継続と一致することも確認する。
 */
const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const stateHash = (sim: ReturnType<typeof createSimulation>): string => sha256(JSON.stringify(sim.state));

interface Mode {
  pax: boolean;
  facility: boolean;
  bag: boolean;
}

function runHashes(
  make: () => ReturnType<typeof createSimulation>,
  ticks: number,
  mode: Mode,
  hooks?: (sim: ReturnType<typeof createSimulation>, tick: number) => void,
): string[] {
  setPaxEventModeForTest(mode.pax);
  setFacilityEventModeForTest(mode.facility);
  setBagEventModeForTest(mode.bag);
  try {
    const sim = make();
    const hashes: string[] = [];
    for (let t = 1; t <= ticks; t++) {
      stepSimulation(sim);
      hooks?.(sim, t);
      if (t % 900 === 0 || t === ticks) hashes.push(stateHash(sim));
    }
    return hashes;
  } finally {
    setPaxEventModeForTest(true);
    setFacilityEventModeForTest(true);
    setBagEventModeForTest(true);
  }
}

const MODES: { name: string; mode: Mode }[] = [
  { name: '従来経路', mode: { pax: false, facility: false, bag: false } },
  { name: 'グループ睡眠のみ', mode: { pax: true, facility: false, bag: false } },
  { name: 'グループ睡眠＋施設イベント化', mode: { pax: true, facility: true, bag: false } },
  { name: '手荷物イベント化のみ', mode: { pax: false, facility: false, bag: true } },
  { name: '全イベント化', mode: { pax: true, facility: true, bag: true } },
];

describe('PERF4 影照合: イベント経路は従来経路と状態が完全一致する', () => {
  it('ストレス運航（flightsPerDay 120・1時間）', { timeout: 600_000 }, () => {
    const make = () => createSimulation(loadFixture('stress'), { seed: 'stress-a', settings: { flightsPerDay: 120 } });
    const results = MODES.map(({ name, mode }) => ({ name, hashes: runHashes(make, 3600, mode) }));
    for (let k = 1; k < results.length; k++) {
      expect(results[k]!.hashes, `${results[k]!.name} が従来経路と一致する`).toEqual(results[0]!.hashes);
    }
  });

  it('サンプル空港＋会社（店舗・ラウンジ・1時間）', { timeout: 600_000 }, () => {
    const make = () => createSimulation(loadFixture('sample'), { company: createSandboxCompany() });
    const results = MODES.map(({ name, mode }) => ({ name, hashes: runHashes(make, 3600, mode) }));
    for (let k = 1; k < results.length; k++) {
      expect(results[k]!.hashes, `${results[k]!.name} が従来経路と一致する`).toEqual(results[0]!.hashes);
    }
  });

  it('バス運航（flightsPerDay 160・1時間）', { timeout: 600_000 }, () => {
    const make = () => createSimulation(loadFixture('sample'), { seed: 'bus-golden', settings: { flightsPerDay: 160 } });
    const results = MODES.map(({ name, mode }) => ({ name, hashes: runHashes(make, 3600, mode) }));
    for (let k = 1; k < results.length; k++) {
      expect(results[k]!.hashes, `${results[k]!.name} が従来経路と一致する`).toEqual(results[0]!.hashes);
    }
  });

  it('エリア閉鎖・再開を挟む運航（ストレス・1時間）', { timeout: 600_000 }, () => {
    const layout = loadFixture('stress');
    const areaId = Object.values(layout.terminalAreas).find((a) => a.kind === 'security')!.id;
    const hooks = (sim: ReturnType<typeof createSimulation>, t: number): void => {
      if (t === 1200) setAreaClosed(sim, areaId, true);
      if (t === 2400) setAreaClosed(sim, areaId, false);
    };
    const make = () => createSimulation(loadFixture('stress'), { seed: 'stress-b', settings: { flightsPerDay: 120 } });
    const results = MODES.map(({ name, mode }) => ({ name, hashes: runHashes(make, 3600, mode, hooks) }));
    for (let k = 1; k < results.length; k++) {
      expect(results[k]!.hashes, `${results[k]!.name} が従来経路と一致する`).toEqual(results[0]!.hashes);
    }
  });

  it('PERF4-3: 増分占有マップが全構築と一致する（イベント経路・ストレス）', { timeout: 600_000 }, () => {
    setPaxEventModeForTest(true);
    setFacilityEventModeForTest(true);
    setBagEventModeForTest(true);
    try {
      const sim = createSimulation(loadFixture('stress'), { seed: 'stress-a', settings: { flightsPerDay: 120 } });
      const expected = () => {
        const m = new Map<string, number>();
        for (const id of sim.state.activePax) {
          const g = sim.state.paxGroups[id]!;
          if (g.area && !PAX_FINAL_STATES.includes(g.state)) m.set(g.area, (m.get(g.area) ?? 0) + g.count);
        }
        return m;
      };
      for (let t = 0; t < 3600; t++) {
        stepSimulation(sim);
        if (t % 300 === 299) expect(areaOccupancy(sim.state), `tick ${t + 1}`).toEqual(expected());
      }
    } finally {
      setPaxEventModeForTest(true);
      setFacilityEventModeForTest(true);
      setBagEventModeForTest(true);
    }
  });

  it('イベント経路: 途中保存→復元→継続が無中断と一致する', { timeout: 600_000 }, () => {
    setPaxEventModeForTest(true);
    setFacilityEventModeForTest(true);
    setBagEventModeForTest(true);
    try {
      const company = createSandboxCompany();
      const sim = createSimulation(loadFixture('sample'), { company });
      for (let i = 0; i < 1800; i++) stepSimulation(sim);
      const json = serializeProject(
        buildProject({ name: 'perf4-shadow', savedAt: '2026-11-10T00:00:00Z', layout: sim.ctx.layout, company, pin: null, scenarios: [], sim }),
      );
      const report = validateProject(json, { fallbackCompany: createSandboxCompany() });
      expect(report.ok).toBe(true);
      const { sim: restored } = restoreSimulation(report.project!.layout, report.project!.sim!, effectiveModels(report.project!.catalog));
      for (let i = 0; i < 1800; i++) {
        stepSimulation(sim);
        stepSimulation(restored);
      }
      expect(stateHash(restored)).toBe(stateHash(sim));
    } finally {
      setPaxEventModeForTest(true);
      setFacilityEventModeForTest(true);
      setBagEventModeForTest(true);
    }
  });
});
