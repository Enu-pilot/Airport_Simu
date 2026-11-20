import { useMemo } from 'react';
import { actions, useEditor, useLayout, type ToolId } from '../editor/store';
import { terminalServiceComplexes } from '../core/terminal/serviceComplex';
import { terminalCapacitySummaries } from '../core/terminal/terminalCapacitySummary';
import { terminalFloorSummary } from '../core/terminal/terminalFloorSummary';
import { TERMINAL_AREA_MIN_LEVEL } from '../core/layout/levelRules';
import { facilityLevel, floorDisplayLabel } from '../core/model/levels';
import { featureForAreaKind, lockLabel } from '../core/economy/unlocks';
import type { TerminalAreaKind } from '../core/model/types';
import { AREA_KIND_LABEL, FACILITY_LABEL } from '../i18n/ja';

/**
 * ターミナル専用設計 Workspace（5-18 T2/T3/T5 の核）: 建設レンズの左パネルを差し替える。
 * 編集そのものは従来どおり全体マップ上のツール・PropertiesPanel・applyOp 経路で行い、
 * ここは対象ターミナルへの絞り込み（フロア切替・内部ツール・容量/フロア別集計・
 * 現在階のエリア一覧）に専念する。状態は store の UI 状態のみで、保存形式は持たない。
 */

/** フロアタブに出す建物内階（B3〜4F） */
const FLOOR_TABS = [-3, -2, -1, 0, 1, 2, 3] as const;

/** ターミナル内部エリアのツール（Toolbox の内部グループと同じ 21 種＋選択） */
const AREA_TOOLS: { id: ToolId; kind: TerminalAreaKind | null; label: string }[] = [
  { id: 'select', kind: null, label: '選択・移動' },
  ...(
    [
      'entrance', 'checkIn', 'security', 'departureLobby', 'waiting', 'restroom', 'arrivalCorridor',
      'baggageClaim', 'exit', 'hall', 'movingWalkway', 'stairs', 'escalator', 'elevator', 'shop',
      'restaurant', 'lounge', 'emigration', 'immigration', 'customs', 'transferSecurity',
    ] as const
  ).map((k) => ({ id: `area:${k}` as ToolId, kind: k as TerminalAreaKind | null, label: AREA_KIND_LABEL[k] })),
];

