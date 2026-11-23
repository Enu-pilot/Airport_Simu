import { describe, expect, it } from 'vitest';
import { addTerminalTransitLink, placeFacility, placeTerminalArea } from '../../src/core/layout/operations';
import { advanceProjects, applyCompletedProjects, prepareCareerEdit, syncProjects } from '../../src/core/economy/expansion';
import { createCareerCompany } from '../../src/core/economy/company';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { classifyPaxConnection } from '../../src/core/terminal/route';
import { emptyLayout, must } from './helpers';

/**
 * 5-13 T4: ターミナル間連絡設備を建設プロジェクト管理へ接続する。
 * キャリアモードで新設したリンクは建設中になり、工期（道路と同じ1日）が終わるまで
 * 現在経路に入らず、完成後に初めて通行可能になる。3状態判定もそれに追随する。
 */
function twoTerminals() {
  let layout = emptyLayout(80, 60);
  const p1 = must(placeFacility(layout, 'terminal', { x: 2, y: 2 }, { name: 'A' }));
  layout = p1.layout;
  const t1 = p1.created[0]!;
  layout = must(placeFacility(layout, 'terminal', { x: 35, y: 2 }, { name: 'B' })).layout;
  const t2 = Object.values(layout.facilities).find((f) => f.name === 'B')!.id;
  const pa = must(placeTerminalArea(layout, t1, 0, 'departureLobby', { x: 2, y: 2 }));
  layout = pa.layout;
  layout = must(placeTerminalArea(layout, t2, 0, 'departureLobby', { x: 35, y: 2 })).layout;
  const a2 = Object.values(layout.terminalAreas).find((a) => a.terminalId === t2)!.id;
  return { layout, a1: pa.created[0]!, a2 };
}

describe('5-13 T4 連絡設備の建設プロジェクト連携', () => {
  it('キャリアモードの新設リンクは建設中→プロジェクト登録→完成で運用中になり、判定が追随する', () => {
    const { layout: base, a1, a2 } = twoTerminals();
    const withLink = must(addTerminalTransitLink(base, {
      kind: 'walkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      bidirectional: true, allowedZones: ['departure'],
    })).layout;
    const linkId = Object.keys(withLink.terminalLinks!)[0]!;

    const company = createCareerCompany();
    const edited = prepareCareerEdit(company, base, withLink);
    expect(edited.terminalLinks![linkId]!.buildState).toBe('underConstruction');
    syncProjects(company, edited);
    expect(company.projects[linkId]).toBeDefined();

    const q = { from: a1, goals: new Map([[a2, 0]]) };
    const during = classifyPaxConnection(
      buildTerminalModel(edited),
      buildTerminalModel(edited, { includeUnderConstruction: true }),
      q,
    );
    expect(during.status).toBe('underConstruction');

    advanceProjects(company);
    const completed = applyCompletedProjects(company, edited);
    expect(completed).not.toBeNull();
    expect(completed!.terminalLinks![linkId]!.buildState).toBe('operational');
    const after = classifyPaxConnection(
      buildTerminalModel(completed!),
      buildTerminalModel(completed!, { includeUnderConstruction: true }),
      q,
    );
    expect(after.status).toBe('operational');
  });

  it('サンドボックスではリンクは即時運用中のまま（従来どおり）', () => {
    const { layout: base, a1, a2 } = twoTerminals();
    const withLink = must(addTerminalTransitLink(base, {
      kind: 'walkway', fromAreaId: a1, toAreaId: a2, distanceM: 100, travelSec: 60,
      bidirectional: true, allowedZones: ['departure'],
    })).layout;
    const linkId = Object.keys(withLink.terminalLinks!)[0]!;
    expect(withLink.terminalLinks![linkId]!.buildState).toBe('operational');
    void base;
  });
});
