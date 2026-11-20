import { BALANCE } from '../../../core/economy/balance';
import { noiseImpactDelta, noiseMitigationFactor, offshoreNoiseFactor, residentFacilityBonus, soundproofLevelOf, soundproofNoiseFactor } from '../../../core/economy/city';
import { cityNoiseMetrics } from '../../../core/economy/ops';
import { Card, CardRow, useSecondly } from '../Card';

/**
 * 住民・騒音カード（機能E、運航画面右列。3b 設計 E.2 の NoiseCard）。
 * 表示専用: 防音工事の購入と騒音対策費の拠出は建設モード（運航計画タブ）でのみ行う。
 * 夜間便数・騒音ポイントは当日の締め前集計（日報の city セクションと同じ cityNoiseMetrics）。
 * 変化見込みは日次締め（ops.settleDay）と同じ合成係数（防音 × 海上移転）と
 * 住民向け施設のプラスで計算する。
 */
export function NoiseCard() {
  const data = useSecondly((o) => {
    const city = o.sim.company?.city;
    if (!city) return null;
    const e = o.sim.state.economy;
    const metrics = e ? cityNoiseMetrics(o.sim.state, o.sim.ctx, e.periodStart, o.sim.state.now) : null;
    const level = soundproofLevelOf(city);
    const tier = o.sim.company?.goals?.tier ?? 0;
    const facilityBonus = residentFacilityBonus(o.sim.ctx.layout);
    // 今日の途中経過（現時点までの騒音実績）での日次変化見込み。締め時に確定する
    const projectedDelta = metrics ? noiseImpactDelta(city, metrics.noisePoints, metrics.nightMovements, { tier, facilityBonus }) : null;
    return {
      residents: city.residents,
      level,
      factor: soundproofNoiseFactor(level),
      tier,
      offshoreFactor: offshoreNoiseFactor(tier),
      combinedFactor: noiseMitigationFactor(city, tier),
      facilityBonus,
      metrics,
      projectedDelta,
    };
  });
  if (!data) return null;
  const maxLevel = BALANCE.noise.soundproof.maxLevel;
  return (
    <Card id="noise" title="住民・騒音" badge={`防音 Lv${data.level}`}>
      <CardRow label="住民満足度" tone={data.residents < 70 ? 'warn' : undefined} testid="card-noise-residents">
        {data.residents.toFixed(1)} / 100
      </CardRow>
      <CardRow label="今日の夜間運航（22時〜6時）" tone={(data.metrics?.nightMovements ?? 0) > 0 ? 'warn' : undefined} testid="card-noise-night">
        {data.metrics ? `${data.metrics.nightMovements} 回` : '—'}
      </CardRow>
      <CardRow label="今日の騒音ポイント" testid="card-noise-points">
        {data.metrics ? `${data.metrics.noisePoints}（${data.metrics.movements} 動作）` : '—'}
      </CardRow>
      <CardRow label="満足度の変化見込み（今日の途中経過）" tone={(data.projectedDelta ?? 0) < 0 ? 'warn' : undefined} testid="card-noise-projection">
        {data.projectedDelta !== null && data.projectedDelta !== undefined ? `${data.projectedDelta >= 0 ? '+' : ''}${data.projectedDelta.toFixed(2)} / 日` : '—'}
      </CardRow>
      <CardRow label="防音工事" testid="card-noise-level">
        {data.level >= maxLevel ? `Lv${maxLevel}（最大、騒音の影響 ×${data.factor}）` : `Lv${data.level}（騒音の影響 ×${data.factor}）`}
      </CardRow>
      {data.offshoreFactor < 1 && (
        <CardRow label={`海上移転（格${data.tier}）`} testid="card-noise-offshore">
          騒音の影響 ×{data.offshoreFactor}（防音と合わせ ×{data.combinedFactor}）
        </CardRow>
      )}
      {data.facilityBonus > 0 && (
        <CardRow label="住民向け施設" testid="card-noise-facility">
          +{data.facilityBonus.toFixed(2)} / 日
        </CardRow>
      )}
      <div className="card-sub">夜間着陸料は ×{1 + BALANCE.fees.nightSurcharge}。防音工事の実施と騒音対策費の拠出は建設モードの運航計画タブから。</div>
    </Card>
  );
}
