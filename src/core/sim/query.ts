import type { Vec2 } from '../geometry/vec';
import { AIRCRAFT_TYPES } from './aircraftTypes';
import type { Aircraft, SimState } from './types';

/** 表示対象の機体（空域・地上にいるもの。出発後しばらくまで） */
export function isVisible(ac: Aircraft): boolean {
  if (ac.state === 'scheduled' || ac.state === 'diverted' || ac.state === 'cannotOperate') return false;
  if (ac.state === 'departed') return ac.route !== null;
  return true;
}

/** 世界座標の点に最も近い機体（機体の大きさ程度の範囲内） */
export function aircraftAt(state: SimState, world: Vec2): string | null {
  // 機体位置はタイル番号空間（タイル中心が整数）
  const p = { x: world.x - 0.5, y: world.y - 0.5 };
  let best: { id: string; d: number } | null = null;
  for (const ac of Object.values(state.aircraft)) {
    if (!isVisible(ac)) continue;
    const r = Math.max(0.8, AIRCRAFT_TYPES[ac.typeId].wingspanM / 25 / 2 + 0.3);
    const d = Math.hypot(ac.x - p.x, ac.y - p.y);
    if (d <= r && (!best || d < best.d)) best = { id: ac.id, d };
  }
  return best?.id ?? null;
}
