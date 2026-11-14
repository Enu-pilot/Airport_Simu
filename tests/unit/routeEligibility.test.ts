import { describe, expect, it } from 'vitest';
import { acceptOffer, addContract, changeFrequency, createCareerCompany, createCompany } from '../../src/core/economy/company';
import { planDay } from '../../src/core/economy/planning';
import { createStarterAirfield } from '../../src/core/sample/starterAirfield';
import { exportLayout, importLayout } from '../../src/core/io/serialize';
import {
  AIRLINES,
  COUNTRIES,
  DESTINATIONS,
  REGIONS,
  airlineDef,
  classifyRoute,
  destinationDef,
  routeAvailability,
  routeCapabilitiesForAirport,
} from '../../src/core/economy/registry';

describe('structured airline and destination registry', () => {
  it('classifies routes by country identifier, not destination display text', () => {
    const sel = destinationDef('SEL');
    expect(sel.name).toBe('ソウル');
    expect(classifyRoute('JP', sel)).toBe('international');
    expect(classifyRoute('KR', sel)).toBe('domestic');
  });

  it('keeps destination country and region references resolvable', () => {
    const countries = new Set(COUNTRIES.map((country) => country.id));
    const regions = new Set(REGIONS.map((region) => region.id));
    expect(AIRLINES.length).toBeGreaterThan(5);
    expect(DESTINATIONS.length).toBeGreaterThan(8);
    for (const destination of DESTINATIONS) {
      expect(countries.has(destination.countryId)).toBe(true);
      expect(regions.has(destination.regionId)).toBe(true);
      expect(Number.isFinite(destination.coordinates.latitude)).toBe(true);
      expect(Number.isFinite(destination.coordinates.longitude)).toBe(true);
    }
  });

  it('blocks international passenger plans until the airport supports international processing', () => {
    const company = createCompany('career', 'international-route');
    addContract(company, {
      airlineId: 'SK',
      destinationId: 'SEL',
      typeId: 'B737-800W',
      perDay: 1,
      window: 'any',
      feeDiscount: 0,
      startDay: 0,
      endDay: 5,
      status: 'active',
      offerExpiresDay: 0,
    });

    const blocked = planDay(company, 0, 1, undefined, routeCapabilitiesForAirport('JP'));
    expect(blocked.flights).toHaveLength(0);
    expect(blocked.unsupportedRoutes).toEqual([
      { contractId: 'ct_1', destinationId: 'SEL', reason: 'international-processing-required' },
    ]);

    const supported = planDay(company, 0, 1, undefined, {
      originCountryId: 'JP',
      internationalPassengerProcessing: true,
    });
    expect(supported.unsupportedRoutes).toEqual([]);
    expect(supported.flights).toHaveLength(1);
  });

  it('preserves an optional airport country in saves and defaults legacy layouts to Japan', () => {
    const layout = createStarterAirfield();
    layout.countryId = 'KR';
    expect(importLayout(exportLayout(layout)).countryId).toBe('KR');

    const legacy = createStarterAirfield();
    delete legacy.countryId;
    const loaded = importLayout(exportLayout(legacy));
    expect(loaded.countryId).toBeUndefined();
    expect(routeCapabilitiesForAirport(loaded.countryId).originCountryId).toBe('JP');
  });

  it('rejects unknown airport country identifiers in imported layouts', () => {
    const layout = createStarterAirfield();
    layout.countryId = 'ZZ';
    expect(() => importLayout(exportLayout(layout))).toThrow('countryId');
  });

  it('refuses accepting an international offer without the required airport processing', () => {
    const company = createCompany('career', 'international-offer');
    const offer = addContract(company, {
      airlineId: 'SK',
      destinationId: 'SEL',
      typeId: 'B737-800W',
      perDay: 1,
      window: 'any',
      feeDiscount: 0,
      startDay: 0,
      endDay: 5,
      status: 'offered',
      offerExpiresDay: 5,
    });
    expect(acceptOffer(company, offer.id, true, 'international-processing-required')).toEqual({
      ok: false,
      reason: 'INTERNATIONAL_PROCESSING_REQUIRED',
    });
  });

  it('refuses a frequency increase when the capacity preview reports a new fatal shortage', () => {
    const company = createCareerCompany('capacity-gate');
    const contract = Object.values(company.contracts).find((candidate) => candidate.status === 'active')!;
    company.airlines[contract.airlineId]!.satisfaction = 100;
    const previousFrequency = contract.perDay;

    expect(changeFrequency(company, contract.id, 1, 'unacceptable')).toEqual({
      ok: false,
      reason: 'CAPACITY_INSUFFICIENT',
    });
    expect(contract.perDay).toBe(previousFrequency);
  });

  it('does not allow a domestic-only carrier to operate an international route', () => {
    const result = routeAvailability(airlineDef('RJ'), destinationDef('SEL'), {
      originCountryId: 'JP',
      internationalPassengerProcessing: true,
    });
    expect(result).toBe('airline-unsupported');
  });
});
