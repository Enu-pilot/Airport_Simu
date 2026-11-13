import { describe, expect, it } from 'vitest';
import { captureGameWeather } from '../golden/capture';
import { checkGolden, goldenText } from '../golden/io';

/**
 * 12B-3a B3: 天候 5 段階・難易度の運航の新規ゴールデン（SIM_MODEL_VERSION の保護の対象）。
 * 再採取: GOLDEN_UPDATE=1 npx vitest run tests/unit/golden.gameWeather.test.ts（他のゴールデンは再採取しない）
 */
describe('ゴールデン: 天候 5 段階・難易度の運航（12B-3a）', () => {
  it('悪天の日に着陸復行・欠航が起き、不変条件を保ち、基準値と一致する', { timeout: 900_000 }, () => {
    const r = captureGameWeather() as { runs: Record<string, { invariantViolations: number; weatherCancels: number; weatherGoArounds: number; plan: string }> };
    for (const run of Object.values(r.runs)) expect(run.invariantViolations).toBe(0);
    expect(r.runs['day0-normal']!.plan).toBe('0'.repeat(24));
    expect(r.runs['day0-normal']!.weatherCancels + r.runs['day0-normal']!.weatherGoArounds).toBe(0);
    expect(r.runs['bad-winter-normal']!.weatherCancels + r.runs['bad-winter-normal']!.weatherGoArounds).toBeGreaterThan(0);
    checkGolden('game-weather.golden.json', goldenText(r), { sim: true });
  });
});
