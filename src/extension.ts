import * as vscode from 'vscode';
import type { ProviderResult } from './providers/types';
import { probeAll, probeSingle } from './providers/engine';
import { createStatusBar, updateStatusBar, disposeStatusBar } from './views/statusBar';
import { UsageDockWebviewProvider } from './views/webviewPanel';

let autoRefreshTimer: ReturnType<typeof setInterval> | null = null;
let latestResults: ProviderResult[] = [];
let webviewProvider: UsageDockWebviewProvider | null = null;
let refreshInFlight: Promise<void> | null = null;

export function activate(context: vscode.ExtensionContext) {
  // Status bar
  createStatusBar();
  context.subscriptions.push({ dispose: disposeStatusBar });

  // Webview sidebar provider
  webviewProvider = new UsageDockWebviewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('usagedock.panel', webviewProvider),
  );

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('usagedock.refreshAll', () => refreshAll()),
    vscode.commands.registerCommand('usagedock.openPanel', () => {
      vscode.commands.executeCommand('usagedock.panel.focus');
    }),
    vscode.commands.registerCommand('usagedock.openSettings', () => {
      vscode.commands.executeCommand('workbench.action.openSettings', 'UsageDock');
    }),
  );

  // Listen for webview messages
  webviewProvider.onMessage((msg) => {
    if (msg.type === 'refreshAll') {
      refreshAll();
    } else if (msg.type === 'refreshSingle' && msg.id) {
      refreshSingleProvider(msg.id);
    } else if (msg.type === 'ready') {
      if (latestResults.length > 0) {
        webviewProvider?.postMessage({ type: 'providerResults', providers: latestResults });
      } else {
        webviewProvider?.postMessage({ type: 'loading', loading: false });
      }

      if (shouldRefreshOnOpen()) {
        refreshAll();
      }
    } else if (msg.type === 'openSettings') {
      vscode.commands.executeCommand('usagedock.openSettings');
    }
  });

  setupAutoRefresh();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('usagedock.autoRefresh.enabled') ||
        e.affectsConfiguration('usagedock.autoRefresh.intervalMinutes')
      ) {
        setupAutoRefresh();
      }
      if (e.affectsConfiguration('usagedock.statusBar.enabled')) {
        updateStatusBar(latestResults);
      }
    }),
  );
}

async function refreshAll() {
  if (refreshInFlight) {
    return refreshInFlight;
  }

  webviewProvider?.postMessage({ type: 'loading', loading: true });
  refreshInFlight = (async () => {
    try {
      latestResults = await probeAll();
    } catch (err) {
      console.error('UsageDock: failed to probe providers', err);
    } finally {
      updateStatusBar(latestResults);
      webviewProvider?.postMessage({ type: 'providerResults', providers: latestResults });
      webviewProvider?.postMessage({ type: 'loading', loading: false });
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function refreshSingleProvider(id: string) {
  webviewProvider?.postMessage({ type: 'refreshing', id, refreshing: true });
  try {
    const result = await probeSingle(id);
    latestResults = latestResults.map((p) => (p.id === id ? result : p));
  } catch (err) {
    console.error(`UsageDock: failed to probe ${id}`, err);
  }
  updateStatusBar(latestResults);
  webviewProvider?.postMessage({ type: 'providerResults', providers: latestResults });
  webviewProvider?.postMessage({ type: 'refreshing', id, refreshing: false });
}

function setupAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
  const config = vscode.workspace.getConfiguration('usagedock');
  const enabled = config.get<boolean>('autoRefresh.enabled', false);
  const minutes = config.get<number>('autoRefresh.intervalMinutes', 15);
  if (enabled && minutes > 0) {
    autoRefreshTimer = setInterval(() => refreshAll(), minutes * 60 * 1000);
  }
}

function shouldRefreshOnOpen(): boolean {
  return vscode.workspace.getConfiguration('usagedock').get<boolean>('refreshOnOpen', false);
}

export function deactivate() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}
