import { useMemo, useState, type ReactNode } from 'react';
import { DecimalInput, Field, Info, NumberInput, Section, TextInput } from './fields';
import { EASA_OMGWS_BANDS, FAA_TDG_PAVEMENT_WIDTH_M, assessTaxiwayWidth, requiredPavementWidthM } from '../core/airside/taxiwayDesign';
import { AirportSettings, CriterionBadge, FreeRunwayFields, LegacyRunwayExtras, legacyHeadingLabel } from './RunwayPanels';
import { FACILITY_SIM_EFFECT, FACILITY_SPECS, PROP_SCHEMAS, TAXI_BLOCK_MAX_AIRCRAFT, TERMINAL_AREA_SPECS, TILE_M, propDefault } from '../core/model/catalog';
import { blockCapacity } from '../core/sim/taxiBlocks';
import { blockGraphOf } from '../core/layout/blockGraph';
import { apronBusesOf, connectedTerminal, gateMode } from '../core/model/gates';
import { busGateStatus, resolveBusGateForStand } from '../core/terminal/busGateAssignment';
import { compareIds, sortedValues } from '../core/model/ids';
import {
  BUILD_STATES,
  HEADINGS,
  entityTypeOf,
  isFreeRunway,
  type AirportLayout,
  type BuildState,
  type RoadClass,
  type RoadConnectorKind,
  type Rotation,
  type TerminalTransitKind,
} from '../core/model/types';
import { distance } from '../core/geometry/vec';
import { facilityDims, standEntry } from '../core/layout/footprint';
import { facilityLevel, roadEdgeLevelValid } from '../core/model/levels';
import { INTERIOR_MIN_FLOOR, TERMINAL_AREA_MIN_LEVEL, levelsInUse } from '../core/layout/levelRules';
import { edgesOfNode } from '../core/layout/network';
import {
  deleteEntity,
  connectRoadLevels,
  addPortal,
  addTerminalTransitLink,
  deletePortal,
  deleteTerminalTransitLink,
  duplicateEntity,
  reverseEdge,
  rotateEntity,
  setFacilityFootprint,
  updateEntity,
  PORTAL_FACILITY_KINDS,
} from '../core/layout/operations';
import { rectRing, validateOrthogonalPolygon } from '../core/geometry/polygon';
import { classifyFacilityConnection, verifyPortalAccess } from '../core/terminal/networkGraph';
import { deriveTerminalComplexes } from '../core/terminal/complex';
import { serviceComplexOf } from '../core/terminal/serviceComplex';
import { designatorsOf } from '../core/layout/designators';
import { runwayEnd, runwayLengthClass, runwayLengthM, runwayMaxSize } from '../core/layout/runway';
import { actions, applyOp, closeTemporarily, editorStore, entityExists, showToast, useAnalysis, useEditor, useLayout } from '../editor/store';
import { ops } from '../editor/simRunner';
import { closureReasonsFor } from '../core/sim/closureState';
import { areaOccupancy, facilityLoad } from '../core/sim/passengers';
import { areaProcessingPerHour, areaServerCount, isProcessingArea, serviceSecPerPax } from '../core/terminal/capacity';
import { GATE_LOUNGE_CAPACITY, PAX_PER_TILE, defaultVerticalCapacityPerHour } from '../core/terminal/model';
import { createContext } from '../core/sim/context';
import { turnaroundCapacityDetail } from '../core/economy/planning';
import { analyzeAirportCapacity } from '../core/economy/capacity';
import { peakProcessDemand } from '../core/economy/peakDemand';
import { cargoHandlingCapacityM3PerHour } from '../core/economy/cargo';
import { composeCapabilityReadings, facilityCapability, layoutCapabilities } from '../core/capability';
import type { Facility, TerminalArea } from '../core/model/types';
import { computePreview, areaKindOf, facilityKindOf } from '../editor/tools';
import { serviceCategoryOfAreaKind, serviceProfilesFor } from '../core/terminal/serviceProfile';
import { BALANCE } from '../core/economy/balance';
import type { UnitKind } from '../core/sim/types';
import type { TerminalAreaKind } from '../core/model/types';
import { focusEntity } from '../editor/input';
import {
  BOARDING_MODE_LABEL,
  BUILD_STATE_LABEL,
  ENTITY_LABEL,
  FACILITY_LABEL,
  NODE_KIND_LABEL,
  OPERABILITY_LABEL,
  propLabel,
  PROJECT_KIND_LABEL,
  RAIL_SERVICE_LABEL,
  ROAD_CLASS_LABEL,
  CONNECTOR_KIND_LABEL,
  SIZE_LABEL,
  displayName,
  issueText,
  AREA_KIND_LABEL,
  AREA_PROP_LABEL,
  ZONE_LABEL,
  RUNWAY_UI,
  PICK_CANDIDATES_LABEL,
  STAND_GATE_FIX_NOTE,
  PLACEMENT_PROBLEM_LABEL,
  INTERIOR_CHILDREN_LABEL,
  TAXI_UI,
  PORTAL_UI,
  FOOTPRINT_UI,
  PHASE7B_UI,
  PREVIEW_UI,
  UNIT_KIND_LABEL,
  CAPABILITY_STATE_LABEL,
  SIM_EFFECT_LABEL,
} from '../i18n/ja';

export function PropertiesPanel() {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const selection = useEditor((s) => s.selection);
  const pickCandidates = useEditor((s) => s.pickCandidates);
  const mode = useEditor((s) => s.mode);
  const layout = useLayout();
  if ((!selection || !entityTypeOf(selection)) && mode === 'operate') {
    return (
      <div className="properties empty" data-testid="properties">
        <p>運航中です。機体をクリック（または運航表の行を選択）すると状態・経路・運航履歴を表示します。</p>
        <ul className="help">
          <li>Space: 一時停止 / 再開</li>
          <li>1〜5: 時間倍率（実時間〜×600）</li>
          <li>右ドラッグ・中ドラッグ: パン / ホイール: ズーム</li>
          <li>「論理ネットワーク・予約」表示で、各機が予約中の誘導路を色分け表示</li>
          <li>滑走路の枠: 赤 = 使用中、黄 = 進入予約あり</li>
          <li>運航中はレイアウトを編集できません</li>
        </ul>
      </div>
    );
  }
  if (!selection || !entityTypeOf(selection)) {
    return (
      <div className="properties empty" data-testid="properties">
        <p>施設を選択するとプロパティを表示・編集できます。</p>
        <ul className="help">
          <li>左クリック: 選択 / ドラッグ: 移動</li>
          <li>右ドラッグ・中ドラッグ・Space+ドラッグ: パン</li>
          <li>ホイール: ズーム</li>
          <li>R: 回転 / Ctrl+D: 複製 / Delete: 削除</li>
          <li>Ctrl+Z: 元に戻す / Ctrl+Shift+Z・Ctrl+Y: やり直し</li>
          <li>矢印: 1タイル移動（Shift で10）/ Esc: 解除</li>
        </ul>
        <PlacementPreviewSection />
        <AirportSettings />
      </div>
    );
  }
  return (
    <div className="properties" data-testid="properties" key={selection}>
      {pickCandidates.length >= 2 && pickCandidates.includes(selection) && (
        <div className="pick-candidates" data-testid="pick-candidates">
          <span className="pick-candidates-title">{PICK_CANDIDATES_LABEL}</span>
          {pickCandidates.filter((c) => entityExists(layout, c)).map((c) => (
            <button
              key={c}
              className={c === selection ? 'small active' : 'small'}
              onClick={() => actions.select(c, pickCandidates)}
              data-testid={`pick-candidate-${c}`}
            >
              {displayName(layout, c)}
            </button>
          ))}
        </div>
      )}
      <EntityProperties layout={layout} id={selection} />
    </div>
  );
}

const update = (layout: AirportLayout, id: string, patch: Record<string, unknown>) => applyOp(updateEntity(layout, id, patch));

