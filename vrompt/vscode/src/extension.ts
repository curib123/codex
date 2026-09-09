import * as vscode from "vscode";
import { VromptAgentSession } from "./appServer";
import { VromptCompatibilityServer } from "./compatServer";
import { AUTO_MODEL_ID, MODELS, type ProviderId } from "./models";
import { buildProviderRuntimeConfig, compatibilityProviderOverride } from "./providers";
import { routeModel } from "./routing";
import { ProviderSecretStore } from "./secrets";

let activeSession: VromptAgentSession | undefined;
let compatibilityServer: VromptCompatibilityServer | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new ProviderSecretStore(context.secrets);

  const open = vscode.commands.registerCommand("vrompt.open", async () => {
    const prompt = await vscode.window.showInputBox({
      title: "Vrompt — Coding Agent",
      prompt: "What should Vrompt do in this workspace?",
      placeHolder: "Fix the failing tests and explain the changes",
      ignoreFocusOut: true,
    });
    if (!prompt) return;

    const config = vscode.workspace.getConfiguration("vrompt");
    const selectedModelId = config.get<string>("modelSelection", AUTO_MODEL_ID);
    const availableProviders = await secrets.configuredProviders();
    // Native Codex authentication can be available even without a separately stored
    // OpenAI API key, so keep OpenAI eligible as the safe Auto fallback.
    if (!availableProviders.includes("openai")) availableProviders.push("openai");

    const decision = routeModel({ prompt, selectedModelId, availableProviders });
    const runtimeModel = decision.model;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const codexBinary = config.get<string>("codexBinary", "codex");

    activeSession?.dispose();
    activeSession = undefined;
    compatibilityServer?.dispose();
    compatibilityServer = undefined;

    try {
      const providerConfig = await buildProviderRuntimeConfig(runtimeModel, secrets);
      if (providerConfig.target) {
        compatibilityServer = new VromptCompatibilityServer();
        const localBaseUrl = await compatibilityServer.start(providerConfig.target);
        providerConfig.configOverrides.push(
          compatibilityProviderOverride(runtimeModel.runtimeProvider!, localBaseUrl),
        );
      }

      activeSession = new VromptAgentSession();
      await activeSession.start({
        codexBinary,
        workspacePath,
        clientVersion: String(context.extension.packageJSON.version ?? "0.0.0"),
        model: runtimeModel,
        providerEnv: providerConfig.env,
        configOverrides: providerConfig.configOverrides,
      });
      const turnId = await activeSession.sendPrompt(prompt, runtimeModel);
      await vscode.window.showInformationMessage(
        `Vrompt started turn ${turnId.slice(0, 8)} using ${runtimeModel.displayName} (${decision.reason}).`,
      );
    } catch (error) {
      activeSession?.dispose();
      activeSession = undefined;
      compatibilityServer?.dispose();
      compatibilityServer = undefined;
      await vscode.window.showErrorMessage(
        `Vrompt could not start: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const selectModel = vscode.commands.registerCommand("vrompt.selectModel", async () => {
    const config = vscode.workspace.getConfiguration("vrompt");
    const current = config.get<string>("modelSelection", AUTO_MODEL_ID);
    const items: Array<vscode.QuickPickItem & { modelId: string }> = [
      {
        label: "$(sparkle) Auto — Recommended",
        description: current === AUTO_MODEL_ID ? "Current selection" : undefined,
        modelId: AUTO_MODEL_ID,
      },
      ...MODELS.map((model) => ({
        label: model.displayName,
        description: current === model.id ? "Current selection" : model.provider,
        detail: `${model.taskClass} • ${model.transport} • tools: ${model.supportsTools ? "yes" : "no"}`,
        modelId: model.id,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Vrompt — Select Model",
      placeHolder: "Choose Auto or a provider/model",
    });
    if (!picked) return;

    await config.update("modelSelection", picked.modelId, vscode.ConfigurationTarget.Global);
    await vscode.window.showInformationMessage(`Vrompt model selection set to ${picked.label}.`);
  });

  const configureProvider = vscode.commands.registerCommand(
    "vrompt.configureProvider",
    async () => {
      const providers: ProviderId[] = ["openai", "anthropic", "mistral", "zai"];
      const picked = await vscode.window.showQuickPick(providers, {
        title: "Vrompt — Configure Provider",
        placeHolder: "Choose a provider",
      });
      if (!picked) return;
      const provider = picked as ProviderId;

      const apiKey = await vscode.window.showInputBox({
        title: `Vrompt — ${provider} API key`,
        password: true,
        ignoreFocusOut: true,
        prompt: "Stored securely using VS Code SecretStorage. Leave blank to remove the saved key.",
      });
      if (apiKey === undefined) return;

      await secrets.set(provider, apiKey);
      await vscode.window.showInformationMessage(
        apiKey.trim() ? `${provider} credentials saved securely.` : `${provider} credentials removed.`,
      );
    },
  );

  context.subscriptions.push(open, selectModel, configureProvider, {
    dispose: () => {
      activeSession?.dispose();
      compatibilityServer?.dispose();
    },
  });
}

export function deactivate(): void {
  activeSession?.dispose();
  activeSession = undefined;
  compatibilityServer?.dispose();
  compatibilityServer = undefined;
}
