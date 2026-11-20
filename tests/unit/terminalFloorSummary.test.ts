import { describe, expect, it } from 'vitest';
import { terminalFloorSummary } from '../../src/core/terminal/terminalFloorSummary';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout } from './helpers';

/**
 * フロア別集計（5-18 T5 の核）: 階ごとに種別件数・処理能力・席数を集計する純関数。
 */
function fixture(): AirportLayout {
  const layout = emptyLayout(120, 60);
  layout.facilities['tA'] = { id: 'tA', kind: 'terminal', name: 'A', origin: { x: 2, y: 2 }, w: 30, h: 10, rotation: 0, buildState: 'operational', props: { levels: 3 } };
  layout.facilities['tB'] = { id: 'tB', kind: 'terminal', name: 'B', origin: { x: 50, y: 2 }, w: 20, h: 8, rotation: 0, buildState: 'operational', props: { levels: 2 } };
  const area = (id: string, terminalId: string, level: number, kind: string, props: Record<string, number>) => {
    layout.terminalAreas[id] = {
      id, terminalId, level, kind: kind as never, name: '', origin: { x: 4, y: 4 }, w: 4, h: 2, zone: 'landside', props,
    };
  };
  // tA 1F（level 0）
  area('sec1', 'tA', 0, 'security', { lanes: 2 });
  area('ci1', 'tA', 0, 'checkIn', { counters: 3 });
  area('lob1', 'tA', 0, 'departureLobby', { seats: 120 });
  area('ent1', 'tA', 0, 'entrance', {});
  // tA 2F（level 1）
  area('sec2', 'tA', 1, 'security', { lanes: 1 });
  area('wait1', 'tA', 1, 'waiting', { seats: 40 });
  area('lng1', 'tA', 1, 'lounge', { seats: 25 });
  // tA B1（level -1）
  area('bag1', 'tA', -1, 'baggageClaim', { belts: 2 });
  area('wc1', 'tA', -1, 'restroom', { fixtures: 4 });
  // 別ターミナルのエリアは混ざらない
  area('secB', 'tB', 0, 'security', { lanes: 5 });
  return layout;
}

describe('フロア別集計 terminalFloorSummary', () => {
  it('階の昇順に並び、種別件数を数える（他ターミナルは含めない）', () => {
    const rows = terminalFloorSummary(fixture(), 'tA');
    expect(rows.map((r) => r.level)).toEqual([-1, 0, 1]);
    expect(rows[1]!.areas).toEqual({ security: 1, checkIn: 1, departureLobby: 1, entrance: 1 });
    expect(rows[2]!.areas).toEqual({ security: 1, waiting: 1, lounge: 1 });
    expect(rows[0]!.areas).toEqual({ baggageClaim: 1, restroom: 1 });
  });

  it('処理能力は種別別に areaProcessingPerHour の合計', () => {
    const rows = terminalFloorSummary(fixture(), 'tA');
    // 保安: レーン×3600÷15秒 = レーン×240。チェックイン: カウンタ×3600÷50秒
    expect(rows[1]!.processingPerHour).toEqual({ security: 480, checkIn: 216 });
    expect(rows[2]!.processingPerHour).toEqual({ security: 240 });
    // トイレ: 器具×3600÷90秒 = 器具×40。手荷物受取は窓口を持たないので含めない
    expect(rows[0]!.processingPerHour).toEqual({ restroom: 160 });
  });

  it('席数は waiting / departureLobby / lounge の seats 合計', () => {
    const rows = terminalFloorSummary(fixture(), 'tA');
    expect(rows[0]!.seats).toBe(0);
    expect(rows[1]!.seats).toBe(120);
    expect(rows[2]!.seats).toBe(65);
  });

  it('エリアの無いターミナル・存在しないターミナルは空', () => {
    const layout = fixture();
    expect(terminalFloorSummary(layout, 'tB').map((r) => r.level)).toEqual([0]);
    layout.terminalAreas = {};
    expect(terminalFloorSummary(layout, 'tA')).toEqual([]);
    expect(terminalFloorSummary(layout, 'missing')).toEqual([]);
  });
});
