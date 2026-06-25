import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

/** Strip ANSI escape codes and carriage returns from a string */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatRuntimeOptions {
  model?: string;
  reasoningEffort?: string;
  skill?: string;
}

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
}

interface SelectionContext {
  filePath: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  text: string;
  languageId: string;
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'jumpHistoryChat';
  private static readonly sessionsStateKey = 'jumpHistory.chat.sessions';
  private static readonly modelOptionsStateKey = 'jumpHistory.chat.availableModels';
  private static readonly skillOptionsStateKey = 'jumpHistory.chat.availableSkills';
  private static readonly maxSessions = 50;
  private static readonly stopGracePeriodMs = 1500;
  private static readonly stopForceKillMs = 4000;

  private view?: vscode.WebviewView;
  private sessionId: string;
  private currentProcess: cp.ChildProcess | null = null;
  private currentStreamingOutput: string = '';
  private isStreaming: boolean = false;
  private stopEscalationTimer: NodeJS.Timeout | null = null;
  private agentBinary: string;
  private currentSelection: SelectionContext | null = null;
  private attachedFiles: string[] = [];
  private sessions: ChatSession[] = [];
  private availableModels: string[];
  private availableSkills: string[];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.sessions = this.workspaceState.get<ChatSession[]>(ChatViewProvider.sessionsStateKey, []);
    this.availableModels = this.workspaceState.get<string[]>(ChatViewProvider.modelOptionsStateKey, []);
    this.availableSkills = this.workspaceState.get<string[]>(ChatViewProvider.skillOptionsStateKey, []);
    this.sessionId = this.sessions[0]?.id ?? `vscode-${Date.now().toString(36)}`;
    if (this.sessions.length === 0) {
      this.sessions = [this.createSession(this.sessionId, 'New Chat')];
      void this.saveSessions();
    }
    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');
  }

  private createSession(id: string, title: string): ChatSession {
    return {
      id,
      title,
      updatedAt: Date.now(),
      messages: [],
    };
  }

  private deriveSessionTitle(text: string): string {
    return text.slice(0, 28).trim() || 'New Chat';
  }

  private getCurrentSession(): ChatSession {
    let session = this.sessions.find((s) => s.id === this.sessionId);
    if (!session) {
      session = this.createSession(this.sessionId, 'New Chat');
      this.sessions.unshift(session);
      void this.saveSessions();
    }
    return session;
  }

  private async saveSessions(): Promise<void> {
    this.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    if (this.sessions.length > ChatViewProvider.maxSessions) {
      this.sessions = this.sessions.slice(0, ChatViewProvider.maxSessions);
    }
    await this.workspaceState.update(ChatViewProvider.sessionsStateKey, this.sessions);
  }

  private async renameSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((s) => s.id === sessionId);
    if (!session) {
      return;
    }
    const nextTitle = await vscode.window.showInputBox({
      title: 'Rename Chat Session',
      value: session.title,
      prompt: 'Enter a new session name',
      validateInput: (value) => value.trim().length === 0 ? 'Session name cannot be empty' : undefined,
    });
    if (nextTitle === undefined) {
      return;
    }
    session.title = nextTitle.trim();
    session.updatedAt = Date.now();
    await this.saveSessions();
    if (this.sessionId === session.id) {
      this.postCurrentSessionToWebview();
    }
  }

  public async renameCurrentSession(): Promise<void> {
    await this.renameSession(this.sessionId);
  }

  public async deleteCurrentSession(): Promise<void> {
    if (this.sessions.length <= 1) {
      vscode.window.showInformationMessage('At least one chat session must remain.');
      return;
    }
    const current = this.getCurrentSession();
    const confirmed = await vscode.window.showWarningMessage(
      `Delete session \"${current.title}\"?`,
      { modal: true },
      'Delete',
    );
    if (confirmed !== 'Delete') {
      return;
    }

    try {
      this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';
      cp.execFile(this.agentBinary, ['/sessions', 'delete', current.id], { cwd, env: { ...process.env } }, (error) => {
        if (error) {
          console.error(`Failed to delete session on backend: ${error.message}`);
        }
      });
    } catch (e) {
      console.error(`Failed to spawn backend delete session command: ${e}`);
    }

    this.sessions = this.sessions.filter((s) => s.id !== current.id);
    this.sessionId = this.sessions[0].id;
    this.currentSelection = null;
    this.attachedFiles = [];
    await this.saveSessions();
    this.postCurrentSessionToWebview();
    this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: [] });
  }

  private getSessionLabel(session: ChatSession): string {
    const time = new Date(session.updatedAt).toLocaleString();
    return `${session.title} (${session.messages.length} msgs) · ${time}`;
  }

  private postCurrentSessionToWebview(): void {
    const session = this.getCurrentSession();
    this.view?.webview.postMessage({
      type: 'loadSession',
      session: {
        id: session.id,
        title: session.title,
        messages: session.messages,
      },
    });
    // Ensure frontend state resets if backend is not streaming
    if (!this.isStreaming) {
      this.view?.webview.postMessage({ type: 'endResponse' });
    }
  }

  private async resolveAvailableModels(): Promise<string[]> {
    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      try {
        const child = cp.spawn(this.agentBinary, [], {
          cwd,
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        const finish = (rawText: string) => {
          if (settled) {
            return;
          }
          settled = true;
          const matches = Array.from(
            stripAnsi(rawText).matchAll(/^\s*(?:>>>\s*)?([a-zA-Z0-9._-]+)\s+\[[^\]]+\]\s*$/gm),
          ).map((match) => match[1]);
          const unique = [...new Set(matches)];
          resolve(unique);
        };

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          finish(`${stdout}\n${stderr}`);
        }, 4000);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', () => {
          clearTimeout(timer);
          finish(`${stdout}\n${stderr}`);
        });
        child.on('close', () => {
          clearTimeout(timer);
          finish(`${stdout}\n${stderr}`);
        });

        child.stdin?.write('/model\n');
        child.stdin?.end();
      } catch {
        resolve([]);
      }
    });
  }

  private async resolveAvailableSkills(): Promise<string[]> {
    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      try {
        const child = cp.spawn(this.agentBinary, ['--list-skills'], {
          cwd,
          env: { ...process.env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        const finish = (rawText: string) => {
          if (settled) {
            return;
          }
          settled = true;
          const matches = Array.from(
            stripAnsi(rawText).matchAll(/^\s*(?:[│|]\s*)?([a-zA-Z0-9._-]+)\s+·\s+/gm),
          ).map((match) => match[1]);
          const unique = [...new Set(matches)];
          resolve(unique);
        };

        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            // ignore
          }
          finish(`${stdout}\n${stderr}`);
        }, 4000);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on('error', () => {
          clearTimeout(timer);
          finish(`${stdout}\n${stderr}`);
        });
        child.on('close', () => {
          clearTimeout(timer);
          finish(`${stdout}\n${stderr}`);
        });
      } catch {
        resolve([]);
      }
    });
  }

  private async postRuntimeOptionsMeta(): Promise<void> {
    const [resolvedModels, resolvedSkills] = await Promise.all([
      this.resolveAvailableModels(),
      this.resolveAvailableSkills(),
    ]);
    if (resolvedModels.length > 0) {
      this.availableModels = resolvedModels;
      await this.workspaceState.update(ChatViewProvider.modelOptionsStateKey, resolvedModels);
    }
    if (resolvedSkills.length > 0) {
      this.availableSkills = resolvedSkills;
      await this.workspaceState.update(ChatViewProvider.skillOptionsStateKey, resolvedSkills);
    }
    this.view?.webview.postMessage({
      type: 'runtimeOptionsMeta',
      models: this.availableModels,
      skills: this.availableSkills,
    });
  }

  public async switchSessionQuickPick(): Promise<void> {
    const items = this.sessions
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((session) => ({
        label: session.title,
        description: session.id === this.sessionId ? 'Current Session' : undefined,
        detail: this.getSessionLabel(session),
        sessionId: session.id,
      }));

    if (items.length === 0) {
      vscode.window.showInformationMessage('No chat sessions yet.');
      return;
    }

    const picked = await vscode.window.showQuickPick(items, {
      title: 'Switch Chat Session',
      placeHolder: 'Choose a chat session',
    });
    if (!picked) {
      return;
    }

    this.sessionId = picked.sessionId;
    this.currentSelection = null;
    this.attachedFiles = [];
    this.postCurrentSessionToWebview();
    this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: [] });
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'errorMessage':
          console.error('[Webview Error]', data.text);
          break;
        case 'sendMessage':
          await this.handleUserMessage(data.text, {
            model: typeof data.model === 'string' ? data.model : undefined,
            reasoningEffort: typeof data.reasoningEffort === 'string' ? data.reasoningEffort : undefined,
            skill: typeof data.skill === 'string' ? data.skill : undefined,
          });
          break;
        case 'stop':
          this.view?.webview.postMessage({ type: 'statusFlag', label: 'Stopping...' });
          this.stopCurrentProcess();
          // Always ensure the UI stops streaming when stop is clicked
          this.isStreaming = false;
          this.view?.webview.postMessage({ type: 'endResponse' });
          break;
        case 'clearChat':
          this.newSession();
          break;
        case 'newSession':
          this.newSession();
          break;
        case 'switchSession':
          await this.switchSessionQuickPick();
          this.currentSelection = null;
          this.attachedFiles = [];
          break;
        case 'renameSession':
          await this.renameCurrentSession();
          break;
        case 'deleteSession':
          await this.deleteCurrentSession();
          break;
        case 'revertTurn':
          await this.revertToUserTurn(Number(data.userTurnIndex));
          break;
        case 'removeFile':
          this.attachedFiles = this.attachedFiles.filter(f => f !== data.filePath);
          break;
        case 'requestRuntimeOptionsMeta':
          void this.postRuntimeOptionsMeta();
          break;
        case 'clearSelection':
          this.currentSelection = null;
          break;
        case 'addFile':
          await this.pickAndAttachFiles();
          break;
        case 'pasteImage':
          await this.handlePastedImage(data.dataUrl, data.fileName);
          break;
        case 'inputFocus':
          await vscode.commands.executeCommand('setContext', 'jumpHistory.chatInputFocused', true);
          break;
        case 'inputBlur':
          await vscode.commands.executeCommand('setContext', 'jumpHistory.chatInputFocused', false);
          break;
        case 'openFile':
          await this.openFileAtLine(data.filePath, data.line);
          break;
      }
    });

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    this.postCurrentSessionToWebview();
    void this.postRuntimeOptionsMeta();

    if (this.isStreaming && this.currentStreamingOutput) {
      webviewView.webview.postMessage({ type: 'startResponse' });
      webviewView.webview.postMessage({ type: 'streamChunk', text: this.currentStreamingOutput });
    }
  }

  public triggerSend(): void {
    this.view?.webview.postMessage({ type: 'triggerSend' });
  }

  public newSession(): void {
    this.sessionId = `vscode-${Date.now().toString(36)}`;
    this.sessions.unshift(this.createSession(this.sessionId, 'New Chat'));
    void this.saveSessions();
    this.currentSelection = null;
    this.attachedFiles = [];
    this.postCurrentSessionToWebview();
    this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: [] });
  }

  /** Called from extension.ts when editor selection changes */
  public updateSelection(editor: vscode.TextEditor | undefined): void {
    if (!editor || editor.selection.isEmpty) {
      if (this.currentSelection) {
        this.currentSelection = null;
        this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
      }
      return;
    }
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') { return; }
    const sel = editor.selection;
    const text = doc.getText(sel);
    if (!text.trim()) {
      if (this.currentSelection) {
        this.currentSelection = null;
        this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
      }
      return;
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const filePath = doc.uri.fsPath;
    const relativePath = wsFolder && filePath.startsWith(wsFolder)
      ? filePath.slice(wsFolder.length + 1)
      : path.basename(filePath);
    this.currentSelection = {
      filePath,
      relativePath,
      startLine: sel.start.line + 1,
      endLine: sel.end.line + 1,
      text,
      languageId: doc.languageId,
    };
    this.view?.webview.postMessage({
      type: 'selectionUpdate',
      selection: {
        relativePath: this.currentSelection.relativePath,
        startLine: this.currentSelection.startLine,
        endLine: this.currentSelection.endLine,
        lineCount: text.split('\n').length,
      },
    });
  }

  /** Pick files via dialog and attach them */
  private async pickAndAttachFiles(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Attach',
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    });
    if (!uris || uris.length === 0) { return; }
    for (const uri of uris) {
      const fp = uri.fsPath;
      if (!this.attachedFiles.includes(fp)) {
        this.attachedFiles.push(fp);
      }
    }
    this.postFilesUpdate();
  }

  /** Handle image pasted from clipboard in webview */
  private async handlePastedImage(dataUrl: string, fileName: string): Promise<void> {
    const os = require('os');
    const fs = require('fs');
    // Extract base64 data from data URL
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
      return;
    }
    const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
    const base64Data = match[2];
    const tmpDir = path.join(os.tmpdir(), 'jump-chat-images');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    const finalName = fileName || `paste-${Date.now()}.${ext}`;
    const tmpPath = path.join(tmpDir, finalName);
    fs.writeFileSync(tmpPath, Buffer.from(base64Data, 'base64'));

    if (!this.attachedFiles.includes(tmpPath)) {
      this.attachedFiles.push(tmpPath);
    }
    this.postFilesUpdate();
  }

  private postFilesUpdate(): void {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const fs = require('fs');
    const chips = this.attachedFiles.map(fp => {
      const rel = wsFolder && fp.startsWith(wsFolder) ? fp.slice(wsFolder.length + 1) : path.basename(fp);
      const isImage = /\.(jpg|jpeg|png|gif|webp|bmp|tif|tiff|ico|qoi|avif)$/i.test(fp);
      let dataUrl: string | undefined;
      if (isImage) {
        try {
          const bytes = fs.readFileSync(fp);
          const ext = path.extname(fp).slice(1).toLowerCase();
          const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          dataUrl = `data:${mime};base64,${bytes.toString('base64')}`;
        } catch { /* ignore */ }
      }
      return { filePath: fp, relativePath: rel, isImage, dataUrl };
    });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: chips });
  }

  public addFileByPath(filePath: string): void {
    if (!this.attachedFiles.includes(filePath)) {
      this.attachedFiles.push(filePath);
    }
    this.postFilesUpdate();
  }

  private forceCleanup(): void {
    if (this.currentProcess) {
      try {
        this.currentProcess.kill('SIGKILL');
      } catch (e) { }
      this.currentProcess = null;
    }
    this.clearStopEscalationTimer();
    this.isStreaming = false;
    this.view?.webview.postMessage({ type: 'endResponse' });
  }

  private stopCurrentProcess(): void {
    if (this.currentProcess) {
      this.signalCurrentProcess('SIGINT');

      // Some agent binaries spawn subprocess trees. If Ctrl+C is ignored,
      // escalate after a short grace period so the stop button is reliable.
      this.clearStopEscalationTimer();
      this.stopEscalationTimer = setTimeout(() => {
        if (!this.currentProcess) {
          return;
        }
        this.signalCurrentProcess('SIGTERM');
        this.stopEscalationTimer = setTimeout(() => {
          if (!this.currentProcess) {
            return;
          }
          this.signalCurrentProcess('SIGKILL');
          this.forceCleanup();
        }, ChatViewProvider.stopForceKillMs - ChatViewProvider.stopGracePeriodMs);
      }, ChatViewProvider.stopGracePeriodMs);
    } else {
      this.forceCleanup();
    }
  }

  private clearStopEscalationTimer(): void {
    if (this.stopEscalationTimer) {
      clearTimeout(this.stopEscalationTimer);
      this.stopEscalationTimer = null;
    }
  }

  private signalCurrentProcess(signal: NodeJS.Signals): void {
    const child = this.currentProcess;
    if (!child) {
      return;
    }

    try {
      // On POSIX, spawn detached children so we can signal the whole process
      // group. This reliably stops agent wrappers plus their worker children.
      if (process.platform !== 'win32' && child.pid) {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // Fall back to signaling just the direct child.
    }

    try {
      child.kill(signal);
    } catch {
      // Ignore failures if the process has already exited.
    }
  }

  private async openFileAtLine(filePath: string, line?: number): Promise<void> {
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(wsFolder, filePath);
    try {
      const uri = vscode.Uri.file(absPath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const lineNum = line ? Math.max(0, line - 1) : 0;
      const range = new vscode.Range(lineNum, 0, lineNum, 0);
      await vscode.window.showTextDocument(doc, { selection: range, preview: true });
    } catch {
      vscode.window.showErrorMessage(`Cannot open file: ${filePath}`);
    }
  }

  private async runSessionCommand(sessionId: string, commandText: string | string[]): Promise<void> {
    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';

    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const commands = Array.isArray(commandText) ? commandText : [commandText];

      const child = cp.spawn(this.agentBinary, ['--session', sessionId], {
        cwd,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // ignore
        }
        finish(new Error('Timed out waiting for agent command to finish.'));
      }, 8000);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        finish(error);
      });
      child.on('close', (code) => {
        const details = stripAnsi(`${stdout}\n${stderr}`).trim();
        if (code === 0) {
          if (/(?:^|\n)\s*(?:local command error|error):/i.test(details)) {
            finish(new Error(details));
            return;
          }
          finish();
          return;
        }
        finish(new Error(details || `Agent command exited with code ${code ?? 'unknown'}.`));
      });

      child.stdin?.end(`${commands.map((command) => command.replace(/\n+$/g, '')).join('\n')}\n`);
    });
  }

  private getHistoryStorageDir(): string {
    return path.join(os.homedir(), '.history_file.sessions');
  }

  private getSessionDatabasePath(sessionId: string): string {
    return path.join(this.getHistoryStorageDir(), `${sessionId}.sqlite`);
  }

  private async runSqliteStatement(databasePath: string, sql: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = cp.spawn('sqlite3', [databasePath, sql], {
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/',
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const finish = (error?: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
          return;
        }
        resolve();
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => finish(error));
      child.on('close', (code) => {
        const details = stripAnsi(`${stdout}\n${stderr}`).trim();
        if (code === 0) {
          finish();
          return;
        }
        finish(new Error(details || `sqlite3 exited with code ${code ?? 'unknown'}.`));
      });
    });
  }

  private async forkBackendSessionBeforeUserTurn(sourceSessionId: string, targetSessionId: string, userTurnIndex: number): Promise<void> {
    const sourceDatabasePath = this.getSessionDatabasePath(sourceSessionId);
    const targetDatabasePath = this.getSessionDatabasePath(targetSessionId);
    await fs.mkdir(this.getHistoryStorageDir(), { recursive: true });
    await fs.copyFile(sourceDatabasePath, targetDatabasePath);

    const sql = `
      BEGIN;
      DELETE FROM messages
      WHERE id >= (
        SELECT id
        FROM messages
        WHERE role = 'user'
        ORDER BY id
        LIMIT 1 OFFSET ${userTurnIndex}
      );
      DELETE FROM meta WHERE key = 'first_user_prompt';
      INSERT INTO meta (key, value)
      SELECT 'first_user_prompt', content
      FROM messages
      WHERE role = 'user'
      ORDER BY id
      LIMIT 1;
      COMMIT;
    `;
    try {
      await this.runSqliteStatement(targetDatabasePath, sql);
    } catch (error) {
      try {
        await fs.unlink(targetDatabasePath);
      } catch {
        // ignore cleanup errors
      }
      throw error;
    }
  }

  private getUserTurnMessageIndex(messages: ChatMessage[], userTurnIndex: number): number {
    if (!Number.isInteger(userTurnIndex) || userTurnIndex < 0) {
      return -1;
    }
    let currentTurn = 0;
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role !== 'user') {
        continue;
      }
      if (currentTurn === userTurnIndex) {
        return i;
      }
      currentTurn++;
    }
    return -1;
  }

  private getUserTurnCount(messages: ChatMessage[]): number {
    return messages.filter((message) => message.role === 'user').length;
  }

  private rewindLocalSessionToTurn(session: ChatSession, userTurnIndex: number): boolean {
    const previousMessages = session.messages.slice();
    const targetMessageIndex = this.getUserTurnMessageIndex(previousMessages, userTurnIndex);
    if (targetMessageIndex < 0) {
      return false;
    }

    const previousFirstUser = previousMessages.find((message) => message.role === 'user');
    const previousAutoTitle = previousFirstUser ? this.deriveSessionTitle(previousFirstUser.content) : 'New Chat';
    const usingAutoTitle = session.title === previousAutoTitle;

    session.messages = previousMessages.slice(0, targetMessageIndex);

    if (usingAutoTitle) {
      const nextFirstUser = session.messages.find((message) => message.role === 'user');
      session.title = nextFirstUser ? this.deriveSessionTitle(nextFirstUser.content) : 'New Chat';
    }

    session.updatedAt = Date.now();
    return true;
  }

  private async revertToUserTurn(userTurnIndex: number): Promise<void> {
    if (this.isStreaming) {
      vscode.window.showInformationMessage('Stop the current response before reverting a round.');
      return;
    }

    const session = this.getCurrentSession();
    const targetMessageIndex = this.getUserTurnMessageIndex(session.messages, userTurnIndex);
    if (targetMessageIndex < 0) {
      vscode.window.showInformationMessage('Cannot find that chat round in this session.');
      return;
    }

    const previousSessionId = this.sessionId;
    const nextSessionId = `vscode-${Date.now().toString(36)}`;
    try {
      await this.forkBackendSessionBeforeUserTurn(previousSessionId, nextSessionId, userTurnIndex);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to revert the selected round: ${message}`);
      return;
    }

    session.id = nextSessionId;
    this.sessionId = nextSessionId;
    this.rewindLocalSessionToTurn(session, userTurnIndex);
    await this.saveSessions();
    this.postCurrentSessionToWebview();
  }

  private async handleUserMessage(text: string, runtimeOptions: ChatRuntimeOptions = {}): Promise<void> {
    if (!text.trim() || this.isStreaming) {
      return;
    }

    // Build final prompt with selection context prepended
    let prompt = text;
    if (this.currentSelection) {
      const s = this.currentSelection;
      prompt = `[Selected code from ${s.relativePath}:${s.startLine}-${s.endLine} (${s.languageId})]\n\`\`\`${s.languageId}\n${s.text}\n\`\`\`\n\n${text}`;
    }

    const session = this.getCurrentSession();
    session.messages.push({ role: 'user', content: text });
    session.updatedAt = Date.now();
    if (session.title === 'New Chat') {
      session.title = this.deriveSessionTitle(text);
    }
    void this.saveSessions();

    // Signal webview: start streaming
    this.view?.webview.postMessage({ type: 'startResponse' });

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';

    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');

    const args = ['--session', this.sessionId];
    const model = runtimeOptions.model?.trim();
    if (model) {
      args.push('--model', model);
    }
    const reasoningEffort = runtimeOptions.reasoningEffort?.trim();
    if (reasoningEffort) {
      args.push('--reasoning-effort', reasoningEffort);
    }
    const skill = runtimeOptions.skill?.trim();

    // Attach files via --files flag
    const allFiles = [...this.attachedFiles];
    if (this.currentSelection) {
      const selFile = this.currentSelection.filePath;
      if (!allFiles.includes(selFile)) {
        allFiles.push(selFile);
      }
    }
    if (allFiles.length > 0) {
      args.push('--files', allFiles.join(','));
    }

    // Clear attachments after sending
    this.currentSelection = null;
    this.attachedFiles = [];
    this.view?.webview.postMessage({ type: 'selectionUpdate', selection: null });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: [] });

    try {
      const child = cp.spawn(this.agentBinary, args, {
        cwd,
        detached: process.platform !== 'win32',
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProcess = child;
      this.clearStopEscalationTimer();

      // Write any runtime commands, then the user message, then close stdin.
      if (skill) {
        child.stdin?.write(`/skills ${skill}\n`);
      }
      child.stdin?.write(prompt + '\n');
      child.stdin?.end();

      this.currentStreamingOutput = '';
      this.isStreaming = true;
      let headerDone = false;
      let insideThinking = false;
      let stdoutBuffer = '';
      let stderrBuffer = '';

      const postStatus = (label: string) => {
        this.view?.webview.postMessage({ type: 'statusFlag', label });
      };

      const emitAssistantText = (textChunk: string) => {
        if (!textChunk) {
          return;
        }
        this.currentStreamingOutput += textChunk;
        this.view?.webview.postMessage({ type: 'streamChunk', text: textChunk });
      };

      const blockStartToken = (kind: 'thinking' | 'tool', title: string) =>
        `\n[[JUMP_BLOCK_START|${kind}|${encodeURIComponent(title)}]]\n`;
      const blockEndToken = '\n[[JUMP_BLOCK_END]]\n';
      const startStructuredBlock = (kind: 'thinking' | 'tool', title: string) => {
        emitAssistantText(blockStartToken(kind, title));
      };
      const endStructuredBlock = () => {
        emitAssistantText(blockEndToken);
      };

      const handleProtocolPayload = (payload: unknown): boolean => {
        if (Array.isArray(payload)) {
          let handled = false;
          for (const item of payload) {
            if (!item || typeof item !== 'object') {
              continue;
            }
            const record = item as {
              action?: string;
              step_append_info?: { token?: string; append_field?: string };
            };
            if (record.action === 'step_append') {
              const token = record.step_append_info?.token;
              if (typeof token === 'string' && token.length > 0) {
                emitAssistantText(token);
                handled = true;
              }
            }
          }
          return handled;
        }

        if (!payload || typeof payload !== 'object') {
          return false;
        }

        const record = payload as { final_report?: unknown; plan_status?: unknown };
        if (typeof record.final_report === 'string' && record.final_report.length > 0) {
          emitAssistantText(record.final_report);
          return true;
        }
        return typeof record.plan_status !== 'undefined';
      };

      const tryHandleProtocolLine = (line: string): boolean => {
        const trimmed = line.trim();
        if (!trimmed) {
          return false;
        }
        if (/^data:\s*\[DONE\]/i.test(trimmed)) {
          return true;
        }

        const payloadText = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        if (!payloadText) {
          return false;
        }
        if (!(payloadText.startsWith('{') || payloadText.startsWith('['))) {
          return false;
        }

        try {
          return handleProtocolPayload(JSON.parse(payloadText));
        } catch {
          return false;
        }
      };

      let insideAidaTool = false;
      let insideToolResult = false;
      let insideToolCall = false;
      let insidePlainToolTranscript = false;

      const closeAnyOpenBlocks = () => {
        if (insideThinking) {
          endStructuredBlock();
          insideThinking = false;
          this.view?.webview.postMessage({ type: 'thinkingEnd' });
        }
        if (insideAidaTool || insideToolResult || insideToolCall) {
          endStructuredBlock();
          insideAidaTool = false;
          insideToolResult = false;
          if (insideToolCall) {
            this.view?.webview.postMessage({ type: 'toolEnd' });
            insideToolCall = false;
          }
        }
        if (insidePlainToolTranscript) {
          endStructuredBlock();
          insidePlainToolTranscript = false;
        }
      };

      const processLine = (rawLine: string) => {
        let line = rawLine;

        const stripStreamPrefix = (value: string): string => {
          // Strip decorative stream prefixes (for tool/thinking output only).
          return value.replace(/^(?:>\s*)?(?:(?:\s*[\u2502\u2503\u2506\u250a\u254e\u254f|¦]\s+)+)/u, '');
        };

        const stripToolTranscriptLead = (value: string): string =>
          value.replace(/^\s*\|\s*/, '').trim();

        const isPromptCacheLine = (value: string): boolean =>
          /^promptcache$/i.test(value) ||
          /^\[prompt\s*cache\](?:\s+\d+\/\d+\s+prompt(?:\s+\w+)*\s+cached.*)?$/i.test(value) ||
          /^\d+\/\d+\s+prompt(?:\s+\w+)*\s+cached/i.test(value);

        const normalizeToolTranscriptValue = (rawValue: string): string => {
          const trimmedRawValue = rawValue.trim();
          if (trimmedRawValue.startsWith('|')) {
            return stripToolTranscriptLead(trimmedRawValue);
          }
          const strippedValue = stripStreamPrefix(rawValue).trim();
          return stripToolTranscriptLead(strippedValue || trimmedRawValue);
        };

        const isToolPathLikeLine = (value: string): boolean =>
          /^(?:~?\/|\.{1,2}\/|[A-Za-z0-9_.-]+\/)[^\s]*$/.test(value) ||
          /^[A-Za-z]:\\[^\s]*$/.test(value);
        const isMarkdownTableLikeLine = (rawValue: string): boolean => {
          const trimmedValue = rawValue.trim();
          if (!trimmedValue.startsWith('|')) {
            return false;
          }
          const body = trimmedValue.replace(/^\|/, '').replace(/\|$/, '');
          const cells = body.split('|').map((cell) => cell.trim());
          return cells.length >= 2 && cells.every((cell) => cell.length > 0 || /^:?-+:?$/.test(cell));
        };
        const isBoxDrawingPrefixedToolLine = (rawValue: string): boolean =>
          /^\s*[│┃┆┊╎╏¦]\s*\S/u.test(rawValue);
        const isAsciiPipePrefixedToolLine = (rawValue: string): boolean =>
          /^\s*\|\s*\S/.test(rawValue);
        const isPipePrefixedToolLine = (rawValue: string): boolean =>
          isBoxDrawingPrefixedToolLine(rawValue) || isAsciiPipePrefixedToolLine(rawValue);
        const isToolTranscriptStatusLine = (value: string): boolean =>
          /^(?:result|output)\s*:/i.test(value) ||
          /^\[(Completed|Running|Failed)\]/i.test(value);
        const isToolTranscriptFragment = (value: string): boolean =>
          isToolPathLikeLine(value) ||
          /^[{\[]/.test(value) ||
          /^["'`]/.test(value) ||
          /^[a-z0-9_.-]+\s*:\s*\S/i.test(value) ||
          /^(?:\.\.\.\s*)?\d+\s+lines?\s+folded\b/i.test(value) ||
          /^\d+\s+\S/.test(value) ||
          /^(?:error|warning|stderr|stdout|traceback)\b[: ]/i.test(value) ||
          /^(?:no such file|permission denied|command not found|exit code\b)/i.test(value);
        const isStandaloneToolTranscriptStartLine = (rawValue: string): boolean => {
          const normalizedValue = normalizeToolTranscriptValue(rawValue);
          if (isToolTranscriptStatusLine(normalizedValue)) {
            return false;
          }
          if (isBoxDrawingPrefixedToolLine(rawValue)) {
            return true;
          }
          if (!isAsciiPipePrefixedToolLine(rawValue)) {
            return false;
          }
          if (isAsciiPipePrefixedToolLine(rawValue) && isMarkdownTableLikeLine(rawValue)) {
            return false;
          }
          return isToolTranscriptFragment(normalizedValue);
        };

        const isToolTranscriptStartLine = (rawValue: string): boolean => {
          const normalizedValue = normalizeToolTranscriptValue(rawValue);
          return /^\s*[│┃┆┊╎╏|¦]\s*[a-z_][a-z0-9_]*(?:\s*(?:\(|["{])|$)/iu.test(rawValue) ||
            /^(web_search|call_tools|promptcache)$/i.test(normalizedValue) ||
            /^[a-z][a-z0-9_]*\s*\(/i.test(normalizedValue) ||
            /^Start query=/i.test(normalizedValue) ||
            /^Attempt \d+\/\d+/i.test(normalizedValue) ||
            /^(ddg|searchxng|searxng)_[a-z0-9_ -]+/i.test(normalizedValue) ||
            isStandaloneToolTranscriptStartLine(rawValue);
        };

        const isToolTranscriptContinuationLine = (rawValue: string): boolean => {
          const normalizedValue = normalizeToolTranscriptValue(rawValue);
          return isToolTranscriptStartLine(rawValue) ||
            isPipePrefixedToolLine(rawValue) ||
            isToolTranscriptFragment(normalizedValue);
        };

        const isToolTranscriptLine = (rawValue: string): boolean =>
          insidePlainToolTranscript
            ? isToolTranscriptContinuationLine(rawValue)
            : isToolTranscriptStartLine(rawValue);

        const isStandaloneToolName = (value: string): boolean =>
          /^(web_search|call_tools)$/i.test(value);

        const maybeHandlePlainToolTranscript = (rawValue: string): boolean => {
          const normalizedValue = normalizeToolTranscriptValue(rawValue);
          if (!normalizedValue) {
            if (insidePlainToolTranscript) {
              emitAssistantText('\n');
              return true;
            }
            return false;
          }

          const toolCallsIndex = normalizedValue.toLowerCase().indexOf('tool calls');
          if (toolCallsIndex >= 0) {
            const prefix = normalizedValue
              .slice(0, toolCallsIndex)
              .replace(/[,\s._-]*$/g, '')
              .trim();
            if (prefix) {
              emitAssistantText(`${prefix}\n`);
            }
            closeAnyOpenBlocks();
            startStructuredBlock('tool', '🔧 Tool Calls');
            insidePlainToolTranscript = true;
            return true;
          }

          const lowerNormalizedValue = normalizedValue.toLowerCase();
          const toolOutputIndex = lowerNormalizedValue.indexOf('tool output');
          const toolResultIndex = lowerNormalizedValue.indexOf('tool result');
          const toolOutputMarkerIndex = toolOutputIndex >= 0 ? toolOutputIndex : toolResultIndex;
          if (toolOutputMarkerIndex >= 0 &&
            isPipePrefixedToolLine(rawValue) &&
            !(isAsciiPipePrefixedToolLine(rawValue) && isMarkdownTableLikeLine(rawValue))) {
            const prefix = normalizedValue
              .slice(0, toolOutputMarkerIndex)
              .replace(/[,\s._-]*$/g, '')
              .trim();
            if (prefix) {
              emitAssistantText(`${prefix}\n`);
            }
            closeAnyOpenBlocks();
            insideToolResult = true;
            startStructuredBlock('tool', '📄 Tool Output');
            return true;
          }

          if (isPromptCacheLine(normalizedValue)) {
            closeAnyOpenBlocks();
            const normalized = /^promptcache$/i.test(normalizedValue)
              ? 'prompt cache'
              : normalizedValue;
            postStatus(normalized);
            return true;
          }

          if (!isToolTranscriptLine(rawValue)) {
            if (insidePlainToolTranscript) {
              closeAnyOpenBlocks();
            }
            return false;
          }

          if (!insidePlainToolTranscript) {
            closeAnyOpenBlocks();
            startStructuredBlock('tool', '🔧 Tool Calls');
            insidePlainToolTranscript = true;
          }

          if (!isStandaloneToolName(normalizedValue)) {
            emitAssistantText(`${normalizedValue}\n`);
          }
          return true;
        };

        if (insideToolResult && (line.match(/^(?:>\s*)?╭─/) || line.match(/^(?:>\s*)?╰─/) || line.match(/^(?:>\s*)?\[Thinking\]/i) || line.match(/^(?:>\s*)?[*_]Thinking[*_]/i))) {
          closeAnyOpenBlocks();
        }

        // Aida agent specific tool call block (outputs to stderr usually)
        if (/^(?:>\s*)?[*_]Running[*_]$/i.test(line.trim())) {
          closeAnyOpenBlocks();
          insideAidaTool = true;
          startStructuredBlock('tool', '🔧 Tool Execution');
          return;
        }
        if (/^(?:>\s*)?[*_](Completed|Failed)[*_]$/i.test(line.trim())) {
          closeAnyOpenBlocks();
          return;
        }
        if (insideAidaTool) {
          // Keep the raw text but strip leading `| ` if present, to show cleanly in the code block
          const stripped = stripStreamPrefix(line);
          emitAssistantText(stripped + '\n');
          return;
        }

        // Thinking markers anywhere
        if (line.match(/^╭─\s*thinking/i) || line.trim().match(/^\[Thinking\]$/i) || line.trim().match(/^[*_]Thinking[*_]$/i) || line.includes('╭─ thinking')) {
          closeAnyOpenBlocks();
          insideThinking = true;
          this.view?.webview.postMessage({ type: 'thinkingStart' });
          startStructuredBlock('thinking', 'Thinking...');
          return;
        }
        if (line.match(/^(?:>\s*)?╰─\s*done thinking/i) || line.includes('╰─ done thinking') || line.includes('╰─  done thinking')) {
          const regex = /(?:>\s*)?╰─\s*done thinking/ui;
          let match = line.match(regex);
          if (!match) {
            match = line.match(/╰─\s*done thinking/ui);
          }
          const idx = match ? match.index! : line.indexOf('done thinking') - 2;

          const beforeDoneThinking = stripStreamPrefix(line.substring(0, Math.max(0, idx))).trim();
          if (beforeDoneThinking && insideThinking) {
            emitAssistantText(beforeDoneThinking + '\n');
          }
          closeAnyOpenBlocks();
          headerDone = true;

          const afterDoneThinking = line.substring(idx + (match ? match[0].length : 15)).trim();
          if (afterDoneThinking) {
            line = afterDoneThinking;
            // Let the rest of the function process the remainder of the line
          } else {
            return;
          }
        }

        // While inside a thinking block, emit content and return early
        if (insideThinking) {
          const stripped = stripStreamPrefix(line);
          emitAssistantText(stripped + '\n');
          return;
        }

        const trimmed = line.trim();
        const normalizedToolLine = normalizeToolTranscriptValue(line);
        const isAssistantHeaderLine = /^(?:>\s*)?\[[^\]]+\(search:\s*(true|false)[^\]]*\)\]$/i.test(trimmed);

        if (isAssistantHeaderLine && (insidePlainToolTranscript || insideToolResult || insideToolCall || insideAidaTool)) {
          closeAnyOpenBlocks();
        }

        if (insideToolResult &&
          (/^(?:>\s*)?[╭╰]─/.test(trimmed) || /^(?:>\s*)?\[(Completed|Running|Failed)\]/i.test(trimmed))) {
          closeAnyOpenBlocks();
        }

        if (/^output:\s*(streaming command output|tool result)/i.test(normalizedToolLine)) {
          closeAnyOpenBlocks();
          insideToolResult = true;
          startStructuredBlock('tool', '📄 Tool Output');
          return;
        }

        if (insideToolResult) {
          emitAssistantText(normalizedToolLine + '\n');
          return;
        }

        if (maybeHandlePlainToolTranscript(line)) {
          return;
        }

        // Skip header lines (mcp info, model info, assistant info)
        if (!headerDone) {
          if (line.match(/^(?:>\s*)?╭─\s*(mcp|assistant)/) || line.match(/^(?:>\s*)?\[.*\(search:/) || line.trim() === '') {
            closeAnyOpenBlocks();
            return;
          }
          // Tool call start — let it fall through to tool processing below
          if (line.match(/^(?:>\s*)?╭─\s*(?:tool|call_tools?|call_tools)\s*·?\s*(.*)$/i)) {
            headerDone = true;
            // fall through
          } else {
            // If the line has actual content (not a known header), start emitting
            const stripped = stripStreamPrefix(line).trim();
            if (stripped.length > 0) {
              headerDone = true;
              // Let it fall through instead of skipping
            } else {
              return;
            }
          }
        }

        // Tool call markers
        const toolMatch = line.match(/^(?:>\s*)?╭─\s*(?:tool|call_tools?|call_tools)\s*·?\s*(.*)$/i);
        if (toolMatch) {
          closeAnyOpenBlocks();
          insideToolCall = true;
          let name = toolMatch[1].trim();
          if (/^(calls?)$/i.test(name)) {
            name = 'call_tools';
          }
          if (!name) {
            name = 'call_tools';
          }
          this.view?.webview.postMessage({ type: 'toolStart', name });
          startStructuredBlock('tool', `🔧 Tool: ${name}`);
          return;
        }
        if (line.match(/^(?:>\s*)?╰─\s*(?:tool|call_tools?|call_tools)/i)) {
          closeAnyOpenBlocks();
          return;
        }
        // Normalize and emit status flags as badges instead of mixing into assistant text
        if (/^(?:>\s*)?[│|]\s*result\s*:/i.test(trimmed)) {
          closeAnyOpenBlocks();
          postStatus(stripStreamPrefix(trimmed));
          return;
        }
        if (/^(?:>\s*)?\[(Completed|Running|Failed)\]/i.test(trimmed)) {
          closeAnyOpenBlocks();
          postStatus(trimmed.replace(/^(?:>\s*)?/, ''));
          return;
        }
        if (isAssistantHeaderLine) {
          closeAnyOpenBlocks();
          postStatus(trimmed.replace(/^(?:>\s*)?/, ''));
          return;
        }
        if (/^(?:>\s*)?(\[Thinking\]|[*_]Thinking[*_])\s*/i.test(trimmed)) {
          const thinkingText = trimmed.replace(/^(?:>\s*)?(\[Thinking\]|[*_]Thinking[*_])\s*/i, '').trim();
          if (thinkingText) {
            closeAnyOpenBlocks();
            startStructuredBlock('thinking', 'Thinking...');
            emitAssistantText(thinkingText + '\n');
            endStructuredBlock();
          }
          return;
        }
        if (line.match(/^(?:>\s*)?╭─\s*(mcp|assistant)/)) {
          closeAnyOpenBlocks();
          return;
        }

        // Skip more header/status lines after thinking
        if (line.match(/^(?:>\s*)?╭─/) || line.match(/^(?:>\s*)?╰─/)) {
          // Ignore tool/thinking boundaries here because we already processed them above.
          // This prevents swallowing remaining lines incorrectly.
          if (!insideToolResult && !insideThinking && !insideToolCall) {
            return;
          }
        }

        if (tryHandleProtocolLine(line)) {
          return;
        }
        // Skip output: prefixed tool result lines (they're shown as status badges)
        if (/^[│|]?\s*output:\s/i.test(trimmed)) {
          return;
        }

        // Keep generic assistant content unchanged to avoid corrupting markdown tables.
        emitAssistantText(line + '\n');
      };

      const processChunk = (raw: string, isStderr = false) => {
        const clean = stripAnsi(raw);
        if (isStderr) {
          stderrBuffer += clean;
          let newlineIndex = stderrBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = stderrBuffer.slice(0, newlineIndex);
            stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = stderrBuffer.indexOf('\n');
          }
        } else {
          stdoutBuffer += clean;
          let newlineIndex = stdoutBuffer.indexOf('\n');
          while (newlineIndex !== -1) {
            const line = stdoutBuffer.slice(0, newlineIndex);
            stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
            processLine(line);
            newlineIndex = stdoutBuffer.indexOf('\n');
          }
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        processChunk(data.toString(), false);
      });

      child.stderr?.on('data', (data: Buffer) => {
        processChunk(data.toString(), true);
      });

      child.on('close', () => {
        this.clearStopEscalationTimer();
        this.currentProcess = null;
        if (stdoutBuffer.trim().length > 0) {
          processLine(stdoutBuffer);
          stdoutBuffer = '';
        }
        if (stderrBuffer.trim().length > 0) {
          processLine(stderrBuffer);
          stderrBuffer = '';
        }

        // Ensure any unclosed HTML details/codeblocks are closed
        if (insideThinking) {
          endStructuredBlock();
          insideThinking = false;
        }
        if (insideAidaTool || insideToolResult || insideToolCall || insidePlainToolTranscript) {
          endStructuredBlock();
          insideAidaTool = false;
          insideToolResult = false;
          insidePlainToolTranscript = false;
          insideToolCall = false;
        }

        const content = this.currentStreamingOutput.trim();
        if (content) {
          const current = this.getCurrentSession();
          current.messages.push({ role: 'assistant', content });
          current.updatedAt = Date.now();
          void this.saveSessions();
        }
        this.isStreaming = false;
        this.view?.webview.postMessage({ type: 'endResponse' });
      });

      child.on('error', (err) => {
        this.clearStopEscalationTimer();
        this.currentProcess = null;
        this.isStreaming = false;
        this.view?.webview.postMessage({
          type: 'errorMessage',
          text: `Failed to start agent: ${err.message}\nMake sure the binary path is correct in settings (jumpHistory.agentBinaryPath).`,
        });
        this.view?.webview.postMessage({ type: 'endResponse' });
      });
    } catch (err: any) {
      this.currentProcess = null;
      this.isStreaming = false;
      this.view?.webview.postMessage({
        type: 'errorMessage',
        text: `Error: ${err.message}`,
      });
      this.view?.webview.postMessage({ type: 'endResponse' });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    // Inline marked.umd.js to guarantee it loads and avoids CSP/AMD issues
    const markedJsPath = vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'marked', 'lib', 'marked.umd.js').fsPath;
    let markedCode = '';
    try {
      markedCode = require('fs').readFileSync(markedJsPath, 'utf8').replace(/<\/script>/gi, '<\\/script>');
    } catch (e) {
      console.error('Failed to read marked.umd.js', e);
    }

    const katexCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.css')
    );
    const katexJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'katex.min.js')
    );
    const katexAutoRenderJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'katex', 'dist', 'contrib', 'auto-render.min.js')
    );
    const prismCssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'themes', 'prism-tomorrow.min.css')
    );
    const prismJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'prism.js')
    );
    const prismMarkupJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-markup.min.js')
    );
    const prismCssLangJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-css.min.js')
    );
    const prismClikeJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-clike.min.js')
    );
    const prismJsLangJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-javascript.min.js')
    );
    const prismTsJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-typescript.min.js')
    );
    const prismJsxJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-jsx.min.js')
    );
    const prismTsxJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-tsx.min.js')
    );
    const prismJsonJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-json.min.js')
    );
    const prismBashJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-bash.min.js')
    );
    const prismPythonJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-python.min.js')
    );
    const prismRustJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-rust.min.js')
    );
    const prismGoJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-go.min.js')
    );
    const prismYamlJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-yaml.min.js')
    );
    const prismDiffJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-diff.min.js')
    );
    const prismSqlJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-sql.min.js')
    );
    const prismJavaJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-java.min.js')
    );
    const prismCJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-c.min.js')
    );
    const prismCppJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-cpp.min.js')
    );
    const prismMarkdownJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'prismjs', 'components', 'prism-markdown.min.js')
    );
    const mermaidJsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
    );
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource}; img-src data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${katexCssUri}">
<link rel="stylesheet" href="${prismCssUri}">
<style nonce="${nonce}">
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    position: relative;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    flex-shrink: 0;
  }
  .header-title {
    font-weight: 600;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.7;
  }
  .session-title {
    margin-left: 8px;
    font-size: 11px;
    opacity: 0.65;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 170px;
  }
  .header-left {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .header-actions button {
    background: none;
    border: none;
    color: var(--vscode-foreground);
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 14px;
    opacity: 0.6;
  }
  .header-actions button:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
  .header-actions button:disabled {
    opacity: 0.3;
    cursor: default;
    background: none;
  }
  .send-btn.stop-mode {
    background: transparent;
    color: var(--vscode-errorForeground);
    border-color: var(--vscode-inputValidation-errorBorder, transparent);
  }
  .send-btn.stop-mode:hover {
    background: color-mix(in srgb, var(--vscode-inputValidation-errorBackground, transparent) 60%, transparent);
    border-color: transparent;
  }
  .send-btn:active {
    transform: scale(0.9);
  }
  @keyframes btn-vibrate {
    0% { transform: scale(1) translateX(0); }
    25% { transform: scale(0.95) translateX(-2px); }
    50% { transform: scale(0.95) translateX(2px); }
    75% { transform: scale(0.95) translateX(-2px); }
    100% { transform: scale(1) translateX(0); }
  }
  .send-btn.vibrate {
    animation: btn-vibrate 0.2s ease-in-out;
  }

  /* Messages */
  .messages-shell {
    flex: 1;
    min-height: 0;
    position: relative;
  }
  .messages {
    height: 100%;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .jump-to-bottom-btn {
    position: absolute;
    right: 16px;
    bottom: 16px;
    width: 30px;
    height: 30px;
    border: 1px solid rgba(127, 127, 127, 0.18);
    border-radius: 999px;
    background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)) 92%, transparent);
    color: color-mix(in srgb, var(--vscode-input-foreground) 78%, transparent);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.18);
    cursor: pointer;
    opacity: 0;
    transform: translateY(6px);
    pointer-events: none;
    transition: opacity 0.15s ease, transform 0.15s ease, background 0.15s ease, color 0.15s ease;
    z-index: 3;
  }
  .jump-to-bottom-btn.visible {
    opacity: 0.92;
    transform: translateY(0);
    pointer-events: auto;
  }
  .jump-to-bottom-btn:hover {
    background: color-mix(in srgb, var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)) 88%, transparent);
    color: var(--vscode-input-foreground);
  }

  .welcome {
    text-align: center;
    padding: 40px 20px;
    opacity: 0.5;
  }
  .welcome h3 { margin-bottom: 8px; font-weight: 500; }
  .welcome p { font-size: 12px; }

  .message {
    max-width: 100%;
    line-height: 1.5;
  }
  .message.user-shell {
    align-self: flex-end;
    max-width: 85%;
  }
  .user-row {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .user-bubble {
    min-width: 0;
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px;
    padding: 8px 12px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .user-actions {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 64px;
    width: 64px;
  }
  .message-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 0;
    height: 22px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 999px;
    background: transparent;
    color: color-mix(in srgb, var(--vscode-foreground) 70%, transparent);
    white-space: nowrap;
    writing-mode: horizontal-tb;
    cursor: pointer;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1;
    opacity: 0;
    pointer-events: none;
    transform: translateX(4px);
    transition: opacity 0.15s ease, transform 0.15s ease, color 0.15s ease, background 0.15s ease, border-color 0.15s ease;
  }
  .message.user-shell:hover .message-action,
  .message.user-shell:focus-within .message-action,
  .user-actions.confirm-open .message-action {
    opacity: 1;
    pointer-events: auto;
    transform: translateX(0);
  }
  .message-action:hover {
    color: var(--vscode-foreground);
    background: var(--vscode-toolbar-hoverBackground);
    border-color: var(--vscode-panel-border);
  }
  .message-action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .revert-confirm[hidden] {
    display: none;
  }
  .revert-confirm {
    position: fixed;
    left: 0;
    top: 0;
    width: min(220px, calc(100vw - 16px));
    background: color-mix(in srgb, var(--vscode-editorHoverWidget-background, #252526) 98%, transparent);
    color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
    border: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 88%, transparent);
    border-radius: 8px;
    padding: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
    z-index: 20;
  }
  .revert-confirm::after {
    content: '';
    position: absolute;
    left: var(--revert-confirm-arrow-left, 24px);
    width: 10px;
    height: 10px;
    background: color-mix(in srgb, var(--vscode-editorHoverWidget-background, #252526) 98%, transparent);
  }
  .revert-confirm.below::after {
    top: -6px;
    transform: rotate(45deg);
    border-left: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 88%, transparent);
    border-top: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 88%, transparent);
  }
  .revert-confirm.above::after {
    bottom: -6px;
    transform: rotate(45deg);
    border-right: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 88%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--vscode-widget-border, var(--vscode-panel-border)) 88%, transparent);
  }
  .revert-confirm-title {
    font-size: 12px;
    font-weight: 600;
    line-height: 1.3;
    margin-bottom: 4px;
  }
  .revert-confirm-detail {
    font-size: 11px;
    line-height: 1.4;
    opacity: 0.86;
  }
  .revert-confirm-preview {
    margin-top: 6px;
    font-size: 11px;
    line-height: 1.35;
    opacity: 0.72;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .revert-confirm-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 10px;
  }
  .revert-confirm-btn {
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 6px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    padding: 4px 10px;
    font-size: 11px;
    line-height: 1.2;
    cursor: pointer;
  }
  .revert-confirm-btn:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .revert-confirm-btn.secondary {
    background: transparent;
    color: var(--vscode-foreground);
    border-color: var(--vscode-panel-border);
  }
  .revert-confirm-btn.secondary:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .message.assistant {
    padding: 4px 0;
  }
  .assistant-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 6px;
    margin-bottom: 8px;
    align-items: center;
  }
  .assistant-content {
    word-break: break-word;
  }
  .assistant-content p {
    margin: 4px 0;
  }
  .assistant-content p:first-child {
    margin-top: 0;
  }
  .message.error {
    color: var(--vscode-errorForeground);
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder);
    border-radius: 8px;
    padding: 8px 12px;
  }

  /* Thinking indicator */
  .thinking-indicator {
    font-size: 12px;
    opacity: 0.5;
    font-style: italic;
    padding: 4px 0;
  }
  .thinking-indicator::after {
    content: '';
    animation: dots 1.5s steps(4,end) infinite;
  }
  @keyframes dots {
    0%   { content: ''; }
    25%  { content: '.'; }
    50%  { content: '..'; }
    75%  { content: '...'; }
    100% { content: ''; }
  }

  .thinking-details, .tool-details {
    margin: 8px 0;
    padding: 8px 12px;
    border-left: 3px solid var(--vscode-editorInfo-foreground, #3794ff);
    background: color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 10%, transparent);
    border-radius: 4px;
    font-size: 0.95em;
    color: var(--vscode-descriptionForeground);
  }
  .tool-details {
    border-left-color: var(--vscode-editorWarning-foreground, #cca700);
    background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 10%, transparent);
  }
  .thinking-details summary, .tool-details summary {
    cursor: pointer;
    font-weight: 600;
    margin-bottom: 4px;
    user-select: none;
    color: var(--vscode-editorInfo-foreground, #3794ff);
  }
  .tool-details summary {
    color: var(--vscode-editorWarning-foreground, #cca700);
  }
  .thinking-details[open] summary, .tool-details[open] summary {
    margin-bottom: 8px;
  }
  .thinking-details > *:last-child, .tool-details > *:last-child {
    margin-bottom: 0;
  }
  .thinking-body {
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .tool-details pre {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .tool-details pre code {
    white-space: inherit;
  }

  /* Tool indicator */
  .tool-indicator {
    font-size: 11px;
    opacity: 0.6;
    padding: 3px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    margin: 1px 0;
  }
  .status-indicator {
    font-size: 11px;
    opacity: 0.75;
    padding: 3px 8px;
    background: var(--vscode-editorInfo-background, var(--vscode-badge-background));
    color: var(--vscode-editorInfo-foreground, var(--vscode-badge-foreground));
    border-radius: 4px;
    display: inline-flex;
    align-items: center;
    margin: 1px 0;
  }

  /* Markdown rendering */
  .message.assistant code {
    font-family: var(--vscode-editor-font-family);
    font-size: 0.9em;
    background: var(--vscode-textCodeBlock-background);
    padding: 1px 4px;
    border-radius: 3px;
  }
  .message.assistant pre {
    background: var(--vscode-textCodeBlock-background);
    padding: 10px 12px;
    border-radius: 6px;
    overflow-x: auto;
    margin: 8px 0;
    position: relative;
  }
  .message.assistant pre code {
    background: none;
    padding: 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .copy-btn {
    position: absolute;
    top: 4px;
    right: 4px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    padding: 2px 6px;
    font-size: 10px;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .message.assistant pre:hover .copy-btn { opacity: 1; }
  .copy-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

  .message.assistant h1,
  .message.assistant h2,
  .message.assistant h3 { margin: 12px 0 4px; font-weight: 600; }
  .message.assistant h1 { font-size: 1.3em; }
  .message.assistant h2 { font-size: 1.15em; }
  .message.assistant h3 { font-size: 1.05em; }
  .message.assistant ul,
  .message.assistant ol { padding-left: 20px; margin: 4px 0; }
  .message.assistant li { margin: 2px 0; }
  .message.assistant blockquote {
    border-left: 3px solid var(--vscode-textBlockQuote-border);
    padding: 4px 12px;
    margin: 4px 0;
    opacity: 0.8;
  }
  .message.assistant a { color: var(--vscode-textLink-foreground); }
  .message.assistant a:hover { color: var(--vscode-textLink-activeForeground); }
  .message.assistant .file-link {
    text-decoration: underline;
    text-decoration-style: dotted;
    cursor: pointer;
  }
  .assistant-content table {
    display: block;
    width: max-content;
    max-width: 100%;
    overflow-x: auto;
    border-collapse: collapse;
    margin: 8px 0;
    border: 1px solid var(--vscode-panel-border);
  }
  .assistant-content th,
  .assistant-content td {
    border: 1px solid var(--vscode-panel-border);
    padding: 6px 10px;
    text-align: left;
    vertical-align: top;
  }
  .assistant-content th {
    background: var(--vscode-editor-inactiveSelectionBackground, var(--vscode-list-hoverBackground));
    font-weight: 600;
  }
  .assistant-content hr {
    border: none;
    border-top: 1px solid var(--vscode-panel-border);
    margin: 12px 0;
  }
  .assistant-content .katex-display {
    margin: 10px 0;
    overflow-x: auto;
    overflow-y: hidden;
    padding-bottom: 2px;
  }
  .assistant-content .katex {
    font-size: 1.02em;
  }
  .assistant-content del {
    opacity: 0.8;
  }
  .assistant-content ul.contains-task-list {
    list-style: none;
    padding-left: 0;
  }
  .assistant-content li.task-list-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .assistant-content li.task-list-item input[type="checkbox"] {
    margin-top: 0.25em;
    pointer-events: none;
  }
  .assistant-content .mermaid-block {
    margin: 10px 0;
    padding: 10px 12px;
    background: var(--vscode-editorWidget-background, var(--vscode-textCodeBlock-background));
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    overflow-x: auto;
  }
  .assistant-content .mermaid-error {
    color: var(--vscode-errorForeground);
    white-space: pre-wrap;
    font-family: var(--vscode-editor-font-family);
    font-size: 12px;
  }

  /* Input area */
  .input-area {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 12px;
    flex-shrink: 0;
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .input-wrapper {
    flex: 1;
    position: relative;
  }
  .input-toolbar {
    position: absolute;
    left: 12px;
    right: 46px;
    bottom: 12px;
    display: flex;
    gap: 2px;
    align-items: center;
    padding: 2px;
    width: fit-content;
    max-width: calc(100% - 46px);
    border: 1px solid rgba(127, 127, 127, 0.14);
    border-radius: 8px;
    background: rgba(127, 127, 127, 0.06);
    pointer-events: none;
  }
  .input-select {
    min-width: 0;
    max-width: 100%;
    height: 22px;
    padding: 0 18px 0 8px;
    border: none;
    border-radius: 6px;
    background-color: transparent;
    color: color-mix(in srgb, var(--vscode-input-foreground) 88%, transparent);
    font: inherit;
    font-size: 11px;
    line-height: 22px;
    pointer-events: auto;
    outline: none;
    appearance: none;
    -webkit-appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5 5 6.5 8 3.5' fill='none' stroke='rgba(255,255,255,0.55)' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
  }
  .input-select.model-select {
    flex: 0 1 104px;
  }
  .input-select.skill-select {
    flex: 0 1 86px;
  }
  .input-select.reasoning-select {
    flex: 0 1 84px;
  }
  .input-select:hover:not(:disabled),
  .input-select:focus {
    background-color: rgba(127, 127, 127, 0.10);
    color: var(--vscode-input-foreground);
  }
  textarea {
    width: 100%;
    resize: none;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 12px 40px 44px 12px;
    border-radius: 6px;
    outline: none;
    line-height: 1.4;
    min-height: 108px;
    max-height: 200px;
    overflow-y: auto;
  }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

  /* Context chips */
  .context-area {
    border-top: 1px solid var(--vscode-panel-border);
    padding: 6px 12px 0;
    flex-shrink: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
  }
  .context-area:empty { display: none; padding: 0; }
  .context-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    padding: 2px 6px 2px 8px;
    border-radius: 10px;
    max-width: 260px;
    white-space: nowrap;
    overflow: hidden;
  }
  .context-chip .chip-label {
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .context-chip .chip-icon {
    opacity: 0.6;
    flex-shrink: 0;
  }
  .context-chip .chip-remove {
    background: none;
    border: none;
    color: var(--vscode-badge-foreground);
    cursor: pointer;
    font-size: 12px;
    padding: 0 2px;
    opacity: 0.6;
    flex-shrink: 0;
    line-height: 1;
  }
  .context-chip .chip-remove:hover { opacity: 1; }
  .context-chip .chip-thumb {
    width: 20px;
    height: 20px;
    object-fit: cover;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .context-chip.selection { background: var(--vscode-textPreformat-background, var(--vscode-badge-background)); }
  .context-chip.file { background: var(--vscode-badge-background); }
  .input-actions {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: flex;
    gap: 4px;
    align-items: center;
  }
  .add-file-btn {
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    opacity: 0.85;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .add-file-btn:hover { opacity: 1; border-color: var(--vscode-focusBorder); }
  .add-file-btn:disabled { opacity: 0.3; cursor: default; }
</style>
</head>
<body>
  <div class="header">
    <div class="header-left">
      <span class="header-title">AI Chat</span>
      <span class="session-title" id="sessionTitle">New Chat</span>
    </div>
    <div class="header-actions">
      <button id="switchSessionBtn" title="Switch Session">☰</button>
      <button id="renameSessionBtn" title="Rename Session">✎</button>
      <button id="deleteSessionBtn" title="Delete Session">🗑</button>
      <button id="newChatBtn" title="New Chat">✚</button>
    </div>
  </div>
  <div class="messages-shell">
    <div class="messages" id="messages">
      <div class="welcome" id="welcome">
        <h3>AI Agent</h3>
        <p>Ask anything. Powered by your local agent.</p>
      </div>
    </div>
    <button id="jumpToBottomBtn" class="jump-to-bottom-btn" title="Jump to bottom">↓</button>
  </div>
  <div class="context-area" id="contextArea"></div>
  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="input" rows="3" placeholder="Ask a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-toolbar">
        <select id="modelSelect" class="input-select model-select">
          <option value="">Default</option>
        </select>
        <select id="skillSelect" class="input-select skill-select">
          <option value="">auto</option>
        </select>
        <select id="reasoningEffortSelect" class="input-select reasoning-select">
          <option value="">Default</option>
          <option value="minimal">minimal</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="off">off</option>
        </select>
      </div>
      <div class="input-actions">
        <button class="add-file-btn" id="addFileBtn" title="Attach files (+)">+</button>
      </div>
    </div>
  </div>

<script nonce="${nonce}">
  // Hide module, exports, and AMD define so UMD libraries expose themselves globally
  var __oldDefine = window.define;
  window.define = undefined;
  var __oldModule = window.module;
  window.module = undefined;
  var __oldExports = window.exports;
  window.exports = undefined;
</script>
<script nonce="${nonce}">
  ${markedCode}
</script>
<script nonce="${nonce}" src="${katexJsUri}"></script>
<script nonce="${nonce}" src="${katexAutoRenderJsUri}"></script>
<script nonce="${nonce}" src="${prismJsUri}"></script>
<script nonce="${nonce}" src="${prismMarkupJsUri}"></script>
<script nonce="${nonce}" src="${prismCssLangJsUri}"></script>
<script nonce="${nonce}" src="${prismClikeJsUri}"></script>
<script nonce="${nonce}" src="${prismJsLangJsUri}"></script>
<script nonce="${nonce}" src="${prismTsJsUri}"></script>
<script nonce="${nonce}" src="${prismJsxJsUri}"></script>
<script nonce="${nonce}" src="${prismTsxJsUri}"></script>
<script nonce="${nonce}" src="${prismJsonJsUri}"></script>
<script nonce="${nonce}" src="${prismBashJsUri}"></script>
<script nonce="${nonce}" src="${prismPythonJsUri}"></script>
<script nonce="${nonce}" src="${prismRustJsUri}"></script>
<script nonce="${nonce}" src="${prismGoJsUri}"></script>
<script nonce="${nonce}" src="${prismYamlJsUri}"></script>
<script nonce="${nonce}" src="${prismDiffJsUri}"></script>
<script nonce="${nonce}" src="${prismSqlJsUri}"></script>
<script nonce="${nonce}" src="${prismJavaJsUri}"></script>
<script nonce="${nonce}" src="${prismCJsUri}"></script>
<script nonce="${nonce}" src="${prismCppJsUri}"></script>
<script nonce="${nonce}" src="${prismMarkdownJsUri}"></script>
<script nonce="${nonce}" src="${mermaidJsUri}"></script>
<script nonce="${nonce}">
  // Restore original AMD/CommonJS environment
  window.define = __oldDefine;
  window.module = __oldModule;
  window.exports = __oldExports;
</script>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('error', (event) => {
    vscode.postMessage({ type: 'errorMessage', text: 'Webview Script Error: ' + event.message + '\\nSource: ' + event.filename });
  });
  vscode.postMessage({ type: 'requestRuntimeOptionsMeta' });

  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('input');
  const newChatBtn = document.getElementById('newChatBtn');
  const switchSessionBtn = document.getElementById('switchSessionBtn');
  const renameSessionBtn = document.getElementById('renameSessionBtn');
  const deleteSessionBtn = document.getElementById('deleteSessionBtn');
  const sessionTitleEl = document.getElementById('sessionTitle');
  const contextArea = document.getElementById('contextArea');
  const addFileBtn = document.getElementById('addFileBtn');
  const jumpToBottomBtn = document.getElementById('jumpToBottomBtn');
  const modelSelect = document.getElementById('modelSelect');
  const skillSelect = document.getElementById('skillSelect');
  const reasoningEffortSelect = document.getElementById('reasoningEffortSelect');

  let isStreaming = false;
  let currentAssistantEl = null;
  let currentAssistantMetaEl = null;
  let currentAssistantContentEl = null;
  let currentAssistantRaw = '';
  let currentSelection = null;
  let attachedFiles = [];
  let mermaidInitialized = false;
  let isImeComposing = false;
  let lastImeEndTime = 0;
  let isRefreshingModels = false;
  let followBottom = true;
  let pauseFollowForExpandedTag = false;
  let isProgrammaticScroll = false;
  let openRevertActionsEl = null;
  const blockOpenState = Object.create(null);
  const nearBottomThreshold = 24;

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= nearBottomThreshold;
  }

  function updateJumpToBottomButton() {
    if (!jumpToBottomBtn) {
      return;
    }
    const shouldShow = !isNearBottom() || !followBottom || pauseFollowForExpandedTag;
    jumpToBottomBtn.classList.toggle('visible', shouldShow);
    jumpToBottomBtn.title = pauseFollowForExpandedTag ? 'Resume auto-follow and jump to bottom' : 'Jump to bottom';
  }

  function scrollToBottom(force) {
    if (!force && (!followBottom || pauseFollowForExpandedTag)) {
      updateJumpToBottomButton();
      return;
    }
    isProgrammaticScroll = true;
    messagesEl.scrollTop = messagesEl.scrollHeight;
    requestAnimationFrame(() => {
      isProgrammaticScroll = false;
      if (force) {
        followBottom = true;
      }
      updateJumpToBottomButton();
    });
  }

  function resumeAutoFollowAndJump() {
    followBottom = true;
    pauseFollowForExpandedTag = false;
    scrollToBottom(true);
  }

  function hasExpandedBlocks() {
    return Object.values(blockOpenState).some(Boolean);
  }

  function setModelRefreshState(refreshing) {
    isRefreshingModels = refreshing;
  }

  function requestRuntimeOptionsMeta(forceRefresh) {
    if (isRefreshingModels) {
      return;
    }
    setModelRefreshState(true);
    vscode.postMessage({ type: 'requestRuntimeOptionsMeta', forceRefresh: !!forceRefresh });
  }

  inputEl.addEventListener('compositionstart', () => {
    isImeComposing = true;
  });
  inputEl.addEventListener('compositionend', () => {
    isImeComposing = false;
    lastImeEndTime = Date.now();
  });

  // ── Input history (persisted across reload) ──
  const prevState = vscode.getState() || {};
  let inputHistory = prevState.inputHistory || [];
  let historyIndex = -1;
  let savedInput = '';
  let availableModels = [];
  let availableSkills = [];
  let runtimeOptions = {
    model: typeof prevState.model === 'string' ? prevState.model : '',
    reasoningEffort: typeof prevState.reasoningEffort === 'string' ? prevState.reasoningEffort : '',
    skill: typeof prevState.skill === 'string' ? prevState.skill : ''
  };

  if (reasoningEffortSelect) {
    reasoningEffortSelect.value = runtimeOptions.reasoningEffort;
  }

  if (skillSelect) {
    skillSelect.value = runtimeOptions.skill;
  }

  function renderModelOptions() {
    if (!modelSelect) {
      return;
    }
    const currentValue = runtimeOptions.model || '';
    const merged = [''].concat(availableModels || []);
    if (currentValue && !merged.includes(currentValue)) {
      merged.push(currentValue);
    }
    modelSelect.innerHTML = '';
    merged.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || 'Default';
      if (value === currentValue) {
        option.selected = true;
      }
      modelSelect.appendChild(option);
    });
  }
  renderModelOptions();

  function renderSkillOptions() {
    if (!skillSelect) {
      return;
    }
    const currentValue = runtimeOptions.skill || '';
    const merged = [''].concat(availableSkills || []);
    if (currentValue && !merged.includes(currentValue)) {
      merged.push(currentValue);
    }
    skillSelect.innerHTML = '';
    merged.forEach((value) => {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = value || 'auto';
      if (value === currentValue) {
        option.selected = true;
      }
      skillSelect.appendChild(option);
    });
  }
  renderSkillOptions();
  setModelRefreshState(false);

  function persistHistory() {
    vscode.setState(Object.assign({}, vscode.getState() || {}, {
      inputHistory: inputHistory.slice(0, 100),
      model: runtimeOptions.model,
      reasoningEffort: runtimeOptions.reasoningEffort,
      skill: runtimeOptions.skill
    }));
  }

  function persistRuntimeOptions() {
    runtimeOptions = {
      model: modelSelect ? modelSelect.value : '',
      reasoningEffort: reasoningEffortSelect ? reasoningEffortSelect.value : '',
      skill: skillSelect ? skillSelect.value : ''
    };
    vscode.setState(Object.assign({}, vscode.getState() || {}, {
      inputHistory: inputHistory.slice(0, 100),
      model: runtimeOptions.model,
      reasoningEffort: runtimeOptions.reasoningEffort,
      skill: runtimeOptions.skill
    }));
  }

  // ── Simple Markdown → HTML ──
  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderMarkdown(text) {
    if (!text) {
      return '';
    }

    // LLM often generates malformed markdown tables (e.g. mismatched columns).
    // Let's try to fix them before passing to marked.
    function fixMarkdownTables(txt) {
      const lines = txt.split('\\n');
      const backtick = String.fromCharCode(96);
      const fenceBacktick = backtick + backtick + backtick;
      const fenceTilde = '~~~';

      const fenceToken = (l) => {
        const trimmed = l.trimStart();
        if (trimmed.startsWith(fenceBacktick)) return fenceBacktick;
        if (trimmed.startsWith(fenceTilde)) return fenceTilde;
        return '';
      };

      const normalizePipeLikes = (l) => {
        const pipeLikeCount = (l.match(/[|｜]/g) || []).length;
        if (pipeLikeCount >= 2) {
          return l.replace(/｜/g, '|');
        }
        return l;
      };

      const normalizeDashes = (l) => l.replace(/[—–−－﹣]/g, '-');
      const countCols = (l) => l.replace(/^\\|/, '').replace(/\\|$/, '').split('|').length;

      let fence = '';
      for (let i = 0; i < lines.length; i++) {
        const tok = fenceToken(lines[i]);
        if (tok) {
          if (!fence) {
            fence = tok;
          } else if (fence === tok) {
            fence = '';
          }
          continue;
        }
        if (fence) {
          continue;
        }
        lines[i] = normalizePipeLikes(lines[i]);
      }

      fence = '';
      for (let i = 1; i < lines.length; i++) {
        const tok = fenceToken(lines[i]);
        if (tok) {
          if (!fence) {
            fence = tok;
          } else if (fence === tok) {
            fence = '';
          }
          continue;
        }
        if (fence) {
          continue;
        }

        const normalizedDelimLine = normalizeDashes(lines[i].trim());
        if (/^\\|? *[:-]+ *\\| *[:-]+ *(?:\\| *[:-]+ *)*\\|?$/.test(normalizedDelimLine)) {
          const headerLine = normalizePipeLikes(lines[i - 1]).trim();
          if (!headerLine.includes('|')) continue;

          lines[i] = normalizeDashes(lines[i]);

          const delimCols = countCols(normalizeDashes(lines[i].trim()));
          const headerCols = countCols(headerLine);

          if (headerCols < delimCols) {
            const diff = delimCols - headerCols;
            let newHeader = headerLine;
            if (newHeader.startsWith('|')) {
              newHeader = newHeader.substring(1);
            }
            newHeader = '|' + '   |'.repeat(diff) + ' ' + newHeader;
            lines[i - 1] = newHeader;
          } else if (delimCols < headerCols) {
            const diff = headerCols - delimCols;
            let newDelim = normalizeDashes(lines[i].trim());
            if (newDelim.endsWith('|')) {
              newDelim = newDelim.substring(0, newDelim.length - 1);
            }
            newDelim = newDelim + '|---'.repeat(diff) + '|';
            lines[i] = newDelim;
          }

          if (!lines[i].trim().startsWith('|')) {
            lines[i] = '| ' + lines[i].trim();
          }

          for (let j = i + 1; j < lines.length; j++) {
            const dataLine = normalizePipeLikes(lines[j]).trim();
            if (dataLine === '' || !dataLine.includes('|')) break;
            lines[j] = normalizePipeLikes(lines[j]);
            if (!lines[j].trim().startsWith('|')) {
              lines[j] = '| ' + lines[j].trim();
            }
          }
        }
      }
      return lines.join('\\n');
    }

let fixedText = fixMarkdownTables(text);

// Handle incomplete code blocks: if there's an unclosed fence,
// close it so marked doesn't truncate output during streaming.
const fenceStr = String.fromCharCode(96) + String.fromCharCode(96) + String.fromCharCode(96);
const count = (fixedText.split(fenceStr).length - 1);
if (count % 2 === 1) {
  fixedText += '\\n' + fenceStr;
}

if (typeof marked !== 'undefined') {
  try {
    return marked.parse(fixedText, {
      gfm: true,
      breaks: true,
      async: false
    });
  } catch (e) {
    console.error('marked.parse failed:', e);
    let html = escapeHtml(fixedText);
    html = html.replace(/\\n/g, '<br>');
    return html;
  }
}
// Very simple fallback if marked fails to load
let html = escapeHtml(fixedText);
html = html.replace(/\\n/g, '<br>');
return html;
  }

function linkifyPaths(html) {
  var insideCode = false;
  const pathRegex = new RegExp('(^|[\\\\s(>])((?:\\\\.{1,2}\\\\/|\\\\/|[a-zA-Z0-9._-]+\\\\/)[a-zA-Z0-9._\\\\-/]*[a-zA-Z0-9._-]+\\\\.[a-zA-Z0-9._-]+)(?::(\\\\d+)(?:-(\\\\d+))?)?', 'g');

  return html.replace(/((?:<[^>]+>)|(?:[^<]+))/g, function (chunk) {
    if (chunk.startsWith('<')) {
      const lower = chunk.toLowerCase();
      if (lower.includes('<code') || lower.includes('<pre')) insideCode = true;
      if (lower.includes('</code') || lower.includes('</pre')) insideCode = false;
      return chunk;
    }
    if (insideCode) return chunk;

    return chunk.replace(pathRegex, function (_m, lead, filePath, startLine, endLine) {
      const suffix = startLine ? (endLine ? ':' + startLine + '-' + endLine : ':' + startLine) : '';
      const display = filePath + suffix;
      return lead + '<a class="file-link" href="#" data-path="' + filePath + '" data-line="' + (startLine || '') + '">' + display + '</a>';
    });
  });
}

function sanitizeHtml(html) {
  const template = document.createElement('template');
  template.innerHTML = html;

  const blockedTags = 'script,style,iframe,object,embed,link,meta,base,form,input,button,textarea,select,option';
  template.content.querySelectorAll(blockedTags).forEach((el) => el.remove());

  template.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value;

      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^\s*javascript:/i.test(value)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'style') {
        el.removeAttribute(attr.name);
      }
    }
  });

  return template.innerHTML;
}

function copyCode(btn) {
  const code = btn.previousElementSibling || btn.parentElement.querySelector('code');
  if (code) {
    navigator.clipboard.writeText(code.textContent);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  }
}
// Make copyCode globally available
window.copyCode = copyCode;

function addCopyButtons(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.copy-btn')) {
      return;
    }
    const code = pre.querySelector('code');
    if (!code) {
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => copyCode(btn));
    pre.appendChild(btn);
  });
}

