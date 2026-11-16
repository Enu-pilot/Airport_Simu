/**
 * 1-11 / K-1（U 側: データ・検証・保存）と Z-1（updateEntity の stand の検証項目）。
 * 決定規則・運航は S の tests/unit/sim/standTerminal.test.ts。
 */
import { describe, expect, it } from 'vitest';
import { busTwoTerminalLayout } from '../../audit/b_helpers';
import { createSandboxCompany } from '../../../src/core/economy/company';
import { buildProject, formatVersionOf, layoutUsesFormat2, serializeProject, validateProject } from '../../../src/core/io/project';
import { deleteEntity, updateEntity } from '../../../src/core/layout/operations';
import type { AirportLayout } from '../../../src/core/model/types';
import { issueText } from '../../../src/i18n/ja';
import { analyzeLayout } from '../../../src/core/validation/validate';
import { must } from '../helpers';

const { layout: base, t1, t2 } = busTwoTerminalLayout();
const codes = (l: AirportLayout, prefix = 'STAND_TERMINAL') => analyzeLayout(l).issues.filter((i) => i.code.startsWith(prefix));
const patch = (l: AirportLayout, id: string, p: Record<string, unknown>) => updateEntity(l, id, p);
const NOW = '2026-11-16T00:00:00Z';
const build = (l: AirportLayout) => buildProject({ name: 't', savedAt: NOW, layout: l, company: createSandboxCompany(), pin: null, scenarios: [], sim: null });
const opts = { fallbackCompany: createSandboxCompany() };

describe('Z-1: updateEntity の stand の検証項目', () => {
  it('remoteBoarding・busGateId・terminalId を変更できる（修正前は必ず INVALID_VALUE だった）', () => {
    let l = must(patch(base, 'std_8', { remoteBoarding: 'bus' })).layout;
    expect(l.stands.std_8!.remoteBoarding).toBe('bus');
    l = must(patch(l, 'std_8', { busGateId: 'fac_10' })).layout;
    expect(l.stands.std_8!.busGateId).toBe('fac_10');
    l = must(patch(l, 'std_8', { busGateId: null })).layout;
    expect(l.stands.std_8!.busGateId).toBeNull();
    l = must(patch(l, 'std_8', { remoteBoarding: 'none' })).layout;
    l = must(patch(l, 'std_8', { remoteBoarding: 'auto' })).layout;
    expect(l.stands.std_8!.remoteBoarding).toBe('auto');
  });
  it('異常系: 不正な値は INVALID_VALUE（元のレイアウトは変わらない）', () => {
    const before = JSON.stringify(base);
    for (const p of [
      { remoteBoarding: 'x' },
      { remoteBoarding: null },
      { busGateId: 'fac_2' }, // ターミナル
      { busGateId: 'fac_3' }, // コンタクトゲート
      { busGateId: 'nope' },
      { busGateId: 5 },
      { terminalId: 'fac_10' }, // ゲート
      { terminalId: 'nope' },
      { terminalId: 7 },
    ]) {
      expect(patch(base, 'std_8', p), JSON.stringify(p)).toEqual({ ok: false, reason: 'INVALID_VALUE' });
    }
    expect(JSON.stringify(base)).toBe(before);
  });
  it('terminalId: ターミナルを設定でき、null でキーを削除する（null は保存しない）', () => {
    let l = must(patch(base, 'std_8', { terminalId: t2 })).layout;
    expect(l.stands.std_8!.terminalId).toBe(t2);
    l = must(patch(l, 'std_8', { terminalId: null })).layout;
    expect('terminalId' in l.stands.std_8!).toBe(false);
    expect(JSON.stringify(l)).not.toContain('"terminalId":null');
  });
  it('回転と同時の更新でも検証される', () => {
    expect(patch(base, 'std_8', { rotation: 90, terminalId: 'nope' })).toEqual({ ok: false, reason: 'INVALID_VALUE' });
  });
});

