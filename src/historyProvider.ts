import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryManager, JumpEntry, HotSpot } from './historyManager';

// ─── Node types ───────────────────────────────────────────────────────

export type TreeNode = FileGroupNode | EntryNode | HotSpotsGroupNode | HotSpotEntryNode;

export class HotSpotsGroupNode {
  readonly kind = 'hotSpotsGroup';
  constructor(public readonly spots: HotSpot[]) { }
}

export class HotSpotEntryNode {
  readonly kind = 'hotSpotEntry';
  constructor(public readonly spot: HotSpot) { }
}

export class FileGroupNode {
  readonly kind = 'fileGroup';
  constructor(
    public readonly uri: string,
    public readonly entries: JumpEntry[]
  ) { }
}

export class EntryNode {
  readonly kind = 'entry';
  constructor(public readonly entry: JumpEntry) { }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class NavHistoryProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private searchQuery = '';

  constructor(private readonly manager: HistoryManager) { }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setSearchQuery(query: string): void {
    this.searchQuery = query.trim().toLowerCase();
    this.refresh();
  }

  clearSearch(): void {
    this.searchQuery = '';
    this.refresh();
  }

  getSearchQuery(): string {
    return this.searchQuery;
  }

  // ─── TreeDataProvider ──────────────────────────────────────────────────────

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'hotSpotsGroup') {
      return this.makeHotSpotsGroupItem(node);
    }
    if (node.kind === 'hotSpotEntry') {
      return this.makeHotSpotEntryItem(node);
    }
    if (node.kind === 'fileGroup') {
      return this.makeFileGroupItem(node);
    }
    return this.makeEntryItem(node);
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (!node) {
      return this.getRoots();
    }
    if (node.kind === 'hotSpotsGroup') {
      return node.spots.map((s) => new HotSpotEntryNode(s));
    }
    if (node.kind === 'fileGroup') {
      return node.entries.map((e) => new EntryNode(e));
    }
    return [];
  }

  // ─── Root nodes ────────────────────────────────────────────────────────────

  private getRoots(): TreeNode[] {
    const cfg = vscode.workspace.getConfiguration('jumpHistory');
    const groupByFile = cfg.get<boolean>('groupByFile', true);
    const showHotSpots = cfg.get<boolean>('showHotSpots', true);
    const hotSpotsCount = cfg.get<number>('hotSpotsCount', 5);
    const hotSpotsMinVisits = cfg.get<number>('hotSpotsMinVisits', 2);

    const roots: TreeNode[] = [];

    // Hot Spots always at the top
    if (showHotSpots) {
      const spots = this.manager
        .getHotSpots(hotSpotsCount, hotSpotsMinVisits)
        .filter((s) => this.matchesHotSpot(s));
      if (spots.length > 0) {
        roots.push(new HotSpotsGroupNode(spots));
      }
    }

    if (groupByFile) {
      const grouped = this.manager.getGroupedByFile();
      for (const [uri, entries] of grouped) {
        const filtered = entries.filter((e) => this.matchesEntry(e));
        if (filtered.length > 0) {
          roots.push(new FileGroupNode(uri, filtered));
        }
      }
    } else {
      for (const e of this.manager.getFlat().filter((entry) => this.matchesEntry(entry))) {
        roots.push(new EntryNode(e));
      }
    }

    return roots;
  }

  private matchesEntry(e: JumpEntry): boolean {
    if (!this.searchQuery) {
      return true;
    }
    const displayName = HistoryManager.displayName(e.uri);
    const haystack = `${displayName} ${e.line + 1} ${e.lineText} ${e.source}`.toLowerCase();
    return haystack.includes(this.searchQuery);
  }

  private matchesHotSpot(h: HotSpot): boolean {
    if (!this.searchQuery) {
      return true;
    }
    const displayName = HistoryManager.displayName(h.uri);
    const haystack = `${displayName} ${h.line + 1} ${h.lineText} ${h.count}`.toLowerCase();
    return haystack.includes(this.searchQuery);
  }

  // ─── Hot Spots items ────────────────────────────────────────────────────

  private makeHotSpotsGroupItem(node: HotSpotsGroupNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      'Hot Spots',
      vscode.TreeItemCollapsibleState.Expanded
    );
    item.description = `top ${node.spots.length}`;
    item.tooltip = new vscode.MarkdownString(
      `**Hot Spots** — locations you visit most frequently\n\nClick an entry to jump there.`
    );
    item.iconPath = new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.red'));
    item.contextValue = 'hotSpotsGroup';
    return item;
  }

  private makeHotSpotEntryItem(node: HotSpotEntryNode): vscode.TreeItem {
    const s = node.spot;
    const displayName = HistoryManager.displayName(s.uri);
    const basename = path.basename(displayName);

    const item = new vscode.TreeItem(
      `L${s.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );

    const snippet = s.lineText || '(empty line)';
    item.description = `×${s.count}  ${snippet}  [${basename}]`;

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.appendMarkdown(`🔥 **Hot Spot** — visited **${s.count}** times\n\n`);
    md.appendMarkdown(`**${displayName}**, Line ${s.line + 1}\n\n`);
    if (s.lineText) {
      md.appendCodeblock(s.lineText, languageFromUri(s.uri));
    }
    md.appendMarkdown(`\nLast visited: ${formatRelativeTime(s.lastTimestamp)}`);
    item.tooltip = md;

    // Heat-based icon color: red for very hot, orange for warm
    const color = s.count >= 5
      ? new vscode.ThemeColor('charts.red')
      : new vscode.ThemeColor('charts.orange');
    item.iconPath = new vscode.ThemeIcon('flame', color);
    item.contextValue = 'hotSpotEntry';
    item.command = {
      command: 'jumpHistory.navigateToLine',
      title: 'Jump to hot spot',
      arguments: [s.uri, s.line],
    };
    return item;
  }

  // ─── File group item ───────────────────────────────────────────────────────

  private makeFileGroupItem(node: FileGroupNode): vscode.TreeItem {
    const displayName = HistoryManager.displayName(node.uri);
    const basename = path.basename(displayName);
    const dir = path.dirname(displayName);
    const ext = path.extname(basename).slice(1);

    const item = new vscode.TreeItem(
      basename,
      vscode.TreeItemCollapsibleState.Collapsed
    );

    const pinnedCount = node.entries.filter((e) => e.pinned).length;
    const deletedCount = node.entries.filter((e) => e.deleted).length;
    const total = node.entries.length;

    const parts: string[] = [];
    if (dir !== '.') { parts.push(dir); }
    parts.push(`${total} jump${total !== 1 ? 's' : ''}`);
    if (pinnedCount > 0) { parts.push(`${pinnedCount} pinned`); }
    item.description = parts.join(' · ');

    item.tooltip = new vscode.MarkdownString(
      `**${displayName}**\n\n${parts.slice(dir !== '.' ? 1 : 0).join(' · ')}${deletedCount > 0 ? `\n\n⚠️ File deleted` : ''}`
    );
    item.iconPath = deletedCount > 0
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : vscode.ThemeIcon.File;

    // Set resourceUri to get proper file icons from the theme
    try {
      item.resourceUri = vscode.Uri.parse(node.uri);
    } catch { /* ignore */ }

    item.contextValue = 'fileGroup';
    return item;
  }

  // ─── Entry item ────────────────────────────────────────────────────────────

  private makeEntryItem(node: EntryNode): vscode.TreeItem {
    const e = node.entry;
    const snippet = e.lineText || '(empty line)';
    const relTime = formatRelativeTime(e.timestamp);
    const sourceIcon = e.source === 'file-switch' ? '⇢' : '⚡';

    // Label: "L42 · snippet"  — compact and readable
    const item = new vscode.TreeItem(
      `L${e.line + 1}`,
      vscode.TreeItemCollapsibleState.None
    );

    // Description: source icon + snippet + relative time
    item.description = `${sourceIcon} ${snippet}  ·  ${relTime}`;
    item.tooltip = this.makeEntryTooltip(e);

    if (e.deleted) {
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'));
      item.contextValue = 'entryDeleted';
    } else if (e.pinned) {
      item.iconPath = new vscode.ThemeIcon('pinned', new vscode.ThemeColor('charts.yellow'));
      item.contextValue = 'entryPinned';
      item.command = this.makeNavigateCommand(e);
    } else {
      item.iconPath = new vscode.ThemeIcon('circle-small-filled', new vscode.ThemeColor('descriptionForeground'));
      item.contextValue = 'entry';
      item.command = this.makeNavigateCommand(e);
    }

    return item;
  }

  private makeEntryTooltip(e: JumpEntry): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = true;

    const displayName = HistoryManager.displayName(e.uri);
    const relTime = formatRelativeTime(e.timestamp);
    const sourceLabel = e.source === 'file-switch' ? '📂 File switch' : '⚡ Command jump';

    if (e.deleted) {
      md.appendMarkdown(`⚠️ **File deleted**\n\n`);
    }
    if (e.pinned) {
      md.appendMarkdown(`📌 **Pinned**\n\n`);
    }

    md.appendMarkdown(`**${displayName}**\n`);
    md.appendMarkdown(`Line ${e.line + 1}, Col ${e.character + 1}\n\n`);

    if (e.lineText) {
      md.appendCodeblock(e.lineText, languageFromUri(e.uri));
    }

    md.appendMarkdown(`\n${sourceLabel} · ${relTime}`);
    return md;
  }

  private makeNavigateCommand(e: JumpEntry): vscode.Command {
    return {
      command: 'jumpHistory.navigateTo',
      title: 'Jump to location',
      arguments: [e],
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) {
    return 'just now';
  }
  const min = Math.floor(sec / 60);
  if (min < 60) {
    return `${min} min ago`;
  }
  const hr = Math.floor(min / 60);
  if (hr < 24) {
    return `${hr} hr ago`;
  }
  const days = Math.floor(hr / 24);
  if (days === 1) {
    return 'yesterday';
  }
  return `${days} days ago`;
}

function languageFromUri(uriStr: string): string {
  const ext = path.extname(uriStr).slice(1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'tsx',
    js: 'javascript',
    jsx: 'jsx',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    rb: 'ruby',
    sh: 'bash',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    md: 'markdown',
    html: 'html',
    css: 'css',
    scss: 'scss',
  };
  return map[ext] ?? ext;
}
