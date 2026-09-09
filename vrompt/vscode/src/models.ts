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
    id: "anthropic/claude-sonnet-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 5",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    runtimeProvider: "vrompt-anthropic",
    runtimeModel: "claude-sonnet-5",
    transport: "anthropic-messages",
  },
  {
    id: "mistral/mistral-medium-3-5",
    provider: "mistral",
    displayName: "Mistral Medium 3.5",
    taskClass: "standard",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    runtimeProvider: "vrompt-mistral",
    runtimeModel: "mistral-medium-3-5",
    transport: "chat-compat",
  },
  {
    id: "zai/glm-5.3",
    provider: "zai",
    displayName: "Z.ai — GLM-5.3",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    runtimeProvider: "vrompt-zai",
    runtimeModel: "glm-5.3",
    transport: "chat-compat",
  },
] as const;

export const AUTO_MODEL_ID = "auto";

export function findModel(id: string): ModelDefinition | undefined {
  return MODELS.find((model) => model.id === id);
}
