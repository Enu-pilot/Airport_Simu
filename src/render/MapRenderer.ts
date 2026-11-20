import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Camera } from '../core/geometry/camera';
import { worldToScreen } from '../core/geometry/camera';
import { mToTiles, worldPolyToMap, worldToMap } from '../core/geometry/frames';
import { distance, type Tile, type Vec2 } from '../core/geometry/vec';
import { FACILITY_SPECS, PBB_TYPES, STRIP_HALF_WIDTH } from '../core/model/catalog';
import { pbbDeckOf, pbbTypeOf } from '../core/model/boardingBridge';
import { isBuildable } from '../core/model/site';
import type { AirportLayout, BuildState, Facility, NetNode, PaxZone, Runway, RunwayFree, Site, Stand, TerminalAreaKind } from '../core/model/types';
import { entityTypeOf, isFreeRunway } from '../core/model/types';
import { facilityDims, standDims, standEntry } from '../core/layout/footprint';
import { facilityLevel } from '../core/model/levels';
import { offsiteTilesIn } from '../core/layout/operations';
import { designatorsOf } from '../core/layout/designators';
import { runwayAxis } from '../core/layout/runway';
import { roadDrawWidthM, runwayStripSurface, runwaySurfaces, taxiwayBandSurface, taxiwayDrawWidthM } from '../core/layout/surfaces';
import { resolveRunwayDims } from '../core/layout/runwayAreas';
import { HOLD_SHORT_MAX_RATIO, SIN_MIN_HOLD } from '../core/sim/rules';
import type { LayoutAnalysis } from '../core/validation/validate';
import { COLOR, FACILITY_COLOR, NODE_COLOR, SEVERITY_COLOR, SIZE_COLOR, TERRAIN_COLOR } from './colors';
import { visibleFacilityLabelIds, visibleInteriorFacilityIds } from './labels';
import { computePreview, facilityKindOf, nextPathPoint, nextTaxiPoint, rectFromDrag } from '../editor/tools';
import { validateOrthogonalPolygon } from '../core/geometry/polygon';
import { getAnalysis, type EditorState, type OpsState } from '../editor/store';
import { AIRCRAFT_TYPES, resolveType, type TypeTable } from '../core/sim/aircraftTypes';
import { isVisible } from '../core/sim/query';
import { edgeIndexAt, pointAt } from '../core/sim/routes';
import type { Aircraft, UnitKind } from '../core/sim/types';
import { areaOccupancy, facilityLoad } from '../core/sim/passengers';
import { linkBetween } from '../core/terminal/route';
import { areaMapLevel } from '../core/terminal/adjacency';
import { terminalAreaLevelProblem } from '../core/layout/levelRules';
import { AREA_KIND_LABEL, floorShortLabel } from '../i18n/ja';
import { airportKpis, type AirportKpis } from '../core/analytics/kpi';
import { heatBand, processAreaHeat, segmentEdgeLoads, staticBottlenecks } from '../core/access/heatmap';
import { daylight } from './daylight';
import { blockGraphOf } from '../core/layout/blockGraph';
import { blockCapacity } from '../core/sim/taxiBlocks';
import { TILE_M } from '../core/model/catalog';

/**
 * PixiJS による空港マップ描画。シミュレーション・編集の状態は一切変更せず、
 * EditorState を受け取って毎回描き直す（編集エディタの規模では十分高速）。
 *
 * world コンテナはタイル単位で描画し、カメラに合わせて拡大・平行移動する。
 * 線幅などの画面上の太さは px(n) = n / zoom でタイル単位に換算する。
 */

/** World フレーム（ノード・滑走路端など）→ Map フレーム（描画）。変換は frames.ts のみで行う */
const c = (t: Tile): Vec2 => worldToMap(t);

const fmtDeg = (d: number): string => (Math.round(d * 10) / 10).toFixed(1);

const BUILD_ALPHA: Record<BuildState, number> = { operational: 1, underConstruction: 0.8, planned: 0.45 };

/** 混雑ヒートの3段階（core/access/heatmap の heatBand と対応: 40%未満 / 40–70% / 70%以上） */
const HEAT_COLORS = [0x3ccf6e, 0xffc23d, 0xff4d4f] as const;

export class MapRenderer {
  readonly app = new Application();
  private world = new Container();
  private terrain = new Sprite();
  private buildable = new Sprite();
  private g = new Graphics();
  private nightShade = new Graphics();
  private overlay = new Graphics();
  private labels = new Container();
  private textPool = new Map<string, Text>();
  private usedTexts = new Set<string>();
  private terrainSite: Site | null = null;
  /** 運航中の機種テーブル（保存時の機種データを使う運航ではそのスナップショット） */
  private typeTable: TypeTable | null = null;
  private zoom = 1;
  /** 混雑マップの集計（毎フレーム集計しないよう、シミュレーション時刻が変わったときだけ更新） */
  private kpiCache: { now: number; sim: unknown; k: AirportKpis } | null = null;
  private interiorShown = false;
  private mapLevel: number | 'all' = 0;
  /** 現在のカメラで見えている範囲（マップ座標＝タイル単位）。draw の冒頭で更新し、画面外カリングの判定に使う */
  private view = { x0: 0, y0: 0, x1: 0, y1: 0 };

  /** 矩形（x, y, w, h）が表示範囲（margin 分だけ拡張）と重なるか。重ならない要素は描いても画面に出ない */
  private boxInView(x: number, y: number, w: number, h: number, margin: number): boolean {
    const v = this.view;
    return x + w >= v.x0 - margin && x <= v.x1 + margin && y + h >= v.y0 - margin && y <= v.y1 + margin;
  }

  private pointInView(x: number, y: number, margin: number): boolean {
    const v = this.view;
    return x >= v.x0 - margin && x <= v.x1 + margin && y >= v.y0 - margin && y <= v.y1 + margin;
  }

  /** 線分が表示範囲（margin 分だけ拡張）と交わるか（Liang–Barsky 法による正確な交差判定） */
  private segInView(ax: number, ay: number, bx: number, by: number, margin: number): boolean {
    const v = this.view;
    const x0 = v.x0 - margin;
    const y0 = v.y0 - margin;
    const x1 = v.x1 + margin;
    const y1 = v.y1 + margin;
    const dx = bx - ax;
    const dy = by - ay;
    let t0 = 0;
    let t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (p === 0) return q >= 0;
      const t = q / p;
      if (p < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
      return true;
    };
    return clip(-dx, ax - x0) && clip(dx, x1 - ax) && clip(-dy, ay - y0) && clip(dy, y1 - ay);
  }

