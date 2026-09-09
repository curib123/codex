export type ProviderId =
  | "openai"
  | "anthropic"
  | "mistral"
  | "zai"
  | "google"
  | "groq";

export type TaskClass = "light" | "standard" | "complex";
export type ProviderTransport = "responses" | "chat-compat" | "anthropic-messages";
export type CostClass = "native" | "free-tier" | "paid";

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
  costClass: CostClass;
  autoEligible?: boolean;
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
    costClass: "native",
  },
  {
    id: "google/gemini-3.7-flash",
    provider: "google",
    displayName: "Gemini 3.7 Flash — Free tier",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    runtimeProvider: "vrompt-google",
    runtimeModel: "gemini-3.7-flash",
    transport: "chat-compat",
    costClass: "free-tier",
  },
  {
    id: "groq/gpt-oss-120b",
    provider: "groq",
    displayName: "Groq — GPT-OSS 120B — Free plan",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    runtimeProvider: "vrompt-groq",
    runtimeModel: "openai/gpt-oss-120b",
    transport: "chat-compat",
    costClass: "free-tier",
  },
  {
    id: "groq/gpt-oss-20b",
    provider: "groq",
    displayName: "Groq — GPT-OSS 20B — Free plan",
    taskClass: "standard",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    runtimeProvider: "vrompt-groq",
    runtimeModel: "openai/gpt-oss-20b",
    transport: "chat-compat",
    costClass: "free-tier",
  },
  {
    id: "mistral/mistral-small-4",
    provider: "mistral",
    displayName: "Mistral Small 4 — Free mode quota",
    taskClass: "standard",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    runtimeProvider: "vrompt-mistral",
    runtimeModel: "mistral-small-2603",
    transport: "chat-compat",
    costClass: "free-tier",
  },
  {
    id: "mistral/leanstral-1.5",
    provider: "mistral",
    displayName: "Leanstral 1.5 — Free • Lean 4",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: true,
    runtimeProvider: "vrompt-mistral",
    runtimeModel: "labs-leanstral-1-5",
    transport: "chat-compat",
    costClass: "free-tier",
    autoEligible: false,
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
    costClass: "paid",
  },
  {
    id: "mistral/mistral-medium-3-5",
    provider: "mistral",
    displayName: "Mistral Medium 3.5",
    taskClass: "complex",
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    runtimeProvider: "vrompt-mistral",
    runtimeModel: "mistral-medium-3-5",
    transport: "chat-compat",
    costClass: "paid",
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
    costClass: "paid",
  },
] as const;

export const AUTO_MODEL_ID = "auto";

export function findModel(id: string): ModelDefinition | undefined {
  return MODELS.find((model) => model.id === id);
}