function normalizeCodeLanguage(codeEl) {
  const classNames = Array.from(codeEl.classList);
  for (const name of classNames) {
    if (name.startsWith('language-')) {
      return name.slice('language-'.length).toLowerCase();
    }
  }
  return '';
}

function upgradeCodeLanguages(container) {
  container.querySelectorAll('pre code').forEach((code) => {
    const lang = normalizeCodeLanguage(code);
    if (!lang) {
      return;
    }
    if (lang === 'shell' && !code.classList.contains('language-bash')) {
      code.classList.add('language-bash');
    }
    if (lang === 'sh' && !code.classList.contains('language-bash')) {
      code.classList.add('language-bash');
    }
    if (lang === 'ts' && !code.classList.contains('language-typescript')) {
      code.classList.add('language-typescript');
    }
    if (lang === 'js' && !code.classList.contains('language-javascript')) {
      code.classList.add('language-javascript');
    }
    if (lang === 'html' && !code.classList.contains('language-markup')) {
      code.classList.add('language-markup');
    }
    if (lang === 'yml' && !code.classList.contains('language-yaml')) {
      code.classList.add('language-yaml');
    }
    if (lang === 'md' && !code.classList.contains('language-markdown')) {
      code.classList.add('language-markdown');
    }
  });
}

function highlightCodeBlocks(container) {
  if (typeof Prism === 'undefined') {
    return;
  }
  container.querySelectorAll('pre code').forEach((code) => {
    const lang = normalizeCodeLanguage(code);
    if (lang === 'mermaid') {
      return;
    }
    Prism.highlightElement(code);
  });
}

