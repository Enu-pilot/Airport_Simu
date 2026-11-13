import { describe, expect, it } from 'vitest';
import { captureLegacyRemote } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a A0: リモートスポット（ゲートのないスポット）を含む従来のレイアウトの運航の特性テスト。
 * バス搭乗・独立ゲートの実装前の現行コードの出力を固定する。バスゲートのないデータでは実装後も 1 ビットも変わってはならない。
 * 再採取は禁止（変わったら実装の漏れ）。
 */
describe('ゴールデン: 従来のリモートスポットの運航（12B-3a A0）', () => {
  it('出発は ゲートなし で乗り遅れ、到着は到達不能のままで、状態の sha256 まで基準値と一致する', { timeout: 300_000 }, () => {
    const r = captureLegacyRemote() as { runs: Record<string, { remoteStands: number; missedByReason: Record<string, number>; arrivalPaxByState: Record<string, number> }> };
    for (const run of Object.values(r.runs)) {
      expect(run.remoteStands).toBe(2);
    }
    checkGolden('legacy-remote-sim.golden.json', goldenText(r), { sim: true });
  });
});
