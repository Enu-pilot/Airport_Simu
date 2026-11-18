import type { CompanyState, Contract } from './company';

/**
 * 契約更新の先行き（5-04 / D2。表示のみ・運航や契約の判定は変えない）。
 * 航空会社の満足度と不満の継続日数から、更新の見込みを 3 段階で示す。
 */
export type RenewalLevel = 'stable' | 'watch' | 'risk';

export interface RenewalOutlook {
  /** 契約終了までの残り日数（過ぎていれば負） */
  daysLeft: number;
  level: RenewalLevel;
  /** 見込みの根拠（満足度・不満日数） */
  reason: string;
}

export const RENEWAL_LEVEL_LABEL: Record<RenewalLevel, string> = {
  stable: '更新見込み高',
  watch: '様子見',
  risk: '撤退リスク',
};

export function renewalOutlook(company: CompanyState, contract: Contract): RenewalOutlook {
  const daysLeft = contract.endDay - company.day;
  const a = company.airlines[contract.airlineId];
  const satisfaction = a?.satisfaction ?? 60;
  const lowDays = a?.lowDays ?? 0;
  let level: RenewalLevel = 'stable';
  if (satisfaction < 40 || lowDays >= 3) level = 'risk';
  else if (satisfaction < 60 || lowDays >= 1) level = 'watch';
  const reason = `満足度 ${Math.round(satisfaction)}${lowDays > 0 ? `・不満 ${lowDays} 日継続` : ''}`;
  return { daysLeft, level, reason };
}
