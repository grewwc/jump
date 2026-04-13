import * as vscode from 'vscode';
import { HistoryManager, JumpEntry } from './historyManager';
import { NavHistoryProvider, EntryNode, FileGroupNode, HotSpotEntryNode, TreeNode } from './historyProvider';

export function activate(context: vscode.ExtensionContext): void {
  // ─── Setup ──────────────────────────────────────────────────────────────────

  // Provider is created after manager so onChange can call realProvider.refresh().
  // We use a late-binding wrapper: manager calls refresh(), which is assigned below.
  let refreshCallback: () => void = () => { /* assigned below */ };

  const manager = new HistoryManager(context, () => {
    refreshCallback();
    updateStatusBar();
  });

  const realProvider = new NavHistoryProvider(manager);
  refreshCallback = () => realProvider.refresh();

  const treeView = vscode.window.createTreeView('jumpHistoryTree', {
    treeDataProvider: realProvider,
    showCollapseAll: true,
    canSelectMany: true,
  });

  // ─── Status Bar ─────────────────────────────────────────────────────────────

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.tooltip = 'Jump History';
  context.subscriptions.push(statusBar);

  function updateStatusBar(): void {
    const count = manager.getAll().length;
    statusBar.text = `$(history) Jump History  ${count}`;
    statusBar.tooltip = manager.hasDeletedEntries()
      ? 'Jump History: some entries reference deleted files'
      : `Jump History: ${count} entries recorded`;
    statusBar.show();
  }

  updateStatusBar();

  // ─── Jump detection ──────────────────────────────────────────────────────────

  // Suppression flag: when navigating via our own tree, don't re-record
  let suppressRecording = false;

  // Track whether we just initiated a navigation ourselves to avoid re-entrancy
  let lastRecordedUri: string | null = null;
  let lastRecordedLine = -1;

  function getLineText(editor: vscode.TextEditor, line: number): string {
    try {
      if (line < editor.document.lineCount) {
        return editor.document.lineAt(line).text;
      }
    } catch {
      // ignore
    }
    return '';
  }

  // Record only command-triggered jumps (Go to Def/References/Navigate Back/Forward).
  // This avoids noise from plain file focus changes, tab switching, and panel interactions.
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (suppressRecording) {
        return;
      }
      const editor = event.textEditor;
      if (editor.document.uri.scheme !== 'file') {
        return;
      }

      const uri = editor.document.uri;
      const line = event.selections[0].active.line;
      const character = event.selections[0].active.character;

      // Normal in-file command jump
      if (event.kind !== vscode.TextEditorSelectionChangeKind.Command) {
        return;
      }

      const lineText = getLineText(editor, line);

      // Skip if this is just the same position we already recorded
      if (uri.toString() === lastRecordedUri && line === lastRecordedLine) {
        return;
      }

      const recorded = manager.addEntry(uri, line, character, lineText, 'command-jump');
      if (recorded) {
        lastRecordedUri = uri.toString();
        lastRecordedLine = line;
      }
    })
  );

  // ─── File change tracking ─────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidDeleteFiles((event) => {
      manager.handleFilesDeleted(event.files);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidRenameFiles((event) => {
      manager.handleFilesRenamed(event.files);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.uri.scheme !== 'file') {
        return;
      }
      if (event.contentChanges.length === 0) {
        return;
      }
      manager.handleDocumentChange(event);
    })
  );

  // ─── Navigate command (internal) ──────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.navigateTo', async (entry: JumpEntry) => {
      if (entry.deleted) {
        vscode.window.showInformationMessage(
          `File no longer exists: ${HistoryManager.displayName(entry.uri)}`
        );
        return;
      }
      try {
        suppressRecording = true;
        const uri = vscode.Uri.parse(entry.uri);
        const position = new vscode.Position(entry.line, entry.character);
        const range = new vscode.Range(position, position);
        await vscode.window.showTextDocument(uri, {
          selection: range,
          preserveFocus: false,
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Jump History: failed to open file — ${err}`);
      } finally {
        setTimeout(() => { suppressRecording = false; }, 300);
      }
    })
  );

  async function navigateEntry(entry: JumpEntry | undefined): Promise<void> {
    if (!entry) {
      return;
    }
    await vscode.commands.executeCommand('jumpHistory.navigateTo', entry);
  }

  // Internal command used by hot spot tree items
  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.navigateToLine', async (uriStr: string, line: number) => {
      try {
        suppressRecording = true;
        const uri = vscode.Uri.parse(uriStr);
        const position = new vscode.Position(line, 0);
        const range = new vscode.Range(position, position);
        await vscode.window.showTextDocument(uri, {
          selection: range,
          preserveFocus: false,
        });
      } catch (err) {
        vscode.window.showErrorMessage(`Jump History: failed to open file — ${err}`);
      } finally {
        setTimeout(() => { suppressRecording = false; }, 300);
      }
    })
  );

  // ─── Selection handler for deleted entries ────────────────────────────────

  context.subscriptions.push(
    treeView.onDidChangeSelection((event) => {
      const selected = event.selection[0];
      if (!selected) {
        return;
      }
      if (selected.kind === 'entry' && selected.entry.deleted) {
        vscode.window.showInformationMessage(
          `File no longer exists: ${HistoryManager.displayName(selected.entry.uri)}`
        );
      }
    })
  );

  // ─── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.clearHistory', () => {
      const count = manager.getAll().filter((e) => !e.pinned).length;
      if (count === 0) {
        vscode.window.showInformationMessage('Jump History: Nothing to clear (pinned entries are kept)');
        return;
      }
      vscode.window
        .showWarningMessage(
          `Clear ${count} unpinned entries? Pinned entries will be kept.`,
          { modal: true },
          'Clear'
        )
        .then((choice) => {
          if (choice === 'Clear') {
            manager.clearHistory(false);
          }
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.clearAll', () => {
      const count = manager.getAll().length;
      if (count === 0) {
        vscode.window.showInformationMessage('Jump History: History is already empty');
        return;
      }
      vscode.window
        .showWarningMessage(
          `Clear all ${count} entries including pinned?`,
          { modal: true },
          'Clear All'
        )
        .then((choice) => {
          if (choice === 'Clear All') {
            manager.clearHistory(true);
          }
        });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.removeDeleted', () => {
      if (!manager.hasDeletedEntries()) {
        vscode.window.showInformationMessage('Jump History: No entries for deleted files');
        return;
      }
      manager.removeDeletedEntries();
      vscode.window.showInformationMessage('Jump History: Removed entries for deleted files');
    })
  );

  // Helper: delete an array of tree nodes in one batch
  function deleteNodes(nodes: readonly TreeNode[]): void {
    const ids: string[] = [];
    const locs: { uri: string; line: number }[] = [];
    for (const node of nodes) {
      if (node.kind === 'entry') {
        ids.push(node.entry.id);
      } else if (node.kind === 'hotSpotEntry') {
        locs.push({ uri: node.spot.uri, line: node.spot.line });
      }
      // fileGroup / hotSpotsGroup: not deletable via batch
    }
    if (ids.length > 0 || locs.length > 0) {
      manager.batchDelete(ids, locs);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.deleteEntry', (node: EntryNode | HotSpotEntryNode, allSelected?: TreeNode[]) => {
      // When multi-select is active, allSelected contains all highlighted items
      const targets = allSelected && allSelected.length > 0 ? allSelected : (node ? [node] : []);
      deleteNodes(targets);
    })
  );

  // Keyboard shortcut command: deletes whatever is currently selected in the tree
  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.deleteSelected', () => {
      const selected = treeView.selection;
      if (selected.length === 0) { return; }
      deleteNodes(selected);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.pinEntry', (node: EntryNode | HotSpotEntryNode) => {
      if (node?.kind === 'entry') {
        manager.pinEntry(node.entry.id, true);
      } else if (node?.kind === 'hotSpotEntry') {
        manager.pinByLocation(node.spot.uri, node.spot.line, true);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.unpinEntry', (node: EntryNode | HotSpotEntryNode) => {
      if (node?.kind === 'entry') {
        manager.pinEntry(node.entry.id, false);
      } else if (node?.kind === 'hotSpotEntry') {
        manager.pinByLocation(node.spot.uri, node.spot.line, false);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.copyPath', (node: EntryNode | HotSpotEntryNode) => {
      const uriStr = node?.kind === 'entry' ? node.entry.uri
        : node?.kind === 'hotSpotEntry' ? node.spot.uri
          : undefined;
      if (uriStr) {
        try {
          const fsPath = vscode.Uri.parse(uriStr).fsPath;
          vscode.env.clipboard.writeText(fsPath);
          vscode.window.showInformationMessage(`Copied: ${fsPath}`);
        } catch {
          vscode.window.showErrorMessage('Jump History: Failed to copy path');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.jumpToPrevious', async (node: EntryNode | HotSpotEntryNode) => {
      let target: JumpEntry | undefined;
      if (node?.kind === 'entry') {
        target = manager.getNeighborById(node.entry.id, 'prev');
      } else if (node?.kind === 'hotSpotEntry') {
        target = manager.getNeighborByLocation(node.spot.uri, node.spot.line, 'prev');
      }
      await navigateEntry(target);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.jumpToNext', async (node: EntryNode | HotSpotEntryNode) => {
      let target: JumpEntry | undefined;
      if (node?.kind === 'entry') {
        target = manager.getNeighborById(node.entry.id, 'next');
      } else if (node?.kind === 'hotSpotEntry') {
        target = manager.getNeighborByLocation(node.spot.uri, node.spot.line, 'next');
      }
      await navigateEntry(target);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.deleteFileGroup', (node: FileGroupNode) => {
      if (node?.kind === 'fileGroup') {
        const count = node.entries.length;
        vscode.window
          .showWarningMessage(
            `Remove all ${count} entries for ${HistoryManager.displayName(node.uri)}?`,
            { modal: true },
            'Remove'
          )
          .then((choice) => {
            if (choice === 'Remove') {
              manager.deleteFileGroup(node.uri);
            }
          });
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.toggleGroupByFile', () => {
      const cfg = vscode.workspace.getConfiguration('jumpHistory');
      const current = cfg.get<boolean>('groupByFile', true);
      cfg.update('groupByFile', !current, vscode.ConfigurationTarget.Global);
      realProvider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('jumpHistory.refresh', () => {
      realProvider.refresh();
    })
  );

  // ─── Config change watcher ─────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jumpHistory')) {
        realProvider.refresh();
        updateStatusBar();
      }
    })
  );

  // Register the treeView itself for disposal
  context.subscriptions.push(treeView);
}

export function deactivate(): void {
  // Nothing to clean up; subscriptions handle it
}
