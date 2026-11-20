import { useEffect, useRef, useState } from 'react';
import { editorStore, actions, useEditor } from '../editor/store';
import { centerOn } from '../core/geometry/camera';
import { worldToMap } from '../core/geometry/frames';
import { View3D } from './View3D';
import {
  onDoubleClick,
  onPointerDown,
  onPointerLeave,
  onPointerMove,
  onPointerUp,
  onWheel,
} from '../editor/input';
import { MapRenderer } from './MapRenderer';
import { recordDraw } from '../core/sim/perfStats';

/** PixiJS キャンバスを保持し、状態変化のたびに（フレーム単位で間引いて）描き直す */
export function MapView() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(false);
  const selectedAircraft = useEditor((s) => s.ops?.selectedAircraft ?? null);
  const uiVersion = useEditor((s) => s.ops?.uiVersion ?? -1);
  const viewSize = useEditor((s) => s.viewSize);

  useEffect(() => {
    if (!follow || !selectedAircraft) return;
    const s = editorStore.getState();
    const ac = s.ops?.sim.state.aircraft[selectedAircraft];
    if (!ac) return;
    actions.setCamera(centerOn(s.camera, worldToMap({ x: ac.x, y: ac.y }), s.viewSize.w, s.viewSize.h));
  }, [follow, selectedAircraft, uiVersion, viewSize.w, viewSize.h]);

  useEffect(() => {
    const host = hostRef.current!;
    const renderer = new MapRenderer();
    let disposed = false;
    let frame = 0;
    let ready = false;
    const schedule = () => {
      if (frame || !ready) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        // 性能計測: 描画1回の所要時間を記録する（描画自体は変えない）
        const t0 = performance.now();
        renderer.draw(editorStore.getState());
        recordDraw(performance.now() - t0);
      });
    };
    const unsubscribe = editorStore.subscribe(schedule);
    const resize = new ResizeObserver(() => {
      actions.setViewSize(host.clientWidth, host.clientHeight);
      schedule();
    });
    void renderer.init(host).then(() => {
      if (disposed) {
        renderer.destroy();
        return;
      }
      ready = true;
      renderer.app.canvas.dataset.testid = 'map-canvas';
      resize.observe(host);
      schedule();
    });
    return () => {
      disposed = true;
      unsubscribe();
      resize.disconnect();
      cancelAnimationFrame(frame);
      if (ready) renderer.destroy();
    };
  }, []);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = hostRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  useEffect(() => {
    const host = hostRef.current!;
    // passive: false でページのスクロールを止める
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      onWheel(local(e), e.deltaY);
    };
    host.addEventListener('wheel', wheel, { passive: false });
    return () => host.removeEventListener('wheel', wheel);
  }, []);

  return (
    <div
      ref={hostRef}
      className="map-host"
      data-testid="map"
      onPointerDown={(e) => {
        (e.target as Element).setPointerCapture?.(e.pointerId);
        onPointerDown(local(e), e.button, { shift: e.shiftKey });
      }}
      onPointerMove={(e) => onPointerMove(local(e))}
      onPointerUp={(e) => onPointerUp(local(e), e.button)}
      onPointerLeave={onPointerLeave}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="pilot-follow-toggle"
        type="button"
        disabled={!selectedAircraft}
        aria-pressed={follow && selectedAircraft !== null}
        onPointerDown={(e) => e.stopPropagation()}
        onPointerUp={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setFollow((value) => !value);
        }}
        title="選択中の機体に2Dカメラを追従させます"
        data-testid="pilot-follow-2d-toggle"
      >
        {follow && selectedAircraft ? '追従中' : '機体に追従'}
      </button>
    </div>
  );
}

/** 2D マップと 3D ビューの切り替え。シミュレーションのループ（simRunner）は表示と独立しているので止まらない */
export function Viewport() {
  const mode = useEditor((s) => s.viewMode);
  return mode === '3d' ? <View3D /> : <MapView />;
}
