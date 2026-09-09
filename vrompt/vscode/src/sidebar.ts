import * as vscode from "vscode";
import type { VromptAgentSession, AgentEvent } from "./appServer";
import { AUTO_MODEL_ID, MODELS, type ProviderId } from "./models";

export interface SidebarController {
  sendPrompt(prompt: string): Promise<void>;
  stop(): Promise<void>;
  selectModel(modelId: string): Promise<void>;
  configureProvider(provider: ProviderId): Promise<void>;
  getCurrentModelId(): string;
}

type WebviewMessage =
  | { type: "send"; prompt: string }
  | { type: "stop" }
  | { type: "selectModel"; modelId: string }
  | { type: "configureProvider"; provider: ProviderId };

export class VromptSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = "vrompt.agentView";

  private view?: vscode.WebviewView;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly controller: SidebarController) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.html(webviewView.webview);

    this.disposables.push(
      webviewView.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        switch (message.type) {
          case "send":
            await this.controller.sendPrompt(message.prompt);
            return;
          case "stop":
            await this.controller.stop();
            return;
          case "selectModel":
            await this.controller.selectModel(message.modelId);
            this.post({ type: "model", modelId: this.controller.getCurrentModelId() });
            return;
          case "configureProvider":
            await this.controller.configureProvider(message.provider);
            return;
        }
      }),
    );

    this.post({ type: "model", modelId: this.controller.getCurrentModelId() });
  }

  bindSession(session: VromptAgentSession): vscode.Disposable {
    return session.onDidEvent((event) => this.handleAgentEvent(event));
  }

  addUserMessage(text: string): void {
    this.post({ type: "user", text });
  }

  addError(message: string): void {
    this.post({ type: "error", message });
  }

  setBusy(busy: boolean): void {
    this.post({ type: "busy", busy });
  }

  setStatus(message: string): void {
    this.post({ type: "status", message });
  }

  dispose(): void {
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private handleAgentEvent(event: AgentEvent): void {
    if (event.type === "assistantDelta") {
      this.post({ type: "assistantDelta", turnId: event.turnId, delta: event.delta });
      return;
    }
    if (event.type === "turnStarted") {
      this.post({ type: "turnStarted", turnId: event.turnId });
      this.setBusy(true);
      return;
    }
    if (event.type === "turnCompleted") {
      this.post({ type: "turnCompleted", turnId: event.turnId });
      this.setBusy(false);
      return;
    }
    if (event.type === "status") this.setStatus(event.message);
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private html(webview: vscode.Webview): string {
    const nonce = String(Date.now());
    const modelOptions = [
      `<option value="${AUTO_MODEL_ID}">Auto — Recommended</option>`,
      ...MODELS.map(
        (model) =>
          `<option value="${escapeHtml(model.id)}">${escapeHtml(model.displayName)}</option>`,
      ),
    ].join("");

    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
  .root { display: flex; flex-direction: column; min-height: 100vh; }
  .toolbar { display: flex; gap: 8px; align-items: center; padding: 10px; border-bottom: 1px solid var(--vscode-panel-border); }
  .toolbar select { flex: 1; min-width: 0; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); padding: 6px; }
  .toolbar button, .composer button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-background); color: var(--vscode-button-foreground); padding: 6px 10px; cursor: pointer; }
  .toolbar button:hover, .composer button:hover { background: var(--vscode-button-hoverBackground); }
  .status { padding: 6px 10px; font-size: 12px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); }
  .messages { flex: 1; padding: 10px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
  .message { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .message.user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 8px; padding: 8px; }
  .message.assistant { padding: 4px 2px; }
  .message.error { color: var(--vscode-errorForeground); }
  .composer { padding: 10px; border-top: 1px solid var(--vscode-panel-border); display: grid; gap: 8px; }
  textarea { resize: vertical; min-height: 84px; max-height: 220px; width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 8px; font: inherit; }
  .actions { display: flex; gap: 8px; justify-content: flex-end; }
  .stop { background: var(--vscode-button-secondaryBackground) !important; color: var(--vscode-button-secondaryForeground) !important; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="root">
  <div class="toolbar">
    <select id="model" aria-label="Model">${modelOptions}</select>
    <button id="provider" type="button" title="Configure provider">API Key</button>
  </div>
  <div id="status" class="status">Ready</div>
  <div id="messages" class="messages" aria-live="polite"></div>
  <div class="composer">
    <textarea id="prompt" placeholder="Ask Vrompt to edit, test, explain, or inspect this workspace…"></textarea>
    <div class="actions">
      <button id="stop" type="button" class="stop hidden">Stop</button>
      <button id="send" type="button">Send</button>
    </div>
  </div>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById('messages');
  const prompt = document.getElementById('prompt');
  const send = document.getElementById('send');
  const stop = document.getElementById('stop');
  const status = document.getElementById('status');
  const model = document.getElementById('model');
  const provider = document.getElementById('provider');
  let activeAssistant = null;

  function append(role, text) {
    const el = document.createElement('div');
    el.className = 'message ' + role;
    el.textContent = text;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
    return el;
  }

  function setBusy(busy) {
    send.disabled = busy;
    model.disabled = busy;
    provider.disabled = busy;
    stop.classList.toggle('hidden', !busy);
  }

  send.addEventListener('click', () => {
    const text = prompt.value.trim();
    if (!text) return;
    vscode.postMessage({ type: 'send', prompt: text });
    prompt.value = '';
  });

  prompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send.click();
    }
  });

  stop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));
  model.addEventListener('change', () => vscode.postMessage({ type: 'selectModel', modelId: model.value }));
  provider.addEventListener('click', () => {
    const id = model.value;
    let providerId = 'openai';
    if (id.startsWith('anthropic/')) providerId = 'anthropic';
    else if (id.startsWith('mistral/')) providerId = 'mistral';
    else if (id.startsWith('zai/')) providerId = 'zai';
    else if (id.startsWith('google/')) providerId = 'google';
    else if (id.startsWith('groq/')) providerId = 'groq';
    vscode.postMessage({ type: 'configureProvider', provider: providerId });
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message.type === 'user') {
      append('user', message.text);
      activeAssistant = null;
    } else if (message.type === 'assistantDelta') {
      if (!activeAssistant) activeAssistant = append('assistant', '');
      activeAssistant.textContent += message.delta;
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === 'turnStarted') {
      activeAssistant = null;
      setBusy(true);
    } else if (message.type === 'turnCompleted') {
      setBusy(false);
      activeAssistant = null;
    } else if (message.type === 'status') {
      status.textContent = message.message;
    } else if (message.type === 'error') {
      append('error', message.message);
      setBusy(false);
    } else if (message.type === 'busy') {
      setBusy(Boolean(message.busy));
    } else if (message.type === 'model') {
      model.value = message.modelId;
    }
  });
</script>
</body>
</html>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const map: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return map[char] ?? char;
  });
}
