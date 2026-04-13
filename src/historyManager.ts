import * as vscode from 'vscode';
import * as path from 'path';

export interface JumpEntry {
  id: string;
  uri: string;           // vscode.Uri.toString()
  line: number;          // 0-based
  character: number;     // 0-based
  timestamp: number;     // Date.now()
  lineText: string;      // truncated snippet of that line
  source: 'file-switch' | 'command-jump';
  pinned: boolean;
  deleted: boolean;      // file has been deleted
}

const STORAGE_KEY = 'jumpHistory.entries';
const DEDUP_WINDOW_MS = 500;
const MAX_CYCLE_LEN = 10;

export interface HotSpot {
  uri: string;
  line: number;
  lineText: string;
  count: number;
  lastTimestamp: number;
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class HistoryManager {
  private entries: JumpEntry[] = [];
  private lastEntry: JumpEntry | null = null;
  private readonly onChange: () => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    onChange: () => void
  ) {
    this.onChange = onChange;
    this.load();
  }

  // ─── Persistence ──────────────────────────────────────────────────────────

  private load(): void {
    const raw = this.context.workspaceState.get<JumpEntry[]>(STORAGE_KEY, []);
    this.entries = raw;
    this.lastEntry = this.entries.length > 0 ? this.entries[0] : null;
  }

  private save(): void {
    this.context.workspaceState.update(STORAGE_KEY, this.entries);
  }

  // ─── Config helpers ───────────────────────────────────────────────────────

  private maxEntries(): number {
    return vscode.workspace.getConfiguration('jumpHistory').get<number>('maxEntries', 500);
  }

  // ─── Add entry ────────────────────────────────────────────────────────────

  /**
   * Attempt to record a jump. Returns true if the entry was actually added.
   */
  addEntry(
    uri: vscode.Uri,
    line: number,
    character: number,
    lineText: string,
    source: JumpEntry['source']
  ): boolean {
    const uriStr = uri.toString();

    // Deduplicate: never record the exact same (uri, line) as the most recent entry
    if (this.lastEntry) {
      const samePlace =
        this.lastEntry.uri === uriStr && this.lastEntry.line === line;
      if (samePlace) {
        return false;
      }
    }

    const entry: JumpEntry = {
      id: makeId(),
      uri: uriStr,
      line,
      character,
      timestamp: Date.now(),
      lineText: lineText.trim().slice(0, 120),
      source,
      pinned: false,
      deleted: false,
    };

    // Prepend (newest first)
    this.entries.unshift(entry);
    this.lastEntry = entry;

    // Collapse jump loops (e.g. A->B->C->A->B->C becomes A->B->C)
    this.detectAndMergeCycle();

    // Enforce max limit (never remove pinned)
    const max = this.maxEntries();
    if (this.entries.length > max) {
      // Remove oldest non-pinned entries beyond the limit
      let removed = 0;
      this.entries = this.entries.filter((e, i) => {
        if (i < max) {
          return true;
        }
        if (e.pinned) {
          return true; // keep pinned even beyond limit
        }
        removed++;
        return false;
      });
    }

    this.save();
    this.onChange();
    return true;
  }

  // ─── Jump loop detection ──────────────────────────────────────────────────

  /**
   * After each new entry is prepended, check if entries[0..k-1] exactly matches
   * entries[k..2k-1] by (uri, line). If so, the user is cycling — remove the
   * duplicate older occurrence. Pinned entries are never removed.
   */
  private detectAndMergeCycle(): void {
    const len = this.entries.length;
    if (len < 4) {
      return;
    }
    const maxK = Math.min(MAX_CYCLE_LEN, Math.floor(len / 2));
    for (let k = 2; k <= maxK; k++) {
      let match = true;
      for (let i = 0; i < k; i++) {
        const a = this.entries[i];
        const b = this.entries[i + k];
        if (a.uri !== b.uri || a.line !== b.line) {
          match = false;
          break;
        }
      }
      if (!match) {
        continue;
      }
      // Don't remove pinned entries
      const toRemove = this.entries.slice(k, 2 * k);
      if (toRemove.some((e) => e.pinned)) {
        continue;
      }
      this.entries.splice(k, k);
      break;
    }
  }

