import { describe, expect, it } from 'vitest';
import { placeBoardingBridge, placeFacility, placeStand, updateEntity } from '../../src/core/layout/operations';
import { standEntry } from '../../src/core/layout/footprint';
import { chebyshevDistance } from '../../src/core/geometry/vec';
import {
  boardingProfile,
  explicitPbbForGate,
  hasExplicitPbb,
  pbbForGate,
} from '../../src/core/model/boardingBridge';
import { PBB_TYPES } from '../../src/core/model/catalog';
import { analyzeLayout } from '../../src/core/validation/validate';
import { buildProject, formatVersionOf, serializeProject, validateProject } from '../../src/core/io/project';
import { createSandboxCompany } from '../../src/core/economy/company';
import { facilityValue, layoutItems } from '../../src/core/economy/construction';
import { checkGate } from '../../src/core/aircraft/compat';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import type { AirportLayout, Facility, SizeClass, Stand } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * 機能H: 搭乗ゲートと PBB（搭乗橋）の分離。設計は design-GHIJ-detail.md §H が正本。
 * 受入条件: 明示 PBB の無い既存レイアウトでは、互換合成（jetBridge → tunnel1 相当）に
 * より搭乗/降機速度が従来定数（3 秒/人・20 人/分、タラップ 5 秒/人・12 人/分）と
 * 完全一致し、運航結果が変わらないこと。
 */

interface Fixture {
  layout: AirportLayout;
  stand: Stand;
  gate: Facility;
}

function fixture(opts: { size?: SizeClass; jetBridge?: boolean; bus?: boolean } = {}): Fixture {
  let l = emptyLayout(80, 60);
  l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 40, h: 30 })).layout;
  l = must(placeStand(l, { x: 20, y: 20 }, opts.size ?? 'L', 0)).layout;
  const stand = Object.values(l.stands)[0]!;
  l = must(placeFacility(l, 'terminal', { x: 8, y: 8 }, { props: { levels: 2 } })).layout;
  l = must(placeFacility(l, 'gate', { x: 18, y: 18 }, {
    props: {
      standId: stand.id,
      jetBridge: opts.jetBridge ?? true,
      ...(opts.bus ? { boardingMode: 'bus', jetBridge: false } : {}),
    },
  })).layout;
  const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
  return { layout: l, stand, gate };
}

const codesFor = (layout: AirportLayout, id: string): string[] =>
  analyzeLayout(layout).byTarget[id]?.map((i) => i.code) ?? [];

describe('H2: 互換合成（既存ゲートは全部 PBB に置き換わる）', () => {
  it('jetBridge 有効のコンタクトゲートは tunnel1 相当（main）が合成される', () => {
    const { layout, gate } = fixture();
    const units = pbbForGate(layout, gate.id);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ bridgeType: 'tunnel1', deck: 'main', synthesized: true, facilityId: null });
    expect(explicitPbbForGate(layout, gate.id)).toHaveLength(0);
    expect(hasExplicitPbb(layout, gate.id)).toBe(false);
  });

  it('合成ゲートの搭乗プロファイルは従来定数と完全一致する（全区分・2階建て機）', () => {
    const { layout, gate } = fixture();
    for (const size of ['S', 'M', 'L'] as const) {
      const p = boardingProfile(layout, gate.id, { size, doubleDeck: false });
      expect(p.usesBridge).toBe(true);
      expect(p.source).toBe('legacy');
      expect(p.boardSecPerPax).toBe(3);
      expect(p.deplanePerMin).toBe(20);
      expect(p.sillOver).toBe(false);
    }
    const dd = boardingProfile(layout, gate.id, { size: 'L', doubleDeck: true });
    expect(dd.boardSecPerPax).toBe(3);
    expect(dd.deplanePerMin).toBe(20);
    expect(dd.decks).toEqual(['main']);
  });

  it('jetBridge 無効のゲートは橋なし（タラップ値）', () => {
    const { layout, gate } = fixture({ jetBridge: false });
    expect(pbbForGate(layout, gate.id)).toHaveLength(0);
    const p = boardingProfile(layout, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, source: 'none', reason: 'noBridge', boardSecPerPax: 5, deplanePerMin: 12 });
  });

  it('バスゲートは橋を使わない', () => {
    const { layout, gate } = fixture({ bus: true });
    const p = boardingProfile(layout, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, reason: 'bus', boardSecPerPax: 5, deplanePerMin: 12 });
  });

  it('tunnel1 の型式パラメータは従来定数と一致する（等価性の根拠）', () => {
    expect(PBB_TYPES.tunnel1.boardSecPerPax.main).toBe(3);
    expect(PBB_TYPES.tunnel1.deplanePerMin.main).toBe(20);
    expect(PBB_TYPES.tunnel1.cost).toBe(150_000);
  });
});

