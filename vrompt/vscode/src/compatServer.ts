import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { ProviderId, ProviderTransport } from "./models";

interface ResponsesRequest {
  model: string;
  instructions?: string;
  input?: unknown[];
  tools?: unknown[];
  tool_choice?: string;
}

interface ProviderTarget {
  provider: ProviderId;
  transport: ProviderTransport;
  apiKey: string;
  baseUrl: string;
  model: string;
}

interface CompatResult {
  text?: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export class VromptCompatibilityServer {
  private server?: Server;
  private target?: ProviderTarget;

  async start(target: ProviderTarget): Promise<string> {
    this.target = target;
    if (!this.server) {
      this.server = createServer((request, response) => {
        void this.handle(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        this.server!.once("error", reject);
        this.server!.listen(0, "127.0.0.1", () => resolve());
      });
    }
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.target = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== "POST" || !request.url?.endsWith("/responses")) {
        writeJson(response, 404, { error: { message: "Vrompt compatibility endpoint not found." } });
        return;
      }
      if (!this.target) throw new Error("Vrompt provider target is not configured.");

      const body = (await readJson(request)) as ResponsesRequest;
      const result =
        this.target.transport === "anthropic-messages"
          ? await callAnthropic(this.target, body)
          : await callChatCompatible(this.target, body);
      writeResponsesSse(response, result);
    } catch (error) {
      writeJson(response, 500, {
        error: {
          message: error instanceof Error ? error.message : String(error),
          type: "vrompt_provider_error",
        },
      });
    }
  }
}

