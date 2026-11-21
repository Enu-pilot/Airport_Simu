import { describe, expect, it } from 'vitest';
import { bulkPlaceBoardingBridges, placeBoardingBridge, placeFacility, placeStand } from '../../src/core/layout/operations';
import {
  boardingProfile,
  explicitPbbForGate,
  hasExplicitPbb,
  pbbForGate,
} from '../../src/core/model/boardingBridge';
import { constructionCost, facilityValue, layoutValue, scaleFactor } from '../../src/core/economy/construction';
import { BALANCE } from '../../src/core/economy/balance';
import { createSandboxCompany } from '../../src/core/economy/company';
import { createHistory } from '../../src/core/editor/history';
import { bulkAttachBoardingBridges, editorStore } from '../../src/editor/store';
import type { AirportLayout, Facility, SizeClass, Stand } from '../../src/core/model/types';
import type { Tile } from '../../src/core/geometry/vec';
import { emptyLayout, must } from './helpers';

/**
 * 全コンタクトゲートへの PBB 一括付与（bulkPlaceBoardingBridges）。
 * 合成のみのゲートに明示 tunnel1 を付け、既存の明示 PBB・バスゲート・
 * スポット無しゲートは付けない。費用は中立（jetBridge 上乗せ 150,000cr =
 * tunnel1 建設費）で、S/M 区分の搭乗プロファイルは合成時と等価。
 * 仕様差: 実データ化後は大型機（シル高 4.7m > tunnel1 上限 4.6m）に
 * 速度ペナルティが掛かるようになる（明示 PBB のみ対象という H の確定仕様）。
 */

interface GateSpec {
  standPos: Tile;
  standSize?: SizeClass;
  gatePos: Tile;
  jetBridge?: boolean;
  bus?: boolean;
}

interface Built {
  layout: AirportLayout;
  stands: Stand[];
  gates: Facility[];
}

function buildLayout(specs: GateSpec[]): Built {
  let l = emptyLayout(80, 60);
  l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 70, h: 50 })).layout;
  l = must(placeFacility(l, 'terminal', { x: 8, y: 8 }, { props: { levels: 2 } })).layout;
  const stands: Stand[] = [];
  const gates: Facility[] = [];
  for (const spec of specs) {
    const s = must(placeStand(l, spec.standPos, spec.standSize ?? 'M', 0));
    l = s.layout;
    stands.push(l.stands[s.created[0]!]!);
    const stand = stands[stands.length - 1]!;
    const g = must(
      placeFacility(l, 'gate', spec.gatePos, {
        props: {
          standId: stand.id,
          jetBridge: spec.jetBridge ?? true,
          ...(spec.bus ? { boardingMode: 'bus', jetBridge: false } : {}),
        },
      }),
    );
    l = g.layout;
    gates.push(l.facilities[g.created[0]!]!);
  }
  return { layout: l, stands, gates };
}

/** スポット無しゲート（fac_172 相当）を足す。配置位置は全スポットから 3 タイル以上離す */
function addStandaloneGate(layout: AirportLayout, pos: Tile): { layout: AirportLayout; gate: Facility } {
  const g = must(placeFacility(layout, 'gate', pos, { props: { jetBridge: true } }));
  const gate = g.layout.facilities[g.created[0]!]!;
  expect(gate.props.standId).toBeNull();
  return { layout: g.layout, gate };
}

describe('一括付与: 未付着→付着', () => {
  it('合成のみのゲートに明示 tunnel1（main / operational）が付く', () => {
    const { layout, stands, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, standSize: 'L', gatePos: { x: 18, y: 18 } }]);
    const gate = gates[0]!;
    expect(pbbForGate(layout, gate.id)[0]).toMatchObject({ synthesized: true, bridgeType: 'tunnel1' });
    const r = bulkPlaceBoardingBridges(layout);
    expect(r.attachedGateIds).toEqual([gate.id]);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([]);
    const pbb = r.layout.facilities[r.created[0]!]!;
    expect(pbb.kind).toBe('boardingBridge');
    expect(pbb.buildState).toBe('operational');
    expect(pbb.props).toMatchObject({ gateId: gate.id, standId: stands[0]!.id, bridgeType: 'tunnel1', deck: 'main' });
    expect(hasExplicitPbb(r.layout, gate.id)).toBe(true);
    const units = pbbForGate(r.layout, gate.id);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ synthesized: false, bridgeType: 'tunnel1', deck: 'main' });
  });

  it('冪等性: 2回目は付着 0件で、レイアウトは変わらない', () => {
    const { layout, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const first = bulkPlaceBoardingBridges(layout);
    expect(first.attachedGateIds).toHaveLength(1);
    const second = bulkPlaceBoardingBridges(first.layout);
    expect(second.attachedGateIds).toEqual([]);
    expect(second.created).toEqual([]);
    expect(second.skipped).toEqual([{ gateId: gates[0]!.id, reason: 'alreadyAttached' }]);
    expect(second.layout).toEqual(first.layout);
  });
});