describe('H1/H5: 配置（placeBoardingBridge）', () => {
  it('スポット入口の近傍に自動配置され、検証エラーにならない', () => {
    const { layout, stand, gate } = fixture();
    const r = placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' });
    const placed = must(r);
    const pbb = placed.layout.facilities[placed.created[0]!]!;
    expect(pbb.kind).toBe('boardingBridge');
    expect(pbb.props).toMatchObject({ gateId: gate.id, standId: stand.id, bridgeType: 'tunnel2', deck: 'main' });
    expect(chebyshevDistance([pbb.origin], [standEntry(stand)])).toBeLessThanOrEqual(2);
    const codes = codesFor(placed.layout, pbb.id);
    expect(codes).not.toContain('PBB_NOT_ADJACENT');
    expect(codes).not.toContain('PBB_GATE_MISMATCH');
    expect(codes).not.toContain('OVERLAP');
  });

  it('ゲートとスポットの対応が違うと配置できない', () => {
    const { layout, gate } = fixture();
    let l = must(placeStand(layout, { x: 30, y: 40 }, 'M', 0)).layout;
    const other = Object.values(l.stands).find((s) => s.id !== gate.props.standId)!;
    expect(placeBoardingBridge(l, gate.id, other.id).ok).toBe(false);
    expect(placeBoardingBridge(l, 'fac_missing', String(gate.props.standId)).ok).toBe(false);
    l = layout;
    expect(placeBoardingBridge(l, gate.id, 'std_missing').ok).toBe(false);
  });

  it('同じデッキは2基置けない。上デッキは別基として置ける', () => {
    const { layout, stand, gate } = fixture();
    const l1 = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'main' })).layout;
    expect(placeBoardingBridge(l1, gate.id, stand.id, { bridgeType: 'tunnel1', deck: 'main' }).ok).toBe(false);
    const l2 = must(placeBoardingBridge(l1, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'upper' })).layout;
    expect(explicitPbbForGate(l2, gate.id)).toHaveLength(2);
  });
});

describe('ユーザー指定1: 本数設定（1本/2本）と大型機の扱い', () => {
  it('明示 PBB があると合成より優先され、型式の速度になる（2本 = tunnel2）', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    const units = pbbForGate(l, gate.id);
    expect(units).toHaveLength(1);
    expect(units[0]!.synthesized).toBe(false);
    const p = boardingProfile(l, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: true, source: 'explicit', boardSecPerPax: 2.4, deplanePerMin: 24, sillOver: false });
  });

  it('1本（tunnel1）でも大型機は運用できるが、ドア高超過で速度ペナルティが掛かる', () => {
    const { layout, stand, gate } = fixture({ size: 'L' });
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel1' })).layout;
    const p = boardingProfile(l, gate.id, { size: 'L', doubleDeck: false });
    expect(p.usesBridge).toBe(true);
    expect(p.sillOver).toBe(true);
    expect(p.boardSecPerPax).toBe(4);
    expect(p.deplanePerMin).toBe(16);
    // 中型機では範囲内（ペナルティなし）
    const pm = boardingProfile(l, gate.id, { size: 'M', doubleDeck: false });
    expect(pm).toMatchObject({ boardSecPerPax: 3, deplanePerMin: 20, sillOver: false });
  });

  it('2本（tunnel2）なら大型機でもペナルティなく速い', () => {
    const { layout, stand, gate } = fixture({ size: 'L' });
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    const p = boardingProfile(l, gate.id, { size: 'L', doubleDeck: false });
    expect(p).toMatchObject({ boardSecPerPax: 2.4, deplanePerMin: 24, sillOver: false });
  });

  it('2階建て機は主+上の2系統が並行に効く（tunnel2Upper）', () => {
    const { layout, stand, gate } = fixture({ size: 'L' });
    let l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'main' })).layout;
    l = must(placeBoardingBridge(l, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'upper' })).layout;
    const p = boardingProfile(l, gate.id, { size: 'L', doubleDeck: true });
    expect(p.decks).toEqual(['main', 'upper']);
    expect(p.boardSecPerPax).toBeCloseTo(1 / (1 / 2.2 + 1 / 3.0), 10);
    expect(p.deplanePerMin).toBe(52);
    // 通常機では上デッキは効かない
    const single = boardingProfile(l, gate.id, { size: 'L', doubleDeck: false });
    expect(single).toMatchObject({ boardSecPerPax: 2.2, deplanePerMin: 26 });
    expect(single.decks).toEqual(['main']);
  });

  it('主デッキの橋が無い（上だけ）ゲートは搭乗できない', () => {
    const { layout, stand, gate } = fixture({ size: 'L' });
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'upper' })).layout;
    const p = boardingProfile(l, gate.id, { size: 'L', doubleDeck: true });
    expect(p).toMatchObject({ usesBridge: false, reason: 'noMainDeck' });
  });

  it('建設中・計画中の明示 PBB は無効（合成にも戻らない）', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2', buildState: 'planned' })).layout;
    const p = boardingProfile(l, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, source: 'explicit', reason: 'notOperational', boardSecPerPax: 5, deplanePerMin: 12 });
  });
});

