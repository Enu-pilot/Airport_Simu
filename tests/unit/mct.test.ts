import { describe, expect, it } from 'vitest';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { buildTerminalModel } from '../../src/core/terminal/model';
import { analyzeHub } from '../../src/core/terminal/hub';
import { domTransferAirport, transferAirport } from './transferLayout';
import { intlAirport } from './intlLayout';

describe('MCT 解析（フェーズ 4 §5.2）', () => {
  it('乗継保安検査が無い空港では DD の MCT は null（接続不可）', () => {
    const l = createSampleAirport();
    const hub = analyzeHub(l, buildTerminalModel(l));
    expect(hub.mct.DD).toBeNull();
    expect(hub.byKind.DD.pairs).toBe(0);
  });

  it('乗継設備がある空港では DD の MCT が決まり、同じ入力では決定的', () => {
    const l = domTransferAirport();
    const m = buildTerminalModel(l);
    const a = analyzeHub(l, m);
    const b = analyzeHub(l, m);
    expect(a).toBe(b); // モデルごとにキャッシュされる
    expect(a.mct.DD).not.toBeNull();
    expect(a.mct.DD!).toBeGreaterThanOrEqual(1800); // 下限 30 分
    expect(a.byKind.DD.pairs).toBeGreaterThan(0);
    expect(a.byKind.DD.median).not.toBeNull();
    // 国際の審査設備が無いので DI / ID / II は接続不可
    expect(a.mct.DI).toBeNull();
    expect(a.mct.ID).toBeNull();
    expect(a.mct.II).toBeNull();
  });

  it('国際ウィング付きでは DI / ID の MCT も決まる', () => {
    const l = transferAirport();
    const hub = analyzeHub(l, buildTerminalModel(l));
    expect(hub.mct.DD).not.toBeNull();
    expect(hub.mct.DI).not.toBeNull();
    expect(hub.mct.ID).not.toBeNull();
  });

  it('国際ウィングだけ（乗継保安検査なし）では全種類 null', () => {
    const l = intlAirport();
    const hub = analyzeHub(l, buildTerminalModel(l));
    expect(hub.mct.DD).toBeNull();
    expect(hub.mct.DI).toBeNull();
    expect(hub.mct.ID).toBeNull();
    expect(hub.mct.II).toBeNull();
  });

  it('ゲートの組ごとの MCT があり、空港の MCT はその最大と一致する', () => {
    const l = domTransferAirport();
    const hub = analyzeHub(l, buildTerminalModel(l));
    const pairValues = [...hub.pairMct.entries()].filter(([k]) => k.endsWith(':DD')).map(([, v]) => v);
    expect(pairValues.length).toBeGreaterThan(0);
    expect(Math.max(...pairValues)).toBe(hub.mct.DD);
    for (const v of pairValues) expect(v % 300).toBe(0); // 5 分刻み
  });
});
