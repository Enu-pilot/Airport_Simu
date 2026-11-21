import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { placeFacility, placeStand } from '../../src/core/layout/operations';
import { createSandboxCompany } from '../../src/core/economy/company';
import { addDisruption } from '../../src/core/sim/disruptions';
import { createSimulation } from '../../src/core/sim/simulation';
import { deriveAlerts, opsInboxAttention, partitionAlerts, LAYOUT_STRUCTURE_SUMMARY_KEY } from '../../src/ui/operate/alerts';
import { emptyLayout, must } from './helpers';

/**
 * 運航アラートの配置サマリ: 静的な配置検証（スポット未接続・ターミナル内動線など）は
 * 運航中は変更できないため個別には出さず、件数だけを注意1件に集約する（ユーザ承認の方針）。
 */
describe('運航アラート: 配置の問題サマリ', () => {
  const withDisconnectedStands = (extra: { x: number; y: number }[]) => {
    let layout = createSampleAirport();
    for (const at of extra) layout = must(placeStand(layout, at, 'M')).layout;
    return layout;
  };

  it('静的問題があると個別アラートは出ず、サマリ1件（注意・件数つき）だけが出る', () => {
    const layout = withDisconnectedStands([{ x: 10, y: 10 }]);
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const r = deriveAlerts(sim, sim.company);
    expect(r.alerts.some((a) => a.key.startsWith('paxStructure:'))).toBe(false);
    expect(r.alerts.some((a) => a.key.startsWith('airsideStructure:'))).toBe(false);
    const summaries = r.alerts.filter((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      severity: 'warning',
      title: '配置の問題 1件（建設モードで確認）',
      count: 1,
      target: { kind: 'none', id: null },
    });
    // 重大（スタック）には入らず、注意（インボックス）側に入る
    const parts = partitionAlerts(r.alerts);
    expect(parts.stack.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(false);
    expect(parts.inbox.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(true);
  });

  it('件数は静的問題の数と一致する（スポット2つ未接続で2件）', () => {
    const layout = withDisconnectedStands([{ x: 10, y: 10 }, { x: 30, y: 10 }]);
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const r = deriveAlerts(sim, sim.company);
    const summaries = r.alerts.filter((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY);
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.title).toBe('配置の問題 2件（建設モードで確認）');
    expect(summaries[0]!.count).toBe(2);
  });

  it('ターミナル側の静的問題も同じサマリに集約される', () => {
    let layout = emptyLayout(80, 60);
    layout = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { name: 'Terminal A' })).layout;
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const r = deriveAlerts(sim, sim.company);
    expect(r.alerts.some((a) => a.key.startsWith('paxStructure:'))).toBe(false);
    const summary = r.alerts.find((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY);
    expect(summary).toBeDefined();
    expect(summary!.severity).toBe('warning');
    const n = Number(summary!.title.match(/配置の問題 (\d+)件/)?.[1]);
    expect(n).toBeGreaterThan(0);
    expect(summary!.count).toBe(n);
  });

  it('静的問題が無いレイアウトではサマリも出ない', () => {
    const sim = createSimulation(createSampleAirport(), { company: createSandboxCompany() });
    const r = deriveAlerts(sim, sim.company);
    expect(r.alerts.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(false);
    expect(r.keys).not.toContain(LAYOUT_STRUCTURE_SUMMARY_KEY);
  });

  it('動的アラート（障害）は従来どおり出て、サマリと共存する', () => {
    const layout = withDisconnectedStands([{ x: 10, y: 10 }]);
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const rwy = Object.keys(sim.ctx.layout.runways)[0]!;
    addDisruption(sim, { kind: 'runwayClosed', targetId: rwy, end: null });
    const r = deriveAlerts(sim, sim.company);
    const disruption = r.alerts.find((a) => a.key === `disruption:runwayClosed:${rwy}`);
    expect(disruption).toMatchObject({ severity: 'critical' });
    expect(r.alerts.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(true);
    const parts = partitionAlerts(r.alerts);
    expect(parts.stack.map((a) => a.key)).toContain(`disruption:runwayClosed:${rwy}`);
    expect(parts.stack.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(false);
  });

  it('サマリは他のアラートと同じく dismiss でき、keys には残る', () => {
    const layout = withDisconnectedStands([{ x: 10, y: 10 }]);
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const dismissed = deriveAlerts(sim, sim.company, [LAYOUT_STRUCTURE_SUMMARY_KEY]);
    expect(dismissed.alerts.some((a) => a.key === LAYOUT_STRUCTURE_SUMMARY_KEY)).toBe(false);
    expect(dismissed.keys).toContain(LAYOUT_STRUCTURE_SUMMARY_KEY);
  });

  it('インボックスへは件数を count に載せて渡る（対象なし）', () => {
    const layout = withDisconnectedStands([{ x: 10, y: 10 }, { x: 30, y: 10 }]);
    const sim = createSimulation(layout, { company: createSandboxCompany() });
    const items = opsInboxAttention(deriveAlerts(sim, sim.company).alerts);
    const item = items.find((i) => i.key === LAYOUT_STRUCTURE_SUMMARY_KEY);
    expect(item).toMatchObject({ title: '配置の問題 2件（建設モードで確認）', count: 2, targetId: null });
  });
});
