/**
 * 回帰（計画 1-08 / 監査 c ID15 / R-1）: 同じ滑走路に滑走路閉鎖の障害が重なっても、全て復旧すれば元の運用モードに戻る。
 * 旧: 後の障害が開始時に prev='closed' を記録し、両方が復旧しても永久に閉鎖のまま残った。
 */
import { describe, expect, it } from 'vitest';
import { sampleSim, runChecked, runUntilTime } from '../../audit/c_helpers';
import { addDisruption, resolveDisruption } from '../../../src/core/sim/disruptions';
import type { Simulation } from '../../../src/core/sim/simulation';

function setup(seed: string): { sim: Simulation; rw: string } {
  const sim = sampleSim({ seed });
  runUntilTime(sim, 8 * 3600, 60, 'repro');
  return { sim, rw: Object.keys(sim.ctx.layout.runways)[0]! };
}

describe('1-08 滑走路閉鎖の重なり', () => {
  it('A(30 分)・B(60 分、後から追加) が両方復旧したら滑走路は開く（再現テスト）', () => {
    const { sim, rw } = setup('c-overlap-repro');
    const orig = sim.state.runwayConfig[rw]!.mode;
    const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 1800 });
    const b = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 3600 });
    expect(b.prev).toBe(orig); // B は A が記録した元のモードを引き継ぐ
    runChecked(sim, 3700, 60, 'repro');
    expect([a.status, b.status]).toEqual(['resolved', 'resolved']);
    expect(sim.state.runwayConfig[rw]!.mode).toBe(orig);
    const dep = sim.state.stats.departures;
    runChecked(sim, 4 * 3600, 60, 'repro');
    expect(sim.state.stats.departures).toBeGreaterThan(dep);
  });

  it('終わる順序を逆にしても（後から追加した B が先に終わる）元に戻る', () => {
    const { sim, rw } = setup('s-overlap-rev');
    const orig = sim.state.runwayConfig[rw]!.mode;
    const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 3600 });
    const b = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 1800 });
    runChecked(sim, 1900, 60, 'rev');
    expect(b.status).toBe('resolved');
    expect(sim.state.runwayConfig[rw]!.mode).toBe('closed'); // A がまだ有効
    runChecked(sim, 1800, 60, 'rev');
    expect(a.status).toBe('resolved');
    expect(sim.state.runwayConfig[rw]!.mode).toBe(orig);
  });

  it('3 つ重ねても（maintenance を含む）全て復旧後に元のモードへ戻る', () => {
    const { sim, rw } = setup('s-overlap-3');
    const orig = sim.state.runwayConfig[rw]!.mode;
    const n = sim.state.now;
    const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: n + 1200 });
    const b = addDisruption(sim, { kind: 'maintenance', targetId: rw, end: n + 2400 });
    const c = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: n + 1800 });
    runChecked(sim, 2500, 60, 'three');
    expect([a.status, b.status, c.status]).toEqual(['resolved', 'resolved', 'resolved']);
    expect(sim.state.runwayConfig[rw]!.mode).toBe(orig);
  });

  it('プレイヤーが修理して解除した順序が逆でも元に戻る', () => {
    const { sim, rw } = setup('s-overlap-player');
    const orig = sim.state.runwayConfig[rw]!.mode;
    const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: null });
    const b = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: null });
    expect(resolveDisruption(sim, a.id)).toBe(true);
    expect(sim.state.runwayConfig[rw]!.mode).toBe('closed');
    expect(resolveDisruption(sim, b.id)).toBe(true);
    expect(sim.state.runwayConfig[rw]!.mode).toBe(orig);
  });

  it('手動閉鎖（有効な障害なし）中に障害が来て終わっても、閉鎖のまま（従来どおり）', () => {
    const { sim, rw } = setup('s-overlap-manual');
    sim.state.runwayConfig[rw]!.mode = 'closed';
    const d = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 600 });
    expect(d.prev).toBe('closed');
    runChecked(sim, 700, 60, 'manual');
    expect(d.status).toBe('resolved');
    expect(sim.state.runwayConfig[rw]!.mode).toBe('closed');
  });
});
