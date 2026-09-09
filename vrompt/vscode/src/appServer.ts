import * as vscode from "vscode";
import {
  CodexAppServerRpc,
  type JsonObject,
  type ServerNotification,
  type ServerRequest,
} from "./rpc";
import type { ModelDefinition } from "./models";

interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  modelProvider: string;
}

interface TurnStartResponse {
  turn: { id: string };
}

export type AgentEvent =
  | { type: "assistantDelta"; turnId: string; delta: string }
  | { type: "turnStarted"; turnId: string }
  | { type: "turnCompleted"; turnId?: string }
  | { type: "status"; message: string };

export interface AgentStartOptions {
  codexBinary: string;
  workspacePath?: string;
  clientVersion: string;
  model?: ModelDefinition;
  providerEnv?: NodeJS.ProcessEnv;
  configOverrides?: readonly string[];
}

export class VromptAgentSession implements vscode.Disposable {
  private readonly rpc = new CodexAppServerRpc();
  private readonly eventEmitter = new vscode.EventEmitter<AgentEvent>();
  readonly onDidEvent = this.eventEmitter.event;

  private threadId?: string;
  private currentTurnId?: string;

  constructor() {
    this.rpc.on("request", (request: ServerRequest) => {
      void this.handleServerRequest(request);
    });
    this.rpc.on("notification", (notification: ServerNotification) => {
      this.handleNotification(notification);
    });
  }

  async start(options: AgentStartOptions): Promise<void> {
    this.eventEmitter.fire({ type: "status", message: "Starting Codex app-server…" });
    await this.rpc.start({
      codexBinary: options.codexBinary,
      cwd: options.workspacePath,
      env: options.providerEnv,
      configOverrides: options.configOverrides,
      clientVersion: options.clientVersion,
    });

    const startParams: JsonObject = {
      cwd: options.workspacePath,
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      ephemeral: false,
    };

    if (options.model?.runtimeModel) startParams.model = options.model.runtimeModel;
    if (options.model?.runtimeProvider) startParams.modelProvider = options.model.runtimeProvider;

    const started = await this.rpc.request<ThreadStartResponse>("thread/start", startParams);
    this.threadId = started.thread.id;
    this.eventEmitter.fire({ type: "status", message: "Ready" });
  }

  async sendPrompt(prompt: string, model?: ModelDefinition): Promise<string> {
    if (!this.threadId) throw new Error("Vrompt agent session has not been started.");
    if (this.currentTurnId) throw new Error("A Vrompt turn is already running.");

    const params: JsonObject = {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    };
    if (model?.runtimeModel) params.model = model.runtimeModel;

    const started = await this.rpc.request<TurnStartResponse>("turn/start", params);
    this.currentTurnId = started.turn.id;
    this.eventEmitter.fire({ type: "turnStarted", turnId: started.turn.id });
    return started.turn.id;
  }

  async interrupt(): Promise<void> {
    if (!this.threadId || !this.currentTurnId) return;
    const turnId = this.currentTurnId;
    await this.rpc.request("turn/interrupt", {
      threadId: this.threadId,
      turnId,
    });
    this.eventEmitter.fire({ type: "status", message: "Stopping…" });
  }

  dispose(): void {
    this.currentTurnId = undefined;
    this.threadId = undefined;
    this.rpc.dispose();
    this.eventEmitter.dispose();
  }

  private handleNotification(notification: ServerNotification): void {
    const params = notification.params;

    if (notification.method === "item/agentMessage/delta") {
      const delta = params?.delta;
      const turnId = params?.turnId;
      if (typeof delta === "string" && typeof turnId === "string") {
        this.eventEmitter.fire({ type: "assistantDelta", turnId, delta });
      }
      return;
    }

    if (notification.method === "turn/completed") {
      const turn = params?.turn;
      const turnId =
        turn && typeof turn === "object" && "id" in turn && typeof turn.id === "string"
          ? turn.id
          : this.currentTurnId;
      this.currentTurnId = undefined;
      this.eventEmitter.fire({ type: "turnCompleted", turnId });
      this.eventEmitter.fire({ type: "status", message: "Ready" });
    }
  }

  private async handleServerRequest(request: ServerRequest): Promise<void> {
    if (
      request.method === "item/commandExecution/requestApproval" ||
      request.method === "item/fileChange/requestApproval"
    ) {
      const kind = request.method.includes("commandExecution") ? "command" : "file change";
      const action = await vscode.window.showWarningMessage(
        `Vrompt requests approval for a ${kind}.`,
        { modal: true, detail: formatApprovalDetail(request.params) },
        "Approve",
        "Reject",
      );
      this.rpc.respond(request.id, { decision: action === "Approve" ? "accept" : "decline" });
      return;
    }

    // Never silently approve or fabricate responses for new app-server request types.
    this.rpc.respondError(request.id, -32601, `Vrompt does not handle ${request.method} yet.`);
  }
}

function formatApprovalDetail(params?: JsonObject): string | undefined {
  if (!params) return undefined;
  const candidate = params.command ?? params.reason ?? params.path ?? params.cwd;
  if (candidate === undefined) return undefined;
  return typeof candidate === "string" ? candidate : JSON.stringify(candidate, null, 2);
}
