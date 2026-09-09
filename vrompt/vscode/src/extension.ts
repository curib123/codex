import * as vscode from "vscode";
import { VromptAgentSession } from "./appServer";
import { VromptCompatibilityServer } from "./compatServer";
import { AUTO_MODEL_ID, MODELS, type ModelDefinition, type ProviderId } from "./models";
import { buildProviderRuntimeConfig, compatibilityProviderOverride } from "./providers";
import { routeModel } from "./routing";
import { ProviderSecretStore } from "./secrets";
import { VromptSidebarProvider, type SidebarController } from "./sidebar";

let activeSession: VromptAgentSession | undefined;
let sessionEvents: vscode.Disposable | undefined;
let compatibilityServer: VromptCompatibilityServer | undefined;
let activeRuntimeKey: string | undefined;
let sidebar: VromptSidebarProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const secrets = new ProviderSecretStore(context.secrets);

  const configureProvider = async (provider?: ProviderId): Promise<void> => {
    const providers: ProviderId[] = [
      "openai",
      "anthropic",
      "mistral",
      "zai",
      "google",
      "groq",
    ];
    const picked =
      provider ??
      ((await vscode.window.showQuickPick(providers, {
        title: "Vrompt — Configure Provider",
        placeHolder: "Choose a provider",
      })) as ProviderId | undefined);
    if (!picked) return;

    const apiKey = await vscode.window.showInputBox({
      title: `Vrompt — ${picked} API key`,
      password: true,
      ignoreFocusOut: true,
      prompt: "Stored securely using VS Code SecretStorage. Leave blank to remove the saved key.",
    });
    if (apiKey === undefined) return;

    await secrets.set(picked, apiKey);
    await vscode.window.showInformationMessage(
      apiKey.trim() ? `${picked} credentials saved securely.` : `${picked} credentials removed.`,
    );
  };

  const controller: SidebarController = {
    async sendPrompt(prompt: string): Promise<void> {
      sidebar?.addUserMessage(prompt);
      sidebar?.setBusy(true);
      sidebar?.setStatus("Routing model…");

      try {
        const config = vscode.workspace.getConfiguration("vrompt");
        const selectedModelId = config.get<string>("modelSelection", AUTO_MODEL_ID);
        const availableProviders = await secrets.configuredProviders();
        if (!availableProviders.includes("openai")) availableProviders.push("openai");

        const decision = routeModel({ prompt, selectedModelId, availableProviders });
        const runtimeModel = decision.model;
        await ensureSession(context, secrets, runtimeModel);
        sidebar?.setStatus(`${runtimeModel.displayName} • ${decision.reason}`);
        await activeSession!.sendPrompt(prompt, runtimeModel);
      } catch (error) {
        sidebar?.setBusy(false);
        sidebar?.setStatus("Error");
        sidebar?.addError(error instanceof Error ? error.message : String(error));
      }
    },

    async stop(): Promise<void> {
      try {
        await activeSession?.interrupt();
      } catch (error) {
        sidebar?.addError(error instanceof Error ? error.message : String(error));
      }
    },

    async selectModel(modelId: string): Promise<void> {
      const valid = modelId === AUTO_MODEL_ID || MODELS.some((model) => model.id === modelId);
      if (!valid) return;
      await vscode.workspace
        .getConfiguration("vrompt")
        .update("modelSelection", modelId, vscode.ConfigurationTarget.Global);
    },

    async configureProvider(provider: ProviderId): Promise<void> {
      await configureProvider(provider);
    },

    getCurrentModelId(): string {
      return vscode.workspace
        .getConfiguration("vrompt")
        .get<string>("modelSelection", AUTO_MODEL_ID);
    },
  };

  sidebar = new VromptSidebarProvider(controller);
  context.subscriptions.push(
    sidebar,
    vscode.window.registerWebviewViewProvider(VromptSidebarProvider.viewType, sidebar, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const open = vscode.commands.registerCommand("vrompt.open", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.vrompt");
  });

  const selectModel = vscode.commands.registerCommand("vrompt.selectModel", async () => {
    const config = vscode.workspace.getConfiguration("vrompt");
    const current = config.get<string>("modelSelection", AUTO_MODEL_ID);
    const items: Array<vscode.QuickPickItem & { modelId: string }> = [
      {
        label: "Auto — Recommended",
        description: current === AUTO_MODEL_ID ? "Current selection" : undefined,
        modelId: AUTO_MODEL_ID,
      },
      ...MODELS.map((model) => ({
        label: model.displayName,
        description:
          current === model.id
            ? "Current selection"
            : `${model.provider} • ${model.costClass === "free-tier" ? "free tier" : model.costClass}`,
        detail: `${model.taskClass} • ${model.transport} • tools: ${model.supportsTools ? "yes" : "no"}`,
        modelId: model.id,
      })),
    ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Vrompt — Select Model",
      placeHolder: "Choose Auto or a provider/model",
    });
    if (!picked) return;

    await controller.selectModel(picked.modelId);
    await vscode.window.showInformationMessage(`Vrompt model selection set to ${picked.label}.`);
  });

  const configureProviderCommand = vscode.commands.registerCommand(
    "vrompt.configureProvider",
    () => configureProvider(),
  );

  context.subscriptions.push(open, selectModel, configureProviderCommand, {
    dispose: disposeRuntime,
  });
}

async function ensureSession(
  context: vscode.ExtensionContext,
  secrets: ProviderSecretStore,
  runtimeModel: ModelDefinition,
): Promise<void> {
  const runtimeKey = `${runtimeModel.provider}:${runtimeModel.runtimeProvider ?? ""}:${runtimeModel.runtimeModel ?? ""}`;
  if (activeSession && activeRuntimeKey === runtimeKey) return;

  disposeRuntime();

  const config = vscode.workspace.getConfiguration("vrompt");
  const providerConfig = await buildProviderRuntimeConfig(runtimeModel, secrets);
  if (providerConfig.target) {
    compatibilityServer = new VromptCompatibilityServer();
    const localBaseUrl = await compatibilityServer.start(providerConfig.target);
    providerConfig.configOverrides.push(
      compatibilityProviderOverride(runtimeModel.runtimeProvider!, localBaseUrl),
    );
  }

  const session = new VromptAgentSession();
  sessionEvents = sidebar?.bindSession(session);
  activeSession = session;
  activeRuntimeKey = runtimeKey;

  try {
    await session.start({
      codexBinary: config.get<string>("codexBinary", "codex"),
      workspacePath: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      clientVersion: String(context.extension.packageJSON.version ?? "0.0.0"),
      model: runtimeModel,
      providerEnv: providerConfig.env,
      configOverrides: providerConfig.configOverrides,
    });
  } catch (error) {
    disposeRuntime();
    throw error;
  }
}

function disposeRuntime(): void {
  sessionEvents?.dispose();
  sessionEvents = undefined;
  activeSession?.dispose();
  activeSession = undefined;
  compatibilityServer?.dispose();
  compatibilityServer = undefined;
  activeRuntimeKey = undefined;
}

export function deactivate(): void {
  disposeRuntime();
  sidebar = undefined;
}
