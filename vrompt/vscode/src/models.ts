export type ProviderId = "openai" | "anthropic" | "mistral" | "zai";

export type TaskClass = "light" | "standard" | "complex";
export type ProviderTransport = "responses" | "chat-compat" | "anthropic-messages";

export interface ModelDefinition {
  id: string;
  provider: ProviderId;
  displayName: string;
  taskClass: TaskClass;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  runtimeProvider?: string;
  runtimeModel?: string;
  transport: ProviderTransport;
}

export const MODELS: readonly ModelDefinition[] = [
  {
    id: "openai/default",
    provider: "openai",
    displayName: "OpenAI — Codex default",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    runtimeProvider: "openai",
    transport: "responses",
  },
  {
    id: "anthropic/default",
    provider: "anthropic",
    displayName: "Anthropic / Claude — Default",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    transport: "anthropic-messages",
  },
  {
    id: "mistral/default",
    provider: "mistral",
    displayName: "Mistral — Default",
    taskClass: "standard",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    transport: "chat-compat",
  },
  {
    id: "zai/default",
    provider: "zai",
    displayName: "Z.ai / GLM — Default",
    taskClass: "standard",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    transport: "chat-compat",
  },
] as const;

export const AUTO_MODEL_ID = "auto";

export function findModel(id: string): ModelDefinition | undefined {
  return MODELS.find((model) => model.id === id);
}
