import { describe, expect, it } from 'vitest';
import { floorDisplay, floorDisplayLabel } from '../../src/core/model/levels';
import {
  AIRCRAFT_TYPES,
  deckElevationForCode,
  requiredAircraftClearanceM,
  requiredClearanceForCode,
  type TypeTable,
} from '../../src/core/sim/aircraftTypes';
import { addTerminalTransitLink, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { analyzeLayout } from '../../src/core/validation/validate';
import { checkRunwayFields, exportLayout, importLayout, validateLayoutData } from '../../src/core/io/serialize';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout, must } from './helpers';

/**
 * J-1（階層定義の統一）:
 * - floorDisplay / floorDisplayLabel の統一表記
 * - crossingMaxCode の宣言方式（requiredClearanceForCode / deckElevationForCode）
 * - 宣言なしリンクの生成・検証が従来と完全一致すること
 * - crossingMaxCode の旧セーブ互換（欠落で読み込める）と保存検証
 */

describe('floorDisplay: 実効地図階層の統一表記', () => {
  it('地上（階層 0）は 1F・床 0m', () => {
    expect(floorDisplay(0)).toEqual({ building: '1F', map: '+0', floorM: 0 });
    expect(floorDisplayLabel(0)).toBe('1F（床 0m／地図階層 +0）');
  });

  it('階層 +3 は 4F・床 +18m（設計書の例どおり）', () => {
    expect(floorDisplay(3)).toEqual({ building: '4F', map: '+3', floorM: 18 });
    expect(floorDisplayLabel(3)).toBe('4F（床 +18m／地図階層 +3）');
  });

  it('階層 −1 は B1F・床 −6m（設計書の例どおり）', () => {
    expect(floorDisplay(-1)).toEqual({ building: 'B1F', map: '-1', floorM: -6 });
    expect(floorDisplayLabel(-1)).toBe('B1F（床 -6m／地図階層 -1）');
  });

  it('階層 −3 は B3F・床 −18m', () => {
    expect(floorDisplayLabel(-3)).toBe('B3F（床 -18m／地図階層 -3）');
  });
});

describe('requiredClearanceForCode / deckElevationForCode: 宣言コードからの導出', () => {
  it('C: 最大尾翼高 12.55m（B737）+ 余裕 3m = 15.55m、デッキは 18m = 4F相当', () => {
    expect(requiredClearanceForCode('C')).toBeCloseTo(15.55);
    expect(deckElevationForCode('C')).toBe(18);
  });

  it('E: 最大尾翼高 19.4m（B747-400）+ 余裕 3m = 22.4m、デッキは 24m = 5F相当', () => {
    expect(requiredClearanceForCode('E')).toBeCloseTo(22.4);
    expect(deckElevationForCode('E')).toBe(24);
  });

  it('F: 最大尾翼高 24.1m（A380）+ 余裕 3m = 27.1m、デッキは 30m = 6F相当', () => {
    expect(requiredClearanceForCode('F')).toBeCloseTo(27.1);
    expect(deckElevationForCode('F')).toBe(30);
  });

  it('区分内に高さ既知の機種が無ければ全体基準と同じ保守値（33m / 36m）', () => {
    const unknownOnly: TypeTable = {
      probe: { ...AIRCRAFT_TYPES['B737-800']!, id: 'probe', heightM: null },
    };
    expect(requiredClearanceForCode('C', unknownOnly)).toBe(requiredAircraftClearanceM());
    expect(deckElevationForCode('C', unknownOnly)).toBe(36);
    expect(requiredClearanceForCode('F', {})).toBe(33);
    expect(deckElevationForCode('F', {})).toBe(36);
  });

  it('高さ不明の汎用機材は区分の最大に数えない（wide300 が E を保守値へ引っ張らない）', () => {
    // wide300 は翼幅 61m = コード E だが heightM は未設定。数えると E は 33m になってしまう
    expect(AIRCRAFT_TYPES.wide300!.heightM).toBeNull();
    expect(requiredClearanceForCode('E')).toBeLessThan(requiredAircraftClearanceM());
  });
});

