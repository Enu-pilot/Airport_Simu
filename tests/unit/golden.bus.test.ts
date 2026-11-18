import { describe, expect, it } from 'vitest';
import { captureBusSim } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a: バス搭乗・独立ゲートの空港の運航の新規ゴールデン（SIM_MODEL_VERSION の保護の対象）。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.bus.test.ts（他のゴールデンは再採取しない）
 * 2026-11-18 深夜の再採取（PR #32 追随）: ホールド理由の拡充で failCauses の分類が
 * hold:noStand 22 → hold:noStand 20 + hold:standTooSmall 2 に変わった分のみ。
 * 件数の合計は不変で、運航そのものは無変更（差分を全件確認済み）。PR #34 で stress 側だけ
 * 再採取されていた取りこぼし。
 */
describe('ゴールデン: バス搭乗・独立ゲートの運航（12B-3a）', () => {
  it('出発・到着がバスで運ばれ、不変条件を保ち、基準値と一致する', { timeout: 600_000 }, () => {
    const r = captureBusSim() as { runs: Record<string, { invariantViolations: number; bus: { trips: number; pax: number }; missedByReason: Record<string, number> }> };
    for (const run of Object.values(r.runs)) {
      expect(run.invariantViolations).toBe(0);
      expect(run.bus.trips).toBeGreaterThan(0);
      expect(run.bus.pax).toBeGreaterThan(0);
      expect(run.missedByReason.noGate ?? 0).toBe(0);
    }
    checkGolden('bus-sim.golden.json', goldenText(r), { sim: true });
  });
});
