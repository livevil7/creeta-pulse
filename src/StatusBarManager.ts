import * as vscode from 'vscode';
import { DashboardState } from './types';

/**
 * Manages the VS Code status bar item showing agent count.
 */
export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'pulse.openDashboard';
    this.item.tooltip = 'Pulse Agent Dashboard';
    this.reset();
  }

  update(state: DashboardState): void {
    const { summary } = state;

    if (summary.running > 0) {
      this.item.text = `$(sync~spin) Pulse: ${summary.running} running`;
      this.item.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground'
      );
      this.item.show();
    } else {
      this.reset();
    }
  }

  private reset(): void {
    this.item.text = '$(radio-tower) Pulse';
    this.item.backgroundColor = undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
