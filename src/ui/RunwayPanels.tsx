import { useState } from 'react';
import { FREE_RUNWAY_MAX_M, FREE_RUNWAY_MIN_M, TAXI_BLOCK_TILES_DEFAULT, TAXI_BLOCK_TILES_MAX, TAXI_BLOCK_TILES_MIN } from '../core/model/catalog';
import {
  FREE_RUNWAY_DEFAULT_BASIS,
  FREE_RUNWAY_DEFAULTS,
  RUNWAY_REFERENCE,
  RUNWAY_REF_SOURCES,
  type DefaultKey,
} from '../core/model/runwayReference';
import { isFreeRunway, type AirportLayout, type RunwayFree, type RunwayGrid8, type RunwaySuffix } from '../core/model/types';
import { sortedValues } from '../core/model/ids';
import { designatorsOf } from '../core/layout/designators';
import { resolveRunwayDims } from '../core/layout/runwayAreas';
import { convertRunwayToFree, snapRunwayToGrid, updateEntity, updateLayoutSettings } from '../core/layout/operations';
import { runwayAxis, runwayLengthM, runwayMaxSize } from '../core/layout/runway';
import { actions, applyOp, useEditor, useLayout, type ToolOptions } from '../editor/store';
import { ACCESS_UI, MAG_VAR_LABEL, RUNWAY_DISCLAIMER, RUNWAY_UI, TAXI_UI, displayName } from '../i18n/ja';
import { blockGraphOf } from '../core/layout/blockGraph';
import { DecimalInput, Field, Info, Section, TextInput } from './fields';

const update = (layout: AirportLayout, id: string, patch: Record<string, unknown>) => applyOp(updateEntity(layout, id, patch));

const fmt = (n: number, digits = 2): string => String(Math.round(n * 10 ** digits) / 10 ** digits);

/** 参考値・ゲーム値の注意書き（参考値を表示する場所には必ず添える） */
export function Disclaimer() {
  return (
    <div className="muted small" data-testid="runway-disclaimer">
      {RUNWAY_DISCLAIMER}
    </div>
  );
}

// ---------------------------------------------------------------- ツールのオプション（Toolbox）