describe('一括付与: スキップ', () => {
  it('バスゲートは付けない', () => {
    const { layout, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 }, bus: true }]);
    const r = bulkPlaceBoardingBridges(layout);
    expect(r.attachedGateIds).toEqual([]);
    expect(r.skipped).toEqual([{ gateId: gates[0]!.id, reason: 'bus' }]);
    expect(Object.values(r.layout.facilities).some((f) => f.kind === 'boardingBridge')).toBe(false);
  });

  it('既存の明示 PBB は不変（2本目を作らない・型式/デッキを変えない）', () => {
    const { layout, stands, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const gate = gates[0]!;
    const l1 = must(placeBoardingBridge(layout, gate.id, stands[0]!.id, { bridgeType: 'tunnel2' })).layout;
    const r = bulkPlaceBoardingBridges(l1);
    expect(r.attachedGateIds).toEqual([]);
    expect(r.skipped).toEqual([{ gateId: gate.id, reason: 'alreadyAttached' }]);
    const units = explicitPbbForGate(r.layout, gate.id);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ bridgeType: 'tunnel2', deck: 'main', synthesized: false });
  });

  it('上デッキだけ明示 PBB があるゲートには main の tunnel1 を付ける（上は不変）', () => {
    const { layout, stands, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const gate = gates[0]!;
    const l1 = must(placeBoardingBridge(layout, gate.id, stands[0]!.id, { bridgeType: 'tunnel2Upper', deck: 'upper' })).layout;
    const r = bulkPlaceBoardingBridges(l1);
    expect(r.attachedGateIds).toEqual([gate.id]);
    const units = explicitPbbForGate(r.layout, gate.id);
    expect(units).toHaveLength(2);
    expect(units.find((u) => u.deck === 'upper')).toMatchObject({ bridgeType: 'tunnel2Upper' });
    expect(units.find((u) => u.deck === 'main')).toMatchObject({ bridgeType: 'tunnel1' });
  });

  it('スポット紐付けのないゲートは理由付きでスキップする', () => {
    const built = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const { layout, gate: lonely } = addStandaloneGate(built.layout, { x: 60, y: 50 });
    const r = bulkPlaceBoardingBridges(layout);
    expect(r.attachedGateIds).toEqual([built.gates[0]!.id]);
    expect(r.skipped).toEqual([{ gateId: lonely.id, reason: 'noStand' }]);
  });

  it('jetBridge 無効のコンタクトゲートは付けない（タラップのまま・費用中立の対象外）', () => {
    const { layout, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 }, jetBridge: false }]);
    const gate = gates[0]!;
    const r = bulkPlaceBoardingBridges(layout);
    expect(r.attachedGateIds).toEqual([]);
    expect(r.skipped).toEqual([{ gateId: gate.id, reason: 'noJetBridge' }]);
    const p = boardingProfile(r.layout, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, boardSecPerPax: 5, deplanePerMin: 12 });
  });

  it('混在レイアウトの集計: 付着とスキップの内訳が正しい', () => {
    const built = buildLayout([
      { standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } },
      { standPos: { x: 20, y: 30 }, gatePos: { x: 18, y: 28 } },
      { standPos: { x: 20, y: 40 }, gatePos: { x: 18, y: 38 }, bus: true },
      { standPos: { x: 40, y: 20 }, gatePos: { x: 38, y: 18 }, jetBridge: false },
    ]);
    const [a, b, busGate, stairsGate] = built.gates;
    // b には先に明示 tunnel2 を付けておく
    let l = must(placeBoardingBridge(built.layout, b!.id, built.stands[1]!.id, { bridgeType: 'tunnel2' })).layout;
    const added = addStandaloneGate(l, { x: 60, y: 50 });
    l = added.layout;
    const r = bulkPlaceBoardingBridges(l);
    expect(r.attachedGateIds).toEqual([a!.id]);
    expect(r.created).toHaveLength(1);
    expect(r.skipped).toEqual([
      { gateId: b!.id, reason: 'alreadyAttached' },
      { gateId: busGate!.id, reason: 'bus' },
      { gateId: stairsGate!.id, reason: 'noJetBridge' },
      { gateId: added.gate.id, reason: 'noStand' },
    ]);
    expect(Object.values(r.layout.facilities).filter((f) => f.kind === 'boardingBridge')).toHaveLength(2);
  });
});

