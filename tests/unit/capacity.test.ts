import { describe, expect, it } from 'vitest';
import { addContract, createCareerCompany } from '../../src/core/economy/company';
import { analyzeAirportCapacity, previewContractCapacity } from '../../src/core/economy/capacity';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { createContext } from '../../src/core/sim/context';
import { ACCESS_MODES, analyzeAccess } from '../../src/core/access/model';
import { terminalLinkCapacityPerHour } from '../../src/core/terminal/model';
import { RUNWAY_HOURLY_CAPACITY } from '../../src/core/economy/planning';
import type { AirportLayout } from '../../src/core/model/types';

const onlyArea = (layout: AirportLayout, kind: string) => Object.values(layout.terminalAreas).find((a) => a.kind === kind)!;

describe('空港能力分析', () => {
  it('計画需要と既存の運航計画能力から時間・日次サマリーを作る', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const result = analyzeAirportCapacity(company, createContext(layout));
    const runways = Object.values(layout.runways).filter((r) => r.buildState === 'operational').length;
    expect(result.summary.find((m) => m.name === '滑走路')?.capacity).toBe(runways * RUNWAY_HOURLY_CAPACITY);
    expect(result.summary.find((m) => m.name === '滑走路')?.demand).toBe(Math.max(...result.analysis.hourly.movements));
    expect(result.summary.find((m) => m.name === '1日総処理（滑走路・理論値）')?.capacity).toBe(runways * RUNWAY_HOURLY_CAPACITY * result.operatingHours);
    expect(result.peakHour.movements).toBe(Math.max(...result.analysis.hourly.movements));
  });

  it('レーン数の変更で能力・不足判定が変わる', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const full = analyzeAirportCapacity(company, createContext(layout));
    const lowLayout = structuredClone(layout);
    onlyArea(lowLayout, 'security').props.lanes = 0;
    const low = analyzeAirportCapacity(company, createContext(lowLayout));
    expect(low.summary.find((m) => m.name === '保安検査')?.capacity).toBe(0);
    expect(low.summary.find((m) => m.name === '保安検査')?.capacity).toBeLessThan(full.summary.find((m) => m.name === '保安検査')?.capacity ?? 0);
    if ((low.summary.find((m) => m.name === '保安検査')?.demand ?? 0) > 0) expect(low.summary.find((m) => m.name === '保安検査')?.status).toBe('shortage');
  });

  it('能力モデルがない工程は未算出とし、仮想契約チェックで会社状態を変更しない', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const before = JSON.stringify(company);
    const result = analyzeAirportCapacity(company, createContext(layout));
    expect(result.summary.find((m) => m.name === '誘導路')?.capacity).toBeNull();
    expect(result.summary.find((m) => m.name === '搭乗バス')?.capacity).toBeNull();
    const preview = previewContractCapacity(company, createContext(layout), { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 2, window: 'morning' });
    expect(preview.after.plan.flights.length).toBeGreaterThan(preview.before.plan.flights.length);
    expect(JSON.stringify(company)).toBe(before);
  });

  it('ターミナル収容モデルと運航中の未完了旅客人数を区別して表示する', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const ctx = createContext(layout);
    const terminalId = Object.keys(ctx.terminal.byTerminal)[0]!;
    const people = analyzeAirportCapacity(company, ctx, [], undefined, { [terminalId]: 17 });
    const metric = people.summary.find((m) => m.name === 'ターミナル最大収容人数')!;
    expect(metric.capacity).toBeGreaterThan(17);
    expect(metric.demand).toBe(17);
  });

  it('新しい契約需要に合わせて時間帯別ピークとスポット利用数を変える', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const before = analyzeAirportCapacity(company, createContext(layout));
    addContract(company, { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 3, window: 'morning', feeDiscount: 0, startDay: company.day, endDay: company.day, status: 'active', offerExpiresDay: company.day });
    const after = analyzeAirportCapacity(company, createContext(layout));
    expect(after.plan.flights.length).toBeGreaterThan(before.plan.flights.length);
    expect(after.summary.find((m) => m.name === 'スポット同時駐機')?.demand).toBeGreaterThanOrEqual(before.summary.find((m) => m.name === 'スポット同時駐機')?.demand ?? 0);
  });
});

