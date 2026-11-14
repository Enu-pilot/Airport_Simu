import { canMove, WALK_SPEED_MPS, type TerminalModel } from './model';

/**
 * 旅客の経路探索（エリアのグラフ上のダイクストラ）。
 * 区域の規則（保安検査を通らずに出発区域へ入れない等）と、閉鎖中のエリアを守る。
 */
export interface PaxRouteQuery {
  from: string;
  /** 目的地と到着時に加えるコスト（秒）。待ち時間の見込みなど */
  goals: Map<string, number>;
  closed?: ReadonlySet<string>;
  /**
   * 保安検査を通過していない出発旅客。保安検査場で並んでいる位置は一般区域側とみなし、
   * 一般区域へ戻ることはできるが、目的地の保安検査場以外の出発区域には入れない。
   */
  uncleared?: boolean;
  /** 階段を利用できない場合、階段エリアを経路から除外する。 */
  stepFree?: boolean;
}

export interface PaxRoute {
  /** 出発エリアを含むエリア列 */
  areas: string[];
  cost: number;
}

export function findPaxRoute(model: TerminalModel, q: PaxRouteQuery): PaxRoute | null {
  if (!model.areas[q.from]) return null;
  const dist = new Map<string, number>([[q.from, 0]]);
  const prev = new Map<string, string>();
  const done = new Set<string>();
  const open: string[] = [q.from];
  let best: { id: string; cost: number } | null = null;
  while (open.length > 0) {
    // エリア数は少ない（数十）ので線形探索で十分
    open.sort((a, b) => dist.get(a)! - dist.get(b)! || (a < b ? -1 : 1));
    const cur = open.shift()!;
    if (done.has(cur)) continue;
    done.add(cur);
    const c = dist.get(cur)!;
    if (best && c >= best.cost) break;
    const g = q.goals.get(cur);
    if (g !== undefined && (!best || c + g < best.cost)) best = { id: cur, cost: c + g };
    const node = model.areas[cur]!;
    for (const link of model.links[cur] ?? []) {
      const next = model.areas[link.to]!;
      if (q.closed?.has(next.id)) continue;
      if (q.stepFree && (node.kind === 'stairs' || next.kind === 'stairs')) continue;
      if (q.uncleared) {
        if (next.zone === 'departure' && !(next.kind === 'security' && q.goals.has(next.id))) continue;
        if (!(node.kind === 'security' && next.zone === 'landside') && !canMove(node, next)) continue;
      } else if (!canMove(node, next)) continue;
      const nc = c + link.lengthM / WALK_SPEED_MPS + link.travelSec;
      if (nc < (dist.get(next.id) ?? Infinity)) {
        dist.set(next.id, nc);
        prev.set(next.id, cur);
        open.push(next.id);
      }
    }
  }
  if (!best) return null;
  const areas = [best.id];
  while (prev.has(areas[0]!)) areas.unshift(prev.get(areas[0]!)!);
  return { areas, cost: best.cost };
}

/** 2エリア間のリンク */
export function linkBetween(model: TerminalModel, a: string, b: string) {
  return (model.links[a] ?? []).find((l) => l.to === b) ?? null;
}
