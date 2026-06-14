import { toolManifest } from "../tools/manifest";
import type { ToolName } from "../tools/metadata";
import type { AliasTarget } from "../../shared/aliases";

const secretLikeKeyPattern = /(token|secret|password|cookie|apikey|api[_-]?key|\bkey\b|authorization|bearer|credential)/i;

export const validateAliasTarget = (target: AliasTarget) => {
  if (!Object.prototype.hasOwnProperty.call(toolManifest, target.toolName)) {
    throw new AliasValidationError(`Unknown alias target tool: ${target.toolName}`, "alias_target_unknown_tool");
  }
  assertNoSecretLikeKeys(target.arguments);
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

export const assertNoSecretLikeKeys = (value: unknown, path: string[] = []) => {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretLikeKeys(item, [...path, String(index)]));
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (secretLikeKeyPattern.test(key)) {
      throw new AliasValidationError(`Secret-like alias argument key is not allowed: ${[...path, key].join(".")}`, "secret_like_key_rejected");
    }
    assertNoSecretLikeKeys(nested, [...path, key]);
  }
};

export class AliasValidationError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
  }
}
