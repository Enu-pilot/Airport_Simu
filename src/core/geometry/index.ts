/** 幾何ライブラリの公開 API。`camera.ts`（画面変換）は別系統のため含めない */
export * from './vec';
export * from './frames';
export * from './tolerance';
export * from './angle';
export * from './bbox';
export * from './segment';
export {
  arcLengthTable,
  bbox as curveBbox,
  closestPoint,
  curvature,
  derivative,
  evaluate,
  flatten,
  length as curveLength,
  pointAtLength,
  rasterizeCurve,
  reverse as reverseCurve,
  split as splitCurve,
  tAtLength,
  tangentBearingDeg,
} from './curve';
export type { ArcCurve, Curve, CurvePoint, CubicCurve, LineCurve, Path, QuadCurve } from './curve';
export * from './arc';
export * from './bezier';
export * from './integrate';
export * from './arclength';
export * from './intersect';
export * from './polygon';
export * from './stroke';