function twoTerminals(): { layout: AirportLayout; a1: string; a2: string } {
  let layout = emptyLayout(80, 60);
  const placedT1 = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { name: 'Terminal A' }));
  layout = placedT1.layout;
  const t1 = placedT1.created[0]!;
  layout = must(placeFacility(layout, 'terminal', { x: 35, y: 2 }, { name: 'Terminal B' })).layout;
  const t2 = Object.values(layout.facilities).find((f) => f.name === 'Terminal B')!.id;
  const placedA = must(placeTerminalArea(layout, t1, 0, 'departureLobby', { x: 2, y: 2 }));
  layout = placedA.layout;
  const a1 = placedA.created[0]!;
  layout = must(placeTerminalArea(layout, t2, 0, 'departureLobby', { x: 35, y: 2 })).layout;
  const a2 = Object.values(layout.terminalAreas).find((a) => a.terminalId === t2)!.id;
  return { layout, a1, a2 };
}

const linkCodes = (l: AirportLayout, linkId: string) => (analyzeLayout(l).byTarget[linkId] ?? []).map((i) => i.code);

describe('addTerminalTransitLink: crossingMaxCode の生成時検証と既定値', () => {
  it('宣言なしは従来どおり: 標高 36m・クリアランス 33m で、crossingMaxCode は保存されない', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60, allowedZones: ['departure'],
    }));
    const link = r.layout.terminalLinks![r.created[0]!]!;
    expect(link.elevationM).toBe(36);
    expect(link.aircraftClearanceM).toBe(33);
    expect(link.crossingMaxCode).toBeUndefined();
    expect('crossingMaxCode' in link).toBe(false);
  });

  it('宣言 C/E/F の既定値は宣言から導かれる（18/24/30m）', () => {
    const { layout, a1, a2 } = twoTerminals();
    const cases = [
      ['C', 18, 15.55],
      ['E', 24, 22.4],
      ['F', 30, 27.1],
    ] as const;
    for (const [code, deck, clearance] of cases) {
      const r = must(addTerminalTransitLink(layout, {
        kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
        crossingMaxCode: code, allowedZones: ['departure'],
      }));
      const link = r.layout.terminalLinks![r.created[0]!]!;
      expect(link.crossingMaxCode).toBe(code);
      expect(link.elevationM).toBe(deck);
      expect(link.aircraftClearanceM).toBeCloseTo(clearance);
    }
  });

  it('宣言 E で標高をデッキ床高（24m）未満に手入力すると弾かれる', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'E', elevationM: 23, aircraftClearanceM: 23, allowedZones: ['departure'],
    });
    expect(r.ok).toBe(false);
  });

  it('宣言 C でクリアランスを宣言基準（15.55m）未満にすると弾かれる', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'C', elevationM: 36, aircraftClearanceM: 10, allowedZones: ['departure'],
    });
    expect(r.ok).toBe(false);
  });

  it('宣言があっても全体基準より高い手入力は通る', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'C', elevationM: 36, aircraftClearanceM: 33, allowedZones: ['departure'],
    });
    expect(r.ok).toBe(true);
  });

  it('宣言なしで全体基準未満のクリアランスは従来どおり弾かれる', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      elevationM: 36, aircraftClearanceM: 20, allowedZones: ['departure'],
    });
    expect(r.ok).toBe(false);
  });

  it('C/E/F 以外の宣言値は弾かれる', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'D' as never, allowedZones: ['departure'],
    });
    expect(r.ok).toBe(false);
  });
});

