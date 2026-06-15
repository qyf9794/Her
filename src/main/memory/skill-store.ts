import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HerSkillDefinition, HerSkillParameter, HerSkillPreview, HerSkillSaveInput, HerSkillStep } from "../../shared/skills";
import { normalizeAliasPhrase } from "./alias-normalize";
import { AliasValidationError, assertNoSecretLikeArguments, validateAliasTarget } from "./alias-validation";
import { toolManifest, toolRequiresConfirmation } from "../tools/manifest";
import type { ToolName } from "../tools/metadata";

type SkillFile = {
  skills: HerSkillDefinition[];
};

export class SkillStore {
  private readonly filePath?: string;
  private skills = new Map<string, HerSkillDefinition>();

  constructor(userDataDir?: string) {
    this.filePath = userDataDir ? path.join(userDataDir, "skills.json") : undefined;
    this.load();
  }

  preview(input: HerSkillSaveInput): HerSkillPreview {
    const normalized = normalizeSkillInput(input);
    const steps = normalized.steps.map((step) => {
      const target = validateAliasTarget({ toolName: step.toolName, arguments: step.arguments });
      const entry = toolManifest[target.toolName as ToolName];
      return {
        ...step,
        toolName: target.toolName,
        arguments: target.arguments,
        summary: entry.summarize(target.arguments),
        risk: entry.risk,
        riskLabel: riskLabel(entry.risk),
        capability: entry.capability,
      };
    });
    return {
      name: normalized.name,
      trigger: normalized.trigger,
      description: normalized.description,
      parameters: normalized.parameters,
      steps,
      requiredCapabilities: unique(steps.map((step) => step.capability).filter(Boolean) as string[]),
      risks: unique(steps.map((step) => step.risk)),
      requiresConfirmation: steps.some((step) => toolRequiresConfirmation(step.toolName)),
    };
  }

  save(input: HerSkillSaveInput) {
    const preview = this.preview(input);
    const normalizedTrigger = normalizeAliasPhrase(preview.trigger);
    const existing = this.getByTrigger(preview.trigger);
    if (existing && input.overwrite !== true) {
      throw new SkillValidationError(`Skill already exists for trigger: ${preview.trigger}`, "skill_duplicate");
    }
    const now = new Date().toISOString();
    const skill: HerSkillDefinition = {
      id: existing?.id ?? crypto.randomUUID(),
      name: preview.name,
      trigger: preview.trigger,
      description: preview.description,
      parameters: preview.parameters,
      steps: preview.steps.map(({ toolName, arguments: args, title }) => ({ toolName, arguments: args, title })),
      requiredCapabilities: preview.requiredCapabilities,
      risks: preview.risks,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      runCount: existing?.runCount ?? 0,
      lastRunAt: existing?.lastRunAt,
    };
    this.skills.set(existing?.id ?? skill.id, skill);
    if (existing && normalizeAliasPhrase(existing.trigger) !== normalizedTrigger) this.skills.delete(existing.id);
    this.saveFile();
    return { skill, preview, saved: true };
  }

