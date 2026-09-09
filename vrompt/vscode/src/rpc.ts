import { ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
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
  argsPrefix?: string[];
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
    const child = spawn(resolved.command, [...(resolved.argsPrefix ?? []), ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
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
        this.closeWithError(new Error(codexNotFoundMessage(options.codexBinary)));
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
    return { command: trimmed };
  }

  if (looksLikePath(trimmed) && existsSync(trimmed)) {
    return resolveWindowsExecutable(trimmed);
  }

  if (trimmed.toLowerCase() !== "codex") {
    const discovered = firstExistingExecutable(whereWindowsExecutable(trimmed));
    return discovered ? resolveWindowsExecutable(discovered) : { command: trimmed };
  }

  // 1. Official standalone installer location.
  for (const candidate of officialWindowsCodexCandidates()) {
    if (existsSync(candidate)) return { command: candidate };
  }

  // 2. Ask Windows directly. This catches PATH locations VS Code can resolve even
  // when they differ from Vrompt's known install layouts.
  const whereCandidate = firstExistingExecutable(whereWindowsExecutable("codex"));
  if (whereCandidate) return resolveWindowsExecutable(whereCandidate);

  // 3. Ask npm for the active global prefix/root instead of assuming %APPDATA%\\npm.
  for (const candidate of npmDiscoveredCodexCandidates()) {
    if (existsSync(candidate)) return resolveWindowsExecutable(candidate);
  }

  // 4. Known npm/PATH layouts retained as a compatibility fallback.
  for (const candidate of windowsNativeCodexCandidates()) {
    if (existsSync(candidate)) return { command: candidate };
  }
  for (const candidate of windowsCodexShimCandidates()) {
    if (existsSync(candidate)) return resolveWindowsExecutable(candidate);
  }

  return { command: "codex" };
}

function resolveWindowsExecutable(candidate: string): ResolvedCodexCommand {
  if (/\.cmd$/i.test(candidate) || /\.bat$/i.test(candidate)) {
    const nodeEntrypoint = findNodeCodexEntrypoint(candidate);
    if (nodeEntrypoint) {
      return { command: process.execPath, argsPrefix: [nodeEntrypoint] };
    }

    // Do not use shell:true: config overrides are passed as arguments and should
    // never be interpreted as shell syntax. cmd.exe /c with the shim as the
    // command is only a last-resort launcher when the package entrypoint cannot
    // be located.
    const comspec = process.env.ComSpec || process.env.COMSPEC || "cmd.exe";
    return { command: comspec, argsPrefix: ["/d", "/s", "/c", candidate] };
  }
  return { command: candidate };
}

function officialWindowsCodexCandidates(): string[] {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA;
  const installDir = process.env.CODEX_INSTALL_DIR;

  if (installDir) {
    candidates.push(path.join(installDir, "codex.exe"));
    candidates.push(path.join(installDir, "bin", "codex.exe"));
  }
  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe"));
  }

  return unique(candidates);
}

function whereWindowsExecutable(name: string): string[] {
  try {
    const output = execFileSync("where.exe", [name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function npmDiscoveredCodexCandidates(): string[] {
  const candidates: string[] = [];
  const prefixes = npmCommandOutput(["prefix", "-g"]);
  const roots = npmCommandOutput(["root", "-g"]);

  for (const prefix of prefixes) {
    candidates.push(path.join(prefix, "codex.cmd"));
    candidates.push(path.join(prefix, "codex.exe"));
  }

  for (const nodeModules of roots) {
    candidates.push(...nativeCodexCandidatesFromNodeModules(nodeModules));
    candidates.push(path.join(nodeModules, "@openai", "codex", "bin", "codex.js"));
  }

  return unique(candidates);
}

function npmCommandOutput(args: string[]): string[] {
  for (const npm of npmExecutableCandidates()) {
    if (looksLikePath(npm) && !existsSync(npm)) continue;
    try {
      const command = /\.(cmd|bat)$/i.test(npm)
        ? process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
        : npm;
      const commandArgs = /\.(cmd|bat)$/i.test(npm) ? ["/d", "/s", "/c", npm, ...args] : args;
      const output = execFileSync(command, commandArgs, {
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const values = output
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      if (values.length) return values;
    } catch {
      // Try the next npm launcher.
    }
  }
  return [];
}

function npmExecutableCandidates(): string[] {
  const candidates = [...whereWindowsExecutable("npm.cmd"), ...whereWindowsExecutable("npm")];
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  if (programFiles) candidates.push(path.join(programFiles, "nodejs", "npm.cmd"));
  if (programFilesX86) candidates.push(path.join(programFilesX86, "nodejs", "npm.cmd"));
  return unique(candidates.length ? candidates : ["npm.cmd"]);
}

function firstExistingExecutable(candidates: string[]): string | undefined {
  return candidates.find((candidate) => existsSync(candidate));
}

function windowsCodexShimCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of windowsCodexRoots()) {
    candidates.push(path.join(root, "codex.cmd"));
    candidates.push(path.join(root, "codex.exe"));
  }
  return unique(candidates);
}

function windowsNativeCodexCandidates(): string[] {
  const candidates: string[] = [];
  for (const root of windowsCodexRoots()) {
    candidates.push(...nativeCodexCandidatesFromNodeModules(path.join(root, "node_modules")));
  }
  return unique(candidates);
}

function nativeCodexCandidatesFromNodeModules(nodeModules: string): string[] {
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  const packageName = process.arch === "arm64" ? "codex-win32-arm64" : "codex-win32-x64";
  const suffix = path.join("vendor", triple, "bin", "codex.exe");

  return [
    path.join(nodeModules, "@openai", "codex", "node_modules", "@openai", packageName, suffix),
    path.join(nodeModules, "@openai", packageName, suffix),
    path.join(nodeModules, "@openai", "codex", suffix),
  ];
}

function findNodeCodexEntrypoint(shimPath: string): string | undefined {
  const shimDir = path.dirname(shimPath);
  const candidates = [
    path.join(shimDir, "node_modules", "@openai", "codex", "bin", "codex.js"),
    ...npmCommandOutput(["root", "-g"]).map((root) =>
      path.join(root, "@openai", "codex", "bin", "codex.js"),
    ),
  ];
  return candidates.find((candidate) => existsSync(candidate));
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

function codexNotFoundMessage(requested: string): string {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "%LOCALAPPDATA%";
    const standalone = path.join(localAppData, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
    return [
      `Vrompt could not find the Codex runtime (${requested}).`,
      "Install Codex with the official Windows installer or: npm.cmd install -g @openai/codex",
      `Vrompt checked the official standalone path (${standalone}), Windows PATH, npm's global prefix/root, and known npm locations.`,
      "After installing, restart VS Code. You can also set Vrompt › Codex Binary to the exact codex.exe path.",
    ].join(" ");
  }
  return `Vrompt could not find the Codex runtime (${requested}). Install @openai/codex and make sure codex is on PATH.`;
}
