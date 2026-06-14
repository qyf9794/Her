import type { AliasResolution } from "../../shared/aliases";
import { AliasStore } from "./alias-store";
import { normalizeAliasPhrase } from "./alias-normalize";

export class AliasResolver {
  constructor(private store: AliasStore) {}

  resolve(phrase: string): AliasResolution {
    const normalizedPhrase = normalizeAliasPhrase(phrase);
    if (!normalizedPhrase) {
      return { matched: false, confidence: 0, reason: "empty phrase" };
    }
    const alias = this.store.getByPhrase(phrase);
    if (!alias || !alias.enabled) {
      return { matched: false, confidence: 0, reason: "no exact alias match" };
    }
    return {
      matched: true,
      alias,
      confidence: 1,
      reason: "exact normalized phrase match",
    };
  }
}
