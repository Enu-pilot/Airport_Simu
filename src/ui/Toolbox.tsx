import { FACILITY_SIM_EFFECT, FACILITY_SPECS } from '../core/model/catalog';
import type { BuildState, FacilityKind, RoadClass, SizeClass } from '../core/model/types';
import { BUILD_STATES } from '../core/model/types';
import { actions, useEditor, type ToolId } from '../editor/store';
import { facilityKindOf } from '../editor/tools';
import { useLayout } from '../editor/store';
import { RunwayToolOptions } from './RunwayPanels';
import { AREA_KIND_LABEL, BUILD_STATE_LABEL, FACILITY_LABEL, FLOOR_NOT_IN_PARENT_LABEL, FLOOR_SELECTOR_LEVELS, PBB_DECK_LABEL, PBB_TYPE_LABEL, PLACEMENT_PROBLEM_LABEL, ROAD_CLASS_LABEL, SIM_EFFECT_LABEL } from '../i18n/ja';
import type { PbbBridgeType, PbbDeck } from '../core/model/catalog';
import { floorExistsInParent } from '../core/layout/levelRules';
import { facilityLevel, floorDisplay, floorDisplayLabel } from '../core/model/levels';
import { featureForAreaKind, lockLabel } from '../core/economy/unlocks';
import type { TerminalAreaKind } from '../core/model/types';

interface ToolDef {
  id: ToolId;
  label: string;
  hint: string;
  /** sim 効果がない / 表示のみの種別だけ付くバッジ文言（UI 改善 案3） */
  effectBadge?: string;
}

