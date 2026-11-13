import { describe, expect, it } from 'vitest';
import { captureLegacyRemote } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a A0: リモートスポット（ゲートのないスポット）を含む従来のレイアウトの運航の特性テスト。
 * バス搭乗・独立ゲートの実装前の現行コードの出力を固定する。バスゲートのないデータでは実装後も 1 ビットも変わってはならない。
 * 運航時間は 6 時間（24 時間は単独で約 180 秒かかり負荷で時間切れになるため短縮。短縮後の値も実装前のコミット 5391881 のコードで同一であることを確認して採取）。
 * 通常は再採取しない（変わったら実装の漏れ）。
 */
describe('ゴールデン: 従来のリモートスポットの運航（12B-3a A0）', () => {
  it('出発は ゲートなし で乗り遅れ、到着は到達不能のままで、状態の sha256 まで基準値と一致する', { timeout: 300_000 }, () => {
    const r = captureLegacyRemote() as { runs: Record<string, { remoteStands: number; missedByReason: Record<string, number>; arrivalPaxByState: Record<string, number> }> };
    for (const run of Object.values(r.runs)) {
      expect(run.remoteStands).toBe(2);
    }
    expect(r.runs['plain-seed']!.missedByReason.noGate ?? 0).toBeGreaterThan(0);
    expect(r.runs['plain-seed']!.arrivalPaxByState.stranded ?? 0).toBeGreaterThan(0);
    checkGolden('legacy-remote-sim.golden.json', goldenText(r), { sim: true });
  });
});