function upgradeLinks(container) {
  container.querySelectorAll('a[href]').forEach((link) => {
    if (link.classList.contains('file-link')) {
      return;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  });
}

function ensureMermaid() {
  if (mermaidInitialized || typeof mermaid === 'undefined') {
    return;
  }
  const styles = getComputedStyle(document.body);
  const fg = styles.getPropertyValue('--vscode-foreground').trim() || '#d4d4d4';
  const bg = styles.getPropertyValue('--vscode-editorWidget-background').trim()
    || styles.getPropertyValue('--vscode-sideBar-background').trim()
    || '#1e1e1e';
  const border = styles.getPropertyValue('--vscode-panel-border').trim() || fg;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    themeVariables: {
      darkMode: true,
      background: bg,
      mainBkg: bg,
      primaryColor: bg,
      secondaryColor: bg,
      primaryBorderColor: border,
      lineColor: fg,
      textColor: fg,
      primaryTextColor: fg
    }
  });
  mermaidInitialized = true;
}

function upgradeMermaidBlocks(container) {
  container.querySelectorAll('pre > code').forEach((code) => {
    const lang = normalizeCodeLanguage(code);
    if (lang !== 'mermaid') {
      return;
    }
    const pre = code.parentElement;
    if (!pre || !pre.parentElement) {
      return;
    }
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-block';
    const node = document.createElement('div');
    node.className = 'mermaid';
    node.textContent = code.textContent || '';
    wrapper.appendChild(node);
    pre.replaceWith(wrapper);
  });
}

