import { describe, expect, it } from 'vitest';
import { CATALOG } from '../../src/core/data/index';
import {
  DESTINATION_DISPLAY_REGIONS,
  DESTINATION_DISPLAY_REGION_BY_ID,
  compareDestinationIdsByDisplayRegion,
  displayRegionOfDestination,
  sortDestinationIdsByDisplayRegion,
  sortDestinationsByDisplayRegion,
} from '../../src/core/data/destinationRegions';

/**
 * 就航都市の表示用地域順（2026-REGION、docs/42 §3.11）:
 * PO 指定の地方順に並ぶことと、対応表が全目的地を網羅することを固定する。
 * 表示専用の分類であり、既存 regionId・保存データ・シミュレーションには関与しない。
 */
describe('destinationRegionOrder: 表示用地域区分（2026-REGION）', () => {
  it('地域順の正本: 国内 11 地域が PO 指定順、海外は指定順＋挿入地域の順', () => {
    expect(DESTINATION_DISPLAY_REGIONS.map((r) => r.id)).toEqual([
      'hokkaido', 'tohoku', 'kanto', 'koshinetsu', 'hokuriku', 'tokai', 'kinki', 'chugoku', 'shikoku', 'kyushu', 'okinawa',
      'east-asia', 'southeast-asia', 'south-asia', 'central-asia', 'middle-east', 'europe', 'africa', 'north-america', 'central-america', 'south-america', 'oceania',
    ]);
    expect(DESTINATION_DISPLAY_REGIONS.map((r) => r.name)).toEqual([
      '北海道', '東北', '関東', '甲信越', '北陸', '東海', '近畿', '中国', '四国', '九州', '沖縄',
      '東アジア', '東南アジア', '南アジア', '中央アジア', '中東', 'ヨーロッパ', 'アフリカ', '北アメリカ', '中米・カリブ', '南アメリカ', 'オセアニア',
    ]);
    expect(DESTINATION_DISPLAY_REGIONS.filter((r) => r.scope === 'domestic')).toHaveLength(11);
    expect(DESTINATION_DISPLAY_REGIONS.filter((r) => r.scope === 'international')).toHaveLength(11);
  });

  it('網羅: 全目的地に表示用地域があり、対応表に実在しない目的地が混ざっていない', () => {
    for (const d of CATALOG.destinations) {
      expect(displayRegionOfDestination(d.id), d.id).toBeDefined();
    }
    const ids = new Set(CATALOG.destinations.map((d) => d.id));
    for (const id of Object.keys(DESTINATION_DISPLAY_REGION_BY_ID)) {
      expect(ids.has(id), id).toBe(true);
    }
    expect(Object.keys(DESTINATION_DISPLAY_REGION_BY_ID)).toHaveLength(CATALOG.destinations.length);
  });

  it('スコープ一致: 国内の目的地は国内地域だけ、海外は海外地域だけに割り当たる', () => {
    const regionScope = new Map(DESTINATION_DISPLAY_REGIONS.map((r) => [r.id, r.scope]));
    for (const d of CATALOG.destinations) {
      expect(regionScope.get(displayRegionOfDestination(d.id)!), d.id).toBe(d.scope);
    }
  });

  it('全目的地を並べ替えると地域順が単調になり、地域内は登録順を保つ', () => {
    const sorted = sortDestinationsByDisplayRegion([...CATALOG.destinations].reverse());
    const orderIndex = new Map(DESTINATION_DISPLAY_REGIONS.map((r, i) => [r.id, i]));
    for (let i = 1; i < sorted.length; i++) {
      const prev = orderIndex.get(displayRegionOfDestination(sorted[i - 1]!.id)!)!;
      const cur = orderIndex.get(displayRegionOfDestination(sorted[i]!.id)!)!;
      expect(cur, `${sorted[i - 1]!.id} → ${sorted[i]!.id}`).toBeGreaterThanOrEqual(prev);
    }
    // 地域内の代表例: 北海道は登録順（札幌 → 函館 → 釧路）
    const hokkaido = sorted.filter((d) => displayRegionOfDestination(d.id) === 'hokkaido').map((d) => d.id);
    expect(hokkaido.indexOf('SPK')).toBeLessThan(hokkaido.indexOf('HKD'));
    expect(hokkaido.indexOf('HKD')).toBeLessThan(hokkaido.indexOf('KUH'));
    // 国内ブロックの最後は沖縄、海外の先頭は東アジア
    const lastDomestic = [...sorted].reverse().find((d) => d.scope === 'domestic')!;
    expect(displayRegionOfDestination(lastDomestic.id)).toBe('okinawa');
    const firstIntl = sorted.find((d) => d.scope === 'international')!;
    expect(displayRegionOfDestination(firstIntl.id)).toBe('east-asia');
  });

  it('代表ペアの前後関係（地方順の境界）', () => {
    const pairs: [string, string][] = [
      ['SPK', 'SDJ'], // 北海道 < 東北
      ['AOJ', 'TYO'], // 東北 < 関東
      ['TYO', 'KIJ'], // 関東 < 甲信越
      ['MMJ', 'TOY'], // 甲信越 < 北陸
      ['KMQ', 'NGO'], // 北陸 < 東海
      ['FSZ', 'OSA'], // 東海 < 近畿
      ['UKB', 'HIJ'], // 近畿 < 中国
      ['OKJ', 'TAK'], // 中国 < 四国
      ['MYJ', 'FUK'], // 四国 < 九州
      ['KOJ', 'OKA'], // 九州 < 沖縄
      ['OKA', 'SEL'], // 国内 < 海外
      ['SEL', 'SIN'], // 東アジア < 東南アジア
      ['BKK', 'DEL'], // 東南アジア < 南アジア
      ['BOM', 'TAS'], // 南アジア < 中央アジア
      ['TAS', 'DXB'], // 中央アジア < 中東
      ['DXB', 'LHR'], // 中東 < ヨーロッパ
      ['FRA', 'ADD'], // ヨーロッパ < アフリカ
      ['CAI', 'LAX'], // アフリカ < 北アメリカ
      ['JFK', 'MEX'], // 北アメリカ < 中米・カリブ
      ['MEX', 'SYD'], // 中米・カリブ < オセアニア（南アメリカは該当都市なし）
    ];
    for (const [a, b] of pairs) {
      expect(compareDestinationIdsByDisplayRegion(a, b), `${a} < ${b}`).toBeLessThan(0);
      expect(compareDestinationIdsByDisplayRegion(b, a), `${b} > ${a}`).toBeGreaterThan(0);
    }
    expect(compareDestinationIdsByDisplayRegion('TYO', 'TYO')).toBe(0);
  });

  it('ID 配列の並べ替え: 元の配列を変更しない', () => {
    const ids = ['OKA', 'SPK', 'TYO', 'SEL'];
    expect(sortDestinationIdsByDisplayRegion(ids)).toEqual(['SPK', 'TYO', 'OKA', 'SEL']);
    expect(ids).toEqual(['OKA', 'SPK', 'TYO', 'SEL']);
  });

  it('個別の割当判断（計画書 §3 に記録した境界ケース）', () => {
    expect(displayRegionOfDestination('ASJ')).toBe('okinawa'); // 奄美群島は沖縄側
    expect(displayRegionOfDestination('KUM')).toBe('kyushu'); // 屋久島は九州
    expect(displayRegionOfDestination('HHC')).toBe('kanto'); // 八丈島は東京都
    expect(displayRegionOfDestination('IST')).toBe('middle-east');
    expect(displayRegionOfDestination('VVO')).toBe('east-asia'); // 極東
    expect(displayRegionOfDestination('IKT')).toBe('central-asia');
    expect(displayRegionOfDestination('HNL')).toBe('north-america');
    expect(displayRegionOfDestination('GUM')).toBe('oceania');
    expect(displayRegionOfDestination('MEX')).toBe('central-america');
  });
});