  list(query?: string) {
    const normalizedQuery = query ? normalizeAliasPhrase(query) : "";
    const skills = [...this.skills.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (!normalizedQuery) return skills;
    return skills.filter((skill) => normalizeAliasPhrase(`${skill.name} ${skill.trigger} ${skill.description ?? ""}`).includes(normalizedQuery));
  }

  get(id: string) {
    return this.skills.get(id) ?? null;
  }

  getByTrigger(trigger: string) {
    const normalized = normalizeAliasPhrase(trigger);
    return this.list().find((skill) => normalizeAliasPhrase(skill.trigger) === normalized) ?? null;
  }

  delete(input: { skillId?: string; trigger?: string }) {
    const skill = input.skillId ? this.get(input.skillId) : input.trigger ? this.getByTrigger(input.trigger) : null;
    if (!skill) throw new SkillValidationError("Skill not found.", "skill_not_found");
    this.skills.delete(skill.id);
    this.saveFile();
    return { skill, deleted: true };
  }

  markRun(skillId: string) {
    const skill = this.get(skillId);
    if (!skill) return;
    this.skills.set(skill.id, {
      ...skill,
      runCount: skill.runCount + 1,
      lastRunAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    this.saveFile();
  }

  count() {
    return this.skills.size;
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as SkillFile;
      for (const skill of parsed.skills ?? []) {
        if (!skill.id || !skill.name || !skill.trigger || !Array.isArray(skill.steps)) continue;
        this.skills.set(skill.id, normalizeStoredSkill(skill));
      }
    } catch {
      this.skills.clear();
    }
  }

  private saveFile() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, `${JSON.stringify({ skills: this.list() }, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}

export class SkillValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}

export const resolveSkillArguments = (step: HerSkillStep, parameters: Record<string, string> = {}) =>
  substituteParameters(step.arguments, parameters);

const normalizeSkillInput = (input: HerSkillSaveInput): HerSkillSaveInput & { parameters: HerSkillParameter[] } => {
  if (!input.name.trim()) throw new SkillValidationError("Skill name is required.", "skill_name_required");
  if (!input.trigger.trim()) throw new SkillValidationError("Skill trigger is required.", "skill_trigger_required");
  if (!input.steps.length) throw new SkillValidationError("At least one skill step is required.", "skill_steps_required");
  assertNoSecretLikeArguments(input);
  return {
    name: input.name.trim(),
    trigger: input.trigger.trim(),
    description: input.description?.trim(),
    parameters: normalizeParameters(input.parameters),
    steps: input.steps.map((step) => ({
      toolName: step.toolName,
      arguments: step.arguments,
      title: step.title?.trim(),
    })),
    overwrite: input.overwrite === true,
  };
};

const normalizeParameters = (parameters: HerSkillParameter[] | undefined) =>
  (parameters ?? []).map((parameter) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(parameter.name)) {
      throw new SkillValidationError(`Invalid skill parameter name: ${parameter.name}`, "skill_parameter_invalid");
    }
    assertNoSecretLikeArguments(parameter);
    assertNoSecretLikeArguments({ [parameter.name]: parameter.defaultValue ?? "" });
    return {
      name: parameter.name,
      description: parameter.description?.trim(),
      required: parameter.required === true,
      defaultValue: parameter.defaultValue,
    };
  });

const substituteParameters = (value: unknown, parameters: Record<string, string>): Record<string, unknown> => {
  const substituted = substituteValue(value, parameters);
  if (!substituted || typeof substituted !== "object" || Array.isArray(substituted)) return {};
  assertNoSecretLikeArguments(substituted);
  return substituted as Record<string, unknown>;
};

const substituteValue = (value: unknown, parameters: Record<string, string>): unknown => {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g, (_match, key: string) => parameters[key] ?? "");
  }
  if (Array.isArray(value)) return value.map((item) => substituteValue(item, parameters));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, substituteValue(nested, parameters)]));
  }
  return value;
};

const normalizeStoredSkill = (skill: HerSkillDefinition): HerSkillDefinition => ({
  ...skill,
  parameters: normalizeParameters(skill.parameters),
  requiredCapabilities: unique(skill.requiredCapabilities ?? []),
  risks: unique(skill.risks ?? []),
  runCount: Number(skill.runCount ?? 0),
  createdAt: skill.createdAt ?? new Date().toISOString(),
  updatedAt: skill.updatedAt ?? skill.createdAt ?? new Date().toISOString(),
});

const unique = <T>(values: T[]) => [...new Set(values)];

const riskLabel = (risk: string) =>
  risk
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");

export const toSkillValidationCode = (error: unknown) => {
  if (error instanceof SkillValidationError) return error.code;
  if (error instanceof AliasValidationError) return error.code;
  return "skill_invalid";
};
