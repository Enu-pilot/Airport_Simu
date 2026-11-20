import { useEditor } from '../../editor/store';
import { AircraftPanel } from '../OpsPanels';
import { PropertiesPanel } from '../PropertiesPanel';
import { opsUi, useOpsUi } from './opsUi';

/**
 * 右インスペクタ（UIデザイン更新 第4段階で下部詳細帯から移行）:
 * 選択中の機体（AircraftPanel）または施設（PropertiesPanel）の詳細を、運航レンズの
 * 右列の先頭に建設レンズのインスペクタと同じ置き方で出す（運航中は読み取り専用）。
 * 何も選んでいないときは細い帯に畳んで、右列をカードに譲る。
 * 狭い画面（右列を畳む幅）では、選択があるときだけ右列が重ね表示になる（operate.css）。
 */
export function OpsDetail() {
  const hasAircraft = useEditor((s) => !!s.ops?.selectedAircraft);
  const hasFacility = useEditor((s) => s.selection !== null);
  const collapsed = useOpsUi((s) => s.detailCollapsed);
  const has = hasAircraft || hasFacility;
  const open = has && !collapsed;
  return (
    <section className={`ops-detail ${open ? 'open' : 'closed'}${has ? ' has-selection' : ''}`} data-testid="ops-detail">
      <div className="ops-detail-bar">
        <span className="muted">{has ? (hasAircraft ? '選択中の機体' : '選択中の施設') : '機体・施設を選ぶと詳細がここに表示されます'}</span>
        {has && (
          <button className="small" onClick={() => opsUi.patch({ detailCollapsed: !collapsed })} data-testid="detail-fold">
            {collapsed ? '▴ 開く' : '▾ 畳む'}
          </button>
        )}
      </div>
      {open && <div className="ops-detail-body">{hasAircraft ? <AircraftPanel /> : <PropertiesPanel />}</div>}
    </section>
  );
}
