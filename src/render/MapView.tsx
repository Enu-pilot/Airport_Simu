import { useEffect, useRef } from 'react';
import { editorStore, actions, useEditor } from '../editor/store';
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

/** PixiJS キャンバスを保持し、状態変化のたびに（フレーム単位で間引いて）描き直す */
export function MapView() {
  const hostRef = useRef<HTMLDivElement>(null);

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
        renderer.draw(editorStore.getState());
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
    />
  );
}

/** 2D マップと 3D ビューの切り替え。シミュレーションのループ（simRunner）は表示と独立しているので止まらない */
export function Viewport() {
  const mode = useEditor((s) => s.viewMode);
  return mode === '3d' ? <View3D /> : <MapView />;
}
