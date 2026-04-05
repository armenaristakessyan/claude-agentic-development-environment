import { useCallback, useRef, useEffect } from 'react';

interface ResizeHandleProps {
  side: 'left' | 'right';
  onResize: (delta: number) => void;
  onResizeEnd?: () => void;
}

export default function ResizeHandle({ side, onResize, onResizeEnd }: ResizeHandleProps) {
  const dragging = useRef(false);
  const lastX = useRef(0);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (!dragging.current) return;
    const delta = e.clientX - lastX.current;
    lastX.current = e.clientX;
    // For left sidebar: dragging right = wider (positive delta)
    // For right sidebar: dragging left = wider (negative delta → invert)
    onResize(side === 'left' ? delta : -delta);
  }, [onResize, side]);

  const onMouseUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    onResizeEnd?.();
  }, [onResizeEnd]);

  useEffect(() => {
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [onMouseMove, onMouseUp]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastX.current = e.clientX;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  return (
    <div
      onMouseDown={onMouseDown}
      className={`group relative z-10 w-0 shrink-0 cursor-col-resize ${
        side === 'left' ? '-ml-px' : '-mr-px'
      }`}
    >
      {/* Invisible wider hit area */}
      <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      {/* Visible line on hover/drag */}
      <div className="absolute inset-y-0 left-0 w-px bg-transparent transition-colors group-hover:bg-blue-500/50 group-active:bg-blue-500" />
    </div>
  );
}
