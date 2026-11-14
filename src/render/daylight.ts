/** Display-only daylight model shared by the 2D and 3D renderers. */
export type DaylightPhase = 'night' | 'dawn' | 'day' | 'dusk';

export interface Daylight {
  phase: DaylightPhase;
  /** Ambient daylight level, from 0 (night) to 1 (day). */
  light: number;
  /** Cool night tint in normalized RGBA components. */
  tint: readonly [number, number, number, number];
  sunriseHour: number;
  sunsetHour: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Approximate seasonal sunrise/sunset for the in-game calendar. The game has no
 * latitude model, so this is a visual convention only and never affects ops.
 * `dayOfYear` is 1..365 (values outside that range wrap deterministically).
 */
export function daylight(tSec: number, dayOfYear = 172): Daylight {
  const day = ((Math.floor(dayOfYear) - 1) % 365 + 365) % 365 + 1;
  const season = Math.cos((2 * Math.PI * (day - 172)) / 365);
  const sunriseHour = 6 - season / 2;
  const sunsetHour = 18 + season;
  const hour = ((tSec % 86400) + 86400) % 86400 / 3600;
  const dawn = smooth(sunriseHour - 1, sunriseHour + 0.75, hour);
  const dusk = 1 - smooth(sunsetHour - 1, sunsetHour + 1, hour);
  const light = Math.max(0, Math.min(1, dawn * dusk));
  const phase: DaylightPhase = light < 0.01
    ? 'night'
    : hour < sunriseHour + 0.75
      ? 'dawn'
      : hour > sunsetHour - 1
        ? 'dusk'
        : 'day';
  return { phase, light, tint: [0.04, 0.075, 0.16, (1 - light) * 0.42], sunriseHour, sunsetHour };
}
