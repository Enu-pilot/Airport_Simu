import { describe, expect, it } from 'vitest';
import { placeRunway } from '../../src/core/layout/operations';
import { runwayRelation, runwaySystemCapacity } from '../../src/core/runwayCapacity';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { emptyLayout, must } from './helpers';
import type { AirportLayout } from '../../src/core/model/types';

const runwayAt = (layout: AirportLayout, x: number, y: number, heading: Parameters<typeof placeRunway>[2], length = 80): AirportLayout =>
  must(placeRunway(layout, { x, y }, heading, length)).layout;

/**
 * 5-01: 滑走路の能力を本数ではなく構成（平行の間隔・交差）から算出する。
 * 1 本 = 30 回/時、独立平行（760 m 以上）は合算、依存平行は 1 本あたり半分増し、交差は増えない。
 */
describe('滑走路能力の構成算出（5-01）', () => {
  it('既存の空港（1 本）は従来どおり 30 回/時', () => {
    expect(runwaySystemCapacity(createSampleAirport()).perHour).toBe(30);
    expect(runwaySystemCapacity(createStarterAirfield()).perHour).toBe(30);
  });

  it('独立平行（800 m 間隔）は合算して 60 回/時', () => {
    let l = emptyLayout(160, 120);
    l = runwayAt(l, 10, 10, 90);
    l = runwayAt(l, 10, 42, 90); // 32 タイル = 800 m 間隔
    const [a, b] = Object.values(l.runways);
    expect(runwayRelation(a!, b!)).toBe('independent');
    expect(runwaySystemCapacity(l).perHour).toBe(60);
  });

  it('依存平行（400 m 間隔）は 45 回/時', () => {
    let l = emptyLayout(160, 120);
    l = runwayAt(l, 10, 10, 90);
    l = runwayAt(l, 10, 26, 90); // 16 タイル = 400 m 間隔
    const [a, b] = Object.values(l.runways);
    expect(runwayRelation(a!, b!)).toBe('dependent');
    expect(runwaySystemCapacity(l).perHour).toBe(45);
  });

  it('交差する 2 本は 30 回/時のまま', () => {
    let l = emptyLayout(160, 120);
    l = runwayAt(l, 10, 40, 90);
    l = runwayAt(l, 45, 75, 0); // 方位 0 は北向き: (45,75) から北へ伸びて横向き滑走路と交わる
    const [a, b] = Object.values(l.runways);
    expect(runwayRelation(a!, b!)).toBe('crossing');
    expect(runwaySystemCapacity(l).perHour).toBe(30);
  });

  it('運用中でない滑走路は数えない', () => {
    let l = emptyLayout(160, 120);
    l = runwayAt(l, 10, 10, 90);
    l = runwayAt(l, 10, 42, 90);
    const second = Object.values(l.runways)[1]!;
    second.buildState = 'underConstruction';
    expect(runwaySystemCapacity(l).perHour).toBe(30);
  });
});