function renderMermaid(container) {
  ensureMermaid();
  if (typeof mermaid === 'undefined') {
    return;
  }
  const nodes = Array.from(container.querySelectorAll('.mermaid'));
  if (nodes.length === 0) {
    return;
  }
  Promise.resolve(mermaid.run({ nodes })).catch((err) => {
    nodes.forEach((node) => {
      if (node.querySelector('svg')) {
        return;
      }
      node.classList.remove('mermaid');
      node.classList.add('mermaid-error');
      node.textContent = 'Mermaid render failed\\n' + ((err && err.message) || String(err));
    });
  });
}

function renderMath(container) {
  if (typeof renderMathInElement !== 'function') {
    return;
  }

  // Only render math when explicit delimiters are present.
  // This avoids mis-parsing normal text that contains '$' and '_' characters.
  const text = container.textContent || '';
  const hasExplicitMath = /\$\$[\s\S]+?\$\$|\\\([\s\S]+?\\\)|\\\[[\s\S]+?\\\]/.test(text);
  if (!hasExplicitMath) {
    return;
  }

  try {
    renderMathInElement(container, {
      throwOnError: false,
      strict: 'ignore',
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false }
      ]
    });
  } catch {
    // Ignore invalid partial formulas while streaming.
  }
}

function parseAssistantSegments(rawText) {
  const segments = [];
  const lines = rawText.split('\\n');
  let markdownLines = [];
  let currentBlock = null;

  function flushMarkdown() {
    if (markdownLines.length === 0) {
      return;
    }
    const text = markdownLines.join('\\n');
    markdownLines = [];
    if (!text.trim()) {
      return;
    }
    segments.push({ type: 'markdown', text });
  }

  for (const line of lines) {
    const blockMatch = line.match(/^\\[\\[JUMP_BLOCK_START\\|(thinking|tool)\\|(.+)\\]\\]$/);
    if (blockMatch) {
      flushMarkdown();
      currentBlock = {
        type: 'block',
        blockType: blockMatch[1],
        title: decodeURIComponent(blockMatch[2]),
        lines: []
      };
      continue;
    }

    if (line === '[[JUMP_BLOCK_END]]') {
      if (currentBlock) {
        segments.push({
          type: 'block',
          blockType: currentBlock.blockType,
          title: currentBlock.title,
          text: currentBlock.lines.join('\\n'),
          open: false
        });
        currentBlock = null;
      }
      continue;
    }

    if (currentBlock) {
      currentBlock.lines.push(line);
    } else {
      markdownLines.push(line);
    }
  }

  flushMarkdown();

  if (currentBlock) {
    segments.push({
      type: 'block',
      blockType: currentBlock.blockType,
      title: currentBlock.title,
      text: currentBlock.lines.join('\\n'),
      open: true
    });
  }

  return segments;
}

