import { OPS_NAV } from '../../i18n/ja';
import { opsUi, useOpsUi, type OverlayKey } from './opsUi';

/**
 * 運航モードの上部の 2 行目: 詳細・あまり使わないパネルのボタン列（data-testid は従来のタブと同じ `tab-<k>`）。
 * 運航表（flights）も含め、すべて大きなオーバーレイ（運航ボード）で開く。
 * 浮動の運航表は要約表示のみで、全列表示はボード側（FidsBoard）が担う（ユーザ決定C）。
 */
export function OpsNav() {
  const overlay = useOpsUi((s) => s.overlay);
  return (
    <nav className="ops-nav" data-testid="ops-nav">
      {OPS_NAV.map(([k, label]) =>
        k === 'flights' ? (
          // 運航表ボタンは e2e が testid を直接使うため、リテラルのまま残す（中身は他のタブと同じくボードを開く）
          <button key={k} className={overlay === k ? 'tab active' : 'tab'} onClick={() => opsUi.toggleOverlay('flights')} data-testid="tab-flights">
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
