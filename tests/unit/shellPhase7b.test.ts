import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { createHistory } from '../../src/core/editor/history';
import { createSandboxCompany, type CompanyState } from '../../src/core/economy/company';
import { buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { addPortal, placeFacility } from '../../src/core/layout/operations';
import { facilityDims } from '../../src/core/layout/footprint';
import {
  composeCapabilityReadings,
  facilityCapability,
  layoutCapabilities,
  type CapabilityReading,
} from '../../src/core/capability';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import type { AirportLayout, Facility } from '../../src/core/model/types';
import type { SimState } from '../../src/core/sim/types';
import { editorStore, type EditorState } from '../../src/editor/store';
import { companyActions, normalizeHubSettings } from '../../src/editor/simRunner';
import { hubOdRows, portalUsageRows } from '../../src/ui/DayReview';
import { airlineNetworkScopeText } from '../../src/ui/operate/cards/AirlineScoreTable';
import { groupCommonReadings, terminalGroupOf } from '../../src/ui/CapacityPanel';
import { TerminalComplexInfo } from '../../src/ui/PropertiesPanel';
import { PortalDiagnostics } from '../../src/ui/AccessPanels';
import { HubSettingsEditor } from '../../src/ui/HubPanel';
import { footprintBuildingGeometry } from '../../src/render/three/Scene3D';
import { must } from './helpers';

/**
 * UIデザイン更新 第7段階b（表示系）のテスト。
 * 1. hubOd / portalUsage の表示行変換（日報ドロワー）
 * 2. 就航範囲の表示文
 * 3. B6 階層切替のグループ化
 * 4. B7 ターミナル複合体の表示
 * 5. B8 複合グラフ診断の表示
 * 6. B9/F6-04 capability の能力状態の統合（バックエンド生成 operationalStateReadings が正本。
 *    旧 UI 側導出は撤去済み。運航状態なしでは従来と同一）
 * 7. B10 3D footprint ジオメトリ
 * 8. ハブ設定の編集（正規化・保存往復）
 * 実セーブ往復（1412/1230）は shellPhase7a の同名テストで同じ土台を検証する。
 */

function setStore(layout: AirportLayout, company: CompanyState = createSandboxCompany()): void {
  editorStore.setState({
    history: createHistory(layout),
    company,
    selection: null,
    tool: 'select',
    draft: null,
    hover: null,
    hoverW: null,
    footprintEdit: null,
    pickCandidates: [],
    mode: 'build',
  } as Partial<EditorState>);
}

beforeEach(() => {
  setStore(createSampleAirport());
});

describe('第7段階b-1: hubOd / portalUsage の表示行', () => {
  it('hubOdRows: OD 名・種類ラベル・品質%・平均接続分へ写す', () => {
    const rows = hubOdRows([
      { from: 'TYO', to: 'OSA', kind: 'DD', pax: 120, pairs: 3, appeal: 1.234, avgQuality: 0.856, avgGapMin: 95.4 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.fromName).toBe('東京');
    expect(rows[0]!.kindLabel).toBe('国内→国内');
    expect(rows[0]!.pax).toBe(120);
    expect(rows[0]!.qualityPct).toBe(86);
    expect(rows[0]!.gapMin).toBe(95);
    expect(hubOdRows(undefined)).toEqual([]);
  });

  it('portalUsageRows: 合計を加算し降順に並べる', () => {
    const rows = portalUsageRows([
      { portalId: 'p1', facilityId: 'f1', enter: 10, exit: 5 },
      { portalId: 'p2', facilityId: 'f2', enter: 30, exit: 40 },
    ]);
    expect(rows.map((r) => r.portalId)).toEqual(['p2', 'p1']);
    expect(rows[0]!.total).toBe(70);
    expect(portalUsageRows(undefined)).toEqual([]);
  });
});

describe('第7段階b-2: 就航範囲の表示', () => {
  it('制限つき会社は許可目的地の件数と名前を列挙する', () => {
    const text = airlineNetworkScopeText('IJ'); // スプリング・ジャパン: 5 目的地に制限
    expect(text).toContain('5 目的地のみ');
    expect(text).toContain('東京');
    expect(text).toContain('高松');
  });

  it('無制限の会社はその旨を表示する', () => {
    expect(airlineNetworkScopeText('NH')).toBe('全目的地（制限なし）');
  });
});

describe('第7段階b-3: B6 階層切替のグループ化', () => {
  const reading = (subjectId: string, domain: string): CapabilityReading =>
    ({ subjectId, label: subjectId, domain, unit: '人/時', theoretical: 10, effective: 10, state: 'operational', basis: '', demand: null, actual: null }) as CapabilityReading;

  it('facility は見出しなしの 1 グループ（従来表示と同一）', () => {
    const layout = createSampleAirport();
    const rows = [reading('a', 'facility'), reading('b', 'night')];
    const groups = groupCommonReadings(layout, rows, 'facility');
    expect(groups).toHaveLength(1);
    expect(groups[0]!.label).toBeNull();
    expect(groups[0]!.rows).toHaveLength(2);
  });

  it('domain は分野ごとに、terminal は所属ターミナルごとに分ける', () => {
    const base = createSampleAirport();
    const terminal = Object.values(base.facilities).find((f) => f.kind === 'terminal')!;
    // サンプル空港にはターミナル内包施設が無いため、親子関係だけを持つ子施設を足して所属判定を固定する
    const child: Facility = { ...terminal, id: 'fac_b6_child', name: '内包施設（テスト）', kind: 'baggageSort', parentFacilityId: terminal.id };
    const layout: AirportLayout = { ...base, facilities: { ...base.facilities, [child.id]: child } };
    const rows = [reading(child.id, 'facility'), reading('night-stand', 'night')];
    const byDomain = groupCommonReadings(layout, rows, 'domain');
    expect(byDomain.map((g) => g.key).sort()).toEqual(['domain-facility', 'domain-night']);
    const byTerminal = groupCommonReadings(layout, rows, 'terminal');
    expect(byTerminal.map((g) => g.key).sort()).toEqual([`terminal-${terminal.id}`, 'terminal-none']);
    expect(terminalGroupOf(layout, reading(terminal.id, 'facility')).id).toBe(terminal.id);
  });
});

describe('第7段階b-4: B7 ターミナル複合体の表示', () => {
  it('隣接する 2 建物は物理複合体として、リンクで結ぶとサービス複合体としても出る', () => {
    const base = createSampleAirport();
    const t1 = Object.values(base.facilities).find((f) => f.kind === 'terminal')!;
    const d = facilityDims(t1);
    const t2: Facility = { ...t1, id: 'fac_terminal_b7', name: '第2ターミナル（テスト）', origin: { x: t1.origin.x + d.w, y: t1.origin.y } };
    const area1 = Object.values(base.terminalAreas).find((a) => a.terminalId === t1.id)!;
    const area2 = { ...area1, id: 'area_b7_t2', terminalId: t2.id };
    const layout: AirportLayout = {
      ...base,
      facilities: { ...base.facilities, [t2.id]: t2 },
      terminalAreas: { ...base.terminalAreas, [area2.id]: area2 },
      terminalLinks: {
        ...(base.terminalLinks ?? {}),
        link_b7: { id: 'link_b7', name: '連絡通路', kind: 'walkway', fromAreaId: area1.id, toAreaId: area2.id, distanceM: 50, travelSec: 60, buildState: 'operational', bidirectional: true, allowedZones: ['landside', 'departure', 'arrival'] },
      },
    };
    const html = renderToString(createElement(TerminalComplexInfo, { layout, terminalId: t1.id }));
    expect(html).toContain('data-testid="terminal-complex"');
    expect(html).toContain('data-testid="complex-physical"');
    expect(html).toContain('構成 2 建物');
    expect(html).toContain('第2ターミナル（テスト）');
    // リンクを外すとサービス複合体は単独に戻る（物理複合体は隣接のまま）
    const unlinked: AirportLayout = { ...layout, terminalLinks: {} };
    const html2 = renderToString(createElement(TerminalComplexInfo, { layout: unlinked, terminalId: t1.id }));
    expect(html2).toContain('単独');
  });
});

describe('第7段階b-5: B8 複合グラフ診断の表示', () => {
  it('ポータルを持つ施設が診断表に出て、無い空港では空表示になる', () => {
    // 第7段階a のポータルテストと同じ作り（スターター飛行場にバスターミナルを置いて入口へ接続）
    let layout = createStarterAirfield();
    layout = must(placeFacility(layout, 'busTerminal', { x: 36, y: 58 })).layout;
    const bt = Object.values(layout.facilities).find((f) => f.kind === 'busTerminal')!;
    const entrance = Object.values(layout.terminalAreas).find((a) => a.kind === 'entrance')!;
    const withPortal = must(addPortal(layout, { facilityId: bt.id, areaId: entrance.id })).layout;
    const html = renderToString(createElement(PortalDiagnostics, { layout: withPortal }));
    expect(html).toContain('data-testid="portal-diagnostics"');
    expect(html).toContain(`data-testid="portal-diag-${bt.id}"`);
    const empty = renderToString(createElement(PortalDiagnostics, { layout: createStarterAirfield() }));
    expect(empty).toContain('data-testid="portal-diagnostics-empty"');
  });
});

describe('第7段階b-6: B9/F6-04 能力状態の統合（バックエンド生成が正本）', () => {
  const stub = (patch: Record<string, unknown>): SimState => patch as unknown as SimState;
  const fakeState = (over: Record<string, unknown>): SimState =>
    stub({ disruptions: [], runwayConfig: {}, closures: { taxiways: [], stands: [], gates: [] }, ...over });

  it('layoutCapabilities 単独では closed / failed は生成されない（従来と同一）', () => {
    const layout = createSampleAirport();
    const plain = layoutCapabilities(layout);
    expect(plain.some((r) => r.state === 'closed' || r.state === 'failed')).toBe(false);
  });

  it('composeCapabilityReadings: 運航状態が無ければ layoutCapabilities と完全同一', () => {
    const layout = createSampleAirport();
    expect(composeCapabilityReadings(layout, undefined)).toEqual(layoutCapabilities(layout));
    expect(composeCapabilityReadings(layout, fakeState({}))).toEqual(layoutCapabilities(layout));
  });

  it('composeCapabilityReadings: 閉鎖台帳の施設は closed になり、理論能力を保ち、二重行にならない', () => {
    const layout = createSampleAirport();
    const tower = Object.values(layout.facilities).find((f) => f.kind === 'tower')!;
    const plain = layoutCapabilities(layout).find((r) => r.subjectId === tower.id)!;
    expect(plain.theoretical).not.toBeNull();
    const state = fakeState({
      closures: { taxiways: [], stands: [], gates: [tower.id] },
      closureReasons: { taxiways: {}, stands: {}, gates: { [tower.id]: ['manual'] } },
    });
    const merged = composeCapabilityReadings(layout, state);
    const rows = merged.filter((r) => r.subjectId === tower.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe('closed');
    expect(rows[0]!.theoretical).toBe(plain.theoretical);
    expect(rows[0]!.effective).toBe(0);
    // 対象外の reading は不変
    const other = plain.subjectId === tower.id ? layoutCapabilities(layout)[1]! : plain;
    expect(merged.find((r) => r.subjectId === other.subjectId)?.state).toBe(other.state);
  });

  it('facilityCapability: 能力式のない種別は uncomputed のまま（状態生成は operationalStateReadings の役目）', () => {
    const f = { id: 'fac_bag_test', kind: 'baggageSort', name: '手荷物ソート', buildState: 'operational', props: {} } as unknown as Facility;
    expect(facilityCapability(f).state).toBe('uncomputed');
    expect(facilityCapability(f).theoretical).toBeNull();
    const cargo = { id: 'fac_cargo_test', kind: 'cargoTerminal', name: '貨物上屋', buildState: 'operational', props: { throughputM3PerHour: 120 } } as unknown as Facility;
    expect(facilityCapability(cargo).theoretical).toBe(120);
  });
});

describe('第7段階b-7: B10 3D footprint ジオメトリ', () => {
  it('L 字リングは押し出しジオメトリになり、外形と高さが一致する', () => {
    const f = {
      id: 'fac_fp',
      kind: 'terminal',
      footprint: [
        { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 2, y: 2 }, { x: 2, y: 4 }, { x: 0, y: 4 },
      ],
    } as unknown as Facility;
    const g = footprintBuildingGeometry(f, 12);
    expect(g).not.toBeNull();
    const bb = g!.boundingBox!;
    expect(bb.max.x - bb.min.x).toBeCloseTo(100); // 4 タイル × 25 m
    expect(bb.max.z - bb.min.z).toBeCloseTo(100);
    expect(bb.max.y - bb.min.y).toBeCloseTo(12);
    expect(bb.min.y).toBeCloseTo(0);
  });

  it('footprint が無い/退化している施設は null（矩形フォールバック）', () => {
    expect(footprintBuildingGeometry({ id: 'x', kind: 'terminal' } as unknown as Facility, 12)).toBeNull();
    expect(footprintBuildingGeometry({ id: 'x', kind: 'terminal', footprint: [{ x: 0, y: 0 }, { x: 1, y: 0 }] } as unknown as Facility, 12)).toBeNull();
  });
});

describe('第7段階b-8: ハブ設定の編集 UI と保存', () => {
  it('normalizeHubSettings: 0–1440 に丸め、from ≤ to に並べ替え、上限の下限を守る', () => {
    const n = normalizeHubSettings({
      banks: [{ id: 'b1', arriveFromMin: 700, arriveToMin: 600, departFromMin: -5, departToMin: 2000 }],
      maxConnectMin: 0,
    });
    expect(n.banks[0]).toMatchObject({ arriveFromMin: 600, arriveToMin: 700, departFromMin: 0, departToMin: 1440 });
    expect(n.maxConnectMin).toBe(1);
  });

  it('編集 UI: 既存のバンクと上限が入力として出る', () => {
    const company = createSandboxCompany();
    company.hub = { banks: [{ id: 'bank_1', arriveFromMin: 360, arriveToMin: 540, departFromMin: 570, departToMin: 720 }], maxConnectMin: 300 };
    const html = renderToString(createElement(HubSettingsEditor, { company }));
    expect(html).toContain('data-testid="hub-settings-edit"');
    expect(html).toContain('data-testid="hub-bank-bank_1"');
    expect(html).toContain('data-testid="hub-max-connect"');
    expect(html).toContain('data-testid="hub-bank-add"');
  });

  it('setHubSettings: company.hub に保存され、プロジェクト保存・再読込でも検証を通る', () => {
    const company = createSandboxCompany();
    // hub はフェーズ4機能（features）を持つ会社の保存対象。実ゲームの会社は作成時に features を持つ
    company.features = { hub: true };
    setStore(createSampleAirport(), company);
    companyActions.setHubSettings({
      banks: [{ id: 'bank_9', arriveFromMin: 660, arriveToMin: 600, departFromMin: 700, departToMin: 800 }],
      maxConnectMin: 300,
    });
    const saved = editorStore.getState().company.hub;
    expect(saved?.maxConnectMin).toBe(300);
    expect(saved?.banks[0]).toMatchObject({ arriveFromMin: 600, arriveToMin: 660 });
    const project = buildProject({
      name: 'hub-test',
      savedAt: '2026-11-20T00:00:00Z',
      layout: editorStore.getState().history.present,
      company: editorStore.getState().company,
      pin: null,
      scenarios: [],
      sim: null,
    });
    const report = validateProject(serializeProject(project), { fallbackCompany: createSandboxCompany() });
    expect(report.errors).toEqual([]);
    expect(report.project?.company.hub?.maxConnectMin).toBe(300);
  });
});