async function callChatCompatible(
  target: ProviderTarget,
  request: ResponsesRequest,
): Promise<CompatResult> {
  const messages = toChatMessages(request.instructions ?? "", request.input ?? []);
  const tools = toChatTools(request.tools ?? []);
  const payload: Record<string, unknown> = {
    model: target.model,
    messages,
    stream: false,
  };
  if (tools.length) {
    payload.tools = tools;
    payload.tool_choice = request.tool_choice === "none" ? "none" : "auto";
  }

  const upstream = await fetch(`${trimSlash(target.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${target.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = (await upstream.json()) as Record<string, any>;
  if (!upstream.ok) throw new Error(providerError(target.provider, upstream.status, json));

  const message = json.choices?.[0]?.message ?? {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((tool: any) => ({
        id: String(tool.id ?? randomUUID()),
        name: String(tool.function?.name ?? ""),
        arguments:
          typeof tool.function?.arguments === "string"
            ? tool.function.arguments
            : JSON.stringify(tool.function?.arguments ?? {}),
      }))
    : [];

  return {
    text: typeof message.content === "string" ? message.content : undefined,
    toolCalls: toolCalls.filter((call: { name: string }) => call.name.length > 0),
    usage: {
      inputTokens: numberOrUndefined(json.usage?.prompt_tokens),
      outputTokens: numberOrUndefined(json.usage?.completion_tokens),
      totalTokens: numberOrUndefined(json.usage?.total_tokens),
    },
  };
}

async function callAnthropic(
  target: ProviderTarget,
  request: ResponsesRequest,
): Promise<CompatResult> {
  const payload: Record<string, unknown> = {
    model: target.model,
    max_tokens: 16384,
    messages: toAnthropicMessages(request.input ?? []),
  };
  if (request.instructions?.trim()) payload.system = request.instructions;
  const tools = toAnthropicTools(request.tools ?? []);
  if (tools.length) payload.tools = tools;

  const upstream = await fetch(`${trimSlash(target.baseUrl)}/v1/messages`, {
    method: "POST",
    headers: {
      "x-api-key": target.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const json = (await upstream.json()) as Record<string, any>;
  if (!upstream.ok) throw new Error(providerError(target.provider, upstream.status, json));

  const content = Array.isArray(json.content) ? json.content : [];
  const text = content
    .filter((block: any) => block?.type === "text" && typeof block.text === "string")
    .map((block: any) => block.text)
    .join("");
  const toolCalls = content
    .filter((block: any) => block?.type === "tool_use")
    .map((block: any) => ({
      id: String(block.id ?? randomUUID()),
      name: String(block.name ?? ""),
      arguments: JSON.stringify(block.input ?? {}),
    }))
    .filter((call: { name: string }) => call.name.length > 0);

  const inputTokens = numberOrUndefined(json.usage?.input_tokens);
  const outputTokens = numberOrUndefined(json.usage?.output_tokens);
  return {
    text: text || undefined,
    toolCalls,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens
          : undefined,
    },
  };
}

function toChatMessages(instructions: string, items: unknown[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  if (instructions.trim()) messages.push({ role: "system", content: instructions });

  for (const raw of items) {
    if (!isRecord(raw)) continue;
    const type = raw.type;
    if (type === "message" && typeof raw.role === "string") {
      const content = responseContentToChat(raw.content);
      messages.push({ role: raw.role, content });
      continue;
    }
    if (type === "function_call") {
      pushChatToolCall(messages, {
        id: String(raw.call_id ?? raw.id ?? randomUUID()),
        type: "function",
        function: {
          name: String(raw.name ?? ""),
          arguments:
            typeof raw.arguments === "string" ? raw.arguments : JSON.stringify(raw.arguments ?? {}),
        },
      });
      continue;
    }
    if (type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: String(raw.call_id ?? ""),
        content: extractToolOutput(raw.output),
      });
    }
  }
  return messages;
}

function toAnthropicMessages(items: unknown[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const raw of items) {
    if (!isRecord(raw)) continue;
    if (raw.type === "message" && (raw.role === "user" || raw.role === "assistant")) {
      appendAnthropicContent(messages, raw.role, responseContentToAnthropic(raw.content));
      continue;
    }
    if (raw.type === "function_call") {
      let input: unknown = {};
      try {
        input = typeof raw.arguments === "string" ? JSON.parse(raw.arguments) : (raw.arguments ?? {});
      } catch {
        input = { raw: String(raw.arguments ?? "") };
      }
      appendAnthropicContent(messages, "assistant", [
        {
          type: "tool_use",
          id: String(raw.call_id ?? raw.id ?? randomUUID()),
          name: String(raw.name ?? ""),
          input,
        },
      ]);
      continue;
    }
    if (raw.type === "function_call_output") {
      appendAnthropicContent(messages, "user", [
        {
          type: "tool_result",
          tool_use_id: String(raw.call_id ?? ""),
          content: extractToolOutput(raw.output),
        },
      ]);
    }
  }
  return messages;
}

function responseContentToChat(content: unknown): unknown {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  const parts: Record<string, unknown>[] = [];
  let textOnly = "";
  let hasImage = false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      textOnly += part.text;
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string") {
      hasImage = true;
      parts.push({ type: "image_url", image_url: { url: part.image_url } });
    }
  }
  return hasImage ? parts : textOnly;
}

function responseContentToAnthropic(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? [{ type: "text", text: content }] : [];
  }
  const blocks: Record<string, unknown>[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if ((part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    }
  }
  return blocks;
}

function toChatTools(tools: unknown[]): Record<string, unknown>[] {
  return tools.flatMap((raw) => {
    if (!isRecord(raw) || raw.type !== "function" || typeof raw.name !== "string") return [];
    return [
      {
        type: "function",
        function: {
          name: raw.name,
          description: typeof raw.description === "string" ? raw.description : undefined,
          parameters: isRecord(raw.parameters) ? raw.parameters : { type: "object", properties: {} },
        },
      },
    ];
  });
}

function toAnthropicTools(tools: unknown[]): Record<string, unknown>[] {
  return tools.flatMap((raw) => {
    if (!isRecord(raw) || raw.type !== "function" || typeof raw.name !== "string") return [];
    return [
      {
        name: raw.name,
        description: typeof raw.description === "string" ? raw.description : undefined,
        input_schema: isRecord(raw.parameters) ? raw.parameters : { type: "object", properties: {} },
      },
    ];
  });
}

function pushChatToolCall(messages: Record<string, unknown>[], toolCall: Record<string, unknown>): void {
  const previous = messages.at(-1);
  if (previous?.role === "assistant" && previous.content === null && Array.isArray(previous.tool_calls)) {
    previous.tool_calls.push(toolCall);
    return;
  }
  messages.push({ role: "assistant", content: null, tool_calls: [toolCall] });
}

function appendAnthropicContent(
  messages: Record<string, unknown>[],
  role: "user" | "assistant",
  blocks: Record<string, unknown>[],
): void {
  if (!blocks.length) return;
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: blocks });
  }
}

function extractToolOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (isRecord(output)) {
    if (typeof output.content === "string") return output.content;
    if (Array.isArray(output.content_items)) return JSON.stringify(output.content_items);
  }
  return JSON.stringify(output ?? "");
}

function writeResponsesSse(response: ServerResponse, result: CompatResult): void {
  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");

  const responseId = `resp_vrompt_${randomUUID()}`;
  emitSse(response, { type: "response.created", response: { id: responseId } });

  if (result.text) {
    emitSse(response, {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id: `msg_${randomUUID()}`,
        content: [{ type: "output_text", text: result.text }],
      },
    });
  }

  for (const call of result.toolCalls) {
    emitSse(response, {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
      },
    });
  }

  emitSse(response, {
    type: "response.completed",
    response: {
      id: responseId,
      usage: {
        input_tokens: result.usage?.inputTokens ?? 0,
        input_tokens_details: null,
        output_tokens: result.usage?.outputTokens ?? 0,
        output_tokens_details: null,
        total_tokens: result.usage?.totalTokens ?? 0,
      },
    },
  });
  response.end();
}

function emitSse(response: ServerResponse, event: unknown): void {
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > 10 * 1024 * 1024) throw new Error("Vrompt provider request exceeds 10 MiB.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(body));
}

function providerError(provider: ProviderId, status: number, payload: Record<string, any>): string {
  const message = payload.error?.message ?? payload.message ?? JSON.stringify(payload);
  return `${provider} API returned HTTP ${status}: ${String(message)}`;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
