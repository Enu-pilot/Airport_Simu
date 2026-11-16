/**
 * 既知の不具合の再現（監査 c / ID15）: 同じ滑走路に滑走路閉鎖の障害を重ねて、先に入れた方が先に復旧すると、
 * 後の障害が開始時に prev='closed' を記録するため、両方が復旧しても滑走路が永久に 'closed' のまま残る。
 * 期待（docs/19・disruptions.ts reopenRunway のコメント「同じ滑走路に発生中の閉鎖が他にあれば閉鎖のまま」＝全て復旧すれば開く）: 全て復旧後は運用モードが元に戻る。
 * 実行: AUDIT_KNOWN=1 npx vitest run -c vitest.audit.config.ts tests/audit/known-issues/c_runwayOverlap.repro.test.ts
 */
import { expect, it } from 'vitest';
import { sampleSim, runChecked, runUntilTime } from '../c_helpers';
import { addDisruption } from '../../../src/core/sim/disruptions';

it('滑走路閉鎖 A(30 分)・B(60 分、後から追加) が両方復旧したら滑走路は開く', () => {
  const sim = sampleSim({ seed: 'c-overlap-repro' });
  runUntilTime(sim, 8 * 3600, 60, 'repro');
  const rw = Object.keys(sim.ctx.layout.runways)[0]!;
  const a = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 1800 });
  const b = addDisruption(sim, { kind: 'runwayClosed', targetId: rw, end: sim.state.now + 3600 });
  expect(b.prev).toBe('closed'); // 原因: B は A がすでに閉じた状態を「元の状態」として記録する
  runChecked(sim, 3700, 60, 'repro');
  expect([a.status, b.status]).toEqual(['resolved', 'resolved']);
  expect(sim.state.runwayConfig[rw]!.mode).not.toBe('closed');
  const dep = sim.state.stats.departures;
  runChecked(sim, 4 * 3600, 60, 'repro');
  expect(sim.state.stats.departures).toBeGreaterThan(dep);
});
