import * as vscode from "vscode";
import { CodexAppServerRpc, type JsonObject, type ServerRequest } from "./rpc";
import type { ModelDefinition } from "./models";

interface ThreadStartResponse {
  thread: { id: string };
  model: string;
  modelProvider: string;
}

interface TurnStartResponse {
  turn: { id: string };
}

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
  private threadId?: string;

  constructor() {
    this.rpc.on("request", (request: ServerRequest) => {
      void this.handleServerRequest(request);
    });
  }

  async start(options: AgentStartOptions): Promise<void> {
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
      sessionStartSource: "vscode",
    };

    if (options.model?.runtimeModel) startParams.model = options.model.runtimeModel;
    if (options.model?.runtimeProvider) startParams.modelProvider = options.model.runtimeProvider;

    const started = await this.rpc.request<ThreadStartResponse>("thread/start", startParams);
    this.threadId = started.thread.id;
  }

  async sendPrompt(prompt: string, model?: ModelDefinition): Promise<string> {
    if (!this.threadId) throw new Error("Vrompt agent session has not been started.");

    const params: JsonObject = {
      threadId: this.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    };
    if (model?.runtimeModel) params.model = model.runtimeModel;

    const started = await this.rpc.request<TurnStartResponse>("turn/start", params);
    return started.turn.id;
  }

  dispose(): void {
    this.rpc.dispose();
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

    // Unknown requests must never be auto-approved. Returning an empty object is
    // intentionally conservative until Vrompt has a dedicated handler for them.
    this.rpc.respond(request.id, {});
  }
}

function formatApprovalDetail(params?: JsonObject): string | undefined {
  if (!params) return undefined;
  const candidate = params.command ?? params.reason ?? params.path ?? params.cwd;
  if (candidate === undefined) return undefined;
  return typeof candidate === "string" ? candidate : JSON.stringify(candidate, null, 2);
}