export function TerminalWorkspace() {
  const workspace = useEditor((s) => s.terminalWorkspace);
  const layout = useLayout();
  const company = useEditor((s) => s.company);
  const tool = useEditor((s) => s.tool);
  const interiorLevel = useEditor((s) => s.interiorLevel);
  const selection = useEditor((s) => s.selection);

  const terminalId = workspace?.terminalId ?? null;
  const terminal = terminalId ? layout.facilities[terminalId] : undefined;

  const complexMembers = useMemo(
    () => (terminalId ? (terminalServiceComplexes(layout).get(terminalId) ?? [terminalId]) : []),
    [layout, terminalId],
  );
  const capacity = useMemo(
    () => (terminalId ? terminalCapacitySummaries(layout, company.reports[company.reports.length - 1]).get(terminalId) : undefined),
    [layout, company, terminalId],
  );
  const floorSummary = useMemo(
    () => (terminalId ? terminalFloorSummary(layout, terminalId) : []),
    [layout, terminalId],
  );

  if (!terminalId || !terminal || terminal.kind !== 'terminal') {
    return (
      <aside className="left build-panel" data-testid="terminal-workspace">
        <div className="build-panel-body">
          <div className="build-readonly">
            <strong>ターミナル設計</strong>
            <span>対象のターミナルが見つかりません。</span>
          </div>
          <button className="small" onClick={() => actions.closeTerminalWorkspace()} data-testid="workspace-close">
            全体マップへ戻る
          </button>
        </div>
      </aside>
    );
  }

  const baseLevel = facilityLevel(terminal);
  /** J-1: 建物内階は、ターミナル基点の実効地図階層に換算して統一表記（併記）で出す */
  const floorLabel = (floor: number): string => floorDisplayLabel(baseLevel + floor);
  const currentFloor = interiorLevel - baseLevel;
  const levels = Math.max(1, Number(terminal.props.levels ?? 1));
  const floorExists = (floor: number) => floor >= TERMINAL_AREA_MIN_LEVEL && floor < levels;
  const currentAreas = Object.values(layout.terminalAreas)
    .filter((a) => a.terminalId === terminalId && a.level === currentFloor)
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  return (
    <aside className="left build-panel" data-testid="terminal-workspace">
      <div className="build-panel-body">
        <div className="toolbox">
          <div className="tool-group">
            <div className="tool-group-title">
              <span>{terminal.name || FACILITY_LABEL.terminal} の内部設計</span>
            </div>
            <div className="tool-buttons">
              <button className="tool" onClick={() => actions.closeTerminalWorkspace()} data-testid="workspace-close">
                全体マップへ戻る
              </button>
            </div>
            {complexMembers.length > 1 && (
              <>
                <div className="muted small">同じ複合体の棟</div>
                <div className="tool-buttons">
                  {complexMembers.map((id) => {
                    const member = layout.facilities[id];
                    if (!member) return null;
                    return (
                      <button
                        key={id}
                        className={id === terminalId ? 'tool active' : 'tool'}
                        onClick={() => actions.openTerminalWorkspace(id)}
                        data-testid={`workspace-complex-${id}`}
                      >
                        {member.name || id}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="tool-group">
            <div className="tool-group-title">
              <span>フロア</span>
              <span className="tool-group-count">{levels}層</span>
            </div>
            <div className="tool-buttons">
              {FLOOR_TABS.map((floor) => {
                const exists = floorExists(floor);
                return (
                  <button
                    key={floor}
                    className={currentFloor === floor ? 'tool active' : 'tool'}
                    disabled={!exists}
                    title={exists ? undefined : 'このターミナルには無い階です'}
                    onClick={() => actions.setInteriorLevel(baseLevel + floor)}
                    data-testid={`workspace-floor-${floor}`}
                  >
                    {floorLabel(floor)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="tool-group">
            <div className="tool-group-title">
              <span>ターミナル内部（ドラッグで範囲）</span>
              <span className="tool-group-count">{AREA_TOOLS.length}</span>
            </div>
            <div className="tool-buttons">
              {AREA_TOOLS.map((t) => {
                const feature = t.kind ? featureForAreaKind(t.kind) : null;
                const lock = feature ? lockLabel(company, feature) : null;
                return (
                  <button
                    key={t.id}
                    className={tool === t.id ? 'tool active' : 'tool'}
                    title={lock ?? (t.kind ? 'ターミナルの中でドラッグして範囲を指定（表示中の階に配置）' : 'クリックで選択、ドラッグで移動')}
                    disabled={!!lock}
                    onClick={() => actions.setTool(t.id)}
                    data-testid={`workspace-tool-${t.id}`}
                  >
                    {t.label}
                    {lock ? `（${lock}）` : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {capacity && (
            <div className="tool-group" data-testid="workspace-capacity">
              <div className="tool-group-title">
                <span>全館容量</span>
              </div>
              <div className="muted small">
                スポット {capacity.stands}（S {capacity.standsBySize.S} / M {capacity.standsBySize.M} / L {capacity.standsBySize.L}）
                <br />
                保安検査 {capacity.securityPerHour} 人/時
                {capacity.securityUtilization !== null && (
                  <>
                    <br />
                    保安ピーク使用率 {Math.round(capacity.securityUtilization * 100)}%
                  </>
                )}
              </div>
            </div>
          )}

          <div className="tool-group" data-testid="workspace-floor-summary">
            <div className="tool-group-title">
              <span>フロア別集計</span>
              <span className="tool-group-count">{floorSummary.length}</span>
            </div>
            {floorSummary.length === 0 ? (
              <div className="muted small">内部エリアはまだありません。</div>
            ) : (
              floorSummary.map((row) => (
                <div key={row.level} className="muted small" data-testid={`workspace-floor-summary-${row.level}`}>
                  <strong>{floorLabel(row.level)}</strong>{' '}
                  {Object.entries(row.areas)
                    .map(([kind, n]) => `${AREA_KIND_LABEL[kind as TerminalAreaKind]}×${n}`)
                    .join('、')}
                  {Object.entries(row.processingPerHour).length > 0 && (
                    <>
                      <br />
                      処理能力:{' '}
                      {Object.entries(row.processingPerHour)
                        .map(([kind, v]) => `${AREA_KIND_LABEL[kind as TerminalAreaKind]} ${v}人/時`)
                        .join('、')}
                    </>
                  )}
                  {row.seats > 0 && (
                    <>
                      <br />
                      席数 {row.seats}
                    </>
                  )}
                </div>
              ))
            )}
          </div>

          <div className="tool-group">
            <div className="tool-group-title">
              <span>現在の階のエリア（{floorLabel(currentFloor)}）</span>
              <span className="tool-group-count">{currentAreas.length}</span>
            </div>
            <div className="tool-buttons">
              {currentAreas.map((a) => (
                <button
                  key={a.id}
                  className={selection === a.id ? 'tool active' : 'tool'}
                  onClick={() => actions.select(a.id)}
                  data-testid={`workspace-area-${a.id}`}
                >
                  {a.name || AREA_KIND_LABEL[a.kind]}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
