import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as readline from "node:readline";

export type JsonObject = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface AppServerLaunchOptions {
  codexBinary: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  configOverrides?: readonly string[];
  clientVersion: string;
}

export interface ServerRequest {
  id: string | number;
  method: string;
  params?: JsonObject;
}

export interface ServerNotification {
  method: string;
  params?: JsonObject;
}

export class CodexAppServerRpc extends EventEmitter {
  private process?: ChildProcessWithoutNullStreams;
  private nextRequestId = 1;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly stderrTail: string[] = [];

  async start(options: AppServerLaunchOptions): Promise<void> {
    if (this.process) return;

    const args: string[] = [];
    for (const override of options.configOverrides ?? []) {
      args.push("--config", override);
    }
    args.push("app-server", "--listen", "stdio://");

    const child = spawn(options.codexBinary, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    const stdout = readline.createInterface({ input: child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = readline.createInterface({ input: child.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 100) this.stderrTail.shift();
      this.emit("stderr", line);
    });

    child.once("error", (error) => this.closeWithError(error));
    child.once("exit", (code, signal) => {
      const suffix = this.stderrTail.length
        ? `\n${this.stderrTail.slice(-10).join("\n")}`
        : "";
      this.closeWithError(
        new Error(
          `Codex app-server exited (code=${String(code)}, signal=${String(signal)}).${suffix}`,
        ),
      );
    });

    await this.request("initialize", {
      clientInfo: {
        name: "vrompt_vscode",
        title: "Vrompt — Coding Agent",
        version: options.clientVersion,
      },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
  }

  async request<T = unknown>(method: string, params?: JsonObject): Promise<T> {
    const child = this.process;
    if (!child) throw new Error("Codex app-server is not running.");

    const id = String(this.nextRequestId++);
    const payload: JsonObject = { id, method };
    if (params !== undefined) payload.params = params;

    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    this.write(payload);
    return (await result) as T;
  }

  notify(method: string, params?: JsonObject): void {
    const payload: JsonObject = { method };
    if (params !== undefined) payload.params = params;
    this.write(payload);
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  dispose(): void {
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.closeWithError(new Error("Codex app-server connection closed."));
  }

  private write(payload: JsonObject): void {
    const child = this.process;
    if (!child?.stdin.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private handleLine(line: string): void {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.emit("protocolError", new Error(`Invalid app-server JSON: ${line}`));
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const id = String(message.id);
      const waiter = this.pending.get(id);
      if (!waiter) return;
      this.pending.delete(id);

      if (message.error && typeof message.error === "object") {
        const error = message.error as { message?: unknown };
        waiter.reject(new Error(String(error.message ?? "App-server request failed.")));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        this.emit("request", {
          id: message.id as string | number,
          method: message.method,
          params: message.params as JsonObject | undefined,
        } satisfies ServerRequest);
      } else {
        this.emit("notification", {
          method: message.method,
          params: message.params as JsonObject | undefined,
        } satisfies ServerNotification);
      }
    }
  }

  private closeWithError(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
    this.emit("closed", error);
  }
}