function createMarkdownSegment(text) {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = linkifyPaths(sanitizeHtml(renderMarkdown(text)));
  return wrapper;
}

function cleanStructuredBlockBody(text, blockType) {
  const lines = text.replace(/\\n+$/g, '').split('\\n');
  const cleaned = lines.filter((line) => {
    const trimmed = line.trim();
    if (blockType === 'thinking' && /^(?:\\.{3}|…)$/.test(trimmed)) {
      return false;
    }
    return true;
  });
  return cleaned.join('\\n').replace(/\\n+$/g, '');
}

function createBlockSegment(segment, blockKey) {
  const details = document.createElement('details');
  details.className = segment.blockType === 'thinking' ? 'thinking-details' : 'tool-details';
  details.open = Object.prototype.hasOwnProperty.call(blockOpenState, blockKey)
    ? Boolean(blockOpenState[blockKey])
    : Boolean(segment.open);
  details.dataset.blockKey = blockKey;

  const summary = document.createElement('summary');
  summary.textContent = segment.title;
  details.appendChild(summary);

  const bodyText = cleanStructuredBlockBody(segment.text, segment.blockType);
  if (segment.blockType === 'thinking') {
    if (bodyText) {
      const body = document.createElement('div');
      body.className = 'thinking-body';
      body.textContent = bodyText;
      details.appendChild(body);
    }
  } else if (bodyText) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    code.textContent = bodyText;
    pre.appendChild(code);
    details.appendChild(pre);
  }

  details.addEventListener('toggle', () => {
    blockOpenState[blockKey] = details.open;
    if (details.open) {
      pauseFollowForExpandedTag = true;
      followBottom = false;
    } else if (!hasExpandedBlocks() && isNearBottom()) {
      pauseFollowForExpandedTag = false;
      followBottom = true;
    } else if (!hasExpandedBlocks()) {
      pauseFollowForExpandedTag = false;
    }
    updateJumpToBottomButton();
  });

  return details;
}