  /** flat な多角形座標列 [x, y, x, y, ...] の外接矩形が表示範囲と重なるか */
  private flatPolyInView(pts: number[], margin: number): boolean {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return this.boxInView(x0, y0, x1 - x0, y1 - y0, margin);
  }

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      background: COLOR.background,
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    host.appendChild(this.app.canvas);
    this.world.addChild(this.terrain, this.buildable, this.g, this.nightShade, this.overlay);
    this.app.stage.addChild(this.world, this.labels);
  }

  destroy(): void {
    this.app.destroy(true, { children: true, texture: true });
  }

  private px(n: number): number {
    return n / this.zoom;
  }

  draw(s: EditorState): void {
    const preview = s.mode === 'build' ? computePreview(s) : null;
    const layout = preview?.result.ok ? preview.result.layout : s.history.present;
    const analysis = getAnalysis(layout);
    const ghostIds = new Set(preview?.ghostIds ?? []);
    const cam = s.camera;
    this.zoom = cam.zoom;
    // 画面外カリング用の表示範囲（drawGrid のクリップと同じ式）
    this.view = { x0: cam.x, y0: cam.y, x1: cam.x + s.viewSize.w / cam.zoom, y1: cam.y + s.viewSize.h / cam.zoom };
    this.world.scale.set(cam.zoom);
    this.world.position.set(-cam.x * cam.zoom, -cam.y * cam.zoom);
    this.usedTexts.clear();
    this.interiorShown = s.overlays.interior;
    this.mapLevel = s.mapLevel;

    this.updateTerrain(layout.site);
    this.buildable.visible = s.overlays.buildable;
    const g = this.g;
    const o = this.overlay;
    g.clear();
    o.clear();

    if (s.overlays.grid) this.drawGrid(cam, s.viewSize, layout.site);
    this.drawLayout(layout, analysis, s);
    this.drawConnectors(layout, analysis, s.selection);
    this.drawTerminalTransit(layout, s.selection);
    this.drawPortalLinks(layout, s.selection);
    if (s.overlays.interior) this.drawInterior(layout, s, cam);
    if (s.overlays.network) this.drawNetwork(analysis);
    if (s.overlays.network) this.drawTaxiBlocks(layout, s.ops, cam, s.overlays.labels);
    if (s.overlays.issues) this.drawIssues(layout, analysis);
    this.drawNightShade(layout, s);

    // 選択
    if (s.selection && !ghostIds.has(s.selection)) this.outline(o, layout, s.selection, COLOR.selection, 3);
    // プレビュー（緑 = 配置可能、赤 = エラーあり）
    for (const id of ghostIds) {
      const bad = (analysis.byTarget[id] ?? []).some((i) => i.severity === 'error');
      this.outline(o, layout, id, bad ? COLOR.ghostBad : COLOR.ghostOk, 3);
    }
    this.drawDraft(s);
    this.drawFootprintEdit(s);
    // 配置・回転のプレビュー中の滑走路: 番号・真方位・磁方位・長さを表示
    for (const id of ghostIds) {
      const gr = layout.runways[id];
      if (!gr || !isFreeRunway(gr)) continue;
      const ds = designatorsOf(gr, layout);
      const mid = c({ x: (runwayAxis(gr).start.x + runwayAxis(gr).end.x) / 2, y: (runwayAxis(gr).start.y + runwayAxis(gr).end.y) / 2 });
      const text = `${ds.text.join('/')}  真 ${fmtDeg(ds.trueDeg[0])}° / 磁 ${fmtDeg(ds.magDeg[0])}°  ${Math.round(gr.lengthM)} m`;
      this.label(`ghostinfo:${id}`, text, { x: mid.x, y: mid.y - 2 }, cam, { size: 12, color: 0xb9f6ca });
    }
    if (s.overlays.labels) this.drawLabels(layout, analysis, cam);
    if (s.ops && s.overlays.congestion) this.drawCongestion(layout, s.ops, cam, s.overlays.labels);
    if (!s.ops && s.overlays.congestion) this.drawStaticHeat(layout, s, cam);
    if (s.ops) this.drawOps(s.ops, cam, s.overlays.network);
    for (const [k, t] of this.textPool) t.visible = this.usedTexts.has(k);
  }

  /** Display-only game-time tint and bounded airfield lights. */
  private drawNightShade(layout: AirportLayout, s: EditorState): void {
    this.nightShade.clear();
    if (!s.overlays.daylight || s.mode !== 'operate' || !s.ops) return;
    const d = daylight(s.ops.sim.state.now, s.ops.sim.company?.day ?? 172);
    if (d.tint[3] > 0.01) this.nightShade.rect(0, 0, layout.site.width, layout.site.height).fill({ color: 0x0b1730, alpha: d.tint[3] });
    const night = 1 - d.light;
    if (night < 0.2) return;
    const cap = 240;
    let drawn = 0;
    const addLineLights = (a: Vec2, b: Vec2, spacingM: number): void => {
      if (drawn >= cap) return;
      const lenM = distance(a, b) * 25;
      const count = Math.max(1, Math.ceil(lenM / spacingM));
      const stride = Math.max(1, Math.ceil(count / Math.max(1, cap - drawn)));
      for (let i = stride; i < count && drawn < cap; i += stride) {
        const t = i / count;
        const p = worldToMap({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        this.nightShade.circle(p.x, p.y, this.px(0.045)).fill({ color: 0xffd98a, alpha: night * 0.72 });
        drawn++;
      }
    };
    for (const r of Object.values(layout.runways)) {
      if (drawn >= cap) break;
      const axis = runwayAxis(r);
      addLineLights(axis.start, axis.end, 100);
    }
    for (const e of Object.values(layout.taxiways)) {
      if (drawn >= cap) break;
      const a = layout.taxiNodes[e.from]?.pos;
      const b = layout.taxiNodes[e.to]?.pos;
      if (a && b) addLineLights(a, b, 125);
    }
  }

  // ------------------------------------------------------------ 地形

  private updateTerrain(site: Site): void {
    if (this.terrainSite === site) return;
    this.terrainSite = site;
    const make = (pixel: (x: number, y: number) => [number, number, number, number]) => {
      const canvas = document.createElement('canvas');
      canvas.width = site.width;
      canvas.height = site.height;
      const ctx = canvas.getContext('2d')!;
      const img = ctx.createImageData(site.width, site.height);
      for (let y = 0; y < site.height; y++) {
        for (let x = 0; x < site.width; x++) {
          const [r, g, b, a] = pixel(x, y);
          const i = (y * site.width + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = a;
        }
      }
      ctx.putImageData(img, 0, 0);
      const tex = Texture.from(canvas);
      tex.source.scaleMode = 'nearest';
      return tex;
    };
    this.terrain.texture = make((x, y) => {
      const [r, g, b] = TERRAIN_COLOR[site.terrain[y * site.width + x] ?? 4];
      return [r, g, b, 255];
    });
    this.buildable.texture = make((x, y) => (isBuildable(site, x, y) ? [0, 0, 0, 0] : [255, 48, 48, 110]));
    this.terrain.width = this.buildable.width = site.width;
    this.terrain.height = this.buildable.height = site.height;
  }

  private drawGrid(cam: Camera, view: { w: number; h: number }, site: Site): void {
    const g = this.g;
    const x0 = Math.max(0, Math.floor(cam.x));
    const y0 = Math.max(0, Math.floor(cam.y));
    const x1 = Math.min(site.width, Math.ceil(cam.x + view.w / cam.zoom));
    const y1 = Math.min(site.height, Math.ceil(cam.y + view.h / cam.zoom));
    const step = cam.zoom >= 7 ? 1 : cam.zoom >= 4 ? 5 : 10;
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) {
      g.moveTo(x, y0).lineTo(x, y1);
    }
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      g.moveTo(x0, y).lineTo(x1, y);
    }
    g.stroke({ width: this.px(1), color: COLOR.grid, alpha: 0.12 });
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) g.moveTo(x, y0).lineTo(x, y1);
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) g.moveTo(x0, y).lineTo(x1, y);
    g.stroke({ width: this.px(1), color: COLOR.gridMajor, alpha: 0.28 });
  }

  // ------------------------------------------------------------ 建設物

  private drawLayout(layout: AirportLayout, analysis: LayoutAnalysis, s: EditorState): void {
    const g = this.g;
    const facilities = Object.values(layout.facilities).filter((f) => !f.parentFacilityId && (s.mapLevel === 'all' || facilityLevel(f) === s.mapLevel));
    const byLayer = (layer: string) => facilities.filter((f) => FACILITY_SPECS[f.kind].layer === layer);

    // 滑走路保護区域
    for (const r of Object.values(layout.runways)) {
      if (isFreeRunway(r)) {
        // 自由形: 着陸帯（薄い面と輪郭）→ RESA（斜線）。形は 3D と共有の runwaySurfaces
        const sf = runwaySurfaces(r, layout);
        g.poly(flat(worldPolyToMap(sf.strip))).fill({ color: COLOR.strip, alpha: 0.06 });
        g.poly(flat(worldPolyToMap(sf.strip))).stroke({ width: this.px(1), color: COLOR.strip, alpha: 0.3 });
        for (const p of sf.resa) this.hatch(g, worldPolyToMap(p), COLOR.resa);
        continue;
      }
      g.poly(flat(worldPolyToMap(runwayStripSurface(r)))).fill({ color: COLOR.strip, alpha: 0.05 });
      g.poly(flat(worldPolyToMap(runwayStripSurface(r)))).stroke({ width: this.px(1), color: COLOR.strip, alpha: 0.25 });
    }
    // エリア
    for (const f of [...byLayer('apron'), ...byLayer('area')]) this.drawFacility(f);

    // 滑走路（従来形も自由形も同じ runwaySurfaces から描く。従来形の舗装は実寸の幅で、判定の範囲は薄い輪郭で示す）
    for (const r of Object.values(layout.runways)) this.drawRunway(r, layout);

    // 道路
    for (const e of Object.values(layout.roads)) {
      const a = layout.roadNodes[e.from];
      const b = layout.roadNodes[e.to];
      if (!a || !b) continue;
      const fromLevel = a.level ?? 0;
      const toLevel = b.level ?? 0;
      if (s.mapLevel !== 'all' && fromLevel !== s.mapLevel && toLevel !== s.mapLevel) continue;
      // 画面外の区間は描かない（破線・矢印・状態印・中点の印はすべて区間とその太さの周辺に収まる）
      if (!this.segInView(c(a.pos).x, c(a.pos).y, c(b.pos).x, c(b.pos).y, mToTiles(roadDrawWidthM(e)) / 2 + 0.45 + 2 / this.zoom)) continue;
      const alpha = BUILD_ALPHA[e.buildState] * (s.mapLevel === 'all' && fromLevel !== toLevel ? 0.65 : 1);
      if (e.roadClass === 'rail') {
        // 鉄道: 細い道床と枕木
        g.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ width: mToTiles(roadDrawWidthM(e)), color: COLOR.rail, alpha, cap: 'round' });
        this.dashed(g, c(a.pos), c(b.pos), 0.15, 0.35, { width: 0.8, color: COLOR.rail, alpha: 0.8 * alpha });
        if (e.buildState !== 'operational') this.edgeStateMarks(g, c(a.pos), c(b.pos), e.buildState);
        continue;
      }
      const color = e.roadClass === 'public' ? COLOR.roadPublic : e.roadClass === 'service' ? COLOR.roadService : e.roadClass === 'walkway' ? COLOR.walkway : COLOR.fuelPipe;
      g.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ width: mToTiles(roadDrawWidthM(e)), color, alpha, cap: 'round' });
      if (e.connectorKind) {
        const mid = c({ x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 });
        g.circle(mid.x, mid.y, 0.35).stroke({ width: this.px(1.4), color: COLOR.selection, alpha });
      }
      if (e.roadClass === 'public') {
        this.dashed(g, c(a.pos), c(b.pos), 0.6, 0.6, { width: this.px(1), color: COLOR.roadMarking, alpha: 0.6 * alpha });
      }
      if (e.oneWay) this.arrow(g, c(a.pos), c(b.pos), COLOR.roadMarking, alpha);
      if (e.buildState !== 'operational') this.edgeStateMarks(g, c(a.pos), c(b.pos), e.buildState);
    }

    // 誘導路: 3D と同じ帯の形状（core の surfaces）。節点の外側にできる隙間は節点の円で埋める。
    // 縁取り → 塗り → 中心線の順に、全エッジを通して描く（エッジ同士の縁取りが互いの塗りを横切らない）
    const taxiEdges = Object.values(layout.taxiways).flatMap((e) => {
      const a = layout.taxiNodes[e.from];
      const b = layout.taxiNodes[e.to];
      if (!a || !b) return [];
      const p = c(a.pos);
      const q = c(b.pos);
      const half = mToTiles(taxiwayDrawWidthM(e)) / 2;
      // 画面外の区間は帯の形状計算ごと省く（節点の円は half + px(1) まで広がる）
      if (!this.segInView(p.x, p.y, q.x, q.y, half + 0.3 + 2 / this.zoom)) return [];
      return [{ e, p, q, band: worldPolyToMap(taxiwayBandSurface(a.pos, b.pos, e)), half }];
    });
    for (const t of taxiEdges) {
      const alpha = BUILD_ALPHA[t.e.buildState];
      if (t.band.length > 0) g.poly(flat(t.band)).fill({ color: COLOR.taxiwayEdge, alpha }).stroke({ width: this.px(2), color: COLOR.taxiwayEdge, alpha });
      for (const n of [t.p, t.q]) g.circle(n.x, n.y, t.half + this.px(1)).fill({ color: COLOR.taxiwayEdge, alpha });
    }
    for (const t of taxiEdges) {
      const alpha = BUILD_ALPHA[t.e.buildState];
      if (t.band.length > 0) g.poly(flat(t.band)).fill({ color: COLOR.taxiway, alpha });
      for (const n of [t.p, t.q]) g.circle(n.x, n.y, t.half).fill({ color: COLOR.taxiway, alpha });
    }
    for (const { e, p, q } of taxiEdges) {
      const alpha = BUILD_ALPHA[e.buildState];
      g.moveTo(p.x, p.y).lineTo(q.x, q.y).stroke({ width: this.px(1.5), color: COLOR.taxiCenter, alpha: 0.9 * alpha });
      if (e.oneWay) this.arrow(g, p, q, COLOR.taxiCenter, alpha);
      if (e.buildState !== 'operational') this.edgeStateMarks(g, p, q, e.buildState);
    }
    // 停止位置（ホールディングポイント）
    for (const e of Object.values(analysis.network.edges)) {
      if (!e.holdShortAt) continue;
      const rwyNode = analysis.network.nodes[e.holdShortAt.nodeId]!;
      const other = analysis.network.nodes[e.from === rwyNode.id ? e.to : e.from]!;
      const p = c(rwyNode.pos);
      const q = c(other.pos);
      const d = distance(p, q);
      // 自由形のノードは、中心線からの垂直距離 H（実寸の停止位置）をエッジに沿った距離に直す（sim/routes.ts holdShortDistanceAt と同じ式）
      const free = rwyNode.runwayIds.map((id) => layout.runways[id]).filter((rw): rw is RunwayFree => !!rw && isFreeRunway(rw));
      let along = Math.min(STRIP_HALF_WIDTH, d * 0.8);
      if (free.length > 0) {
        const eAx = other.pos.x - rwyNode.pos.x;
        const eAy = other.pos.y - rwyNode.pos.y;
        let dm = 0;
        for (const rw of free) {
          const u = runwayAxis(rw).dir;
          const sin = d > 0 ? Math.abs(eAx * u.y - eAy * u.x) / d : 1;
          dm = Math.max(dm, resolveRunwayDims(rw).holdingPositionM / Math.max(sin, SIN_MIN_HOLD));
        }
        along = Math.min(mToTiles(dm), d * HOLD_SHORT_MAX_RATIO);
      }
      const t = along / d;
      const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
      const n = { x: -(q.y - p.y) / d, y: (q.x - p.x) / d };
      g.moveTo(m.x - n.x * 0.6, m.y - n.y * 0.6).lineTo(m.x + n.x * 0.6, m.y + n.y * 0.6);
      g.stroke({ width: this.px(3), color: COLOR.holdShort });
    }

    // スポット
    for (const st of Object.values(layout.stands)) this.drawStand(st, !!analysis.network.standLinks[st.id]);
    // 建物・ゲート
    for (const f of [...byLayer('building'), ...byLayer('gate')]) this.drawFacility(f);

    // ノード
    const showNodes = this.zoom >= 6 || s.overlays.network || s.tool === 'taxiway' || s.tool === 'road';
    if (showNodes) {
      for (const n of Object.values(layout.taxiNodes)) {
        const p = c(n.pos);
        if (!this.pointInView(p.x, p.y, 0.3)) continue;
        const kind = analysis.network.nodes[n.id]?.kind ?? 'taxiway';
        const r = kind === 'taxiway' ? 0.14 : 0.22;
        g.circle(p.x, p.y, r).fill({ color: NODE_COLOR[kind] }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.6 });
      }
      for (const n of Object.values(layout.roadNodes)) {
        if (s.mapLevel !== 'all' && (n.level ?? 0) !== s.mapLevel) continue;
        const p = c(n.pos);
        if (!this.pointInView(p.x, p.y, 0.3)) continue;
        g.circle(p.x, p.y, 0.14).fill({ color: 0xd7ccc8 }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.6 });
      }
    }
  }

  /**
   * 滑走路: 肩 → 舗装 → 中心線の破線 → 進入端の縦じま（番号は drawLabels）。形は 3D と共有の runwaySurfaces。
   * 従来形は肩・RESA なし。舗装は実寸の幅（30/45/60 m）で描き、判定に使う占有の多角形（footprint）は薄い破線で示す。
   */
  private drawRunway(r: Runway, layout: AirportLayout): void {
    const g = this.g;
    const a = BUILD_ALPHA[r.buildState];
    const sf = runwaySurfaces(r, layout);
    const paved = flat(worldPolyToMap(sf.paved));
    const pavement = flat(worldPolyToMap(sf.pavement));
    if (sf.footprint) this.dashedPoly(g, worldPolyToMap(sf.footprint), COLOR.runwayMarking, 0.35);
    if (sf.paved !== sf.pavement) g.poly(paved).fill({ color: COLOR.runwayShoulder, alpha: a });
    g.poly(pavement).fill({ color: COLOR.runway, alpha: a });
    g.poly(pavement).stroke({ width: this.px(1.5), color: COLOR.runwayMarking, alpha: 0.7 * a });
    for (const [p, q] of sf.centrelineDashes) {
      const m0 = worldToMap(p);
      const m1 = worldToMap(q);
      g.moveTo(m0.x, m0.y).lineTo(m1.x, m1.y);
    }
    g.stroke({ width: this.px(2), color: COLOR.runwayMarking, alpha: a });
    for (const bar of sf.thresholdBars) g.poly(flat(worldPolyToMap(bar))).fill({ color: COLOR.runwayMarking, alpha: a });
    this.buildStateOutline(g, pavement, r.buildState);
  }

  /** 多角形の辺を薄い破線で描く（従来形の判定範囲・実寸との対比） */
  private dashedPoly(g: Graphics, poly: Vec2[], color: number, alpha: number): void {
    for (let i = 0; i < poly.length; i++) this.dashed(g, poly[i]!, poly[(i + 1) % poly.length]!, 0.4, 0.4, { width: this.px(1), color, alpha });
  }

  /** 斜線の面（RESA）: 多角形の塗りと、辺に平行でない斜めの線 */
  private hatch(g: Graphics, poly: Vec2[], color: number): void {
    g.poly(flat(poly)).fill({ color, alpha: 0.1 });
    g.poly(flat(poly)).stroke({ width: this.px(1), color, alpha: 0.6 });
    // 対角線方向の線（凸の 4 角形。頂点 0-1 の方向と 1-2 の方向で斜線を引く）
    const [p0, p1, p2, p3] = poly as [Vec2, Vec2, Vec2, Vec2];
    const steps = 6;
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const a = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
      const b = { x: p3.x + (p2.x - p3.x) * Math.min(1, t + 1 / steps), y: p3.y + (p2.y - p3.y) * Math.min(1, t + 1 / steps) };
      g.moveTo(a.x, a.y).lineTo(b.x, b.y);
    }
    g.stroke({ width: this.px(1), color, alpha: 0.35 });
  }

  private drawFacility(f: Facility): void {
    const g = this.g;
    const d = facilityDims(f);
    // 画面外の施設は描かない（矩形施設は origin + 寸法、非矩形は footprint の外接矩形で判定。
    // 内部の印・枠線はすべてその内側か縁に収まる）
    if (f.footprint && f.footprint.length >= 3) {
      if (!this.flatPolyInView(flat(f.footprint.map((p) => ({ x: p.x, y: p.y }))), 0.3 + 3 / this.zoom)) return;
    } else if (!this.boxInView(f.origin.x, f.origin.y, d.w, d.h, 0.3 + 3 / this.zoom)) return;
    const alpha = BUILD_ALPHA[f.buildState];
    const color = FACILITY_COLOR[f.kind];
    const layer = FACILITY_SPECS[f.kind].layer;
    // 5-15 T7: 非矩形の footprint がある施設は、その多角形で描く（頂点はタイル角の座標）
    if (f.footprint && f.footprint.length >= 3) {
      const pts = flat(f.footprint.map((p) => ({ x: p.x, y: p.y })));
      g.poly(pts).fill({ color, alpha: (layer === 'building' || layer === 'gate' ? 1 : 0.85) * alpha });
      g.poly(pts).stroke({ width: this.px(1), color: 0x000000, alpha: 0.5 * alpha });
      this.buildStateOutline(g, pts, f.buildState);
      return;
    }
    const inset = layer === 'building' || layer === 'gate' ? 0.08 : 0;
    const x = f.origin.x + inset;
    const y = f.origin.y + inset;
    const w = d.w - inset * 2;
    const h = d.h - inset * 2;
    g.rect(x, y, w, h).fill({ color, alpha: (layer === 'building' || layer === 'gate' ? 1 : 0.85) * alpha });
    g.rect(x, y, w, h).stroke({ width: this.px(1), color: 0x000000, alpha: 0.5 * alpha });
    if (f.kind === 'parking') {
      for (let k = 1; k < d.w; k++) g.moveTo(f.origin.x + k, f.origin.y + 0.15).lineTo(f.origin.x + k, f.origin.y + d.h - 0.15);
      g.stroke({ width: this.px(1), color: 0xffffff, alpha: 0.25 * alpha });
    }
    if (f.kind === 'tower') g.circle(f.origin.x + d.w / 2, f.origin.y + d.h / 2, 0.5).fill({ color: 0x9fd3ff, alpha });
    if (f.kind === 'fuelFarm') {
      g.circle(f.origin.x + d.w / 2, f.origin.y + d.h / 2, Math.min(d.w, d.h) * 0.35).stroke({ width: this.px(2), color: 0x5a4a00, alpha });
    }
    if (f.kind === 'gate' && f.props.jetBridge) {
      const jb = worldToMap(f.origin);
      g.circle(jb.x, jb.y, 0.18).fill({ color: 0x333333, alpha });
    }
    if (f.kind === 'boardingBridge') {
      // 機能H: 搭乗橋（PBB）を型式で描き分ける。トンネルは基部から向き（機体側）へ線を引き、
      // 2本型式は平行2線、上デッキの基は中央に白丸を重ねる。互換合成だけのゲートは従来の印（上の丸）のまま
      const base = worldToMap(f.origin);
      const spec = PBB_TYPES[pbbTypeOf(f)];
      const dir = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[f.rotation] as [number, number];
      const cx = base.x + 0.5;
      const cy = base.y + 0.5;
      for (const o of spec.tunnels === 2 ? [-0.16, 0.16] : [0]) {
        g.moveTo(cx - dir[0] * 0.3 - dir[1] * o, cy - dir[1] * 0.3 + dir[0] * o)
          .lineTo(cx + dir[0] * 0.45 - dir[1] * o, cy + dir[1] * 0.45 + dir[0] * o);
      }
      g.stroke({ width: this.px(2), color: 0x222222, alpha });
      if (pbbDeckOf(f) === 'upper') g.circle(cx, cy, 0.14).fill({ color: 0xffffff, alpha });
    }
    // 向き（入口側）を示す印: 回転の向きに小さな三角
    if (layer === 'building' && f.kind !== 'tower') {
      const cx = f.origin.x + d.w / 2;
      const cy = f.origin.y + d.h / 2;
      const dir = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[f.rotation] as [number, number];
      const tip = { x: cx + dir[0] * (d.w / 2 - 0.25), y: cy + dir[1] * (d.h / 2 - 0.25) };
      const base = { x: tip.x - dir[0] * 0.5, y: tip.y - dir[1] * 0.5 };
      g.poly([tip.x, tip.y, base.x - dir[1] * 0.35, base.y + dir[0] * 0.35, base.x + dir[1] * 0.35, base.y - dir[0] * 0.35]).fill({
        color: 0x000000,
        alpha: 0.35 * alpha,
      });
    }
    this.buildStateOutline(g, [x, y, x + w, y, x + w, y + h, x, y + h], f.buildState);
  }

  private drawStand(st: Stand, connected: boolean): void {
    const g = this.g;
    const d = standDims(st);
    // 画面外のスポットは描かない（枠・シルエット・入口の印はすべて矩形の内側に収まる）
    if (!this.boxInView(st.origin.x, st.origin.y, d.w, d.h, 0.3 + 3 / this.zoom)) return;
    const alpha = BUILD_ALPHA[st.buildState];
    const { x, y } = st.origin;
    g.rect(x + 0.05, y + 0.05, d.w - 0.1, d.h - 0.1).stroke({ width: this.px(1.5), color: COLOR.standLine, alpha: 0.85 * alpha });
    // 機体シルエット（機首方向を示す）。a = 機首方向の座標、b = 翼幅方向の座標
    const cx = x + d.w / 2;
    const cy = y + d.h / 2;
    const dir = { 0: [0, -1], 90: [1, 0], 180: [0, 1], 270: [-1, 0] }[st.rotation] as [number, number];
    const half = (st.rotation === 0 || st.rotation === 180 ? d.h : d.w) / 2 - 0.3;
    const span = (st.rotation === 0 || st.rotation === 180 ? d.w : d.h) / 2 - 0.2;
    const P = (a: number, b: number) => [cx + dir[0] * a * half - dir[1] * b * span, cy + dir[1] * a * half + dir[0] * b * span];
    const fill = { color: SIZE_COLOR[st.size], alpha: 0.75 * alpha };
    const fw = 0.1; // 胴体の半幅（翼幅比）
    g.poly([...P(1, 0), ...P(0.8, fw), ...P(-0.9, fw), ...P(-1, 0), ...P(-0.9, -fw), ...P(0.8, -fw)]).fill(fill);
    g.poly([...P(0.25, fw), ...P(-0.15, 1), ...P(-0.35, 1), ...P(-0.15, fw), ...P(-0.15, -fw), ...P(-0.35, -1), ...P(-0.15, -1), ...P(0.25, -fw)]).fill(fill);
    g.poly([...P(-0.7, fw), ...P(-0.95, 0.4), ...P(-1, 0.4), ...P(-0.9, 0), ...P(-1, -0.4), ...P(-0.95, -0.4), ...P(-0.7, -fw)]).fill(fill);
    // 入口（誘導路との接続点）
    const e = c(standEntry(st));
    g.circle(e.x, e.y, 0.2).fill({ color: connected ? COLOR.connected : COLOR.disconnected, alpha });
    this.buildStateOutline(g, [x, y, x + d.w, y, x + d.w, y + d.h, x, y + d.h], st.buildState);
  }

  /** 計画 = 白の破線枠、建設中 = 橙の破線枠 */
  private buildStateOutline(g: Graphics, poly: number[], state: BuildState): void {
    if (state === 'operational') return;
    const color = state === 'planned' ? COLOR.planned : COLOR.construction;
    for (let i = 0; i < poly.length; i += 2) {
      const a = { x: poly[i]!, y: poly[i + 1]! };
      const b = { x: poly[(i + 2) % poly.length]!, y: poly[(i + 3) % poly.length]! };
      this.dashed(g, a, b, 0.5, 0.35, { width: this.px(2), color, alpha: 0.95 });
    }
  }

  private edgeStateMarks(g: Graphics, a: Vec2, b: Vec2, state: BuildState): void {
    const color = state === 'planned' ? COLOR.planned : COLOR.construction;
    this.dashed(g, a, b, 0.4, 0.4, { width: this.px(3), color, alpha: 0.9 });
  }

  // ------------------------------------------------------------ オーバーレイ

  // ------------------------------------------------------------ 混雑マップ

  /**
   * 運航実績（analytics）から、滑走路・スポットの使用率、地上で止まった時間の多いノード、
   * 処理施設の平均待ち時間を色で示す。緑 → 黄 → 赤 の順に混雑。
   */
  private drawCongestion(layout: AirportLayout, ops: OpsState, cam: Camera, labels: boolean): void {
    const sim = ops.sim;
    if (!this.kpiCache || this.kpiCache.sim !== sim || Math.abs(this.kpiCache.now - sim.state.now) >= 30) {
      this.kpiCache = { now: sim.state.now, sim, k: airportKpis(sim) };
    }
    const k = this.kpiCache.k;
    const o = this.overlay;
    const heat = (v: number) => HEAT_COLORS[heatBand(v)];
    for (const r of k.runways) {
      const rw = layout.runways[r.id];
      if (!rw) continue;
      const poly = flat(worldPolyToMap(runwaySurfaces(rw, layout).pavement));
      o.poly(poly).fill({ color: heat(r.util), alpha: 0.35 });
      if (labels) this.label(`cg:${r.id}`, `使用率 ${Math.round(r.util * 100)}%`, c({ x: rw.start.x + 1, y: rw.start.y - 1 }), cam, { size: 11, color: 0xffffff });
    }
    for (const st of k.stands) {
      const stand = layout.stands[st.id];
      if (!stand) continue;
      const d = standDims(stand);
      o.rect(stand.origin.x, stand.origin.y, d.w, d.h).fill({ color: heat(st.util), alpha: 0.35 });
    }
    const maxWait = Math.max(1, ...k.hotspots.map((h) => h.waitMin));
    for (const h of k.hotspots) {
      const n = sim.ctx.network.nodes[h.node];
      if (!n || h.waitMin <= 0) continue;
      const p = c(n.pos);
      o.circle(p.x, p.y, 1 + 3 * (h.waitMin / maxWait)).fill({ color: heat(h.waitMin / 30), alpha: 0.45 });
      if (labels) this.label(`cgn:${h.node}`, `停止 ${h.waitMin}分`, { x: p.x + 1, y: p.y - 1 }, cam, { size: 10, color: 0xffe08a });
    }
    for (const f of k.facilities) {
      const a = layout.terminalAreas[f.id];
      if (!a || f.avgWaitMin === null) continue;
      o.rect(a.origin.x, a.origin.y, a.w, a.h).stroke({ width: this.px(3), color: heat(f.avgWaitMin / 15), alpha: 0.9 });
    }
    // 案2-2c: 直近日報の工程ピーク使用率でターミナルエリアを塗る（枠線の平均待ち表示と併用できるよう塗りにする）
    const report = sim.company?.reports[sim.company.reports.length - 1];
    for (const h of processAreaHeat(report, Object.values(layout.terminalAreas))) {
      const a = layout.terminalAreas[h.areaId];
      if (!a) continue;
      o.rect(a.origin.x, a.origin.y, a.w, a.h).fill({ color: heat(h.utilization), alpha: 0.3 });
    }
    // 案2-2b: 区間モデルの道路辺を、その時間帯の volume / capacity で色付けする。
    // 交通量は access runtime が経路選択のために記録済みの hourly['seg:<辺>:<時>'] を読むだけ（集計の追加なし）
    const acc = sim.state.access;
    if (acc?.segments) {
      const hour = Math.floor(sim.state.now / 3600);
      for (const load of segmentEdgeLoads(acc, hour)) {
        const e = layout.roads[load.edgeId];
        if (!e) continue;
        const a = layout.roadNodes[e.from];
        const b = layout.roadNodes[e.to];
        if (!a || !b) continue;
        o.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ width: mToTiles(roadDrawWidthM(e)), color: heat(load.ratio), alpha: 0.55, cap: 'round' });
        if (labels) {
          const mid = c({ x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 });
          this.label(`cgseg:${e.id}`, `道路 ${Math.round(load.ratio * 100)}%`, { x: mid.x, y: mid.y - 1 }, cam, { size: 10, color: 0xffffff });
        }
      }
    }
  }

  /**
   * 案2（建設モード）: 混雑マップ overlay が ON のとき、運航前でも根拠のあるものだけを描く。
   * - 2a: 区間モデルの静的ボトルネック辺（最も細い辺は赤、その他の経路ボトルネックは黄）
   * - 2c: 直近日報の工程ピーク使用率によるターミナルエリアの塗り（運航中と同じ定義）
   */
  private drawStaticHeat(layout: AirportLayout, s: EditorState, cam: Camera): void {
    const o = this.overlay;
    const heat = (v: number) => HEAT_COLORS[heatBand(v)];
    const report = s.company.reports[s.company.reports.length - 1];
    for (const h of processAreaHeat(report, Object.values(layout.terminalAreas))) {
      const a = layout.terminalAreas[h.areaId];
      if (!a) continue;
      o.rect(a.origin.x, a.origin.y, a.w, a.h).fill({ color: heat(h.utilization), alpha: 0.3 });
    }
    for (const b of staticBottlenecks(layout)) {
      const e = layout.roads[b.edgeId];
      if (!e) continue;
      const a = layout.roadNodes[e.from];
      const bb = layout.roadNodes[e.to];
      if (!a || !bb) continue;
      if (s.mapLevel !== 'all' && (a.level ?? 0) !== s.mapLevel && (bb.level ?? 0) !== s.mapLevel) continue;
      o.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(bb.pos).x, c(bb.pos).y).stroke({
        width: mToTiles(roadDrawWidthM(e)),
        color: b.global ? HEAT_COLORS[2] : HEAT_COLORS[1],
        alpha: b.global ? 0.75 : 0.55,
        cap: 'round',
      });
      if (b.global || s.overlays.labels) {
        const mid = c({ x: (a.pos.x + bb.pos.x) / 2, y: (a.pos.y + bb.pos.y) / 2 });
        this.label(`bn:${e.id}`, `ボトルネック ${b.capacityPerHour} 台/時${b.lanes ? `（${b.lanes}車線）` : ''}`, { x: mid.x, y: mid.y - 1 }, cam, { size: 11, color: 0xffffff });
      }
    }
  }

  /** 独立ゲート（connectedTo で接続されたゲート）から接続先の区域のエリアへの連絡通路を破線で描く（選択中は太く） */
  private drawConnectors(layout: AirportLayout, analysis: LayoutAnalysis, selection: string | null): void {
    const o = this.overlay;
    for (const cn of analysis.terminal.connectors ?? []) {
      const gate = layout.facilities[cn.gateId];
      if (!gate) continue;
      const from = worldToMap(gate.origin);
      const sel = selection === cn.gateId;
      for (const anchorId of [cn.depAnchor, cn.arrAnchor]) {
        const a = anchorId ? analysis.terminal.areas[anchorId] : undefined;
        if (!a) continue;
        const dx = a.center.x - from.x;
        const dy = a.center.y - from.y;
        const len = Math.hypot(dx, dy);
        const dash = 0.6;
        for (let t = 0; t < len; t += dash * 2) {
          const t2 = Math.min(len, t + dash);
          o.moveTo(from.x + (dx * t) / len, from.y + (dy * t) / len).lineTo(from.x + (dx * t2) / len, from.y + (dy * t2) / len);
        }
        o.stroke({ width: this.px(sel ? 3 : 1.5), color: anchorId === cn.depAnchor ? 0x7fdbff : 0xffd166, alpha: sel ? 0.95 : 0.7 });
      }
    }
  }

  /** Explicitly configured walkways between distinct terminal area graphs. */
  private drawTerminalTransit(layout: AirportLayout, selection: string | null): void {
    const g = this.overlay;
    for (const link of Object.values(layout.terminalLinks ?? {})) {
      const from = layout.terminalAreas[link.fromAreaId];
      const to = layout.terminalAreas[link.toAreaId];
      if (!from || !to) continue;
      const a = c({ x: from.origin.x + from.w / 2, y: from.origin.y + from.h / 2 });
      const b = c({ x: to.origin.x + to.w / 2, y: to.origin.y + to.h / 2 });
      const selected = selection === from.id || selection === to.id;
      const color = link.kind === 'movingWalkway' ? COLOR.selection : link.kind === 'elevatedWalkway' ? 0x7fdbff : COLOR.walkway;
      const alpha = BUILD_ALPHA[link.buildState];
      this.dashed(g, a, b, 0.65, 0.4, { width: this.px(selected ? 3 : 1.7), color, alpha });
      if (!link.bidirectional) this.arrow(g, a, b, color, alpha);
      for (const p of [a, b]) g.circle(p.x, p.y, this.px(selected ? 4 : 2.5)).fill({ color, alpha });
    }
  }

  /** 外形（フットプリント）編集中の作業ポリゴンと頂点ハンドル（5-15 T3）。有効=緑、不正=赤 */
  private drawFootprintEdit(s: EditorState): void {
    const fe = s.footprintEdit;
    if (!fe || fe.points.length === 0) return;
    const g = this.overlay;
    const pts = fe.points;
    const valid = validateOrthogonalPolygon(pts).length === 0;
    const color = valid ? COLOR.ghostOk : COLOR.ghostBad;
    g.poly(pts.flatMap((p) => [p.x, p.y])).fill({ color, alpha: 0.15 });
    for (let i = 0; i < pts.length; i++) {
      this.dashed(g, pts[i]!, pts[(i + 1) % pts.length]!, 0.4, 0.3, { width: this.px(2), color, alpha: 0.9 });
    }
    for (const p of pts) g.circle(p.x, p.y, this.px(5)).fill({ color }).stroke({ width: this.px(1), color: 0x000000 });
  }

  /** 歩行ポータル（5-16）の接続線。選択中の交通施設・エリアに関係するものだけを破線で描く */
  private drawPortalLinks(layout: AirportLayout, selection: string | null): void {
    if (!selection) return;
    const portals = Object.values(layout.portals ?? {}).filter((p) => p.facilityId === selection || p.areaId === selection);
    if (portals.length === 0) return;
    const g = this.overlay;
    for (const p of portals) {
      const f = layout.facilities[p.facilityId];
      const a = layout.terminalAreas[p.areaId];
      if (!f || !a) continue;
      const dims = facilityDims(f);
      const from = c({ x: f.origin.x + dims.w / 2, y: f.origin.y + dims.h / 2 });
      const to = c({ x: a.origin.x + a.w / 2, y: a.origin.y + a.h / 2 });
      const alpha = BUILD_ALPHA[p.buildState];
      this.dashed(g, from, to, 0.65, 0.4, { width: this.px(2.5), color: 0xc792ea, alpha });
      for (const pt of [from, to]) g.circle(pt.x, pt.y, this.px(4)).fill({ color: 0xc792ea, alpha });
    }
  }

  private drawNetwork(analysis: LayoutAnalysis): void {
    const o = this.overlay;
    for (const e of Object.values(analysis.network.edges)) {
      const a = c(analysis.network.nodes[e.from]!.pos);
      const b = c(analysis.network.nodes[e.to]!.pos);
      const color = e.maxSize ? SIZE_COLOR[e.maxSize] : COLOR.ghostBad;
      const width = this.px(e.kind === 'standLink' ? 2 : 3.5);
      if (e.operational) o.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width, color, alpha: 0.95 });
      else this.dashed(o, a, b, 0.5, 0.4, { width, color, alpha: 0.95 });
      if (!e.bidirectional) this.arrow(o, a, b, color, 1);
    }
    for (const n of Object.values(analysis.network.nodes)) {
      const p = c(n.pos);
      o.circle(p.x, p.y, this.px(4)).fill({ color: NODE_COLOR[n.kind] }).stroke({ width: this.px(1), color: 0x000000 });
    }
  }

  /**
   * 区間ごとに進む地上走行（taxiMode 'block'）の区切りの印と、運航中は区間の占有（機数 / 進入可能機数。M 機の値）。
   * 論理ネットワーク表示（network）に重ねる。従来方式の配置では何も描かない。
   */
  private drawTaxiBlocks(layout: AirportLayout, ops: OpsState | null | undefined, cam: Camera, labels: boolean): void {
    const graph = ops?.sim.ctx.blocks ?? blockGraphOf(layout);
    if (!graph) return;
    const o = this.overlay;
    const occ = ops?.sim.state.taxiBlocks?.occ;
    const at = (edgeId: string, m: number): Vec2 | null => {
      const e = layout.taxiways[edgeId];
      const a = e && layout.taxiNodes[e.from];
      const b = e && layout.taxiNodes[e.to];
      if (!e || !a || !b) return null;
      const len = distance(a.pos, b.pos) * TILE_M;
      const t = len > 0 ? Math.max(0, Math.min(1, m / len)) : 0;
      return c({ x: a.pos.x + (b.pos.x - a.pos.x) * t, y: a.pos.y + (b.pos.y - a.pos.y) * t });
    };
    const tick = (edgeId: string, m: number, color: number) => {
      const e = layout.taxiways[edgeId];
      const a = e && layout.taxiNodes[e.from];
      const b = e && layout.taxiNodes[e.to];
      const p = at(edgeId, m);
      if (!e || !a || !b || !p) return;
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const n = Math.hypot(dx, dy) || 1;
      const nx = -dy / n;
      const ny = dx / n;
      const h = 0.45;
      o.moveTo(p.x - nx * h, p.y - ny * h).lineTo(p.x + nx * h, p.y + ny * h).stroke({ width: this.px(2), color, alpha: 0.95 });
    };
    for (const b of Object.values(graph.blocks)) {
      const n = occ?.[b.id]?.length ?? 0;
      const cap = b.entry ? 0 : blockCapacity(b, 1, 'M');
      // 運航中: 空 = 緑、使用中 = 黄、満杯 = 赤。建設モード・入口の小片は区切りの色だけ
      const color = !ops || b.entry ? 0x9fb4c8 : n === 0 ? 0x66bb6a : n < cap ? 0xffd400 : 0xff4d4f;
      for (const sp of b.spans) {
        if (ops && !b.entry) {
          const pa = at(sp.edgeId, sp.fromM);
          const pb = at(sp.edgeId, sp.toM);
          if (pa && pb) o.moveTo(pa.x, pa.y).lineTo(pb.x, pb.y).stroke({ width: this.px(6), color, alpha: n > 0 ? 0.55 : 0.3 });
        }
        tick(sp.edgeId, sp.fromM, color);
        tick(sp.edgeId, sp.toM, color);
      }
      if (labels && !b.entry && this.zoom >= 6 && b.spans.length > 0) {
        const mid = b.spans[Math.floor(b.spans.length / 2)]!;
        const p = at(mid.edgeId, (mid.fromM + mid.toM) / 2);
        if (p) this.label(`blk:${b.id}`, ops ? `${n}/${cap}` : `${cap}`, { x: p.x, y: p.y - 0.55 }, cam, { size: 10, color: 0xd7e6f5 });
      }
    }
  }

  private drawIssues(layout: AirportLayout, analysis: LayoutAnalysis): void {
    const o = this.overlay;
    const errorTargets = new Set<string>();
    for (const iss of analysis.issues) {
      if (iss.severity === 'error') iss.targets.forEach((t) => errorTargets.add(t));
      if (!iss.at || iss.severity === 'info') continue;
      const p = c(iss.at);
      const r = Math.max(0.45, this.px(7));
      o.circle(p.x, p.y, r).fill({ color: SEVERITY_COLOR[iss.severity], alpha: 0.9 }).stroke({ width: this.px(1.5), color: 0xffffff });
      o.moveTo(p.x, p.y - r * 0.55).lineTo(p.x, p.y + r * 0.1).stroke({ width: this.px(2), color: 0xffffff });
      o.circle(p.x, p.y + r * 0.45, this.px(1.2)).fill({ color: 0xffffff });
    }
    for (const id of errorTargets) this.outline(o, layout, id, SEVERITY_COLOR.error, 2);
  }

  /** エンティティの形状に沿って強調線を描く（選択・プレビュー・エラー表示） */
  private outline(g: Graphics, layout: AirportLayout, id: string, color: number, widthPx: number): void {
    const style = { width: this.px(widthPx), color, alpha: 1 };
    switch (entityTypeOf(id)) {
      case 'facility': {
        const f = layout.facilities[id];
        if (!f) return;
        const d = facilityDims(f);
        g.rect(f.origin.x, f.origin.y, d.w, d.h).stroke(style);
        return;
      }
      case 'stand': {
        const st = layout.stands[id];
        if (!st) return;
        const d = standDims(st);
        g.rect(st.origin.x, st.origin.y, d.w, d.h).stroke(style);
        return;
      }
      case 'runway': {
        const r = layout.runways[id];
        if (!r) return;
        // 舗装の外形に加えて、判定の基準を見せる: 自由形は着陸帯と RESA の実寸の輪郭、従来形はゲームの占有範囲（破線）
        const sf = runwaySurfaces(r, layout);
        g.poly(flat(worldPolyToMap(sf.pavement))).stroke(style);
        const thin = { width: this.px(1.5), color, alpha: 0.7 };
        if (sf.footprint) {
          this.dashedPoly(g, worldPolyToMap(sf.footprint), color, 0.9);
          this.dashedPoly(g, worldPolyToMap(sf.strip), color, 0.9);
          return;
        }
        g.poly(flat(worldPolyToMap(sf.strip))).stroke(thin);
        for (const p of sf.resa) g.poly(flat(worldPolyToMap(p))).stroke({ ...thin, color: COLOR.resa });
        return;
      }
      case 'taxiway':
      case 'road': {
        const nodes = entityTypeOf(id) === 'taxiway' ? layout.taxiNodes : layout.roadNodes;
        const e = layout.taxiways[id] ?? layout.roads[id];
        const a = e && nodes[e.from];
        const b = e && nodes[e.to];
        if (!a || !b) return;
        g.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ ...style, width: 1.1, alpha: 0.45, cap: 'round' });
        return;
      }
      case 'terminalArea': {
        const a = layout.terminalAreas[id];
        if (a) g.rect(a.origin.x, a.origin.y, a.w, a.h).stroke(style);
        return;
      }
      case 'taxiNode':
      case 'roadNode': {
        const n: NetNode | undefined = layout.taxiNodes[id] ?? layout.roadNodes[id];
        if (n) g.circle(c(n.pos).x, c(n.pos).y, 0.45).stroke(style);
        return;
      }
    }
  }

  /** 進行中の操作（経路の頂点、矩形の始点など）とカーソル */
  private drawDraft(s: EditorState): void {
    const o = this.overlay;
    const d = s.draft;
    if (d?.kind === 'path') {
      for (const p of d.points) o.circle(c(p).x, c(p).y, 0.3).fill({ color: COLOR.ghostOk });
      if (s.hover && d.points.length > 0) {
        const next = c(s.tool === 'taxiway' ? nextTaxiPoint(s.history.present, d.points, s.hover) : nextPathPoint(d.points, s.hover));
        o.circle(next.x, next.y, 0.25).stroke({ width: this.px(2), color: COLOR.ghostOk });
      }
    }
    if (d?.kind === 'runway') o.circle(c(d.start).x, c(d.start).y, 0.4).fill({ color: COLOR.ghostOk });
    if (d?.kind === 'freeRunway') o.circle(c(d.start).x, c(d.start).y, 0.4).fill({ color: COLOR.ghostOk });
    // 選択中の自由形の端のハンドル（端 = 回転、Shift + 端 = 反対の端を固定）
    const sel = s.selection ? s.history.present.runways[s.selection] : undefined;
    if (sel && isFreeRunway(sel) && s.mode === 'build' && s.tool === 'select') {
      const ax = runwayAxis(sel);
      for (const p of [ax.start, ax.end]) {
        const q = c(p);
        o.circle(q.x, q.y, this.px(6)).fill({ color: 0xffffff, alpha: 0.95 }).stroke({ width: this.px(2), color: COLOR.selection });
      }
    }
    if (d?.kind === 'rect' && s.hover) {
      const r = rectFromDrag(d.start, s.hover);
      if (s.tool === 'land') {
        // 購入できる未取得地を塗る
        for (const t of offsiteTilesIn(s.history.present, d.start, s.hover)) o.rect(t.x, t.y, 1, 1).fill({ color: COLOR.ghostOk, alpha: 0.35 });
      }
      o.rect(r.origin.x, r.origin.y, r.w, r.h).stroke({ width: this.px(1.5), color: COLOR.ghostOk });
    }
    if (s.hover && s.tool !== 'select' && !facilityKindOf(s.tool)) {
      o.rect(s.hover.x, s.hover.y, 1, 1).stroke({ width: this.px(1.5), color: 0xffffff, alpha: 0.8 });
    }
  }

  // ------------------------------------------------------------ ラベル

  private label(key: string, text: string, world: Vec2, cam: Camera, opts: { size?: number; color?: number } = {}): void {
    let t = this.textPool.get(key);
    if (!t) {
      t = new Text({
        text,
        style: { fontFamily: 'system-ui, sans-serif', fontSize: opts.size ?? 12, fill: opts.color ?? 0xffffff, stroke: { color: 0x000000, width: 3 } },
        resolution: window.devicePixelRatio || 1,
      });
      t.anchor.set(0.5);
      this.textPool.set(key, t);
      this.labels.addChild(t);
    }
    if (t.text !== text) t.text = text;
    const p = worldToScreen(cam, world);
    t.position.set(Math.round(p.x), Math.round(p.y));
    this.usedTexts.add(key);
  }

  private drawLabels(layout: AirportLayout, analysis: LayoutAnalysis, cam: Camera): void {
    for (const r of Object.values(layout.runways)) {
      // 番号は端から内側へ min(0.1 × 長さ, 150 m)（3D と共有の runwaySurfaces）
      const [m0, m1] = runwaySurfaces(r, layout).designators;
      this.label(`rwy0:${r.id}`, m0!.text, c(m0!.pos), cam, { size: 13 });
      this.label(`rwy1:${r.id}`, m1!.text, c(m1!.pos), cam, { size: 13 });
    }
    if (cam.zoom >= 5) {
      // 誘導路名は同名区間のうち最長の区間に1つだけ
      const best = new Map<string, { len: number; mid: Vec2 }>();
      for (const e of Object.values(layout.taxiways)) {
        const a = layout.taxiNodes[e.from];
        const b = layout.taxiNodes[e.to];
        if (!e.name || !a || !b) continue;
        const len = distance(a.pos, b.pos);
        if ((best.get(e.name)?.len ?? -1) < len) best.set(e.name, { len, mid: c({ x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2 }) });
      }
      for (const [name, { mid }] of best) this.label(`twy:${name}`, name, mid, cam, { color: COLOR.taxiCenter });
    }
    if (cam.zoom >= 8) {
      for (const st of Object.values(layout.stands)) {
        const d = standDims(st);
        if (st.name) this.label(`std:${st.id}`, st.name, { x: st.origin.x + d.w / 2, y: st.origin.y + d.h / 2 }, cam, { size: 11 });
      }
      for (const id of visibleFacilityLabelIds(layout, this.mapLevel, this.interiorShown)) {
        const f = layout.facilities[id]!;
        const d = facilityDims(f);
        this.label(`fac:${f.id}`, f.name, { x: f.origin.x + d.w / 2, y: f.origin.y + d.h / 2 }, cam, { size: 11 });
      }
      for (const n of Object.values(layout.taxiNodes)) {
        if (n.name) this.label(`tn:${n.id}`, n.name, { x: c(n.pos).x + 0.8, y: c(n.pos).y - 0.6 }, cam, { size: 10, color: 0xffe082 });
      }
    }
    void analysis;
  }



  // ------------------------------------------------------------ ターミナル内部

  private drawInterior(layout: AirportLayout, s: EditorState, cam: Camera): void {
    const g = this.overlay;
    const level = s.interiorLevel;
    const ops = s.ops;
    const occupancy = ops ? areaOccupancy(ops.sim.state) : null;
    const closed = new Set(ops?.sim.state.closedAreas ?? []);
    for (const t of Object.values(layout.facilities)) {
      if (t.kind !== 'terminal') continue;
      const d = facilityDims(t);
      g.rect(t.origin.x, t.origin.y, d.w, d.h).fill({ color: 0x20262d, alpha: 0.85 });
      // 階ラベルはターミナルごとの建物内階（表示階 − そのターミナルの地図階層）で出す。
      // その階が建物の範囲外ならラベル自体を出さない（内外で階の意味が食い違わないように）
      const floor = level - facilityLevel(t);
      if (s.overlays.labels && terminalAreaLevelProblem(layout, t.id, floor) === null) {
        this.label(`lvl:${t.id}`, `${floorShortLabel(floor)} / ${Number(t.props.levels ?? 1)}階`, { x: t.origin.x + 1.2, y: t.origin.y - 0.6 }, cam, { size: 11, color: 0x9fd3ff });
      }
    }
    for (const a of Object.values(layout.terminalAreas)) {
      if (areaMapLevel(layout, a) !== level) continue;
      // 画面外のエリアは図形（塗り・混雑・閉鎖の斜線）を描かない。ラベルは中心基準で
      // 画面端に掛かりうるため、従来どおり常に出す（ラベル側の判定は変えない）
      const areaVisible = this.boxInView(a.origin.x, a.origin.y, a.w, a.h, 0.15 + 3 / this.zoom);
      if (areaVisible) {
        g.rect(a.origin.x + 0.05, a.origin.y + 0.05, a.w - 0.1, a.h - 0.1).fill({ color: AREA_COLOR[a.kind], alpha: 0.9 });
        g.rect(a.origin.x + 0.05, a.origin.y + 0.05, a.w - 0.1, a.h - 0.1).stroke({ width: this.px(1), color: ZONE_COLOR[a.zone], alpha: 0.9 });
      }
      if (occupancy && ops && areaVisible) {
        const node = ops.sim.ctx.terminal.areas[a.id];
        const load = node ? (occupancy.get(a.id) ?? 0) / node.capacity : 0;
        if (load > 0.25) g.rect(a.origin.x, a.origin.y, a.w, a.h).fill({ color: load > 1 ? 0xff3030 : 0xffb020, alpha: Math.min(0.55, load * 0.4) });
        if (closed.has(a.id)) {
          g.rect(a.origin.x, a.origin.y, a.w, a.h).stroke({ width: this.px(3), color: 0xff4d4f });
          for (let k = 0; k < a.w + a.h; k += 1) {
            const x0 = a.origin.x + Math.min(k, a.w);
            const y0 = a.origin.y + Math.max(0, k - a.w);
            const x1 = a.origin.x + Math.max(0, k - a.h);
            const y1 = a.origin.y + Math.min(k, a.h);
            g.moveTo(x0, y0).lineTo(x1, y1);
          }
          g.stroke({ width: this.px(1.5), color: 0xff4d4f, alpha: 0.7 });
        }
      }
      if (s.overlays.labels && this.zoom >= 6) {
        let text = a.name || AREA_SHORT[a.kind];
        if (ops) {
          const load = facilityLoad(ops.sim.state, a.id);
          const here = occupancy?.get(a.id) ?? 0;
          text += load.queued > 0 ? ` 待${load.queued}` : here > 0 ? ` ${here}人` : '';
        }
        this.label(`area:${a.id}`, text, { x: a.origin.x + a.w / 2, y: a.origin.y + a.h / 2 }, cam, { size: 10 });
      }
    }
    // 建物内の設備は、エリアの数に関係なく 1 度だけ描く（親の種類は問わない。その階にエリアが無くても描く）
    for (const id of visibleInteriorFacilityIds(layout, level)) {
      const f = layout.facilities[id]!;
      const d = facilityDims(f);
      // 画面外の設備は矩形を描かない（ラベルは従来どおり常に出す）
      if (this.boxInView(f.origin.x, f.origin.y, d.w, d.h, 0.3)) {
        g.rect(f.origin.x + 0.2, f.origin.y + 0.2, Math.max(0.6, d.w - 0.4), Math.max(0.6, d.h - 0.4))
          .fill({ color: FACILITY_COLOR[f.kind], alpha: BUILD_ALPHA[f.buildState] });
      }
      if (s.overlays.labels && f.name) this.label(`interior-fac:${f.id}`, f.name, { x: f.origin.x + d.w / 2, y: f.origin.y + d.h / 2 }, cam, { size: 9, color: 0xffffff });
    }
    if (ops) this.drawPax(ops, level);
  }

  /** 旅客グループの代表点（業務計算は sim、ここでは表示だけ）。level は表示中の絶対階層で、エリアの実効階層と比べる */
  private drawPax(ops: OpsState, level: number): void {
    const g = this.overlay;
    const { state, ctx } = ops.sim;
    const model = ctx.terminal;
    const layout = ctx.layout;
    const effLevel = (a: { terminalId: string; level: number }): number => {
      const t = layout.facilities[a.terminalId];
      return (t ? facilityLevel(t) : 0) + a.level;
    };
    for (const id of state.activePax) {
      const p = state.paxGroups[id]!;
      if (!p.area) continue;
      const here = model.areas[p.area];
      if (!here) continue;
      // 滞在中の代表点はエリア矩形の内側にある。矩形ごと画面外なら描くものはない
      if (p.state !== 'walking' && !this.boxInView(here.x, here.y, here.w, here.h, 0.3 + 2 / this.zoom)) continue;
      let x: number;
      let y: number;
      let onLevel = effLevel(here) === level;
      if (p.state === 'walking' && p.route.length > 0 && p.legLength > 0) {
        const next = model.areas[p.route[0]!]!;
        const link = linkBetween(model, here.id, next.id);
        const via = link?.via ?? next.center;
        const t = Math.min(1, p.legProgress / p.legLength);
        const d1 = Math.hypot(via.x - here.center.x, via.y - here.center.y);
        const d2 = Math.hypot(next.center.x - via.x, next.center.y - via.y);
        const k = d1 + d2 > 0 ? t * (d1 + d2) : 0;
        if (k <= d1) {
          x = here.center.x + (via.x - here.center.x) * (d1 > 0 ? k / d1 : 0);
          y = here.center.y + (via.y - here.center.y) * (d1 > 0 ? k / d1 : 0);
        } else {
          x = via.x + (next.center.x - via.x) * (d2 > 0 ? (k - d1) / d2 : 0);
          y = via.y + (next.center.y - via.y) * (d2 > 0 ? (k - d1) / d2 : 0);
          onLevel = effLevel(next) === level;
        }
      } else {
        // 滞在中: エリア内の決定的な位置にばらす
        const h = hash(p.id);
        x = here.x + 0.2 + ((h % 997) / 997) * Math.max(0.1, here.w - 0.4);
        y = here.y + 0.2 + (((h >> 10) % 991) / 991) * Math.max(0.1, here.h - 0.4);
      }
      if (!onLevel) continue;
      // 画面外の点は描かない（半径は最大でも margin の内側）
      if (!this.pointInView(x, y, 0.3 + 2 / this.zoom)) continue;
      const color =
        p.state === 'stranded' || p.state === 'waitingFacility' ? 0xff4d4f : p.direction === 'departure' ? 0xffb74d : 0x4fc3f7;
      g.circle(x, y, Math.max(this.px(2), 0.06 + 0.03 * p.count)).fill({ color, alpha: 0.95 });
    }
  }

  // ------------------------------------------------------------ 運航

  private drawOps(ops: OpsState, cam: Camera, showReservations: boolean): void {
    this.typeTable = ops.sim.ctx.types;
    const o = this.overlay;
    const { sim } = ops;
    const net = sim.ctx.network;
    const node = (id: string) => c(net.nodes[id]!.pos);

    // 滑走路の状態: 占有中 = 赤、進入予約 = 黄
    for (const [rid, rs] of Object.entries(sim.state.runways)) {
      const r = sim.ctx.layout.runways[rid];
      if (!r) continue;
      const poly = flat(worldPolyToMap(runwaySurfaces(r, sim.ctx.layout).pavement));
      // 画面外の滑走路は状態の輪郭を描かない
      if (!this.flatPolyInView(poly, 0.3 + 3 / this.zoom)) continue;
      if (rs.occupant) o.poly(poly).stroke({ width: this.px(3), color: 0xff4d4f });
      else if (rs.booking) o.poly(poly).stroke({ width: this.px(3), color: 0xffd400 });
    }

    // 予約中の区間（論理ネットワーク表示時）
    if (showReservations) {
      for (const [eid, acId] of Object.entries(sim.state.edgeReservations)) {
        const e = net.edges[eid];
        if (!e) continue;
        const a = node(e.from);
        const b = node(e.to);
        if (!this.segInView(a.x, a.y, b.x, b.y, 0.2 + 3 / this.zoom)) continue;
        o.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: this.px(5), color: aircraftColor(acId), alpha: 0.55 });
      }
      for (const [nid, acId] of Object.entries(sim.state.nodeReservations)) {
        const p = node(nid);
        if (!this.pointInView(p.x, p.y, 0.2 + 6 / this.zoom)) continue;
        o.circle(p.x, p.y, this.px(6)).stroke({ width: this.px(2), color: aircraftColor(acId) });
      }
    }

    // 選択中の機体の残りの経路と予約
    const sel = ops.selectedAircraft ? sim.state.aircraft[ops.selectedAircraft] : undefined;
    if (sel?.route && isVisible(sel)) {
      const r = sel.route;
      const here = pointAt(sim.ctx, r, Math.min(sel.dist, r.cum[r.cum.length - 1]!));
      const hereMap = worldToMap(here);
      o.moveTo(hereMap.x, hereMap.y);
      for (let i = edgeIndexAt(r, sel.dist) + 1; i < r.nodes.length; i++) {
        const p = node(r.nodes[i]!);
        o.lineTo(p.x, p.y);
      }
      o.stroke({ width: this.px(3), color: COLOR.selection, alpha: 0.9 });
      for (const [nid, acId] of Object.entries(sim.state.nodeReservations)) {
        if (acId !== sel.id) continue;
        const p = node(nid);
        o.circle(p.x, p.y, this.px(5)).fill({ color: COLOR.selection, alpha: 0.8 });
      }
    }

    // 作業車両（待機中は基地にいるので描かない）。手荷物牽引車は積んでいる個数を表示
    const cartBags = new Map<string, number>();
    for (const id of sim.state.activeBags) {
      const b = sim.state.bags[id]!;
      if (b.state === 'onCart') cartBags.set(b.location.slice('cart:'.length), (cartBags.get(b.location.slice('cart:'.length)) ?? 0) + 1);
    }
    for (const u of Object.values(sim.state.units)) {
      if (u.kind === 'staff' || u.status === 'idle') continue;
      const { x, y } = worldToMap(u);
      // 画面外の車両は描かない（台数ラベルは車両の真上に出るため、余白にその分も含める）
      if (!this.pointInView(x, y, 2.2)) continue;
      const color = u.status === 'broken' ? 0xff4d4f : UNIT_COLOR[u.kind];
      // ランプバスは他の車両の 2 倍の長さ。乗車中の人数を表示
      if (u.kind === 'apronBus') {
        o.rect(x - 0.56, y - 0.2, 1.12, 0.4).fill({ color }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.7 });
        const trip = u.trip ? sim.state.bus?.trips[u.trip] : undefined;
        if (trip && trip.pax > 0 && this.zoom >= 8) this.label(`bus:${u.id}`, `🚌${trip.pax}`, { x, y: y - 0.7 }, cam, { size: 10, color: 0xbfe1ff });
        continue;
      }
      o.rect(x - 0.28, y - 0.18, 0.56, 0.36).fill({ color }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.7 });
      const n = cartBags.get(u.id);
      if (n && this.zoom >= 8) this.label(`cart:${u.id}`, `🧳${n}`, { x, y: y - 0.6 }, cam, { size: 10, color: 0xffe082 });
    }

    // 機体（前ティックと現ティックの間を補間）
    const alpha = ops.clock.acc;
    const list = Object.values(sim.state.aircraft).filter(isVisible);
    for (const ac of list) {
      const { x, y } = worldToMap({ x: ac.px + (ac.x - ac.px) * alpha, y: ac.py + (ac.y - ac.py) * alpha });
      // 画面外の機体はシルエットを描かない（外接範囲は機首方向の半長 + 翼幅の半分が上限）。
      // コールサインは画面端に掛かりうるためシルエットとは別に判定し、見える範囲なら従来どおり出す
      const t = resolveType(this.typeTable ?? AIRCRAFT_TYPES, ac.typeId);
      const extent = Math.max(0.5, t.lengthM / 25 / 2) + Math.max(0.5, t.wingspanM / 25 / 2);
      const bodyVisible = this.boxInView(x - extent, y - extent, extent * 2, extent * 2, 0.3 + 3 / this.zoom);
      const showLabel = this.zoom >= 6 || ac.id === ops.selectedAircraft;
      const labelVisible = showLabel && this.pointInView(x, y - 1.4, 30 / this.zoom);
      if (!bodyVisible && !labelVisible) continue;
      if (bodyVisible) {
        const dh = ((ac.heading - ac.pheading + 540) % 360) - 180;
        const heading = ac.pheading + dh * alpha;
        this.drawAircraft(ac, x, y, heading, ac.id === ops.selectedAircraft);
      }
      if (labelVisible) {
        this.label(`ac:${ac.id}`, ac.callsign, { x, y: y - 1.4 }, cam, { size: 11, color: 0xffffff });
      }
    }
  }

  private drawAircraft(ac: Aircraft, x: number, y: number, heading: number, selected: boolean): void {
    const g = this.overlay;
    const t = resolveType(this.typeTable ?? AIRCRAFT_TYPES, ac.typeId);
    const half = Math.max(0.5, t.lengthM / 25 / 2);
    const span = Math.max(0.5, t.wingspanM / 25 / 2);
    const rad = (heading * Math.PI) / 180;
    const fx = Math.sin(rad);
    const fy = -Math.cos(rad);
    // a: 機首方向、b: 右翼方向
    const P = (a: number, b: number) => [x + fx * a * half - fy * b * span, y + fy * a * half + fx * b * span];
    const fw = 0.12;
    const poly = [
      ...P(1, 0), ...P(0.75, fw), ...P(0.2, fw), ...P(-0.15, 1), ...P(-0.35, 1), ...P(-0.2, fw), ...P(-0.7, fw),
      ...P(-0.95, 0.4), ...P(-1, 0.4), ...P(-0.92, 0), ...P(-1, -0.4), ...P(-0.95, -0.4), ...P(-0.7, -fw),
      ...P(-0.2, -fw), ...P(-0.35, -1), ...P(-0.15, -1), ...P(0.2, -fw), ...P(0.75, -fw),
    ];
    const color = aircraftStateColor(ac);
    g.poly(poly).fill({ color, alpha: 0.95 });
    const outline = selected ? COLOR.selection : ac.holdReason ? 0xff4d4f : 0x000000;
    g.poly(poly).stroke({ width: this.px(selected || ac.holdReason ? 2.5 : 1), color: outline, alpha: selected || ac.holdReason ? 1 : 0.6 });
  }

  // ------------------------------------------------------------ 描画補助

  private dashed(g: Graphics, a: Vec2, b: Vec2, dash: number, gap: number, style: { width: number; color: number; alpha?: number }): void {
    const len = distance(a, b);
    if (len < 1e-6) return;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    for (let t = 0; t < len; t += dash + gap) {
      const t2 = Math.min(len, t + dash);
      g.moveTo(a.x + ux * t, a.y + uy * t).lineTo(a.x + ux * t2, a.y + uy * t2);
    }
    g.stroke(style);
  }

  private arrow(g: Graphics, a: Vec2, b: Vec2, color: number, alpha: number): void {
    const len = distance(a, b);
    if (len < 1e-6) return;
    const ux = (b.x - a.x) / len;
    const uy = (b.y - a.y) / len;
    const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = 0.35;
    g.poly([m.x + ux * s, m.y + uy * s, m.x - ux * s - uy * s, m.y - uy * s + ux * s, m.x - ux * s + uy * s, m.y - uy * s - ux * s]).fill({ color, alpha });
  }
}

