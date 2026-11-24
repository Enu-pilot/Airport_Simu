import { canMove, linkCostSec, type TerminalModel } from './model';

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
  /**
   * 他の建物群を経由する経路を禁止する（2026-11-24 PO 決定、docs/10 R-07）。値はターミナル ID → 所属する建物群（サービス複合体:
   * 運用中リンク・隣接でつながった建物の集合。terminal/serviceComplex.ts）の代表 ID。出発エリアの建物群を O として、
   * 移動は O 内・O→X・X 内だけを許し、X→Y（第三の建物群の通り抜け）と X→O（戻り）は通さない。
   * これにより経路の建物群は常に「出発」と「目的地」の 2 つ以内に収まり、不変条件 P6（建物群単位）と一致する。
   * 連絡でつながった建物群の中の移動は従来どおり。
   */
  complexOf?: ReadonlyMap<string, string>;
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
  const complexOfArea = (areaId: string): string => {
    const t = model.areas[areaId]!.terminalId;
    return q.complexOf?.get(t) ?? t;
  };
  const originComplex = q.complexOf ? complexOfArea(q.from) : undefined;
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
      // 出発の建物群を出た後は、入った建物群の中だけを進む（第三の建物群の通り抜け・出発の建物群への戻りを禁止）
      if (q.complexOf) {
        const cn = complexOfArea(node.id);
        if (cn !== originComplex && complexOfArea(next.id) !== cn) continue;
      }
      if (q.uncleared) {
        // フェーズ 4 §4.4: 保安検査を済ませていないグループは security・transferSecurity 以外から出発区域へ入れない
        if ((next.zone === 'departure' || next.zone === 'departureIntl') && !((next.kind === 'security' || next.kind === 'transferSecurity') && q.goals.has(next.id))) continue;
        if (!(node.kind === 'security' && next.zone === 'landside') && !canMove(node, next)) continue;
      } else if (!canMove(node, next)) continue;
      const nc = c + linkCostSec(link);
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

/* ------------------------------------------------------------------ */
/* 旅客接続の3状態判定（5-13）                                          */
/* ------------------------------------------------------------------ */

export type PaxConnectionStatus = 'operational' | 'underConstruction' | 'unreachable';

export interface PaxConnection {
  status: PaxConnectionStatus;
  /** 現在通行できる経路（operational のときのみ）。実際に旅客を歩かせてよいのはこれだけ */
  route: PaxRoute | null;
  /** 建設完了後に成立する経路（underConstruction のときのみ）。診断専用で、旅客に設定してはならない */
  futureRoute: PaxRoute | null;
}

/**
 * 起点から目的地までの接続を3状態で判定する。
 * current は operational のみのモデル、future は underConstruction も含むモデル
 * （buildTerminalModel(layout, { includeUnderConstruction: true })）。
 * 運用中の迂回路があれば、建設中設備が別にあっても operational を優先する。
 * planned のリンクはどちらのモデルにも含まれないため「完成待ち」にはならない。
 */
export function classifyPaxConnection(current: TerminalModel, future: TerminalModel, q: PaxRouteQuery): PaxConnection {
  const route = findPaxRoute(current, q);
  if (route) return { status: 'operational', route, futureRoute: null };
  const futureRoute = findPaxRoute(future, q);
  if (futureRoute) return { status: 'underConstruction', route: null, futureRoute };
  return { status: 'unreachable', route: null, futureRoute: null };
}
