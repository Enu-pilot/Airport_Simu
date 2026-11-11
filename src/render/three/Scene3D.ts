import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { bearingToSceneYawRad, tilesToM, worldPolyToScene, worldToScene } from '../../core/geometry/frames';
import type { AirportLayout, Facility, FacilityKind } from '../../core/model/types';
import { facilityDims, standDims } from '../../core/layout/footprint';
import { roadBandSurface, runwayPavementSurface, taxiwayBandSurface } from '../../core/layout/surfaces';
import { resolveType, type AircraftType } from '../../core/sim/aircraftTypes';
import { isVisible } from '../../core/sim/query';
import type { Aircraft, UnitKind } from '../../core/sim/types';
import { AIRBORNE_STATES } from '../../core/sim/types';
import { modelOf } from '../../core/aircraft/catalog';
import { assetOf, liveryOf } from '../../core/assets/registry';
import type { EditorState, OpsState } from '../../editor/store';
import { FACILITY_COLOR, TERRAIN_COLOR } from '../colors';
import { aircraftObject, geometryCacheSize } from './aircraftMesh';

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

/** 施設の高さ（m、ゲームの表示用の値） */
const FACILITY_HEIGHT: Partial<Record<FacilityKind, number>> = {
  terminal: 18,
  tower: 45,
  hangar: 24,
  maintenance: 14,
  fuelFarm: 10,
  fireStation: 9,
  gseBase: 6,
  baggageSort: 10,
  serviceArea: 6,
  parking: 3,
  gate: 6,
  apron: 0.2,
};

const UNIT_COLOR3D: Record<UnitKind, number> = {
  staff: 0xffffff,
  engineer: 0xfacc15,
  tug: 0xf59e0b,
  beltLoader: 0xf97316,
  baggageTractor: 0x8b5cf6,
  fuelTruck: 0xef4444,
  cateringTruck: 0x22c55e,
  cleaningVan: 0x06b6d4,
};

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
  private staticGroup = new THREE.Group();
  private aircraftGroup = new THREE.Group();
  private units: THREE.InstancedMesh | null = null;
  private unitCapacity = 0;
  private selRing: THREE.Mesh;
  private layout: AirportLayout | null = null;
  private aircraftObjs = new Map<string, { obj: THREE.Object3D; key: string }>();
  private raycaster = new THREE.Raycaster();
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
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x556644, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(-3000, 6000, 2000);
    this.scene.add(sun);
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

  private rebuildStatic(layout: AirportLayout): void {
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
    this.staticGroup.add(ground);

    /** pts は Map フレーム（タイル）。metres = true のときは変換済み（m）の Scene の (x, z) */
    const flat = (pts: { x: number; y: number }[], y: number, color: number, opacity = 1, entityId?: string, metres = false) => {
      const shape = new THREE.Shape(pts.map((p) => (metres ? new THREE.Vector2(p.x, p.y) : new THREE.Vector2(w(p.x), w(p.y)))));
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: opacity < 1, opacity }));
      m.position.y = y;
      if (entityId) m.userData.entityId = entityId;
      this.staticGroup.add(m);
    };

    // World フレームの形状は frames の worldPolyToScene 経由で描く（滑走路・誘導路・道路で同じ位置規約）
    const flatWorld = (pts: { x: number; y: number }[], y: number, color: number, opacity = 1, entityId?: string) => {
      if (pts.length > 0) flat(worldPolyToScene(pts).map((p) => ({ x: p.x, y: p.z })), y, color, opacity, entityId, true);
    };
    for (const r of Object.values(layout.runways)) flatWorld(runwayPavementSurface(r), 0.3, 0x3a3f45, r.buildState === 'operational' ? 1 : 0.5, r.id);

    // 誘導路・道路（ノード間の帯。形状は core の surfaces、幅は m の表）
    for (const e of Object.values(layout.taxiways)) {
      const a = layout.taxiNodes[e.from];
      const b = layout.taxiNodes[e.to];
      if (a && b) flatWorld(taxiwayBandSurface(a.pos, b.pos, e), 0.2, 0x55595f, e.buildState === 'operational' ? 1 : 0.5);
    }
    for (const e of Object.values(layout.roads)) {
      const a = layout.roadNodes[e.from];
      const b = layout.roadNodes[e.to];
      if (a && b) flatWorld(roadBandSurface(a.pos, b.pos, e), 0.15, e.roadClass === 'rail' ? 0x6b4f3a : 0x777777, 1);
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
      );
    }
    for (const f of Object.values(layout.facilities)) this.addFacility(f);
  }

  private addFacility(f: Facility): void {
    const d = facilityDims(f);
    const levels = f.kind === 'terminal' ? Math.max(1, Number(f.props.levels ?? 1)) : 1;
    const h = (FACILITY_HEIGHT[f.kind] ?? 5) * (f.kind === 'terminal' ? Math.max(1, levels * 0.6) : 1);
    const g = new THREE.BoxGeometry(w(d.w) - 2, h, w(d.h) - 2);
    const mat = new THREE.MeshLambertMaterial({ color: FACILITY_COLOR[f.kind] ?? 0x999999, transparent: f.buildState !== 'operational', opacity: f.buildState === 'operational' ? 1 : 0.45 });
    const m = new THREE.Mesh(g, mat);
    m.position.set(w(f.origin.x + d.w / 2), h / 2, w(f.origin.y + d.h / 2));
    m.userData.entityId = f.id;
    this.staticGroup.add(m);
    if (f.kind === 'tower') {
      const cab = new THREE.Mesh(new THREE.CylinderGeometry(10, 8, 8, 12), new THREE.MeshLambertMaterial({ color: 0x9ad1ff }));
      cab.position.set(m.position.x, h + 4, m.position.z);
      this.staticGroup.add(cab);
    }
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

  draw(s: EditorState, layout: AirportLayout): void {
    if (layout !== this.layout) {
      this.layout = layout;
      this.rebuildStatic(layout);
    }
    this.selRing.visible = false;
    if (s.ops) {
      this.updateAircraft(s.ops);
      this.updateUnits(s.ops);
    } else {
      for (const rec of this.aircraftObjs.values()) this.aircraftGroup.remove(rec.obj);
      this.aircraftObjs.clear();
      if (this.units) this.units.count = 0;
      this.stats.aircraft = this.stats.units = 0;
    }
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

