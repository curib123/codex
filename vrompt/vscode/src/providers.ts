import * as vscode from "vscode";
import type { ModelDefinition, ProviderId } from "./models";
import { ProviderSecretStore } from "./secrets";

export interface ProviderRuntimeConfig {
  env: NodeJS.ProcessEnv;
  configOverrides: string[];
  target?: {
    provider: ProviderId;
    transport: ModelDefinition["transport"];
    apiKey: string;
    baseUrl: string;
    model: string;
  };
}

const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  zai: "ZAI_API_KEY",
  google: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
};

const DEFAULT_BASE_URLS: Record<Exclude<ProviderId, "openai">, string> = {
  anthropic: "https://api.anthropic.com",
  mistral: "https://api.mistral.ai/v1",
  zai: "https://api.z.ai/api/paas/v4",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
};

export async function buildProviderRuntimeConfig(
  model: ModelDefinition,
  secrets: ProviderSecretStore,
): Promise<ProviderRuntimeConfig> {
  const apiKey = await secrets.get(model.provider);
  const env: NodeJS.ProcessEnv = {};

  if (model.provider === "openai") {
    if (apiKey) env[PROVIDER_ENV_KEYS.openai] = apiKey;
    return { env, configOverrides: [] };
  }

  if (!apiKey) {
    throw new Error(`${model.displayName} requires an API key. Run “Vrompt: Configure AI Provider”.`);
  }
  if (!model.runtimeProvider || !model.runtimeModel) {
    throw new Error(`${model.displayName} is missing Vrompt runtime metadata.`);
  }

  const config = vscode.workspace.getConfiguration("vrompt");
  const baseUrl = config.get<string>(
    `providers.${model.provider}.baseUrl`,
    DEFAULT_BASE_URLS[model.provider],
  );
  const configuredModel = config.get<string>(`providers.${model.provider}.model`, "").trim();
  const providerModel = configuredModel || model.runtimeModel;

  return {
    env,
    configOverrides: [],
    target: {
      provider: model.provider,
      transport: model.transport,
      apiKey,
      baseUrl,
      model: providerModel,
    },
  };
}

export function compatibilityProviderOverride(providerId: string, localBaseUrl: string): string {
  const escapedName = providerId.replace(/[^a-zA-Z0-9_-]/g, "-");
  return `model_providers.${escapedName}={ name = "Vrompt ${escapedName}", base_url = "${localBaseUrl}", wire_api = "responses" }`;
}

export function providerEnvKey(provider: ProviderId): string {
  return PROVIDER_ENV_KEYS[provider];
}
