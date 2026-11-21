import { useMemo, useState } from 'react';
import { actions, applyOp, useEditor, useLayout, type ToolId } from '../editor/store';
import { terminalServiceComplexes } from '../core/terminal/serviceComplex';
import { terminalCapacitySummaries } from '../core/terminal/terminalCapacitySummary';
import { terminalFloorSummary } from '../core/terminal/terminalFloorSummary';
import { terminalFloorRange } from '../core/layout/levelRules';
import { createConnectionFacility, deleteConnectionFacility, type ConnectionVerticalKind } from '../core/layout/operations';
import { connectionFacilityCost } from '../core/economy/construction';
import { TILE_M } from '../core/model/catalog';
import { facilityLevel, floorDisplayLabel } from '../core/model/levels';
import { featureForAreaKind, lockLabel } from '../core/economy/unlocks';
import type { AirportLayout, CrossingMaxCode, TerminalAreaKind, TerminalTransitKind } from '../core/model/types';
import { AREA_KIND_LABEL, FACILITY_LABEL, PBB_DECK_LABEL, PBB_TYPE_LABEL, ZONE_LABEL } from '../i18n/ja';
import { buildTerminalModel } from '../core/terminal/model';
import { gateMode } from '../core/model/gates';
import { pbbForGate } from '../core/model/boardingBridge';

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
  /** 機能H: このターミナル（複合体）に属するゲートと、その搭乗橋（PBB）の状態（表示のみ。編集は PropertiesPanel の PBB 節） */
  const complexGates = useMemo(() => {
    if (!terminalId) return [];
    const model = buildTerminalModel(layout);
    return Object.values(layout.facilities)
      .filter((f) => f.kind === 'gate' && complexMembers.includes(model.gates[f.id]?.terminalId ?? ''))
      .sort((a, b) => a.id.localeCompare(b.id));
  }, [layout, terminalId, complexMembers]);

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
  /** 機能G: エリアを置ける階の範囲（floorRange。欠落時は従来どおり B3〜階数−1）でタブの有無を決める */
  const floorRange = terminalFloorRange(layout, terminalId);
  const floorExists = (floor: number) => floor >= floorRange.min && floor <= floorRange.max;
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
                // 地下棟で地上階のタブが無い場合は、その旨を無効理由として出す（機能G）
                const missingReason = baseLevel < 0 && baseLevel + floor >= 0 ? '地下だけの建物のため、地上階はありません' : 'このターミナルには無い階です';
                return (
                  <button
                    key={floor}
                    className={currentFloor === floor ? 'tool active' : 'tool'}
                    disabled={!exists}
                    title={exists ? undefined : missingReason}
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

          <div className="tool-group" data-testid="workspace-gates">
            <div className="tool-group-title">
              <span>ゲートと搭乗橋（PBB）</span>
              <span className="tool-group-count">{complexGates.length}</span>
            </div>
            {complexGates.length === 0 ? (
              <div className="muted small">このターミナルに属するゲートはありません。</div>
            ) : (
              complexGates.map((g) => {
                const units = pbbForGate(layout, g.id);
                const pbbLabel =
                  gateMode(g) === 'bus'
                    ? 'バスゲート'
                    : units.length === 0
                      ? '橋なし（タラップ）'
                      : units
                          .map((u) => `${PBB_TYPE_LABEL[u.bridgeType]}・${PBB_DECK_LABEL[u.deck]}${u.synthesized ? '（従来の橋）' : ''}`)
                          .join(' / ');
                return (
                  <div key={g.id} className="muted small" data-testid={`workspace-gate-${g.id}`}>
                    <button className={selection === g.id ? 'small tool active' : 'small'} onClick={() => actions.select(g.id)}>
                      {g.name || g.id}
                    </button>{' '}
                    {pbbLabel}
                  </div>
                );
              })
            )}
            <div className="muted small">型式の変更・追加は、ゲートを選んでプロパティの「搭乗橋（PBB）」節から行います</div>
          </div>

          <ConnectionFacilityGroup
            layout={layout}
            terminalId={terminalId}
            complexMembers={complexMembers}
            selection={selection}
            floorLabel={floorLabel}
          />

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

const TRANSIT_KIND_LABEL: Record<TerminalTransitKind, string> = {
  walkway: '徒歩連絡通路',
  movingWalkway: '動く歩道',
  elevatedWalkway: '高層通路',
  escalator: 'エスカレーター',
  elevator: 'エレベーター',
};

const VERTICAL_KIND_OPTIONS: { value: ConnectionVerticalKind | ''; label: string }[] = [
  { value: '', label: '生成しない' },
  { value: 'stairs', label: '階段' },
  { value: 'escalator', label: 'エスカレーター' },
  { value: 'elevator', label: 'エレベーター' },
];

/**
 * 複合連絡施設（J-2）: この複合体に属する連絡施設の一覧と、3ステップの作成フロー
 * （端点エリア → 通路段 → 両端の垂直ノード）。作成は1つの操作（= Undo 1回）で
 * 部品生成とグルーピング記録までを原子的に行う。
 */
function ConnectionFacilityGroup({
  layout,
  terminalId,
  complexMembers,
  selection,
  floorLabel,
}: {
  layout: AirportLayout;
  terminalId: string;
  complexMembers: string[];
  selection: string | null;
  floorLabel: (floor: number) => string;
}) {
  const facilitiesHere = useMemo(
    () =>
      Object.values(layout.connectionFacilities ?? {})
        .filter((cf) => {
          if (cf.segment.kind !== 'link') return false;
          const link = layout.terminalLinks?.[cf.segment.linkId];
          if (!link) return false;
          const from = layout.terminalAreas[link.fromAreaId];
          const to = layout.terminalAreas[link.toAreaId];
          return !!from && !!to && (complexMembers.includes(from.terminalId) || complexMembers.includes(to.terminalId));
        })
        .sort((a, b) => a.id.localeCompare(b.id)),
    [layout, complexMembers],
  );

  const [fromAreaId, setFromAreaId] = useState('');
  const [toAreaId, setToAreaId] = useState('');
  const [segKind, setSegKind] = useState<TerminalTransitKind>('elevatedWalkway');
  const [crossingMaxCode, setCrossingMaxCode] = useState<CrossingMaxCode | ''>('');
  const [autoMetrics, setAutoMetrics] = useState(true);
  const [distanceM, setDistanceM] = useState(250);
  const [travelSec, setTravelSec] = useState(190);
  const [aKind, setAKind] = useState<ConnectionVerticalKind | ''>('escalator');
  const [bKind, setBKind] = useState<ConnectionVerticalKind | ''>('escalator');
  const [stepFreeMode, setStepFreeMode] = useState<'auto' | 'yes' | 'no'>('auto');
  const [name, setName] = useState('');

  const ownAreas = useMemo(
    () =>
      Object.values(layout.terminalAreas)
        .filter((a) => a.terminalId === terminalId)
        .sort((a, b) => a.level - b.level || a.id.localeCompare(b.id)),
    [layout, terminalId],
  );
  const fromArea = layout.terminalAreas[fromAreaId];
  const toCandidates = useMemo(
    () =>
      fromArea
        ? Object.values(layout.terminalAreas)
            .filter((a) => a.terminalId !== terminalId && a.zone === fromArea.zone)
            .sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.level - b.level || a.id.localeCompare(b.id))
        : [],
    [layout, terminalId, fromArea],
  );
  const toArea = toCandidates.find((a) => a.id === toAreaId);
  const autoDistance =
    fromArea && toArea
      ? Math.max(
          25,
          Math.round(
            Math.hypot(
              fromArea.origin.x + fromArea.w / 2 - (toArea.origin.x + toArea.w / 2),
              fromArea.origin.y + fromArea.h / 2 - (toArea.origin.y + toArea.h / 2),
            ) * TILE_M,
          ),
        )
      : 250;
  const effDistance = autoMetrics ? autoDistance : distanceM;
  const effTravel = autoMetrics ? Math.max(10, Math.round(autoDistance / 1.2)) : travelSec;

  const areaOptionLabel = (a: (typeof ownAreas)[number]) =>
    `${floorLabel(a.level)} ${a.name || AREA_KIND_LABEL[a.kind]}（${ZONE_LABEL[a.zone]}）`;

  const create = () => {
    if (!fromArea || !toArea) return;
    applyOp(
      createConnectionFacility(layout, {
        name: name.trim() || undefined,
        fromAreaId: fromArea.id,
        toAreaId: toArea.id,
        link: {
          kind: segKind,
          distanceM: effDistance,
          travelSec: effTravel,
          ...(segKind === 'elevatedWalkway' && crossingMaxCode ? { crossingMaxCode } : {}),
        },
        aVerticalKind: aKind || null,
        bVerticalKind: bKind || null,
        stepFree: stepFreeMode === 'auto' ? undefined : stepFreeMode === 'yes',
      }),
      { select: true },
    );
  };

  return (
    <div className="tool-group" data-testid="workspace-connection-facilities">
      <div className="tool-group-title">
        <span>連絡施設（複合）</span>
        <span className="tool-group-count">{facilitiesHere.length}</span>
      </div>
      {facilitiesHere.map((cf) => {
        const link = cf.segment.kind === 'link' ? layout.terminalLinks?.[cf.segment.linkId] : undefined;
        return (
          <div key={cf.id} className="muted small" data-testid={`workspace-cf-${cf.id}`}>
            <span>
              {cf.name || '（名称未設定）'}（{link ? TRANSIT_KIND_LABEL[link.kind] : 'AGT'}・
              {cf.stepFree ? '段差なし' : '段差あり'}・{connectionFacilityCost(layout, cf.id).toLocaleString()} cr）
            </span>{' '}
            <button className="tool" onClick={() => actions.select(cf.id)}>
              選択
            </button>{' '}
            <button className="tool danger" onClick={() => applyOp(deleteConnectionFacility(layout, cf.id))}>
              削除
            </button>
          </div>
        );
      })}
      <div className="muted small">新しい連絡施設を作成（端点 → 通路段 → 垂直ノードの3ステップ、1回の操作で配置されます）</div>
      <label className="small">
        名前（任意）{' '}
        <input type="text" value={name} onChange={(e) => setName(e.target.value)} data-testid="cf-create-name" />
      </label>
      <label className="small">
        1. 入口エリア（このターミナル）{' '}
        <select
          value={fromAreaId}
          onChange={(e) => {
            setFromAreaId(e.target.value);
            setToAreaId('');
          }}
          data-testid="cf-create-from"
        >
          <option value="">選択してください</option>
          {ownAreas.map((a) => (
            <option key={a.id} value={a.id}>
              {areaOptionLabel(a)}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        出口エリア（別ターミナル・同じ区域）{' '}
        <select value={toAreaId} onChange={(e) => setToAreaId(e.target.value)} disabled={!fromArea} data-testid="cf-create-to">
          <option value="">選択してください</option>
          {toCandidates.map((a) => (
            <option key={a.id} value={a.id}>
              {layout.facilities[a.terminalId]?.name || a.terminalId}: {areaOptionLabel(a)}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        2. 通路段の種類{' '}
        <select value={segKind} onChange={(e) => setSegKind(e.target.value as TerminalTransitKind)} data-testid="cf-create-kind">
          {(Object.keys(TRANSIT_KIND_LABEL) as TerminalTransitKind[]).map((k) => (
            <option key={k} value={k}>
              {TRANSIT_KIND_LABEL[k]}
            </option>
          ))}
        </select>
      </label>
      {segKind === 'elevatedWalkway' && (
        <label className="small">
          下を通過する最大機種コード（クリアランス導出）{' '}
          <select value={crossingMaxCode} onChange={(e) => setCrossingMaxCode(e.target.value as CrossingMaxCode | '')} data-testid="cf-create-crossing">
            <option value="">指定なし（従来 33m）</option>
            <option value="C">C（床 +18m）</option>
            <option value="E">E（床 +24m）</option>
            <option value="F">F（床 +30m）</option>
          </select>
        </label>
      )}
      <label className="small">
        <input type="checkbox" checked={autoMetrics} onChange={(e) => setAutoMetrics(e.target.checked)} /> 距離・所要時間を端点間から自動計算
      </label>
      {!autoMetrics && (
        <>
          <label className="small">
            距離（m） <input type="number" min={1} value={distanceM} onChange={(e) => setDistanceM(Number(e.target.value))} />
          </label>
          <label className="small">
            所要時間（秒） <input type="number" min={1} value={travelSec} onChange={(e) => setTravelSec(Number(e.target.value))} />
          </label>
        </>
      )}
      <label className="small">
        3. 入口側の垂直ノード{' '}
        <select value={aKind} onChange={(e) => setAKind(e.target.value as ConnectionVerticalKind | '')} data-testid="cf-create-akind">
          {VERTICAL_KIND_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        出口側の垂直ノード{' '}
        <select value={bKind} onChange={(e) => setBKind(e.target.value as ConnectionVerticalKind | '')} data-testid="cf-create-bkind">
          {VERTICAL_KIND_OPTIONS.map((o) => (
            <option key={o.label} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="small">
        段差なし{' '}
        <select value={stepFreeMode} onChange={(e) => setStepFreeMode(e.target.value as 'auto' | 'yes' | 'no')} data-testid="cf-create-stepfree">
          <option value="auto">自動（垂直ノードの種類から導出）</option>
          <option value="yes">段差なしにする</option>
          <option value="no">段差なしにしない</option>
        </select>
      </label>
      <div className="tool-buttons">
        <button className="tool" disabled={!fromArea || !toArea} onClick={create} data-testid="cf-create">
          連絡施設を作成
        </button>
      </div>
      <div className="muted small">
        垂直ノードは端点エリアと同じ位置に、通路段の階までの各階へ生成されます（高層通路以外では階移動が無いため生成されません）。費用は部品ごとの通常単価の合計です。
      </div>
    </div>
  );
}
