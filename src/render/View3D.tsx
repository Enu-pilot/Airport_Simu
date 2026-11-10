import { useEffect, useRef, useState } from 'react';
import { actions, editorStore } from '../editor/store';
import { ops as opsActions } from '../editor/simRunner';
import { Scene3D, type PerfStats } from './three/Scene3D';

declare global {
  interface Window {
    /** 3D 表示の性能計測値（E2E の性能テストが読む） */
    __skyport3d?: PerfStats;
  }
}

/** 3D ビュー。毎フレーム EditorState を読んで描画し、クリックした機体を選択する */
export function View3D() {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<Scene3D | null>(null);
  const [stats, setStats] = useState<PerfStats | null>(null);

  useEffect(() => {
    const host = hostRef.current!;
    let scene: Scene3D;
    try {
      scene = new Scene3D(host);
    } catch (e) {
      host.textContent = `3D 表示を開始できませんでした（WebGL を利用できません）: ${String(e)}`;
      return;
    }
    sceneRef.current = scene;
    scene.renderer.domElement.dataset.testid = 'view3d-canvas';
    scene.lookAt2D(editorStore.getState());
    let raf = 0;
    let n = 0;
    const loop = () => {
      const s = editorStore.getState();
      scene.draw(s, s.history.present);
      window.__skyport3d = { ...scene.stats };
      if (++n % 30 === 0) setStats({ ...scene.stats });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const ro = new ResizeObserver(() => scene.resize());
    ro.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.destroy();
      sceneRef.current = null;
      delete window.__skyport3d;
    };
  }, []);

  const down = useRef<{ x: number; y: number } | null>(null);
  return (
    <div
      ref={hostRef}
      className="map-host view3d"
      data-testid="view3d"
      onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
      onPointerUp={(e) => {
        const d = down.current;
        down.current = null;
        // ドラッグ（視点操作）ではなくクリックのときだけ選択する
        if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
        const hit = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
        if (hit && 'aircraftId' in hit) {
          if (editorStore.getState().ops) opsActions.selectAircraft(hit.aircraftId);
        } else {
          // 施設を選ぶとプロパティ欄に詳細が出る（運航中は閲覧のみ）。何もない所なら選択を外す
          if (editorStore.getState().ops) opsActions.selectAircraft(null);
          actions.select(hit ? hit.entityId : null);
        }
      }}
    >
      {stats && (
        <div className="perf-hud" data-testid="perf-3d">
          {stats.fps} fps · {stats.frameMs} ms · 描画 {stats.drawCalls} 回 · 三角形 {Math.round(stats.triangles / 1000)}k · 機体 {stats.aircraft} · 車両 {stats.units}
          {stats.heapMB !== null ? ` · JS ${stats.heapMB} MB` : ''}
        </div>
      )}
    </div>
  );
}
