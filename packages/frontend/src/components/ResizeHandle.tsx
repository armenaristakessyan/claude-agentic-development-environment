import { useCallback, useRef, useEffect, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';

interface ResizeHandleProps {
  side: 'left' | 'right';
  onResize: (delta: number) => void;
}

interface GlowPos {
  clientX: number;
  clientY: number;
  hovered: boolean; // false = dragging only (still show glow)
}

export default function ResizeHandle({ side, onResize }: ResizeHandleProps) {
  const { zoom } = useTheme();
  const zoomFactor = zoom / 100;
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onResizeRef = useRef(onResize);
  const sideRef = useRef(side);
  const containerRef = useRef<HTMLDivElement>(null);
  // Glow is rendered with position:fixed so it escapes any ancestor's
  // overflow-hidden clipping (parents use overflow-hidden for the
  // width-animated panel transitions). We track the viewport coords of
  // the cursor and the handle's centerline separately.
  const [glow, setGlow] = useState<GlowPos | null>(null);
  onResizeRef.current = onResize;
  sideRef.current = side;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onResizeRef.current(sideRef.current === 'left' ? delta : -delta);
      setGlow({ clientX: e.clientX, clientY: e.clientY, hovered: true });
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.body.classList.remove('resizing');
      setGlow(null);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.body.classList.add('resizing');
  }, []);

  const handleLocalMove = useCallback((e: React.MouseEvent) => {
    setGlow({ clientX: e.clientX, clientY: e.clientY, hovered: true });
  }, []);

  const handleLeave = useCallback(() => {
    if (!dragging.current) setGlow(null);
  }, []);

  // Compute the X of the handle's visual centerline (in viewport coords)
  // so we can pin the glow to the line itself while still following the
  // cursor's Y position for the hotspot.
  const rect = containerRef.current?.getBoundingClientRect();
  const lineX = rect ? rect.left + rect.width / 2 : null;

  return (
    <div
      ref={containerRef}
      onMouseDown={onMouseDown}
      onMouseMove={handleLocalMove}
      onMouseLeave={handleLeave}
      className={`group relative z-10 w-0 shrink-0 cursor-col-resize self-stretch ${
        side === 'left' ? '-ml-px' : '-mr-px'
      }`}
    >
      {/* Invisible wider hit area */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      {/* Glow rendered fixed to viewport so it isn't clipped by
          width-animated ancestors that use overflow-hidden. */}
      {glow && lineX !== null && (
        <div
          className="pointer-events-none fixed z-[9999]"
          // Root `<html>` has CSS `zoom` applied. A `position: fixed` element
          // still inherits that zoom at paint, scaling `left`/`top` by the
          // zoom factor and producing an offset that grows with distance from
          // the origin. Divide coords by zoom so the final painted position
          // matches the viewport coords returned by getBoundingClientRect /
          // MouseEvent.clientX.
          style={{
            left: lineX / zoomFactor,
            top: glow.clientY / zoomFactor,
            width: 4,
            height: 400,
            transform: 'translate(-50%, -50%)',
            background: 'radial-gradient(ellipse at center, rgba(100,160,255,1) 0%, rgba(59,130,246,0.5) 35%, rgba(59,130,246,0) 70%)',
            filter: 'blur(2px)',
          }}
        />
      )}
    </div>
  );
}
