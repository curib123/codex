import * as vscode from "vscode";
import { AUTO_MODEL_ID, MODELS } from "./models";

export function activate(context: vscode.ExtensionContext): void {
  const open = vscode.commands.registerCommand("vrompt.open", async () => {
    await vscode.window.showInformationMessage(
      "Vrompt — Coding Agent is initializing its Codex app-server integration.",
    );
  });

  const selectModel = vscode.commands.registerCommand(
    "vrompt.selectModel",
    async () => {
      const config = vscode.workspace.getConfiguration("vrompt");
      const current = config.get<string>("modelSelection", AUTO_MODEL_ID);
      const items: vscode.QuickPickItem[] = [
        {
          label: "$(sparkle) Auto — Recommended",
          description:
            current === AUTO_MODEL_ID ? "Current selection" : undefined,
        },
        ...MODELS.map((model) => ({
          label: model.displayName,
          description: current === model.id ? "Current selection" : model.provider,
          detail: `${model.taskClass} • tools: ${model.supportsTools ? "yes" : "no"} • vision: ${model.supportsVision ? "yes" : "no"}`,
        })),
      ];

      const picked = await vscode.window.showQuickPick(items, {
        title: "Vrompt — Select Model",
        placeHolder: "Choose Auto or a provider/model",
      });

      if (!picked) return;

      const selected = picked.label.includes("Auto — Recommended")
        ? AUTO_MODEL_ID
        : MODELS.find((model) => model.displayName === picked.label)?.id;

      if (!selected) return;

      await config.update(
        "modelSelection",
        selected,
        vscode.ConfigurationTarget.Global,
      );

      await vscode.window.showInformationMessage(
        selected === AUTO_MODEL_ID
          ? "Vrompt model selection set to Auto — Recommended."
          : `Vrompt model selection set to ${picked.label}.`,
      );
    },
  );

  context.subscriptions.push(open, selectModel);
}

export function deactivate(): void {}