describe('H4: 検証コード', () => {
  it('PBB_GATE_MISMATCH: ゲートの standId と一致しない PBB', () => {
    const { layout, stand, gate } = fixture();
    const entry = standEntry(stand);
    const l = must(placeFacility(layout, 'boardingBridge', { x: entry.x + 1, y: entry.y }, {
      props: { gateId: gate.id, standId: 'std_missing', bridgeType: 'tunnel1', deck: 'main' },
    })).layout;
    const pbb = Object.values(l.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(codesFor(l, pbb.id)).toContain('PBB_GATE_MISMATCH');
  });

  it('PBB_NOT_ADJACENT: スポット入口から離れた PBB', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeFacility(layout, 'boardingBridge', { x: 60, y: 50 }, {
      props: { gateId: gate.id, standId: stand.id, bridgeType: 'tunnel1', deck: 'main' },
    })).layout;
    const pbb = Object.values(l.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(codesFor(l, pbb.id)).toContain('PBB_NOT_ADJACENT');
  });

  it('PBB_DECK_DUPLICATE: 同じデッキの PBB が複数あるゲート', () => {
    const { layout, stand, gate } = fixture();
    const entry = standEntry(stand);
    let l = must(placeFacility(layout, 'boardingBridge', { x: entry.x + 1, y: entry.y }, {
      props: { gateId: gate.id, standId: stand.id, bridgeType: 'tunnel1', deck: 'main' },
    })).layout;
    l = must(placeFacility(l, 'boardingBridge', { x: entry.x - 1, y: entry.y }, {
      props: { gateId: gate.id, standId: stand.id, bridgeType: 'tunnel2', deck: 'main' },
    })).layout;
    expect(codesFor(l, gate.id)).toContain('PBB_DECK_DUPLICATE');
  });

  it('PBB_SILL_RANGE: L スポットの tunnel1 に警告、tunnel2 には出ない', () => {
    const { layout, stand, gate } = fixture({ size: 'L' });
    const l1 = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel1' })).layout;
    const pbb1 = Object.values(l1.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(codesFor(l1, pbb1.id)).toContain('PBB_SILL_RANGE');
    const l2 = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    const pbb2 = Object.values(l2.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(codesFor(l2, pbb2.id)).not.toContain('PBB_SILL_RANGE');
  });

  it('PBB_LEGACY_OVERRIDDEN: 明示 PBB があるのに jetBridge が残っている', () => {
    const { layout, stand, gate } = fixture({ jetBridge: true });
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    expect(codesFor(l, gate.id)).toContain('PBB_LEGACY_OVERRIDDEN');
    const l2 = must(updateEntity(l, gate.id, { props: { jetBridge: false } })).layout;
    expect(codesFor(l2, gate.id)).not.toContain('PBB_LEGACY_OVERRIDDEN');
  });

  it('GATE_UPPER_DECK（compat）: upper の PBB があるゲートでは付かない', () => {
    // B747-400 は doubleDeck かつ codeF ではないため、L スポットでゲート判定が ok になる
    const a380 = AIRCRAFT_TYPES['B747-400']!;
    expect(a380.doubleDeck).toBe(true);
    expect(a380.codeF).toBe(false);
    const { layout, stand, gate } = fixture({ size: 'L' });
    // 従来（合成）: 付く
    expect(checkGate(a380, gate, layout).reasons).toContain('GATE_UPPER_DECK');
    // 主だけの明示 PBB: 付く（PBB 側の理由として読む）
    const lMain = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'main' })).layout;
    expect(checkGate(a380, lMain.facilities[gate.id]!, lMain).reasons).toContain('GATE_UPPER_DECK');
    // 主+上: 付かない
    const lBoth = must(placeBoardingBridge(lMain, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'upper' })).layout;
    expect(checkGate(a380, lBoth.facilities[gate.id]!, lBoth).reasons).not.toContain('GATE_UPPER_DECK');
  });
});

