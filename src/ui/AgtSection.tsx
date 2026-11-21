import { agtSegmentCapacityPerHour, agtSegmentTravelSec, agtSegmentsAtStation, agtSystemOfStation } from '../core/model/agt';
import { deleteAgtSegment } from '../core/layout/operations';
import { agtStationConnectedAreas } from '../core/terminal/agt';
import { floorDisplayLabel } from '../core/model/levels';
import { actions, applyOp } from '../editor/store';
import type { AirportLayout, Facility } from '../core/model/types';

/**
 * AGT 駅のプロパティに出す節（機能I、design-GHIJ-detail.md §I.6）。
 * 系統の所属変更は汎用プロパティ（systemId）、ここでは系統の要約・接続セグメントの
 * 一覧と削除・接続ツールの起動を行う。運行設定の編集は Workspace の
 * 「ターミナル内交通」節が担う。
 */
export function AgtStationSection({ layout, station }: { layout: AirportLayout; station: Facility }) {
  const system = agtSystemOfStation(layout, station);
  const segments = agtSegmentsAtStation(layout, station.id);
  const connected = agtStationConnectedAreas(layout, station);
  return (
    <div className="agt-section" data-testid="agt-station-section">
      <div className="tool-group-title">
        <span>AGT（新交通システム）</span>
        <span className="tool-group-count">{segments.length} 本のセグメント</span>
      </div>
      <div className="muted small">
        {system ? (
          <>
            系統: <strong>{system.name || system.id}</strong>（定員 {system.vehicleCapacity} 人・間隔 {system.headwaySec} 秒・停車 {system.dwellSec} 秒・速度 {system.speedMps} m/s
            {system.buildState !== 'operational' ? '・未稼働' : ''}）
          </>
        ) : (
          '系統に所属していません（上の「所属する AGT 系統」で選んでください）'
        )}
        <br />
        接続エリア: {connected.length > 0 ? connected.map((id) => layout.terminalAreas[id]?.name || id).join('、') : 'なし（未接続の駅は経路に使われません）'}
      </div>
      {segments.map((seg) => {
        const otherId = seg.fromStationId === station.id ? seg.toStationId : seg.fromStationId;
        const other = layout.facilities[otherId];
        return (
          <div key={seg.id} className="muted small" data-testid={`agt-segment-${seg.id}`}>
            ⇔ {other?.name || otherId}（{seg.distanceM} m・{floorDisplayLabel(seg.level)}
            {system && <>・所要 {Math.round(agtSegmentTravelSec(system, seg))} 秒・容量 {agtSegmentCapacityPerHour(system)} 人/時</>}
            {seg.buildState !== 'operational' ? '・未稼働' : ''}）{' '}
            <button className="small danger" onClick={() => applyOp(deleteAgtSegment(layout, seg.id))} data-testid={`agt-segment-delete-${seg.id}`}>
              削除
            </button>
          </div>
        );
      })}
      <button
        className="small"
        onClick={() => {
          actions.setTool('agt');
          actions.setDraft({ kind: 'agt', fromStationId: station.id });
        }}
        data-testid="agt-connect-from-here"
      >
        この駅からセグメントを接続（続けて接続先の駅をクリック）
      </button>
    </div>
  );
}
