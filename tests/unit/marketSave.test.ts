import { describe, expect, it } from 'vitest';
import { createSandboxCompany, importCompany } from '../../src/core/economy/company';
import { defaultCity } from '../../src/core/economy/city';
import { checkMarket } from '../../src/core/economy/market';
import { PROJECT_FORMAT_VERSION_5, buildProject, serializeProject, validateProject } from '../../src/core/io/project';
import { createSampleAirport } from '../../src/core/sample/sampleAirport';

const NOW = '2026-11-18T00:00:00Z';
const opts = { fallbackCompany: createSandboxCompany() };

function marketCompany() {
  const c = createSandboxCompany();
  c.city = defaultCity('core');
  c.market = { version: 1, routes: { K_1: { lfEma: 0.8, lowDays: 0, highDays: 3, signal: 'grow' } } };
  return c;
}

describe('marketSave: 市場設定の保存と検証（フェーズ 3 §2.2 / §2.3）', () => {
  it('market がある会社は保存形式 5 で書き出され、検証を通って往復する', () => {
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: marketCompany(), pin: null, scenarios: [], sim: null });
    expect(p.formatVersion).toBe(PROJECT_FORMAT_VERSION_5);
    const text = serializeProject(p);
    const v = validateProject(text, opts);
    expect(v.errors).toEqual([]);
    expect(v.project!.company.market).toEqual({ version: 1, routes: { K_1: { lfEma: 0.8, lowDays: 0, highDays: 3, signal: 'grow' } } });
  });

  it('market がない会社は版が上がらない', () => {
    const c = createSandboxCompany();
    c.city = defaultCity('core');
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c, pin: null, scenarios: [], sim: null });
    expect(p.formatVersion).toBeLessThan(PROJECT_FORMAT_VERSION_5);
  });

  it('厳格な検証: city のない market はエラー、形の不正もエラー', () => {
    const c = createSandboxCompany();
    c.market = { version: 1, routes: {} };
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c, pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), opts);
    expect(v.errors.some((e) => e.includes('market'))).toBe(true);
    expect(checkMarket({ version: 2, routes: {} }).length).toBeGreaterThan(0);
    expect(checkMarket({ version: 1, routes: { K_1: { lfEma: 1.5, lowDays: 0, highDays: 0 } } }).length).toBeGreaterThan(0);
    expect(checkMarket({ version: 1, routes: {} })).toEqual([]);
  });

  it('寛容な読み込み: city のない market・不正な market は捨てて読み込む', () => {
    const noCity = createSandboxCompany();
    noCity.market = { version: 1, routes: {} };
    const a = importCompany(JSON.stringify(noCity));
    expect(a).not.toBeNull();
    expect(a!.market).toBeUndefined();
    const bad = marketCompany();
    (bad.market as unknown as { routes: unknown }).routes = 'x';
    const b = importCompany(JSON.stringify(bad));
    expect(b).not.toBeNull();
    expect(b!.market).toBeUndefined();
    const good = importCompany(JSON.stringify(marketCompany()));
    expect(good!.market).toBeDefined();
  });

  it('未知の航空会社・就航先の契約は読み込みエラー（§2.2）', () => {
    const c = marketCompany();
    const k = Object.values(c.contracts)[0]!;
    k.airlineId = 'ZZ';
    const p = buildProject({ name: 't', savedAt: NOW, layout: createSampleAirport(), company: c, pin: null, scenarios: [], sim: null });
    const v = validateProject(serializeProject(p), opts);
    expect(v.errors.some((e) => e.includes('ZZ'))).toBe(true);
  });
});