  // ─── File change tracking ─────────────────────────────────────────────────

  /**
   * Called when files are deleted. Marks affected entries as deleted.
   */
  handleFilesDeleted(uris: readonly vscode.Uri[]): void {
    const deleted = new Set(uris.map((u) => u.toString()));
    let changed = false;
    for (const e of this.entries) {
      if (deleted.has(e.uri) && !e.deleted) {
        e.deleted = true;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.onChange();
    }
  }

  /**
   * Called when files are renamed/moved. Updates URIs in all affected entries.
   */
  handleFilesRenamed(renames: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): void {
    const map = new Map(renames.map((r) => [r.oldUri.toString(), r.newUri.toString()]));
    let changed = false;
    for (const e of this.entries) {
      const newUri = map.get(e.uri);
      if (newUri) {
        e.uri = newUri;
        e.deleted = false; // it now exists again
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.onChange();
    }
  }

  /**
   * Called on document text changes. Adjusts line numbers of entries
   * that come after the edit position to keep them accurate.
   */
  handleDocumentChange(event: vscode.TextDocumentChangeEvent): void {
    const uriStr = event.document.uri.toString();
    let changed = false;

    for (const change of event.contentChanges) {
      const startLine = change.range.start.line;
      const oldLines = change.range.end.line - change.range.start.line;
      const newLines = change.text.split('\n').length - 1;
      const delta = newLines - oldLines;

      if (delta === 0) {
        continue;
      }

      for (const e of this.entries) {
        if (e.uri === uriStr && e.line > startLine) {
          e.line = Math.max(startLine, e.line + delta);
          changed = true;
        }
      }
    }

    if (changed) {
      this.save();
      this.onChange();
    }
  }

  // ─── Mutations ────────────────────────────────────────────────────────────

  deleteEntry(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
    if (this.lastEntry?.id === id) {
      this.lastEntry = this.entries[0] ?? null;
    }
    this.save();
    this.onChange();
  }

  deleteFileGroup(uriStr: string): void {
    this.entries = this.entries.filter((e) => e.uri !== uriStr);
    if (this.lastEntry?.uri === uriStr) {
      this.lastEntry = this.entries[0] ?? null;
    }
    this.save();
    this.onChange();
  }

  pinEntry(id: string, pinned: boolean): void {
    const e = this.entries.find((e) => e.id === id);
    if (e) {
      e.pinned = pinned;
      this.save();
      this.onChange();
    }
  }

  clearHistory(includePinned: boolean): void {
    if (includePinned) {
      this.entries = [];
      this.lastEntry = null;
    } else {
      this.entries = this.entries.filter((e) => e.pinned);
      this.lastEntry = this.entries[0] ?? null;
    }
    this.save();
    this.onChange();
  }

  removeDeletedEntries(): void {
    this.entries = this.entries.filter((e) => !e.deleted);
    this.lastEntry = this.entries[0] ?? null;
    this.save();
    this.onChange();
  }

  hasDeletedEntries(): boolean {
    return this.entries.some((e) => e.deleted);
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  getAll(): JumpEntry[] {
    return this.entries;
  }

  /** Find the previous/next entry relative to a specific entry id in current timeline order. */
  getNeighborById(id: string, direction: 'next' | 'prev'): JumpEntry | undefined {
    const idx = this.entries.findIndex((e) => e.id === id);
    if (idx < 0) {
      return undefined;
    }
    if (direction === 'next') {
      return this.entries[idx + 1];
    }
    if (idx > 0) {
      return this.entries[idx - 1];
    }
    return undefined;
  }

  /**
   * For aggregated nodes (hot spots), resolve neighbor from the newest matching location.
   */
  getNeighborByLocation(uri: string, line: number, direction: 'next' | 'prev'): JumpEntry | undefined {
    const idx = this.entries.findIndex((e) => e.uri === uri && e.line === line);
    if (idx < 0) {
      return undefined;
    }
    if (direction === 'next') {
      return this.entries[idx + 1];
    }
    if (idx > 0) {
      return this.entries[idx - 1];
    }
    return undefined;
  }

  /** Returns entries grouped by file URI. Pinned entries appear first within each group. */
  getGroupedByFile(): Map<string, JumpEntry[]> {
    const map = new Map<string, JumpEntry[]>();
    for (const e of this.entries) {
      const group = map.get(e.uri) ?? [];
      group.push(e);
      map.set(e.uri, group);
    }
    // Sort within each group: pinned first, then by timestamp desc
    for (const [uri, group] of map) {
      map.set(
        uri,
        group.sort((a, b) => {
          if (a.pinned !== b.pinned) {
            return a.pinned ? -1 : 1;
          }
          return b.timestamp - a.timestamp;
        })
      );
    }
    return map;
  }

  /**
   * Returns hot spots: locations visited most frequently (non-deleted).
   * @param topN     How many to return.
   * @param minVisits Minimum visit count to qualify.
   */
  getHotSpots(topN: number, minVisits: number): HotSpot[] {
    const counts = new Map<string, HotSpot>();
    for (const e of this.entries) {
      if (e.deleted) {
        continue;
      }
      const key = `${e.uri}::${e.line}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
        if (e.timestamp > existing.lastTimestamp) {
          existing.lastTimestamp = e.timestamp;
          existing.lineText = e.lineText;
        }
      } else {
        counts.set(key, {
          uri: e.uri,
          line: e.line,
          lineText: e.lineText,
          count: 1,
          lastTimestamp: e.timestamp,
        });
      }
    }
    return Array.from(counts.values())
      .filter((h) => h.count >= minVisits)
      .sort((a, b) => b.count - a.count || b.lastTimestamp - a.lastTimestamp)
      .slice(0, topN);
  }

  /** Pin or unpin all entries at a given (uri, line) location. */
  pinByLocation(uri: string, line: number, pinned: boolean): void {
    let changed = false;
    for (const e of this.entries) {
      if (e.uri === uri && e.line === line && e.pinned !== pinned) {
        e.pinned = pinned;
        changed = true;
      }
    }
    if (changed) {
      this.save();
      this.onChange();
    }
  }

  /** Delete all entries at a given (uri, line) location. */
  deleteByLocation(uri: string, line: number): void {
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => !(e.uri === uri && e.line === line));
    if (this.entries.length !== before) {
      if (this.lastEntry?.uri === uri && this.lastEntry?.line === line) {
        this.lastEntry = this.entries[0] ?? null;
      }
      this.save();
      this.onChange();
    }
  }

  /**
   * Batch delete: removes all entries matching any of the given ids,
   * or any entry at any of the given (uri, line) locations.
   * Saves and fires onChange only once.
   */
  batchDelete(entryIds: string[], locations: { uri: string; line: number }[] = []): void {
    const idSet = new Set(entryIds);
    const locSet = new Set(locations.map((l) => `${l.uri}::${l.line}`));
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => {
      if (idSet.has(e.id)) { return false; }
      if (locSet.has(`${e.uri}::${e.line}`)) { return false; }
      return true;
    });
    if (this.entries.length !== before) {
      this.lastEntry = this.entries[0] ?? null;
      this.save();
      this.onChange();
    }
  }

  /** Flat list: pinned first (newest first), then non-pinned (newest first). */
  getFlat(): JumpEntry[] {
    const pinned = this.entries.filter((e) => e.pinned);
    const rest = this.entries.filter((e) => !e.pinned);
    return [...pinned, ...rest];
  }

  /** Display name for a URI (workspace-relative if possible, else basename). */
  static displayName(uriStr: string): string {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const wsFolder = vscode.workspace.getWorkspaceFolder(uri);
      if (wsFolder) {
        return path.relative(wsFolder.uri.fsPath, uri.fsPath);
      }
      return path.basename(uri.fsPath);
    } catch {
      return uriStr;
    }
  }
}
