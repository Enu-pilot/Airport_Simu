import type { CompanyState } from './company';

/**
 * 航空会社の評価・目標が契約・提案に及ぼす効果の判定（読み取りだけの小さな関数。company.ts から使うので、重い依存を持たない）。
 * game の評価・目標が無効な会社では、すべて従来の値になる（docs/30 §3・§4）。
 */

/** 不満がこの数以上の航空会社は、契約の更新で増便しない */
export const COMPLAINTS_BLOCK_INCREASE = 2;
/** 評価要素 slots の移動平均がこの値以上なら、増便の依頼に応じる満足度の下限が下がる（60 → 50） */
export const SLOTS_EMA_RELAX = 75;
export const SLOTS_RELAX_SAT = 10;
/** 評価要素 aircraft の移動平均がこの値未満の航空会社は、運航できない大型機の提案を出さない */
export const AIRCRAFT_EMA_LOW = 45;
/** 要望を達成した後の提案確率の倍率と、その期間（日） */
export const REQUEST_BOOST = 1.3;
export const REQUEST_BOOST_DAYS = 7;

export const complaintCount = (c: Pick<CompanyState, 'airlineEval'>, airlineId: string): number => c.airlineEval?.[airlineId]?.complaints.length ?? 0;

/** 増便の依頼に応じる満足度の下限の引き下げ幅（評価が無効なら 0） */
export function increaseMinSatRelief(c: Pick<CompanyState, 'airlineEval'>, airlineId: string): number {
  const slots = c.airlineEval?.[airlineId]?.ema.slots;
  return slots !== undefined && slots >= SLOTS_EMA_RELAX ? SLOTS_RELAX_SAT : 0;
}

/** 提案の確率の倍率（要望の達成・目標の報酬のブーストの積。評価・目標が無効なら 1） */
export function offerBoost(c: Pick<CompanyState, 'airlineEval' | 'goals' | 'day'>, airlineId: string): number {
  let m = 1;
  if ((c.airlineEval?.[airlineId]?.boostUntil ?? 0) > c.day) m *= REQUEST_BOOST;
  if ((c.goals?.boostUntil ?? 0) > c.day) m *= REQUEST_BOOST;
  return m;
}

export const aircraftIsLow = (c: Pick<CompanyState, 'airlineEval'>, airlineId: string): boolean => {
  const e = c.airlineEval?.[airlineId]?.ema.aircraft;
  return e !== undefined && e < AIRCRAFT_EMA_LOW;
};

/** 契約提案の 1 日の便数の上限への加算（空港の格。目標が無効なら 0） */
export const tierBonus = (c: Pick<CompanyState, 'goals'>): number => c.goals?.tier ?? 0;
