import { compareIds } from '../model/ids';
import type { WorkOrder } from '../economy/company';
import { addClosureReason, removeClosureReason, type ClosureKind } from './closureState';
import { engineerCount } from './overnight';
import type { Simulation } from './simulation';

/**
 * 5-25 Work Order の実施エンジン。
 * - 実施可能窓は夜間枠 23:00〜05:00（5-24 の夜間運用と同じ夜の定義に寄せる）。
 * - 進捗は「夜間枠内かつ必要整備士をその tick に確保できた」ときだけ進む。
 *   整備士プールは整備施設の engineers 合計（既存の正本）で、複数件は ID 順に確保する。
 *   機体の周期整備（Phase 4）は日次決済時のチェックで tick 単位の人員を消費しないため、
 *   ここでの確保と二重割当にはならない。
 * - 実施中だけ対象資産を一時閉鎖する（誘導路・スポット・ゲートは閉鎖理由台帳に
 *   `workorder:<id>` を積み、滑走路は runwayConfig の mode を 'closed' にして元 mode を
 *   Work Order 側に保持する）。窓を出る・整備士不足・完了のいずれでも閉鎖は解除される。
 */
export const WORK_ORDER_NIGHT_START_SEC = 23 * 3600;
export const WORK_ORDER_NIGHT_END_SEC = 5 * 3600;

export function isWorkOrderNight(now: number): boolean {
  const tod = now % 86400;
  return tod >= WORK_ORDER_NIGHT_START_SEC || tod < WORK_ORDER_NIGHT_END_SEC;
}

const CLOSURE_KIND: Record<Exclude<WorkOrder['assetKind'], 'runway'>, ClosureKind> = {
  taxiway: 'taxiways',
  stand: 'stands',
  gate: 'gates',
};

function applyClosure(sim: Simulation, wo: WorkOrder): void {
  if (wo.assetKind === 'runway') {
    const cfg = sim.state.runwayConfig[wo.assetId];
    if (cfg && cfg.mode !== 'closed') {
      wo.prevRunwayMode = cfg.mode;
      cfg.mode = 'closed';
    }
  } else {
    addClosureReason(sim.state, CLOSURE_KIND[wo.assetKind], wo.assetId, `workorder:${wo.id}`);
  }
}

/** 閉鎖を解除する（完了・中断・延期・削除時に呼ぶ） */
export function releaseWorkOrderClosure(sim: Simulation, wo: WorkOrder): void {
  if (wo.assetKind === 'runway') {
    const cfg = sim.state.runwayConfig[wo.assetId];
    if (cfg && wo.prevRunwayMode !== undefined) {
      const heldByDisruption = sim.state.disruptions.some(
        (d) => d.status === 'active' && d.targetId === wo.assetId && (d.kind === 'runwayClosed' || d.kind === 'maintenance'),
      );
      if (!heldByDisruption) cfg.mode = wo.prevRunwayMode as typeof cfg.mode;
      delete wo.prevRunwayMode;
    }
  } else {
    removeClosureReason(sim.state, CLOSURE_KIND[wo.assetKind], wo.assetId, `workorder:${wo.id}`);
  }
}

/** 1 tick 分の進行（stepSimulation から毎 tick 呼ばれる。Work Order が無ければ即戻る） */
export function stepWorkOrders(sim: Simulation): void {
  const c = sim.company;
  if (!c?.workOrders) return;
  const orders = Object.values(c.workOrders)
    .filter((w) => w.status === 'planned' || w.status === 'active')
    .sort((a, b) => compareIds(a.id, b.id));
  if (!orders.length) return;
  const night = isWorkOrderNight(sim.state.now);
  let pool = engineerCount(sim);
  for (const wo of orders) {
    if (wo.status === 'planned') {
      if (!night) continue;
      wo.status = 'active';
    }
    if (night && pool >= wo.engineers) {
      pool -= wo.engineers;
      applyClosure(sim, wo);
      wo.progressMin += 1 / 60;
      if (wo.progressMin >= wo.durationMin - 1e-9) {
        wo.progressMin = wo.durationMin;
        wo.status = 'done';
        releaseWorkOrderClosure(sim, wo);
      }
    } else {
      releaseWorkOrderClosure(sim, wo);
    }
  }
}
