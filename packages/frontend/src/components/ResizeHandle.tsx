import { useCallback, useRef, useEffect, useState } from 'react';

interface ResizeHandleProps {
  side: 'left' | 'right';
  onResize: (delta: number) => void;
}

export default function ResizeHandle({ side, onResize }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);
  const onResizeRef = useRef(onResize);
  const sideRef = useRef(side);
  const containerRef = useRef<HTMLDivElement>(null);
  const [glowY, setGlowY] = useState<number | null>(null);
  onResizeRef.current = onResize;
  sideRef.current = side;

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientX - lastX.current;
      lastX.current = e.clientX;
      onResizeRef.current(sideRef.current === 'left' ? delta : -delta);
      // Track glow Y during drag
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) setGlowY(e.clientY - rect.top);
    };

    const onMouseUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setGlowY(null);
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
  }, []);

  const handleLocalMove = useCallback((e: React.MouseEvent) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) setGlowY(e.clientY - rect.top);
  }, []);

  const handleLeave = useCallback(() => {
    if (!dragging.current) setGlowY(null);
  }, []);

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
      {/* Glow centered on the line, following cursor Y */}
      {glowY !== null && (
        <div
          className="pointer-events-none absolute left-0 -translate-x-1/2 opacity-0 transition-opacity group-hover:opacity-100 group-active:opacity-100"
          style={{
            top: glowY - 200,
            width: 4,
            height: 400,
            background: 'radial-gradient(ellipse at center, rgba(100,160,255,1) 0%, rgba(59,130,246,0.5) 35%, rgba(59,130,246,0) 70%)',
            filter: 'blur(2px)',
          }}
        />
      )}
    </div>
  );
}
