import { describe, expect, it } from 'vitest';
import { terminalCapacitySummaries } from '../../src/core/terminal/terminalCapacitySummary';
import type { DailyReport } from '../../src/core/economy/company';
import type { AirportLayout } from '../../src/core/model/types';
import { emptyLayout } from './helpers';

/**
 * ターミナル別容量サマリ: 使用ターミナル選択 UI に出すスポット数と
 * 保安検査の処理能力・使用率の集計。
 */
function fixture(): AirportLayout {
  const layout = emptyLayout(120, 60);
  layout.facilities['tA'] = { id: 'tA', kind: 'terminal', name: 'A', origin: { x: 2, y: 2 }, w: 20, h: 8, rotation: 0, buildState: 'operational', props: {} };
  layout.facilities['tB'] = { id: 'tB', kind: 'terminal', name: 'B', origin: { x: 40, y: 2 }, w: 20, h: 8, rotation: 0, buildState: 'operational', props: {} };
  layout.facilities['gA1'] = { id: 'gA1', kind: 'gate', name: '', origin: { x: 10, y: 1 }, w: 1, h: 1, rotation: 0, buildState: 'operational', props: { standId: 's1' } };
  layout.facilities['gA2'] = { id: 'gA2', kind: 'gate', name: '', origin: { x: 14, y: 1 }, w: 1, h: 1, rotation: 0, buildState: 'operational', props: { standId: 's2' } };
  layout.terminalAreas['secA1'] = { id: 'secA1', terminalId: 'tA', level: 0, kind: 'security', name: '', origin: { x: 4, y: 4 }, w: 4, h: 2, zone: 'landside', props: { lanes: 2 } };
  layout.terminalAreas['secA2'] = { id: 'secA2', terminalId: 'tA', level: 0, kind: 'security', name: '', origin: { x: 10, y: 4 }, w: 4, h: 2, zone: 'landside', props: { lanes: 1 } };
  layout.terminalAreas['secB1'] = { id: 'secB1', terminalId: 'tB', level: 0, kind: 'security', name: '', origin: { x: 44, y: 4 }, w: 4, h: 2, zone: 'landside', props: { lanes: 3 } };
  layout.stands['s1'] = { id: 's1', name: '', origin: { x: 8, y: 0 }, rotation: 0, size: 'M', buildState: 'operational' };
  layout.stands['s2'] = { id: 's2', name: '', origin: { x: 12, y: 0 }, rotation: 0, size: 'L', buildState: 'operational' };
  layout.stands['s3'] = { id: 's3', name: '', origin: { x: 44, y: 0 }, rotation: 0, size: 'S', buildState: 'operational', terminalId: 'tB' };
  layout.stands['s4'] = { id: 's4', name: '', origin: { x: 48, y: 0 }, rotation: 0, size: 'M', buildState: 'underConstruction', terminalId: 'tB' };
  layout.stands['s5'] = { id: 's5', name: '', origin: { x: 60, y: 0 }, rotation: 0, size: 'M', buildState: 'operational' };
  return layout;
}

const report = {
  processPeakByTerminal: [
    { terminalId: 'tA', step: 'security', capacityPerHour: 720, peakHour: 10, peakProcessed: 500, utilization: 0.69, avgWaitSec: 30 },
    { terminalId: 'tA', step: 'checkIn', capacityPerHour: 900, peakHour: 10, peakProcessed: 450, utilization: 0.5, avgWaitSec: 10 },
  ],
} as unknown as DailyReport;

describe('ターミナル別容量サマリ', () => {
  it('スポット数はゲート所属とリモートの明示所属を数え、建設中と無所属は除く', () => {
    const summaries = terminalCapacitySummaries(fixture());
    expect(summaries.get('tA')!.stands).toBe(2);
    expect(summaries.get('tA')!.standsBySize).toEqual({ S: 0, M: 1, L: 1 });
    expect(summaries.get('tB')!.stands).toBe(1);
    expect(summaries.get('tB')!.standsBySize).toEqual({ S: 1, M: 0, L: 0 });
  });

  it('保安検査の処理能力はエリアの合計（レーン数×3600÷処理秒数）', () => {
    const summaries = terminalCapacitySummaries(fixture());
    expect(summaries.get('tA')!.securityPerHour).toBe(720); // (2+1) レーン × 240
    expect(summaries.get('tB')!.securityPerHour).toBe(720); // 3 レーン × 240
  });

  it('使用率は直近の日報の保安ピークから取り、無ければ null', () => {
    const withReport = terminalCapacitySummaries(fixture(), report);
    expect(withReport.get('tA')!.securityUtilization).toBe(0.69);
    expect(withReport.get('tB')!.securityUtilization).toBeNull();
    const without = terminalCapacitySummaries(fixture());
    expect(without.get('tA')!.securityUtilization).toBeNull();
  });
});
