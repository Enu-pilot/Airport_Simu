import { useMemo } from 'react';
import { getAtcNetwork } from '../../core/atc/index';
import type { AtcAirportSnapshot, AtcSessionState } from '../../core/atc/index';

/**
 * ATC-08: レーダー風マップ（ATC画面内で完結する軽量 SVG 描画）。
 * 経営側 render には依存せず、スナップショットから再構築した
 * airside ネットワーク（滑走路・誘導路・スポット）と航空機の現在位置を描く。
 * 位置の正本はセッション状態（position）であり、ここでは表示だけを行う。
 */

interface Props {
  airport: AtcAirportSnapshot;
  session: AtcSessionState;
  selectedAircraftId: string | null;
  onSelect: (aircraftId: string) => void;
}

export function RadarMap({ airport, session, selectedAircraftId, onSelect }: Props) {
  const network = useMemo(() => getAtcNetwork(airport), [airport]);
  const { width, height } = airport.layout.site;

  const edges = useMemo(() => Object.values(network.edges), [network]);
  const standNodes = useMemo(
    () => Object.values(network.nodes).filter((n) => n.kind === 'stand'),
    [network],
  );
  const holdNodes = useMemo(
    () => Object.values(network.nodes).filter((n) => n.holdShort),
    [network],
  );

  const aircraft = Object.values(session.aircraft).sort((a, b) => (a.id < b.id ? -1 : 1));
  // 上空（位置なし）の到着機はマップ上端に待機列として描く
  const airborne = aircraft.filter((a) => a.position === null);
  const airborneIndex = new Map(airborne.map((a, i) => [a.id, i]));

  const selected = selectedAircraftId ? session.aircraft[selectedAircraftId] : undefined;
  const routePoints = (nodeIds: string[] | undefined): string =>
    (nodeIds ?? [])
      .map((id) => network.nodes[id])
      .filter((n) => n !== undefined)
      .map((n) => `${n.pos.x},${n.pos.y}`)
      .join(' ');

  return (
    <svg
      className="atc-map"
      viewBox={`-4 -4 ${width + 8} ${height + 8}`}
      role="img"
      aria-label="管制レーダーマップ"
      data-testid="atc-map"
    >
      <rect x={-4} y={-4} width={width + 8} height={height + 8} className="atc-map-bg" />
      {/* 誘導路・滑走路・スポット接続 */}
      {edges.map((e) => {
        const a = network.nodes[e.from];
        const b = network.nodes[e.to];
        if (!a || !b) return null;
        return (
          <line
            key={e.id}
            x1={a.pos.x}
            y1={a.pos.y}
            x2={b.pos.x}
            y2={b.pos.y}
            className={`atc-edge atc-edge-${e.kind}${e.operational ? '' : ' atc-edge-closed'}`}
          />
        );
      })}
      {/* スポット */}
      {standNodes.map((n) => (
        <g key={n.id}>
          <rect x={n.pos.x - 1.7} y={n.pos.y - 1.2} width={3.4} height={2.4} className="atc-stand" />
          <text x={n.pos.x} y={n.pos.y + 0.7} className="atc-stand-label">
            {n.standIds[0] ?? ''}
          </text>
        </g>
      ))}
      {/* 滑走路名 */}
      {Object.entries(network.runwayNodes).map(([runwayId, nodeIds]) => {
        const first = nodeIds[0] ? network.nodes[nodeIds[0]] : undefined;
        if (!first) return null;
        return (
          <text key={runwayId} x={first.pos.x} y={first.pos.y - 1.6} className="atc-runway-label">
            RWY {airport.layout.runways[runwayId]?.name ?? runwayId}
          </text>
        );
      })}
      {/* ホールディングポイント */}
      {holdNodes.map((n) => (
        <circle key={n.id} cx={n.pos.x} cy={n.pos.y} r={0.55} className="atc-hold-node" />
      ))}
      {/* 選択機の経路（実行中経路と走行前の再計画経路） */}
      {selected?.movement && (
        <polyline points={routePoints(selected.movement.nodeIds)} className="atc-route-active" />
      )}
      {selected?.plannedRoute && (
        <polyline points={routePoints(selected.plannedRoute.nodeIds)} className="atc-route-planned" />
      )}
      {/* 横断ゲートの停止位置（選択機） */}
      {(selected?.movement?.crossings ?? [])
        .filter((c) => c.status === 'waiting')
        .map((c) => {
          const n = network.nodes[c.holdNodeId];
          if (!n) return null;
          return (
            <rect
              key={c.requestId}
              x={n.pos.x - 1}
              y={n.pos.y - 1}
              width={2}
              height={2}
              className="atc-crossing-gate"
            />
          );
        })}
      {/* 航空機 */}
      {aircraft.map((a) => {
        const idx = airborneIndex.get(a.id);
        const x = a.position ? a.position.x : 5 + (idx ?? 0) * 9;
        const y = a.position ? a.position.y : 2.5;
        const isSelected = a.id === selectedAircraftId;
        const blocked = a.movement?.held === true;
        return (
          <g
            key={a.id}
            className={`atc-plane${isSelected ? ' atc-plane-selected' : ''}`}
            onClick={() => onSelect(a.id)}
            data-testid={`atc-plane-${a.id}`}
          >
            <circle
              cx={x}
              cy={y}
              r={isSelected ? 1.7 : 1.25}
              className={`atc-plane-dot atc-plane-${a.kind}${blocked ? ' atc-plane-held' : ''}${a.position === null ? ' atc-plane-airborne' : ''}`}
            />
            <text x={x + 2} y={y + 0.9} className="atc-plane-label">
              {a.callsign}
              {a.position === null ? '（上空）' : ''}
              {blocked ? '（停止中）' : ''}
            </text>
          </g>
        );
      })}
      {aircraft.length === 0 && (
        <text x={width / 2} y={height / 2} className="atc-map-empty">
          航空機はまだ出現していません（再生するとシナリオ時刻に出現します）
        </text>
      )}
    </svg>
  );
}
