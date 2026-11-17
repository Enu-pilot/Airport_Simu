import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { analyzeLayout, intlLockedIssues } from '../../src/core/validation/validate';
import { createSandboxCompany } from '../../src/core/economy/company';
import { intlAirport, intlGateId } from './intlLayout';

const codesFor = (l: ReturnType<typeof intlAirport>, target: string) =>
  (analyzeLayout(l).byTarget[target] ?? []).map((i) => i.code);
const allCodes = (l: ReturnType<typeof intlAirport>) => analyzeLayout(l).issues.map((i) => i.code);

describe('国際まわりの検証（フェーズ 4 §4.2）', () => {
  it('正しくつながった国際ウィングには INTL 系の指摘がない', () => {
    const l = intlAirport();
    const codes = allCodes(l);
    expect(codes).not.toContain('INTL_EMIGRATION_UNLINKED');
    expect(codes).not.toContain('INTL_IMMIGRATION_UNLINKED');
    expect(codes).not.toContain('INTL_CUSTOMS_UNLINKED');
    expect(codes).not.toContain('INTL_GATE_ZONE');
    expect(codes).not.toContain('SWING_GATE_ZONE');
  });

  it('出国審査が国際出発区域に接していないと INTL_EMIGRATION_UNLINKED', () => {
    const l = intlAirport();
    // 国際ホールを消すと、出国審査は国内側にしか接しなくなる
    delete l.terminalAreas['ta_i2'];
    delete l.terminalAreas['ta_i1'];
    expect(codesFor(l, 'ta_i3')).toContain('INTL_EMIGRATION_UNLINKED');
  });

  it('入国審査が到着区域に接していないと INTL_IMMIGRATION_UNLINKED', () => {
    const l = intlAirport();
    // 入国審査をターミナルの隅へ動かす（周囲は一般区域と国際到着ホールだけになる位置ではない、孤立させる）
    l.terminalAreas['ta_i6']!.origin = { x: 46, y: 55 };
    expect(codesFor(l, 'ta_i6')).toContain('INTL_IMMIGRATION_UNLINKED');
  });

  it('税関が両側に接していないと INTL_CUSTOMS_UNLINKED', () => {
    const l = intlAirport();
    l.terminalAreas['ta_i8']!.origin = { x: 46, y: 55 };
    expect(codesFor(l, 'ta_i8')).toContain('INTL_CUSTOMS_UNLINKED');
  });

  it('国際ゲートが国際区域に接していないと INTL_GATE_ZONE、兼用なら SWING_GATE_ZONE', () => {
    const l = intlAirport();
    const domestic = Object.values(l.facilities).find((f) => f.kind === 'gate' && f.props.standId === 'std_1')!;
    domestic.props.routeType = 'international';
    expect(codesFor(l, domestic.id)).toContain('INTL_GATE_ZONE');
    domestic.props.routeType = 'swing';
    expect(codesFor(l, domestic.id)).toContain('SWING_GATE_ZONE');
    expect(codesFor(l, intlGateId(l))).not.toContain('INTL_GATE_ZONE');
  });

  it('国際の設備があるのに機能が無効なら INTL_LOCKED（会社が要る別枠の検査）', () => {
    const l = intlAirport();
    const locked = createSandboxCompany('intl-locked');
    expect(intlLockedIssues(l, locked).map((i) => i.code)).toEqual(['INTL_LOCKED']);
    const enabled = createSandboxCompany('intl-enabled');
    enabled.features = { international: true };
    expect(intlLockedIssues(l, enabled)).toEqual([]);
    // 国際の設備がなければ会社が無効でも出ない
    expect(intlLockedIssues(createSampleAirport(), locked)).toEqual([]);
    expect(intlLockedIssues(l, null)).toEqual([]);
  });
});
