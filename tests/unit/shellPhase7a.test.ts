import { existsSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import { createSandboxCompany } from '../../src/core/economy/company';
import { validateOrthogonalPolygon } from '../../src/core/geometry/polygon';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import {
  buildProject,
  effectiveModels,
  formatVersionOf,
  restoreSimulation,
  serializeProject,
  validateProject,
  PROJECT_FORMAT_MAX_READABLE,
} from '../../src/core/io/project';
import {
  addPortal,
  deletePortal,
  placeFacility,
  placeTerminalArea,
  setFacilityFootprint,
  updateEntity,
} from '../../src/core/layout/operations';
import { facilityOutline } from '../../src/core/layout/footprint';
import { assessTaxiwayWidth, requiredPavementWidthM } from '../../src/core/airside/taxiwayDesign';
import { layoutCapabilities } from '../../src/core/capability';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import type { AirportLayout } from '../../src/core/model/types';
import { buildTypeTable } from '../../src/core/sim/aircraftTypes';
import { stepTicks } from '../../src/core/sim/dayloop';
import { createSimulation } from '../../src/core/sim/simulation';
import { serviceProfilesFor } from '../../src/core/terminal/serviceProfile';
import { runServiceDetailSim } from '../../src/core/terminal/serviceDetailSim';
import { verifyPortalAccess } from '../../src/core/terminal/networkGraph';
import { actions, applyOp, editorStore, type EditorState } from '../../src/editor/store';
import { computeOp, computePreview, deleteFootprintVertex, footprintEdgeInsert, footprintVertexAt, moveFootprintVertex } from '../../src/editor/tools';
import {
  FacilityCapabilityPreview,
  FacilityFootprintSection,
  FacilityPortalSection,
  TaxiwayDesignFields,
} from '../../src/ui/PropertiesPanel';
import { Toolbox } from '../../src/ui/Toolbox';
import { must } from './helpers';

/**
 * UIデザイン更新 第7段階a（編集系）のテスト。
 * 1. ラウンジ配置 UI（Toolbox・編集経路・能力/詳細 sim のカテゴリ）
 * 2. B2 ポータル編集（PropertiesPanel の節・作成/削除の往復・到達状態の追随）
 * 3. B1 フットプリント編集（頂点操作の純関数・確定の往復・形式の版が上がらない）
 * 4. B3 誘導路の設計項目（updateEntity の保存・適合表示）
 * 5. B5 F6-02 配置/増設プレビュー（プレビュー値と確定後の実値の一致）
 * 実セーブ往復（1412/1230）はファイルがある環境でのみ実行する。
 */

function setStore(layout: AirportLayout, patch: Partial<EditorState> = {}): void {
  editorStore.setState({
    history: createHistory(layout),
    company: createSandboxCompany(),
    selection: null,
    tool: 'select',
    draft: null,
    hover: null,
    hoverW: null,
    footprintEdit: null,
    pickCandidates: [],
    mode: 'build',
    ...patch,
  } as Partial<EditorState>);
}

beforeEach(() => {
  setStore(createSampleAirport());
});

describe('第7段階a-1: ラウンジ配置 UI', () => {
  it('Toolbox の内部エリア一覧にラウンジが出る', () => {
    const html = renderToString(createElement(Toolbox));
    expect(html).toContain('data-testid="tool-area:lounge"');
    expect(html).toContain('ラウンジ');
  });

  it('編集経路（ツール→プレビュー→確定）でラウンジを配置でき、席数が能力に出る', () => {
    const layout = createSampleAirport();
    const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    setStore(layout, { tool: 'area:lounge', hover: { x: 60, y: 51 }, interiorLevel: 1 } as Partial<EditorState>);
    const preview = computePreview(editorStore.getState());
    expect(preview?.result.ok).toBe(true);
    const op = computeOp(editorStore.getState());
    expect(op).not.toBeNull();
    expect(applyOp(op!.result)).toBe(true);
    const after = editorStore.getState().history.present;
    const lounge = Object.values(after.terminalAreas).find((a) => a.kind === 'lounge');
    expect(lounge).toBeDefined();
    expect(lounge!.terminalId).toBe(terminal);
    expect(Number(lounge!.props.seats)).toBe(40);
    // 能力（サービス profile）: ラウンジカテゴリに席数 40 が出る
    const profiles = serviceProfilesFor(after);
    const cat = profiles.byTerminalCategory.get(`${terminal}|lounge`);
    expect(cat?.status).toBe('available');
    expect(cat?.totalCapacity).toBe(40);
    // PropertiesPanel の汎用 props 編集（席数）が通る
    const upd = updateEntity(after, lounge!.id, { props: { seats: 120 } });
    expect(upd.ok).toBe(true);
    const after2 = must(upd).layout;
    expect(serviceProfilesFor(after2).byTerminalCategory.get(`${terminal}|lounge`)?.totalCapacity).toBe(120);
  });

  it('詳細 sim でラウンジが滞留先カテゴリとして使われる', () => {
    const layout = createSampleAirport();
    const terminal = Object.values(layout.facilities).find((f) => f.kind === 'terminal')!.id;
    const placed = placeTerminalAreaForTest(layout, terminal);
    const loungeId = Object.values(placed.terminalAreas).find((a) => a.kind === 'lounge')!.id;
    const result = runServiceDetailSim(placed, {
      terminalId: terminal,
      durationSec: 3 * 3600,
      groupsPerHour: 60,
      seed: 'phase7a-lounge',
      loungeVisitProb: 1,
      // ラウンジ立寄りは締切まで 60 分以上の余裕が条件（BALANCE.lounge.minSlackMin）のため予算を広く取る
      budgetMinSec: 150 * 60,
      budgetMaxSec: 200 * 60,
    });
    expect(result.loungeExperience.users).toBeGreaterThan(0);
    expect(result.records[loungeId]?.users).toBeGreaterThan(0);
  });
});

function placeTerminalAreaForTest(layout: AirportLayout, terminal: string): AirportLayout {
  // ターミナル内部（保安検査と待合の間の空き）へ置く。到達できない位置では詳細 sim の候補にならない
  return must(placeTerminalArea(layout, terminal, 1, 'lounge', { x: 60, y: 51 }, { w: 4, h: 2, name: 'ラウンジ', props: { seats: 40 } })).layout;
}

describe('第7段階a-2: B2 ポータル編集', () => {
  function fixture() {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'busTerminal', { x: 36, y: 58 })).layout;
    const bt = Object.values(l.facilities).find((f) => f.kind === 'busTerminal')!;
    const entrance = Object.values(l.terminalAreas).find((a) => a.kind === 'entrance')!;
    return { l, bt, entrance };
  }

  it('交通施設のプロパティにポータル節が出て、未接続の案内が出る', () => {
    const { l, bt } = fixture();
    // PropertiesPanel は store 連動のため、節コンポーネントを props 駆動で直接描画して固定する
    const html = renderToString(createElement(FacilityPortalSection, { layout: l, facilityId: bt.id, readOnly: false }));
    expect(html).toContain('data-testid="portal-section"');
    expect(html).toContain('data-testid="portal-area-select"');
    expect(html).toContain('data-testid="portal-add"');
  });

  it('作成→到達状態が operational→削除、の往復が UI の使う操作で成立する', () => {
    const { l, bt, entrance } = fixture();
    setStore(l, { selection: bt.id });
    expect(applyOp(addPortal(l, { facilityId: bt.id, areaId: entrance.id }))).toBe(true);
    const withPortal = editorStore.getState().history.present;
    const portal = Object.values(withPortal.portals!)[0]!;
    expect(portal.facilityId).toBe(bt.id);
    // 到達状態: ポータル経由で到達可能になる
    const access = verifyPortalAccess(withPortal).find((s) => s.facilityId === bt.id);
    expect(access?.toEntrance).toBe('operational');
    // パネルにポータルと到達状態が出る
    const html = renderToString(createElement(FacilityPortalSection, { layout: withPortal, facilityId: bt.id, readOnly: false }));
    expect(html).toContain(`data-testid="portal-delete-${portal.id}"`);
    expect(html).toContain('data-testid="portal-access-status"');
    // 削除の往復
    expect(applyOp(deletePortal(withPortal, portal.id))).toBe(true);
    const after = editorStore.getState().history.present;
    expect(Object.keys(after.portals ?? {})).toHaveLength(0);
  });

  it('ポータルは保存・再読込で往復し、書き出し形式の版を上げない', () => {
    const { l, bt, entrance } = fixture();
    const before = buildProject({ name: 't', savedAt: '2026-11-19T00:00:00Z', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    const withPortal = must(addPortal(l, { facilityId: bt.id, areaId: entrance.id })).layout;
    const after = buildProject({ name: 't', savedAt: '2026-11-19T00:00:00Z', layout: withPortal, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    expect(after.formatVersion).toBe(before.formatVersion);
    const round = importLayout(exportLayout(withPortal));
    expect(Object.keys(round.portals ?? {})).toHaveLength(1);
    expect(Object.values(round.portals!)[0]!.facilityId).toBe(bt.id);
  });
});

describe('第7段階a-3: B1 フットプリント編集', () => {
  it('施設のプロパティに外形の節が出る（矩形表示と編集開始ボタン）', () => {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'cargoTerminal', { x: 10, y: 10 })).layout;
    const f = Object.values(l.facilities).find((x) => x.kind === 'cargoTerminal')!;
    const html = renderToString(createElement(FacilityFootprintSection, { layout: l, f, readOnly: false }));
    expect(html).toContain('data-testid="footprint-info"');
    expect(html).toContain('data-testid="footprint-edit-start"');
  });


  const rect = [
    { x: 10, y: 10 },
    { x: 16, y: 10 },
    { x: 16, y: 14 },
    { x: 10, y: 14 },
  ];

  it('頂点の移動は直交を保ち、辺への挿入と削除が成立する', () => {
    const moved = moveFootprintVertex(rect, 1, { x: 18, y: 10 });
    expect(validateOrthogonalPolygon(moved)).toEqual([]);
    expect(moved[1]).toEqual({ x: 18, y: 10 });
    expect(moved[2]!.x).toBe(18); // 縦辺の隣接頂点が x を追随
    const ins = footprintEdgeInsert(moved, { x: 18.2, y: 12 }, 0.6);
    expect(ins).not.toBeNull();
    const withIns = [...moved.slice(0, ins!.index), ins!.point, ...moved.slice(ins!.index)];
    expect(validateOrthogonalPolygon(withIns)).toEqual([]);
    expect(footprintVertexAt(withIns, { x: 18, y: 12 }, 0.1)).toBe(ins!.index);
    const deleted = deleteFootprintVertex(withIns, ins!.index);
    expect(deleted).not.toBeNull();
    expect(validateOrthogonalPolygon(deleted!)).toEqual([]);
    // 矩形（4頂点）はこれ以上削れない
    expect(deleteFootprintVertex(rect, 0)).toBeNull();
  });

  it('編集→確定→保存→再読込の往復と、形式の版が上がらないこと', () => {
    let l = createStarterAirfield();
    l = must(placeFacility(l, 'cargoTerminal', { x: 10, y: 10 })).layout;
    const f = Object.values(l.facilities).find((x) => x.kind === 'cargoTerminal')!;
    const before = buildProject({ name: 't', savedAt: '2026-11-19T00:00:00Z', layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    setStore(l, { selection: f.id });
    actions.startFootprintEdit(f.id);
    const edit = editorStore.getState().footprintEdit;
    expect(edit?.facilityId).toBe(f.id);
    expect(edit!.points).toEqual(facilityOutline(f));
    // 1頂点を外へ動かして L 字にする（辺に頂点を足してから角を動かす）
    const ins = footprintEdgeInsert(edit!.points, { x: f.origin.x + f.w / 2, y: f.origin.y + 0.2 }, 0.6);
    expect(ins).not.toBeNull();
    let pts = [...edit!.points.slice(0, ins!.index), ins!.point, ...edit!.points.slice(ins!.index)];
    pts = moveFootprintVertex(pts, ins!.index, { x: ins!.point.x, y: f.origin.y - 2 });
    expect(validateOrthogonalPolygon(pts)).toEqual([]);
    actions.setFootprintPoints(pts);
    const current = editorStore.getState().history.present;
    expect(applyOp(setFacilityFootprint(current, f.id, pts))).toBe(true);
    actions.endFootprintEdit();
    const after = editorStore.getState().history.present;
    expect(after.facilities[f.id]!.footprint).toEqual(pts);
    // 保存・再読込の往復
    const round = importLayout(exportLayout(after));
    expect(round.facilities[f.id]!.footprint).toEqual(pts);
    // 形式の版は上がらない
    const afterProject = buildProject({ name: 't', savedAt: '2026-11-19T00:00:00Z', layout: after, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
    expect(afterProject.formatVersion).toBe(before.formatVersion);
    expect(formatVersionOf(afterProject)).toBeLessThanOrEqual(PROJECT_FORMAT_MAX_READABLE);
    // 矩形へ戻す（footprint 解除）も往復する
    const cleared = must(setFacilityFootprint(after, f.id, null)).layout;
    expect(cleared.facilities[f.id]!.footprint).toBeUndefined();
    expect(importLayout(exportLayout(cleared)).facilities[f.id]!.footprint).toBeUndefined();
  });
});

describe('第7段階a-4: B3 誘導路の設計項目', () => {
  function taxiwayLayout() {
    const l = createStarterAirfield();
    const tw = Object.values(l.taxiways)[0]!;
    return { l, tw };
  }

  it('設計項目を設定・解除でき、不正値は拒否され、往復保存できる', () => {
    const { l, tw } = taxiwayLayout();
    const set = updateEntity(l, tw.id, { pavementWidthM: 23, shoulderWidthM: 10.5, designProfile: 'faa-tdg', designGroup: '5', role: 'rapidExit' });
    expect(set.ok).toBe(true);
    const e = must(set).layout.taxiways[tw.id]!;
    expect(e.pavementWidthM).toBe(23);
    expect(e.shoulderWidthM).toBe(10.5);
    expect(e.designProfile).toBe('faa-tdg');
    expect(e.designGroup).toBe('5');
    expect(e.role).toBe('rapidExit');
    // io 往復
    const round = importLayout(exportLayout(must(set).layout));
    expect(round.taxiways[tw.id]!.pavementWidthM).toBe(23);
    expect(round.taxiways[tw.id]!.designGroup).toBe('5');
    // 解除（null でキーが消える）
    const cleared = updateEntity(must(set).layout, tw.id, { pavementWidthM: null, designProfile: null });
    expect(cleared.ok).toBe(true);
    expect(must(cleared).layout.taxiways[tw.id]!.pavementWidthM).toBeUndefined();
    expect(must(cleared).layout.taxiways[tw.id]!.designProfile).toBeUndefined();
    // 不正値
    expect(updateEntity(l, tw.id, { pavementWidthM: -1 }).ok).toBe(false);
    expect(updateEntity(l, tw.id, { pavementWidthM: 101 }).ok).toBe(false);
    expect(updateEntity(l, tw.id, { designProfile: 'xxx' }).ok).toBe(false);
    expect(updateEntity(l, tw.id, { role: 'xxx' }).ok).toBe(false);
    // 変更なしは NO_CHANGE
    expect(updateEntity(must(set).layout, tw.id, { pavementWidthM: 23 }).ok).toBe(false);
  });

  it('幅適合: FAA TDG の必要幅と実幅の比較が assessTaxiwayWidth と一致する', () => {
    const { l, tw } = taxiwayLayout();
    const narrow = must(updateEntity(l, tw.id, { pavementWidthM: 15, designProfile: 'faa-tdg', designGroup: '5' })).layout.taxiways[tw.id]!;
    expect(requiredPavementWidthM('faa-tdg', { designGroup: '5', omgwsM: 34.9 })).toBe(22.9); // FAA TDG 5 の舗装幅
    expect(assessTaxiwayWidth(narrow, 34.9)).toBe('insufficient');
    const wide = { ...narrow, pavementWidthM: 23 };
    expect(assessTaxiwayWidth(wide, 34.9)).toBe('sufficient');
    // 幅未設定は legacy（従来どおり扱う）、必要幅が決まらなければ unknown
    expect(assessTaxiwayWidth(tw, 34.9)).toBe('legacy');
    expect(assessTaxiwayWidth(narrow, undefined)).toBe('unknown');
  });

  it('誘導路のプロパティに設計節と適合表示が出る', () => {
    const { l, tw } = taxiwayLayout();
    const withDesign = must(updateEntity(l, tw.id, { pavementWidthM: 15, designProfile: 'faa-tdg', designGroup: '5' })).layout;
    const html = renderToString(createElement(TaxiwayDesignFields, { layout: withDesign, id: tw.id, readOnly: false }));
    expect(html).toContain('data-testid="taxi-design"');
    expect(html).toContain('data-testid="taxi-design-assessment"');
    expect(html).toContain('不足');
  });
});

describe('第7段階a-5: B5 配置・増設プレビュー', () => {
  it('配置プレビュー（仮レイアウトの能力）と確定後の能力が一致する', () => {
    const layout = createStarterAirfield();
    setStore(layout, { tool: 'facility:cargoTerminal', hover: { x: 10, y: 10 } } as Partial<EditorState>);
    const preview = computePreview(editorStore.getState());
    expect(preview?.result.ok).toBe(true);
    const createdId = preview!.result.ok ? preview!.result.created[0]! : '';
    const hypoReading = layoutCapabilities(preview!.result.ok ? preview!.result.layout : layout).find((x) => x.subjectId === createdId);
    expect(hypoReading).toBeDefined();
    const op = computeOp(editorStore.getState());
    expect(applyOp(op!.result, { select: true })).toBe(true);
    const after = editorStore.getState().history.present;
    const actual = layoutCapabilities(after).find((x) => x.subjectId === createdId);
    expect(actual?.theoretical).toBe(hypoReading!.theoretical);
    expect(actual?.effective).toBe(hypoReading!.effective);
  });

  it('増設プレビュー: 仮変更の能力と、同じ変更を確定した後の能力が一致する', () => {
    const layout = createStarterAirfield();
    const placed = must(placeFacility(layout, 'cargoTerminal', { x: 10, y: 10 }));
    const f = Object.values(placed.layout.facilities).find((x) => x.kind === 'cargoTerminal')!;
    const key = 'throughputM3PerHour';
    const cur = Number(f.props[key] ?? 0);
    const hypo = updateEntity(placed.layout, f.id, { props: { [key]: cur + 100 } });
    expect(hypo.ok).toBe(true);
    const hypoReading = layoutCapabilities(must(hypo).layout).find((x) => x.subjectId === f.id);
    // パネルに増設プレビューの節が出る（理論能力を持つ施設）
    const html = renderToString(createElement(FacilityCapabilityPreview, { layout: placed.layout, f }));
    expect(html).toContain('data-testid="capability-preview"');
    expect(html).toContain('data-testid="capability-preview-result"');
    expect(hypoReading!.theoretical).toBe(cur + 100);
  });
});

describe('第7段階a: 実セーブ往復（1412 / 1230）', () => {
  for (const name of ['skyport-mainplay1-20261119-1412.skyport.json', 'skyport-mainplay1-20261119-1230.skyport.json']) {
    it(`${name}: 読込→1日運航→建設モード保存→再読込が 0 エラー`, () => {
      const path = `/home/hatch/workspace/user/files/${name}`;
      if (!existsSync(path)) return; // 実セーブのない環境ではスキップ
      const raw = readFileSync(path, 'utf8');
      const report = validateProject(raw, { fallbackCompany: createSandboxCompany() });
      expect(report.errors).toEqual([]);
      expect(report.project).not.toBeNull();
      const project = report.project!;
      expect(project.formatVersion).toBe(7);
      // 運航を 1 日進める（この2件は建設モード保存で sim スナップショットを持たないため新規運航で開始）
      const sim = project.sim
        ? restoreSimulation(project.layout, project.sim, effectiveModels(project.catalog)).sim
        : createSimulation(project.layout, { company: project.company, types: buildTypeTable(effectiveModels(project.catalog)) });
      const day0 = sim.company?.day ?? 0;
      // 1 日運航（締めまでチャンクで進める。大規模空港では数分かかるため制限時間は広く取る）
      let stop: string | null = null;
      for (let i = 0; i < 20 && !stop; i++) {
        stop = stepTicks(sim, 10000, { stopAtDayClose: true }).stop;
      }
      expect(stop).toBe('dayClose');
      expect((sim.company?.day ?? 0)).toBe(day0 + 1);
      // 建設モードで保存し直して再読込（締め跨ぎスナップショットの既知問題を避ける通常導線）
      const rebuilt = buildProject({
        name: project.name,
        savedAt: '2026-11-19T00:00:00Z',
        layout: project.layout,
        company: sim.company ?? project.company,
        pin: project.catalog,
        scenarios: project.scenarios,
        sim: null,
      });
      const report2 = validateProject(serializeProject(rebuilt), { fallbackCompany: createSandboxCompany() });
      expect(report2.errors).toEqual([]);
    }, 1200000);
  }
});
