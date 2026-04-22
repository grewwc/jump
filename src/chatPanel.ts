import * as vscode from 'vscode';
import * as cp from 'child_process';
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

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
  ) {
    this.sessions = this.workspaceState.get<ChatSession[]>(ChatViewProvider.sessionsStateKey, []);
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

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    this.postCurrentSessionToWebview();

    if (this.isStreaming && this.currentStreamingOutput) {
      webviewView.webview.postMessage({ type: 'startResponse' });
      webviewView.webview.postMessage({ type: 'streamChunk', text: this.currentStreamingOutput });
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'errorMessage':
          console.error('[Webview Error]', data.text);
          break;
        case 'sendMessage':
          await this.handleUserMessage(data.text);
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
        case 'removeFile':
          this.attachedFiles = this.attachedFiles.filter(f => f !== data.filePath);
          break;
        case 'clearSelection':
          this.currentSelection = null;
          break;
        case 'addFile':
          await this.pickAndAttachFiles();
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
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    for (const uri of uris) {
      const fp = uri.fsPath;
      if (!this.attachedFiles.includes(fp)) {
        this.attachedFiles.push(fp);
      }
    }
    const chips = this.attachedFiles.map(fp => {
      const rel = wsFolder && fp.startsWith(wsFolder) ? fp.slice(wsFolder.length + 1) : path.basename(fp);
      return { filePath: fp, relativePath: rel };
    });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: chips });
  }

  public addFileByPath(filePath: string): void {
    if (!this.attachedFiles.includes(filePath)) {
      this.attachedFiles.push(filePath);
    }
    const wsFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    const chips = this.attachedFiles.map(fp => {
      const rel = wsFolder && fp.startsWith(wsFolder) ? fp.slice(wsFolder.length + 1) : path.basename(fp);
      return { filePath: fp, relativePath: rel };
    });
    this.view?.webview.postMessage({ type: 'filesUpdate', files: chips });
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

  private async handleUserMessage(text: string): Promise<void> {
    if (!text.trim() || this.isStreaming) { return; }

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
      session.title = text.slice(0, 28).trim() || 'New Chat';
    }
    void this.saveSessions();

    // Signal webview: start streaming
    this.view?.webview.postMessage({ type: 'startResponse' });

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.env.HOME ?? '/';

    this.agentBinary = vscode.workspace.getConfiguration('jumpHistory').get<string>('agentBinaryPath', 'a');

    const args = ['--session', this.sessionId];

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

      // Write the user message to stdin and close it
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

      const processLine = (rawLine: string) => {
        let line = rawLine;

        if (insideToolResult && (line.match(/^╭─/) || line.match(/^╰─/) || line.match(/^\[Thinking\]/i))) {
          emitAssistantText('\n```\n</details>\n\n');
          insideToolResult = false;
        }

        // Aida agent specific tool call block (outputs to stderr usually)
        if (/^\*Running\*$/.test(line.trim())) {
          insideAidaTool = true;
          emitAssistantText('\n<details class="tool-details"><summary>🔧 Tool Execution</summary>\n\n```\n');
          return;
        }
        if (/^\*(Completed|Failed)\*$/.test(line.trim())) {
          if (insideAidaTool) {
            emitAssistantText('\n```\n</details>\n\n');
            insideAidaTool = false;
          }
          return;
        }
        if (insideAidaTool) {
          // Keep the raw text but strip leading `| ` if present, to show cleanly in the code block
          const stripped = line.replace(/^\s*[│|]\s?/, '');
          emitAssistantText(stripped + '\n');
          return;
        }

        // Thinking markers anywhere
        if (line.match(/╭─\s*thinking/)) {
          insideThinking = true;
          this.view?.webview.postMessage({ type: 'thinkingStart' });
          emitAssistantText('\n<details class="thinking-details"><summary>Thinking...</summary>\n\n');
          return;
        }
        if (line.match(/╰─\s*done thinking/)) {
          if (insideThinking) {
            const beforeDoneThinking = line.replace(/╰─\s*done thinking[\s\S]*$/u, '').replace(/^\s*[│|]\s?/, '').trim();
            if (beforeDoneThinking) {
              emitAssistantText(beforeDoneThinking + '\n');
            }
            emitAssistantText('\n\n</details>\n\n');
          }
          insideThinking = false;
          this.view?.webview.postMessage({ type: 'thinkingEnd' });
          headerDone = true;
          return;
        }

        // While inside a thinking block, emit content and return early
        if (insideThinking) {
          const stripped = line.replace(/^\s*[│|]\s?/, '');
          emitAssistantText(stripped + '\n');
          return;
        }

        // Skip header lines (mcp info, model info, assistant info)
        if (!headerDone) {
          if (line.match(/^╭─\s*(mcp|assistant)/) || line.match(/^\[.*\(search:/) || line.trim() === '') {
            return;
          }
          // Tool call start — let it fall through to tool processing below
          if (line.match(/^╭─\s*(?:tool|call_tools?|call_tools)\s*·?\s*(.*)$/i)) {
            headerDone = true;
            // fall through
          } else {
            // If the line has actual content (not a known header), start emitting
            const stripped = line.replace(/^\s*[│|]\s?/, '').trim();
            if (stripped.length > 0) {
              headerDone = true;
              // fall through to content processing
            } else {
              return;
            }
          }
        }

        // Tool call markers
        const toolMatch = line.match(/^╭─\s*(?:tool|call_tools?|call_tools)\s*·?\s*(.*)$/i);
        if (toolMatch) {
          insideToolCall = true;
          let name = toolMatch[1].trim();
          if (/^(calls?)$/i.test(name)) {
            name = 'call_tools';
          }
          if (!name) {
            name = 'call_tools';
          }
          this.view?.webview.postMessage({ type: 'toolStart', name });
          // Add a code block start to neatly display the tool call content
          const safeName = name.replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const codeBlockStart = '\n<details class="tool-details"><summary>🔧 Tool: ' + safeName + '</summary>\n\n```\n';
          this.currentStreamingOutput += codeBlockStart;
          this.view?.webview.postMessage({ type: 'streamChunk', text: codeBlockStart });
          return;
        }
        if (line.match(/^╰─\s*(?:tool|call_tools?|call_tools)/i)) {
          insideToolCall = false;
          this.view?.webview.postMessage({ type: 'toolEnd' });
          // Add a code block end
          const codeBlockEnd = '\n```\n</details>\n\n';
          this.currentStreamingOutput += codeBlockEnd;
          this.view?.webview.postMessage({ type: 'streamChunk', text: codeBlockEnd });
          return;
        }
        // Normalize and emit status flags as badges instead of mixing into assistant text
        const trimmed = line.trim();
        if (/^[│|]\s*result\s*:/i.test(trimmed)) {
          if (insideToolResult) {
            emitAssistantText('\n```\n</details>\n\n');
            insideToolResult = false;
          }
          postStatus(trimmed.replace(/^[│|]\s*/u, ''));
          return;
        }
        if (/^\[(Completed|Running|Failed)\]/i.test(trimmed)) {
          postStatus(trimmed);
          return;
        }
        if (/^\[[^\]]+\(search:\s*(true|false)\)\]$/i.test(trimmed)) {
          postStatus(trimmed);
          return;
        }
        if (/^\[Thinking\]\s*/i.test(trimmed)) {
          const thinkingText = trimmed.replace(/^\[Thinking\]\s*/i, '').trim();
          if (thinkingText) {
            emitAssistantText('\n<details class="thinking-details"><summary>Thinking...</summary>\n\n' + thinkingText + '\n\n</details>\n\n');
          }
          return;
        }
        // Ignore the 'output: streaming command output' prefix and 'is asking the same question again' log that Minimax might emit directly
        if (/^[│|]\s*output: streaming command output/i.test(trimmed)) {
          if (insideToolCall) {
            emitAssistantText('\n```\n</details>\n\n');
            insideToolCall = false;
          }
          insideToolResult = true;
          emitAssistantText('\n<details class="tool-details"><summary>📄 Tool Output</summary>\n\n```\n');
          return;
        }

        if (insideToolResult) {
          const stripped = line.replace(/^\s*[│|]\s?/, '');
          emitAssistantText(stripped + '\n');
          return;
        }

        // Skip more header/status lines after thinking
        if (line.match(/^╭─/) || line.match(/^╰─/)) {
          return;
        }

        if (tryHandleProtocolLine(line)) {
          return;
        }
        // Skip output: prefixed tool result lines (they're shown as status badges)
        if (/^[│|]?\s*output:\s/i.test(trimmed)) {
          return;
        }

        // Actual content – strip leading box-drawing bars (may have leading whitespace)
        line = line.replace(/^\s*[│|]\s?/, '');
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
          emitAssistantText('\n\n</details>\n\n');
          insideThinking = false;
        }
        if (insideAidaTool || insideToolResult || insideToolCall) {
          emitAssistantText('\n```\n</details>\n\n');
          insideAidaTool = false;
          insideToolResult = false;
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource}; font-src ${webview.cspSource};">
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
  .messages {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  .message.user {
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 8px;
    padding: 8px 12px;
    align-self: flex-end;
    max-width: 85%;
    white-space: pre-wrap;
    word-break: break-word;
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
  textarea {
    width: 100%;
    resize: none;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 12px 38px 12px 12px;
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
  .context-chip.selection { background: var(--vscode-textPreformat-background, var(--vscode-badge-background)); }
  .context-chip.file { background: var(--vscode-badge-background); }
  .input-actions {
    position: absolute;
    right: 8px;
    bottom: 8px;
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add-file-btn, .send-btn {
    background: var(--vscode-button-secondaryBackground);
    border: 1px solid var(--vscode-panel-border);
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 14px;
    width: 24px;
    height: 24px;
    border-radius: 6px;
    opacity: 0.85;
    line-height: 1;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .send-btn {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: transparent;
  }
  .add-file-btn:hover, .send-btn:hover { opacity: 1; border-color: var(--vscode-focusBorder); }
  .add-file-btn:disabled, .send-btn:disabled { opacity: 0.3; cursor: default; }
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
  <div class="messages" id="messages">
    <div class="welcome" id="welcome">
      <h3>AI Agent</h3>
      <p>Ask anything. Powered by your local agent.</p>
    </div>
  </div>
  <div class="context-area" id="contextArea"></div>
  <div class="input-area">
    <div class="input-wrapper">
      <textarea id="input" rows="3" placeholder="Ask a question... (Enter to send, Shift+Enter for newline)"></textarea>
      <div class="input-actions">
        <button class="add-file-btn" id="addFileBtn" title="Attach files (+)">+</button>
        <button class="send-btn" id="sendBtn" title="Send (Enter)">↑</button>
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
  const sendBtn = document.getElementById('sendBtn');

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

  function persistHistory() {
    vscode.setState(Object.assign({}, vscode.getState() || {}, { inputHistory: inputHistory.slice(0, 100) }));
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
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        // Match a table delimiter row like ---|---|--- or |---|---|---|
        if (/^\\|? *[:-]+ *\\| *[:-]+ *(?:\\| *[:-]+ *)*\\|?$/.test(line)) {
          const headerLine = lines[i - 1].trim();
          if (!headerLine.includes('|')) continue;
          
          const countCols = (l) => l.replace(/^\\|/, '').replace(/\\|$/, '').split('|').length;
          
          const delimCols = countCols(line);
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
            let newDelim = line;
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
            const dataLine = lines[j].trim();
            if (dataLine === '' || !dataLine.includes('|')) break; // End of table
            if (!dataLine.startsWith('|')) {
              lines[j] = '| ' + lines[j].trim();
            }
          }
        }
      }
      return lines.join('\\n');
    }

    const fixedText = fixMarkdownTables(text);

    if (typeof marked !== 'undefined') {
      return marked.parse(fixedText, {
        gfm: true,
        breaks: true,
        async: false
      });
    }
    // Very simple fallback if marked fails to load
    let html = escapeHtml(fixedText);
    html = html.replace(/\\n/g, '<br>');
    return html;
  }

  function linkifyPaths(html) {
    var insideCode = false;
    return html.replace(/((?:<[^>]+>)|(?:[^<]+))/g, function(segment) {
      if (segment.startsWith('<')) {
        const lower = segment.toLowerCase();
        if (lower.includes('<code') || lower.includes('<pre')) insideCode = true;
        if (lower.includes('</code') || lower.includes('</pre')) insideCode = false;
        return segment;
      }
      if (insideCode) return segment;
      return segment.replace(/(\\/?)([a-zA-Z0-9_.\\-]+\\/(?:[a-zA-Z0-9_.\\-]+\\/)*[a-zA-Z0-9_.\\-]+\\.[a-zA-Z0-9]+)(?::(\\d+)(?:-(\\d+))?)?/g, function(m, slash, fp, ln) {
        var fullPath = slash + fp;
        return '<a class="file-link" href="#" data-path="' + fullPath + '" data-line="' + (ln || '') + '">' + m + '</a>';
      });
    });
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
    try {
      renderMathInElement(container, {
        throwOnError: false,
        strict: 'ignore',
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ]
      });
    } catch {
      // Ignore invalid partial formulas while streaming.
    }
  }

  function renderAssistantContent(container, rawText) {
    container.innerHTML = linkifyPaths(renderMarkdown(rawText));
    upgradeCodeLanguages(container);
    upgradeMermaidBlocks(container);
    addCopyButtons(container);
    highlightCodeBlocks(container);
    upgradeLinks(container);
    renderMermaid(container);
    renderMath(container);
  }

  function scrollToBottom() {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function addUserMessage(text) {
    if (welcomeEl) welcomeEl.style.display = 'none';
    const el = document.createElement('div');
    el.className = 'message user';
    el.textContent = text;
    messagesEl.appendChild(el);
    scrollToBottom();
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
    scrollToBottom();
  }

  // Throttled rendering: accumulate text, render at most once per animation frame
  let renderPending = false;

  function flushAssistantRender() {
    if (!currentAssistantContentEl) {
      return;
    }
    renderAssistantContent(currentAssistantContentEl, currentAssistantRaw);
    scrollToBottom();
  }

  function appendToAssistant(text) {
    if (!currentAssistantEl) startAssistantMessage();
    currentAssistantRaw += text;
    if (!renderPending) {
      renderPending = true;
      requestAnimationFrame(function() {
        renderPending = false;
        flushAssistantRender();
      });
    }
  }

  function appendAssistantFlag(className, text) {
    if (!currentAssistantEl) startAssistantMessage();
    const el = document.createElement('div');
    el.className = className;
    el.textContent = text;
    currentAssistantMetaEl.appendChild(el);
    scrollToBottom();
  }

  function escapeForRender(text) {
    // Only escape characters that aren't part of markdown syntax
    // We need a careful approach: escape HTML, then apply markdown
    return text;
  }

  function setStreaming(val) {
    isStreaming = val;
    inputEl.disabled = val;
    addFileBtn.disabled = val;
    if (val) {
      sendBtn.textContent = '■';
      sendBtn.title = 'Stop generating';
      sendBtn.classList.add('stop-mode');
    } else {
      sendBtn.textContent = '↑';
      sendBtn.title = 'Send (Enter)';
      sendBtn.classList.remove('stop-mode');
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
  }

  function sendMessage() {
    try {
      const text = inputEl.value.trim();
      if (!text || isStreaming) {
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
      vscode.postMessage({ type: 'sendMessage', text });
      inputEl.value = '';
      inputEl.style.height = 'auto';
      setStreaming(true);
    } catch (e) {
      vscode.postMessage({ type: 'errorMessage', text: 'sendMessage error: ' + e.message + '\\n' + e.stack });
      // Fallback: try to at least send the message if UI update fails
      try {
        vscode.postMessage({ type: 'sendMessage', text: inputEl.value.trim() });
      } catch (e2) {}
    }
  }

  // ── Event handlers ──
  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
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
    renderContextChips();
    setStreaming(false);
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

  sendBtn.addEventListener('click', () => {
    sendBtn.classList.remove('vibrate');
    void sendBtn.offsetWidth; // Trigger reflow to restart animation
    sendBtn.classList.add('vibrate');

    if (isStreaming) {
      vscode.postMessage({ type: 'stop' });
    } else {
      sendMessage();
    }
  });

  inputEl.addEventListener('keydown', (e) => {
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

  inputEl.addEventListener('focus', () => {
    vscode.postMessage({ type: 'inputFocus' });
  });
  inputEl.addEventListener('blur', () => {
    vscode.postMessage({ type: 'inputBlur' });
  });

  // Auto-resize textarea
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + 'px';
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
      chip.innerHTML = '<span class="chip-icon">📎</span>'
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
    const link = e.target.closest('.file-link');
    if (!link) return;
    e.preventDefault();
    const fp = link.dataset.path;
    const ln = link.dataset.line ? parseInt(link.dataset.line, 10) : undefined;
    vscode.postMessage({ type: 'openFile', filePath: fp, line: ln });
  });

  function renderLoadedSession(session) {
    messagesEl.innerHTML = '';
    if (sessionTitleEl) {
      sessionTitleEl.textContent = session?.title || 'New Chat';
    }
    currentAssistantEl = null;
    currentAssistantMetaEl = null;
    currentAssistantContentEl = null;
    currentAssistantRaw = '';

    const history = Array.isArray(session?.messages) ? session.messages : [];
    if (history.length === 0) {
      if (welcomeEl) {
        messagesEl.appendChild(welcomeEl);
        welcomeEl.style.display = '';
      }
      return;
    }

    for (const msg of history) {
      if (msg.role === 'user') {
        addUserMessage(msg.content);
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
    scrollToBottom();
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
        scrollToBottom();
        break;
      }
      case 'clearChat':
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
        renderContextChips();
        setStreaming(false);
        break;
      case 'selectionUpdate':
        currentSelection = data.selection;
        renderContextChips();
        break;
      case 'filesUpdate':
        attachedFiles = data.files || [];
        renderContextChips();
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
