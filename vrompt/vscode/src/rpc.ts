import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import * as path from "node:path";
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

interface ResolvedCodexCommand {
  command: string;
  shell: boolean;
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

    const resolved = resolveCodexCommand(options.codexBinary);
    const child = spawn(resolved.command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: resolved.shell,
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

    child.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        this.closeWithError(
          new Error(
            codexNotFoundMessage(options.codexBinary),
          ),
        );
        return;
      }
      this.closeWithError(error);
    });
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

function resolveCodexCommand(requested: string): ResolvedCodexCommand {
  const trimmed = requested.trim() || "codex";

  if (process.platform !== "win32") {
    return { command: trimmed, shell: false };
  }

  // Respect an explicit path first. .cmd/.bat launchers need cmd.exe on Windows.
  if (looksLikePath(trimmed) && existsSync(trimmed)) {
    return { command: trimmed, shell: isWindowsScript(trimmed) };
  }

  if (trimmed.toLowerCase() !== "codex") {
    return { command: trimmed, shell: isWindowsScript(trimmed) };
  }

  // Prefer the native executable from the globally installed @openai/codex package.
  // This avoids depending on whether VS Code inherited npm's global bin directory.
  for (const candidate of windowsNativeCodexCandidates()) {
    if (existsSync(candidate)) return { command: candidate, shell: false };
  }

  // Fall back to npm's codex.cmd shim. Node must invoke it through cmd.exe.
  for (const candidate of windowsCodexShimCandidates()) {
    if (existsSync(candidate)) return { command: candidate, shell: true };
  }

  // Final fallback preserves PATH-based installs such as standalone codex.exe.
  return { command: "codex", shell: false };
}

function windowsCodexShimCandidates(): string[] {
  const roots = windowsCodexRoots();
  const candidates: string[] = [];
  for (const root of roots) {
    candidates.push(path.join(root, "codex.cmd"));
    candidates.push(path.join(root, "codex.exe"));
  }
  return unique(candidates);
}

function windowsNativeCodexCandidates(): string[] {
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const candidates: string[] = [];

  for (const root of windowsCodexRoots()) {
    const nodeModules = path.join(root, "node_modules");
    const suffix = path.join("vendor", triple, "bin", "codex.exe");

    candidates.push(
      path.join(nodeModules, "@openai", "codex", "node_modules", "@openai", packageName, suffix),
    );
    candidates.push(path.join(nodeModules, "@openai", packageName, suffix));
    candidates.push(path.join(nodeModules, "@openai", "codex", suffix));
  }

  return unique(candidates);
}

function windowsCodexRoots(): string[] {
  const roots: string[] = [];
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const prefix = process.env.npm_config_prefix;

  if (appData) roots.push(path.join(appData, "npm"));
  if (localAppData) roots.push(path.join(localAppData, "npm"));
  if (prefix) roots.push(prefix);

  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    const cleaned = entry.replace(/^"|"$/g, "").trim();
    if (cleaned) roots.push(cleaned);
  }

  return unique(roots);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => path.normalize(value)))];
}

function looksLikePath(value: string): boolean {
  return path.isAbsolute(value) || value.includes("\\") || value.includes("/");
}

function isWindowsScript(value: string): boolean {
  return /\.(cmd|bat)$/i.test(value);
}

function codexNotFoundMessage(requested: string): string {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    const expected = appData ? path.join(appData, "npm", "codex.cmd") : "%APPDATA%\\npm\\codex.cmd";
    return [
      `Vrompt could not find the Codex runtime (${requested}).`,
      "Install it with: npm.cmd install -g @openai/codex",
      `Expected Windows launcher: ${expected}`,
      "Then restart VS Code. You can also set Vrompt › Codex Binary to the full codex.exe or codex.cmd path.",
    ].join(" ");
  }
  return `Vrompt could not find the Codex runtime (${requested}). Install @openai/codex and make sure codex is on PATH.`;
}
