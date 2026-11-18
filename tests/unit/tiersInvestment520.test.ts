import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { addTaxiwayPath, placeFacility, placeStand, placeTerminalArea, updateEntity } from '../../src/core/layout/operations';
import { createContext, operableTypes } from '../../src/core/sim/context';
import { acceptOffer, contractsOf, createCareerCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame, startGame } from '../../src/core/economy/game';
import { createSimulation, stepSimulation } from '../../src/core/sim/simulation';
import { checkInvariants } from '../../src/core/sim/invariants';
import { DAY_SEC } from '../../src/core/sim/rules';
import type { AirportLayout, TerminalAreaKind } from '../../src/core/model/types';
import { must } from './helpers';

/**
 * 5-20 T8 残件: 投資ありプレイでの格 3 到達可能性（有機的検証ハーネス）。
 *
 * 無投資のサンプル空港はスポット 9 が上限になり約 150〜160 運航/日で頭打ちだった。
 * ここでは「開港前に資本を投じた」形として、第 2 ターミナル + スポット 10 追加 +
 * ゲート 10 追加 + GSE/整備の増強をしたレイアウトで、キャリア会社（大都市圏）が
 * 貪欲受諾で運航し、格 3（200 運航/日・評価 70 などが複数日）に届くかを記録する。
 * 結果は ~/workspace/test/tiers_t8_investment.json に日次で書く。
 */
const MAX_DAYS = 45;
const OUT = '/home/hatch/workspace/test/tiers_t8_investment.json';

function investedLayout(): AirportLayout {
  let layout = createSampleAirport();
  const first = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
  const originalAreas = Object.values(layout.terminalAreas).filter((a) => a.terminalId === first);
  // 誘導路 B を東へ延長し、スポットを 10 追加
  layout = must(addTaxiwayPath(layout, [{ x: 95, y: 41 }, { x: 145, y: 41 }], { widthClass: 'L', name: 'B-ext' })).layout;
  const newStands: string[] = [];
  for (let i = 0; i < 10; i++) {
    const r = must(placeStand(layout, { x: 98 + i * 5, y: 42 }, 'M', 180, 'operational', `E${i + 1}`));
    layout = r.layout;
    newStands.push(r.created[0]!);
  }
  // 第 2 ターミナル（第 1 のエリア構成を複写）とゲート 10
  layout = must(placeFacility(layout, 'terminal', { x: 100, y: 49 }, { w: 48, h: 8, name: 'ターミナル2', props: { levels: 2 } })).layout;
  const second = Object.values(layout.facilities).filter((f) => f.kind === 'terminal').at(-1)!.id;
  for (const area of originalAreas) {
    layout = must(placeTerminalArea(layout, second, area.level, area.kind as TerminalAreaKind, { x: area.origin.x + 54, y: area.origin.y }, {
      w: area.w, h: area.h, name: `${area.name} 2`, props: structuredClone(area.props),
    })).layout;
  }
  for (let i = 0; i < 10; i++) {
    const r = must(placeFacility(layout, 'gate', { x: 100 + i * 5, y: 48 }, { props: { standId: newStands[i]!, connectedTo: second } }));
    layout = r.layout;
  }
  // GSE 基地と整備を増強（投資）
  for (const f of Object.values(layout.facilities)) {
    if (f.kind === 'gseBase') {
      layout = must(updateEntity(layout, f.id, { props: { ...f.props, staff: 40, tugs: 4, beltLoaders: 6, baggageTractors: 6, fuelTrucks: 4, cateringTrucks: 4, cleaningVans: 4 } })).layout;
    }
    if (f.kind === 'maintenance') {
      layout = must(updateEntity(layout, f.id, { props: { ...f.props, engineers: 6 } })).layout;
    }
  }
  return layout;
}

describe('5-20 T8 投資ありプレイの格到達可能性', () => {
  it('投資済みレイアウト + 大都市圏 + 貪欲受諾で格 3 に届く日数を記録する', { timeout: 3000000 }, () => {
    const layout = investedLayout();
    const operable = new Set<string>(operableTypes(createContext(layout)));
    const c = createCareerCompany('t8-invest');
    startGame(c, defaultGame());
    c.city = defaultCity('metropolitan');
    const sim = createSimulation(layout, { company: c });
    const log: Record<string, unknown>[] = [];
    let reachedTier3: number | null = null;
    for (let d = 0; d < MAX_DAYS; d++) {
      const target = (Math.floor(sim.state.now / DAY_SEC) + 1) * DAY_SEC;
      while (sim.state.now <= target) stepSimulation(sim);
      const v = checkInvariants(sim);
      if (v.length > 0) throw new Error(`day=${c.day}: ${v.join(' / ')}`);
      for (const k of contractsOf(c, 'offered')) {
        if (operable.has(k.typeId)) acceptOffer(c, k.id, true);
      }
      const r = c.reports[c.reports.length - 1]!;
      const tier = c.goals?.tier ?? 0;
      if (tier >= 3 && reachedTier3 === null) reachedTier3 = log.length + 1;
      log.push({
        day: c.day, tier, movements: r.kpi.movements, pax: r.kpi.paxDeparted + r.kpi.paxArrived,
        rating: Math.round(c.rating * 10) / 10, contracts: contractsOf(c, 'active').length,
        cash: Math.round(c.cash), missedPax: r.kpi.missedPax,
      });
      fs.writeFileSync(OUT, JSON.stringify({ reachedTier3, log }, null, 1));
      if (tier >= 3) break;
    }
    expect(reachedTier3).not.toBeNull();
  });
});
