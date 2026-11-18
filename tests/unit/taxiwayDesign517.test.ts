import { describe, expect, it } from 'vitest';
import {
  FAA_TDG_PAVEMENT_WIDTH_M,
  EASA_OMGWS_BANDS,
  assessTaxiwayWidth,
  requiredPavementWidthM,
} from '../../src/core/airside/taxiwayDesign';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import { exportLayout, importLayout } from '../../src/core/io/serialize';

/**
 * 5-17 T1/T3: FAA TDG と EASA OMGWS の表を混ぜず、旧エッジは legacy のまま変えない。
 * 機体 OMGWS が未確認のときは通行可否を推測しない。
 */
describe('5-17 誘導路の実寸設計プロファイル', () => {
  it('FAA TDG の舗装幅表が計画どおりで、EASA の表と混ざっていない', () => {
    expect(FAA_TDG_PAVEMENT_WIDTH_M).toEqual({
      '1A': 7.6, '1B': 7.6, '2A': 10.7, '2B': 10.7, '3': 15.2, '4': 15.2, '5': 22.9, '6': 22.9,
    });
    expect(EASA_OMGWS_BANDS.map((b) => b.pavementWidthM)).toEqual([7.5, 10.5, 15, 23]);
    expect(requiredPavementWidthM('faa-tdg', { designGroup: '5' })).toBe(22.9);
    expect(requiredPavementWidthM('faa-tdg', { designGroup: '9' })).toBeNull();
    expect(requiredPavementWidthM('faa-tdg', {})).toBeNull();
  });

  it('EASA は OMGWS バンドで引き、範囲外は推測しない', () => {
    expect(requiredPavementWidthM('easa-omgws', { omgwsM: 4.4 })).toBe(7.5);
    expect(requiredPavementWidthM('easa-omgws', { omgwsM: 4.5 })).toBe(10.5);
    expect(requiredPavementWidthM('easa-omgws', { omgwsM: 8.9 })).toBe(15);
    expect(requiredPavementWidthM('easa-omgws', { omgwsM: 15 })).toBeNull();
    expect(requiredPavementWidthM('legacy-game', { omgwsM: 5 })).toBeNull();
  });

  it('適合判定: legacy / unknown / sufficient / insufficient を区別する', () => {
    expect(assessTaxiwayWidth({}, 8)).toBe('legacy');
    expect(assessTaxiwayWidth({ pavementWidthM: 15, designProfile: 'easa-omgws' }, undefined)).toBe('unknown');
    expect(assessTaxiwayWidth({ pavementWidthM: 15, designProfile: 'easa-omgws' }, 8)).toBe('sufficient');
    expect(assessTaxiwayWidth({ pavementWidthM: 10.5, designProfile: 'easa-omgws' }, 8)).toBe('insufficient');
    expect(assessTaxiwayWidth({ pavementWidthM: 23, designProfile: 'faa-tdg', designGroup: '5' }, 10)).toBe('sufficient');
    expect(assessTaxiwayWidth({ pavementWidthM: 23, designProfile: 'faa-tdg' }, 10)).toBe('unknown');
  });

  it('新フィールドは保存・復元で往復し、未設定の旧エッジは legacy のまま', () => {
    const l = createSampleAirport();
    const edge = Object.values(l.taxiways)[0]!;
    expect(assessTaxiwayWidth(edge, 8)).toBe('legacy');
    edge.pavementWidthM = 18;
    edge.designProfile = 'easa-omgws';
    edge.role = 'rapidExit';
    const restored = importLayout(exportLayout(l));
    const e2 = Object.values(restored.taxiways)[0]!;
    expect(e2.pavementWidthM).toBe(18);
    expect(e2.designProfile).toBe('easa-omgws');
    expect(e2.role).toBe('rapidExit');
  });
});