describe('地下ゲートの確定（G-U4 の解消）', () => {
  function undergroundGate(jetBridge: boolean) {
    let l = emptyLayout(80, 60);
    l = must(placeFacility(l, 'apron', { x: 5, y: 5 }, { w: 40, h: 30 })).layout;
    l = must(placeStand(l, { x: 20, y: 20 }, 'M', 0)).layout;
    const stand = Object.values(l.stands)[0]!;
    l = must(placeFacility(l, 'terminal', { x: 8, y: 8 }, { mapLevel: -1, props: { levels: 2, floorRangeMin: 0, floorRangeMax: 1 } })).layout;
    const terminal = Object.values(l.facilities).find((f) => f.kind === 'terminal')!;
    l = must(placeFacility(l, 'gate', { x: 10, y: 10 }, {
      parentFacilityId: terminal.id,
      floorIndex: 0,
      props: { standId: stand.id, jetBridge },
    })).layout;
    const gate = Object.values(l.facilities).find((f) => f.kind === 'gate')!;
    return { layout: l, stand, gate };
  }

  it('地下ゲートは sim で橋なし（タラップ値）になる', () => {
    const { layout, gate } = undergroundGate(true);
    const p = boardingProfile(layout, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, reason: 'underground', boardSecPerPax: 5, deplanePerMin: 12 });
    expect(codesFor(layout, gate.id)).toContain('GATE_UNDERGROUND_BRIDGE');
  });

  it('地下ゲートに明示 PBB がある場合（jetBridge 無効でも）警告が出て、橋は使えない', () => {
    const { layout, stand, gate } = undergroundGate(false);
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    expect(codesFor(l, gate.id)).toContain('GATE_UNDERGROUND_BRIDGE');
    const p = boardingProfile(l, gate.id, { size: 'M', doubleDeck: false });
    expect(p).toMatchObject({ usesBridge: false, reason: 'underground' });
  });
});

describe('ユーザー指定2 / H1: 保存形式（formatVersion 9）と往復保存', () => {
  const projectOf = (layout: AirportLayout) =>
    buildProject({ name: 'h', savedAt: '2026-11-20T00:00:00.000Z', layout, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });

  it('PBB を含まないファイルは版 9 を名乗らない（従来のゲートは合成で読める）', () => {
    const { layout, gate } = fixture();
    const p = projectOf(layout);
    expect(formatVersionOf(p)).toBeLessThan(9);
    expect(serializeProject(p)).not.toContain('boardingBridge');
    const v = validateProject(serializeProject(p), { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    // 読み込み後も合成で「PBB 付き」として扱える（= ユーザーの言う置き換え）
    const loadedGate = Object.values(v.project!.layout.facilities).find((f) => f.kind === 'gate')!;
    expect(loadedGate.id).toBe(gate.id);
    expect(pbbForGate(v.project!.layout, loadedGate.id)).toHaveLength(1);
  });

  it('明示 PBB を含むファイルは版 9 を名乗り、往復保存で PBB が実データとして残る', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2Upper', deck: 'main' })).layout;
    const p = projectOf(l);
    expect(formatVersionOf(p)).toBe(9);
    const text = serializeProject(p);
    expect(JSON.parse(text).formatVersion).toBe(9);
    const v = validateProject(text, { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(true);
    const pbb = Object.values(v.project!.layout.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(pbb).toBeDefined();
    expect(pbb.props).toMatchObject({ gateId: gate.id, standId: stand.id, bridgeType: 'tunnel2Upper', deck: 'main' });
  });

  it('版 8 以下を名乗るのに PBB を含むファイルは拒否される', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel1' })).layout;
    const p = projectOf(l);
    const tampered = JSON.stringify({ ...JSON.parse(serializeProject(p)), formatVersion: 8 });
    const v = validateProject(tampered, { fallbackCompany: createSandboxCompany() });
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toContain('搭乗橋');
  });
});

describe('H6: 建設費', () => {
  it('明示 PBB の建設費は型式表から取る', () => {
    const { layout, stand, gate } = fixture();
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel2' })).layout;
    const pbb = Object.values(l.facilities).find((f) => f.kind === 'boardingBridge')!;
    expect(facilityValue(pbb, l)).toBe(260_000);
    expect(facilityValue(pbb)).toBe(260_000);
  });

  it('jetBridge 上乗せは合成ゲートのみ（明示 PBB があるゲートでは二重取りしない）', () => {
    const { layout, stand, gate } = fixture({ jetBridge: true });
    const before = layoutItems(layout);
    const gateBefore = before[gate.id]!;
    const l = must(placeBoardingBridge(layout, gate.id, stand.id, { bridgeType: 'tunnel1' })).layout;
    const after = layoutItems(l);
    const pbb = Object.values(l.facilities).find((f) => f.kind === 'boardingBridge')!;
    // tunnel1 の費用 150,000 は PBB 側に移り、ゲート側の上乗せは消える（総額は不変）
    expect(after[pbb.id]).toBe(150_000);
    expect(after[gate.id]).toBe(gateBefore - 150_000);
  });
});
