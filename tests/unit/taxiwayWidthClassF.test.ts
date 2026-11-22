import { describe, expect, it } from 'vitest';
import { checkTaxiway } from '../../src/core/aircraft/compat';
import { buildAirsideNetwork, canAircraftUse } from '../../src/core/airside/network';
import { layoutItems } from '../../src/core/economy/construction';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import { addTaxiwayPath, updateEntity } from '../../src/core/layout/operations';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';
import {
  TAXIWAY_WIDTH_ORDER,
  requiredTaxiwayWidth,
  taxiwayWidthAtLeast,
  taxiwayWidthCap,
  type AirportLayout,
  type TaxiwayEdge,
  type TaxiwayWidthClass,
} from '../../src/core/model/types';
import { AIRCRAFT_TYPES } from '../../src/core/sim/aircraftTypes';
import { sizeOptionForTool, taxiwayWidthForKey } from '../../src/editor/shortcuts';
import { emptyLayout, must } from './helpers';

/**
 * 2026-CF: 誘導路幅の F 区分（コード F の独立区分化）。
 * - F は第4の幅区分で、ネットワーク導出では (maxSize 'L', codeF true) と等価
 * - 旧表現（widthClass 'L' ＋ codeF）は読み込み時に 'F' へ読み替える
 * - F キーは誘導路ツールで F 区分そのものを選ぶ（スポット・滑走路では従来どおり最大の別名）
 */

const edge = (widthClass: TaxiwayWidthClass): TaxiwayEdge => ({
  id: 'twy_1',
  from: 'tn_1',
  to: 'tn_2',
  name: '',
  widthClass,
  oneWay: false,
  buildState: 'operational',
});

const a380 = AIRCRAFT_TYPES['A380-800']!; // L ＋ コード F
const b777 = AIRCRAFT_TYPES['B777-300ER']!; // L（コード F ではない）
const narrow = AIRCRAFT_TYPES.narrow180!; // M

describe('幅区分の順序と換算', () => {
  it('順序は S < M < L < F で、F は機体区分の物差しでは L に丸まる', () => {
    expect(TAXIWAY_WIDTH_ORDER).toEqual({ S: 1, M: 2, L: 3, F: 4 });
    expect(taxiwayWidthAtLeast('F', 'L')).toBe(true);
    expect(taxiwayWidthAtLeast('L', 'F')).toBe(false);
    expect(taxiwayWidthAtLeast('M', 'M')).toBe(true);
    expect(taxiwayWidthCap('F')).toBe('L');
    expect(taxiwayWidthCap('M')).toBe('M');
  });

  it('機体が要求する幅区分: コード F 機は F、それ以外は自区分', () => {
    expect(requiredTaxiwayWidth('L', true)).toBe('F');
    expect(requiredTaxiwayWidth('L', false)).toBe('L');
    expect(requiredTaxiwayWidth('M', false)).toBe('M');
    expect(a380.codeF).toBe(true);
    expect(b777.codeF).toBe(false);
  });
});

describe('適合判定（checkTaxiway）の境界', () => {
  it('コード F 機（A380）は F 幅でのみ ok。L 幅は TAXIWAY_CODE_F、M 幅は区分不足も付く', () => {
    expect(checkTaxiway(a380, edge('F'))).toEqual({ id: 'twy_1', status: 'ok', reasons: [] });
    expect(checkTaxiway(a380, edge('L'))).toEqual({ id: 'twy_1', status: 'ng', reasons: ['TAXIWAY_CODE_F'] });
    expect(checkTaxiway(a380, edge('M'))).toEqual({ id: 'twy_1', status: 'ng', reasons: ['TAXIWAY_CLASS', 'TAXIWAY_CODE_F'] });
  });

  it('L 機（コード F でない）は F 幅も L 幅も使え、M 幅は区分不足', () => {
    expect(checkTaxiway(b777, edge('F')).status).toBe('ok');
    expect(checkTaxiway(b777, edge('L')).status).toBe('ok');
    expect(checkTaxiway(b777, edge('M'))).toEqual({ id: 'twy_1', status: 'ng', reasons: ['TAXIWAY_CLASS'] });
  });

  it('M 機は F 幅を使える', () => {
    expect(checkTaxiway(narrow, edge('F')).status).toBe('ok');
    expect(checkTaxiway(narrow, edge('S'))).toEqual({ id: 'twy_1', status: 'ng', reasons: ['TAXIWAY_CLASS'] });
  });
});

