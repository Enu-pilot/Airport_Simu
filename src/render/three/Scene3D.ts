import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { bearingToSceneYawRad, tilesToM, worldPolyToScene, worldToScene } from '../../core/geometry/frames';
import { type AirportLayout, type Facility } from '../../core/model/types';
import { elevationOf, facilityLevel, facilityVerticalRange, levelOf } from '../../core/model/levels';
import { facilityDims, standDims } from '../../core/layout/footprint';
import { bandSurface, roadBandSurface, roadDrawWidthM, runwaySurfaces, taxiwayBandSurface } from '../../core/layout/surfaces';
import { resolveType, type AircraftType } from '../../core/sim/aircraftTypes';
import { isVisible } from '../../core/sim/query';
import type { Aircraft, UnitKind } from '../../core/sim/types';
import { AIRBORNE_STATES } from '../../core/sim/types';
import { modelOf } from '../../core/aircraft/catalog';
import { assetOf, liveryOf } from '../../core/assets/registry';
import type { EditorState, OpsState } from '../../editor/store';
import { FACILITY_COLOR, TERRAIN_COLOR } from '../colors';
import { aircraftObject, geometryCacheSize } from './aircraftMesh';
import { daylight } from '../daylight';
import { blockGraphOf } from '../../core/layout/blockGraph';
import { blockCapacity } from '../../core/sim/taxiBlocks';

/**
 * 3D 表示（Phase 9）。レイアウト（論理データ）から施設を組み立て、機体・車両の位置はシミュレーションの状態を
 * そのまま読む（3D 側で動きを計算しない）。2D と同じ EditorState を受け取り、状態は変更しない。
 *
 * 座標: 1 単位 = 1 m。World 座標の点は frames.ts の worldToScene で変換する（タイル (x, y) の中心 → (x + 0.5) × 25）。
 * 機首方位 h（0 = 北 = 画面上）→ Y 軸まわりに 90° − h。
 *
 * 高度は表示専用の簡略式（進入中は滑走路までの距離 × tan 3°、離陸後は経過時間 × 10 m/s）で、
 * シミュレーションには高度の概念がない。
 */

/** Map フレームのタイル座標 → m（位置は World → Map を frames.ts で変換してから使う） */
const w = tilesToM;

const UNIT_COLOR3D: Record<UnitKind, number> = {
  apronBus: 0x2b8cff,
  staff: 0xffffff,
  engineer: 0xfacc15,
  tug: 0xf59e0b,
  beltLoader: 0xf97316,
  baggageTractor: 0x8b5cf6,
  fuelTruck: 0xef4444,
  cateringTruck: 0x22c55e,
  cleaningVan: 0x06b6d4,
};

/**
 * footprint（タイル座標の直交リング）を持つ施設の 3D 建物ジオメトリ（UIデザイン更新 第7段階b / B10）。
 * 従来は footprint があっても外接矩形の Box で描いていたため、複合形状のターミナルが矩形に見えていた。
 * リングをそのまま THREE.Shape にして高さ h で押し出す。座標規約は既存の矩形描画と同じ
 * （タイル座標 × TILE_M。平面は (x, −z) で作り rotateX(-90°) で立てる = flatWorld と同じ流儀）。
 * 退化したリングでは null を返し、呼び出し側が矩形にフォールバックする。表示専用で sim には影響しない。
 */
export function footprintBuildingGeometry(f: Facility, heightM: number): THREE.BufferGeometry | null {
  const fp = f.footprint;
  if (!fp || fp.length < 3 || heightM <= 0) return null;
  try {
    const shape = new THREE.Shape();
    fp.forEach((p, i) => {
      const sx = w(p.x);
      const sy = -w(p.y);
      if (i === 0) shape.moveTo(sx, sy);
      else shape.lineTo(sx, sy);
    });
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth: heightM, bevelEnabled: false });
    g.rotateX(-Math.PI / 2);
    g.computeBoundingBox();
    const bb = g.boundingBox;
    if (!bb || !Number.isFinite(bb.min.x) || !Number.isFinite(bb.max.x)) return null;
    return g;
  } catch {
    return null;
  }
}