function renderAssistantContent(container, rawText) {
  container.innerHTML = '';
  const segments = parseAssistantSegments(rawText);

  if (segments.length === 0 && rawText.trim()) {
    container.appendChild(createMarkdownSegment(rawText));
  } else {
    let blockIndex = 0;
    for (const segment of segments) {
      if (segment.type === 'markdown') {
        container.appendChild(createMarkdownSegment(segment.text));
      } else {
        const blockKey = segment.blockType + ':' + blockIndex + ':' + segment.title;
        blockIndex += 1;
        container.appendChild(createBlockSegment(segment, blockKey));
      }
    }
  }
  upgradeCodeLanguages(container);
  upgradeMermaidBlocks(container);
  addCopyButtons(container);
  highlightCodeBlocks(container);
  upgradeLinks(container);
  renderMermaid(container);
  renderMath(container);
}

function addUserMessage(text) {
  if (welcomeEl) welcomeEl.style.display = 'none';
  const userTurnIndex = messagesEl.querySelectorAll('.message.user-shell').length;
  messagesEl.appendChild(createUserMessage(text, userTurnIndex));
  scrollToBottom(true);
}

function createUserMessage(text, userTurnIndex) {
  const shell = document.createElement('div');
  shell.className = 'message user-shell';
  shell.dataset.userTurnIndex = String(userTurnIndex);

  const row = document.createElement('div');
  row.className = 'user-row';

  const actions = document.createElement('div');
  actions.className = 'user-actions';

  const revertBtn = document.createElement('button');
  revertBtn.className = 'message-action';
  revertBtn.type = 'button';
  revertBtn.dataset.action = 'revertTurn';
  revertBtn.dataset.userTurnIndex = String(userTurnIndex);
  revertBtn.setAttribute('aria-label', 'Revert to the state before this round.');
  revertBtn.textContent = 'Rewind';
  actions.appendChild(revertBtn);

  const confirm = document.createElement('div');
  confirm.className = 'revert-confirm';
  confirm.hidden = true;

  const title = document.createElement('div');
  title.className = 'revert-confirm-title';
  title.textContent = 'Revert to the state before this round?';

  const detail = document.createElement('div');
  detail.className = 'revert-confirm-detail';

  const preview = document.createElement('div');
  preview.className = 'revert-confirm-preview';

  const buttons = document.createElement('div');
  buttons.className = 'revert-confirm-buttons';

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'revert-confirm-btn secondary';
  cancelBtn.dataset.action = 'cancelRevertTurn';
  cancelBtn.textContent = 'Cancel';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'revert-confirm-btn';
  confirmBtn.dataset.action = 'confirmRevertTurn';
  confirmBtn.dataset.userTurnIndex = String(userTurnIndex);
  confirmBtn.textContent = 'Revert';

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  confirm.appendChild(title);
  confirm.appendChild(detail);
  confirm.appendChild(preview);
  confirm.appendChild(buttons);
  actions.appendChild(confirm);

  const bubble = document.createElement('div');
  bubble.className = 'user-bubble';
  bubble.textContent = text;

  row.appendChild(actions);
  row.appendChild(bubble);
  shell.appendChild(row);
  return shell;
}

