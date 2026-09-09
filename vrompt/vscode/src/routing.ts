import { AUTO_MODEL_ID, MODELS, type ModelDefinition, type TaskClass } from "./models";

export interface RoutingContext {
  prompt: string;
  selectedModelId: string;
  availableProviders: readonly string[];
}

export interface RoutingDecision {
  taskClass: TaskClass;
  model: ModelDefinition;
  reason: string;
}

export function classifyTask(prompt: string): TaskClass {
  const text = prompt.toLowerCase();
  const complexSignals = [
    "architecture",
    "security",
    "repository-wide",
    "large refactor",
    "race condition",
    "deadlock",
    "performance regression",
    "migration",
  ];
  if (complexSignals.some((signal) => text.includes(signal)) || prompt.length > 2500) {
    return "complex";
  }

  const lightSignals = ["rename", "format", "typo", "comment", "explain", "small edit"];
  if (lightSignals.some((signal) => text.includes(signal)) && prompt.length < 800) {
    return "light";
  }

  return "standard";
}

export function routeModel(context: RoutingContext): RoutingDecision {
  const taskClass = classifyTask(context.prompt);

  if (context.selectedModelId !== AUTO_MODEL_ID) {
    const model = MODELS.find((candidate) => candidate.id === context.selectedModelId);
    if (!model) throw new Error(`Unknown Vrompt model selection: ${context.selectedModelId}`);
    return { taskClass, model, reason: "Manual model selection" };
  }

  const available = MODELS.filter((model) => context.availableProviders.includes(model.provider));
  if (available.length === 0) {
    const openai = MODELS.find((model) => model.provider === "openai");
    if (!openai) throw new Error("Vrompt has no fallback model configured.");
    return { taskClass, model: openai, reason: "Fallback to Codex/OpenAI configuration" };
  }

  const exact = available.find((model) => model.taskClass === taskClass);
  if (exact) return { taskClass, model: exact, reason: `Auto matched ${taskClass} task` };

  const complex = available.find((model) => model.taskClass === "complex");
  if (complex) return { taskClass, model: complex, reason: "Auto escalated to available complex model" };

  return { taskClass, model: available[0], reason: "Auto selected first available provider" };
}
