import { describe, expect, it } from 'vitest';
import { acceptOffer, addContract, createCompany, createSandboxCompany, generateOffers } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { defaultGame } from '../../src/core/economy/game';
import { initialGoals, type Tier } from '../../src/core/economy/goals';
import { effectiveTier, featureOn, isUnlocked, lockLabel, UNLOCKS } from '../../src/core/economy/unlocks';

function careerAtTier(tier: Tier) {
  const c = createCompany('career', `unlocks-${tier}`);
  c.game = defaultGame();
  c.goals = { ...initialGoals(), tier };
  return c;
}

describe('unlocks: 格による解放（4-01）', () => {
  it('解放一覧: 格 0 は何も解放されず、格が上がるごとに増える', () => {
    const at = (t: Tier) => UNLOCKS.filter((u) => isUnlocked(careerAtTier(t), u.feature)).map((u) => u.feature).sort();
    expect(at(0)).toEqual([]);
    expect(at(1)).toEqual(['overnight']);
    expect(at(2)).toEqual(['based', 'maintenance', 'overnight']);
    expect(at(3)).toEqual(['based', 'cargo', 'hub', 'international', 'maintenance', 'overnight']);
  });

  it('サンドボックスと目標のない会社は全解放', () => {
    const sandbox = createSandboxCompany();
    expect(effectiveTier(sandbox)).toBe(3);
    const plain = createCompany('career', 'unlocks-plain');
    expect(effectiveTier(plain)).toBe(3);
    for (const u of UNLOCKS) expect(isUnlocked(plain, u.feature)).toBe(true);
  });

  it('lockLabel は解放前だけ文を返し、格と名前を含む', () => {
    expect(lockLabel(careerAtTier(0), 'overnight')).toBe('格 1（地方空港）で解放');
    expect(lockLabel(careerAtTier(0), 'international')).toBe('格 3（国際ハブ）で解放');
    expect(lockLabel(careerAtTier(3), 'international')).toBeNull();
    expect(lockLabel(createSandboxCompany(), 'hub')).toBeNull();
  });

  it('featureOn は解放 かつ features の ON が必要。整備は拠点に含まれる', () => {
    const c = careerAtTier(3);
    expect(featureOn(c, 'overnight')).toBe(false);
    c.features = { overnight: true };
    expect(featureOn(c, 'overnight')).toBe(true);
    expect(featureOn(c, 'maintenance')).toBe(false);
    c.features = { based: true };
    expect(featureOn(c, 'maintenance')).toBe(true);
    expect(featureOn(c, 'based')).toBe(true);
    // 格が足りなければ ON でも動かない
    const low = careerAtTier(0);
    low.features = { overnight: true };
    expect(featureOn(low, 'overnight')).toBe(false);
  });

  it('features OFF の会社では新しい種類の提案が出ず、従来の提案だけが返る', () => {
    const c = createSandboxCompany('unlocks-off');
    let total = 0;
    for (let d = 0; d < 6; d++) {
      c.day = d;
      const offers = generateOffers(c, ['B737-800', 'B787-9', 'A320neo', 'ATR72-600']);
      total += offers.length;
      expect(offers.every((k) => k.kind === undefined)).toBe(true);
      for (const k of offers) k.status = 'expired';
    }
    expect(total).toBeGreaterThan(0);
  });

  it('サンドボックスで overnight を有効にすると、滞泊の提案が（数日のうちに）出る', () => {
    const c = createSandboxCompany('unlocks-on');
    c.features = { overnight: true };
    let found = false;
    for (let d = 0; d < 6 && !found; d++) {
      c.day = d;
      const offers = generateOffers(c, ['B737-800', 'B787-9', 'A320neo', 'ATR72-600', 'B767-300', 'E190']);
      found = offers.some((k) => k.kind === 'overnight');
      for (const k of offers) k.status = 'expired';
    }
    expect(found).toBe(true);
  });

  it('acceptOffer: 解放・有効化されていない種類は LOCKED で拒否する', () => {
    const c = careerAtTier(0);
    c.features = { overnight: true }; // 格 0 では解放されていない
    const k = addContract(c, {
      airlineId: 'SK', destinationId: 'KTA', typeId: 'B737-800', perDay: 1, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 30, status: 'offered', offerExpiresDay: 7, kind: 'overnight',
    });
    expect(acceptOffer(c, k.id, true)).toEqual({ ok: false, reason: 'LOCKED' });
    const s = createSandboxCompany('unlocks-accept');
    s.features = { overnight: true };
    const k2 = addContract(s, {
      airlineId: 'SK', destinationId: 'KTA', typeId: 'B737-800', perDay: 1, window: 'evening',
      feeDiscount: 0.1, startDay: 0, endDay: 30, status: 'offered', offerExpiresDay: 7, kind: 'overnight',
    });
    expect(acceptOffer(s, k2.id, true)).toEqual({ ok: true });
  });

  it('拠点の提案は canBase の会社だけに出て、受け入れで所属機が登録され期間が 3 倍になる', () => {
    const c = createSandboxCompany('unlocks-based');
    c.city = defaultCity('core');
    c.market = { version: 1, routes: {} }; // canBase の会社（NH・JL）は market 専用のため
    c.rating = 80; // NH・JL の参入条件（評価 60 以上）
    c.features = { based: true };
    let based: ReturnType<typeof addContract> | undefined;
    for (let d = 0; d < 10 && !based; d++) {
      c.day = d;
      const offers = generateOffers(c, ['B737-800', 'B787-9', 'A320neo', 'A321neo', 'A350-900', 'ATR72-600', 'B767-300', 'E190']);
      based = offers.find((k) => k.kind === 'based');
      for (const k of offers) if (k !== based) k.status = 'expired';
    }
    expect(based).toBeDefined();
    expect(['NH', 'JL']).toContain(based!.airlineId); // canBase は実在データの NH・JL のみ（market 専用）
    const before = c.day;
    expect(acceptOffer(c, based!.id, true)).toEqual({ ok: true });
    expect(based!.endDay - before).toBe(30 * 3 - 1); // 通常（30 日）の 3 倍
    const fleet = Object.values(c.basedFleet ?? {});
    expect(fleet.length).toBe(based!.basedAircraft);
    expect(fleet.every((b) => b.contractId === based!.id)).toBe(true);
  });
});