describe('配置と変更（operations）', () => {
  it('addTaxiwayPath で F 幅の誘導路を置け、ネットワークでは (L, codeF) として導出される', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 5, y: 5 }, { x: 20, y: 5 }], { widthClass: 'F' })).layout;
    const ids = Object.keys(l.taxiways);
    expect(ids).toHaveLength(1);
    expect(l.taxiways[ids[0]!]!.widthClass).toBe('F');
    const net = buildAirsideNetwork(l);
    const ne = net.edges[ids[0]!]!;
    expect(ne.maxSize).toBe('L');
    expect(ne.codeF).toBe(true);
    expect(canAircraftUse(ne, 'L', { codeF: true })).toBe(true);
    expect(canAircraftUse(ne, 'L')).toBe(true);
  });

  it('L 幅のネットワークエッジはコード F 機を通さない（従来どおり）', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 5, y: 5 }, { x: 20, y: 5 }], { widthClass: 'L' })).layout;
    const id = Object.keys(l.taxiways)[0]!;
    const ne = buildAirsideNetwork(l).edges[id]!;
    expect(ne.codeF).toBe(false);
    expect(canAircraftUse(ne, 'L', { codeF: true })).toBe(false);
  });

  it('updateEntity で幅を F に変更でき、誘導路への codeF 指定は廃止されたので拒否される', () => {
    let l = must(addTaxiwayPath(emptyLayout(), [{ x: 5, y: 5 }, { x: 20, y: 5 }], { widthClass: 'L' })).layout;
    const id = Object.keys(l.taxiways)[0]!;
    l = must(updateEntity(l, id, { widthClass: 'F' })).layout;
    expect(l.taxiways[id]!.widthClass).toBe('F');
    expect(updateEntity(l, id, { codeF: true }).ok).toBe(false);
  });

  it('スポットのサイズに F は指定できない（スポットは S/M/L ＋ codeF のまま）', () => {
    const l = createSampleAirport();
    const standId = Object.keys(l.stands)[0]!;
    expect(updateEntity(l, standId, { size: 'F' }).ok).toBe(false);
    expect(updateEntity(l, standId, { codeF: true }).ok).toBe(true);
  });

  it('F 幅の建設費はタイル単価 10,000 cr（区分ごとの +2,000 の延長）', () => {
    const l = must(addTaxiwayPath(emptyLayout(), [{ x: 5, y: 5 }, { x: 20, y: 5 }], { widthClass: 'F' })).layout;
    const id = Object.keys(l.taxiways)[0]!;
    expect(layoutItems(l)[id]).toBe(15 * 10_000);
  });
});

describe('旧セーブの読み替え（移行）', () => {
  /** サンプル空港の JSON に旧表現（L ＋ codeF）を書き込んだもの */
  function legacyJson(): { json: string; taxiwayId: string; standId: string } {
    const l = createSampleAirport();
    const taxiwayId = Object.keys(l.taxiways)[0]!;
    const standId = Object.values(l.stands).find((s) => s.size === 'L')!.id;
    const data = JSON.parse(exportLayout(l)) as { layout: AirportLayout };
    const twy = data.layout.taxiways[taxiwayId] as unknown as Record<string, unknown>;
    twy.widthClass = 'L';
    twy.codeF = true;
    (data.layout.stands[standId] as unknown as Record<string, unknown>).codeF = true;
    return { json: JSON.stringify(data), taxiwayId, standId };
  }

  it('L ＋ codeF の誘導路は F に読み替えられ、codeF は落ちる。スポットの codeF は残る', () => {
    const { json, taxiwayId, standId } = legacyJson();
    const l = importLayout(json);
    expect(l.taxiways[taxiwayId]!.widthClass).toBe('F');
    expect('codeF' in l.taxiways[taxiwayId]!).toBe(false);
    expect(l.stands[standId]!.size).toBe('L');
    expect(l.stands[standId]!.codeF).toBe(true);
    // ネットワーク導出は旧表現のときと同一（F = (L, codeF)）
    const ne = buildAirsideNetwork(l).edges[taxiwayId]!;
    expect(ne.maxSize).toBe('L');
    expect(ne.codeF).toBe(true);
  });

  it('読み替え後の保存・読込で F が往復する（codeF は書き戻されない）', () => {
    const { json, taxiwayId } = legacyJson();
    const once = importLayout(json);
    const twice = importLayout(exportLayout(once));
    expect(twice.taxiways[taxiwayId]!.widthClass).toBe('F');
    const saved = JSON.parse(exportLayout(once)) as { layout: AirportLayout };
    expect('codeF' in saved.layout.taxiways[taxiwayId]!).toBe(false);
  });

  it('codeF のない L 誘導路は読み替えない', () => {
    const l = createSampleAirport();
    const id = Object.keys(l.taxiways)[0]!;
    const restored = importLayout(exportLayout(l));
    expect(restored.taxiways[id]!.widthClass).toBe(l.taxiways[id]!.widthClass);
  });
});

describe('F キー（ショートカット）', () => {
  it('誘導路ツールでは S/M/L/F が 1 対 1 に対応する', () => {
    expect(taxiwayWidthForKey('s')).toBe('S');
    expect(taxiwayWidthForKey('m')).toBe('M');
    expect(taxiwayWidthForKey('l')).toBe('L');
    expect(taxiwayWidthForKey('f')).toBe('F');
    expect(sizeOptionForTool('taxiway', 'f')).toEqual({ option: 'taxiWidth', value: 'F' });
    expect(sizeOptionForTool('taxiway', 'l')).toEqual({ option: 'taxiWidth', value: 'L' });
  });

  it('スポット・滑走路では F は従来どおり最大段階の別名', () => {
    expect(sizeOptionForTool('stand', 'f')).toEqual({ option: 'standSize', value: 'L' });
    expect(sizeOptionForTool('runway', 'f')).toEqual({ option: 'runwayWidth', value: 60 });
  });
});
