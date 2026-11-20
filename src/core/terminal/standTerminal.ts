import type { SimContext } from '../sim/context';
import { resolveBusGateForStand } from './busGateAssignment';

/**
 * スポットが属するターミナル（施設 ID）を返す。航空会社の使用ターミナル制限の判定に使う、
 * 計画（planning.ts の assignments.terminalId）と同じ決定規則:
 * - コンタクトスポットは付属ゲートの所属ターミナルで決まる
 * - リモートスポットは所属ターミナルの明示指定（Stand.terminalId）を優先し、
 *   なければバスゲート決定規則（resolveBusGateForStand: 運航・計画・検証で共通）の所属に従う
 * - どちらでも決まらず、ターミナルが 1 つしかない空港ではそのターミナル（計画と同じフォールバック）
 * 決まらない場合は null（制限がある便では「許可されたターミナルと確認できない」として扱う）。
 */
export type StandTerminalContext = Pick<SimContext, 'layout' | 'terminal' | 'standGate' | 'busGates' | 'paxTerminal' | 'network' | 'stands'>;

export function standTerminalId(ctx: StandTerminalContext, standId: string, closedGateIds: readonly string[] = []): string | null {
  const gateId = ctx.standGate[standId];
  if (gateId) return ctx.terminal.gates[gateId]?.terminalId ?? null;
  const stand = ctx.layout.stands[standId];
  if (!stand) return null;
  if (stand.terminalId) return stand.terminalId;
  if (!ctx.stands[standId]?.contact) {
    const point = ctx.network.nodes[ctx.stands[standId]?.node ?? '']?.pos ?? null;
    const bus = resolveBusGateForStand(ctx.layout, ctx.terminal, standId, point, ctx.busGates, closedGateIds);
    if (bus.terminalId) return bus.terminalId;
  }
  if (stand.remoteBoarding === undefined && ctx.busGates.length === 0 && Object.keys(ctx.terminal.byTerminal).length === 1) {
    return ctx.paxTerminal;
  }
  return null;
}
