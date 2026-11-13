import type { CompanyState } from '../../core/economy/company';
import type { SimContext } from '../../core/sim/context';
import type { Disruption, DisruptionKind, SimEvent, SimState } from '../../core/sim/types';
import { BUS_SHORTAGE_ALERT_SEC } from '../../core/sim/busRules';
import { DISRUPTION_KIND_LABEL, OPS_UI, HOLD_REASON_LABEL, WEATHER_LABEL, displayName } from '../../i18n/ja';
import type { OverlayKey } from './opsUi';

/**
 * アラート（重要な出来事の整理）。現在の状態と直近の記録から導く純関数で、状態を変更しない。
 * 同じ種類・対象は 1 件にまとめて count を増やす。閉じたアラートの key は UI の状態に持つ（保存しない）。
 */
export type AlertSeverity = 'critical' | 'warning';
export type AlertAction = 'focus' | 'repair' | 'delay15' | 'reassign' | 'openPanel';
export type AlertTargetKind = 'aircraft' | 'runway' | 'stand' | 'area' | 'unit' | 'none';

export interface Alert {
  key: string;
  severity: AlertSeverity;
  /** 発生時刻（ゲーム内の秒） */
  t: number;
  title: string;
  count: number;
  target: { kind: AlertTargetKind; id: string | null };
  actions: AlertAction[];
  /** 'repair' の対象の障害 ID */
  disruptionId?: string;
  /** 'delay15' / 'reassign' の対象の便 ID */
  flightId?: string;
  /** 'openPanel' で開くオーバーレイ */
  panel?: OverlayKey;
}

/** 直近のイベントをアラートに含める時間（ゲーム内の秒） */
export const ALERT_EVENT_WINDOW_SEC = 10 * 60;
/** 待機・待ちを注意として扱うしきい値 */
export const ALERT_HOLD_SEC = 10 * 60;
export const ALERT_QUEUE_MIN = 20;
/** 同時に見せる最大件数 */
export const ALERT_VISIBLE = 3;

const CRITICAL_DISRUPTION: readonly DisruptionKind[] = ['runwayClosed'];
const SHOWN_DISRUPTION: readonly DisruptionKind[] = ['weather', 'runwayClosed', 'taxiwayClosed', 'standClosed', 'gateFailure', 'baggageFailure', 'vehicleFailure', 'maintenance', 'staffAbsence'];
const REPAIRABLE: readonly DisruptionKind[] = ['runwayClosed', 'taxiwayClosed', 'standClosed', 'gateFailure', 'baggageFailure', 'vehicleFailure', 'staffAbsence', 'maintenance'];

function targetKindOf(d: Disruption): AlertTargetKind {
  switch (d.kind) {
    case 'runwayClosed':
      return 'runway';
    case 'standClosed':
      return 'stand';
    case 'vehicleFailure':
      return 'unit';
    case 'taxiwayClosed':
    case 'gateFailure':
    case 'baggageFailure':
    case 'maintenance':
      return d.targetId ? 'area' : 'none';
    default:
      return 'none';
  }
}

export interface AlertResult {
  /** 閉じていないアラート（重大 → 注意、新しい順） */
  alerts: Alert[];
  /** 閉じたものを含む、現在成立しているアラートの key（閉じた key の掃除に使う） */
  keys: string[];
}

