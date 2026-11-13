import { OPS_NAV } from '../../i18n/ja';
import { opsUi, useOpsUi, type OverlayKey } from './opsUi';

/**
 * 運航モードの上部の 2 行目: 詳細・あまり使わないパネルのボタン列（data-testid は従来のタブと同じ `tab-<k>`）。
 * 運航表（flights）は別の表を開かず、マップ右上の運航表を全列表示に切り替える。他は大きなオーバーレイで開く。
 */
export function OpsNav() {
  const overlay = useOpsUi((s) => s.overlay);
  const full = useOpsUi((s) => s.fidsFull);
  return (
    <nav className="ops-nav" data-testid="ops-nav">
      {OPS_NAV.map(([k, label]) =>
        k === 'flights' ? (
          <button
            key={k}
            className={full ? 'tab active' : 'tab'}
            onClick={() => opsUi.patch({ fidsFull: !full, fidsCollapsed: false })}
            title="運航表を全列表示に切り替えます"
            data-testid="tab-flights"
          >
            {label}
          </button>
        ) : (
          <button key={k} className={overlay === k ? 'tab active' : 'tab'} onClick={() => opsUi.toggleOverlay(k as OverlayKey)} data-testid={`tab-${k}`}>
            {label}
          </button>
        ),
      )}
    </nav>
  );
}