export function RunwayToolOptions() {
  const o = useEditor((s) => s.options);
  const set = actions.setOption;
  const free = o.runwayAlignment === 'free';
  return (
    <>
      <label>
        方式
        <select
          value={o.runwayAlignment}
          onChange={(e) => set('runwayAlignment', e.target.value as ToolOptions['runwayAlignment'])}
          data-testid="opt-runwayAlignment"
        >
          <option value="grid8">{RUNWAY_UI.alignment.grid8}</option>
          <option value="free">{RUNWAY_UI.alignment.free}</option>
        </select>
      </label>
      {free && (
        <div className="free-options" data-testid="free-options">
          <label>
            配置方法
            <select value={o.freeInput} onChange={(e) => set('freeInput', e.target.value as ToolOptions['freeInput'])} data-testid="opt-freeInput">
              <option value="drag">{RUNWAY_UI.input.drag}</option>
              <option value="numeric">{RUNWAY_UI.input.numeric}</option>
            </select>
          </label>
          {o.freeInput === 'numeric' && (
            <>
              <label>
                {RUNWAY_UI.trueHeading}
                <DecimalInput value={o.freeHeadingDeg} min={0} max={359.999} step={0.1} onCommit={(v) => set('freeHeadingDeg', v)} testid="opt-freeHeading" />
              </label>
              <label>
                {RUNWAY_UI.lengthM}
                <DecimalInput value={o.freeLengthM} min={FREE_RUNWAY_MIN_M} max={Math.floor(FREE_RUNWAY_MAX_M)} step={10} onCommit={(v) => set('freeLengthM', v)} testid="opt-freeLength" />
              </label>
              <label>
                基準点
                <select value={o.freeAnchor} onChange={(e) => set('freeAnchor', e.target.value as 'start' | 'mid')} data-testid="opt-freeAnchor">
                  <option value="start">{RUNWAY_UI.anchor.start}</option>
                  <option value="mid">{RUNWAY_UI.anchor.mid}</option>
                </select>
              </label>
            </>
          )}
          <label>
            格子の吸着
            <select value={o.gridSnap} onChange={(e) => set('gridSnap', e.target.value as ToolOptions['gridSnap'])} data-testid="opt-gridSnap">
              {(['tile', 'half', 'off'] as const).map((k) => (
                <option key={k} value={k}>
                  {RUNWAY_UI.gridSnap[k]}
                </option>
              ))}
            </select>
          </label>
          {o.freeInput === 'drag' && (
            <>
              <label>
                方位の吸着
                <select value={o.angleSnapDeg} onChange={(e) => set('angleSnapDeg', Number(e.target.value) as ToolOptions['angleSnapDeg'])} data-testid="opt-angleSnap">
                  {([0, 1, 5, 10, 15, 45] as const).map((k) => (
                    <option key={k} value={k}>
                      {RUNWAY_UI.angleSnap[k]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                長さの吸着
                <select value={o.lengthSnapM} onChange={(e) => set('lengthSnapM', Number(e.target.value) as ToolOptions['lengthSnapM'])} data-testid="opt-lengthSnap">
                  {([0, 10, 50, 100] as const).map((k) => (
                    <option key={k} value={k}>
                      {RUNWAY_UI.lengthSnap[k]}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <div className="muted small">{RUNWAY_UI.freeNote}</div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 滑走路のプロパティ

/** 判定基準のバッジ（従来 / 実寸） */
export function CriterionBadge({ free, testid }: { free: boolean; testid?: string }) {
  return (
    <span className={free ? 'badge free-badge' : 'badge legacy-badge'} data-testid={testid} title={free ? RUNWAY_UI.freeCriterion : RUNWAY_UI.legacyCriterion}>
      {free ? RUNWAY_UI.badgeFree : RUNWAY_UI.badgeLegacy}
    </span>
  );
}

function ChangeList({ items }: { items: readonly string[] }) {
  return (
    <ul className="help small">
      {items.map((t) => (
        <li key={t}>{t}</li>
      ))}
    </ul>
  );
}

/** 従来形の滑走路: 判定の基準の表示と「自由形に変換」 */
export function LegacyRunwayExtras({ layout, id }: { layout: AirportLayout; id: string }) {
  const [confirm, setConfirm] = useState(false);
  const mode = useEditor((s) => s.mode);
  return (
    <Section title="判定の基準" testid="runway-criterion">
      <div className="criterion-row">
        <CriterionBadge free={false} /> <span className="small">{RUNWAY_UI.legacyCriterion}</span>
      </div>
      {mode === 'build' &&
        (confirm ? (
          <div className="confirm-box" data-testid="convert-confirm">
            <div className="small">{RUNWAY_UI.convertExplain}</div>
            <ChangeList items={RUNWAY_UI.convertChanges} />
            <div className="small">{RUNWAY_UI.convertUndo}</div>
            <div className="prop-actions">
              <button
                className="primary"
                data-testid="convert-do"
                onClick={() => {
                  applyOp(convertRunwayToFree(layout, id));
                  setConfirm(false);
                }}
              >
                {RUNWAY_UI.convertDo}
              </button>
              <button onClick={() => setConfirm(false)}>{RUNWAY_UI.cancel}</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setConfirm(true)} data-testid="convert-to-free">
            {RUNWAY_UI.convertToFree}
          </button>
        ))}
    </Section>
  );
}

const DIM_KEYS: DefaultKey[] = ['shoulderWidthM', 'stripHalfWidthM', 'stripEndM', 'resaLengthM', 'resaWidthM', 'holdingPositionM'];

/** 参考値と出典の表（ゲーム値との対応。注意書きつき） */
function ReferenceTable({ r }: { r: RunwayFree }) {
  const cur = resolveRunwayDims(r);
  return (
    <details className="ref-table" data-testid="runway-reference">
      <summary>{RUNWAY_UI.refTitle}</summary>
      {DIM_KEYS.map((k) => {
        const basis = FREE_RUNWAY_DEFAULT_BASIS[k];
        const src = RUNWAY_REF_SOURCES[basis.source];
        return (
          <div key={k} className="ref-row">
            <div>
              <b>{RUNWAY_UI.dimLabels[k]}</b>: {RUNWAY_UI.refGame} {cur[k]} m（既定 {FREE_RUNWAY_DEFAULTS[r.surfaceWidthM][k]} m）
            </div>
            <div className="small muted">
              {basis.refKeys.map((rk) => RUNWAY_REFERENCE[rk]).filter(Boolean).map((v, i) => (
                <div key={i}>
                  {RUNWAY_UI.refRef} {v!.value}: {v!.note}
                </div>
              ))}
              <div>{basis.note}</div>
              {src && <div>出典: {src.publisher} {src.title}（{src.accessed} 閲覧）</div>}
            </div>
          </div>
        );
      })}
      <Disclaimer />
    </details>
  );
}

/** 自由形の滑走路の編集欄 */
export function FreeRunwayFields({ layout, id, r, entries }: { layout: AirportLayout; id: string; r: RunwayFree; entries: string[] }) {
  const [confirm, setConfirm] = useState(false);
  const mode = useEditor((s) => s.mode);
  const ds = designatorsOf(r, layout);
  const axis = runwayAxis(r);
  const end = axis.end;
  const dims = resolveRunwayDims(r);
  const variation = layout.magneticVariationDeg ?? 0;
  const dimPatch = (patch: Record<string, number>) => update(layout, id, { dims: { ...(r.dims ?? {}), ...patch } });
  const hasOverride = r.dims !== undefined && Object.keys(r.dims).length > 0;
  const slope = (r.dims?.elevationStartM !== undefined || r.dims?.elevationEndM !== undefined) ? (((r.dims?.elevationEndM ?? 0) - (r.dims?.elevationStartM ?? 0)) / r.lengthM) * 100 : null;
  const suffixValue = r.designatorSuffix ?? 'auto';
  return (
    <>
      <div className="criterion-row" data-testid="runway-criterion">
        <CriterionBadge free /> <span className="small">{RUNWAY_UI.freeCriterion}</span>
      </div>
      <Field label="名前">
        <TextInput value={r.name} onCommit={(v) => update(layout, id, { name: v })} testid="prop-name" />
      </Field>
      <Field label={RUNWAY_UI.trueHeading}>
        <DecimalInput value={r.headingDeg} min={0} max={359.999} step={0.1} onCommit={(v) => update(layout, id, { headingDeg: v })} testid="prop-trueHeading" />
      </Field>
      <Info label={RUNWAY_UI.magHeading} testid="prop-magHeading">
        {`${ds.magDeg[0].toFixed(1)}°（磁気偏角 ${MAG_VAR_LABEL(variation)}）`}
      </Info>
      <Field label={RUNWAY_UI.lengthM}>
        <DecimalInput value={r.lengthM} min={FREE_RUNWAY_MIN_M} max={FREE_RUNWAY_MAX_M} step={10} onCommit={(v) => update(layout, id, { lengthM: v })} testid="prop-lengthM" />
      </Field>
      <Field label="舗装幅">
        <select value={r.surfaceWidthM} onChange={(e) => update(layout, id, { surfaceWidthM: Number(e.target.value) })} data-testid="prop-width">
          <option value={30}>30m（S級まで）</option>
          <option value={45}>45m（M級まで）</option>
          <option value={60}>60m（L級まで）</option>
        </select>
      </Field>
      <Info label={RUNWAY_UI.designators} testid="prop-designators">{`${ds.text[0]}/${ds.text[1]}`}</Info>
      <Field label={RUNWAY_UI.suffix}>
        <select
          value={suffixValue}
          onChange={(e) => update(layout, id, { designatorSuffix: e.target.value === 'auto' ? null : (e.target.value as RunwaySuffix) })}
          data-testid="prop-suffix"
        >
          {(['auto', 'L', 'C', 'R', 'none'] as const).map((k) => (
            <option key={k} value={k}>
              {RUNWAY_UI.suffixOptions[k]}
            </option>
          ))}
        </select>
      </Field>
      <Info label="実長">{`${runwayLengthM(r).toLocaleString()} m`}</Info>
      <Info label="使用可能な機体" testid="prop-maxSize">{runwayMaxSize(r) ? `${runwayMaxSize(r)}級まで` : '使用不可'}</Info>
      <Info label={RUNWAY_UI.startEnd}>{`(${fmt(r.start.x)}, ${fmt(r.start.y)}) → (${fmt(end.x)}, ${fmt(end.y)})`}</Info>
      <Info label="滑走路入口">{entries.length === 0 ? 'なし' : entries.map((n) => <EntityLinkLite key={n} layout={layout} id={n} />)}</Info>

      <Section title={RUNWAY_UI.dimsTitle} testid="runway-dims">
        <div className="muted small">{RUNWAY_UI.dimsExplain}</div>
        {DIM_KEYS.map((k) => (
          <Field key={k} label={RUNWAY_UI.dimLabels[k]} title={`${RUNWAY_UI.refGame}。${FREE_RUNWAY_DEFAULT_BASIS[k].note}。${RUNWAY_DISCLAIMER}`}>
            <DecimalInput
              value={dims[k]}
              min={k === 'stripHalfWidthM' || k === 'resaWidthM' ? 0.1 : 0}
              max={5000}
              onCommit={(v) => dimPatch({ [k]: v })}
              testid={`prop-dim-${k}`}
            />
            {r.dims?.[k] !== undefined && <span className="badge game" title={`既定 ${FREE_RUNWAY_DEFAULTS[r.surfaceWidthM][k]} m`}>{RUNWAY_UI.dimsOverridden}</span>}
          </Field>
        ))}
        <Field label={RUNWAY_UI.elevationStart}>
          <DecimalInput value={r.dims?.elevationStartM} min={-500} max={9000} placeholder="0" onCommit={(v) => dimPatch({ elevationStartM: v })} testid="prop-elevStart" />
        </Field>
        <Field label={RUNWAY_UI.elevationEnd}>
          <DecimalInput value={r.dims?.elevationEndM} min={-500} max={9000} placeholder="0" onCommit={(v) => dimPatch({ elevationEndM: v })} testid="prop-elevEnd" />
        </Field>
        <Info label={RUNWAY_UI.slope} testid="prop-slope" title={RUNWAY_UI.slopeNote}>
          {slope === null ? '—' : `${fmt(slope)} %`}
        </Info>
        {hasOverride && mode === 'build' && (
          <button className="small" onClick={() => update(layout, id, { dims: {} })} data-testid="dims-reset">
            {RUNWAY_UI.dimsReset}
          </button>
        )}
        <Disclaimer />
        <ReferenceTable r={r} />
      </Section>

      {mode === 'build' && (
        <Section title="従来形との関係">
          {confirm ? (
            <div className="confirm-box" data-testid="snap-confirm">
              <div className="small">{RUNWAY_UI.snapExplain}</div>
              <ChangeList items={RUNWAY_UI.snapChanges} />
              <div className="small">{RUNWAY_UI.convertUndo}</div>
              <div className="prop-actions">
                <button
                  className="primary"
                  data-testid="snap-do"
                  onClick={() => {
                    applyOp(snapRunwayToGrid(layout, id));
                    setConfirm(false);
                  }}
                >
                  {RUNWAY_UI.snapDo}
                </button>
                <button onClick={() => setConfirm(false)}>{RUNWAY_UI.cancel}</button>
              </div>
            </div>
          ) : (
            <button onClick={() => setConfirm(true)} data-testid="snap-to-grid">
              {RUNWAY_UI.snapToGrid}
            </button>
          )}
          <div className="muted small">{RUNWAY_UI.handleHelp}</div>
        </Section>
      )}
    </>
  );
}

function EntityLinkLite({ layout, id }: { layout: AirportLayout; id: string }) {
  return <span className="link-like">{displayName(layout, id)}</span>;
}

/** 従来形の滑走路の向き（真方位）に対する、磁方位つきの番号の表示 */
export function legacyHeadingLabel(layout: AirportLayout, r: RunwayGrid8, h: RunwayGrid8['heading']): string {
  const d = designatorsOf({ ...r, heading: h }, layout);
  return `${h}°（${d.text.join('/')}）`;
}

// ---------------------------------------------------------------- 空港の設定（何も選択していないとき）

export function AirportSettings() {
  const layout = useLayout();
  const mode = useEditor((s) => s.mode);
  const variation = layout.magneticVariationDeg ?? 0;
  const ruleSet = layout.ruleSet ?? 'classic';
  const runways = sortedValues(layout.runways);
  const disabled = mode === 'operate';
  const taxiGraph = blockGraphOf(layout);
  return (
    <Section title={RUNWAY_UI.settingsTitle} testid="airport-settings">
      <Field label={RUNWAY_UI.magVar}>
        {disabled ? (
          <span>{MAG_VAR_LABEL(variation)}</span>
        ) : (
          <DecimalInput value={variation} min={-180} max={180} step={0.1} onCommit={(v) => applyOp(updateLayoutSettings(layout, { magneticVariationDeg: v }))} testid="setting-magvar" />
        )}
        <span className="small muted" data-testid="setting-magvar-label">
          {MAG_VAR_LABEL(variation)}
        </span>
      </Field>
      <div className="muted small">{RUNWAY_UI.magVarHelp}</div>
      <Field label={RUNWAY_UI.ruleSet}>
        <select
          value={ruleSet}
          disabled={disabled}
          onChange={(e) => applyOp(updateLayoutSettings(layout, { ruleSet: e.target.value as 'classic' | 'realistic' }))}
          data-testid="setting-ruleSet"
        >
          <option value="classic">{RUNWAY_UI.ruleClassic}</option>
          <option value="realistic">{RUNWAY_UI.ruleRealistic}</option>
        </select>
      </Field>
      <div className="muted small" data-testid="setting-ruleExplain">
        {RUNWAY_UI.ruleExplain}
      </div>
      <Field label={TAXI_UI.mode}>
        <select
          value={layout.taxiMode ?? 'full'}
          disabled={disabled}
          onChange={(e) => applyOp(updateLayoutSettings(layout, { taxiMode: e.target.value as 'full' | 'block' }))}
          data-testid="setting-taxiMode"
        >
          <option value="full">{TAXI_UI.modeFull}</option>
          <option value="block">{TAXI_UI.modeBlock}</option>
        </select>
      </Field>
      <div className="muted small" data-testid="setting-taxiExplain">{TAXI_UI.modeExplain}</div>
      <Field label={ACCESS_UI.model}>
        <select
          value={layout.accessCapacityModel ?? 'aggregate'}
          disabled={disabled}
          onChange={(e) => applyOp(updateLayoutSettings(layout, { accessCapacityModel: e.target.value === 'segment' ? 'segment' : null }))}
          data-testid="setting-accessModel"
        >
          <option value="aggregate">{ACCESS_UI.modelAggregate}</option>
          <option value="segment">{ACCESS_UI.modelSegment}</option>
        </select>
      </Field>
      <div className="muted small" data-testid="setting-accessExplain">{ACCESS_UI.modelExplain}</div>
      <Field label={TAXI_UI.tiles}>
        {disabled ? (
          <span>{layout.taxiBlockTiles ?? TAXI_BLOCK_TILES_DEFAULT}</span>
        ) : (
          <DecimalInput value={layout.taxiBlockTiles ?? TAXI_BLOCK_TILES_DEFAULT} min={TAXI_BLOCK_TILES_MIN} max={TAXI_BLOCK_TILES_MAX} step={1} onCommit={(v) => applyOp(updateLayoutSettings(layout, { taxiBlockTiles: v }))} testid="setting-taxiBlockTiles" />
        )}
      </Field>
      <div className="muted small">{TAXI_UI.tilesHelp}</div>
      {disabled && <div className="muted small" data-testid="setting-taxi-locked">{TAXI_UI.operateLocked}</div>}
      {taxiGraph && <div className="muted small" data-testid="setting-taxiSummary">{TAXI_UI.summary(Object.keys(taxiGraph.blocks).length, Object.keys(taxiGraph.corridors).length)}</div>}
      <Disclaimer />
      <div className="prop-section-title">{RUNWAY_UI.numbersTitle}</div>
      <div data-testid="settings-designators">
        {runways.length === 0 && <div className="muted small">{RUNWAY_UI.noRunways}</div>}
        {runways.map((r) => {
          const d = designatorsOf(r, layout);
          return (
            <div key={r.id} className="prop-field" data-testid={`settings-designator-${r.id}`}>
              <span className="prop-label">
                {displayName(layout, r.id)} <CriterionBadge free={isFreeRunway(r)} />
              </span>
              <span className="prop-value info">{`${d.text[0]}/${d.text[1]}（真 ${fmt(d.trueDeg[0], 1)}° / 磁 ${fmt(d.magDeg[0], 1)}°）`}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}
