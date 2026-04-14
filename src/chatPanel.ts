import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

/** Strip ANSI escape codes from a string */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, '');
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

  private view?: vscode.WebviewView;
  private sessionId: string;
  private currentProcess: cp.ChildProcess | null = null;
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

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'sendMessage':
          await this.handleUserMessage(data.text);
          break;
        case 'stop':
          this.stopCurrentProcess();
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
      }
    });
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

  private stopCurrentProcess(): void {
    if (this.currentProcess) {
      this.currentProcess.kill('SIGTERM');
      this.currentProcess = null;
    }
  }

  private async handleUserMessage(text: string): Promise<void> {
    if (!text.trim()) { return; }

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

    const args = ['--session', this.sessionId, '--short-output'];

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
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.currentProcess = child;

      // Write the user message to stdin and close it
      child.stdin?.write(prompt + '\n');
      child.stdin?.end();

      let fullOutput = '';
      let headerDone = false;

      const processChunk = (raw: string) => {
        const clean = stripAnsi(raw);
        const lines = clean.split('\n');

        for (const line of lines) {
          // Skip header lines (mcp info, model info, assistant info)
          if (!headerDone) {
            if (line.match(/^╭─\s*(mcp|assistant)/) || line.match(/^\[.*\(search:/) || line.trim() === '') {
              continue;
            }
            // Thinking markers
            if (line.match(/╭─\s*thinking/)) {
              this.view?.webview.postMessage({ type: 'thinkingStart' });
              continue;
            }
            if (line.match(/╰─\s*done thinking/)) {
              this.view?.webview.postMessage({ type: 'thinkingEnd' });
              headerDone = true;
              continue;
            }
          }

          // Tool call markers
          if (line.match(/^╭─\s*tool/)) {
            this.view?.webview.postMessage({ type: 'toolStart', name: line.replace(/^╭─\s*tool\s*·?\s*/, '').trim() });
            continue;
          }
          if (line.match(/^╰─\s*tool/)) {
            this.view?.webview.postMessage({ type: 'toolEnd' });
            continue;
          }
          // Skip more header/status lines after thinking
          if (line.match(/^╭─/) || line.match(/^╰─/)) {
            continue;
          }

          // Actual content
          fullOutput += line + '\n';
          this.view?.webview.postMessage({ type: 'streamChunk', text: line + '\n' });
        }
      };

      child.stdout?.on('data', (data: Buffer) => {
        processChunk(data.toString());
      });

      child.stderr?.on('data', (data: Buffer) => {
        // Some info goes to stderr; mostly ignore but log errors
        const text = data.toString();
        if (text.includes('Error') || text.includes('error')) {
          this.view?.webview.postMessage({ type: 'streamChunk', text: stripAnsi(text) });
        }
      });

      child.on('close', () => {
        this.currentProcess = null;
        const content = fullOutput.trim();
        if (content) {
          const current = this.getCurrentSession();
          current.messages.push({ role: 'assistant', content });
          current.updatedAt = Date.now();
          void this.saveSessions();
        }
        this.view?.webview.postMessage({ type: 'endResponse' });
      });

      child.on('error', (err) => {
        this.currentProcess = null;
        this.view?.webview.postMessage({
          type: 'errorMessage',
          text: `Failed to start agent: ${err.message}\nMake sure the binary path is correct in settings (jumpHistory.agentBinaryPath).`,
        });
        this.view?.webview.postMessage({ type: 'endResponse' });
      });
    } catch (err: any) {
      this.view?.webview.postMessage({
        type: 'errorMessage',
        text: `Error: ${err.message}`,
      });
      this.view?.webview.postMessage({ type: 'endResponse' });
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
    white-space: pre-wrap;
    word-break: break-word;
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

  /* Tool indicator */
  .tool-indicator {
    font-size: 11px;
    opacity: 0.6;
    padding: 3px 8px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 4px;
    display: inline-block;
    margin: 2px 0;
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

  .stop-btn {
    border: none;
    border-radius: 6px;
    padding: 8px 14px;
    cursor: pointer;
    font-size: 13px;
    flex-shrink: 0;
    height: 36px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    display: none;
  }
  .stop-btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

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
  .add-file-btn {
    position: absolute;
    right: 8px;
    bottom: 8px;
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
  .add-file-btn:hover { opacity: 1; border-color: var(--vscode-focusBorder); }
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
      <button class="add-file-btn" id="addFileBtn" title="Attach files (+)">+</button>
    </div>
    <button class="stop-btn" id="stopBtn">Stop</button>
  </div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const welcomeEl = document.getElementById('welcome');
  const inputEl = document.getElementById('input');
  const stopBtn = document.getElementById('stopBtn');
  const newChatBtn = document.getElementById('newChatBtn');
  const switchSessionBtn = document.getElementById('switchSessionBtn');
  const renameSessionBtn = document.getElementById('renameSessionBtn');
  const deleteSessionBtn = document.getElementById('deleteSessionBtn');
  const sessionTitleEl = document.getElementById('sessionTitle');
  const contextArea = document.getElementById('contextArea');
  const addFileBtn = document.getElementById('addFileBtn');

  let isStreaming = false;
  let currentAssistantEl = null;
  let currentAssistantRaw = '';
  let currentSelection = null;
  let attachedFiles = [];

  // ── Simple Markdown → HTML ──
  function renderMarkdown(text) {
    // Code blocks
    text = text.replace(/\`\`\`(\\w*)?\\n([\\s\\S]*?)\`\`\`/g, (_, lang, code) => {
      const escaped = escapeHtml(code.trimEnd());
      return '<pre><code class="lang-' + (lang || '') + '">' + escaped + '</code><button class="copy-btn" onclick="copyCode(this)">Copy</button></pre>';
    });
    // Inline code
    text = text.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
    // Bold
    text = text.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
    // Italic
    text = text.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
    // Headers
    text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    // Links
    text = text.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g, '<a href="$2" target="_blank">$1</a>');
    // Blockquotes
    text = text.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
    return text;
  }

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
    messagesEl.appendChild(el);
    currentAssistantEl = el;
    currentAssistantRaw = '';
    scrollToBottom();
  }

  function appendToAssistant(text) {
    if (!currentAssistantEl) startAssistantMessage();
    currentAssistantRaw += text;
    currentAssistantEl.innerHTML = renderMarkdown(escapeForRender(currentAssistantRaw));
    scrollToBottom();
  }

  function escapeForRender(text) {
    // Only escape characters that aren't part of markdown syntax
    // We need a careful approach: escape HTML, then apply markdown
    return text;
  }

  function setStreaming(val) {
    isStreaming = val;
    stopBtn.style.display = val ? '' : 'none';
    inputEl.disabled = val;
    addFileBtn.disabled = val;
    if (!val) inputEl.focus();
  }

  function sendMessage() {
    const text = inputEl.value.trim();
    if (!text || isStreaming) return;
    addUserMessage(text);
    vscode.postMessage({ type: 'sendMessage', text });
    inputEl.value = '';
    inputEl.style.height = 'auto';
    setStreaming(true);
  }

  // ── Event handlers ──
  stopBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'stop' });
  });
  newChatBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'newSession' });
    messagesEl.innerHTML = '';
    if (welcomeEl) {
      messagesEl.appendChild(welcomeEl);
      welcomeEl.style.display = '';
    }
    currentAssistantEl = null;
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

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
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

  function renderLoadedSession(session) {
    messagesEl.innerHTML = '';
    if (sessionTitleEl) {
      sessionTitleEl.textContent = session?.title || 'New Chat';
    }
    currentAssistantEl = null;
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
        el.innerHTML = renderMarkdown(escapeForRender(msg.content || ''));
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
        const el = document.createElement('div');
        el.className = 'thinking-indicator';
        el.id = 'thinking';
        el.textContent = 'Thinking';
        messagesEl.appendChild(el);
        scrollToBottom();
        break;
      }
      case 'thinkingEnd': {
        const el = document.getElementById('thinking');
        if (el) el.remove();
        break;
      }
      case 'toolStart': {
        const el = document.createElement('div');
        el.className = 'tool-indicator';
        el.textContent = '🔧 ' + (data.name || 'tool');
        messagesEl.appendChild(el);
        scrollToBottom();
        break;
      }
      case 'toolEnd':
        break;
      case 'streamChunk':
        appendToAssistant(data.text);
        break;
      case 'endResponse':
        currentAssistantEl = null;
        currentAssistantRaw = '';
        setStreaming(false);
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