function startAssistantMessage() {
  const el = document.createElement('div');
  el.className = 'message assistant';

  const metaEl = document.createElement('div');
  metaEl.className = 'assistant-meta';
  el.appendChild(metaEl);

  const contentEl = document.createElement('div');
  contentEl.className = 'assistant-content';
  el.appendChild(contentEl);

  messagesEl.appendChild(el);
  currentAssistantEl = el;
  currentAssistantMetaEl = metaEl;
  currentAssistantContentEl = contentEl;
  currentAssistantRaw = '';
  scrollToBottom(true);
}

// Throttled rendering: accumulate text, render at most once per 30ms to prevent lag
let renderPending = false;
let lastRenderTime = 0;

function flushAssistantRender() {
  if (!currentAssistantContentEl) {
    return;
  }
  renderAssistantContent(currentAssistantContentEl, currentAssistantRaw);
  scrollToBottom(false);
  lastRenderTime = Date.now();
}

function appendToAssistant(text) {
  if (!currentAssistantEl) startAssistantMessage();
  currentAssistantRaw += text;
  if (!renderPending) {
    renderPending = true;
    // Schedule re-render in 30ms, or immediately if we haven't rendered in a while
    const timeSinceLastRender = Date.now() - lastRenderTime;
    const scheduleDelay = timeSinceLastRender > 30 ? 0 : 30;

    if (scheduleDelay === 0) {
      flushAssistantRender();
      renderPending = false;
    } else {
      setTimeout(function () {
        renderPending = false;
        flushAssistantRender();
      }, scheduleDelay);
    }
  }
}

function appendAssistantFlag(className, text) {
  if (!currentAssistantEl) startAssistantMessage();
  const existing = currentAssistantMetaEl.querySelector('.' + className.replace(/\s+/g, '.'));
  if (existing) {
    existing.textContent = text;
  } else {
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    currentAssistantMetaEl.appendChild(el);
  }
  scrollToBottom(false);
}

function escapeForRender(text) {
  // Only escape characters that aren't part of markdown syntax
  // We need a careful approach: escape HTML, then apply markdown
  return text;
}

function closeOpenRevertConfirm(exceptEl) {
  if (!openRevertActionsEl || openRevertActionsEl === exceptEl) {
    return;
  }
  const popover = openRevertActionsEl.querySelector('.revert-confirm');
  if (popover) {
    popover.hidden = true;
    popover.classList.remove('above', 'below');
    popover.style.left = '';
    popover.style.top = '';
    popover.style.setProperty('--revert-confirm-arrow-left', '24px');
  }
  openRevertActionsEl.classList.remove('confirm-open');
  openRevertActionsEl = null;
}

function populateRevertConfirm(actionsEl) {
  const revertBtn = actionsEl.querySelector('[data-action="revertTurn"]');
  const detailEl = actionsEl.querySelector('.revert-confirm-detail');
  const previewEl = actionsEl.querySelector('.revert-confirm-preview');
  const shell = actionsEl.closest('.message.user-shell');
  const bubble = shell ? shell.querySelector('.user-bubble') : null;
  const userTurnIndex = Number(revertBtn ? revertBtn.dataset.userTurnIndex : '-1');
  const totalUserTurns = messagesEl.querySelectorAll('.message.user-shell').length;
  const removedCount = Number.isInteger(userTurnIndex) && userTurnIndex >= 0
    ? Math.max(1, totalUserTurns - userTurnIndex)
    : 1;
  if (detailEl) {
    detailEl.textContent = removedCount > 1
      ? 'This removes this prompt and all later rounds.'
      : 'This removes this prompt from the current session.';
  }
  if (previewEl) {
    const preview = (bubble && bubble.textContent ? bubble.textContent : '').trim().replace(/\s+/g, ' ').slice(0, 80);
    previewEl.textContent = preview;
    previewEl.hidden = !preview;
  }
}

function openRevertConfirm(actionsEl) {
  if (!actionsEl) {
    return;
  }
  closeOpenRevertConfirm(actionsEl);
  populateRevertConfirm(actionsEl);
  const revertBtn = actionsEl.querySelector('[data-action="revertTurn"]');
  const popover = actionsEl.querySelector('.revert-confirm');
  if (!popover || !revertBtn) {
    return;
  }
  popover.hidden = false;
  popover.classList.remove('above', 'below');
  popover.style.visibility = 'hidden';
  popover.style.left = '0px';
  popover.style.top = '0px';

  const spacing = 8;
  const viewportPadding = 8;
  const buttonRect = revertBtn.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const maxLeft = Math.max(viewportPadding, window.innerWidth - popoverRect.width - viewportPadding);
  const preferredLeft = buttonRect.left - 12;
  const left = Math.max(viewportPadding, Math.min(preferredLeft, maxLeft));
  const openBelow = window.innerHeight - buttonRect.bottom >= popoverRect.height + spacing + viewportPadding;
  const top = openBelow
    ? buttonRect.bottom + spacing
    : Math.max(viewportPadding, buttonRect.top - popoverRect.height - spacing);
  const arrowLeft = Math.max(
    14,
    Math.min(buttonRect.left + buttonRect.width / 2 - left - 5, popoverRect.width - 20)
  );

  popover.classList.add(openBelow ? 'below' : 'above');
  popover.style.left = String(left) + 'px';
  popover.style.top = String(top) + 'px';
  popover.style.setProperty('--revert-confirm-arrow-left', String(arrowLeft) + 'px');
  popover.style.visibility = '';
  actionsEl.classList.add('confirm-open');
  openRevertActionsEl = actionsEl;
}

function setStreaming(val) {
  if (val) {
    closeOpenRevertConfirm();
  }
  isStreaming = val;
  inputEl.disabled = val;
  addFileBtn.disabled = val;
  if (modelSelect) {
    modelSelect.disabled = val;
  }
  if (skillSelect) {
    skillSelect.disabled = val;
  }
  if (reasoningEffortSelect) {
    reasoningEffortSelect.disabled = val;
  }
  if (!val) {
    inputEl.focus();
  }
}

function endResponse() {
  renderPending = false;
  flushAssistantRender();
  currentAssistantEl = null;
  currentAssistantMetaEl = null;
  currentAssistantContentEl = null;
  currentAssistantRaw = '';
  setStreaming(false);
  updateJumpToBottomButton();
}

function canSendMessage() {
  return Boolean(inputEl.value.trim() || attachedFiles.length > 0 || currentSelection);
}

function fallbackPromptForContextOnly() {
  if (attachedFiles.some((f) => f && f.isImage)) {
    return 'Please analyze the attached image.';
  }
  if (attachedFiles.length > 0 || currentSelection) {
    return 'Please analyze the attached context.';
  }
  return '';
}

function sendMessage() {
  try {
    const typedText = inputEl.value.trim();
    const text = typedText || fallbackPromptForContextOnly();
    if (!text || isStreaming || !canSendMessage()) {
      return;
    }
    if (!Array.isArray(inputHistory)) {
      inputHistory = [];
    }
    inputHistory.unshift(text);
    historyIndex = -1;
    savedInput = '';
    persistHistory();
    addUserMessage(text);
    vscode.postMessage({
      type: 'sendMessage',
      text,
      model: runtimeOptions.model,
      reasoningEffort: runtimeOptions.reasoningEffort,
      skill: runtimeOptions.skill
    });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setStreaming(true);
  } catch (e) {
    vscode.postMessage({ type: 'errorMessage', text: 'sendMessage error: ' + e.message + '\\n' + e.stack });
    // Fallback: try to at least send the message if UI update fails
    try {
      const fallbackText = inputEl.value.trim() || fallbackPromptForContextOnly();
      if (fallbackText) {
        vscode.postMessage({ type: 'sendMessage', text: fallbackText });
      }
    } catch (e2) { }
  }
}