/** 誘導路の「区間の進入可能機数の上限」（フェーズ 2。区間ごとに進む方式のときだけ効く） */
function TaxiBlockFields({ layout, id, readOnly }: { layout: AirportLayout; id: string; readOnly: boolean }) {
  const e = layout.taxiways[id]!;
  const graph = blockGraphOf(layout);
  const blocks = graph ? (graph.edgeBlocks[id] ?? []).map((bid) => graph.blocks[bid]!) : [];
  const caps = blocks.filter((b) => !b.entry).map((b) => blockCapacity(b, 1, 'M'));
  return (
    <>
      <Field label={TAXI_UI.blockMax} title={TAXI_UI.blockMaxHelp}>
        <select
          value={e.blockMaxAircraft ?? ''}
          disabled={readOnly}
          onChange={(ev) => update(layout, id, { blockMaxAircraft: ev.target.value === '' ? null : Number(ev.target.value) })}
          data-testid="prop-blockMax"
        >
          <option value="">{TAXI_UI.blockMaxAuto}</option>
          {Array.from({ length: TAXI_BLOCK_MAX_AIRCRAFT }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Field>
      {layout.taxiMode !== 'block' && <div className="muted small" data-testid="prop-blockMax-inactive">{TAXI_UI.blockMaxInactive}</div>}
      {graph && blocks.length > 0 && <Info label="区間" testid="prop-blocks">{TAXI_UI.blocksOf(blocks.length, caps.length ? (Math.min(...caps) === Math.max(...caps) ? String(caps[0]) : `${Math.min(...caps)}〜${Math.max(...caps)}`) : '—')}</Info>}
    </>
  );
}

/**
 * 誘導路の実寸設計データ（5-17 T3）の編集と幅適合の表示。
 * 設計データは保存される記録で、通行可否の判定（幅区分・コードF）には影響しない。
 * 適合判定は core/airside/taxiwayDesign の assessTaxiwayWidth が正本で、判定に使う OMGWS は
 * EASA バンドから選ぶ（帯内では必要幅が一定のため、帯の上限未満の代表値で判定する）。
 * 必要幅が決まらないケースは unknown として推測しない。
 */
export function TaxiwayDesignFields({ layout, id, readOnly }: { layout: AirportLayout; id: string; readOnly: boolean }) {
  const e = layout.taxiways[id]!;
  const [bandIdx, setBandIdx] = useState(EASA_OMGWS_BANDS.length - 1);
  const band = EASA_OMGWS_BANDS[Math.min(bandIdx, EASA_OMGWS_BANDS.length - 1)]!;
  const omgwsM = band.maxOmgwsM - 0.01;
  const hasWidth = e.pavementWidthM !== undefined;
  const required = hasWidth ? requiredPavementWidthM(e.designProfile ?? 'legacy-game', { designGroup: e.designGroup, omgwsM }) : null;
  const assessment = assessTaxiwayWidth(e, omgwsM);
  return (
    <Section title={TAXI_UI.designSection} testid="taxi-design">
      <div className="muted small">{TAXI_UI.designExplain}</div>
      <Field label={TAXI_UI.pavementWidth}>
        <DecimalInput
          value={e.pavementWidthM}
          min={1}
          max={100}
          onCommit={(v) => update(layout, id, { pavementWidthM: v })}
          testid="prop-pavementWidthM"
          placeholder={TAXI_UI.unset}
        />
        {hasWidth && !readOnly && (
          <button className="small" onClick={() => update(layout, id, { pavementWidthM: null })} data-testid="taxi-design-clear-pavement">
            {TAXI_UI.clear}
          </button>
        )}
      </Field>
      <Field label={TAXI_UI.shoulderWidth}>
        <DecimalInput
          value={e.shoulderWidthM}
          min={0}
          max={100}
          onCommit={(v) => update(layout, id, { shoulderWidthM: v })}
          testid="prop-shoulderWidthM"
          placeholder={TAXI_UI.unset}
        />
        {e.shoulderWidthM !== undefined && !readOnly && (
          <button className="small" onClick={() => update(layout, id, { shoulderWidthM: null })} data-testid="taxi-design-clear-shoulder">
            {TAXI_UI.clear}
          </button>
        )}
      </Field>
      <Field label={TAXI_UI.designProfile}>
        <select
          value={e.designProfile ?? ''}
          disabled={readOnly}
          onChange={(ev) => update(layout, id, { designProfile: ev.target.value === '' ? null : ev.target.value })}
          data-testid="prop-designProfile"
        >
          <option value="">{TAXI_UI.profileNone}</option>
          <option value="faa-tdg">{TAXI_UI.profileFaa}</option>
          <option value="easa-omgws">{TAXI_UI.profileEasa}</option>
          <option value="legacy-game">{TAXI_UI.profileLegacy}</option>
        </select>
      </Field>
      {e.designProfile === 'faa-tdg' && (
        <Field label={TAXI_UI.designGroup}>
          <select
            value={e.designGroup ?? ''}
            disabled={readOnly}
            onChange={(ev) => update(layout, id, { designGroup: ev.target.value === '' ? null : ev.target.value })}
            data-testid="prop-designGroup"
          >
            <option value="">{TAXI_UI.groupNone}</option>
            {Object.keys(FAA_TDG_PAVEMENT_WIDTH_M).map((g) => (
              <option key={g} value={g}>
                TDG {g}（必要幅 {FAA_TDG_PAVEMENT_WIDTH_M[g]} m）
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label={TAXI_UI.role}>
        <select
          value={e.role ?? 'normal'}
          disabled={readOnly}
          onChange={(ev) => update(layout, id, { role: ev.target.value === 'normal' ? null : ev.target.value })}
          data-testid="prop-role"
        >
          <option value="normal">{TAXI_UI.roleNormal}</option>
          <option value="rapidExit">{TAXI_UI.roleRapidExit}</option>
        </select>
      </Field>
      {hasWidth && (
        <Field label={TAXI_UI.assessBand}>
          <select value={bandIdx} onChange={(ev) => setBandIdx(Number(ev.target.value))} data-testid="taxi-design-band">
            {EASA_OMGWS_BANDS.map((b, i) => (
              <option key={b.maxOmgwsM} value={i}>
                OMGWS {b.maxOmgwsM} m 未満
              </option>
            ))}
          </select>
        </Field>
      )}
      <Info label={TAXI_UI.assessResult} testid="taxi-design-assessment">
        <span data-state={assessment}>
          {!hasWidth
            ? TAXI_UI.assessLegacy
            : assessment === 'sufficient' && required !== null
              ? TAXI_UI.assessSufficient(String(required))
              : assessment === 'insufficient' && required !== null
                ? TAXI_UI.assessInsufficient(String(required))
                : TAXI_UI.assessUnknown}
        </span>
      </Info>
      {hasWidth && required !== null && <Info label={TAXI_UI.requiredWidth}>{`${required} m`}</Info>}
    </Section>
  );
}

const portalStatusText = (s: string): string =>
  s === 'operational' ? PORTAL_UI.statusOperational : s === 'underConstruction' ? PORTAL_UI.statusPending : PORTAL_UI.statusUnreachable;

/**
 * 歩行ポータル（5-16 T2）の作成・削除（交通施設側）。
 * 接続の作成・削除は core/layout/operations の addPortal / deletePortal が正本で、
 * 到達性の表示は terminal/networkGraph の verifyPortalAccess（検証・能力と同じ判定）を読む。
 * 作成が拒否される場合（階の不一致・遠隔すぎる接続など）は applyOp が理由を通知する。
 */
export function FacilityPortalSection({ layout, facilityId, readOnly }: { layout: AirportLayout; facilityId: string; readOnly: boolean }) {
  const portals = sortedValues(layout.portals ?? {}).filter((p) => p.facilityId === facilityId);
  const areas = sortedValues(layout.terminalAreas);
  const [areaId, setAreaId] = useState('');
  const chosen = areas.some((a) => a.id === areaId) ? areaId : (areas[0]?.id ?? '');
  const access = verifyPortalAccess(layout).find((s) => s.facilityId === facilityId);
  return (
    <Section title={PORTAL_UI.section} testid="portal-section">
      <div className="muted small">{PORTAL_UI.explain}</div>
      {portals.length === 0 ? (
        <Info label="接続">{PORTAL_UI.none}</Info>
      ) : (
        portals.map((p) => {
          // B8: このポータル先エリアへの複合グラフ分類（経路の有無・所要秒）。検証・能力と同じ純関数を読む
          const conn = classifyFacilityConnection(layout, facilityId, p.areaId);
          const routeSec = conn.route ? Math.round(conn.route.costSec) : conn.futureRoute ? Math.round(conn.futureRoute.costSec) : null;
          return (
            <div key={p.id}>
              <Info label="接続先">
                <EntityLink layout={layout} id={p.areaId} />
                <span className="muted small"> {PORTAL_UI.floor(p.floorIndex, p.mapLevel)}</span>
                {!readOnly && (
                  <button className="small danger" onClick={() => applyOp(deletePortal(layout, p.id))} data-testid={`portal-delete-${p.id}`}>
                    {PORTAL_UI.remove}
                  </button>
                )}
              </Info>
              <Info label={PHASE7B_UI.diagRoute} testid={`portal-route-${p.id}`}>
                {conn.status === 'underConstruction'
                  ? PHASE7B_UI.diagFuture
                  : PHASE7B_UI.diagRouteValue(portalStatusText(conn.status), conn.status === 'operational' ? routeSec : null)}
              </Info>
            </div>
          );
        })
      )}
      {access && (
        <Info label={PORTAL_UI.access} testid="portal-access-status">
          {PORTAL_UI.accessValue(portalStatusText(access.toEntrance), portalStatusText(access.fromExit))}
        </Info>
      )}
      {!readOnly && areas.length > 0 && (
        <Field label={PORTAL_UI.addLabel}>
          <select value={chosen} onChange={(e) => setAreaId(e.target.value)} data-testid="portal-area-select">
            {areas.map((a) => (
              <option key={a.id} value={a.id}>
                {`${displayName(layout, a.terminalId)} / ${AREA_KIND_LABEL[a.kind]}（${a.level < 0 ? `地下${-a.level}階` : `${a.level + 1}F`}）`}
              </option>
            ))}
          </select>
          <button onClick={() => chosen && applyOp(addPortal(layout, { facilityId, areaId: chosen }))} data-testid="portal-add">
            {PORTAL_UI.add}
          </button>
        </Field>
      )}
    </Section>
  );
}

/**
 * ターミナル複合体の表示（UIデザイン更新 第7段階b / B7）。
 * 物理複合体（terminal/complex.ts: 辺接触＋運用中の高層連絡通路で決定的に導出）と、
 * サービス複合体（terminal/serviceComplex.ts: 運用中ターミナルリンクで結ばれた建物群。
 * サテライトが本体の入口・保安・受取所を使える候補集合）を併記する。どちらも派生データで保存には影響しない。
 * 地図でのハイライトは構成建物のリンク（focusEntity による選択ハイライト）で代替する。
 */
export function TerminalComplexInfo({ layout, terminalId }: { layout: AirportLayout; terminalId: string }) {
  const physical = deriveTerminalComplexes(layout).find((c) => c.buildingIds.includes(terminalId));
  const service = serviceComplexOf(layout, terminalId);
  const members = (ids: string[]) => (
    <span>
      {ids.map((id, i) => (
        <span key={id}>
          {i > 0 ? '、' : ''}
          <EntityLink layout={layout} id={id} />
        </span>
      ))}
      <span className="muted small"> {PHASE7B_UI.complexMembers(ids.length)}</span>
    </span>
  );
  return (
    <Section title={PHASE7B_UI.complexSection} testid="terminal-complex">
      <Info label={PHASE7B_UI.complexPhysical} testid="complex-physical">
        {physical && physical.buildingIds.length > 1 ? members(physical.buildingIds) : PHASE7B_UI.complexAlone}
      </Info>
      <Info label={PHASE7B_UI.complexService} testid="complex-service">
        {service.length > 1 ? members(service) : PHASE7B_UI.complexAlone}
      </Info>
      <div className="muted small">{PHASE7B_UI.complexNote}</div>
    </Section>
  );
}

/** 歩行ポータルの接続一覧（ターミナルエリア側。作成は交通施設側から行う） */
export function AreaPortalSection({ layout, areaId, readOnly }: { layout: AirportLayout; areaId: string; readOnly: boolean }) {
  const portals = sortedValues(layout.portals ?? {}).filter((p) => p.areaId === areaId);
  if (portals.length === 0) return null;
  return (
    <Section title={PORTAL_UI.section} testid="portal-section-area">
      {portals.map((p) => (
        <Info key={p.id} label="接続元">
          <EntityLink layout={layout} id={p.facilityId} />
          <span className="muted small"> {PORTAL_UI.floor(p.floorIndex, p.mapLevel)}</span>
          {!readOnly && (
            <button className="small danger" onClick={() => applyOp(deletePortal(layout, p.id))} data-testid={`portal-delete-${p.id}`}>
              {PORTAL_UI.remove}
            </button>
          )}
        </Info>
      ))}
      <div className="muted small">{PORTAL_UI.fromFacility}</div>
    </Section>
  );
}

/**
 * 施設の外形（フットプリント、5-15 T3）の表示と編集。
 * 編集そのものは地図上（頂点ドラッグ・辺への追加・ダブルクリックで削除）で行い、
 * 作業コピーは editor store の footprintEdit に置く。確定は core の setFacilityFootprint を
 * applyOp で通すため、プレビュー（MapRenderer の作業ポリゴン）と確定結果は同じ頂点列になる。
 * 矩形そのものへ戻す場合は footprint を消す（矩形リングを footprint として保存しない）。
 */
export function FacilityFootprintSection({ layout, f, readOnly }: { layout: AirportLayout; f: Facility; readOnly: boolean }) {
  const footprintEdit = useEditor((s) => s.footprintEdit);
  const editing = footprintEdit?.facilityId === f.id ? footprintEdit : null;
  if (editing) {
    const issues = validateOrthogonalPolygon(editing.points);
    const apply = () => {
      const rect = rectRing(f.origin, f.w, f.h);
      const sameAsRect = editing.points.length === 4 && rect.every((r) => editing.points.some((p) => p.x === r.x && p.y === r.y));
      if (sameAsRect) {
        if (f.footprint) applyOp(setFacilityFootprint(layout, f.id, null));
        actions.endFootprintEdit();
        return;
      }
      if (applyOp(setFacilityFootprint(layout, f.id, editing.points))) actions.endFootprintEdit();
    };
    return (
      <Section title={FOOTPRINT_UI.section} testid="footprint-edit">
        <Info label="頂点">{FOOTPRINT_UI.vertices(editing.points.length)}</Info>
        <div className={issues.length === 0 ? 'muted small' : 'reason ng-text'} data-testid="footprint-validity">
          {issues.length === 0 ? FOOTPRINT_UI.valid : FOOTPRINT_UI.invalid(issues.join(', '))}
        </div>
        <div className="muted small">{FOOTPRINT_UI.help}</div>
        <div className="prop-actions">
          <button className="primary" onClick={apply} disabled={issues.length > 0} data-testid="footprint-edit-apply">
            {FOOTPRINT_UI.apply}
          </button>
          <button onClick={() => actions.endFootprintEdit()} data-testid="footprint-edit-cancel">
            {FOOTPRINT_UI.cancel}
          </button>
        </div>
      </Section>
    );
  }
  return (
    <Section title={FOOTPRINT_UI.section}>
      <Info label="外形" testid="footprint-info">
        {f.footprint ? FOOTPRINT_UI.free(f.footprint.length) : FOOTPRINT_UI.rect}
      </Info>
      {!readOnly && (
        <div className="prop-actions">
          {f.rotation === 0 ? (
            <button onClick={() => actions.startFootprintEdit(f.id)} data-testid="footprint-edit-start">
              {FOOTPRINT_UI.edit}
            </button>
          ) : (
            <span className="muted small">{FOOTPRINT_UI.rotated}</span>
          )}
          {f.footprint && (
            <button onClick={() => applyOp(setFacilityFootprint(layout, f.id, null))} data-testid="footprint-reset">
              {FOOTPRINT_UI.reset}
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/** 差分の表示（+N / -N / ±0） */
const fmtDelta = (before: number, after: number): string => {
  const d = Math.round((after - before) * 100) / 100;
  return d > 0 ? `+${d}` : d < 0 ? `${d}` : '±0';
};

/**
 * エリア1件の能力の代表値（F6-02 配置・増設プレビューの測り方）。
 * 処理系=処理能力（人/時）、サービスカテゴリ=カテゴリ能力（ラウンジは席数・その他は窓口相当）、
 * 昇降系=定員（人/時）、受託手荷物=ベルト本数。能力式のない種別は null。
 */
function areaOwnMeasure(layout: AirportLayout, a: TerminalArea): { value: number; unit: string } | null {
  if (isProcessingArea(a.kind)) return { value: areaProcessingPerHour(a.kind, a.props), unit: '人/時' };
  const category = serviceCategoryOfAreaKind(a.kind);
  if (category) {
    const f = serviceProfilesFor(layout).facilities.find((x) => x.areaId === a.id);
    return f ? { value: f.capacity, unit: category === 'lounge' ? '席' : '窓口相当' } : null;
  }
  if (a.kind === 'stairs' || a.kind === 'escalator' || a.kind === 'elevator') {
    return { value: Number(a.props.capacityPerHour ?? defaultVerticalCapacityPerHour(a.kind)), unit: '人/時' };
  }
  if (a.kind === 'baggageClaim') return { value: Math.max(0, Math.trunc(Number(a.props.belts ?? 0))), unit: '本' };
  return null;
}

/**
 * 配置プレビュー（F6-02）: 配置ツール使用中、現在のゴースト（computePreview の仮レイアウト）で
 * 実計算した能力と、同種合計の現在→配置後を示す。確定後の能力表示と同じ計算式を使うため、
 * プレビューと確定後の表示は一致する。
 */
function PlacementPreviewSection() {
  const tool = useEditor((s) => s.tool);
  const mode = useEditor((s) => s.mode);
  useEditor((s) => s.hover);
  useEditor((s) => s.draft);
  useEditor((s) => s.options);
  const layout = useLayout();
  if (mode !== 'build') return null;
  const fkind = facilityKindOf(tool);
  const akind = areaKindOf(tool);
  if (!fkind && !akind) return null;
  const preview = computePreview(editorStore.getState());
  const createdId = preview?.result.ok ? preview.result.created[0] : undefined;
  const hypo = preview?.result.ok ? preview.result.layout : null;
  let body: ReactNode = <div className="muted small">{PREVIEW_UI.placementHint}</div>;
  if (createdId && hypo) {
    if (fkind) {
      const reading = layoutCapabilities(hypo).find((x) => x.subjectId === createdId);
      const total = (l: AirportLayout) => layoutCapabilities(l).reduce((s2, x) => (l.facilities[x.subjectId]?.kind === fkind ? s2 + (x.effective ?? 0) : s2), 0);
      const before = total(layout);
      const after = total(hypo);
      body = (
        <>
          <Info label={FACILITY_LABEL[fkind]} testid="placement-preview-capability">
            {reading && reading.theoretical !== null ? `理論能力 ${reading.theoretical} ${reading.unit} / 有効能力 ${reading.effective} ${reading.unit}` : PREVIEW_UI.uncomputed}
          </Info>
          <Info label={PREVIEW_UI.kindTotal(FACILITY_LABEL[fkind])} testid="placement-preview-total">{`${before} → ${after}（${fmtDelta(before, after)}）`}</Info>
        </>
      );
    } else {
      const area = hypo.terminalAreas[createdId];
      const m = area ? areaOwnMeasure(hypo, area) : null;
      if (area && m) {
        const total = (l: AirportLayout) =>
          Object.values(l.terminalAreas).reduce((s2, x) => (x.terminalId === area.terminalId && x.kind === area.kind ? s2 + (areaOwnMeasure(l, x)?.value ?? 0) : s2), 0);
        const before = total(layout);
        const after = total(hypo);
        body = (
          <>
            <Info label={AREA_KIND_LABEL[area.kind]} testid="placement-preview-capability">{`${m.value} ${m.unit}`}</Info>
            <Info label={PREVIEW_UI.kindTotal(AREA_KIND_LABEL[area.kind])} testid="placement-preview-total">{`${before} → ${after} ${m.unit}（${fmtDelta(before, after)}）`}</Info>
          </>
        );
      } else {
        body = <div className="muted small">{PREVIEW_UI.uncomputed}</div>;
      }
    }
  }
  return (
    <Section title={PREVIEW_UI.placementSection} testid="placement-preview">
      {body}
    </Section>
  );
}

/**
 * 増設プレビュー（F6-02）: 施設の数値項目を仮変更したときの能力（理論値・有効値）の変化を、
 * 確定前に示す。仮変更は core の updateEntity を通した仮レイアウトで計算する（保存はしない）。
 */
export function FacilityCapabilityPreview({ layout, f }: { layout: AirportLayout; f: Facility }) {
  const [key, setKey] = useState<string | null>(null);
  const [val, setVal] = useState<number | null>(null);
  const defs = (PROP_SCHEMAS[f.kind] ?? []).filter((d) => d.type === 'int');
  const current = layoutCapabilities(layout).find((x) => x.subjectId === f.id);
  if (defs.length === 0 || !current || current.theoretical === null) return null;
  const def = defs.find((d) => d.key === key) ?? defs[0]!;
  const curVal = typeof f.props[def.key] === 'number' ? (f.props[def.key] as number) : (propDefault(def) as number);
  const hypoVal = val ?? curVal;
  const hypo = updateEntity(layout, f.id, { props: { [def.key]: hypoVal } });
  const after = hypo.ok ? layoutCapabilities(hypo.layout).find((x) => x.subjectId === f.id) : undefined;
  return (
    <Section title={PREVIEW_UI.expansionSection} testid="capability-preview">
      <div className="muted small">{PREVIEW_UI.expansionExplain}</div>
      <Field label={PREVIEW_UI.propLabel}>
        <select
          value={def.key}
          onChange={(e) => {
            setKey(e.target.value);
            setVal(null);
          }}
          data-testid="capability-preview-prop"
        >
          {defs.map((d) => (
            <option key={d.key} value={d.key}>
              {propLabel(f.kind, d.key)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={PREVIEW_UI.valueLabel}>
        <NumberInput value={hypoVal} min={def.min} max={def.max} onCommit={(v) => setVal(v)} testid="capability-preview-value" />
      </Field>
      <Info label={PREVIEW_UI.delta} testid="capability-preview-result">
        {after && after.theoretical !== null
          ? `理論 ${current.theoretical} → ${after.theoretical}（${fmtDelta(current.theoretical, after.theoretical)}） / 有効 ${current.effective ?? '—'} → ${after.effective ?? '—'}`
          : PREVIEW_UI.uncomputed}
      </Info>
    </Section>
  );
}

/** 増設プレビュー（F6-02・エリア版）: 内部エリアの数値項目の仮変更に対する能力の変化 */
export function AreaCapabilityPreview({ layout, a }: { layout: AirportLayout; a: TerminalArea }) {
  const [key, setKey] = useState<string | null>(null);
  const [val, setVal] = useState<number | null>(null);
  const defs = TERMINAL_AREA_SPECS[a.kind].props.filter((d) => d.type === 'int');
  const measure = areaOwnMeasure(layout, a);
  if (defs.length === 0 || !measure) return null;
  const def = defs.find((d) => d.key === key) ?? defs[0]!;
  const curVal = typeof a.props[def.key] === 'number' ? (a.props[def.key] as number) : 0;
  const hypoVal = val ?? curVal;
  const hypo = updateEntity(layout, a.id, { props: { [def.key]: hypoVal } });
  let after: { value: number; unit: string } | null = null;
  if (hypo.ok) {
    const afterArea = hypo.layout.terminalAreas[a.id];
    after = afterArea ? areaOwnMeasure(hypo.layout, afterArea) : null;
  }
  return (
    <Section title={PREVIEW_UI.expansionSection} testid="capability-preview">
      <div className="muted small">{PREVIEW_UI.expansionExplain}</div>
      <Field label={PREVIEW_UI.propLabel}>
        <select
          value={def.key}
          onChange={(e) => {
            setKey(e.target.value);
            setVal(null);
          }}
          data-testid="capability-preview-prop"
        >
          {defs.map((d) => (
            <option key={d.key} value={d.key}>
              {AREA_PROP_LABEL[d.key] ?? d.key}
            </option>
          ))}
        </select>
      </Field>
      <Field label={PREVIEW_UI.valueLabel}>
        <NumberInput value={hypoVal} min={def.min} max={def.max} onCommit={(v) => setVal(v)} testid="capability-preview-value" />
      </Field>
      <Info label={PREVIEW_UI.delta} testid="capability-preview-result">
        {after ? `${measure.value} → ${after.value} ${measure.unit}（${fmtDelta(measure.value, after.value)}）` : PREVIEW_UI.uncomputed}
      </Info>
    </Section>
  );
}

/** 工事の状況（キャリア）と一時閉鎖 */
function ProjectInfo({ layout, id, buildState }: { layout: AirportLayout; id: string; buildState: BuildState | undefined }) {
  const company = useEditor((s) => s.company);
  const mode = useEditor((s) => s.mode);
  const [days, setDays] = useState(2);
  if (company.mode !== 'career' || !buildState) return null;
  const p = company.projects[id];
  if (p) {
    return (
      <div className="operability ng" data-testid="project-info">
        {PROJECT_KIND_LABEL[p.kind]}: 残り {p.remaining}日（工期 {p.days}日、{p.startDay + 1}日目に開始）
        {p.remaining === 0 && <div className="reason">完了。運航を終えると運用中になります</div>}
      </div>
    );
  }
  if (buildState !== 'operational' || mode === 'operate') return null;
  return (
    <div className="prop-actions">
      <select value={days} onChange={(e) => setDays(Number(e.target.value))} title="閉鎖する日数（運航した日で数える）">
        {[1, 2, 3, 5, 7].map((d) => (
          <option key={d} value={d}>
            {d}日
          </option>
        ))}
      </select>
      <button onClick={() => closeTemporarily(id, days)} data-testid="prop-close" title={`${displayName(layout, id)} を指定の日数だけ閉鎖する（費用なし）`}>
        一時閉鎖
      </button>
    </div>
  );
}

function EntityProperties({ layout, id }: { layout: AirportLayout; id: string }) {
  const analysis = useAnalysis();
  const type = entityTypeOf(id)!;
  const issues = analysis.byTarget[id] ?? [];
  const op = analysis.operability[id];
  const canTransform = type === 'facility' || type === 'stand' || type === 'runway' || type === 'terminalArea';
  const buildState = (layout.runways[id] ?? layout.taxiways[id] ?? layout.roads[id] ?? layout.stands[id] ?? layout.facilities[id])?.buildState;
  const typeLabel = type === 'facility' ? FACILITY_LABEL[layout.facilities[id]!.kind] : ENTITY_LABEL[type];
  // 運航モードは読み取り専用（編集ボタン・入力を出さない／無効にする）。運用状況・閉鎖/再開（AreaOpsSection）だけは操作できる
  const readOnly = useEditor((s) => s.mode) === 'operate';

  return (
    <>
      <div className="prop-header">
        <div className="prop-title" data-testid="prop-title">{displayName(layout, id)}</div>
        <div className="prop-sub">
          {typeLabel} · <code>{id}</code>
          {type === 'runway' && layout.runways[id] && (
            <>
              {' '}
              <CriterionBadge free={isFreeRunway(layout.runways[id]!)} testid={isFreeRunway(layout.runways[id]!) ? 'badge-free' : 'badge-legacy'} />
            </>
          )}
        </div>
      </div>

      {!readOnly && (
      <div className="prop-actions">
        {canTransform && (
          <>
            <button onClick={() => applyOp(rotateEntity(layout, id))} title="R">回転</button>
            <button onClick={() => applyOp(duplicateEntity(layout, id), { select: true })} title="Ctrl+D">複製</button>
          </>
        )}
        <button className="danger" onClick={() => applyOp(deleteEntity(layout, id))} title="Delete" data-testid="prop-delete">
          削除
        </button>
      </div>
      )}

      <ProjectInfo layout={layout} id={id} buildState={buildState} />
      <ResourceClosureControl id={id} type={type} />

      {op && (
        <div className={op.operable ? 'operability ok' : 'operability ng'} data-testid="operability">
          {op.operable ? '✔ 運用可能' : '✖ 運用不可'}
          {op.reasons.map((r) => (
            <div key={r} className="reason">
              ・{OPERABILITY_LABEL[r]}
            </div>
          ))}
        </div>
      )}

      <Section title={readOnly ? '基本（運航中は変更できません）' : '基本'} testid={readOnly ? 'prop-readonly' : undefined}>
        <FieldsetIf readOnly={readOnly}>
        {buildState && (
          <Field label="建設状態">
            <select value={buildState} onChange={(e) => update(layout, id, { buildState: e.target.value as BuildState })} data-testid="prop-buildState">
              {BUILD_STATES.map((b) => (
                <option key={b} value={b}>
                  {BUILD_STATE_LABEL[b]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <TypeFields layout={layout} id={id} readOnly={readOnly} />
        </FieldsetIf>
        {readOnly && type === 'terminalArea' && <AreaOpsSection id={id} />}
      </Section>

      {type === 'terminalArea' && <TerminalTransitControls layout={layout} areaId={id} readOnly={readOnly} />}

      {issues.length > 0 && (
        <Section title={`問題（${issues.length}）`}>
          {issues.map((iss) => (
            <div key={iss.key} className={`issue ${iss.severity}`}>
              {issueText(layout, iss)}
              {iss.params.criterion === 'real' && <span className="badge free-badge">{RUNWAY_UI.tagReal}</span>}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

function TerminalTransitControls({ layout, areaId, readOnly }: { layout: AirportLayout; areaId: string; readOnly: boolean }) {
  const area = layout.terminalAreas[areaId];
  const [targetId, setTargetId] = useState('');
  const [kind, setKind] = useState<TerminalTransitKind>('elevatedWalkway');
  const [distanceM, setDistanceM] = useState(250);
  const [travelSec, setTravelSec] = useState(190);
  const [capacity, setCapacity] = useState(0);
  const [widthM, setWidthM] = useState(6);
  const [elevationM, setElevationM] = useState(36);
  const [aircraftClearanceM, setAircraftClearanceM] = useState(33);
  const [bidirectional, setBidirectional] = useState(true);
  if (!area) return null;
  const candidates = Object.values(layout.terminalAreas)
    .filter((other) => other.terminalId !== area.terminalId && other.zone === area.zone)
    .sort((a, b) => a.terminalId.localeCompare(b.terminalId) || a.id.localeCompare(b.id));
  const links = Object.values(layout.terminalLinks ?? {}).filter((link) => link.fromAreaId === areaId || link.toAreaId === areaId);
  return <Section title="ターミナル間連絡設備" testid="terminal-transit-controls">
    <p className="muted small">選択エリアを、別ターミナルの同じ旅客区域に接続します。旅客生成は行わず、明示された連絡経路だけを探索します。</p>
    {links.map((link) => {
      const from = layout.terminalAreas[link.fromAreaId];
      const to = layout.terminalAreas[link.toAreaId];
      return <div key={link.id} className="operability" data-testid={`terminal-link-${link.id}`}>
        <strong>{TERMINAL_TRANSIT_LABEL[link.kind]} · {from?.terminalId ?? '?'} → {to?.terminalId ?? '?'}</strong>
        <div>{link.distanceM} m · {link.travelSec} 秒 · 幅 {link.widthM ?? 6} m · 標高 {link.elevationM ?? 36} m · 航空機クリアランス {link.aircraftClearanceM ?? 33} m</div>
        <div>{link.bidirectional ? '双方向' : '片方向'} · {(link.capacityPerHour ?? Math.floor((link.widthM ?? 6) * 200)).toLocaleString()} 人/時</div>
        <div className="muted small">利用区域: {link.allowedZones.map((zone) => ZONE_LABEL[zone]).join('、')} · {BUILD_STATE_LABEL[link.buildState]}</div>
        {!readOnly && <button className="danger" onClick={() => applyOp(deleteTerminalTransitLink(layout, link.id))}>連絡設備を撤去</button>}
      </div>;
    })}
    {!readOnly && <div className="terminal-transit-form">
      <Field label="接続先エリア">
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} data-testid="terminal-link-target">
          <option value="">選択してください</option>
          {candidates.map((target) => <option key={target.id} value={target.id}>{layout.facilities[target.terminalId]?.name ?? target.terminalId} · {target.name || target.id} ({ZONE_LABEL[target.zone]})</option>)}
        </select>
      </Field>
      <Field label="設備"><select value={kind} onChange={(e) => setKind(e.target.value as TerminalTransitKind)}>{Object.entries(TERMINAL_TRANSIT_LABEL).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
      <Field label="距離 (m)"><NumberInput value={distanceM} min={1} max={100000} onCommit={setDistanceM} /></Field>
      <Field label="移動時間 (秒)"><NumberInput value={travelSec} min={1} max={86400} onCommit={setTravelSec} /></Field>
      <Field label="幅 (m)"><NumberInput value={widthM} min={1} max={100} onCommit={setWidthM} /></Field>
      <Field label="輸送能力 (人/時、0=幅から算出)"><NumberInput value={capacity} min={0} max={1000000} onCommit={setCapacity} /></Field>
      {kind === 'elevatedWalkway' && <>
        <Field label="通路階の高さ (m)"><NumberInput value={elevationM} min={1} max={200} onCommit={setElevationM} /></Field>
        <Field label="航空機クリアランス (m)"><NumberInput value={aircraftClearanceM} min={1} max={200} onCommit={setAircraftClearanceM} /></Field>
        <div className="muted small">橋脚のないクリアスパンとして扱い、通路下の航空機経路は既存の地上ネットワークを維持します。</div>
      </>}
      <label className="prop-field"><span className="prop-label">方向</span><select value={bidirectional ? 'both' : 'oneWay'} onChange={(e) => setBidirectional(e.target.value === 'both')}><option value="both">双方向</option><option value="oneWay">選択元から片方向</option></select></label>
      <button className="primary" disabled={!targetId} onClick={() => applyOp(addTerminalTransitLink(layout, { kind, fromAreaId: areaId, toAreaId: targetId, distanceM, travelSec, widthM, ...(capacity > 0 ? { capacityPerHour: capacity } : {}), ...(kind === 'elevatedWalkway' ? { elevationM, aircraftClearanceM } : {}), bidirectional, allowedZones: [area.zone], name: TERMINAL_TRANSIT_LABEL[kind] }))} data-testid="terminal-link-create">連絡設備を建設</button>
    </div>}
    {!candidates.length && <div className="muted">接続できる別ターミナルの同一区域エリアがありません。対象側のエリアを先に配置してください。</div>}
  </Section>;
}

const TERMINAL_TRANSIT_LABEL: Record<TerminalTransitKind, string> = {
  walkway: '徒歩連絡通路',
  movingWalkway: '動く歩道',
  elevatedWalkway: '高架連絡通路',
  escalator: 'エスカレーター',
  elevator: 'エレベーター',
};

function ResourceClosureControl({ id, type }: { id: string; type: ReturnType<typeof entityTypeOf> }) {
  const mode = useEditor((s) => s.mode);
  if (mode !== 'operate' || (type !== 'stand' && type !== 'taxiway')) return null;
  const sim = editorStore.getState().ops?.sim;
  if (!sim) return null;
  const kind = type === 'stand' ? 'stands' : 'taxiways';
  const closed = sim.state.closures[kind].includes(id);
  const reasons = closureReasonsFor(sim.state, kind, id);
  const manuallyClosed = reasons.includes('manual');
  const reasonLabel = (reason: string) => {
    if (reason === 'manual') return '手動閉鎖';
    if (reason === 'legacy') return '旧保存データの閉鎖';
    const disruption = sim.state.disruptions.find((d) => `disruption:${d.id}` === reason);
    return disruption ? `障害・整備 (${disruption.kind})` : reason;
  };
  const inUse = type === 'stand'
    ? Number(!!sim.state.standAssignments[id])
    : Object.values(sim.state.aircraft).filter((aircraft) => aircraft.route?.edges.some((edgeId) => sim.ctx.network.edges[edgeId]?.sourceId === id)).length;
  return (
    <section className="operability" data-testid="resource-closure-control">
      <strong>{closed ? '使用停止中' : '使用可能'}</strong>
      {closed && <div className="reason">閉鎖理由: {reasons.map(reasonLabel).join('、') || '不明'}</div>}
      {inUse > 0 && <div className="reason">現在使用中: {inUse} 機。移動中の機体は安全のため既存経路を継続します。</div>}
      {closed && type === 'taxiway' && <div className="reason">代替経路がない便は滑走路手前または進入待機となり、経路が開くまで進みません。</div>}
      <button className={manuallyClosed ? 'primary' : 'danger'} onClick={() => ops.setResourceClosed(type, id, !manuallyClosed)} data-testid="toggle-resource-closure">
        {manuallyClosed ? '手動閉鎖を解除' : '手動で使用停止'}
      </button>
    </section>
  );
}

function RoadNodeLayerControl({ layout, nodeId }: { layout: AirportLayout; nodeId: string }) {
  const node = layout.roadNodes[nodeId];
  const [targetId, setTargetId] = useState('');
  const [roadClass, setRoadClass] = useState<RoadClass>('walkway');
  const [connectorKind, setConnectorKind] = useState<RoadConnectorKind>('stairs');
  const [capacity, setCapacity] = useState(0);
  const [travelSec, setTravelSec] = useState(0);
  if (!node) return null;
  const candidates = Object.values(layout.roadNodes)
    .filter((other) => other.id !== nodeId && (other.level ?? 0) !== (node.level ?? 0))
    .sort((a, b) => Math.hypot(a.pos.x - node.pos.x, a.pos.y - node.pos.y) - Math.hypot(b.pos.x - node.pos.x, b.pos.y - node.pos.y) || a.id.localeCompare(b.id));
  const kinds: Record<RoadClass, RoadConnectorKind[]> = {
    walkway: ['stairs', 'escalator', 'elevator'], public: ['ramp'], service: ['ramp'], rail: ['railRamp'], fuel: ['pipeRiser'],
  };
  // 選択中の設備で結べる候補だけを選べるようにする（5-09 / W-9: 勾配・近接の条件を候補の時点で示す）
  const candidateOk = (candidate: (typeof candidates)[number]): boolean => roadEdgeLevelValid({ id: 'preview', from: nodeId, to: candidate.id, name: '', roadClass, oneWay: false, buildState: 'operational', connectorKind }, node, candidate);
  const target = candidates.find((c) => c.id === targetId);
  const targetRunM = target ? Math.round(Math.hypot(target.pos.x - node.pos.x, target.pos.y - node.pos.y) * TILE_M) : 0;
  const setClass = (value: RoadClass) => { setRoadClass(value); setConnectorKind(kinds[value][0]!); };
  return <section className="operability road-layer-connect" data-testid="road-layer-connect">
    <strong>階層接続設備</strong>
    <p className="muted small">階層の違う交通ノードを、移動種別に合う設備で結びます。階段・昇降機は近接、道路・鉄道ランプは階高に応じた勾配長が必要です。</p>
    {candidates.length === 0 ? <div className="muted">別階層に接続候補ノードがありません。</div> : <>
      <label className="prop-field"><span className="prop-label">接続先ノード</span><select value={targetId} onChange={(e) => setTargetId(e.target.value)}>
        <option value="">選択してください</option>
        {candidates.map((candidate) => { const ok = candidateOk(candidate); const distM = Math.round(Math.hypot(candidate.pos.x - node.pos.x, candidate.pos.y - node.pos.y) * TILE_M); return <option key={candidate.id} value={candidate.id} disabled={!ok}>{candidate.id} · 階層 {candidate.level ?? 0} · ({candidate.pos.x}, {candidate.pos.y}) · {distM} m{ok ? '' : '（この設備では結べません）'}</option>; })}
      </select></label>
      {target && (connectorKind === 'ramp' || connectorKind === 'railRamp') && <p className="muted small" data-testid="connector-run">勾配区間の長さ {targetRunM} m（{connectorKind === 'ramp' ? '道路ランプは高低差の 12 倍以上' : '鉄道ランプは高低差の 20 倍以上'}が必要です）</p>}
      <label className="prop-field"><span className="prop-label">移動種別</span><select value={roadClass} onChange={(e) => setClass(e.target.value as RoadClass)}>
        {(Object.keys(kinds) as RoadClass[]).map((kind) => <option key={kind} value={kind}>{ROAD_CLASS_LABEL[kind]}</option>)}
      </select></label>
      <label className="prop-field"><span className="prop-label">接続設備</span><select value={connectorKind} onChange={(e) => setConnectorKind(e.target.value as RoadConnectorKind)}>
        {kinds[roadClass].map((kind) => <option key={kind} value={kind}>{CONNECTOR_KIND_LABEL[kind]}</option>)}
      </select></label>
      <label className="prop-field"><span className="prop-label">能力 / 時（0=未算出）</span><input type="number" min="0" value={capacity} onChange={(e) => setCapacity(Math.max(0, Number(e.target.value) || 0))} /></label>
      {['elevator', 'escalator', 'stairs'].includes(connectorKind) && <label className="prop-field"><span className="prop-label">所要時間（秒、0=距離から）</span><input type="number" min="0" value={travelSec} onChange={(e) => setTravelSec(Math.max(0, Number(e.target.value) || 0))} /></label>}
      <button className="primary" disabled={!targetId} onClick={() => applyOp(connectRoadLevels(layout, nodeId, targetId, { roadClass, connectorKind, ...(capacity > 0 ? { capacityPerHour: capacity } : {}), ...(travelSec > 0 ? { travelSec } : {}) }))} data-testid="connect-road-levels">接続設備を建設</button>
    </>}
  </section>;
}

/** 運航モードだけ、入力を一括で無効にする fieldset で包む（建設モードの DOM は従来どおり） */
function FieldsetIf({ readOnly, children }: { readOnly: boolean; children: ReactNode }) {
  return readOnly ? (
    <fieldset className="ro-fields" disabled data-testid="prop-readonly-fields">
      {children}
    </fieldset>
  ) : (
    <>{children}</>
  );
}

function TypeFields({ layout, id, readOnly = false }: { layout: AirportLayout; id: string; readOnly?: boolean }) {
  const analysis = useAnalysis();
  const sim = editorStore.getState().ops?.sim;
  const net = analysis.network;
  const type = entityTypeOf(id);

  if (type === 'runway') {
    const r = layout.runways[id]!;
    const [d0, d1] = designatorsOf(r, layout).text;
    const entries = (net.runwayNodes[id] ?? []).filter((n) => layout.taxiNodes[n]);
    const crossing = (net.crossings ?? []).filter((x) => x.a === id || x.b === id);
    const crossingInfo =
      crossing.length === 0 ? null : (
        <Info label="交差する滑走路" testid="prop-crossings" title="交差点はネットワークの論理ノード。運航では従属運用（2 本の離着陸を同時に使いません）">
          {crossing.map((x) => {
            const other = x.a === id ? x.b : x.a;
            return <EntityLink key={x.id} layout={layout} id={other} />;
          })}
        </Info>
      );
    if (isFreeRunway(r))
      return (
        <>
          <FreeRunwayFields layout={layout} id={id} r={r} entries={entries} />
          {crossingInfo}
        </>
      );
    return (
      <>
        <NameField layout={layout} id={id} value={r.name} />
        <Field label="向き（始点→終点）">
          <select value={r.heading} onChange={(e) => update(layout, id, { heading: Number(e.target.value) })} data-testid="prop-heading">
            {HEADINGS.map((h) => (
              <option key={h} value={h}>
                {legacyHeadingLabel(layout, r, h)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="長さ（タイル）">
          <NumberInput value={r.length} min={1} max={200} onCommit={(v) => update(layout, id, { length: v })} testid="prop-length" />
        </Field>
        <Field label="舗装幅">
          <select value={r.surfaceWidthM} onChange={(e) => update(layout, id, { surfaceWidthM: Number(e.target.value) })}>
            <option value={30}>30m（S級まで）</option>
            <option value={45}>45m（M級まで）</option>
            <option value={60}>60m（L級まで）</option>
          </select>
        </Field>
        <Info label="滑走路番号">{`${d0}/${d1}`}</Info>
        <Info label="実長">{`${runwayLengthM(r).toLocaleString()} m`}</Info>
        <Info label="長さによる区分">{runwayLengthClass(r) ?? '使用不可'}</Info>
        <Info label="使用可能な機体" testid="prop-maxSize">{runwayMaxSize(r) ? `${runwayMaxSize(r)}級まで` : '使用不可'}</Info>
        <Info label="始点 / 終点">{`(${r.start.x}, ${r.start.y}) → (${runwayEnd(r).x}, ${runwayEnd(r).y})`}</Info>
        <Info label="滑走路入口">
          {entries.length === 0 ? 'なし' : entries.map((n) => <EntityLink key={n} layout={layout} id={n} />)}
        </Info>
        {(layout.magneticVariationDeg ?? 0) !== 0 && (
          <Info label="磁方位（真方位 − 偏角）" testid="prop-magHeading">{`${designatorsOf(r, layout).magDeg[0]}°`}</Info>
        )}
        {crossingInfo}
        <LegacyRunwayExtras layout={layout} id={id} />
      </>
    );
  }

  if (type === 'taxiway') {
    const e = layout.taxiways[id]!;
    const a = layout.taxiNodes[e.from]!;
    const b = layout.taxiNodes[e.to]!;
    return (
      <>
        <NameField layout={layout} id={id} value={e.name} />
        <Field label="誘導路幅（最大機体）">
          <select value={e.widthClass} onChange={(ev) => update(layout, id, { widthClass: ev.target.value })} data-testid="prop-widthClass">
            {(['S', 'M', 'L'] as const).map((s) => (
              <option key={s} value={s}>
                {SIZE_LABEL[s]}
              </option>
            ))}
          </select>
        </Field>
        {e.widthClass === 'L' && (
          <Field label="コード F 対応">
            <input type="checkbox" checked={!!e.codeF} onChange={(ev) => update(layout, id, { codeF: ev.target.checked })} data-testid="prop-codeF" title="翼幅 65〜80 m の機体（A380 など）が通行できる（ゲームの適合ルール）" />
          </Field>
        )}
        <Field label="一方通行">
          <input type="checkbox" checked={e.oneWay} onChange={(ev) => update(layout, id, { oneWay: ev.target.checked })} />
          {e.oneWay && (
            <button className="small" onClick={() => applyOp(reverseEdge(layout, id))}>
              向きを反転
            </button>
          )}
        </Field>
        <TaxiBlockFields layout={layout} id={id} readOnly={readOnly} />
        <TaxiwayDesignFields layout={layout} id={id} readOnly={readOnly} />
        <Info label="区間">
          <EntityLink layout={layout} id={e.from} /> {e.oneWay ? '→' : '↔'} <EntityLink layout={layout} id={e.to} />
        </Info>
        <Info label="長さ">{`${Math.round(distance(a.pos, b.pos) * TILE_M)} m`}</Info>
        {net.edges[id]?.holdShortAt && <Info label="停止位置">滑走路手前で停止（ホールディングポイント）</Info>}
      </>
    );
  }

  if (type === 'road') {
    const e = layout.roads[id]!;
    const from = layout.roadNodes[e.from];
    const to = layout.roadNodes[e.to];
    return (
      <>
        <NameField layout={layout} id={id} value={e.name} />
        <Field label="種別">
          <select value={e.roadClass} onChange={(ev) => update(layout, id, { roadClass: ev.target.value })}>
            <option value="public">{ROAD_CLASS_LABEL.public}</option>
            <option value="service">{ROAD_CLASS_LABEL.service}</option>
            <option value="rail">{ROAD_CLASS_LABEL.rail}</option>
            <option value="walkway">{ROAD_CLASS_LABEL.walkway}</option>
            <option value="fuel">{ROAD_CLASS_LABEL.fuel}</option>
          </select>
        </Field>
        <Field label="一方通行">
          <input type="checkbox" checked={e.oneWay} onChange={(ev) => update(layout, id, { oneWay: ev.target.checked })} />
        </Field>
        <Info label="階層">{`${from?.level ?? 0} → ${to?.level ?? 0}`}</Info>
        {e.connectorKind && <Info label="階層接続">{e.connectorKind}</Info>}
        {(e.roadClass === 'public' || e.roadClass === 'service') && (
          <Field label="車線数（区間能力の既定値）">
            <NumberInput value={e.lanes ?? 1} min={1} max={8} onCommit={(v) => update(layout, id, { lanes: v })} testid="prop-lanes" />
          </Field>
        )}
        {e.roadClass === 'rail' && (
          <Field label="線路（区間能力の既定値）">
            <select value={e.tracks ?? 1} onChange={(ev) => update(layout, id, { tracks: Number(ev.target.value) })} data-testid="prop-tracks">
              <option value={1}>単線（4 本/時）</option>
              <option value={2}>複線（12 本/時）</option>
            </select>
          </Field>
        )}
        <Info label="明示能力">{e.capacityPerHour ? `${e.capacityPerHour.toLocaleString()} /時` : '未算出'}</Info>
        {e.travelSec && <Info label="移動時間">{`${e.travelSec} 秒`}</Info>}
      </>
    );
  }

  if (type === 'taxiNode' || type === 'roadNode') {
    const n = layout.taxiNodes[id] ?? layout.roadNodes[id]!;
    const edges: { id: string }[] = type === 'taxiNode' ? edgesOfNode(layout.taxiways, id) : edgesOfNode(layout.roads, id);
    const an = net.nodes[id];
    return (
      <>
        <NameField layout={layout} id={id} value={n.name} />
        <Info label="位置">{`(${n.pos.x}, ${n.pos.y})`}</Info>
        {type === 'roadNode' && <Info label="交通階層">{`${n.level ?? 0}（標高 ${n.elevationM ?? (n.level ?? 0) * 6} m）`}</Info>}
        {an && <Info label="種類">{NODE_KIND_LABEL[an.kind]}</Info>}
        {an?.kind === 'runwayEntry' && (
          <Field label="停止義務（ホールディングポイント）">
            <input type="checkbox" checked={n.holdShort} onChange={(e) => update(layout, id, { holdShort: e.target.checked })} data-testid="prop-holdShort" />
          </Field>
        )}
        {an && an.runwayIds.length > 0 && (
          <Info label="滑走路">
            {an.runwayIds.map((r) => (
              <EntityLink key={r} layout={layout} id={r} />
            ))}
          </Info>
        )}
        <Info label={`接続（${edges.length}）`}>
          {edges.map((e) => (
            <EntityLink key={e.id} layout={layout} id={e.id} />
          ))}
        </Info>
        {type === 'roadNode' && <RoadNodeLayerControl layout={layout} nodeId={id} />}
        {an && an.standIds.length > 0 && (
          <Info label="スポット">
            {an.standIds.map((s) => (
              <EntityLink key={s} layout={layout} id={s} />
            ))}
          </Info>
        )}
      </>
    );
  }

  if (type === 'stand') {
    const s = layout.stands[id]!;
    const link = net.standLinks[id];
    const gates = sortedValues(layout.facilities).filter((f) => f.kind === 'gate' && f.props.standId === id);
    const availableBusGateIds = sortedValues(layout.facilities)
      .filter((facility) => facility.kind === 'gate' && gateMode(facility) === 'bus' && facility.buildState === 'operational')
      .map((facility) => facility.id);
    const busAssignment = resolveBusGateForStand(
      layout, analysis.terminal, id, net.nodes[`${id}:P`]?.pos ?? null, availableBusGateIds, sim?.state.closures.gates ?? [],
    );
    const selectedBusGateId = s.remoteBoarding === 'bus' ? s.busGateId ?? null : busAssignment.gateId;
    const selectedBusAccess = selectedBusGateId ? analysis.terminal.gates[selectedBusGateId] : undefined;
    const selectedBusStatus = busGateStatus(layout, analysis.terminal, selectedBusGateId, sim?.state.closures.gates ?? []);
    const busGateInvalid = s.remoteBoarding === 'bus' && !selectedBusStatus.usable;
    const rampBusCount = sortedValues(layout.facilities)
      .filter((facility) => facility.kind === 'gseBase' && facility.buildState === 'operational')
      .reduce((count, facility) => count + apronBusesOf(facility), 0);
    const entry = standEntry(s);
    return (
      <>
        <NameField layout={layout} id={id} value={s.name} />
        <Field label="サイズ">
          <select value={s.size} onChange={(e) => update(layout, id, { size: e.target.value })} data-testid="prop-size">
            {(['S', 'M', 'L'] as const).map((z) => (
              <option key={z} value={z}>
                {SIZE_LABEL[z]}
              </option>
            ))}
          </select>
        </Field>
        {s.size === 'L' && (
          <Field label="コード F 対応">
            <input type="checkbox" checked={!!s.codeF} onChange={(ev) => update(layout, id, { codeF: ev.target.checked })} data-testid="prop-codeF" title="翼幅 65〜80 m の機体（A380 など）が駐機できる（ゲームの適合ルール）" />
          </Field>
        )}
        <RotationField value={s.rotation} onChange={(r) => update(layout, id, { rotation: r })} label="機首の向き" />
        <Info label="位置">{`(${s.origin.x}, ${s.origin.y})`}</Info>
        <Info label="入口">{`(${entry.x}, ${entry.y})`}</Info>
        <Info label="誘導路接続">{link ? <EntityLink layout={layout} id={link} /> : <span className="ng-text">未接続</span>}</Info>
        <Info label="ゲート">{gates.length === 0 ? 'なし（リモート）' : gates.map((g) => <EntityLink key={g.id} layout={layout} id={g.id} />)}</Info>
        {gates.length === 0 && (
          <>
            <Field label="リモート搭乗">
              <select value={s.remoteBoarding ?? 'auto'} onChange={(e) => update(layout, id, { remoteBoarding: e.target.value })} data-testid="prop-remoteBoarding">
                <option value="auto">自動割当（利用可能な最寄りゲート）</option>
                <option value="bus">バス搭乗を使用</option>
                <option value="none">使用しない</option>
              </select>
            </Field>
            {s.remoteBoarding !== 'none' && (
              <Field label="所属ターミナル">
                <select value={s.terminalId ?? ''} onChange={(e) => update(layout, id, { terminalId: e.target.value || null })} data-testid="prop-standTerminal">
                  <option value="">自動（バスゲートで決定）</option>
                  {sortedValues(layout.facilities).filter((f) => f.kind === 'terminal').map((t) => (
                    <option key={t.id} value={t.id}>{displayName(layout, t.id)}</option>
                  ))}
                  {s.terminalId && layout.facilities[s.terminalId]?.kind !== 'terminal' && <option value={s.terminalId}>{s.terminalId}（見つかりません）</option>}
                </select>
              </Field>
            )}
            <Info label="接続先ターミナル">{selectedBusStatus.terminalId ? displayName(layout, selectedBusStatus.terminalId) : s.remoteBoarding === 'none' ? 'バスを使用しない設定' : '利用可能な接続先なし'}</Info>
            <Info label="使用するバスゲート">{selectedBusGateId ? <EntityLink layout={layout} id={selectedBusGateId} /> : s.remoteBoarding === 'none' ? 'なし' : '利用可能なゲートなし'}</Info>
            <Info label="搭乗・降機">{`${selectedBusAccess?.boarding ? '搭乗可' : '搭乗不可'} / ${selectedBusAccess?.deplane ? '降機可' : '降機不可'}`}</Info>
            <Info label="ランプバス">{rampBusCount > 0 ? `運行可能（${rampBusCount} 台）` : '運行不可（運用中のランプバスなし）'}</Info>
            {(s.remoteBoarding === 'bus') && (
              <Field label="接続バスゲート">
                <select value={s.busGateId ?? ''} onChange={(e) => update(layout, id, { busGateId: e.target.value || null })} data-testid="prop-busGateId">
                  <option value="">選択してください</option>
                  {sortedValues(layout.facilities).filter((f) => f.kind === 'gate' && gateMode(f) === 'bus' && (!s.terminalId || analysis.terminal.gates[f.id]?.terminalId === s.terminalId)).map((g) => {
                    const access = analysis.terminal.gates[g.id];
                    const status = busGateStatus(layout, analysis.terminal, g.id, sim?.state.closures.gates ?? []);
                    const terminal = access?.terminalId ? ` · ${displayName(layout, access.terminalId)}` : ' · ターミナル未接続';
                    const capability = `${access?.boarding ? '搭乗可' : '搭乗不可'} / ${access?.deplane ? '降機可' : '降機不可'}`;
                    const state = status.usable ? '利用可能' : status.problem === 'closed' ? '閉鎖中' : status.problem === 'building' ? '建設中' : '接続不備';
                    return <option key={g.id} value={g.id} disabled={!status.usable}>{displayName(layout, g.id)}{terminal} · {capability} · {state}</option>;
                  })}
                </select>
              </Field>
            )}
            {sim && <div className="hint" data-testid="stand-gate-fix-note">{STAND_GATE_FIX_NOTE}</div>}
            {s.remoteBoarding === 'bus' && s.busGateId && sim?.state.closures.gates.includes(s.busGateId) && <div className="reason ng-text">選択中のバスゲートは運航中に閉鎖されています。再開するまで旅客を割り当てられません。</div>}
            {s.remoteBoarding === 'bus' && !s.busGateId && <div className="reason ng-text">接続バスゲートが未設定です。このスポットの旅客は生成されません。</div>}
            {busGateInvalid && !!s.busGateId && <div className="reason ng-text">指定したバスゲートは利用できません（{selectedBusStatus.problem}）。運用中で、同一ターミナルの搭乗口・降機口に接続されたゲートを選んでください。</div>}
          </>
        )}
      </>
    );
  }

  if (type === 'terminalArea') {
    const a = layout.terminalAreas[id]!;
    const spec = TERMINAL_AREA_SPECS[a.kind];
    const terminal = layout.facilities[a.terminalId];
    const levels = Number(terminal?.props.levels ?? 1);
    const node = analysis.terminal.areas[id];
    const links = (analysis.terminal.links[id] ?? []).map((l) => l.to);
    const areaTiles = a.w * a.h;
    const isLift = a.kind === 'stairs' || a.kind === 'escalator' || a.kind === 'elevator';
    return (
      <>
        <NameField layout={layout} id={id} value={a.name} />
        <Info label="種類">{AREA_KIND_LABEL[a.kind]}</Info>
        <Field label="階">
          <select value={a.level} onChange={(e) => update(layout, id, { level: Number(e.target.value) })} data-testid="prop-level">
            {Array.from({ length: levels - TERMINAL_AREA_MIN_LEVEL }, (_, i) => i + TERMINAL_AREA_MIN_LEVEL).map((l) => (
              <option key={l} value={l}>
                {l < 0 ? `地下${-l}階` : `${l + 1}F`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="区域">
          {spec.zoneEditable ? (
            <select value={a.zone} onChange={(e) => update(layout, id, { zone: e.target.value })}>
              {(['landside', 'departure', 'arrival'] as const).map((z) => (
                <option key={z} value={z}>
                  {ZONE_LABEL[z]}
                </option>
              ))}
            </select>
          ) : (
            ZONE_LABEL[a.zone]
          )}
        </Field>
        <Field label="幅（タイル）">
          <NumberInput value={a.w} min={spec.minW} max={150} onCommit={(v) => update(layout, id, { w: v })} />
        </Field>
        <Field label="奥行き（タイル）">
          <NumberInput value={a.h} min={spec.minH} max={150} onCommit={(v) => update(layout, id, { h: v })} />
        </Field>
        {spec.props.map((def) =>
          def.type === 'int' ? (
            <Field key={def.key} label={AREA_PROP_LABEL[def.key] ?? def.key}>
              <NumberInput value={Number(a.props[def.key])} min={def.min} max={def.max} onCommit={(v) => update(layout, id, { props: { [def.key]: v } })} testid={`prop-${def.key}`} />
            </Field>
          ) : null,
        )}
        {!readOnly && <AreaCapabilityPreview layout={layout} a={a} />}
        {isProcessingArea(a.kind) && (
          <Info label="処理能力" title="窓口数 × 3600 ÷ 1人あたり処理秒数（docs/12 の処理時間。エリアの serviceSecPerPax 設定があればそれを優先）">
            {areaServerCount(a.props) > 0
              ? `約 ${areaProcessingPerHour(a.kind, a.props)} 人/時（窓口 ${areaServerCount(a.props)} × 1人 ${serviceSecPerPax(a.kind, a.props)} 秒）`
              : '0 人/時（窓口がありません）'}
          </Info>
        )}
        {isLift && (
          <Info label="昇降能力" title="この設備を通る階間移動の上限（人/時）。capacityPerHour の設定があればそれ、なければ種別ごとの既定値（階段 1800 / エスカレーター 2400 / エレベーター 600）">
            {`${Number(a.props.capacityPerHour ?? defaultVerticalCapacityPerHour(a.kind))} 人/時`}
          </Info>
        )}
        {a.kind === 'baggageClaim' && (
          <Info label="受取ベルト" title="同時にベルトへ載せられる便数の上限（1便につき1ベルト）">
            {`${Math.max(0, Number(a.props.belts ?? 0))} 本（同時に ${Math.max(0, Number(a.props.belts ?? 0))} 便まで）`}
          </Info>
        )}
        {(isProcessingArea(a.kind) || a.kind === 'baggageClaim') && <AreaPeakDemandInfo layout={layout} terminalId={a.terminalId} kind={a.kind} />}
        <Info label="収容人数" title={`面積基準の収容上限（1タイルあたり ${PAX_PER_TILE} 人、下限 10 人）`}>
          {areaTiles * PAX_PER_TILE >= 10
            ? `${node?.capacity ?? Math.max(10, areaTiles * PAX_PER_TILE)} 人（1タイルあたり ${PAX_PER_TILE} 人 × ${areaTiles} タイル）`
            : `${node?.capacity ?? 10} 人（下限）`}
        </Info>
        <Info label={`接続（${links.length}）`}>
          {links.length === 0 ? <span className="ng-text">どこにも接していません</span> : links.map((l) => <EntityLink key={l} layout={layout} id={l} />)}
        </Info>
        <AreaPortalSection layout={layout} areaId={id} readOnly={readOnly} />
        <TerminalComplexInfo layout={layout} terminalId={a.terminalId} />
        {!readOnly && <AreaOpsSection id={id} />}
      </>
    );
  }

  if (type === 'facility') {
    const f = layout.facilities[id]!;
    const spec = FACILITY_SPECS[f.kind];
    const dims = facilityDims(f);
    const busGate = gateMode(f) === 'bus';
    return (
      <>
        <NameField layout={layout} id={id} value={f.name} />
        <SimEffectBadge kind={f.kind} />
        <Info label="位置">{`(${f.origin.x}, ${f.origin.y})`}</Info>
        <FacilityCapabilityInfo layout={layout} f={f} />
        {!readOnly && <FacilityCapabilityPreview layout={layout} f={f} />}
        {(PORTAL_FACILITY_KINDS as readonly string[]).includes(f.kind) && <FacilityPortalSection layout={layout} facilityId={id} readOnly={readOnly} />}
        {f.kind === 'terminal' && <TerminalComplexInfo layout={layout} terminalId={id} />}
        {f.kind === 'terminal' && !readOnly && (
          <button className="small" onClick={() => actions.openTerminalWorkspace(id)} data-testid="open-terminal-workspace">
            内部設計を開く
          </button>
        )}
        {f.parentFacilityId ? (
          <Field label={`建物内配置（${layout.facilities[f.parentFacilityId]?.name || f.parentFacilityId}）`}>
            <select
              value={f.floorIndex ?? 0}
              disabled={readOnly}
              onChange={(e) => update(layout, id, { floorIndex: Number(e.target.value) })}
              data-testid="prop-floorIndex"
            >
              {Array.from({ length: Math.max(1, Number(layout.facilities[f.parentFacilityId]?.props.levels ?? 1)) - INTERIOR_MIN_FLOOR }, (_, i) => i + INTERIOR_MIN_FLOOR).map((floor) => (
                <option key={floor} value={floor}>
                  {floor < 0 ? `地下${-floor}階` : `${floor + 1}階`}
                </option>
              ))}
            </select>
          </Field>
        ) : f.kind !== 'gate' && (
          <Field label="階層">
            <NumberInput value={facilityLevel(f)} min={-5} max={10} onCommit={(v) => update(layout, id, { mapLevel: v })} testid="prop-mapLevel" />
          </Field>
        )}
        {!f.parentFacilityId && (() => {
          const children = Object.values(layout.facilities).filter((c) => c.parentFacilityId === id).sort((a, b) => (a.floorIndex ?? 0) - (b.floorIndex ?? 0) || compareIds(a.id, b.id));
          if (children.length === 0) return null;
          return (
            <Info label={`${INTERIOR_CHILDREN_LABEL}（${children.length}）`}>
              <span data-testid="interior-children">
                {children.map((c) => (
                  <EntityLink key={c.id} layout={layout} id={c.id} />
                ))}
              </span>
            </Info>
          );
        })()}
        {spec.resizable ? (
          <>
            <Field label="幅（タイル）">
              <NumberInput value={f.w} min={spec.minW} max={150} onCommit={(v) => update(layout, id, { w: v })} testid="prop-w" />
            </Field>
            <Field label="奥行き（タイル）">
              <NumberInput value={f.h} min={spec.minH} max={150} onCommit={(v) => update(layout, id, { h: v })} testid="prop-h" />
            </Field>
          </>
        ) : (
          <Info label="大きさ">{`${dims.w} × ${dims.h} タイル`}</Info>
        )}
        <FacilityFootprintSection layout={layout} f={f} readOnly={readOnly} />
        {f.kind !== 'gate' && <RotationField value={f.rotation} onChange={(r) => update(layout, id, { rotation: r })} label="向き" />}
        {PROP_SCHEMAS[f.kind]
          .filter((def) => !(f.kind === 'gate' && busGate && (def.key === 'standId' || def.key === 'jetBridge')))
          .map((def) => (
          <Field key={def.key} label={propLabel(f.kind, def.key)}>
            {def.type === 'int' && (
              <NumberInput
                value={(f.props[def.key] as number | undefined) ?? propDefault(def) as number}
                min={def.min}
                max={def.max}
                onCommit={(v) => {
                  if (def.key === 'levels' && levelsInUse(layout, id, v)) {
                    showToast(PLACEMENT_PROBLEM_LABEL.levelsInUse, 'error');
                    return;
                  }
                  update(layout, id, { props: { [def.key]: v } });
                }}
                testid={`prop-${def.key}`}
              />
            )}
            {def.type === 'bool' && (
              <input type="checkbox" checked={!!f.props[def.key]} onChange={(e) => update(layout, id, { props: { [def.key]: e.target.checked } })} />
            )}
            {def.type === 'enum' && def.key === 'boardingMode' && (
              <select
                value={busGate ? 'bus' : 'contact'}
                onChange={(e) =>
                  update(layout, id, { props: e.target.value === 'bus' ? { boardingMode: 'bus', standId: null, jetBridge: false } : { boardingMode: 'contact', jetBridge: true } })
                }
                data-testid="prop-boardingMode"
              >
                <option value="contact">{BOARDING_MODE_LABEL.contact}</option>
                <option value="bus">{BOARDING_MODE_LABEL.bus}</option>
              </select>
            )}
            {def.type === 'enum' && def.key !== 'boardingMode' && (
              <select value={String((f.props[def.key] as string | undefined) ?? propDefault(def))} onChange={(e) => update(layout, id, { props: { [def.key]: e.target.value } })}>
                {def.options.map((o) => (
                  <option key={o} value={o}>
                    {RAIL_SERVICE_LABEL[o as keyof typeof RAIL_SERVICE_LABEL] ?? o}
                  </option>
                ))}
              </select>
            )}
            {def.type === 'facilityRef' && (
              <select
                value={connectedTerminal(f, layout) ?? ''}
                onChange={(e) => update(layout, id, { props: { [def.key]: e.target.value || null } })}
                data-testid={`prop-${def.key}`}
              >
                <option value="">{BOARDING_MODE_LABEL.connectAuto}</option>
                {sortedValues(layout.facilities)
                  .filter((x) => x.kind === def.of)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {displayName(layout, x.id)}
                    </option>
                  ))}
              </select>
            )}
            {def.type === 'standRef' && (
              <select
                value={(f.props[def.key] as string | null) ?? ''}
                onChange={(e) => update(layout, id, { props: { [def.key]: e.target.value || null } })}
                data-testid={`prop-${def.key}`}
              >
                <option value="">（なし）</option>
                {sortedValues(layout.stands).map((s) => (
                  <option key={s.id} value={s.id}>
                    {displayName(layout, s.id)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        ))}
        {f.kind === 'gate' && busGate && (
          <Info label="対象のスポット" testid="prop-bus-targets" title="バスゲートは、ゲートのないリモートスポットの便をランプバスで運びます（docs/29）">
            {`リモートスポット ${remoteStandCount(layout)} か所`}
          </Info>
        )}
        {f.kind === 'gate' && (
          <Info label="待合容量" title="ゲート待合の収容上限（ゲートあたり固定）">
            {`${GATE_LOUNGE_CAPACITY} 人`}
          </Info>
        )}
        {f.kind === 'gate' && sim?.state.swingGates?.[f.id] && (
          <Info label="現在の割当（兼用ゲート）" testid="prop-swing-gate" title="国内線・国際線を兼用するゲートの現在の割当（運航中のシミュレーション状態）">
            {`${sim.state.swingGates[f.id]!.routeType === 'domestic' ? '国内線' : '国際線'}として使用中`}
          </Info>
        )}
        {(f.kind === 'gseBase' || f.kind === 'maintenance') && <GroundCapacityInfo layout={layout} />}
        {f.kind === 'baggageSort' && (
          <Info label="処理上限" title="仕分け機1施設あたりの処理上限。合計は運用中の全仕分け施設の合算（空港全体の仕分け能力）">
            {`${Math.max(0, Number(f.props.capacityPerMin ?? 0))} 個/分（全施設の合計 ${sorterTotalPerMin(layout)} 個/分）`}
          </Info>
        )}
        {f.kind === 'cargoTerminal' && (
          <Info label="処理上限" title="貨物上屋1施設あたりの処理上限。合計は運用中の全貨物上屋の合算（空港全体の荷役能力）">
            {`${Math.max(0, Number(f.props.throughputM3PerHour ?? 0))} m³/時（全施設の合計 ${cargoHandlingCapacityM3PerHour(layout)} m³/時）`}
          </Info>
        )}
        {(f.kind === 'busStop' || f.kind === 'busTerminal') && (() => {
          const bays = Math.max(0, Number((f.kind === 'busTerminal' ? f.props.berths : f.props.busBays) ?? 0));
          const declared = Math.max(0, Number(f.props.busesPerHour ?? 0));
          const bayCap = bays * BALANCE.accessModel.busesPerBay;
          const eff = Math.min(declared, bayCap);
          return (
            <Info label="発着上限" title="バスの発着上限。設定便数と乗降場の上限（乗降場1か所あたり6便/時）の小さい方。旅客数は1便50人換算">
              {`${eff} 便/時（${declared <= bayCap ? `設定 ${declared} 便/時` : `乗降場 ${bays} か所 × ${BALANCE.accessModel.busesPerBay} 便/時`}が上限）・旅客 約 ${eff * BALANCE.accessModel.busSeats} 人/時`}
            </Info>
          );
        })()}
        {f.kind === 'railStation' && Number(f.props.trainsPerHour ?? 0) > 0 && (
          <Info label="運行上限" title="設定された運行頻度がそのまま上限。旅客数は1便200人換算">
            {`${Number(f.props.trainsPerHour)} 本/時（旅客 約 ${Number(f.props.trainsPerHour) * BALANCE.accessModel.trainSeats} 人/時）`}
          </Info>
        )}
      </>
    );
  }
  return null;
}

/** ゲートのない（コンタクトでない）スポットの数。バスゲートが受け持つ対象 */
function remoteStandCount(layout: AirportLayout): number {
  const contact = new Set<string>();
  for (const g of Object.values(layout.facilities)) {
    if (g.kind === 'gate' && gateMode(g) !== 'bus' && typeof g.props.standId === 'string') contact.add(g.props.standId);
  }
  return Object.values(layout.stands).filter((s) => !contact.has(s.id)).length;
}

/** 運用中の仕分け施設の処理能力の合計（個/分）。運航側の sorters の選び方（運用中・建物内配置を除く）と同じ */
function sorterTotalPerMin(layout: AirportLayout): number {
  return Object.values(layout.facilities)
    .filter((f) => f.kind === 'baggageSort' && f.buildState === 'operational' && !f.parentFacilityId)
    .reduce((s, f) => s + Math.max(0, Number(f.props.capacityPerMin ?? 0)), 0);
}

/**
 * 運行計画から算出したピーク需要（人/時）を、処理系エリア・手荷物受取の詳細に並べる。
 * 定義は core/economy/peakDemand.ts（出発は出発90分前に出現・到着は到着時刻に出現する前提の60分窓最大）。
 * 会社（計画）が無い文脈では何も出さない。
 */
function AreaPeakDemandInfo({ layout, terminalId, kind }: { layout: AirportLayout; terminalId: string; kind: TerminalAreaKind }) {
  const company = useEditor((s) => s.company);
  const demand = useMemo(() => {
    if (!company) return null;
    const ctx = createContext(layout);
    const snap = analyzeAirportCapacity(company, ctx);
    const terminalIds = Object.keys(ctx.terminal.byTerminal);
    return {
      peak: peakProcessDemand(snap.plan, {
        terminalId,
        terminalIdOf: (f) => snap.analysis.assignments[f.key]?.terminalId ?? null,
        soleTerminalId: terminalIds.length === 1 ? terminalIds[0] : undefined,
      }),
      hasFlights: snap.plan.flights.length > 0,
    };
  }, [company, layout, terminalId]);
  if (!demand) return null;
  const value = kind === 'checkIn'
    ? demand.peak.checkInPaxPerHour
    : kind === 'security' || kind === 'emigration' || kind === 'transferSecurity'
      ? demand.peak.departurePaxPerHour
      : demand.peak.arrivalPaxPerHour;
  return (
    <Info label="ピーク需要（運行計画）" title="その日の運行計画から算出。出発側は出発90分前に手続きへ現れる前提、到着側は到着時刻に現れる前提で、任意の60分の最大（人/時）。チェックインは出発旅客の65%が利用する前提（計画分析と同じ）">
      {demand.hasFlights ? `約 ${value} 人/時` : '0 人/時（計画便なし）'}
    </Info>
  );
}

const GROUND_UNIT_SUFFIX: Partial<Record<UnitKind, string>> = { staff: '人', engineer: '人' };

/**
 * 地上支援の同時処理能力とボトルネックを、GSE 基地・整備施設の詳細に並べる。
 * 資源は空港全体で共有されるため、能力は全基地・全整備施設の合計に対する値（計画側の
 * turnaroundCapacity と同じ前提）。会社があれば計画上の最大同時折り返し（需要側）も併記する。
 */
function GroundCapacityInfo({ layout }: { layout: AirportLayout }) {
  const company = useEditor((s) => s.company);
  const data = useMemo(() => {
    const ctx = createContext(layout);
    return {
      detail: turnaroundCapacityDetail(ctx),
      peakTurns: company ? analyzeAirportCapacity(company, ctx).analysis.peakTurnarounds : null,
    };
  }, [company, layout]);
  const { detail, peakTurns } = data;
  const gateLabel = (k: 'fuelFarm' | 'engineer' | 'tug'): string => (k === 'fuelFarm' ? '燃料施設' : UNIT_KIND_LABEL[k]);
  return (
    <>
      <Info label="同時処理能力" title="空港全体の地上支援（運用中の全GSE基地・整備施設の合計）で、資源待ちなく同時に処理できる折り返し機数。計画側の turnaroundCapacity と同じ前提">
        {`${detail.capacity} 機（空港全体）`}
      </Info>
      {detail.gates.length > 0 ? (
        <Info label="不足（運航が止まる）" title="この不足がある間は、他の資源を増やしても同時処理能力は 0 のまま">
          {detail.gates.map((g) => `${gateLabel(g.kind)}なし`).join('・')}
        </Info>
      ) : detail.limiting.length > 0 ? (
        <Info label="次に増やすべき" title="同時処理を +1 機するために不足している資源。複数ある場合は全部そろうと +1 機になる">
          {`${detail.limiting.map((l) => `${UNIT_KIND_LABEL[l.kind]} あと ${l.add} ${GROUND_UNIT_SUFFIX[l.kind] ?? '台'}`).join('・')}（${detail.limiting.length > 1 ? '全部そろうと' : ''}同時処理 +1 機）`}
        </Info>
      ) : null}
      {peakTurns !== null && (
        <Info label="計画上の最大同時折り返し" title="その日の運行計画で、同時に折り返しが重なる最大機数。同時処理能力と比べると不足が分かる">
          {`${peakTurns} 機`}
        </Info>
      )}
    </>
  );
}

// ---------------------------------------------------------------- 部品

function EntityLink({ layout, id }: { layout: AirportLayout; id: string }) {
  return (
    <button className="link" onClick={() => focusEntity(id)}>
      {displayName(layout, id)}
    </button>
  );
}

/** sim 効果がない / 表示のみの種別のバッジ（UI 改善 案3。分類は core/model/catalog が正本） */
function SimEffectBadge({ kind }: { kind: Facility['kind'] }) {
  const effect = FACILITY_SIM_EFFECT[kind];
  if (effect !== 'none' && effect !== 'displayOnly') return null;
  return (
    <p className="sim-effect-badge-row">
      <span className="badge sim-effect-badge" data-testid={`facility-sim-effect-${kind}`}>
        {SIM_EFFECT_LABEL[effect]}
      </span>
    </p>
  );
}

/** Phase 6 / F6-02: 施設の共通能力インスペクター。値は core/capability の正本から表示する */
function FacilityCapabilityInfo({ layout, f }: { layout: AirportLayout; f: Facility }) {
  // ポータル到達不能の減額（disconnected）まで含めて CapacityPanel と同じ値にするため、
  // facilityCapability の直接呼び出しではなく合成済みの読み取り列経由で取る（UI 改善 案3 の統一修正）。
  // 運航中は閉鎖・故障（F6-04 の operationalStateReadings が正本）も同じ合成から反映する:
  // 同じ subjectId の運航中状態の行があればそちらを表示する
  const r = composeCapabilityReadings(layout, editorStore.getState().ops?.sim.state).find((x) => x.subjectId === f.id) ?? facilityCapability(f);
  return (
    <Section title="能力">
      <div data-testid="facility-capability">
        <Info label="状態">{CAPABILITY_STATE_LABEL[r.state] ?? r.state}</Info>
        {r.theoretical !== null ? (
          <>
            <Info label="理論能力">{`${r.theoretical} ${r.unit}`}</Info>
            <Info label="有効能力">{`${r.effective} ${r.unit}`}</Info>
          </>
        ) : (
          <Info label="能力">{`未算出（${r.uncomputedReason ?? '根拠なし'}）`}</Info>
        )}
        <Info label="根拠">{r.basis}</Info>
      </div>
    </Section>
  );
}

function NameField({ layout, id, value }: { layout: AirportLayout; id: string; value: string }) {
  return (
    <Field label="名前">
      <TextInput value={value} onCommit={(v) => update(layout, id, { name: v })} testid="prop-name" />
    </Field>
  );
}

function RotationField({ value, onChange, label }: { value: Rotation; onChange: (r: Rotation) => void; label: string }) {
  const names: Record<Rotation, string> = { 0: '北（0°）', 90: '東（90°）', 180: '南（180°）', 270: '西（270°）' };
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(Number(e.target.value) as Rotation)} data-testid="prop-rotation">
        {([0, 90, 180, 270] as const).map((r) => (
          <option key={r} value={r}>
            {names[r]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** 運航中の施設の状況と閉鎖・再開 */
function AreaOpsSection({ id }: { id: string }) {
  useEditor((s) => s.ops?.uiVersion ?? -1);
  const o = editorStore.getState().ops;
  if (!o) return null;
  const st = o.sim.state;
  const closed = st.closedAreas.includes(id);
  const fac = st.facilities[id];
  const load = facilityLoad(st, id);
  const here = areaOccupancy(st).get(id) ?? 0;
  return (
    <div className="prop-section" data-testid="area-ops">
      <div className="prop-section-title">運用状況</div>
      <Info label="滞在中">{`${here} 人`}</Info>
      <Info label="待ち / 手続き中">{`${load.queued} 人 / ${load.inService} 人`}</Info>
      {fac && <Info label="処理済み / 平均待ち">{`${fac.served} 人 / ${fac.served ? Math.round(fac.waitTotal / fac.served / 6) / 10 : 0} 分`}</Info>}
      <button className={closed ? 'primary' : 'danger'} onClick={() => ops.setAreaClosed(id, !closed)} data-testid="toggle-area">
        {closed ? '再開する' : '閉鎖する'}
      </button>
    </div>
  );
}