const fac = (kind: FacilityKind, hint?: string): ToolDef => {
  const effect = FACILITY_SIM_EFFECT[kind];
  return {
    id: `facility:${kind}`,
    label: FACILITY_LABEL[kind],
    hint: hint ?? (FACILITY_SPECS[kind].dragPlace ? 'ドラッグで範囲を指定' : 'クリックで配置（R で回転）'),
    ...(effect === 'none' || effect === 'displayOnly' ? { effectBadge: SIM_EFFECT_LABEL[effect] } : {}),
  };
};

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
  {
    title: 'ターミナル',
    tools: [
      fac('terminal'),
      fac('gate', 'ターミナルに接して配置。近くのスポットに自動で紐付け'),
      // 機能H: 搭乗橋（PBB）。スポット→ゲートの2クリックで紐付けて配置する専用ツール
      { id: 'pbb', label: '搭乗橋（PBB）', hint: 'スポット→ゲート（またはゲート→スポット）の順にクリック。置き場所はスポット入口の近傍から自動で選ぶ' },
    ],
  },
  {
    title: '支援施設',
    tools: [fac('tower'), fac('hangar'), fac('maintenance'), fac('fuelFarm'), fac('fireStation'), fac('gseBase'), fac('baggageSort')],
  },
  {
    title: 'ターミナル内部（ドラッグで範囲）',
    tools: (['entrance', 'checkIn', 'security', 'departureLobby', 'waiting', 'restroom', 'arrivalCorridor', 'baggageClaim', 'exit', 'hall', 'movingWalkway', 'stairs', 'escalator', 'elevator', 'shop', 'restaurant', 'lounge', 'emigration', 'immigration', 'customs', 'transferSecurity'] as const).map((k) => ({
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
      fac('busTerminal', 'バースを持つバスの拠点。一般道路に接して、ターミナルの近く（16タイル以内）に配置'),
      fac('cargoTerminal', '貨物の保管・仕分け・積み付けを行う上屋。処理能力（m3/時）を持つ。エプロンに接して配置'),
      fac('railStation', '鉄道線（道路ツールの種別「鉄道」）を敷地の外周までつなぐ'),
      fac('staffParking', 'ドラッグで範囲を指定。道路（一般・業務用）に接して配置'),
      fac('hotel', '一般道路に接して、ターミナルの近くに配置'),
      { id: 'land', label: '土地を購入', hint: '敷地外（暗い部分）をドラッグして購入。取得済みの敷地に隣接する土地のみ' },
    ],
  },
  {
    title: '住民向け施設',
    tools: [
      fac('shoppingMall', '置くだけで住民満足度 +0.03/日。運航には影響しません（施設由来のプラスは合計 +0.10/日まで）'),
      fac('culturalHall', '置くだけで住民満足度 +0.02/日。運航には影響しません'),
      fac('park', 'ドラッグで範囲を指定。置くだけで住民満足度 +0.01/日。運航には影響しません'),
    ],
  },
];

const ALL_TOOLS = GROUPS.flatMap((g) => g.tools);

/** ターミナル配置で選べる絶対階（B3F〜4F。総階数 1〜4 の制約は選択肢の無効化で表す） */
const TERMINAL_FLOOR_CANDIDATES = [-3, -2, -1, 0, 1, 2, 3] as const;

/** 階範囲のプリセット（[最下階, 最上階] の絶対階） */
const TERMINAL_FLOOR_PRESETS: Record<string, readonly [number, number]> = {
  ground: [0, 1],
  under1: [-1, -1],
  under2: [-2, -1],
  straddle: [-1, 1],
};

const terminalFloorPreset = (min: number, max: number): string =>
  Object.entries(TERMINAL_FLOOR_PRESETS).find(([, [a, b]]) => a === min && b === max)?.[0] ?? 'custom';

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

  const renderToolButton = (t: ToolDef) => {
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
        {t.effectBadge && (
          <span className="badge sim-effect-badge" data-testid={`tool-effect-${t.id}`}>
            {t.effectBadge}
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="toolbox" data-testid="toolbox">
      {GROUPS.map((g, gi) =>
        gi === 0 ? (
          // 「編集」（選択・移動）だけはアコーディオンにせず常時表示する（PO 要望）
          <div key={g.title} className="tool-group">
            <div className="tool-group-title">
              <span>{g.title}</span>
              <span className="tool-group-count">{g.tools.length}</span>
            </div>
            <div className="tool-buttons">{g.tools.map(renderToolButton)}</div>
          </div>
        ) : (
          <details
            key={g.title}
            className="tool-group"
            open={g.tools.some((t) => t.id === tool)}
          >
            <summary className="tool-group-title">
              <span>{g.title}</span>
              <span className="tool-group-count">{g.tools.length}</span>
            </summary>
            <div className="tool-buttons">{g.tools.map(renderToolButton)}</div>
          </details>
        ),
      )}

      <div className="tool-options">
        <div className="tool-group-title">配置オプション</div>
        <label>
          交通・独立施設の階層
          <select value={mapLevel} onChange={(e) => actions.setMapLevel(e.target.value === 'all' ? 'all' : Number(e.target.value))} data-testid="map-level">
            <option value="all">全レイヤ</option>
            {Array.from({ length: 16 }, (_, i) => i - 5).map((l) => <option key={l} value={l}>{l === 0 ? '地上' : l < 0 ? `地下 ${-l}` : `高架 ${l}`}</option>)}
          </select>
          {mapLevel === 'all' && <span className="muted small" data-testid="placement-level-note">配置先は {options.roadLevel === 0 ? '地上' : options.roadLevel < 0 ? `地下 ${-options.roadLevel}` : `高架 ${options.roadLevel}`} のままです</span>}
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
        {kind === 'terminal' && !options.interiorParentId && (
          <>
            <label>
              建物の階（プリセット）
              <select
                value={terminalFloorPreset(options.terminalFloorMin, options.terminalFloorMax)}
                onChange={(e) => {
                  const p = TERMINAL_FLOOR_PRESETS[e.target.value];
                  if (!p) return;
                  actions.setOption('terminalFloorMin', p[0]);
                  actions.setOption('terminalFloorMax', p[1]);
                }}
                data-testid="terminal-floor-preset"
              >
                <option value="ground">地上のみ（1F〜2F）</option>
                <option value="under1">地下のみ（B1F）</option>
                <option value="under2">地下のみ（B2F〜B1F）</option>
                <option value="straddle">跨ぎ（B1F〜2F）</option>
                <option value="custom">カスタム</option>
              </select>
            </label>
            <label>
              最下階
              <select value={options.terminalFloorMin} onChange={(e) => actions.setOption('terminalFloorMin', Number(e.target.value))} data-testid="terminal-floor-min">
                {TERMINAL_FLOOR_CANDIDATES.map((v) => (
                  <option key={v} value={v} disabled={v > options.terminalFloorMax || options.terminalFloorMax - v + 1 > 4}>
                    {floorDisplayLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              最上階
              <select value={options.terminalFloorMax} onChange={(e) => actions.setOption('terminalFloorMax', Number(e.target.value))} data-testid="terminal-floor-max">
                {TERMINAL_FLOOR_CANDIDATES.map((v) => (
                  <option key={v} value={v} disabled={v < options.terminalFloorMin || v - options.terminalFloorMin + 1 > 4}>
                    {floorDisplayLabel(v)}
                  </option>
                ))}
              </select>
              <span className="muted small">最下階が建物の基底階になります。地下だけの建物も置けます（真上にエプロン等を置けます）</span>
            </label>
          </>
        )}
        {options.interiorParentId && (
          <label>
            建物内の階
            <select value={options.interiorFloorIndex} onChange={(e) => actions.setOption('interiorFloorIndex', Number(e.target.value))} data-testid="facility-floor">
              {Array.from({ length: 8 }, (_, i) => i - 5).map((floor) => {
                const exists = floorExistsInParent(layout, options.interiorParentId!, floor);
                // J-1: 親建物を基点にした実効階の併記で出す
                const parent = layout.facilities[options.interiorParentId!];
                return (
                  <option key={floor} value={floor} title={exists ? undefined : PLACEMENT_PROBLEM_LABEL.floorOutOfRange}>
                    {floorDisplayLabel((parent ? facilityLevel(parent) : 0) + floor)}{exists ? '' : FLOOR_NOT_IN_PARENT_LABEL}
                  </option>
                );
              })}
            </select>
          </label>
        )}
        <label>
          ターミナル内部の階
          <span>
            {FLOOR_SELECTOR_LEVELS.map((l) => (
              <button key={l} className={interior && level === l ? 'small tool active' : 'small'} onClick={() => actions.setInteriorLevel(l)} data-testid={`level-${l}`} title={floorDisplayLabel(l)}>
                {floorDisplay(l).building}
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
        {tool === 'pbb' && (
          <>
            <label>
              型式（トンネル本数）
              <select value={options.pbbType} onChange={(e) => actions.setOption('pbbType', e.target.value as PbbBridgeType)} data-testid="opt-pbbType">
                {Object.entries(PBB_TYPE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
              <span className="muted small">1本でも大型機は運用できますが、ドア高が合わず搭乗・降機が遅くなります。2本は大型機のドア高に届き、速くなります</span>
            </label>
            <label>
              接続デッキ
              <select value={options.pbbDeck} onChange={(e) => actions.setOption('pbbDeck', e.target.value as PbbDeck)} data-testid="opt-pbbDeck">
                {Object.entries(PBB_DECK_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>{label}</option>
                ))}
              </select>
              <span className="muted small">上デッキは tunnel2Upper の2基目用（2階建て機向け）</span>
            </label>
          </>
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