// ── Event handlers ──
newChatBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'newSession' });
  closeOpenRevertConfirm();
  messagesEl.innerHTML = '';
  if (welcomeEl) {
    messagesEl.appendChild(welcomeEl);
    welcomeEl.style.display = '';
  }
  currentAssistantEl = null;
  currentAssistantMetaEl = null;
  currentAssistantContentEl = null;
  currentAssistantRaw = '';
  currentSelection = null;
  attachedFiles = [];
  for (const key of Object.keys(blockOpenState)) {
    delete blockOpenState[key];
  }
  followBottom = true;
  pauseFollowForExpandedTag = false;
  renderContextChips();
  setStreaming(false);
  updateJumpToBottomButton();
});

switchSessionBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'switchSession' });
});

renameSessionBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'renameSession' });
});

deleteSessionBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'deleteSession' });
});

addFileBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'addFile' });
});

if (jumpToBottomBtn) {
  jumpToBottomBtn.addEventListener('click', () => {
    resumeAutoFollowAndJump();
  });
}

messagesEl.addEventListener('scroll', () => {
  if (openRevertActionsEl) {
    closeOpenRevertConfirm();
  }
  if (isProgrammaticScroll) {
    return;
  }
  const nearBottom = isNearBottom();
  if (nearBottom) {
    if (!pauseFollowForExpandedTag) {
      followBottom = true;
    }
  } else {
    followBottom = false;
  }
  updateJumpToBottomButton();
});

inputEl.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) {
    return;
  }
  // Prevent Enter from sending when using an IME (Input Method Editor)
  // In many browsers, pressing Enter to select IME candidates fires keydown with keyCode 229
  // or fires Enter but during composition.
  if (e.isComposing || isImeComposing || e.keyCode === 229) {
    return;
  }

  // Check if the time since the last compositionend is very short
  if (e.key === 'Enter' && (Date.now() - lastImeEndTime < 100)) {
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
  // Navigate input history with up/down arrows
  if (e.key === 'ArrowUp' && inputEl.selectionStart === 0 && inputEl.selectionEnd === 0) {
    if (inputHistory.length > 0 && historyIndex < inputHistory.length - 1) {
      if (historyIndex === -1) savedInput = inputEl.value;
      historyIndex++;
      inputEl.value = inputHistory[historyIndex];
      e.preventDefault();
    }
  }
  if (e.key === 'ArrowDown' && historyIndex >= 0) {
    if (inputEl.selectionStart === inputEl.value.length) {
      historyIndex--;
      inputEl.value = historyIndex === -1 ? savedInput : inputHistory[historyIndex];
      e.preventDefault();
    }
  }
});

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || isStreaming) {
    return;
  }
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) {
    return;
  }
  if (document.activeElement !== inputEl) {
    return;
  }
  if (e.isComposing || isImeComposing || e.keyCode === 229 || Date.now() - lastImeEndTime < 100) {
    return;
  }
  e.preventDefault();
  sendMessage();
}, true);

inputEl.addEventListener('focus', () => {
  vscode.postMessage({ type: 'inputFocus' });
});
inputEl.addEventListener('blur', () => {
  vscode.postMessage({ type: 'inputBlur' });
});
if (modelSelect) {
  modelSelect.addEventListener('change', persistRuntimeOptions);
  modelSelect.addEventListener('focus', () => {
    if (!isStreaming) {
      requestRuntimeOptionsMeta(false);
    }
  });
}
if (reasoningEffortSelect) {
  reasoningEffortSelect.addEventListener('change', persistRuntimeOptions);
}
if (skillSelect) {
  skillSelect.addEventListener('change', persistRuntimeOptions);
  skillSelect.addEventListener('focus', () => {
    if (!isStreaming) {
      requestRuntimeOptionsMeta(false);
    }
  });
}

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
});

// Paste image support
function postPastedImage(file, index) {
  if (!file || !file.type || !file.type.startsWith('image/')) {
    return false;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const dataUrl = reader.result;
    if (typeof dataUrl === 'string') {
      const ext = file.type.split('/')[1] || 'png';
      const safeExt = ext === 'jpeg' ? 'jpg' : ext;
      const fileName = 'paste-' + Date.now() + '-' + index + '.' + safeExt;
      vscode.postMessage({ type: 'pasteImage', dataUrl, fileName });
    }
  };
  reader.onerror = () => {
    vscode.postMessage({ type: 'errorMessage', text: 'Failed to read pasted image.' });
  };
  reader.readAsDataURL(file);
  return true;
}

let lastImagePasteAt = 0;
function handlePasteEvent(e) {
  if (e.defaultPrevented) {
    return false;
  }
  const clipboard = e.clipboardData;
  if (!clipboard) return false;
  let handled = false;
  let imageCount = 0;

  if (clipboard.items) {
    for (let i = 0; i < clipboard.items.length; i++) {
      const item = clipboard.items[i];
      if (item.type && item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (postPastedImage(file, imageCount++)) {
          handled = true;
        }
      }
    }
  }

  if (!handled && clipboard.files) {
    for (let i = 0; i < clipboard.files.length; i++) {
      if (postPastedImage(clipboard.files[i], imageCount++)) {
        handled = true;
      }
    }
  }

  if (handled) {
    lastImagePasteAt = Date.now();
    e.preventDefault();
    inputEl.focus();
  }
  return handled;
}

let clipboardReadPending = false;
async function tryReadClipboardImages() {
  if (Date.now() - lastImagePasteAt < 500) {
    return;
  }
  if (clipboardReadPending || !navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
    return;
  }
  clipboardReadPending = true;
  try {
    const items = await navigator.clipboard.read();
    let imageCount = 0;
    for (const item of items) {
      const imageType = item.types.find((type) => type.startsWith('image/'));
      if (!imageType) {
        continue;
      }
      const blob = await item.getType(imageType);
      const ext = imageType.split('/')[1] || 'png';
      const file = new File([blob], 'clipboard.' + (ext === 'jpeg' ? 'jpg' : ext), { type: imageType });
      if (postPastedImage(file, imageCount++)) {
        lastImagePasteAt = Date.now();
      }
    }
  } catch {
    // Clipboard read permission is not always available in VS Code webviews.
  } finally {
    clipboardReadPending = false;
  }
}

inputEl.addEventListener('paste', handlePasteEvent);
document.addEventListener('paste', handlePasteEvent, true);
document.addEventListener('keydown', (e) => {
  const isPasteShortcut = (e.key === 'v' || e.key === 'V') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
  if (!isPasteShortcut) {
    return;
  }
  setTimeout(() => {
    void tryReadClipboardImages();
  }, 50);
});

// ── Context chips rendering ──
function renderContextChips() {
  contextArea.innerHTML = '';
  // Selection chip
  if (currentSelection) {
    const chip = document.createElement('span');
    chip.className = 'context-chip selection';
    chip.innerHTML = '<span class="chip-icon">✂</span>'
      + '<span class="chip-label">' + escapeHtml(currentSelection.relativePath)
      + ':' + currentSelection.startLine + '-' + currentSelection.endLine
      + ' (' + currentSelection.lineCount + ' lines)</span>'
      + '<button class="chip-remove" data-action="clearSelection">×</button>';
    contextArea.appendChild(chip);
  }
  // File chips
  for (const f of attachedFiles) {
    const chip = document.createElement('span');
    chip.className = 'context-chip file';
    let iconHtml = '<span class="chip-icon">📎</span>';
    if (f.isImage && f.dataUrl) {
      iconHtml = '<img class="chip-thumb" src="' + f.dataUrl + '" alt="img">';
    }
    chip.innerHTML = iconHtml
      + '<span class="chip-label">' + escapeHtml(f.relativePath) + '</span>'
      + '<button class="chip-remove" data-action="removeFile" data-path="' + escapeHtml(f.filePath) + '">×</button>';
    contextArea.appendChild(chip);
  }
}

contextArea.addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-remove');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'clearSelection') {
    currentSelection = null;
    vscode.postMessage({ type: 'clearSelection' });
    renderContextChips();
  } else if (action === 'removeFile') {
    const fp = btn.dataset.path;
    attachedFiles = attachedFiles.filter(f => f.filePath !== fp);
    vscode.postMessage({ type: 'removeFile', filePath: fp });
    renderContextChips();
  }
});

// ── File path click handler ──
messagesEl.addEventListener('click', (e) => {
  const cancelRevertBtn = e.target.closest('[data-action="cancelRevertTurn"]');
  if (cancelRevertBtn) {
    e.preventDefault();
    e.stopPropagation();
    closeOpenRevertConfirm();
    return;
  }

  const confirmRevertBtn = e.target.closest('[data-action="confirmRevertTurn"]');
  if (confirmRevertBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (!isStreaming) {
      const userTurnIndex = Number(confirmRevertBtn.dataset.userTurnIndex);
      closeOpenRevertConfirm();
      if (Number.isInteger(userTurnIndex) && userTurnIndex >= 0) {
        vscode.postMessage({ type: 'revertTurn', userTurnIndex });
      }
    }
    return;
  }

  const revertBtn = e.target.closest('[data-action="revertTurn"]');
  if (revertBtn) {
    e.preventDefault();
    e.stopPropagation();
    if (!isStreaming) {
      const actionsEl = revertBtn.closest('.user-actions');
      if (actionsEl === openRevertActionsEl) {
        closeOpenRevertConfirm();
      } else {
        openRevertConfirm(actionsEl);
      }
    }
    return;
  }

  const link = e.target.closest('.file-link');
  if (!link) return;
  e.preventDefault();
  const fp = link.dataset.path;
  const ln = link.dataset.line ? parseInt(link.dataset.line, 10) : undefined;
  vscode.postMessage({ type: 'openFile', filePath: fp, line: ln });
});

document.addEventListener('click', (e) => {
  if (!openRevertActionsEl) {
    return;
  }
  if (e.target.closest('.user-actions')) {
    return;
  }
  closeOpenRevertConfirm();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !openRevertActionsEl) {
    return;
  }
  closeOpenRevertConfirm();
});

window.addEventListener('resize', () => {
  closeOpenRevertConfirm();
});

function renderLoadedSession(session) {
  closeOpenRevertConfirm();
  messagesEl.innerHTML = '';
  if (sessionTitleEl) {
    sessionTitleEl.textContent = session?.title || 'New Chat';
  }
  currentAssistantEl = null;
  currentAssistantMetaEl = null;
  currentAssistantContentEl = null;
  currentAssistantRaw = '';
  for (const key of Object.keys(blockOpenState)) {
    delete blockOpenState[key];
  }
  followBottom = true;
  pauseFollowForExpandedTag = false;

  const history = Array.isArray(session?.messages) ? session.messages : [];
  if (history.length === 0) {
    if (welcomeEl) {
      messagesEl.appendChild(welcomeEl);
      welcomeEl.style.display = '';
    }
    return;
  }

  let userTurnIndex = 0;
  for (const msg of history) {
    if (msg.role === 'user') {
      messagesEl.appendChild(createUserMessage(msg.content, userTurnIndex));
      userTurnIndex += 1;
    } else {
      const el = document.createElement('div');
      el.className = 'message assistant';
      const contentEl = document.createElement('div');
      contentEl.className = 'assistant-content';
      renderAssistantContent(contentEl, msg.content || '');
      el.appendChild(contentEl);
      messagesEl.appendChild(el);
    }
  }
  scrollToBottom(true);
  updateJumpToBottomButton();
}

// ── Messages from extension ──
window.addEventListener('message', (event) => {
  const data = event.data;
  switch (data.type) {
    case 'loadSession':
      renderLoadedSession(data.session);
      break;
    case 'startResponse':
      startAssistantMessage();
      break;
    case 'thinkingStart': {
      // Do not inject the floating Thinking... indicator anymore,
      // because we are rendering the actual thinking content now inside details.
      break;
    }
    case 'thinkingEnd': {
      break;
    }
    case 'toolStart': {
      const normalized = /^(calls?)$/i.test(data.name || '') ? 'call_tools' : (data.name || 'call_tools');
      const name = normalized !== 'call_tools' ? 'call_tools(' + normalized + ')' : 'call_tools';
      appendAssistantFlag('tool-indicator', '🔧 ' + name);
      break;
    }
    case 'toolEnd':
      break;
    case 'statusFlag': {
      appendAssistantFlag('status-indicator', '• ' + (data.label || 'status'));
      break;
    }
    case 'streamChunk':
      appendToAssistant(data.text);
      break;
    case 'endResponse':
      endResponse();
      break;
    case 'errorMessage': {
      const el = document.createElement('div');
      el.className = 'message error';
      el.textContent = data.text;
      messagesEl.appendChild(el);
      scrollToBottom(false);
      break;
    }
    case 'clearChat':
      closeOpenRevertConfirm();
      messagesEl.innerHTML = '';
      if (welcomeEl) {
        messagesEl.appendChild(welcomeEl);
        welcomeEl.style.display = '';
      }
      currentAssistantEl = null;
      currentAssistantMetaEl = null;
      currentAssistantContentEl = null;
      currentAssistantRaw = '';
      currentSelection = null;
      attachedFiles = [];
      for (const key of Object.keys(blockOpenState)) {
        delete blockOpenState[key];
      }
      followBottom = true;
      pauseFollowForExpandedTag = false;
      renderContextChips();
      setStreaming(false);
      updateJumpToBottomButton();
      break;
    case 'selectionUpdate':
      currentSelection = data.selection;
      renderContextChips();
      break;
    case 'filesUpdate':
      attachedFiles = data.files || [];
      renderContextChips();
      break;
    case 'runtimeOptionsMeta':
      availableModels = Array.isArray(data.models) ? data.models : [];
      availableSkills = Array.isArray(data.skills) ? data.skills : [];
      renderModelOptions();
      renderSkillOptions();
      setModelRefreshState(false);
      break;
    case 'triggerSend':
      sendMessage();
      break;
  }
});
</script>
  </body>
  </html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