describe('TERMINAL_LINK_CLEARANCE: 宣言基準と従来一致', () => {
  it('宣言なしリンクは従来どおり: 既定値では出ず、クリアランスを潰すと出る', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60, allowedZones: ['departure'],
    }));
    const linkId = r.created[0]!;
    expect(linkCodes(r.layout, linkId)).not.toContain('TERMINAL_LINK_CLEARANCE');
    const broken: AirportLayout = {
      ...r.layout,
      terminalLinks: { ...r.layout.terminalLinks, [linkId]: { ...r.layout.terminalLinks![linkId]!, aircraftClearanceM: 1 } },
    };
    expect(linkCodes(broken, linkId)).toContain('TERMINAL_LINK_CLEARANCE');
  });

  it('宣言 C の既定値リンクは検証を通る（全体基準 33m 未満でも宣言基準で判定）', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'C', allowedZones: ['departure'],
    }));
    expect(linkCodes(r.layout, r.created[0]!)).not.toContain('TERMINAL_LINK_CLEARANCE');
  });

  it('宣言 C でクリアランスを宣言基準未満に潰すと出る', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'C', allowedZones: ['departure'],
    }));
    const linkId = r.created[0]!;
    const broken: AirportLayout = {
      ...r.layout,
      terminalLinks: { ...r.layout.terminalLinks, [linkId]: { ...r.layout.terminalLinks![linkId]!, aircraftClearanceM: 10 } },
    };
    expect(linkCodes(broken, linkId)).toContain('TERMINAL_LINK_CLEARANCE');
  });

  it('宣言 E で標高がデッキ床高（24m）未満だと、クリアランスを満たしても出る', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'E', allowedZones: ['departure'],
    }));
    const linkId = r.created[0]!;
    // クリアランス 23m は宣言基準 22.4m を満たすが、標高 23m はデッキ床高 24m 未満
    const lowered: AirportLayout = {
      ...r.layout,
      terminalLinks: { ...r.layout.terminalLinks, [linkId]: { ...r.layout.terminalLinks![linkId]!, aircraftClearanceM: 23, elevationM: 23 } },
    };
    expect(linkCodes(lowered, linkId)).toContain('TERMINAL_LINK_CLEARANCE');
  });
});

describe('crossingMaxCode: 保存と旧セーブ互換', () => {
  it('宣言つきリンクは往復で保持され、保存検証も通る', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      crossingMaxCode: 'F', allowedZones: ['departure'],
    }));
    const json = exportLayout(r.layout);
    const data = (JSON.parse(json) as { layout: AirportLayout }).layout;
    expect(validateLayoutData(data)).toEqual([]);
    expect(checkRunwayFields(data, 'test').filter((e) => e.includes('crossingMaxCode'))).toEqual([]);
    const restored = importLayout(json);
    expect(Object.values(restored.terminalLinks!)[0]!.crossingMaxCode).toBe('F');
  });

  it('crossingMaxCode の無い旧形式データはそのまま読み込める', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60, allowedZones: ['departure'],
    }));
    const file = JSON.parse(exportLayout(r.layout)) as { layout: { terminalLinks: Record<string, Record<string, unknown>> } };
    expect(Object.values(file.layout.terminalLinks)[0]).not.toHaveProperty('crossingMaxCode');
    expect(validateLayoutData(file.layout)).toEqual([]);
    const restored = importLayout(JSON.stringify(file));
    expect(Object.values(restored.terminalLinks!)[0]!.crossingMaxCode).toBeUndefined();
  });

  it('crossingMaxCode の不正値は保存検証で弾かれる', () => {
    const { layout, a1, a2 } = twoTerminals();
    const r = must(addTerminalTransitLink(layout, {
      kind: 'elevatedWalkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60, allowedZones: ['departure'],
    }));
    const file = JSON.parse(exportLayout(r.layout)) as { layout: { terminalLinks: Record<string, Record<string, unknown>> } };
    Object.values(file.layout.terminalLinks)[0]!.crossingMaxCode = 'D';
    const errors = checkRunwayFields(file.layout as unknown as AirportLayout, 'test');
    expect(errors.some((e) => e.includes('crossingMaxCode'))).toBe(true);
  });
});
