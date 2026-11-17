import { describe, expect, it } from 'vitest';
import { admits, blockCapacity, blockCapacityPerHour, isPassThrough, type TaxiBlock } from '../../../src/core/sim/taxiBlocks';
import { BLOCK_REQ_M, JUNCTION_STOP_M } from '../../../src/core/sim/rules';
import type { SizeClass } from '../../../src/core/model/types';

/** 出口が交差点の区間（長さ lengthM、正規の向きの出口 = 交差点） */
const blk = (lengthM: number, end: 'junction' | 'runway' = 'junction', extra: Partial<TaxiBlock> = {}): TaxiBlock => ({
  id: 'b#0', corridorId: 'C', corrFwd: true, spans: [], lengthM, startNode: 'a', endNode: 'b',
  endKind: { start: 'junction', end },
  usableM: { fwd: end === 'junction' ? Math.max(0, lengthM - JUNCTION_STOP_M) : lengthM, rev: Math.max(0, lengthM - JUNCTION_STOP_M) },
  ...extra,
});
const S: SizeClass[] = ['S', 'M', 'L'];

describe('2-02 taxiBlocks.capacity', () => {
  it('計画 §2.2 の表: 4/8/10/12/20 タイル × S/M/L の進入可能機数', () => {
    const table: Record<number, [number, number, number]> = { 4: [1, 1, 1], 8: [2, 1, 1], 10: [2, 2, 1], 12: [3, 2, 2], 20: [6, 5, 3] };
    for (const [tiles, [s, m, l]] of Object.entries(table)) {
      const b = blk(Number(tiles) * 25);
      expect([blockCapacity(b, 1, 'S'), blockCapacity(b, 1, 'M'), blockCapacity(b, 1, 'L')]).toEqual([s, m, l]);
    }
  });

  it('S ≥ M ≥ L（長さを変えて全域）・最小 1', () => {
    for (let len = 25; len <= 1000; len += 5) {
      const b = blk(len);
      expect(blockCapacity(b, 1, 'S')).toBeGreaterThanOrEqual(blockCapacity(b, 1, 'M'));
      expect(blockCapacity(b, 1, 'M')).toBeGreaterThanOrEqual(blockCapacity(b, 1, 'L'));
      for (const s of S) {
        expect(blockCapacity(b, 1, s)).toBeGreaterThanOrEqual(1);
        expect(admits(b, 1, [], s)).toBe(true);
      }
    }
  });

  it('滑走路手前の列（出口が滑走路）: 10 タイルは M が 2 機・L が 2 機', () => {
    const b = blk(250, 'runway');
    expect(blockCapacity(b, 1, 'M')).toBe(2);
    expect(blockCapacity(b, 1, 'L')).toBe(2);
  });

  it('混在は必要長の合計: U = 180 m で M+M は入り、179 m では入らない（1 m 足りない）', () => {
    const b180 = blk(180, 'runway');
    const b179 = blk(179, 'runway');
    expect(admits(b180, 1, ['M'], 'M')).toBe(true);
    expect(admits(b179, 1, ['M'], 'M')).toBe(false);
    // 混在: S(70) + M(90) = 160 ≤ 160 ちょうど入る / 159 は入らない
    expect(admits(blk(160, 'runway'), 1, ['S'], 'M')).toBe(true);
    expect(admits(blk(159, 'runway'), 1, ['S'], 'M')).toBe(false);
    // L(120) + S(70) + S(70) = 260
    expect(admits(blk(260, 'runway'), 1, ['L', 'S'], 'S')).toBe(true);
    expect(admits(blk(259, 'runway'), 1, ['L', 'S'], 'S')).toBe(false);
    // 「L は M 2 枠」のような固定換算はしない: L + M = 210
    expect(admits(blk(210, 'runway'), 1, ['L'], 'M')).toBe(true);
    expect(admits(blk(209, 'runway'), 1, ['L'], 'M')).toBe(false);
  });

  it('向きで使える長さが変わる（出口側の停止距離）', () => {
    const b = blk(250, 'runway'); // 正規の向きの出口は滑走路（停止 0）、逆向きの出口は交差点（−45）
    expect(blockCapacity(b, 1, 'M')).toBe(2);
    expect(blockCapacity(b, -1, 'M')).toBe(2); // 205 / 90
    expect(blockCapacity(blk(200, 'runway'), -1, 'M')).toBe(1); // 155 / 90
    expect(blockCapacity(blk(200, 'runway'), 1, 'M')).toBe(2);
  });

  it('blockMaxAircraft は上限（計算値より小さくする方向だけ。大きくはならない）', () => {
    const b = blk(500, 'runway', { maxAircraft: 2 });
    expect(blockCapacity(b, 1, 'S')).toBe(2);
    expect(admits(b, 1, ['S', 'S'], 'S')).toBe(false);
    expect(admits(b, 1, ['S'], 'S')).toBe(true);
    const big = blk(100, 'runway', { maxAircraft: 10 });
    expect(blockCapacity(big, 1, 'M')).toBe(1);
  });

  it('通過専用: 使える長さが必要長に満たない大きさは止まれない（空なら 1 機は入れる）', () => {
    const b = blk(100); // U = 55
    for (const s of S) {
      expect(isPassThrough(b, 1, s)).toBe(true);
      expect(admits(b, 1, [], s)).toBe(true);
      expect(admits(b, 1, [s], s)).toBe(false);
    }
    expect(isPassThrough(blk(250), 1, 'M')).toBe(false);
    expect(isPassThrough(blk(250), 1, 'L')).toBe(false); // 205 ≥ 120
    expect(isPassThrough(blk(150), 1, 'L')).toBe(true); // 105 < 120
    expect(BLOCK_REQ_M.L).toBe(120);
  });

  it('入口の小片は枠を持たない', () => {
    const e = blk(87, 'runway', { entry: true });
    expect(blockCapacity(e, 1, 'M')).toBe(0);
    expect(admits(e, 1, ['M', 'M'], 'M')).toBe(true);
    expect(blockCapacityPerHour(e, 'M', 10)).toBeNull();
  });

  it('通行能力（回/時）: min(cap × 3600 / 通過時間, 3600 × 速度 / 必要長)', () => {
    const b = blk(250);
    const v = 10;
    expect(blockCapacityPerHour(b, 'M', v)).toBeCloseTo(Math.min((2 * 3600) / 25, (3600 * 10) / 90), 9);
  });
});