export interface PerfStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  aircraft: number;
  units: number;
  geometryCache: number;
  heapMB: number | null;
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private hemisphere: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private staticGroup = new THREE.Group();
  private aircraftGroup = new THREE.Group();
  private units: THREE.InstancedMesh | null = null;
  private unitCapacity = 0;
  private selRing: THREE.Mesh;
  private layout: AirportLayout | null = null;
  /** 区間ごとに進む地上走行の区間の線（taxiMode 'block' のときだけ。運航中は占有で色を変える） */
  private blockLines: { mesh: THREE.LineSegments; blockOfSegment: string[]; capOfSegment: number[] } | null = null;
  private aircraftObjs = new Map<string, { obj: THREE.Object3D; key: string }>();
  private raycaster = new THREE.Raycaster();
  private pilotFollow = false;
  private frameTimes: number[] = [];
  private last = 0;
  stats: PerfStats = { fps: 0, frameMs: 0, drawCalls: 0, triangles: 0, geometries: 0, textures: 0, aircraft: 0, units: 0, geometryCache: 0, heapMB: null };

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(host.clientWidth || 1, host.clientHeight || 1);
    host.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(50, (host.clientWidth || 1) / (host.clientHeight || 1), 5, 60000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.enableDamping = true;
    this.scene.background = new THREE.Color(0x9cc6e6);
    this.scene.fog = new THREE.Fog(0x9cc6e6, 8000, 30000);
    this.hemisphere = new THREE.HemisphereLight(0xffffff, 0x556644, 1.6);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.position.set(-3000, 6000, 2000);
    this.scene.add(this.hemisphere, this.sun);
    this.scene.add(this.staticGroup, this.aircraftGroup);
    this.selRing = new THREE.Mesh(new THREE.RingGeometry(1, 1.15, 40), new THREE.MeshBasicMaterial({ color: 0xffd400, side: THREE.DoubleSide }));
    this.selRing.rotateX(-Math.PI / 2);
    this.selRing.visible = false;
    this.scene.add(this.selRing);
  }

  resize(): void {
    const { clientWidth: cw, clientHeight: ch } = this.host;
    if (!cw || !ch) return;
    this.renderer.setSize(cw, ch);
    this.camera.aspect = cw / ch;
    this.camera.updateProjectionMatrix();
  }

  /** Enable a display-only cockpit approximation that follows the selected aircraft. */
  setPilotFollow(enabled: boolean): void {
    this.pilotFollow = enabled;
    this.controls.enabled = !enabled;
  }

  /** 2D のカメラ中心から 3D のカメラ位置を決める（切り替え時に同じ場所を見る） */
  lookAt2D(s: EditorState): void {
    const cam = s.camera;
    const cx = cam.x + s.viewSize.w / cam.zoom / 2;
    const cy = cam.y + s.viewSize.h / cam.zoom / 2;
    const span = w(s.viewSize.w / cam.zoom);
    this.controls.target.set(w(cx), 0, w(cy));
    this.camera.position.set(w(cx), Math.max(300, span * 0.6), w(cy) + Math.max(300, span * 0.6));
    this.controls.update();
  }

  // ------------------------------------------------------------ 施設（レイアウトが変わったときだけ作り直す）

  /** 区間の線を作り直す（レイアウトが変わったとき）。従来方式の配置は何も作らない */
  private rebuildBlockLines(layout: AirportLayout): void {
    if (this.blockLines) {
      this.scene.remove(this.blockLines.mesh);
      this.blockLines.mesh.geometry.dispose();
      (this.blockLines.mesh.material as THREE.Material).dispose();
      this.blockLines = null;
    }
    const graph = blockGraphOf(layout);
    if (!graph) return;
    const pos: number[] = [];
    const blockOfSegment: string[] = [];
    const capOfSegment: number[] = [];
    const at = (edgeId: string, m: number) => {
      const e = layout.taxiways[edgeId];
      const a = e && layout.taxiNodes[e.from];
      const b = e && layout.taxiNodes[e.to];
      if (!e || !a || !b) return null;
      const len = Math.hypot(a.pos.x - b.pos.x, a.pos.y - b.pos.y) * 25;
      const t = len > 0 ? Math.max(0, Math.min(1, m / len)) : 0;
      return worldToScene({ x: a.pos.x + (b.pos.x - a.pos.x) * t, y: a.pos.y + (b.pos.y - a.pos.y) * t }, 0.5);
    };
    for (const b of Object.values(graph.blocks)) {
      if (b.entry) continue;
      const cap = blockCapacity(b, 1, 'M');
      for (const sp of b.spans) {
        const p = at(sp.edgeId, sp.fromM);
        const q = at(sp.edgeId, sp.toM);
        if (!p || !q) continue;
        pos.push(p.x, p.y, p.z, q.x, q.y, q.z);
        blockOfSegment.push(b.id);
        capOfSegment.push(cap);
      }
    }
    if (pos.length === 0) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const colors = new Float32Array((pos.length / 3) * 3).fill(0.62);
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true }));
    mesh.userData.blockLines = true;
    mesh.renderOrder = 5;
    this.scene.add(mesh);
    this.blockLines = { mesh, blockOfSegment, capOfSegment };
  }

  /** 運航中は区間の占有（空 = 緑、使用中 = 黄、満杯 = 赤）で線の色を変える。建設モードは灰色 */
  private updateBlockLines(ops: OpsState | null): void {
    const bl = this.blockLines;
    if (!bl) return;
    const occ = ops?.sim.state.taxiBlocks?.occ;
    const attr = bl.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let i = 0; i < bl.blockOfSegment.length; i++) {
      const n = ops ? occ?.[bl.blockOfSegment[i]!]?.length ?? 0 : -1;
      const cap = bl.capOfSegment[i]!;
      const [r, g, b] = n < 0 ? [0.62, 0.7, 0.78] : n === 0 ? [0.4, 0.73, 0.42] : n < cap ? [1, 0.83, 0] : [1, 0.3, 0.31];
      for (const v of [i * 2, i * 2 + 1]) attr.setXYZ(v, r, g, b);
    }
    attr.needsUpdate = true;
  }

  private rebuildStatic(layout: AirportLayout): void {
    this.rebuildBlockLines(layout);
    for (const c of [...this.staticGroup.children]) {
      this.staticGroup.remove(c);
      c.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          if (o.material instanceof THREE.MeshBasicMaterial && o.material.map) o.material.map.dispose();
        }
      });
    }
    const site = layout.site;
    // 地面（地形の色をテクスチャにする）
    const canvas = document.createElement('canvas');
    canvas.width = site.width;
    canvas.height = site.height;
    const ctx = canvas.getContext('2d')!;
    const img = ctx.createImageData(site.width, site.height);
    for (let i = 0; i < site.width * site.height; i++) {
      const [r, g, b] = TERRAIN_COLOR[site.terrain[i] ?? 4];
      img.data.set([r, g, b, 255], i * 4);
    }
    ctx.putImageData(img, 0, 0);
    const tex = new THREE.CanvasTexture(canvas);
    tex.magFilter = THREE.NearestFilter;
    tex.colorSpace = THREE.SRGBColorSpace;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(w(site.width), w(site.height)), new THREE.MeshBasicMaterial({ map: tex }));
    ground.rotateX(-Math.PI / 2);
    ground.position.set(w(site.width) / 2, 0, w(site.height) / 2);
    ground.userData.terrain = true;
    this.staticGroup.add(ground);

    /** pts は Map フレーム（タイル）。metres = true のときは変換済み（m）の Scene の (x, z) */
    const flat = (pts: { x: number; y: number }[], y: number, color: number, opacity = 1, entityId?: string, metres = false, depthBias = 0, level = 0) => {
      const shape = new THREE.Shape(pts.map((p) => (metres ? new THREE.Vector2(p.x, p.y) : new THREE.Vector2(w(p.x), w(p.y)))));
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({
          color,
          side: THREE.DoubleSide,
          transparent: opacity < 1,
          opacity,
          // 同じ高さに近い面（舗装・肩・標示）の重なりを安定させる（描画順の奪い合いを避ける）
          ...(depthBias > 0 ? { polygonOffset: true, polygonOffsetFactor: -depthBias, polygonOffsetUnits: -depthBias } : {}),
        }),
      );
      m.position.y = y;
      if (entityId) m.userData.entityId = entityId;
      m.userData.layerLevels = [level];
      this.staticGroup.add(m);
    };

    // World フレームの形状は frames の worldPolyToScene 経由で描く（滑走路・誘導路・道路で同じ位置規約）
    const flatWorld = (pts: { x: number; y: number }[], y: number, color: number, opacity = 1, entityId?: string, depthBias = 0, level = 0) => {
      if (pts.length > 0) flat(worldPolyToScene(pts).map((p) => ({ x: p.x, y: p.z })), y, color, opacity, entityId, true, depthBias, level);
    };
    const slopedRoad = (a: { x: number; y: number }, b: { x: number; y: number }, widthM: number, y0: number, y1: number, color: number, entityId: string, level0: number, level1: number) => {
      const p = worldToScene(a);
      const q = worldToScene(b);
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) {
        const pad = Math.max(1, widthM / 2);
        flat([{ x: p.x - pad, y: p.z - pad }, { x: p.x + pad, y: p.z - pad }, { x: p.x + pad, y: p.z + pad }, { x: p.x - pad, y: p.z + pad }], (y0 + y1) / 2, color, 0.9, entityId, true);
        return;
      }
      const nx = (-dz / len) * widthM / 2;
      const nz = (dx / len) * widthM / 2;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([
        p.x + nx, y0, p.z + nz, p.x - nx, y0, p.z - nz,
        q.x - nx, y1, q.z - nz, q.x + nx, y1, q.z + nz,
      ], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide }));
      mesh.userData.entityId = entityId;
      mesh.userData.layerLevels = [...new Set([level0, level1])];
      this.staticGroup.add(mesh);
    };
    for (const r of Object.values(layout.runways)) {
      const alpha = r.buildState === 'operational' ? 1 : 0.5;
      // 従来形・自由形とも 2D と同じ runwaySurfaces（舗装は実寸の幅。番号の文字は Phase 16）。
      // 着陸帯・RESA は薄く、従来形は判定に使う占有の多角形（footprint）も薄く示す。クリックの選択は舗装・footprint のどちらでも滑走路になる
      const sf = runwaySurfaces(r, layout);
      flatWorld(sf.strip, 0.1, 0xffffff, 0.08, undefined, 1);
      for (const p of sf.resa) flatWorld(p, 0.12, 0xffb74d, 0.3, undefined, 2);
      if (sf.footprint) flatWorld(sf.footprint, 0.14, 0xffffff, 0.1, r.id, 2);
      if (sf.paved !== sf.pavement) flatWorld(sf.paved, 0.28, 0x565b61, alpha, r.id, 3);
      flatWorld(sf.pavement, 0.3, 0x3a3f45, alpha, r.id, 4);
      for (const [a, b] of sf.centrelineDashes) flatWorld(bandSurface(a, b, 0.9), 0.34, 0xf2f2f2, alpha, undefined, 5);
      for (const bar of sf.thresholdBars) flatWorld(bar, 0.34, 0xf2f2f2, alpha, undefined, 5);
    }

    // 誘導路・道路（ノード間の帯。形状は core の surfaces、幅は m の表）
    for (const e of Object.values(layout.taxiways)) {
      const a = layout.taxiNodes[e.from];
      const b = layout.taxiNodes[e.to];
      if (a && b) flatWorld(taxiwayBandSurface(a.pos, b.pos, e), 0.2, 0x55595f, e.buildState === 'operational' ? 1 : 0.5, e.id, 0, 0);
    }
    for (const e of Object.values(layout.roads)) {
      const a = layout.roadNodes[e.from];
      const b = layout.roadNodes[e.to];
      if (!a || !b) continue;
      const color = e.roadClass === 'rail' ? 0x6b4f3a : e.roadClass === 'walkway' ? 0x39a9a1 : e.roadClass === 'fuel' ? 0xcaa52b : 0x777777;
      const ya = elevationOf(a) + 0.15;
      const yb = elevationOf(b) + 0.15;
      if (levelOf(a) !== levelOf(b)) slopedRoad(a.pos, b.pos, roadDrawWidthM(e), ya, yb, color, e.id, levelOf(a), levelOf(b));
      else flatWorld(roadBandSurface(a.pos, b.pos, e), ya, color, 1, e.id, 0, levelOf(a));
    }
    for (const st of Object.values(layout.stands)) {
      const d = standDims(st);
      flat(
        [
          { x: st.origin.x, y: st.origin.y },
          { x: st.origin.x + d.w, y: st.origin.y },
          { x: st.origin.x + d.w, y: st.origin.y + d.h },
          { x: st.origin.x, y: st.origin.y + d.h },
        ],
        0.25,
        0x6b7078,
        1,
        st.id,
        false,
        0,
        0,
      );
    }
    const interiorHosts = new Set(Object.values(layout.facilities).flatMap((f) => f.parentFacilityId ? [f.parentFacilityId] : []));
    for (const f of Object.values(layout.facilities)) {
      if (f.parentFacilityId) this.addInteriorFacility(f, layout.facilities[f.parentFacilityId]);
      else this.addFacility(f, interiorHosts.has(f.id));
    }
    for (const link of Object.values(layout.terminalLinks ?? {})) {
      if (link.kind !== 'elevatedWalkway' || link.buildState === 'planned') continue;
      const from = layout.terminalAreas[link.fromAreaId];
      const to = layout.terminalAreas[link.toAreaId];
      if (!from || !to) continue;
      const path = new THREE.LineCurve3(
        new THREE.Vector3(w(from.origin.x + from.w / 2), link.elevationM ?? 36, w(from.origin.y + from.h / 2)),
        new THREE.Vector3(w(to.origin.x + to.w / 2), link.elevationM ?? 36, w(to.origin.y + to.h / 2)),
      );
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(path, 1, (link.widthM ?? 6) / 2, 8, false),
        new THREE.MeshLambertMaterial({ color: 0x7fdbff, transparent: link.buildState !== 'operational', opacity: link.buildState === 'operational' ? 0.85 : 0.4 }),
      );
      mesh.userData.entityId = link.id;
      this.staticGroup.add(mesh);
    }
  }

  private addFacility(f: Facility, hasInterior: boolean): void {
    const d = facilityDims(f);
    const vertical = facilityVerticalRange(f);
    const h = vertical.maxM - vertical.minM;
    // B10: footprint（非矩形の外形）がある施設はポリゴンを押し出して描く。無い/退化時は従来の矩形
    const fpGeo = footprintBuildingGeometry(f, h);
    const g = fpGeo ?? new THREE.BoxGeometry(w(d.w) - 2, h, w(d.h) - 2);
    const mat = new THREE.MeshLambertMaterial({
      color: FACILITY_COLOR[f.kind] ?? 0x999999,
      transparent: f.buildState !== 'operational' || hasInterior,
      opacity: f.buildState !== 'operational' ? 0.45 : hasInterior ? 0.28 : 1,
      // リングの巻き方向に依存しないよう footprint 描画は両面にする
      ...(fpGeo ? { side: THREE.DoubleSide } : {}),
    });
    const m = new THREE.Mesh(g, mat);
    if (fpGeo) m.position.set(0, vertical.minM, 0);
    else m.position.set(w(f.origin.x + d.w / 2), vertical.minM + h / 2, w(f.origin.y + d.h / 2));
    m.userData.entityId = f.id;
    m.userData.layerLevels = [facilityLevel(f)];
    this.staticGroup.add(m);
    if (f.kind === 'tower') {
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(10, 8, 8, 12), new THREE.MeshLambertMaterial({ color: 0x9ad1ff }));
      cab.position.set(m.position.x, h + 4, m.position.z);
      cab.userData.layerLevels = [facilityLevel(f)];
      this.staticGroup.add(cab);
    }
  }

  private addInteriorFacility(f: Facility, parent: Facility | undefined): void {
    if (!parent) return;
    const d = facilityDims(f);
    const width = Math.max(4, Math.min(w(d.w), 18));
    const depth = Math.max(4, Math.min(w(d.h), 18));
    const height = 3;
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      new THREE.MeshLambertMaterial({ color: FACILITY_COLOR[f.kind] ?? 0x999999, transparent: true, opacity: f.buildState === 'operational' ? 0.8 : 0.35 }),
    );
    mesh.position.set(
      w(f.origin.x + d.w / 2),
      facilityLevel(parent) * 6 + (f.floorIndex ?? 0) * 6 + height / 2,
      w(f.origin.y + d.h / 2),
    );
    mesh.userData.entityId = f.id;
    this.staticGroup.add(mesh);
  }

  // ------------------------------------------------------------ 動くもの（毎フレーム、シミュレーションの位置を読む）

  private altitudeM(ops: OpsState, ac: Aircraft, t: AircraftType): number {
    const { state } = ops.sim;
    if (AIRBORNE_STATES.includes(ac.state)) {
      const rw = ac.runwayId ? this.layout?.runways[ac.runwayId] : undefined;
      if (!rw) return 600;
      const dist = tilesToM(Math.hypot(ac.x - rw.start.x, ac.y - rw.start.y));
      return Math.min(900, Math.max(15, dist * Math.tan((3 * Math.PI) / 180)));
    }
    if (ac.state === 'takeoff') return Math.max(0, (ac.speed - t.rotateSpeed) * 4);
    if (ac.state === 'departed') return Math.min(1500, 30 + (state.now - ac.stateSince) * 10);
    return 0;
  }

  private updateAircraft(ops: OpsState): void {
    const { sim, clock } = ops;
    const alpha = clock.acc;
    const seen = new Set<string>();
    for (const ac of Object.values(sim.state.aircraft)) {
      if (!isVisible(ac)) continue;
      seen.add(ac.id);
      const t = resolveType(sim.ctx.types, ac.typeId);
      const airline = sim.state.flights[ac.arrivalFlightId]?.airlineId ?? sim.state.flights[ac.departureFlightId]?.airlineId ?? null;
      const asset = assetOf(modelOf(t.id)?.assetId ?? (t.size === 'L' ? 'generic-wide' : t.size === 'S' ? 'generic-regional' : 'generic-narrow'));
      const livery = liveryOf(airline);
      const key = `${t.id}|${asset.id}|${livery.id}`;
      let rec = this.aircraftObjs.get(ac.id);
      if (!rec || rec.key !== key) {
        if (rec) this.aircraftGroup.remove(rec.obj);
        const obj = aircraftObject(t, asset, livery);
        obj.traverse((o) => (o.userData.aircraftId = ac.id));
        this.aircraftGroup.add(obj);
        rec = { obj, key };
        this.aircraftObjs.set(ac.id, rec);
      }
      const sp = worldToScene({ x: ac.px + (ac.x - ac.px) * alpha, y: ac.py + (ac.y - ac.py) * alpha });
      const dh = ((ac.heading - ac.pheading + 540) % 360) - 180;
      const heading = ac.pheading + dh * alpha;
      rec.obj.position.set(sp.x, this.altitudeM(ops, ac, t), sp.z);
      rec.obj.rotation.y = bearingToSceneYawRad(heading);
      if (ac.id === ops.selectedAircraft) {
        this.selRing.visible = true;
        const s = t.wingspanM * 0.6;
        this.selRing.scale.set(s, s, s);
        this.selRing.position.set(sp.x, 0.6, sp.z);
      }
    }
    for (const [id, rec] of this.aircraftObjs) {
      if (seen.has(id)) continue;
      this.aircraftGroup.remove(rec.obj);
      this.aircraftObjs.delete(id);
    }
    this.stats.aircraft = seen.size;
  }

  /** 作業車両はインスタンス描画（1 回の描画命令でまとめる） */
  private updateUnits(ops: OpsState): void {
    const units = Object.values(ops.sim.state.units).filter((u) => u.kind !== 'staff' && u.status !== 'idle');
    const all = Object.keys(ops.sim.state.units).length;
    if (!this.units || this.unitCapacity < all) {
      if (this.units) {
        this.scene.remove(this.units);
        this.units.dispose();
      }
      this.units = new THREE.InstancedMesh(new THREE.BoxGeometry(7, 3, 3), new THREE.MeshLambertMaterial({ color: 0xffffff }), Math.max(1, all));
      this.unitCapacity = Math.max(1, all);
      this.units.frustumCulled = false;
      this.scene.add(this.units);
    }
    const m = new THREE.Matrix4();
    const col = new THREE.Color();
    units.forEach((u, i) => {
      const up = worldToScene(u);
      m.makeTranslation(up.x, 1.5, up.z);
      this.units!.setMatrixAt(i, m);
      this.units!.setColorAt(i, col.setHex(u.status === 'broken' ? 0xff3030 : UNIT_COLOR3D[u.kind]));
    });
    this.units.count = units.length;
    this.units.instanceMatrix.needsUpdate = true;
    if (this.units.instanceColor) this.units.instanceColor.needsUpdate = true;
    this.stats.units = units.length;
  }

  private updateLighting(s: EditorState): void {
    const enabled = s.overlays.daylight && s.mode === 'operate' && s.ops !== null;
    const light = enabled ? daylight(s.ops!.sim.state.now, s.ops!.sim.company?.day ?? 172).light : 1;
    const nightColor = new THREE.Color(0x0b1830);
    const dayColor = new THREE.Color(0x9cc6e6);
    const atmosphere = nightColor.clone().lerp(dayColor, light);
    this.scene.background = atmosphere;
    if (this.scene.fog instanceof THREE.Fog) this.scene.fog.color.copy(atmosphere);
    this.hemisphere.intensity = 0.45 + light * 1.15;
    this.sun.intensity = 0.12 + light * 1.28;
  }

  private updatePilotCamera(s: EditorState): void {
    if (!this.pilotFollow || !s.ops?.selectedAircraft) return;
    const rec = this.aircraftObjs.get(s.ops.selectedAircraft);
    const ac = s.ops.sim.state.aircraft[s.ops.selectedAircraft];
    if (!rec || !ac) return;
    const forwardX = Math.sin((ac.heading * Math.PI) / 180);
    const forwardZ = -Math.cos((ac.heading * Math.PI) / 180);
    const position = rec.obj.position;
    const height = Math.max(2, position.y + 2.4);
    this.camera.position.set(position.x + forwardX * 1.5, height, position.z + forwardZ * 1.5);
    this.controls.target.set(position.x + forwardX * 220, height + 12, position.z + forwardZ * 220);
  }

  draw(s: EditorState, layout: AirportLayout): void {
    if (layout !== this.layout) {
      this.layout = layout;
      this.rebuildStatic(layout);
    }
    for (const object of this.staticGroup.children) {
      const levels = object.userData.layerLevels as number[] | undefined;
      if (object.userData.terrain === true) {
        const material = (object as THREE.Mesh).material;
        if (material instanceof THREE.MeshBasicMaterial) {
          material.transparent = s.mapLevel !== 'all' && s.mapLevel !== 0;
          material.opacity = s.mapLevel === 'all' || s.mapLevel === 0 ? 1 : 0.24;
          material.depthWrite = s.mapLevel === 'all' || s.mapLevel === 0;
        }
        object.visible = true;
      } else if (levels) {
        object.visible = s.mapLevel === 'all' || levels.includes(s.mapLevel);
      }
    }
    this.selRing.visible = false;
    this.updateBlockLines(s.ops);
    if (s.ops) {
      this.updateAircraft(s.ops);
      this.updateUnits(s.ops);
    } else {
      for (const rec of this.aircraftObjs.values()) this.aircraftGroup.remove(rec.obj);
      this.aircraftObjs.clear();
      if (this.units) this.units.count = 0;
      this.stats.aircraft = this.stats.units = 0;
    }
    this.updateLighting(s);
    this.updatePilotCamera(s);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.measure();
  }

  private measure(): void {
    const now = performance.now();
    if (this.last) {
      this.frameTimes.push(now - this.last);
      if (this.frameTimes.length > 120) this.frameTimes.shift();
    }
    this.last = now;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / Math.max(1, this.frameTimes.length);
    const info = this.renderer.info;
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    Object.assign(this.stats, {
      fps: avg ? Math.round(1000 / avg) : 0,
      frameMs: Math.round(avg * 10) / 10,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      geometryCache: geometryCacheSize(),
      heapMB: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    });
  }

  /** 画面上の点にあるもの（レイキャスト）: 機体を優先し、なければ施設（滑走路・スポット・建物） */
  pick(clientX: number, clientY: number): { aircraftId: string } | { entityId: string } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const v = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(v, this.camera);
    const ac = this.raycaster.intersectObjects(this.aircraftGroup.children, true)[0]?.object.userData.aircraftId as string | undefined;
    if (ac) return { aircraftId: ac };
    const hit = this.raycaster.intersectObjects(this.staticGroup.children, false).find((h) => h.object.userData.entityId);
    return hit ? { entityId: hit.object.userData.entityId as string } : null;
  }

  destroy(): void {
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

