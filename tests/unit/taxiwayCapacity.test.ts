import { describe, expect, it } from 'vitest';
import { analyzeAirportCapacity } from '../../src/core/economy/capacity';
import { createCareerCompany, createSandboxCompany } from '../../src/core/economy/company';
import { defaultCity, defaultCityNightOps } from '../../src/core/economy/city';
import { updateEntity, updateLayoutSettings } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createContext } from '../../src/core/sim/context';
import { resolveType } from '../../src/core/sim/aircraftTypes';
import { BLOCK_REQ_M } from '../../src/core/sim/rules';
import { blockCapacityPerHour, taxiwayCapacityPerHour } from '../../src/core/sim/taxiBlocks';
import { must } from './helpers';

/** 2-08: 能力ダッシュボードの誘導路の行（block のときだけ値を出し、従来は未算出のまま） */
const rows = (layout = createSampleAirport(), company = createSandboxCompany()) =>
  analyzeAirportCapacity(company, createContext(layout)).facilities.filter((f) => f.kind === '誘導路');

describe('誘導路の能力（2-08）', () => {
  it('従来方式（taxiMode なし）は未算出のまま（capacity null・従来の根拠文）', () => {
    const r = rows();
    expect(r.length).toBeGreaterThan(0);
    for (const f of r) {
      expect(f.capacity).toBeNull();
      expect(f.status).toBe('uncomputed');
      if (f.state === 'operational') expect(f.basis).toContain('未算出');
    }
  });

  it('block では運用中の誘導路が min(cap×3600/通過時間, 3600×速度/必要長) の区間の最小で値を持つ', () => {
    const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const ctx = createContext(layout);
    expect(ctx.blocks).toBeDefined();
    const speed = resolveType(ctx.types, 'narrow180').taxiSpeed;
    const r = analyzeAirportCapacity(createSandboxCompany(), ctx).facilities.filter((f) => f.kind === '誘導路');
    let withValue = 0;
    for (const f of r) {
      const expected = taxiwayCapacityPerHour(ctx.blocks!, [f.id], 'M', speed);
      if (f.state !== 'operational') { expect(f.capacity).toBeNull(); continue; }
      if (expected === null) { expect(f.capacity).toBeNull(); continue; }
      withValue++;
      expect(f.capacity!).toBeCloseTo(expected, 0);
      // 上限: 速度から決まる間隔の上限を超えない
      expect(f.capacity!).toBeLessThanOrEqual((3600 * speed) / BLOCK_REQ_M.M + 0.1);
      expect(f.basis).toContain('区間ごとの走行');
    }
    expect(withValue).toBeGreaterThan(0);
  });

  it('blockMaxAircraft を小さくすると能力は増えない。1 機にすると、その区間の能力 = 3600×… ÷ 通過時間以下', () => {
    const base = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const before = rows(base);
    let layout = base;
    for (const id of Object.keys(base.taxiways)) layout = must(updateEntity(layout, id, { blockMaxAircraft: 1 })).layout;
    const after = rows(layout);
    expect(after.length).toBe(before.length);
    for (let i = 0; i < before.length; i++) {
      if (before[i]!.capacity === null) continue;
      expect(after[i]!.capacity!).toBeLessThanOrEqual(before[i]!.capacity! + 1e-9);
    }
  });

  it('区間の長さ（taxiBlockTiles）を変えても能力は範囲内の有限値（4・10・40）', () => {
    for (const tiles of [4, 10, 40]) {
      const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block', taxiBlockTiles: tiles })).layout;
      for (const f of rows(layout)) if (f.capacity !== null) {
        expect(Number.isFinite(f.capacity)).toBe(true);
        expect(f.capacity).toBeGreaterThan(0);
      }
    }
  });

  it('純粋関数: 通過専用や入口の小片だけのエッジは null、blockCapacityPerHour は 0 以下の速度で null', () => {
    const layout = must(updateLayoutSettings(createSampleAirport(), { taxiMode: 'block' })).layout;
    const g = createContext(layout).blocks!;
    expect(taxiwayCapacityPerHour(g, ['no-such-edge'], 'M', 8)).toBeNull();
    const b = Object.values(g.blocks).find((x) => !x.entry)!;
    expect(blockCapacityPerHour(b, 'M', 0)).toBeNull();
    expect(blockCapacityPerHour(b, 'S', 8)!).toBeGreaterThanOrEqual(blockCapacityPerHour(b, 'L', 8)! - 1e-9);
  });
});

describe('運用時間と最終出発時刻（R17）', () => {
  it('nightOps なしの運用時間は従来のまま。nightOps があると終わりを最終出発時刻で切る', () => {
    const layout = createSampleAirport();
    const c = createCareerCompany();
    c.city = defaultCity('core');
    const plain = analyzeAirportCapacity(c, createContext(layout)).operatingHours;
    expect(plain).toBe((c.hours.closeMin - c.hours.openMin) / 60); // 都市だけ（nightOps なし）は従来の値
    const c2 = structuredClone(c);
    c2.city!.nightOps = { ...defaultCityNightOps(), departureCutoffMin: 1200 };
    const cut = analyzeAirportCapacity(c2, createContext(layout)).operatingHours;
    expect(cut).toBeCloseTo((1200 - Math.max(c.hours.openMin, 360)) / 60, 6);
    expect(cut).toBeLessThan(plain);
    // 都市なし（従来）は変わらない
    const legacy = createCareerCompany();
    expect(analyzeAirportCapacity(legacy, createContext(layout)).operatingHours).toBe((legacy.hours.closeMin - legacy.hours.openMin) / 60);
  });
});
