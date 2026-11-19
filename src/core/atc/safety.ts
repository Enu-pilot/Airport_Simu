import { buildAirsideNetwork } from '../airside/network';
import { effectiveArrivalSequence } from './assignments';
import { diagnoseAtcAirport } from './scenario';
import type {
  AtcRequestKind,
  AtcSafetyProvider,
  AtcSafetyReasonCode,
  AtcSafetyVerdict,
} from './types';

/**
 * ATC-05 既定の安全判定（セッション内判定）。
 *
 * 滑走路の物理占有・予約の正本は、ATC-04 の共通カーネル抽出までは
 * 「セッション内の航空機の段階 + 実行中/復唱済み指示」とする。
 * これは simulation.ts の runwayControl を複製したものではなく、
 * ATC セッション単独で閉じた占有モデルであり、抽出後は
 * AtcSafetyProvider の差し替えで共通カーネルへ寄せる。
 *
 * ハード制約は deny を返し、管制官が強行することはできない（計画 §3.5）。
 */

const RUNWAY_KINDS: ReadonlySet<AtcRequestKind> = new Set([
  'landing',
  'lineUp',
  'takeoff',
  'runwayCrossing',
]);

export function createSessionSafetyProvider(): AtcSafetyProvider {
  return {
    check({ session, airport, aircraft, kind, runwayId }) {
      const reasons: AtcSafetyReasonCode[] = [];
      let warn = false;
      const layout = airport.layout;
      const targetRunwayId = runwayId ?? aircraft.runwayId;

      if (kind === 'pushback' || kind === 'taxiOut' || kind === 'taxiIn') {
        const stand = layout.stands[aircraft.standId];
        if (!stand) reasons.push('stand-not-found');
        else if (stand.buildState !== 'operational') reasons.push('stand-not-operational');
        else {
          const diag = diagnoseAtcAirport(airport);
          if (!diag.connectedStandIds.includes(aircraft.standId)) {
            reasons.push('stand-not-connected');
          }
        }
      }

      if (RUNWAY_KINDS.has(kind)) {
        const runway = layout.runways[targetRunwayId];
        if (!runway) reasons.push('runway-not-found');
        else if (runway.buildState !== 'operational') reasons.push('runway-not-operational');

        for (const other of Object.values(session.aircraft)) {
          if (other.id === aircraft.id || other.runwayId !== targetRunwayId) continue;
          if (
            other.phase === 'lineUp' ||
            other.phase === 'takeoffRoll' ||
            other.phase === 'landingRoll' ||
            other.phase === 'finalApproach'
          ) {
            reasons.push('runway-occupied');
            break;
          }
        }
        // 位置ベースの占有（ATC-06/07 物理移動）: 着陸後に滑走路上を
        // 走行中（taxiIn で滑走路ノード上に位置する）機体も占有とみなす。
        // 段階だけでは「滑走路を離脱し終えたか」を表せないため、位置を正とする。
        if (!reasons.includes('runway-occupied')) {
          const net = buildAirsideNetwork(layout);
          for (const other of Object.values(session.aircraft)) {
            if (other.id === aircraft.id || other.runwayId !== targetRunwayId) continue;
            if (other.phase !== 'taxiIn' || !other.position) continue;
            const node = net.nodes[other.position.nodeId];
            if (node && node.runwayIds.includes(targetRunwayId)) {
              reasons.push('runway-occupied');
              break;
            }
          }
        }
        if (reasons.length === 0) {
          for (const c of Object.values(session.clearances)) {
            if (c.aircraftId === aircraft.id) continue;
            if (c.runwayId !== targetRunwayId) continue;
            if (c.status === 'issued' || c.status === 'readback' || c.status === 'executing') {
              reasons.push('runway-reserved');
              break;
            }
          }
        }
        // 到着順序制約（ATC-07）: 管制官が到着順序を設定している場合だけ効く。
        // 実効順序で自機より前にいる同滑走路の到着機が、まだ進入前/進入中
        // （着陸・復行・順序からの除外で解消していない）なら着陸許可を拒否する。
        // 順序未指定（空）なら従来どおり制約なし（後方互換）。
        if (kind === 'landing' && (session.arrivalSequence ?? []).length > 0) {
          const sequence = effectiveArrivalSequence(session);
          const idx = sequence.indexOf(aircraft.id);
          if (idx > 0) {
            const blocked = sequence.slice(0, idx).some((id) => {
              const ahead = session.aircraft[id];
              return (
                ahead !== undefined &&
                ahead.runwayId === targetRunwayId &&
                (ahead.phase === 'inbound' || ahead.phase === 'finalApproach')
              );
            });
            if (blocked) reasons.push('arrival-sequence-blocked');
          }
        }
        // 離陸許可時に同滑走路へ向かう到着機がいる場合は警告（拒否はしない）
        if (kind === 'takeoff' && reasons.length === 0) {
          const inbound = Object.values(session.aircraft).some(
            (o) =>
              o.id !== aircraft.id &&
              o.kind === 'arrival' &&
              o.runwayId === targetRunwayId &&
              (o.phase === 'inbound' || o.phase === 'finalApproach'),
          );
          if (inbound) {
            warn = true;
            reasons.push('arrival-inbound-same-runway');
          }
        }
      }

      const hard = reasons.filter((r) => r !== 'arrival-inbound-same-runway');
      if (hard.length > 0) {
        const verdict: AtcSafetyVerdict = { verdict: 'deny', reasons: hard };
        return verdict;
      }
      if (warn) return { verdict: 'warn', reasons };
      return { verdict: 'allow', reasons: [] };
    },
  };
}
