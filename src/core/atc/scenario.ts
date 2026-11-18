import { buildAirsideNetwork } from '../airside/network';
import type { AirportLayout } from '../model/types';
import type { AtcAirportSnapshot, AtcScenarioDefinition, AtcTrafficEntry } from './types';

/**
 * ATC-03: 空港スナップショットの取り込み・診断・シナリオ作成。
 * 経営プロジェクトからは AirportLayout だけを複製する。会社・契約・
 * 運航中 sim・旅客・journal はここへ持ち込まない（引数自体が layout のみ）。
 */

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export function createAtcAirportSnapshot(
  layout: AirportLayout,
  input: { id: string; capturedAtIso: string },
): AtcAirportSnapshot {
  const cloned = deepClone(layout);
  return {
    id: input.id,
    name: cloned.name,
    sourceLayoutName: layout.name,
    sourceSchemaVersion: layout.schemaVersion,
    capturedAtIso: input.capturedAtIso,
    layout: cloned,
  };
}

export interface AtcAirportDiagnostics {
  errors: string[];
  warnings: string[];
  operationalRunwayIds: string[];
  operationalStandIds: string[];
  connectedStandIds: string[];
  unconnectedStandIds: string[];
}

/** 開始前診断。不足を黙って補正せず、理由を列挙する（計画 §4.3） */
export function diagnoseAtcAirport(snapshot: AtcAirportSnapshot): AtcAirportDiagnostics {
  const { layout } = snapshot;
  const errors: string[] = [];
  const warnings: string[] = [];
  const operationalRunwayIds = Object.values(layout.runways)
    .filter((r) => r.buildState === 'operational')
    .map((r) => r.id)
    .sort();
  const operationalStandIds = Object.values(layout.stands)
    .filter((s) => s.buildState === 'operational')
    .map((s) => s.id)
    .sort();
  if (operationalRunwayIds.length === 0) errors.push('no-operational-runway');
  if (operationalStandIds.length === 0) errors.push('no-operational-stand');

  const network = buildAirsideNetwork(layout);
  const connectedStandIds = operationalStandIds.filter((id) => network.standLinks[id] !== undefined);
  const unconnectedStandIds = operationalStandIds.filter((id) => network.standLinks[id] === undefined);
  if (operationalStandIds.length > 0 && connectedStandIds.length === 0) {
    errors.push('no-connected-stand');
  } else if (unconnectedStandIds.length > 0) {
    warnings.push('some-stands-unconnected');
  }
  return {
    errors,
    warnings,
    operationalRunwayIds,
    operationalStandIds,
    connectedStandIds,
    unconnectedStandIds,
  };
}

/**
 * チュートリアル用シナリオ（低交通量・決定的）。
 * 航空会社名は表示ラベルの一部（コールサイン）としてのみ使い、
 * 経営側の航空会社 ID・契約・評価とは結び付けない。
 */
export function createTutorialScenario(
  snapshot: AtcAirportSnapshot,
  diagnostics: AtcAirportDiagnostics,
): AtcScenarioDefinition {
  const runwayId = diagnostics.operationalRunwayIds[0];
  const standIds = diagnostics.connectedStandIds.length > 0
    ? diagnostics.connectedStandIds
    : diagnostics.operationalStandIds;
  if (runwayId === undefined || standIds.length === 0) {
    throw new Error('atc-tutorial-airport-not-usable');
  }
  const mk = (
    i: number,
    callsign: string,
    kind: AtcTrafficEntry['kind'],
    atSec: number,
    readyDelaySec?: number,
  ): AtcTrafficEntry => ({
    id: `traffic_${i + 1}`,
    callsign,
    aircraftTypeId: 'B737-800',
    size: 'M',
    kind,
    runwayId,
    standId: standIds[i % standIds.length]!,
    atSec,
    readyDelaySec,
  });
  return {
    id: 'atc-tutorial-1',
    name: 'チュートリアル: 基本管制',
    airport: snapshot,
    durationSec: 3600,
    seed: 'atc-tutorial-1',
    traffic: [
      mk(0, 'ANA101', 'departure', 0, 60),
      mk(1, 'JAL202', 'arrival', 120),
      mk(2, 'ANA303', 'departure', 300, 60),
      mk(3, 'JAL404', 'arrival', 480),
    ],
  };
}
