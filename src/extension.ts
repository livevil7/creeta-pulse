import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AgentWatcher } from './AgentWatcher';
import { DashboardPanel } from './DashboardPanel';
import { AgentTreeProvider } from './AgentTreeProvider';
import { StatusBarManager } from './StatusBarManager';
import { TranscriptReader } from './TranscriptReader';
import { DashboardState } from './types';

// Multi-project support: one watcher per workspace folder
const watchers = new Map<string, AgentWatcher>();
const projectStates = new Map<string, DashboardState>();
const previousRunningCount = new Map<string, number>(); // for 0→N transition detection

const fallbackTimers: ReturnType<typeof setInterval>[] = [];

let statusBar: StatusBarManager | undefined;
let treeProvider: AgentTreeProvider | undefined;
let transcriptReader: TranscriptReader | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const outputChannel = vscode.window.createOutputChannel('Pulse Agent Dashboard');
  outputChannel.appendLine('[Pulse] Extension activating...');

  // Status bar
  statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // TreeView
  treeProvider = new AgentTreeProvider();
  const treeView = vscode.window.createTreeView('pulseAgentTree', {
    treeDataProvider: treeProvider,
  });
  context.subscriptions.push(treeView);

  // Transcript reader for live agent thinking
  transcriptReader = new TranscriptReader();
  transcriptReader.onNewEntry((entry) => {
    DashboardPanel.currentPanel?.postTranscriptEntry(entry);
  });
  context.subscriptions.push(transcriptReader);

  // Start watchers for ALL workspace folders
  syncWatchers(outputChannel);

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('pulse.openDashboard', () => {
      const panel = DashboardPanel.createOrShow(context.extensionUri);
      // Send all current project states (use folder basename as display name)
      for (const [projectKey, state] of projectStates) {
        panel.updateProjectState(path.basename(projectKey), state);
      }
    }),

    vscode.commands.registerCommand('pulse.refreshDashboard', () => {
      for (const [project, watcher] of watchers) {
        const state = watcher.readNow();
        if (state) {
          handleStateUpdate(project, state);
        }
      }
    }),

    vscode.commands.registerCommand('pulse.clearDashboard', () => {
      projectStates.clear();
      DashboardPanel.currentPanel?.clearAll();
      const empty: DashboardState = {
        $schema: 'pulse-agent-dashboard/1.0.0',
        session: { id: '', startedAt: '', endedAt: null, status: 'completed' },
        agents: [],
        summary: { total: 0, pending: 0, running: 0, done: 0, error: 0 },
        errors: [],
        lastUpdatedAt: new Date().toISOString(),
      };
      treeProvider?.update(empty);
      statusBar?.update(empty);
    })
  );

  // Watch for workspace folder changes (add/remove projects)
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      syncWatchers(outputChannel);
    })
  );

  context.subscriptions.push(outputChannel);
  outputChannel.appendLine('[Pulse] Extension activated.');

  // Check if Claude Code plugin is likely installed (look for .pulse/ or .lens/ in any folder)
  checkPluginInstalled(outputChannel);
}

/** Show a one-time hint if no dashboard data is found after a delay */
function checkPluginInstalled(output: vscode.OutputChannel): void {
  setTimeout(() => {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const hasData = folders.some(f => {
      const pulseFile = path.join(f.uri.fsPath, '.pulse', 'agent-dashboard.json');
      const lensFile = path.join(f.uri.fsPath, '.lens', 'agent-dashboard.json');
      return fs.existsSync(pulseFile) || fs.existsSync(lensFile);
    });

    if (!hasData && folders.length > 0) {
      vscode.window.showInformationMessage(
        'Pulse: No agent data detected. Install the Claude Code plugin for real-time tracking.',
        'How to Install',
        'Dismiss'
      ).then(selection => {
        if (selection === 'How to Install') {
          vscode.env.openExternal(
            vscode.Uri.parse('https://github.com/CreetaCorp/pulse#setup')
          );
        }
      });
      output.appendLine('[Pulse] No dashboard data found. Plugin install hint shown.');
    }
  }, 10000); // Check 10 seconds after activation
}

/** Sync watchers to match current workspace folders */
function syncWatchers(output: vscode.OutputChannel): void {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const currentPaths = new Set(folders.map(f => f.uri.fsPath));

  // Remove watchers for folders no longer in workspace
  for (const [fsPath, watcher] of watchers) {
    if (!currentPaths.has(fsPath)) {
      watcher.dispose();
      watchers.delete(fsPath);
      projectStates.delete(fsPath);
      previousRunningCount.delete(fsPath);
      output.appendLine(`[Pulse] Stopped watching: ${fsPath}`);
    }
  }

  // Add watchers for new folders (.pulse/ preferred, .lens/ fallback)
  for (const folder of folders) {
    const fsPath = folder.uri.fsPath;
    if (!watchers.has(fsPath)) {
      const pulseDir = path.join(fsPath, '.pulse');
      const lensDir = path.join(fsPath, '.lens');
      const dashboardDir = fs.existsSync(pulseDir) ? pulseDir : lensDir;
      startWatcher(fsPath, dashboardDir, output);

      // Also watch .pulse/ if we started with .lens/ (in case pulse plugin starts later)
      if (dashboardDir === lensDir) {
        startFallbackWatcher(folder, pulseDir, output);
      }
    }
  }
}

