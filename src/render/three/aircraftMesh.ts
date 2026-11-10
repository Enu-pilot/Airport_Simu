import * as THREE from 'three';
import type { AircraftType } from '../../core/sim/aircraftTypes';
import type { AircraftAsset, Livery } from '../../core/assets/registry';

/**
 * 手続き生成の機体メッシュ。寸法は機種カタログ（AircraftType）の全長・翼幅・全高をそのまま使い（1 単位 = 1 m）、
 * 形の比率はアセット登録簿のテンプレートから取る。機首は +X、原点は胴体中央の接地面。
 *
 * LOD: high = 胴体・主翼・尾翼・エンジン・塗装の帯 / medium = エンジンと帯を省略 / low = 箱2つ（十字形）
 * ジオメトリは（アセット × 機種）ごと、マテリアルは塗装ごとに共有する。
 */

type Detail = 'high' | 'medium' | 'low';

const geomCache = new Map<string, Parts>();
const matCache = new Map<string, THREE.MeshLambertMaterial>();

export function material(color: number): THREE.MeshLambertMaterial {
  const k = color.toString(16);
  let m = matCache.get(k);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color });
    matCache.set(k, m);
  }
  return m;
}

/** 平面の台形（主翼・水平尾翼）。x = 胴体方向（+ が機首）、z = 翼幅方向 */
function wingGeometry(rootX: number, rootChord: number, halfSpan: number, tipChord: number, sweepDeg: number, thick: number): THREE.BufferGeometry {
  const back = Math.tan((sweepDeg * Math.PI) / 180) * halfSpan;
  // 右翼と左翼を一つの形で描く（中心から両側へ）
  const pts: [number, number][] = [
    [rootX, 0],
    [rootX - back, halfSpan],
    [rootX - back - tipChord, halfSpan],
    [rootX - rootChord, 0],
    [rootX - back - tipChord, -halfSpan],
    [rootX - back, -halfSpan],
  ];
  const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
  // Shape は xy 平面。y（翼幅）→ z に回して水平にする
  g.rotateX(Math.PI / 2);
  g.translate(0, thick / 2, 0);
  return g;
}

function tailFinGeometry(rootX: number, rootChord: number, height: number, sweepDeg: number): THREE.BufferGeometry {
  const back = Math.tan((sweepDeg * Math.PI) / 180) * height;
  const shape = new THREE.Shape(
    [
      [rootX, 0],
      [rootX - back, height],
      [rootX - back - rootChord * 0.45, height],
      [rootX - rootChord, 0],
    ].map(([x, y]) => new THREE.Vector2(x, y)),
  );
  const g = new THREE.ExtrudeGeometry(shape, { depth: 0.5, bevelEnabled: false });
  g.translate(0, 0, -0.25);
  return g;
}

interface Parts {
  body: THREE.BufferGeometry[];
  tail: THREE.BufferGeometry[];
  engine: THREE.BufferGeometry[];
  stripe: THREE.BufferGeometry[];
}