export function deriveAlerts(sim: { state: SimState; ctx: SimContext }, company: CompanyState | null | undefined, dismissed: readonly string[] = []): AlertResult {
  const { state, ctx } = sim;
  const layout = ctx.layout;
  const map = new Map<string, Alert>();
  const add = (a: Omit<Alert, 'count'>) => {
    const found = map.get(a.key);
    if (found) {
      found.count++;
      found.t = Math.max(found.t, a.t);
    } else map.set(a.key, { ...a, count: 1 });
  };
  const callsign = (id: string) => state.aircraft[id]?.callsign ?? id;

  // 発生中の障害
  for (const d of state.disruptions) {
    if (d.status !== 'active' || !SHOWN_DISRUPTION.includes(d.kind)) continue;
    const target = d.targetId;
    const label =
      d.kind === 'weather' ? `${DISRUPTION_KIND_LABEL.weather}: ${WEATHER_LABEL[d.weather ?? 'rain']}` : `${DISRUPTION_KIND_LABEL[d.kind]}${target ? `: ${displayName(layout, target)}` : ''}`;
    add({
      key: `disruption:${d.kind}:${target ?? d.weather ?? ''}`,
      severity: CRITICAL_DISRUPTION.includes(d.kind) ? 'critical' : 'warning',
      t: d.start,
      title: label,
      target: { kind: targetKindOf(d), id: target },
      actions: [...(targetKindOf(d) !== 'none' ? (['focus'] as const) : []), ...(REPAIRABLE.includes(d.kind) ? (['repair'] as const) : []), ...(d.kind === 'weather' ? (['openPanel'] as const) : [])],
      disruptionId: d.id,
      ...(d.kind === 'weather' ? { panel: 'disruptions' as const } : {}),
    });
  }

  // 直近のイベント（新しいものから）
  const since = state.now - ALERT_EVENT_WINDOW_SEC;
  for (let i = state.events.length - 1; i >= 0; i--) {
    const e: SimEvent = state.events[i]!;
    if (e.t < since) break;
    const ac = e.aircraftId ? state.aircraft[e.aircraftId] : undefined;
    switch (e.kind) {
      case 'diverted':
      case 'cannotOperate':
        if (ac) add({ key: `${e.kind}:${ac.id}`, severity: 'critical', t: e.t, title: `${ac.callsign} ${e.kind === 'diverted' ? 'ダイバート' : '運航不能'}${e.reason ? `（${HOLD_REASON_LABEL[e.reason]}）` : ''}`, target: { kind: 'aircraft', id: ac.id }, actions: ['focus'] });
        break;
      case 'conflict':
        if (ac) add({ key: `conflict:${ac.id}`, severity: 'critical', t: e.t, title: `競合検知: ${ac.callsign}${e.note ? ` と ${callsign(e.note)}` : ''}`, target: { kind: 'aircraft', id: ac.id }, actions: ['focus'] });
        break;
      case 'bagsLeftBehind':
        add({ key: 'bagsLeft', severity: 'warning', t: e.t, title: '手荷物の積み残し', target: { kind: 'none', id: null }, actions: ['openPanel'], panel: 'baggage' });
        break;
      case 'paxMissed':
        add({ key: 'paxMissed', severity: 'warning', t: e.t, title: '旅客の乗り遅れ', target: { kind: 'none', id: null }, actions: ['openPanel'], panel: 'terminal' });
        break;
      default:
        break;
    }
  }

  // 設備の停止
  for (const [key, eq] of Object.entries(state.equipment)) {
    if (eq.broken) add({ key: `equipment:${key}`, severity: 'warning', t: state.now, title: `設備停止: ${key.startsWith('belt:') ? `${displayName(layout, key.slice(5))} ベルト` : displayName(layout, key)}`, target: { kind: 'area', id: key.startsWith('belt:') ? key.slice(5) : key }, actions: ['focus', 'openPanel'], panel: 'ground' });
  }

  // 10 分以上の待機
  for (const ac of Object.values(state.aircraft)) {
    if (!ac.holdReason || ac.waitSince === null || state.now - ac.waitSince < ALERT_HOLD_SEC) continue;
    const beforeLanding = ac.state === 'scheduled' || ac.state === 'inbound' || ac.state === 'holding';
    const flightId = beforeLanding ? ac.arrivalFlightId : ac.departureFlightId;
    add({
      key: `hold:${ac.id}`,
      severity: 'warning',
      t: ac.waitSince,
      title: `${ac.callsign} 待機 ${Math.round((state.now - ac.waitSince) / 60)}分（${HOLD_REASON_LABEL[ac.holdReason]}）`,
      target: { kind: 'aircraft', id: ac.id },
      actions: ['focus', 'delay15', ...(beforeLanding ? (['reassign'] as const) : [])],
      flightId,
    });
  }

  // 保安検査の待ち（待ち人数 × 1 人あたりの処理時間 ÷ レーン数）
  for (const a of Object.values(ctx.terminal.areas)) {
    if (a.kind !== 'security' || state.closedAreas.includes(a.id)) continue;
    const fac = state.facilities[a.id];
    const props = layout.terminalAreas[a.id]?.props ?? {};
    const lanes = Math.max(1, Number(props.lanes ?? props.counters ?? 1));
    const sec = Math.max(1, Number(props.serviceSecPerPax ?? 30));
    const queued = (fac?.queue ?? []).reduce((s, id) => s + (state.paxGroups[id]?.count ?? 0), 0);
    const waitMin = (queued * sec) / lanes / 60;
    if (waitMin >= ALERT_QUEUE_MIN) add({ key: `queue:${a.id}`, severity: 'warning', t: state.now, title: `${displayName(layout, a.id).replace(/^\dF /, '')} の待ち 約${Math.round(waitMin)}分`, target: { kind: 'area', id: a.id }, actions: ['focus', 'openPanel'], panel: 'terminal' });
  }

  // ランプバス: 配車待ちが続く（不足）、走行中の故障（乗客が車内で救援待ち）
  if (state.bus) {
    let shortage = 0;
    for (const id of state.bus.active) {
      const t = state.bus.trips[id]!;
      if (!t.busId && t.phase === 'waiting' && state.now - t.createdAt >= BUS_SHORTAGE_ALERT_SEC) shortage++;
      if (t.phase === 'stalled') add({ key: `busStalled:${t.id}`, severity: 'critical', t: t.phaseSince, title: OPS_UI.alertBusStalled(t.pax), target: { kind: 'none', id: null }, actions: ['openPanel'], panel: 'ground' });
    }
    if (shortage > 0) add({ key: 'busShortage', severity: 'warning', t: state.now, title: OPS_UI.alertBusShortage(shortage), target: { kind: 'none', id: null }, actions: ['openPanel'], panel: 'ground' });
  }

  // 資金不足
  if (company && company.cash < 0 && !company.bankrupt) add({ key: 'cash', severity: 'critical', t: state.now, title: `資金不足 ${company.negativeDays}日目`, target: { kind: 'none', id: null }, actions: ['openPanel'], panel: 'finance' });

  const all = [...map.values()].sort((a, b) => (a.severity === b.severity ? b.t - a.t || (a.key < b.key ? -1 : 1) : a.severity === 'critical' ? -1 : 1));
  return { alerts: all.filter((a) => !dismissed.includes(a.key)), keys: all.map((a) => a.key) };
}