describe('能力ダッシュボードの追加項目（計画 1-19 / 1-20）', () => {
  const metricOf = (r: ReturnType<typeof analyzeAirportCapacity>, name: string) => r.summary.find((m) => m.name === name)!;

  it('AS-5: 運航中の閉鎖（live）で、滑走路・スポットの数が減り、根拠に「運航中の閉鎖を反映」と出る', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const ctx = createContext(layout);
    const base = analyzeAirportCapacity(company, ctx);
    const runwayId = Object.keys(layout.runways)[0]!;
    const standIds = Object.values(ctx.stands).filter((s) => s.operational && s.entry).map((s) => s.id);
    const live = analyzeAirportCapacity(company, ctx, [], undefined, undefined, { closedRunwayIds: [runwayId], closedStandIds: [standIds[0]!] });
    expect(metricOf(live, '滑走路').capacity).toBe((metricOf(base, '滑走路').capacity ?? 0) - RUNWAY_HOURLY_CAPACITY);
    expect(metricOf(live, 'スポット同時駐機').capacity).toBe((metricOf(base, 'スポット同時駐機').capacity ?? 0) - 1);
    expect(metricOf(live, '滑走路').basis).toContain('運航中の閉鎖を反映');
    expect(metricOf(base, '滑走路').basis).not.toContain('運航中の閉鎖を反映');
    // live を渡さない（空配列でもない）呼び出しは従来どおり
    expect(JSON.stringify(analyzeAirportCapacity(company, ctx).summary.slice(0, 13))).toBe(JSON.stringify(base.summary.slice(0, 13)));
    // 閉鎖した滑走路・スポットの施設行は容量 0
    expect(live.facilities.find((f) => f.id === runwayId)?.capacity).toBe(0);
    expect(live.facilities.find((f) => f.id === standIds[0])?.capacity).toBe(0);
  });

  it('AS-4・AS-6: スポットの回転数と空港全体の離発着能力は、最小の要素が制約名になる。計画が空ならスポット・折り返しは未算出', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const r = analyzeAirportCapacity(company, createContext(layout));
    const turnover = metricOf(r, 'スポットの回転数');
    const overall = metricOf(r, '空港全体の離発着能力');
    expect(r.summary.at(-4)?.name).toBe('スポットの回転数'); // 既存の並びの末尾に追加
    expect(overall.capacity).toBe(r.overall.capacity);
    const runway = metricOf(r, '滑走路').capacity!;
    if (r.plan.flights.length === 0) {
      expect(turnover.capacity).toBeNull();
      expect(r.overall.limitedBy).toBe('runway');
    } else {
      expect(turnover.capacity).toBeGreaterThan(0);
      expect(r.overall.capacity).toBeLessThanOrEqual(Math.min(runway, turnover.capacity!) + 1e-9);
    }
    expect(['runway', 'stand', 'turnaround']).toContain(r.overall.limitedBy);
    // 契約を足して計画ができると、回転数が算出される
    const withFlights = createCareerCompany();
    addContract(withFlights, { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 3, window: 'morning', feeDiscount: 0, startDay: withFlights.day, endDay: withFlights.day, status: 'active', offerExpiresDay: withFlights.day });
    const r2 = analyzeAirportCapacity(withFlights, createContext(layout));
    expect(r2.plan.flights.length).toBeGreaterThan(0);
    expect(metricOf(r2, 'スポットの回転数').capacity).toBeGreaterThan(0);
    expect(r2.overall.capacity).toBeLessThanOrEqual(Math.min(metricOf(r2, '滑走路').capacity!, metricOf(r2, 'スポットの回転数').capacity!) + 1e-9);
  });

  it('AS-6: スポットを全部閉鎖（live）すると、スポットの回転数が 0 で、空港全体の能力が 0 になり、制約は stand', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    addContract(company, { airlineId: 'AQ', destinationId: 'KTA', typeId: 'narrow180', perDay: 3, window: 'morning', feeDiscount: 0, startDay: company.day, endDay: company.day, status: 'active', offerExpiresDay: company.day });
    const ctx = createContext(layout);
    const all = Object.values(ctx.stands).map((s) => s.id);
    const r = analyzeAirportCapacity(company, ctx, [], undefined, undefined, { closedRunwayIds: [], closedStandIds: all });
    expect(r.overall).toEqual({ capacity: 0, limitedBy: 'stand' });
  });

  it('AC-1: 空港アクセス（合計）は、使える手段の能力の合計。能力が算出できない手段（自家用車・送迎・徒歩）が 1 つでもあれば未算出で、根拠に手段名が出る', () => {
    const layout = createStarterAirfield();
    const company = createCareerCompany();
    const ctx = createContext(layout);
    const r = analyzeAirportCapacity(company, ctx);
    const access = analyzeAccess(layout, { city: company.city, day: company.day });
    const usable = ACCESS_MODES.filter((m) => access.modes[m].available);
    const hasNull = usable.some((m) => access.modes[m].capacityPerHour === null);
    const total = metricOf(r, '空港アクセス（合計）');
    const day = metricOf(r, '空港アクセス（合計・1日）');
    if (hasNull || usable.length === 0) {
      expect(total.capacity).toBeNull();
      expect(day.capacity).toBeNull();
      expect(total.status).toBe('uncomputed');
    } else {
      expect(total.capacity).toBe(usable.reduce((s, m) => s + (access.modes[m].capacityPerHour ?? 0), 0));
      expect(day.capacity).toBe(total.capacity! * r.operatingHours);
    }
    if (hasNull && usable.length > 0) expect(total.basis).toMatch(/自家用車|送迎|徒歩|タクシー|バス|鉄道/);
  });

  it('AC-2: 出入口・車寄せ・駐車場・バス乗り場・タクシー乗り場の行があり、需要・実績は未算出', () => {
    const r = analyzeAirportCapacity(createCareerCompany(), createContext(createStarterAirfield()));
    const kinds = new Set(r.facilities.map((f) => f.kind));
    expect(kinds.has('出入口')).toBe(true);
    expect(kinds.has('車寄せ')).toBe(true);
    for (const f of r.facilities.filter((x) => ['出入口', '車寄せ', '駐車場', 'バス乗り場', 'タクシー乗り場'].includes(x.kind))) {
      expect(f.demand).toBeNull();
      expect(f.status).toBe('uncomputed');
      expect(f.basis).toContain('未算出');
    }
  });

  it('HB-7: ターミナル間通路の能力が未設定なら、運航で使う既定値を表示し、根拠に「未設定（既定値 N 人/時）」と書く。明示値はそのまま', () => {
    const layout = structuredClone(createStarterAirfield());
    const [a1] = Object.values(layout.terminalAreas);
    const link = { id: 'lnk_t1', name: '', kind: 'walkway', fromAreaId: a1!.id, toAreaId: a1!.id, bidirectional: true, travelSec: 60, distanceM: 100, allowedZones: ['departure'], buildState: 'operational', widthM: 4 };
    (layout.terminalLinks ??= {})['lnk_t1'] = link as never;
    const company = createCareerCompany();
    const unset = analyzeAirportCapacity(company, createContext(layout)).facilities.find((f) => f.id === 'lnk_t1')!;
    expect(unset.capacity).toBe(terminalLinkCapacityPerHour(link));
    expect(unset.capacity).toBe(800); // 幅 4 m × 200 人/時
    expect(unset.basis).toContain('明示容量は未設定（運航では既定値 800 人/時を使用）');
    (layout.terminalLinks!['lnk_t1'] as { capacityPerHour?: number }).capacityPerHour = 300;
    const set = analyzeAirportCapacity(company, createContext(layout)).facilities.find((f) => f.id === 'lnk_t1')!;
    expect(set.capacity).toBe(300);
    expect(set.basis).toContain('明示容量 300 人/時');
  });

  it('1-20: 折り返し能力の根拠・値: トーイングカー 0 なら地上支援・折り返しの能力は 0', () => {
    const layout = structuredClone(createStarterAirfield());
    const base = Object.values(layout.facilities).find((f) => f.kind === 'gseBase')!;
    const company = createCareerCompany();
    const before = metricOf(analyzeAirportCapacity(company, createContext(layout)), '地上支援・折り返し').capacity;
    base.props.tugs = 0;
    const after = metricOf(analyzeAirportCapacity(company, createContext(layout)), '地上支援・折り返し').capacity;
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(0);
  });
});
