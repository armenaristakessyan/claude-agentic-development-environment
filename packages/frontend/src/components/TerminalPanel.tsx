import React, { useEffect, useRef, useState, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Plus, X, TerminalSquare } from 'lucide-react';
import { useSocket } from '../hooks/useSocket';
import { useTheme } from '../contexts/ThemeContext';

interface ShellTab {
  id: string;
  index: number;
}

interface TerminalPanelProps {
  width: number;
  cwd?: string | null;
  onClose: () => void;
}

const DARK_THEME = {
  background: '#161616',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  selectionBackground: '#3b3b3b',
  black: '#161616',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#6272a4',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#e5e5e5',
  brightBlack: '#555555',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
};

const LIGHT_THEME = {
  background: '#ffffff',
  foreground: '#383a42',
  cursor: '#383a42',
  selectionBackground: '#bfceff',
  black: '#383a42',
  red: '#e45649',
  green: '#50a14f',
  yellow: '#c18401',
  blue: '#4078f2',
  magenta: '#a626a4',
  cyan: '#0184bc',
  white: '#fafafa',
  brightBlack: '#a0a1a7',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff',
};

function tabLabel(tab: ShellTab): string {
  return tab.index === 1 ? 'Terminal' : `Terminal (${tab.index})`;
}

const TerminalPanel = React.memo(function TerminalPanel({ width, cwd, onClose }: TerminalPanelProps) {
  const socket = useSocket();
  const { theme } = useTheme();
  const [tabs, setTabs] = useState<ShellTab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const activeSessionRef = useRef<string | null>(null);
  const counterRef = useRef(0);
  const createdRef = useRef(false);

  // Create a new shell session
  const createSession = useCallback((cwd?: string) => {
    counterRef.current += 1;
    const index = counterRef.current;
    socket.emit('shell:create', { cwd }, (res: { sessionId?: string; error?: string }) => {
      if (!res.sessionId) {
        console.error('[TerminalPanel] Failed to create shell:', res.error);
        counterRef.current -= 1;
        return;
      }
      const newTab: ShellTab = { id: res.sessionId, index };
      setTabs(prev => [...prev, newTab]);
      setActiveTab(res.sessionId);
    });
  }, [socket]);

  // Destroy a session — close panel when last tab is removed
  const destroySession = useCallback((sessionId: string) => {
    socket.emit('shell:destroy', { sessionId });
    setTabs(prev => {
      const next = prev.filter(t => t.id !== sessionId);
      if (next.length === 0) {
        setActiveTab(null);
        // Defer onClose so React doesn't warn about setState during render
        setTimeout(onClose, 0);
        return next;
      }
      if (activeTab === sessionId) {
        setActiveTab(next[next.length - 1].id);
      }
      return next;
    });
  }, [socket, activeTab, onClose]);

  // Auto-create exactly one session on first mount (StrictMode-safe)
  useEffect(() => {
    if (!createdRef.current) {
      createdRef.current = true;
      createSession(cwd ?? undefined);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Manage xterm instance for active tab
  useEffect(() => {
    if (!containerRef.current || !activeTab) return;

    const sessionId = activeTab;
    activeSessionRef.current = sessionId;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: theme === 'dark' ? DARK_THEME : LIGHT_THEME,
      allowProposedApi: true,
      scrollback: 5000,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);
    term.open(containerRef.current);

    requestAnimationFrame(() => {
      fitAddon.fit();
      socket.emit('shell:resize', {
        sessionId,
        cols: term.cols,
        rows: term.rows,
      });
    });

    termRef.current = term;
    fitRef.current = fitAddon;

    // User input → PTY
    const dataDisposable = term.onData(data => {
      socket.emit('shell:input', { sessionId, data });
    });

    // PTY output → terminal
    const onOutput = ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
      if (sid === sessionId) {
        term.write(data);
      }
    };

    const onExit = ({ sessionId: sid }: { sessionId: string }) => {
      if (sid === sessionId) {
        term.write('\r\n\x1b[90m[shell exited]\x1b[0m\r\n');
      }
    };

    socket.on('shell:output', onOutput);
    socket.on('shell:exit', onExit);

    // Attach to get buffer history
    socket.emit('shell:attach', { sessionId });

    // Handle resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitAddon && term) {
        fitAddon.fit();
        socket.emit('shell:resize', {
          sessionId,
          cols: term.cols,
          rows: term.rows,
        });
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      socket.off('shell:output', onOutput);
      socket.off('shell:exit', onExit);
      socket.emit('shell:detach', { sessionId });
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      activeSessionRef.current = null;
    };
  }, [activeTab, socket, theme]);

  return (
    <div className="flex h-full shrink-0 flex-col overflow-hidden rounded-xl bg-surface" style={{ width }}>
      {/* Header — tab bar matching TaskChangesPanel style */}
      <div className="flex items-center gap-1 overflow-x-auto px-3 py-2">
        {tabs.map(tab => (
          <div
            key={tab.id}
            className={`flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 transition-colors cursor-pointer ${
              activeTab === tab.id
                ? 'border-emerald-500/30 bg-emerald-500/10'
                : 'border-transparent hover:bg-hover'
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            <TerminalSquare className={`h-3 w-3 shrink-0 ${
              activeTab === tab.id ? 'text-emerald-300' : 'text-faint'
            }`} />
            <span className={`text-[11px] font-medium transition-colors ${
              activeTab === tab.id ? 'text-emerald-300' : 'text-faint hover:text-tertiary'
            }`}>
              {tabLabel(tab)}
            </span>
            <button
              onClick={e => {
                e.stopPropagation();
                destroySession(tab.id);
              }}
              className="rounded p-0.5 text-faint/50 transition-colors hover:text-secondary"
              title="Close terminal"
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        ))}

        <button
          onClick={() => createSession(cwd ?? undefined)}
          className="shrink-0 rounded p-1 text-faint transition-colors hover:text-tertiary hover:bg-hover"
          title="New terminal"
        >
          <Plus className="h-3 w-3" />
        </button>

        <div className="flex-1" />

        <button
          onClick={onClose}
          className="shrink-0 rounded p-1 text-faint transition-colors hover:text-secondary"
          title="Close terminal panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Terminal container */}
      {activeTab ? (
        <div
          ref={containerRef}
          className="flex-1 min-h-0"
          style={{ padding: '2px 6px 6px' }}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <button
            onClick={() => createSession(cwd ?? undefined)}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] text-faint transition-colors hover:bg-hover hover:text-tertiary"
          >
            <Plus className="h-3.5 w-3.5" />
            New terminal
          </button>
        </div>
      )}
    </div>
  );
});

export default TerminalPanel;
