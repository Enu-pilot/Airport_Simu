import { Application, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { Camera } from '../core/geometry/camera';
import { worldToScreen } from '../core/geometry/camera';
import { distance, type Tile, type Vec2 } from '../core/geometry/vec';
import { FACILITY_SPECS, STRIP_HALF_WIDTH } from '../core/model/catalog';
import { isBuildable } from '../core/model/site';
import type { AirportLayout, BuildState, Facility, NetNode, PaxZone, Site, Stand, TerminalAreaKind } from '../core/model/types';
import { entityTypeOf } from '../core/model/types';
import { facilityDims, standDims, standEntry } from '../core/layout/footprint';
import { offsiteTilesIn } from '../core/layout/operations';
import { runwayDesignators, runwayEnd, runwayPolygon, runwayStripPolygon, headingVector } from '../core/layout/runway';
import type { LayoutAnalysis } from '../core/validation/validate';
import { COLOR, FACILITY_COLOR, NODE_COLOR, SEVERITY_COLOR, SIZE_COLOR, TERRAIN_COLOR } from './colors';
import { computePreview, facilityKindOf, nextPathPoint, rectFromDrag } from '../editor/tools';
import { getAnalysis, type EditorState, type OpsState } from '../editor/store';
import { AIRCRAFT_TYPES } from '../core/sim/aircraftTypes';
import { isVisible } from '../core/sim/query';
import { edgeIndexAt, pointAt } from '../core/sim/routes';
import type { Aircraft, UnitKind } from '../core/sim/types';
import { areaOccupancy, facilityLoad } from '../core/sim/passengers';
import { linkBetween } from '../core/terminal/route';
import { AREA_KIND_LABEL } from '../i18n/ja';

/**
 * PixiJS による空港マップ描画。シミュレーション・編集の状態は一切変更せず、
 * EditorState を受け取って毎回描き直す（編集エディタの規模では十分高速）。
 *
 * world コンテナはタイル単位で描画し、カメラに合わせて拡大・平行移動する。
 * 線幅などの画面上の太さは px(n) = n / zoom でタイル単位に換算する。
 */

/** ノード・エッジはタイル中心に描く */
const c = (t: Tile): Vec2 => ({ x: t.x + 0.5, y: t.y + 0.5 });

const BUILD_ALPHA: Record<BuildState, number> = { operational: 1, underConstruction: 0.8, planned: 0.45 };

export class MapRenderer {
  readonly app = new Application();
  private world = new Container();
  private terrain = new Sprite();
  private buildable = new Sprite();
  private g = new Graphics();
  private overlay = new Graphics();
  private labels = new Container();
  private textPool = new Map<string, Text>();
  private usedTexts = new Set<string>();
  private terrainSite: Site | null = null;
  private zoom = 1;
  private interiorShown = false;

  async init(host: HTMLElement): Promise<void> {
    await this.app.init({
      background: COLOR.background,
      resizeTo: host,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    host.appendChild(this.app.canvas);
    this.world.addChild(this.terrain, this.buildable, this.g, this.overlay);
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
    this.world.scale.set(cam.zoom);
    this.world.position.set(-cam.x * cam.zoom, -cam.y * cam.zoom);
    this.usedTexts.clear();
    this.interiorShown = s.overlays.interior;

    this.updateTerrain(layout.site);
    this.buildable.visible = s.overlays.buildable;
    const g = this.g;
    const o = this.overlay;
    g.clear();
    o.clear();

    if (s.overlays.grid) this.drawGrid(cam, s.viewSize, layout.site);
    this.drawLayout(layout, analysis, s);
    if (s.overlays.interior) this.drawInterior(layout, s, cam);
    if (s.overlays.network) this.drawNetwork(analysis);
    if (s.overlays.issues) this.drawIssues(layout, analysis);

    // 選択
    if (s.selection && !ghostIds.has(s.selection)) this.outline(o, layout, s.selection, COLOR.selection, 3);
    // プレビュー（緑 = 配置可能、赤 = エラーあり）
    for (const id of ghostIds) {
      const bad = (analysis.byTarget[id] ?? []).some((i) => i.severity === 'error');
      this.outline(o, layout, id, bad ? COLOR.ghostBad : COLOR.ghostOk, 3);
    }
    this.drawDraft(s);
    if (s.overlays.labels) this.drawLabels(layout, analysis, cam);
    if (s.ops) this.drawOps(s.ops, cam, s.overlays.network);
    for (const [k, t] of this.textPool) t.visible = this.usedTexts.has(k);
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
    const facilities = Object.values(layout.facilities);
    const byLayer = (layer: string) => facilities.filter((f) => FACILITY_SPECS[f.kind].layer === layer);

    // 滑走路保護区域
    for (const r of Object.values(layout.runways)) {
      g.poly(flat(runwayStripPolygon(r).map(c))).fill({ color: COLOR.strip, alpha: 0.05 });
      g.poly(flat(runwayStripPolygon(r).map(c))).stroke({ width: this.px(1), color: COLOR.strip, alpha: 0.25 });
    }
    // エリア
    for (const f of [...byLayer('apron'), ...byLayer('area')]) this.drawFacility(f);

    // 滑走路
    for (const r of Object.values(layout.runways)) {
      const a = BUILD_ALPHA[r.buildState];
      const poly = flat(runwayPolygon(r).map(c));
      g.poly(poly).fill({ color: COLOR.runway, alpha: a });
      g.poly(poly).stroke({ width: this.px(1.5), color: COLOR.runwayMarking, alpha: 0.7 * a });
      const s0 = c(r.start);
      const e0 = c(runwayEnd(r));
      const v = headingVector(r.heading);
      const len = Math.hypot(v.x, v.y);
      const u = { x: v.x / len, y: v.y / len };
      const n = { x: -u.y, y: u.x };
      this.dashed(g, add(s0, scale(u, 3)), add(e0, scale(u, -3)), 1.5, 1.2, { width: this.px(2), color: COLOR.runwayMarking, alpha: a });
      // 進入端の標識
      for (const [p, dir] of [[s0, 1], [e0, -1]] as const) {
        for (let k = -1; k <= 1; k += 0.5) {
          const q = add(p, scale(n, k));
          g.moveTo(q.x, q.y).lineTo(q.x + u.x * dir * 1.4, q.y + u.y * dir * 1.4);
        }
        g.stroke({ width: this.px(2), color: COLOR.runwayMarking, alpha: a });
      }
      this.buildStateOutline(g, poly, r.buildState);
    }

    // 道路
    for (const e of Object.values(layout.roads)) {
      const a = layout.roadNodes[e.from];
      const b = layout.roadNodes[e.to];
      if (!a || !b) continue;
      const alpha = BUILD_ALPHA[e.buildState];
      if (e.roadClass === 'rail') {
        // 鉄道: 細い道床と枕木
        g.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ width: 0.5, color: COLOR.rail, alpha, cap: 'round' });
        this.dashed(g, c(a.pos), c(b.pos), 0.15, 0.35, { width: 0.8, color: COLOR.rail, alpha: 0.8 * alpha });
        if (e.buildState !== 'operational') this.edgeStateMarks(g, c(a.pos), c(b.pos), e.buildState);
        continue;
      }
      const color = e.roadClass === 'public' ? COLOR.roadPublic : COLOR.roadService;
      g.moveTo(c(a.pos).x, c(a.pos).y).lineTo(c(b.pos).x, c(b.pos).y).stroke({ width: 0.9, color, alpha, cap: 'round' });
      if (e.roadClass === 'public') {
        this.dashed(g, c(a.pos), c(b.pos), 0.6, 0.6, { width: this.px(1), color: COLOR.roadMarking, alpha: 0.6 * alpha });
      }
      if (e.oneWay) this.arrow(g, c(a.pos), c(b.pos), COLOR.roadMarking, alpha);
      if (e.buildState !== 'operational') this.edgeStateMarks(g, c(a.pos), c(b.pos), e.buildState);
    }

    // 誘導路
    const taxiWidth = { S: 0.55, M: 0.75, L: 0.95 };
    for (const e of Object.values(layout.taxiways)) {
      const a = layout.taxiNodes[e.from];
      const b = layout.taxiNodes[e.to];
      if (!a || !b) continue;
      const alpha = BUILD_ALPHA[e.buildState];
      const p = c(a.pos);
      const q = c(b.pos);
      g.moveTo(p.x, p.y).lineTo(q.x, q.y).stroke({ width: taxiWidth[e.widthClass] + this.px(2), color: COLOR.taxiwayEdge, alpha, cap: 'round' });
      g.moveTo(p.x, p.y).lineTo(q.x, q.y).stroke({ width: taxiWidth[e.widthClass], color: COLOR.taxiway, alpha, cap: 'round' });
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
      const t = Math.min(STRIP_HALF_WIDTH, d * 0.8) / d;
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
        const kind = analysis.network.nodes[n.id]?.kind ?? 'taxiway';
        const r = kind === 'taxiway' ? 0.14 : 0.22;
        g.circle(c(n.pos).x, c(n.pos).y, r).fill({ color: NODE_COLOR[kind] }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.6 });
      }
      for (const n of Object.values(layout.roadNodes)) {
        g.circle(c(n.pos).x, c(n.pos).y, 0.14).fill({ color: 0xd7ccc8 }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.6 });
      }
    }
  }

  private drawFacility(f: Facility): void {
    const g = this.g;
    const d = facilityDims(f);
    const alpha = BUILD_ALPHA[f.buildState];
    const color = FACILITY_COLOR[f.kind];
    const layer = FACILITY_SPECS[f.kind].layer;
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
      g.circle(f.origin.x + 0.5, f.origin.y + 0.5, 0.18).fill({ color: 0x333333, alpha });
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
        if (r) g.poly(flat(runwayPolygon(r).map(c))).stroke(style);
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
        const next = c(nextPathPoint(d.points, s.hover));
        o.circle(next.x, next.y, 0.25).stroke({ width: this.px(2), color: COLOR.ghostOk });
      }
    }
    if (d?.kind === 'runway') o.circle(c(d.start).x, c(d.start).y, 0.4).fill({ color: COLOR.ghostOk });
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
      const [d0, d1] = runwayDesignators(r.heading);
      const v = headingVector(r.heading);
      const len = Math.hypot(v.x, v.y);
      const s0 = c(r.start);
      const e0 = c(runwayEnd(r));
      this.label(`rwy0:${r.id}`, d0, { x: s0.x + (v.x / len) * 3, y: s0.y + (v.y / len) * 3 }, cam, { size: 13 });
      this.label(`rwy1:${r.id}`, d1, { x: e0.x - (v.x / len) * 3, y: e0.y - (v.y / len) * 3 }, cam, { size: 13 });
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
      for (const f of Object.values(layout.facilities)) {
        if (!f.name || f.kind === 'gate' || (f.kind === 'terminal' && this.interiorShown)) continue;
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
      if (s.overlays.labels) this.label(`lvl:${t.id}`, `${level + 1}F / ${Number(t.props.levels ?? 1)}階`, { x: t.origin.x + 1.2, y: t.origin.y - 0.6 }, cam, { size: 11, color: 0x9fd3ff });
    }
    for (const a of Object.values(layout.terminalAreas)) {
      if (a.level !== level) continue;
      g.rect(a.origin.x + 0.05, a.origin.y + 0.05, a.w - 0.1, a.h - 0.1).fill({ color: AREA_COLOR[a.kind], alpha: 0.9 });
      g.rect(a.origin.x + 0.05, a.origin.y + 0.05, a.w - 0.1, a.h - 0.1).stroke({ width: this.px(1), color: ZONE_COLOR[a.zone], alpha: 0.9 });
      if (occupancy && ops) {
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
    if (ops) this.drawPax(ops, level);
  }

  /** 旅客グループの代表点（業務計算は sim、ここでは表示だけ） */
  private drawPax(ops: OpsState, level: number): void {
    const g = this.overlay;
    const { state, ctx } = ops.sim;
    const model = ctx.terminal;
    for (const id of state.activePax) {
      const p = state.paxGroups[id]!;
      if (!p.area) continue;
      const here = model.areas[p.area];
      if (!here) continue;
      let x: number;
      let y: number;
      let onLevel = here.level === level;
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
          onLevel = next.level === level;
        }
      } else {
        // 滞在中: エリア内の決定的な位置にばらす
        const h = hash(p.id);
        x = here.x + 0.2 + ((h % 997) / 997) * Math.max(0.1, here.w - 0.4);
        y = here.y + 0.2 + (((h >> 10) % 991) / 991) * Math.max(0.1, here.h - 0.4);
      }
      if (!onLevel) continue;
      const color =
        p.state === 'stranded' || p.state === 'waitingFacility' ? 0xff4d4f : p.direction === 'departure' ? 0xffb74d : 0x4fc3f7;
      g.circle(x, y, Math.max(this.px(2), 0.06 + 0.03 * p.count)).fill({ color, alpha: 0.95 });
    }
  }

  // ------------------------------------------------------------ 運航

  private drawOps(ops: OpsState, cam: Camera, showReservations: boolean): void {
    const o = this.overlay;
    const { sim } = ops;
    const net = sim.ctx.network;
    const node = (id: string) => c(net.nodes[id]!.pos);

    // 滑走路の状態: 占有中 = 赤、進入予約 = 黄
    for (const [rid, rs] of Object.entries(sim.state.runways)) {
      const r = sim.ctx.layout.runways[rid];
      if (!r) continue;
      const poly = flat(runwayPolygon(r).map(c));
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
        o.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: this.px(5), color: aircraftColor(acId), alpha: 0.55 });
      }
      for (const [nid, acId] of Object.entries(sim.state.nodeReservations)) {
        const p = node(nid);
        o.circle(p.x, p.y, this.px(6)).stroke({ width: this.px(2), color: aircraftColor(acId) });
      }
    }

    // 選択中の機体の残りの経路と予約
    const sel = ops.selectedAircraft ? sim.state.aircraft[ops.selectedAircraft] : undefined;
    if (sel?.route && isVisible(sel)) {
      const r = sel.route;
      const here = pointAt(sim.ctx, r, Math.min(sel.dist, r.cum[r.cum.length - 1]!));
      o.moveTo(here.x + 0.5, here.y + 0.5);
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
      const x = u.x + 0.5;
      const y = u.y + 0.5;
      const color = u.status === 'broken' ? 0xff4d4f : UNIT_COLOR[u.kind];
      o.rect(x - 0.28, y - 0.18, 0.56, 0.36).fill({ color }).stroke({ width: this.px(1), color: 0x000000, alpha: 0.7 });
      const n = cartBags.get(u.id);
      if (n && this.zoom >= 8) this.label(`cart:${u.id}`, `🧳${n}`, { x, y: y - 0.6 }, cam, { size: 10, color: 0xffe082 });
    }

    // 機体（前ティックと現ティックの間を補間）
    const alpha = ops.clock.acc;
    const list = Object.values(sim.state.aircraft).filter(isVisible);
    for (const ac of list) {
      const x = ac.px + (ac.x - ac.px) * alpha + 0.5;
      const y = ac.py + (ac.y - ac.py) * alpha + 0.5;
      const dh = ((ac.heading - ac.pheading + 540) % 360) - 180;
      const heading = ac.pheading + dh * alpha;
      this.drawAircraft(ac, x, y, heading, ac.id === ops.selectedAircraft);
      if (this.zoom >= 6 || ac.id === ops.selectedAircraft) {
        this.label(`ac:${ac.id}`, ac.callsign, { x, y: y - 1.4 }, cam, { size: 11, color: 0xffffff });
      }
    }
  }

  private drawAircraft(ac: Aircraft, x: number, y: number, heading: number, selected: boolean): void {
    const g = this.overlay;
    const t = AIRCRAFT_TYPES[ac.typeId];
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
  baggageClaim: 0x2a6b5a,
  hall: 0x4a4f55,
  escalator: 0x8a7a2a,
  elevator: 0x8a6a2a,
  shop: 0x9a5a2a,
  restaurant: 0xa0603a,
};
const ZONE_COLOR: Record<PaxZone, number> = { landside: 0x9be7a8, departure: 0xe0a0ff, arrival: 0x8fd3ff };
const AREA_SHORT = AREA_KIND_LABEL;

/** 作業車両の色 */
const UNIT_COLOR: Record<UnitKind, number> = {
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
const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
