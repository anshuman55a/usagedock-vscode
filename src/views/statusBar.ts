import * as vscode from 'vscode';
import type { ProviderResult } from '../providers/types';

let statusBarItem: vscode.StatusBarItem | null = null;

export function createStatusBar() {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'usagedock.openPanel';
  statusBarItem.text = '$(zap) UsageDock';
  statusBarItem.tooltip = 'Open UsageDock. Use Refresh All to load provider usage.';
  statusBarItem.show();
}

export function updateStatusBar(providers: ProviderResult[]) {
  if (!statusBarItem) { return; }

  const config = vscode.workspace.getConfiguration('usagedock');
  if (!config.get<boolean>('statusBar.enabled', true)) {
    statusBarItem.hide();
    return;
  }

  const connected = providers.filter((p) => !p.error && p.lines.length > 0);
  const total = providers.length;

  if (total === 0) {
    statusBarItem.text = '$(zap) UsageDock';
    statusBarItem.tooltip = 'No providers configured';
    statusBarItem.show();
    return;
  }

  // Build compact headline: top provider percent if available
  let headline = '';
  for (const p of connected) {
    const prog = p.lines.find((l) => l.type === 'progress');
    if (prog && prog.type === 'progress') {
      const pct = prog.limit > 0 ? Math.round((prog.used / prog.limit) * 100) : 0;
      headline = ` · ${p.name} ${pct}%`;
      break;
    }
  }

  statusBarItem.text = `$(zap) ${connected.length}/${total}${headline}`;

  // Rich tooltip
  const lines = providers.map((p) => {
    const icon = p.error ? '$(warning)' : '$(check)';
    const detail = p.error
      ? p.error.slice(0, 60)
      : p.lines
          .filter((l) => l.type === 'progress')
          .map((l) => {
            if (l.type !== 'progress') { return ''; }
            const pct = l.limit > 0 ? Math.round((l.used / l.limit) * 100) : 0;
            return `${l.label} ${pct}%`;
          })
          .join(', ') || 'Connected';
    return `${icon} ${p.name}: ${detail}`;
  });
  statusBarItem.tooltip = lines.join('\n');
  statusBarItem.show();
}

export function disposeStatusBar() {
  statusBarItem?.dispose();
  statusBarItem = null;
}
