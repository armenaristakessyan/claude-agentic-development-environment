import { useState, useEffect, useRef } from 'react';
import { Settings, X, Plus } from 'lucide-react';

interface ScanPathsModalProps {
  scanPaths: string[];
  onSave: (paths: string[]) => void;
  onClose: () => void;
}

export default function ScanPathsModal({ scanPaths, onSave, onClose }: ScanPathsModalProps) {
  const [paths, setPaths] = useState<string[]>(scanPaths.length > 0 ? [...scanPaths] : ['']);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleSave = () => {
    onSave(paths.filter(p => p.trim()));
  };

  const handleAdd = () => {
    setPaths(prev => [...prev, '']);
    requestAnimationFrame(() => {
      inputRefs.current[paths.length]?.focus();
    });
  };

  const handleRemove = (index: number) => {
    setPaths(prev => prev.filter((_, i) => i !== index));
  };

  const handleChange = (index: number, value: string) => {
    setPaths(prev => prev.map((p, i) => (i === index ? value : p)));
  };

  const handleKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Enter' && index === paths.length - 1) {
      handleSave();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-lg border border-neutral-700 bg-neutral-900 p-4 shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2 text-neutral-200">
            <Settings className="h-4 w-4 text-neutral-400" />
            <span className="text-sm font-semibold">Scan Paths</span>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mb-3 text-[11px] text-neutral-500">
          Directories to scan for projects
        </p>

        <div className="mb-3 flex max-h-48 flex-col gap-2 overflow-y-auto">
          {paths.map((path, index) => (
            <div key={index} className="flex items-center gap-1.5">
              <input
                ref={el => { inputRefs.current[index] = el; }}
                type="text"
                value={path}
                onChange={e => handleChange(index, e.target.value)}
                onKeyDown={e => handleKeyDown(e, index)}
                placeholder="~/projects"
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200 placeholder-neutral-600 outline-none focus:border-neutral-500 focus:ring-1 focus:ring-neutral-500"
              />
              <button
                onClick={() => handleRemove(index)}
                className="shrink-0 rounded p-1 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-red-400"
                title="Remove path"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>

        <button
          onClick={handleAdd}
          className="mb-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-neutral-700 py-1.5 text-xs text-neutral-500 transition-colors hover:border-neutral-500 hover:text-neutral-300"
        >
          <Plus className="h-3 w-3" />
          Add path
        </button>

        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1.5 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-200"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            className="rounded bg-green-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-green-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
