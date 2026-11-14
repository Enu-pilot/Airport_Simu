import type { TerminalAreaKind } from '../model/types';

/** docs/12 の既定処理時間。配置済み施設は個別の serviceSecPerPax 設定を優先する。 */
export const DEFAULT_SERVICE_SEC_PER_PAX: Partial<Record<TerminalAreaKind, number>> = {
  checkIn: 50,
  security: 15,
};

export function serviceSecPerPax(kind: TerminalAreaKind, props: Readonly<Record<string, unknown>>): number {
  const fallback = DEFAULT_SERVICE_SEC_PER_PAX[kind] ?? 30;
  const configured = props.serviceSecPerPax;
  return typeof configured === 'number' && Number.isFinite(configured) ? Math.max(1, configured) : fallback;
}
