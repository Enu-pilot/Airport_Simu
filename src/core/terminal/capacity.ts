import type { TerminalAreaKind } from '../model/types';

/** docs/12 の既定処理時間。配置済み施設は個別の serviceSecPerPax 設定を優先する。 */
export const DEFAULT_SERVICE_SEC_PER_PAX: Partial<Record<TerminalAreaKind, number>> = {
  checkIn: 50,
  security: 15,
  // フェーズ 4 §4.2: 出国審査 30 秒・入国審査 45 秒・税関 20 秒・乗継保安検査 15 秒
  emigration: 30,
  immigration: 45,
  customs: 20,
  transferSecurity: 15,
  // トイレ（5-21）: 施設処理 RESTROOM_SEC/2 = 90 秒/人 → 1 fixture あたり 40 人/時
  restroom: 90,
};

export function serviceSecPerPax(kind: TerminalAreaKind, props: Readonly<Record<string, unknown>>): number {
  const fallback = DEFAULT_SERVICE_SEC_PER_PAX[kind] ?? 30;
  const configured = props.serviceSecPerPax;
  return typeof configured === 'number' && Number.isFinite(configured) ? Math.max(1, configured) : fallback;
}

/** 処理系エリアか（docs/12 の既定処理時間があり、1人あたり処理時間が意味を持つ種別） */
export function isProcessingArea(kind: TerminalAreaKind): boolean {
  return DEFAULT_SERVICE_SEC_PER_PAX[kind] !== undefined;
}

/** エリアの窓口数。運航側（sim/passengers.ts の serversOf）と同じ数え方 */
export function areaServerCount(props: Readonly<Record<string, unknown>>): number {
  return Math.max(0, Number(props.counters ?? props.booths ?? props.lanes ?? props.fixtures ?? props.capacity ?? 0));
}

/** 処理能力（人/時）= 窓口数 × 3600 ÷ 1人あたり処理秒数。窓口がなければ 0 */
export function areaProcessingPerHour(kind: TerminalAreaKind, props: Readonly<Record<string, unknown>>): number {
  const servers = areaServerCount(props);
  if (servers <= 0) return 0;
  return Math.round((servers * 3600) / serviceSecPerPax(kind, props));
}
