import type { AirportLayout, Facility } from './types';

/**
 * ゲートの搭乗方式・接続先、GSE 基地のランプバス台数の読み取り（純関数）。
 * 新しいプロパティは欠落 = 従来どおり（DEFAULT_PROPS は変えない）なので、必ずここを通して読む。
 */
export type GateMode = 'contact' | 'bus';

/** 搭乗方式。欠落・不明な値は 'contact'（従来） */
export function gateMode(f: Facility): GateMode {
  return f.kind === 'gate' && f.props.boardingMode === 'bus' ? 'bus' : 'contact';
}

/** 明示の接続先ターミナルの ID。欠落・null・存在しない・ターミナルでない場合は null（= 隣接で決まる従来の扱い） */
export function connectedTerminal(f: Facility, layout: AirportLayout): string | null {
  if (f.kind !== 'gate') return null;
  const id = f.props.connectedTo;
  if (typeof id !== 'string') return null;
  return layout.facilities[id]?.kind === 'terminal' ? id : null;
}

/** GSE 基地のランプバス台数（欠落 = 0） */
export function apronBusesOf(f: Facility): number {
  const n = f.kind === 'gseBase' ? f.props.apronBuses : 0;
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}