/** Watch for .pulse/ directory creation when we initially fell back to .lens/ */
function startFallbackWatcher(folder: vscode.WorkspaceFolder, pulseDir: string, output: vscode.OutputChannel): void {
  const checkInterval = setInterval(() => {
    if (fs.existsSync(path.join(pulseDir, 'agent-dashboard.json'))) {
      clearInterval(checkInterval);
      const idx = fallbackTimers.indexOf(checkInterval);
      if (idx >= 0) { fallbackTimers.splice(idx, 1); }
      // Switch to .pulse/ watcher
      const existing = watchers.get(folder.uri.fsPath);
      if (existing) {
        existing.dispose();
      }
      startWatcher(folder.uri.fsPath, pulseDir, output);
      output.appendLine(`[Pulse] Switched to .pulse/ for: ${folder.name}`);
    }
  }, 2000);
  fallbackTimers.push(checkInterval);
  // Stop checking after 5 minutes
  setTimeout(() => clearInterval(checkInterval), 5 * 60 * 1000);
}

function startWatcher(projectKey: string, dashboardDir: string, output: vscode.OutputChannel): void {
  const displayName = path.basename(projectKey);
  const watcher = new AgentWatcher(dashboardDir);

  watcher.onStateChange((state) => {
    handleStateUpdate(projectKey, state, displayName);
  });

  watcher.onFileCreated(() => {
    const autoOpen = vscode.workspace
      .getConfiguration('pulse')
      .get<boolean>('autoOpen', true);
    if (autoOpen) {
      vscode.commands.executeCommand('pulse.openDashboard');
    }
  });

  watchers.set(projectKey, watcher);
  output.appendLine(`[Pulse] Watching: ${dashboardDir}`);

  // Initial read
  const initialState = watcher.readNow();
  if (initialState) {
    handleStateUpdate(projectKey, initialState, displayName);
  }
}

function handleStateUpdate(projectKey: string, rawState: DashboardState, displayName?: string): void {
  const state = resolveStaleSession(rawState);
  projectStates.set(projectKey, state);

  // Update dashboard panel with display name (folder basename) for UI
  const label = displayName ?? path.basename(projectKey);
  DashboardPanel.currentPanel?.updateProjectState(label, state);

  // Update tree with most active project's agents
  const activeState = getMostActiveState();
  if (activeState) {
    treeProvider?.update(activeState);
  }

  // Update status bar with aggregated totals across all projects
  statusBar?.update(buildAggregateState());

  // Start watching transcripts for ALL sub-agents (not just running)
  // Agents may complete before polling detects them, so watch done/error too
  const subAgents = state.agents.filter(a => a.id !== 'main');
  for (const agent of subAgents) {
    transcriptReader?.watchAgent(agent.id, state.session.id, agent.description);
  }

  // Auto-open only when running count transitions from 0 → N (not on every poll)
  const prevRunning = previousRunningCount.get(projectKey) ?? 0;
  previousRunningCount.set(projectKey, state.summary.running);
  if (state.summary.running > 0 && prevRunning === 0 && !DashboardPanel.currentPanel) {
    const autoOpen = vscode.workspace
      .getConfiguration('pulse')
      .get<boolean>('autoOpen', true);
    if (autoOpen) {
      vscode.commands.executeCommand('pulse.openDashboard');
    }
  }
}

/** Returns the most actively running project's state (for TreeView) */
function getMostActiveState(): DashboardState | undefined {
  let best: DashboardState | undefined;
  let bestScore = -1;
  for (const state of projectStates.values()) {
    const score = state.summary.running * 100 + state.summary.pending * 10 + state.summary.done;
    if (score > bestScore) {
      bestScore = score;
      best = state;
    }
  }
  return best;
}

/** Build a merged state for status bar (aggregate totals) */
function buildAggregateState(): DashboardState {
  let running = 0, done = 0, pending = 0, error = 0;
  for (const s of projectStates.values()) {
    running += s.summary.running;
    done += s.summary.done;
    pending += s.summary.pending;
    error += s.summary.error;
  }
  return {
    $schema: 'pulse-agent-dashboard/1.0.0',
    session: { id: '', startedAt: '', endedAt: null, status: running > 0 ? 'active' : 'completed' },
    agents: [],
    summary: { total: running + done + pending + error, running, done, pending, error },
    errors: [],
    lastUpdatedAt: new Date().toISOString(),
  };
}

function resolveStaleSession(state: DashboardState): DashboardState {
  if (state.session.status !== 'active' || state.summary.running === 0) {
    return state;
  }

  const STALE_THRESHOLD_MS = 3 * 60 * 1000; // 3 minutes
  try {
    const lastUpdate = new Date(state.lastUpdatedAt).getTime();
    if (Date.now() - lastUpdate < STALE_THRESHOLD_MS) {
      return state;
    }
  } catch {
    return state;
  }

  const resolvedAgents = state.agents.map(a => {
    if (a.status === 'running') {
      return { ...a, status: 'error' as const, error: 'Session ended unexpectedly', endedAt: state.lastUpdatedAt };
    }
    if (a.status === 'pending') {
      return { ...a, status: 'error' as const, error: 'Session ended before this agent started', endedAt: state.lastUpdatedAt };
    }
    return a;
  });

  return {
    ...state,
    session: { ...state.session, status: 'completed', endedAt: state.session.endedAt ?? state.lastUpdatedAt },
    agents: resolvedAgents,
    summary: {
      total: state.summary.total,
      pending: 0,
      running: 0,
      done: state.summary.done,
      error: state.summary.error + state.summary.running + state.summary.pending,
    },
  };
}

export function deactivate(): void {
  for (const watcher of watchers.values()) {
    watcher.dispose();
  }
  watchers.clear();
  for (const timer of fallbackTimers) {
    clearInterval(timer);
  }
  fallbackTimers.length = 0;
  transcriptReader?.dispose();
}
