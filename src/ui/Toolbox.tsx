import { FACILITY_SPECS } from '../core/model/catalog';
import type { BuildState, FacilityKind, RoadClass, SizeClass } from '../core/model/types';
import { BUILD_STATES } from '../core/model/types';
import { actions, useEditor, type ToolId } from '../editor/store';
import { facilityKindOf } from '../editor/tools';
import { useLayout } from '../editor/store';
import { RunwayToolOptions } from './RunwayPanels';
import { AREA_KIND_LABEL, BUILD_STATE_LABEL, FACILITY_LABEL, FLOOR_NOT_IN_PARENT_LABEL, PLACEMENT_PROBLEM_LABEL, ROAD_CLASS_LABEL } from '../i18n/ja';
import { floorExistsInParent } from '../core/layout/levelRules';
import { featureForAreaKind, lockLabel } from '../core/economy/unlocks';
import type { TerminalAreaKind } from '../core/model/types';

interface ToolDef {
  id: ToolId;
  label: string;
  hint: string;
}

const fac = (kind: FacilityKind, hint?: string): ToolDef => ({
  id: `facility:${kind}`,
  label: FACILITY_LABEL[kind],
  hint: hint ?? (FACILITY_SPECS[kind].dragPlace ? 'ドラッグで範囲を指定' : 'クリックで配置（R で回転）'),
});

const GROUPS: { title: string; tools: ToolDef[] }[] = [
  { title: '編集', tools: [{ id: 'select', label: '選択・移動', hint: 'クリックで選択、ドラッグで移動' }] },
  {
    title: '滑走路・誘導路',
    tools: [
      { id: 'runway', label: '滑走路', hint: '始点→終点をクリック（またはドラッグ）。既定は8方向（オプションで自由形: 任意の方位・実寸）' },
      { id: 'taxiway', label: '誘導路', hint: 'クリックで頂点を追加、ダブルクリック/Enter/右クリックで確定' },
    ],
  },
  {
    title: 'エプロン・スポット',
    tools: [fac('apron'), { id: 'stand', label: '駐機スポット', hint: 'クリックで配置（R で機首の向きを回転）' }],
  },
  { title: 'ターミナル', tools: [fac('terminal'), fac('gate', 'ターミナルに接して配置。近くのスポットに自動で紐付け')] },
  {
    title: '支援施設',
    tools: [fac('tower'), fac('hangar'), fac('maintenance'), fac('fuelFarm'), fac('fireStation'), fac('gseBase'), fac('baggageSort')],
  },
  {
    title: 'ターミナル内部（ドラッグで範囲）',
    tools: (['entrance', 'checkIn', 'security', 'departureLobby', 'waiting', 'restroom', 'arrivalCorridor', 'baggageClaim', 'exit', 'hall', 'stairs', 'escalator', 'elevator', 'shop', 'restaurant', 'emigration', 'immigration', 'customs', 'transferSecurity'] as const).map((k) => ({
      id: `area:${k}` as ToolId,
      label: AREA_KIND_LABEL[k],
      hint: 'ターミナルの中でドラッグして範囲を指定（表示中の階に配置）',
    })),
  },
  {
    title: '道路・エリア',
    tools: [
      { id: 'road', label: '道路・交通網', hint: '選択中の階層に交通網を敷設。別階層はノードのプロパティから接続設備を作成' },
      fac('serviceArea'),
      fac('parking'),
    ],
  },
  {
    title: '空港アクセス・周辺施設',
    tools: [
      fac('taxiStand', '一般道路に接して、ターミナルの近く（16タイル以内）に配置'),
      fac('busStop', '一般道路に接して、ターミナルの近く（16タイル以内）に配置'),
      fac('railStation', '鉄道線（道路ツールの種別「鉄道」）を敷地の外周までつなぐ'),
      fac('staffParking', 'ドラッグで範囲を指定。道路（一般・業務用）に接して配置'),
      fac('hotel', '一般道路に接して、ターミナルの近くに配置'),
      { id: 'land', label: '土地を購入', hint: '敷地外（暗い部分）をドラッグして購入。取得済みの敷地に隣接する土地のみ' },
    ],
  },
];

const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);

export function toolHint(tool: ToolId): string {
  return ALL_TOOLS.find((t) => t.id === tool)?.hint ?? '';
}

