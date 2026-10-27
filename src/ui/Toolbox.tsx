import { FACILITY_SPECS } from '../core/model/catalog';
import type { BuildState, FacilityKind, RoadClass, SizeClass } from '../core/model/types';
import { BUILD_STATES } from '../core/model/types';
import { actions, useEditor, type ToolId } from '../editor/store';
import { facilityKindOf } from '../editor/tools';
import { AREA_KIND_LABEL, BUILD_STATE_LABEL, FACILITY_LABEL, ROAD_CLASS_LABEL } from '../i18n/ja';

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
      { id: 'runway', label: '滑走路', hint: '始点→終点をクリック（またはドラッグ）。8方向' },
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
    tools: (['entrance', 'checkIn', 'security', 'departureLobby', 'waiting', 'restroom', 'arrivalCorridor', 'baggageClaim', 'exit', 'hall', 'escalator', 'elevator', 'shop', 'restaurant'] as const).map((k) => ({
      id: `area:${k}` as ToolId,
      label: AREA_KIND_LABEL[k],
      hint: 'ターミナルの中でドラッグして範囲を指定（表示中の階に配置）',
    })),
  },
  {
    title: '道路・エリア',
    tools: [
      { id: 'road', label: '道路・鉄道', hint: 'クリックで頂点を追加、ダブルクリック/Enter/右クリックで確定（種別: 一般・業務用・鉄道）' },
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
  const options = useEditor((s) => s.options);
  const kind = facilityKindOf(tool);
  const level = useEditor((s) => s.interiorLevel);
  const interior = useEditor((s) => s.overlays.interior);
  const rotatable = tool === 'stand' || (kind !== null && !FACILITY_SPECS[kind].dragPlace);

  return (
    <div className="toolbox" data-testid="toolbox">
      {GROUPS.map((g) => (
        <div key={g.title} className="tool-group">
          <div className="tool-group-title">{g.title}</div>
          <div className="tool-buttons">
            {g.tools.map((t) => (
              <button
                key={t.id}
                className={tool === t.id ? 'tool active' : 'tool'}
                title={t.hint}
                data-testid={`tool-${t.id}`}
                onClick={() => actions.setTool(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="tool-options">
        <div className="tool-group-title">配置オプション</div>
        <label>
          ターミナル内部の階
          <span>
            {[0, 1, 2].map((l) => (
              <button key={l} className={interior && level === l ? 'small tool active' : 'small'} onClick={() => actions.setInteriorLevel(l)} data-testid={`level-${l}`}>
                {l + 1}F
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
              </select>
            </label>
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
