import type { ProviderId } from "./models";
import { ProviderSecretStore } from "./secrets";

export interface ProviderRuntimeConfig {
  env: NodeJS.ProcessEnv;
  configOverrides: string[];
}

const PROVIDER_ENV_KEYS: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  mistral: "MISTRAL_API_KEY",
  zai: "ZAI_API_KEY",
};

export async function buildProviderRuntimeConfig(
  provider: ProviderId,
  secrets: ProviderSecretStore,
): Promise<ProviderRuntimeConfig> {
  const apiKey = await secrets.get(provider);
  const env: NodeJS.ProcessEnv = {};
  if (apiKey) env[PROVIDER_ENV_KEYS[provider]] = apiKey;

  // OpenAI is already native in Codex. Third-party provider overrides are added
  // only once their transport adapters are active; keeping them out here avoids
  // accidentally routing a chat/messages provider into the Responses endpoint.
  return { env, configOverrides: [] };
}

export function providerEnvKey(provider: ProviderId): string {
  return PROVIDER_ENV_KEYS[provider];
}
