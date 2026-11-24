import { useMemo } from 'react';
import { actions, useAnalysis, useEditor, useLayout, type Overlays } from '../../editor/store';
import { useCompany } from '../ManagementPanels';
import { HEAT_LEGEND, SHELL_UI } from '../../i18n/ja';
import { keyForOverlayToggle } from '../../editor/shortcuts';
import type { MainPage } from './TopBar';
import { sharedAttentionItems } from '../attentionShared';

/**
 * UIデザイン更新 第1段階: 左端レール（ワークスペース骨格）。
 * レンズ切替の入口と、要対応インボックスへの入口（件数バッジ）を置く。
 * 第2段階: オーバーレイ切替をトップバーからこのレールのレイヤーポップオーバーへ集約し、
 * 要対応ボタンは建設レンズの左パネル「要対応」タブ（インボックス）を開くようにした。
 */

const HeatLegend = () => (
  <div className="overlay-legend" data-testid="congestion-legend">
    <span>{HEAT_LEGEND.title}</span>
    <span><i style={{ background: '#3ccf6e' }} />{HEAT_LEGEND.low}</span>
    <span><i style={{ background: '#ffc23d' }} />{HEAT_LEGEND.mid}</span>
    <span><i style={{ background: '#ff4d4f' }} />{HEAT_LEGEND.high}</span>
  </div>
);

const OVERLAY_LABEL: Record<keyof Overlays, string> = {
  grid: 'グリッド',
  interior: 'ターミナル内部',
  buildable: '建設不可エリア',
  network: '論理ネットワーク・予約',
  issues: 'エラー表示',
  labels: 'ラベル',
  flightNames: '便名',
  busPax: 'バスの人数',
  cargoCounts: '貨物数',
  congestion: '混雑マップ',
  daylight: '昼夜表現',
};

/** 運航中の地図注記だけを切り替える項目（建設モードでは表示しない） */
const OPERATE_ONLY_OVERLAYS: readonly (keyof Overlays)[] = ['daylight', 'flightNames', 'busPax', 'cargoCounts'];

export function Rail({ page, setPage, onOpenAtc }: { page: MainPage; setPage: (p: MainPage) => void; onOpenAtc: () => void }) {
  const mode = useEditor((s) => s.mode);
  const overlays = useEditor((s) => s.overlays);
  const layout = useLayout();
  const analysis = useAnalysis();
  const company = useCompany();
  const uiVersion = useEditor((s) => s.ops?.uiVersion ?? -1);
  const attentionCount = useMemo(
    () => sharedAttentionItems(layout, analysis, company, uiVersion).length,
    // uiVersion は運航中の閉鎖・故障（F6-04）の変化をバッジへ反映するための購読
    [layout, analysis, company, uiVersion],
  );
  const overlayKeys = (Object.keys(OVERLAY_LABEL) as (keyof Overlays)[]).filter((k) => mode === 'operate' || !OPERATE_ONLY_OVERLAYS.includes(k));
  const lensBtn = (target: MainPage, label: string, testid: string) => (
    <button
      className={`rail-btn ${page === target ? 'active' : ''}`}
      onClick={() => setPage(target)}
      data-testid={testid}
      aria-pressed={page === target}
      title={target === 'construction' && mode === 'operate' ? '運航中は閲覧専用です。建設するには運航を終了してください' : undefined}
    >
      {target === 'construction' && mode === 'operate' ? '建設（閲覧）' : label}
    </button>
  );
  return (
    <nav className="shell-rail" aria-label="ワークスペース" data-testid="shell-rail">
      <button
        className="rail-btn rail-attention"
        onClick={() => { setPage('construction'); actions.setBuildPanel('inbox'); }}
        title={SHELL_UI.railAttentionTitle(attentionCount)}
        data-testid="rail-attention"
      >
        <span>{SHELL_UI.railAttention}</span>
        {attentionCount > 0 && <span className="rail-badge" data-testid="rail-attention-count">{attentionCount}</span>}
      </button>
      {lensBtn('construction', SHELL_UI.railBuild, 'rail-build')}
      {lensBtn('management', SHELL_UI.railManage, 'rail-manage')}
      {/* 運行ボタンはトップバーと同じ挙動（建設モードでは運航開始ボタンが担うため、レールからは運航中だけ有効） */}
      <button
        className={`rail-btn ${page === 'operations' ? 'active' : ''}`}
        onClick={() => { if (mode === 'operate') setPage('operations'); }}
        disabled={mode !== 'operate'}
        title={mode !== 'operate' ? '運航はトップバーの「運行開始」から始めます' : undefined}
        data-testid="rail-operate"
        aria-pressed={page === 'operations'}
      >
        {SHELL_UI.railOperate}
      </button>
      <button className="rail-btn" onClick={onOpenAtc} disabled={mode === 'operate'} title={mode === 'operate' ? '運航中は管制官モードへ移れません（モードを同時に進行させないため）。建設モードに戻ってから開いてください' : '管制官モード（ATC）を開きます。経営モードの状態は変更されません'} data-testid="rail-atc">
        {SHELL_UI.railAtc}
      </button>
      {/* レイヤーポップオーバー: マップのオーバーレイ切替（旧トップバーの表示切替を集約。混雑マップの凡例も同居） */}
      <details className="overlays-pop rail-layers" data-testid="overlays-pop">
        <summary title={SHELL_UI.railLayersTitle}>{SHELL_UI.railLayers}</summary>
        <div className="overlays-menu">
          {overlayKeys.map((k) => {
            const shortcutKey = keyForOverlayToggle(mode, k);
            return (
              <label key={k}>
                <input type="checkbox" checked={overlays[k]} onChange={() => actions.toggleOverlay(k)} data-testid={`overlay-${k}`} />
                {OVERLAY_LABEL[k]}
                {shortcutKey && <span className="muted small">（{shortcutKey.toUpperCase()} キー）</span>}
              </label>
            );
          })}
          {overlays.congestion && <HeatLegend />}
        </div>
      </details>
    </nav>
  );
}
