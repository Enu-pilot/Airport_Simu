import { useEditor } from '../../editor/store';
import { AircraftPanel } from '../OpsPanels';
import { PropertiesPanel } from '../PropertiesPanel';
import { opsUi, useOpsUi } from './opsUi';

/**
 * 下部: 選択中の機体（AircraftPanel）または施設（PropertiesPanel）の詳細。
 * 何も選んでいないときは細い帯に畳んで、マップを広く使う。
 */
export function OpsDetail() {
  const hasAircraft = useEditor((s) => !!s.ops?.selectedAircraft);
  const hasFacility = useEditor((s) => s.selection !== null);
  const collapsed = useOpsUi((s) => s.detailCollapsed);
  const has = hasAircraft || hasFacility;
  const open = has && !collapsed;
  return (
    <footer className={`ops-detail ${open ? 'open' : 'closed'}`} data-testid="ops-detail">
      <div className="ops-detail-bar">
        <span className="muted">{has ? (hasAircraft ? '選択中の機体' : '選択中の施設') : '機体・施設を選ぶと詳細がここに表示されます'}</span>
        {has && (
          <button className="small" onClick={() => opsUi.patch({ detailCollapsed: !collapsed })} data-testid="detail-fold">
            {collapsed ? '▴ 開く' : '▾ 畳む'}
          </button>
        )}
      </div>
      {open && <div className="ops-detail-body">{hasAircraft ? <AircraftPanel /> : <PropertiesPanel />}</div>}
    </footer>
  );
}