const flat = (pts: Vec2[]): number[] => pts.flatMap((p) => [p.x, p.y]);

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const AREA_COLOR: Record<TerminalAreaKind, number> = {
  entrance: 0x3d6b4a,
  exit: 0x3d5a6b,
  checkIn: 0x5a6b3d,
  security: 0x7a4a2a,
  departureLobby: 0x5a3d6b,
  waiting: 0x6b3d5a,
  restroom: 0x3d6b6b,
  arrivalCorridor: 0x2a4a6b,
  movingWalkway: 0x2a7a8a,
  baggageClaim: 0x2a6b5a,
  hall: 0x4a4f55,
  stairs: 0x8a6a2a,
  escalator: 0x8a7a2a,
  elevator: 0x8a6a2a,
  shop: 0x9a5a2a,
  restaurant: 0xa0603a,
  lounge: 0x7a5a8a,
  emigration: 0x2a7a5a,
  immigration: 0x2a5a7a,
  customs: 0x7a2a4a,
  transferSecurity: 0x5a2a7a,
};
const ZONE_COLOR: Record<PaxZone, number> = { landside: 0x9be7a8, departure: 0xe0a0ff, arrival: 0x8fd3ff, departureIntl: 0xffa0c0, arrivalIntl: 0xa0e7ff };
const AREA_SHORT = AREA_KIND_LABEL;