export function Toolbox() {
  const tool = useEditor((s) => s.tool);
  const company = useEditor((s) => s.company);
  const options = useEditor((s) => s.options);
  const kind = facilityKindOf(tool);
  const level = useEditor((s) => s.interiorLevel);
  const interior = useEditor((s) => s.overlays.interior);
  const mapLevel = useEditor((s) => s.mapLevel);
  const layout = useLayout();
  const rotatable = tool === 'stand' || (kind !== null && !FACILITY_SPECS[kind].dragPlace);

  return (
    <div className="toolbox" data-testid="toolbox">
      {GROUPS.map((g) => (
        <div key={g.title} className="tool-group">
          <div className="tool-group-title">{g.title}</div>
          <div className="tool-buttons">
            {g.tools.map((t) => {
              // フェーズ 4 のエリアは、格で解放されるまで選べない（理由を表示）
              const areaKind = t.id.startsWith('area:') ? (t.id.slice(5) as TerminalAreaKind) : null;
              const feature = areaKind ? featureForAreaKind(areaKind) : null;
              const lock = feature && company ? lockLabel(company, feature) : null;
              return (
                <button
                  key={t.id}
                  className={tool === t.id ? 'tool active' : 'tool'}
                  title={lock ?? t.hint}
                  data-testid={`tool-${t.id}`}
                  disabled={!!lock}
                  onClick={() => actions.setTool(t.id)}
                >
                  {t.label}
                  {lock ? `（${lock}）` : ''}
                </button>
              );
            })}
          </div>
        </div>
      ))}

      <div className="tool-options">
        <div className="tool-group-title">配置オプション</div>
        <label>
          交通・独立施設の階層
          <select value={mapLevel} onChange={(e) => actions.setMapLevel(e.target.value === 'all' ? 'all' : Number(e.target.value))} data-testid="map-level">
            <option value="all">全レイヤ</option>
            {Array.from({ length: 16 }, (_, i) => i - 5).map((l) => <option key={l} value={l}>{l === 0 ? '地上' : l < 0 ? `地下 ${-l}` : `高架 ${l}`}</option>)}
          </select>
        </label>
        <label>
          施設の配置先
          <select value={options.interiorParentId ?? ''} onChange={(e) => actions.setOption('interiorParentId', e.target.value || null)} data-testid="facility-parent">
            <option value="">独立施設</option>
            {Object.values(layout.facilities).filter((f) => f.kind !== 'gate' && FACILITY_SPECS[f.kind].layer === 'building').sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((f) => (
              <option key={f.id} value={f.id}>{f.name || FACILITY_LABEL[f.kind]} · {f.id}</option>
            ))}
          </select>
        </label>
        {options.interiorParentId && (
          <label>
            建物内の階
            <select value={options.interiorFloorIndex} onChange={(e) => actions.setOption('interiorFloorIndex', Number(e.target.value))} data-testid="facility-floor">
              {Array.from({ length: 8 }, (_, i) => i - 5).map((floor) => {
                const exists = floorExistsInParent(layout, options.interiorParentId!, floor);
                return (
                  <option key={floor} value={floor} title={exists ? undefined : PLACEMENT_PROBLEM_LABEL.floorOutOfRange}>
                    {floor < 0 ? `地下${-floor}階` : `${floor + 1}階`}{exists ? '' : FLOOR_NOT_IN_PARENT_LABEL}
                  </option>
                );
              })}
            </select>
          </label>
        )}
        <label>
          ターミナル内部の階
          <span>
            {[-3, -2, -1, 0, 1, 2, 3].map((l) => (
              <button key={l} className={interior && level === l ? 'small tool active' : 'small'} onClick={() => actions.setInteriorLevel(l)} data-testid={`level-${l}`} title={l < 0 ? `地下${-l}階` : `${l + 1}階`}>
                {l < 0 ? `B${-l}` : `${l + 1}F`}
              </button>
            ))}
          </span>
        </label>
        <label>
          新規の状態
          <select
            value={options.buildState}
            onChange={(e) => actions.setOption('buildState', e.target.value as BuildState)}
            data-testid="opt-buildState"
          >
            {BUILD_STATES.map((b) => (
              <option key={b} value={b}>
                {BUILD_STATE_LABEL[b]}
              </option>
            ))}
          </select>
        </label>
        {tool === 'runway' && <RunwayToolOptions />}
        {tool === 'runway' && (
          <label>
            舗装幅
            <select value={options.runwayWidth} onChange={(e) => actions.setOption('runwayWidth', Number(e.target.value) as 30 | 45 | 60)}>
              <option value={30}>30m（S級まで）</option>
              <option value={45}>45m（M級まで）</option>
              <option value={60}>60m（L級まで）</option>
            </select>
          </label>
        )}
        {tool === 'taxiway' && (
          <>
            <label>
              誘導路幅
              <SizeSelect value={options.taxiWidth} onChange={(v) => actions.setOption('taxiWidth', v)} />
            </label>
            <label className="check">
              <input type="checkbox" checked={options.oneWay} onChange={(e) => actions.setOption('oneWay', e.target.checked)} />
              一方通行（描いた向き）
            </label>
          </>
        )}
        {tool === 'road' && (
          <>
            <label>
              種別
              <select value={options.roadClass} onChange={(e) => actions.setOption('roadClass', e.target.value as RoadClass)} data-testid="opt-roadClass">
                <option value="public">{ROAD_CLASS_LABEL.public}</option>
                <option value="service">{ROAD_CLASS_LABEL.service}</option>
                <option value="rail">{ROAD_CLASS_LABEL.rail}</option>
                <option value="walkway">{ROAD_CLASS_LABEL.walkway}</option>
                <option value="fuel">{ROAD_CLASS_LABEL.fuel}</option>
              </select>
            </label>
            <label>
              明示能力（/時、0=未算出）
              <input type="number" min="0" value={options.roadCapacityPerHour} onChange={(e) => actions.setOption('roadCapacityPerHour', Math.max(0, Number(e.target.value) || 0))} data-testid="road-capacity" />
            </label>
            {options.roadClass === 'rail' && <div className="muted small">駅の「階層」と同じ階で接続してください。鉄道乗降客がターミナルへ移動するには旅客通路が必要です。</div>}
            {options.roadClass === 'fuel' && <div className="muted small">給油施設からスポットまで連続した配管と階層間ライザーを敷設します。</div>}
            <label className="check">
              <input type="checkbox" checked={options.oneWay} onChange={(e) => actions.setOption('oneWay', e.target.checked)} />
              一方通行
            </label>
          </>
        )}
        {tool === 'stand' && (
          <label>
            サイズ
            <SizeSelect value={options.standSize} onChange={(v) => actions.setOption('standSize', v)} />
          </label>
        )}
        {rotatable && (
          <label>
            向き
            <button className="small" onClick={() => actions.rotateTool()} title="R キー">
              {options.rotation}° ↻
            </button>
          </label>
        )}
      </div>
    </div>
  );
}

function SizeSelect({ value, onChange }: { value: SizeClass; onChange: (v: SizeClass) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as SizeClass)}>
      <option value="S">S（小型）</option>
      <option value="M">M（中型）</option>
      <option value="L">L（大型）</option>
    </select>
  );
}
