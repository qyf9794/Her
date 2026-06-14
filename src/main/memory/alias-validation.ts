import { toolManifest } from "../tools/manifest";
import type { ToolName } from "../tools/metadata";
import type { AliasTarget } from "../../shared/aliases";

const secretLikeKeyPattern = /(token|secret|password|cookie|apikey|api[_-]?key|\bkey\b|authorization|bearer|credential)/i;
const secretLikeValuePattern = /\b(sk-[a-z0-9_-]{3,}|bearer\s+[a-z0-9._-]{8,})\b/i;

export const validateAliasTarget = (target: AliasTarget) => {
  if (!Object.prototype.hasOwnProperty.call(toolManifest, target.toolName)) {
    throw new AliasValidationError(`Unknown alias target tool: ${target.toolName}`, "alias_target_unknown_tool");
  }
  assertNoSecretLikeArguments(target.arguments);
  const toolName = target.toolName as ToolName;
  const parsed = toolManifest[toolName].schema.safeParse(target.arguments);
  if (!parsed.success) {
    throw new AliasValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      "alias_target_invalid_arguments",
    );
  }
  return { toolName, arguments: parsed.data as Record<string, unknown> };
};

export const assertNoSecretLikeArguments = (value: unknown, path: string[] = []) => {
  if (typeof value === "string") {
    if (secretLikeValuePattern.test(value)) {
      throw new AliasValidationError(`Secret-like alias argument value is not allowed: ${path.join(".") || "<root>"}`, "secret_like_value_rejected");
    }
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeArguments(item, [...path, String(index)]));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (secretLikeKeyPattern.test(key)) {
      throw new AliasValidationError(`Secret-like alias argument key is not allowed: ${[...path, key].join(".")}`, "secret_like_key_rejected");
    }
    assertNoSecretLikeArguments(nested, [...path, key]);
  }
};

export const assertNoSecretLikeKeys = assertNoSecretLikeArguments;

export class AliasValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
