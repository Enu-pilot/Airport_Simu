import { OPS_NAV, OPS_NAV_GROUPS } from '../../i18n/ja';
import { opsUi, useOpsUi, type OverlayKey } from './opsUi';

/**
 * 運航モードの上部の 2 行目: 詳細・あまり使わないパネルのボタン列（data-testid は従来のタブと同じ `tab-<k>`）。
 * 運航表（flights）も含め、すべて大きなオーバーレイ（運航ボード）で開く。
 * 浮動の運航表は要約表示のみで、全列表示はボード側（FidsBoard）が担う（ユーザ決定C）。
 */
export function OpsNav() {
  const overlay = useOpsUi((s) => s.overlay);
  const labelOf = new Map(OPS_NAV.map(([k, label]) => [k, label]));
  // UX-5: 5 群の見出し付きで並べる。分類に無いキーは最後の群へ（取りこぼし防止）
  const grouped = new Set(OPS_NAV_GROUPS.flatMap(([, keys]) => keys));
  const rest = OPS_NAV.map(([k]) => k).filter((k) => !grouped.has(k));
  const groups = OPS_NAV_GROUPS.map(([title, keys], i) => [title, i === OPS_NAV_GROUPS.length - 1 ? [...keys, ...rest] : keys] as const);
  const button = (k: string) =>
    k === 'flights' ? (
      // 運航表ボタンは e2e が testid を直接使うため、リテラルのまま残す（中身は他のタブと同じくボードを開く）
      <button key={k} className={overlay === k ? 'tab active' : 'tab'} onClick={() => opsUi.toggleOverlay('flights')} data-testid="tab-flights">
        {labelOf.get(k)}
      </button>
    ) : (
      <button key={k} className={overlay === k ? 'tab active' : 'tab'} onClick={() => opsUi.toggleOverlay(k as OverlayKey)} data-testid={`tab-${k}`}>
        {labelOf.get(k)}
      </button>
    );
  return (
    <nav className="ops-nav" data-testid="ops-nav">
      {groups.map(([title, keys]) => (
        <span key={title} className="ops-nav-group" data-testid={`ops-nav-group-${title}`}>
          <span className="ops-nav-group-label">{title}</span>
          {keys.filter((k) => labelOf.has(k)).map(button)}
        </span>
      ))}
    </nav>
  );
}