describe('finalize: 削除したターミナルを指す terminalId は掃除される', () => {
  it('terminalId のターミナルを削除するとキーが消える。別のスポットは不変', () => {
    let l = must(patch(base, 'std_8', { terminalId: t2 })).layout;
    l = must(patch(l, 'std_9', { terminalId: t1 })).layout;
    const r = deleteEntity(l, t2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect('terminalId' in r.layout.stands.std_8!).toBe(false);
    expect(r.layout.stands.std_9!.terminalId).toBe(t1);
  });
});

describe('検証コード 4 種', () => {
  it('terminalId なしの旧レイアウト: 新しいコードは出ない', () => {
    expect(codes(base)).toEqual([]);
  });
  it('正常系: auto + 所属ターミナルにバスゲートがある → 問題なし。ターミナルが違っても所属側にゲートがあれば OK', () => {
    for (const t of [t1, t2]) {
      const l = must(patch(base, 'std_8', { remoteBoarding: 'auto', terminalId: t })).layout;
      expect(codes(l, 'STAND_').map((i) => i.code).filter((c) => c.startsWith('STAND_TERMINAL') || c === 'STAND_BUS_NO_GATE'), t).toEqual([]);
    }
  });
  it('STAND_TERMINAL_INVALID（error）: 施設がない・ターミナルでない（読み込んだデータを想定）', () => {
    for (const bad of ['nope', 'fac_10']) {
      const l = structuredClone(base);
      l.stands.std_8!.terminalId = bad;
      const issues = codes(l);
      const hit = issues.find((i) => i.code === 'STAND_TERMINAL_INVALID')!;
      expect(hit.severity).toBe('error');
      expect(hit.targets).toEqual(['std_8']);
      expect(issueText(l, hit)).toContain('所属ターミナルが見つからないか、ターミナルではありません');
    }
  });
  it('STAND_TERMINAL_NO_BUS_GATE（error）: そのターミナルに使えるバスゲートがない（別のターミナルには移さない）', () => {
    // fac_10（ターミナル A のバスゲート）を計画中にすると、A には使えるゲートがなくなる（B の fac_11 だけ）
    let l = must(patch(base, 'fac_10', { buildState: 'planned' })).layout;
    l = must(patch(l, 'std_8', { terminalId: t1 })).layout;
    const issues = codes(l);
    const hit = issues.find((i) => i.code === 'STAND_TERMINAL_NO_BUS_GATE')!;
    expect(hit.severity).toBe('error');
    expect(hit.targets).toEqual(['std_8']);
    expect(hit.related).toEqual([t1]);
    expect(issueText(l, hit)).toMatch(/所属ターミナル .+ に、搭乗口・降機口の両方へ接続した使えるバスゲートがありません/);
    // 同じスポットで terminalId を外すと、従来どおり B のゲートが使える（エラーなし）
    const free = must(patch(l, 'std_8', { terminalId: null })).layout;
    expect(analyzeLayout(free).issues.filter((i) => i.targets.includes('std_8') && i.severity === 'error')).toEqual([]);
  });
  it('STAND_TERMINAL_MISMATCH（error）: bus の busGateId の所属が terminalId と異なる', () => {
    let l = must(patch(base, 'std_8', { remoteBoarding: 'bus', busGateId: 'fac_10', terminalId: t2 })).layout;
    const hit = codes(l).find((i) => i.code === 'STAND_TERMINAL_MISMATCH')!;
    expect(hit.severity).toBe('error');
    expect(hit.targets).toEqual(['std_8', 'fac_10']);
    expect(issueText(l, hit)).toContain('は所属ターミナルと別のターミナルにあります');
    // 一致させればエラーなし
    l = must(patch(l, 'std_8', { terminalId: t1 })).layout;
    expect(codes(l)).toEqual([]);
    // 所属未設定は従来どおり
    l = must(patch(l, 'std_8', { terminalId: null })).layout;
    expect(codes(l)).toEqual([]);
  });
  it('STAND_TERMINAL_IGNORED（info）: 固定スポット、または none に terminalId がある', () => {
    let l = must(patch(base, 'std_1', { terminalId: t1 })).layout; // コンタクトゲート付き
    l = must(patch(l, 'std_8', { remoteBoarding: 'none', terminalId: t2 })).layout;
    const hits = codes(l).filter((i) => i.code === 'STAND_TERMINAL_IGNORED');
    expect(hits.map((i) => i.targets[0]).sort()).toEqual(['std_1', 'std_8']);
    expect(hits.every((i) => i.severity === 'info')).toBe(true);
    expect(hits.map((i) => issueText(l, i)).join('|')).toMatch(/固定スポット.*バス不使用|バス不使用.*固定スポット/);
    // info なので error は増えない
    expect(analyzeLayout(l).issues.filter((i) => i.severity === 'error').map((i) => i.code)).toEqual(analyzeLayout(base).issues.filter((i) => i.severity === 'error').map((i) => i.code));
  });
});

describe('保存・復元', () => {
  it('terminalId を持つレイアウトは版 2 で往復でき、キーが保たれる。繰り返しても同一', () => {
    const l = must(patch(base, 'std_8', { terminalId: t2 })).layout;
    expect(layoutUsesFormat2(l)).toBe(true);
    const p = build(l);
    expect(formatVersionOf(p)).toBe(2);
    const json = serializeProject(p);
    const r = validateProject(json, opts);
    expect(r.errors).toEqual([]);
    expect(r.project!.layout.stands.std_8!.terminalId).toBe(t2);
    expect(r.project!.formatVersion).toBe(2);
    const again = validateProject(serializeProject(r.project!), opts);
    expect(again.errors).toEqual([]);
    expect(again.project!.layout.stands).toEqual(r.project!.layout.stands);
    expect(again.project!.layout.stands.std_8!.terminalId).toBe(t2);
    expect(again.project!.formatVersion).toBe(2);
  });
  it('terminalId のない旧形式は、従来の版・内容のまま（キーが増えない）', () => {
    const json = serializeProject(build(base));
    expect(Object.values(JSON.parse(json).layout.stands).some((st) => 'terminalId' in (st as object))).toBe(false);
    const r = validateProject(json, opts);
    expect(r.errors).toEqual([]);
    expect('terminalId' in r.project!.layout.stands.std_8!).toBe(false);
  });
  it('不正な terminalId（存在しない・ターミナルでない・文字列でない）は読み込みエラー', () => {
    for (const bad of ['nope', 'fac_10', 5]) {
      const p = build(base);
      (p.layout.stands.std_8 as unknown as { terminalId: unknown }).terminalId = bad;
      const r = validateProject(JSON.stringify(p), opts);
      expect(r.ok, String(bad)).toBe(false);
      expect(r.errors.join('\n')).toContain('スポット std_8 の所属ターミナル（terminalId）が不正です');
    }
  });
});
