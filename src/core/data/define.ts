import type { AirlineInput, DestinationInput } from './types';

/**
 * データ定義の入口。既定値の補完は buildCatalog（index.ts）が行うため、ここは恒等に近い純関数。
 * 都市・航空会社を足すときは destinations.ts / airlines.ts に defineDestination / defineAirline の
 * 1 項目を足すだけ（docs/43_data_extension_guide.md）。
 */
export const defineDestination = (input: DestinationInput): DestinationInput => input;
export const defineAirline = (input: AirlineInput): AirlineInput => input;
