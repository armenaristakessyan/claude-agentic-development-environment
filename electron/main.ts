import { app, BrowserWindow, shell, Tray, Menu, nativeImage } from 'electron';
import path from 'path';
import { fork, type ChildProcess } from 'child_process';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let backendProcess: ChildProcess | null = null;
let isQuitting = false;

const isDev = process.env.NODE_ENV === 'development';

function getIconPath(): string {
  if (isDev) {
    return path.join(__dirname, '..', '..', 'packages', 'frontend', 'public', 'pwa-512x512.png');
  }
  return path.join(process.resourcesPath, 'icon.png');
}

function startBackend(): Promise<number> {
  return new Promise((resolve, reject) => {
    // In production, asarUnpack puts files in app.asar.unpacked/ alongside app.asar
    const unpackedPath = app.getAppPath().replace('app.asar', 'app.asar.unpacked');

    const staticDir = isDev
      ? undefined
      : path.join(__dirname, 'renderer');

    // fork() can't execute inside ASAR — use unpacked path in production
    const backendEntry = isDev
      ? path.join(__dirname, '..', '..', 'packages', 'backend', 'dist', 'index.js')
      : path.join(unpackedPath, 'packages', 'backend', 'dist', 'index.js');

    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
      PORT: '0', // Let OS pick a free port
      ELECTRON: '1',
    };
    if (staticDir) {
      env.STATIC_DIR = staticDir;
    }

    backendProcess = fork(backendEntry, [], {
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    });

    let resolved = false;

    backendProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      console.log('[backend]', text.trimEnd());

      // Parse port from startup log: "[server] Claude Dashboard backend running on http://localhost:PORT"
      if (!resolved) {
        const match = text.match(/running on http:\/\/localhost:(\d+)/);
        if (match) {
          resolved = true;
          resolve(parseInt(match[1], 10));
        }
      }
    });

    backendProcess.stderr?.on('data', (data: Buffer) => {
      console.error('[backend]', data.toString().trimEnd());
    });

    backendProcess.on('exit', (code) => {
      console.log(`[electron] Backend exited with code ${code}`);
      if (!resolved) {
        reject(new Error(`Backend exited with code ${code}`));
      }
      backendProcess = null;
    });

    // Timeout after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Backend startup timed out'));
      }
    }, 30_000);
  });
}

function createWindow(port: number): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'Claude ADE',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 15, y: 15 },
    backgroundColor: '#0a0a0a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadURL(`http://localhost:${port}`);
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    if (process.platform === 'darwin' && !isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray(): void {
  const iconPath = getIconPath();
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  tray = new Tray(icon);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show ADE',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Claude ADE');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });
}

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  isQuitting = true;
  if (backendProcess) {
    console.log('[electron] Stopping backend...');
    backendProcess.kill('SIGTERM');
  }
});

app.whenReady().then(async () => {
  try {
    const port = await startBackend();
    createWindow(port);
    createTray();
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    app.quit();
  }
});