function buildParts(t: AircraftType, a: AircraftAsset, detail: Detail): Parts {
  const L = t.lengthM;
  const W = t.wingspanM;
  // 全高が未設定の機種は表示だけ全長の 25% で代用する（シミュレーションには使わない）
  const H = t.heightM ?? L * 0.25;
  const r = (L * a.shape.fuselageRatio) / 2;
  const deckScale = t.doubleDeck ? 1.35 : 1;
  const gear = Math.max(1.2, H * 0.1);
  const cy = gear + r * deckScale;
  const parts: Parts = { body: [], tail: [], engine: [], stripe: [] };

  if (detail === 'low') {
    const f = new THREE.BoxGeometry(L, r * 2 * deckScale, r * 2);
    f.translate(0, cy, 0);
    const w = new THREE.BoxGeometry(L * 0.14, 0.8, W);
    w.translate(-L * 0.05, cy - r * 0.4, 0);
    parts.body.push(f, w);
    const fin = new THREE.BoxGeometry(L * 0.1, Math.max(1, H - cy - r), 0.6);
    fin.translate(-L * 0.44, cy + r + (H - cy - r) / 2, 0);
    parts.tail.push(fin);
    return parts;
  }

  // 胴体（円筒＋機首・尾部）
  const seg = detail === 'high' ? 16 : 8;
  const bodyLen = L * 0.74;
  const fus = new THREE.CylinderGeometry(r, r, bodyLen, seg);
  fus.rotateZ(Math.PI / 2);
  fus.scale(1, deckScale, 1);
  fus.translate(L * 0.03, cy, 0);
  const noseLen = L * (a.shape.noseStyle === 'airbus' ? 0.1 : 0.11);
  const nose = new THREE.SphereGeometry(r, seg, seg / 2, 0, Math.PI * 2, 0, Math.PI / 2);
  nose.rotateZ(-Math.PI / 2);
  nose.scale(noseLen / r, deckScale, 1);
  nose.translate(L * 0.03 + bodyLen / 2, cy, 0);
  const tailCone = new THREE.ConeGeometry(r, L * 0.15, seg);
  tailCone.rotateZ(Math.PI / 2);
  tailCone.scale(1, deckScale * 0.9, 0.9);
  tailCone.translate(L * 0.03 - bodyLen / 2 - L * 0.075, cy + r * 0.25, 0);
  parts.body.push(fus, nose, tailCone);

  // 主翼・水平尾翼
  const rootChord = L * 0.2;
  parts.body.push(wingGeometry(L * 0.12, rootChord, W / 2, rootChord * 0.25, a.shape.sweepDeg, Math.max(0.4, r * 0.18)));
  const hs = wingGeometry(-L * 0.36, L * 0.09, W * 0.17, L * 0.035, a.shape.sweepDeg + 4, 0.35);
  hs.translate(0, cy + r * 0.2, 0);
  parts.body.push(hs);
  for (const g of parts.body.slice(3, 4)) g.translate(0, cy - r * 0.55, 0);

  // 垂直尾翼（全高に届くまで）
  const finH = Math.max(1, H - (cy + r * deckScale * 0.6));
  const fin = tailFinGeometry(-L * 0.33, L * 0.13, finH, a.shape.sweepDeg + 8);
  fin.translate(0, cy + r * deckScale * 0.6, 0);
  parts.tail.push(fin);

  if (detail === 'high') {
    // エンジン（翼下。4発機は内側・外側）
    const er = r * (t.engines >= 4 ? 0.36 : 0.5);
    const el = L * 0.07;
    const spans = t.engines >= 4 ? [0.34, 0.62] : [0.33];
    for (const k of spans) {
      for (const side of [1, -1]) {
        const e = new THREE.CylinderGeometry(er, er * 0.9, el, 10);
        e.rotateZ(Math.PI / 2);
        const z = (side * W) / 2 * k;
        const x = L * 0.12 - Math.tan((a.shape.sweepDeg * Math.PI) / 180) * Math.abs(z) + el * 0.3;
        e.translate(x, cy - r * 0.55 - er * 0.9, z);
        parts.engine.push(e);
      }
    }
    // 塗装の帯（窓の高さ）。2階建ては2本
    const decks = t.doubleDeck ? [0.15, 0.55] : [0.25];
    for (const d of decks) {
      const s = new THREE.BoxGeometry(bodyLen * 0.92, r * 0.12, r * 2 * 1.02);
      s.translate(L * 0.03, cy + r * deckScale * d, 0);
      parts.stripe.push(s);
    }
  }
  return parts;
}

function partsFor(t: AircraftType, a: AircraftAsset, detail: Detail): Parts {
  const key = `${a.id}|${t.id}|${t.lengthM}|${t.wingspanM}|${t.heightM}|${detail}`;
  let p = geomCache.get(key);
  if (!p) {
    p = buildParts(t, a, detail);
    geomCache.set(key, p);
  }
  return p;
}

function levelMesh(t: AircraftType, a: AircraftAsset, livery: Livery, detail: Detail): THREE.Group {
  const p = partsFor(t, a, detail);
  const g = new THREE.Group();
  for (const geo of p.body) g.add(new THREE.Mesh(geo, material(livery.body)));
  for (const geo of p.tail) g.add(new THREE.Mesh(geo, material(livery.tail)));
  for (const geo of p.engine) g.add(new THREE.Mesh(geo, material(livery.engine)));
  for (const geo of p.stripe) g.add(new THREE.Mesh(geo, material(livery.stripe)));
  return g;
}

/** LOD 付きの機体オブジェクト */
export function aircraftObject(t: AircraftType, a: AircraftAsset, livery: Livery): THREE.LOD {
  const lod = new THREE.LOD();
  let prev = 0;
  for (const l of a.lod) {
    lod.addLevel(levelMesh(t, a, livery, l.detail), prev);
    prev = l.maxDistanceM;
  }
  return lod;
}

export function geometryCacheSize(): number {
  return geomCache.size;
}
