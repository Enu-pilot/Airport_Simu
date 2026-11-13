/**
 * 日ごとの履歴の保持規則（純関数。保存先は editor 層）。
 *
 * - 現在の日（currentDay）より先の履歴は捨てる（戻ってやり直した別の経過の残り）。
 * - 直近 RECENT_DAYS 日（currentDay を含む）はすべて残す。
 * - それより古いものは WEEK_DAYS 日ごとの区間につき 1 件（区間の中で最も新しい日）、新しい区間から最大 MAX_WEEKLY 件。
 * 合計は 1 プロジェクトあたり最大 RECENT_DAYS + MAX_WEEKLY 件。
 */
export const HISTORY_RECENT_DAYS = 7;
export const HISTORY_WEEK_DAYS = 7;
export const HISTORY_MAX_WEEKLY = 8;

export function retainHistoryDays(days: readonly number[], currentDay: number): { keep: number[]; drop: number[] } {
  const uniq = [...new Set(days)].sort((a, b) => b - a);
  const keep: number[] = [];
  const drop: number[] = [];
  const seen = new Set<number>();
  for (const d of uniq) {
    const age = currentDay - d;
    if (age < 0) drop.push(d);
    else if (age < HISTORY_RECENT_DAYS) keep.push(d);
    else {
      const bucket = Math.floor((age - HISTORY_RECENT_DAYS) / HISTORY_WEEK_DAYS);
      if (!seen.has(bucket) && seen.size < HISTORY_MAX_WEEKLY) {
        seen.add(bucket);
        keep.push(d);
      } else drop.push(d);
    }
  }
  return { keep, drop };
}