/** 作業車両の色 */
const UNIT_COLOR: Record<UnitKind, number> = {
  apronBus: 0x2b8cff,
  staff: 0xffffff,
  engineer: 0x9575cd,
  tug: 0xffeb3b,
  beltLoader: 0x8d6e63,
  baggageTractor: 0xff7043,
  fuelTruck: 0xe53935,
  cateringTruck: 0x26a69a,
  cleaningVan: 0x42a5f5,
};

/** 状態ごとの機体色: 到着系 = 水色、駐機・準備 = 白、出発系 = 橙、空中 = 薄青 */
function aircraftStateColor(ac: Aircraft): number {
  switch (ac.state) {
    case 'inbound':
    case 'holding':
    case 'approach':
      return 0xb3e5fc;
    case 'landing':
    case 'vacating':
    case 'taxiIn':
    case 'docking':
      return 0x4fc3f7;
    case 'parked':
    case 'turnaround':
    case 'readyForPushback':
      return 0xeeeeee;
    default:
      return 0xffb74d;
  }
}

/** 機体ごとの区別用の色（予約表示） */
function aircraftColor(id: string): number {
  const n = Number(id.slice(id.indexOf('_') + 1));
  const palette = [0xff8a65, 0x4db6ac, 0xba68c8, 0xffd54f, 0x64b5f6, 0xaed581, 0xf06292, 0x90a4ae];
  return palette[n % palette.length]!;
}
