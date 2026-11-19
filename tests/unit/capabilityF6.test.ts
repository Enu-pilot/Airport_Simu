import { describe, expect, it } from 'vitest';
import { capabilityUtilization, facilityCapability, layoutCapabilities, readingFromCapacityMetric, readingsFromProcessPeak } from '../../src/core/capability';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createCareerCompany } from '../../src/core/economy/company';
import { cargoHandlingCapacityM3PerHour } from '../../src/core/economy/cargo';
import { towerCapacityPerHour } from '../../src/core/safety';
import { BALANCE } from '../../src/core/economy/balance';
import { createContext } from '../../src/core/sim/context';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { placeFacility } from '../../src/core/layout/operations';
import type { DailyReport } from '../../src/core/economy/company';


describe('F6-01 共通能力契約', () => {
  it('adapter は既存能力スナップショットの値をそのまま写す（回帰）', () => {
    const layout = createStarterAirfield();
    const snap = analyzeAirportCapacity(createCareerCompany(), createContext(layout));
    expect(snap.summary.length).toBeGreaterThan(0);
    for (const m of snap.summary) {
      const r = readingFromCapacityMetric(m, m.name);
      expect(r.theoretical).toBe(m.capacity);
      expect(r.effective).toBe(m.capacity);
      expect(r.demand).toBe(m.demand);
      expect(r.unit).toBe(m.unit);
      expect(r.actual).toBeNull();
      if (m.capacity === null) {
        expect(r.state).toBe('uncomputed');
        expect(r.uncomputedReason).toBeTruthy();
      }
    }
  });

  it('貨物上屋: 施設別理論能力の合計が既存の空港合計と一致する', () => {
    const placed = placeFacility(createStarterAirfield(), 'cargoTerminal', { x: 10, y: 10 });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    const layout = placed.layout;
    const f = Object.values(layout.facilities).find((x) => x.kind === 'cargoTerminal')!;
    const r = facilityCapability(f);
    expect(r.unit).toBe('m³/h');
    expect(r.theoretical).toBe(Math.max(0, Number(f.props.throughputM3PerHour ?? 0) || 0));
    const sum = layoutCapabilities(layout)
      .filter((x) => x.domain === 'facility' && x.unit === 'm³/h' && x.theoretical !== null)
      .reduce((s, x) => s + (x.theoretical ?? 0), 0);
    expect(sum).toBe(cargoHandlingCapacityM3PerHour(layout));
  });

  it('バスターミナル: access/model と同じ式で人/時を返す', () => {
    const res = placeFacility(createStarterAirfield(), 'busTerminal', { x: 36, y: 58 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const f = Object.values(res.layout.facilities).find((x) => x.kind === 'busTerminal')!;
    const M = BALANCE.accessModel;
    const expected = Math.min(Number(f.props.busesPerHour ?? 0) || 0, (Number(f.props.berths ?? 0) || 0) * M.busesPerBay) * M.busSeats;
    const r = facilityCapability(f);
    expect(r.theoretical).toBe(expected);
    expect(r.unit).toBe('pax/h');
  });

  it('管制塔: safety.ts のレベル別能力と一致し、建設中は有効能力 0', () => {
    const layout = createStarterAirfield();
    const tower = Object.values(layout.facilities).find((x) => x.kind === 'tower');
    expect(tower).toBeTruthy();
    const r = facilityCapability(tower!);
    expect(r.theoretical).toBe(towerCapacityPerHour(Number(tower!.props.level ?? 1) || 0));
    const building = { ...tower!, buildState: 'underConstruction' as const };
    const rb = facilityCapability(building);
    expect(rb.state).toBe('underConstruction');
    expect(rb.effective).toBe(0);
    expect(rb.theoretical).toBe(r.theoretical);
  });

  it('能力式のない施設種別は 0 ではなく未算出として理由を返す', () => {
    const layout = createStarterAirfield();
    const hangar = Object.values(layout.facilities).find((x) => x.kind === 'fuelFarm');
    expect(hangar).toBeTruthy();
    const r = facilityCapability(hangar!);
    expect(r.state).toBe('uncomputed');
    expect(r.theoretical).toBeNull();
    expect(r.effective).toBeNull();
    expect(r.uncomputedReason).toBeTruthy();
  });

  it('5-21 工程ピークの adapter は能力・需要・実績を写し、使用率は有効能力基準', () => {
    const report = {
      processPeak: [
        { step: 'checkIn', capacityPerHour: 600, demandPerHour: 300, peakHour: 8, peakProcessed: 280, utilization: 0.5, avgWaitSec: 120 },
        { step: 'security', capacityPerHour: 0, demandPerHour: 100, peakHour: 8, peakProcessed: 0, utilization: null, avgWaitSec: 0 },
      ],
    } as unknown as DailyReport;
    const rows = readingsFromProcessPeak(report);
    expect(rows[0]).toMatchObject({ theoretical: 600, effective: 600, demand: 300, actual: 280, unit: 'pax/h' });
    expect(capabilityUtilization(rows[0]!)).toBe(0.5);
    expect(rows[1]!.state).toBe('zeroCapacity');
    expect(capabilityUtilization(rows[1]!)).toBeNull();
  });
});

describe('F6-11 夜間滞泊能力の共通契約', () => {
  it('既存の overnightCapacity / overnightRequired と同じ値を返す', async () => {
    const { createSampleAirport } = await import('../../src/core/sample/sampleAirport');
    const { overnightCapacity, overnightRequired } = await import('../../src/core/economy/capacity');
    const { overnightReadings } = await import('../../src/core/capability');
    const layout = createSampleAirport();
    const ctx = createContext(layout);
    const company = createCareerCompany();
    const rows = overnightReadings(company, ctx, company.day);
    const cap = overnightCapacity(ctx);
    const req = overnightRequired(company, ctx, company.day);
    expect(rows.map((r) => r.subjectId)).toEqual(['overnight:S', 'overnight:M', 'overnight:L']);
    for (const r of rows) {
      const size = r.subjectId.split(':')[1] as 'S' | 'M' | 'L';
      expect(r.theoretical).toBe(cap[size]);
      expect(r.demand).toBe(req[size] ?? 0);
      expect(r.unit).toBe('aircraft');
    }
  });
});
