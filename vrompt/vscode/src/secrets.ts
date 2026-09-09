import * as vscode from "vscode";
import type { ProviderId } from "./models";

const SECRET_KEYS: Record<ProviderId, string> = {
  openai: "vrompt.provider.openai.apiKey",
  anthropic: "vrompt.provider.anthropic.apiKey",
  mistral: "vrompt.provider.mistral.apiKey",
  zai: "vrompt.provider.zai.apiKey",
};

export class ProviderSecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(provider: ProviderId): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEYS[provider]);
  }

  async set(provider: ProviderId, value: string): Promise<void> {
    const trimmed = value.trim();
    if (!trimmed) {
      await this.secrets.delete(SECRET_KEYS[provider]);
      return;
    }
    await this.secrets.store(SECRET_KEYS[provider], trimmed);
  }

  delete(provider: ProviderId): Thenable<void> {
    return this.secrets.delete(SECRET_KEYS[provider]);
  }

  async configuredProviders(): Promise<ProviderId[]> {
    const providers = Object.keys(SECRET_KEYS) as ProviderId[];
    const results = await Promise.all(
      providers.map(async (provider) => [provider, Boolean(await this.get(provider))] as const),
    );
    return results.filter(([, configured]) => configured).map(([provider]) => provider);
  }
}