describe('一括付与: 搭乗プロファイルの等価性と仕様差', () => {
  it('S/M 区分: 合成 tunnel1 と明示 tunnel1 は共に 3.0秒/人・20人/分', () => {
    const { layout, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const gate = gates[0]!;
    for (const size of ['S', 'M'] as const) {
      const before = boardingProfile(layout, gate.id, { size, doubleDeck: false });
      expect(before).toMatchObject({ usesBridge: true, source: 'legacy', boardSecPerPax: 3, deplanePerMin: 20, sillOver: false });
    }
    const r = bulkPlaceBoardingBridges(layout);
    for (const size of ['S', 'M'] as const) {
      const after = boardingProfile(r.layout, gate.id, { size, doubleDeck: false });
      expect(after).toMatchObject({ usesBridge: true, source: 'explicit', boardSecPerPax: 3, deplanePerMin: 20, sillOver: false });
    }
  });

  it('L（大型機）: 合成時はペナルティなし、明示 tunnel1 ではシル高ペナルティが掛かる', () => {
    const { layout, gates } = buildLayout([{ standPos: { x: 20, y: 20 }, standSize: 'L', gatePos: { x: 18, y: 18 } }]);
    const gate = gates[0]!;
    const before = boardingProfile(layout, gate.id, { size: 'L', doubleDeck: false });
    expect(before).toMatchObject({ usesBridge: true, source: 'legacy', boardSecPerPax: 3, deplanePerMin: 20, sillOver: false });
    const r = bulkPlaceBoardingBridges(layout);
    const after = boardingProfile(r.layout, gate.id, { size: 'L', doubleDeck: false });
    expect(after).toMatchObject({ usesBridge: true, source: 'explicit', boardSecPerPax: 4, deplanePerMin: 16, sillOver: true });
  });
});

describe('一括付与: 建設費の中立性', () => {
  it('資産額は不変（ゲート側の上乗せ 150,000cr が PBB 側に移るだけ）', () => {
    const { layout, gates } = buildLayout([
      { standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } },
      { standPos: { x: 20, y: 30 }, gatePos: { x: 18, y: 28 } },
      { standPos: { x: 20, y: 40 }, gatePos: { x: 18, y: 38 } },
    ]);
    const r = bulkPlaceBoardingBridges(layout);
    expect(r.attachedGateIds).toHaveLength(3);
    expect(layoutValue(r.layout)).toBe(layoutValue(layout));
    // 内訳: ゲート側の上乗せ 150,000cr が外れ、PBB 側に同額が移る
    for (const gate of gates) {
      expect(facilityValue(r.layout.facilities[gate.id]!, r.layout)).toBe(facilityValue(layout.facilities[gate.id]!, layout) - 150_000);
    }
    for (const id of r.created) {
      expect(facilityValue(r.layout.facilities[id]!, r.layout)).toBe(150_000);
    }
  });

  it('注意: constructionCost(before, after) は 0 にならない（払い戻し率の非対称性）', () => {
    // 増えた分（PBB 150,000cr）は全額、減った分（ゲートの上乗せ −150,000cr）は
    // 払い戻し率 25% でしか戻らないため、1ゲートあたり 112,500cr × 規模係数が
    // 請求される計算になる。資産額は不変なので、ストア側は明示的に 0 で精算する。
    const { layout } = buildLayout([
      { standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } },
      { standPos: { x: 20, y: 30 }, gatePos: { x: 18, y: 28 } },
      { standPos: { x: 20, y: 40 }, gatePos: { x: 18, y: 38 } },
    ]);
    const r = bulkPlaceBoardingBridges(layout);
    const expected = Math.round(3 * 150_000 * (1 - BALANCE.construction.refundRate) * scaleFactor(layout));
    expect(expected).toBeGreaterThan(0);
    expect(constructionCost(layout, r.layout)).toBe(expected);
  });
});

describe('一括付与: エディタ反映（専用アクション）', () => {
  it('履歴1件として直接コミットされ、資金は変わらず、PBB は運用中のまま', () => {
    const { layout } = buildLayout([
      { standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } },
      { standPos: { x: 20, y: 30 }, gatePos: { x: 18, y: 28 } },
      { standPos: { x: 20, y: 40 }, gatePos: { x: 18, y: 38 } },
    ]);
    const company = createSandboxCompany();
    const cashBefore = company.cash;
    editorStore.setState({ history: createHistory(layout), company, mode: 'build', charges: { past: [], future: [] } });
    bulkAttachBoardingBridges();
    const s = editorStore.getState();
    expect(s.history.past).toHaveLength(1);
    expect(s.company.cash).toBe(cashBefore);
    expect(s.charges.past).toEqual([0]);
    const pbbs = Object.values(s.history.present.facilities).filter((f) => f.kind === 'boardingBridge');
    expect(pbbs).toHaveLength(3);
    expect(pbbs.every((f) => f.buildState === 'operational')).toBe(true);
  });

  it('運航中は拒否され、レイアウトも履歴も変わらない', () => {
    const { layout } = buildLayout([{ standPos: { x: 20, y: 20 }, gatePos: { x: 18, y: 18 } }]);
    const company = createSandboxCompany();
    editorStore.setState({ history: createHistory(layout), company, mode: 'operate', charges: { past: [], future: [] } });
    bulkAttachBoardingBridges();
    const s = editorStore.getState();
    expect(s.history.past).toHaveLength(0);
    expect(s.history.present).toBe(layout);
    expect(Object.values(s.history.present.facilities).some((f) => f.kind === 'boardingBridge')).toBe(false);
  });
});
