import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AliasCreateInput, AliasDefinition, AliasUpdateInput } from "../../shared/aliases";
import { normalizeAliasPhrase } from "./alias-normalize";

type AliasFile = {
  aliases: AliasDefinition[];
};

export class AliasStore {
  private readonly filePath?: string;
  private aliases = new Map<string, AliasDefinition>();

  constructor(userDataDir?: string) {
    this.filePath = userDataDir ? path.join(userDataDir, "aliases.json") : undefined;
    this.load();
  }

  list(query?: string) {
    const normalizedQuery = query ? normalizeAliasPhrase(query) : "";
    const aliases = [...this.aliases.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (!normalizedQuery) return aliases;
    return aliases.filter((alias) => alias.normalizedPhrase.includes(normalizedQuery));
  }

  getById(id: string) {
    return this.aliases.get(id) ?? null;
  }

  getByPhrase(phrase: string) {
    const normalizedPhrase = normalizeAliasPhrase(phrase);
    return this.list().find((alias) => alias.normalizedPhrase === normalizedPhrase) ?? null;
  }

  create(input: AliasCreateInput) {
    const normalizedPhrase = normalizeAliasPhrase(input.phrase);
    if (!normalizedPhrase) throw new Error("Alias phrase is required.");
    const existing = this.getByPhrase(input.phrase);
    const now = new Date().toISOString();

    if (existing && !input.overwrite) {
      throw new Error(`Alias already exists for phrase: ${input.phrase}`);
    }

    if (existing) {
      const updated: AliasDefinition = {
        ...existing,
        phrase: input.phrase.trim(),
        normalizedPhrase,
        description: input.description,
        target: input.target,
        enabled: true,
        updatedAt: now,
      };
      this.aliases.set(updated.id, updated);
      this.save();
      return updated;
    }

    const alias: AliasDefinition = {
      id: crypto.randomUUID(),
      phrase: input.phrase.trim(),
      normalizedPhrase,
      description: input.description,
      target: input.target,
      enabled: true,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
    };
    this.aliases.set(alias.id, alias);
    this.save();
    return alias;
  }

  update(input: AliasUpdateInput) {
    const current = input.aliasId ? this.getById(input.aliasId) : input.phrase ? this.getByPhrase(input.phrase) : null;
    if (!current) throw new Error("Alias not found.");
    const phrase = input.nextPhrase ?? current.phrase;
    const normalizedPhrase = normalizeAliasPhrase(phrase);
    if (!normalizedPhrase) throw new Error("Alias phrase is required.");
    const duplicate = this.getByPhrase(phrase);
    if (duplicate && duplicate.id !== current.id) throw new Error(`Alias already exists for phrase: ${phrase}`);
    const updated: AliasDefinition = {
      ...current,
      phrase: phrase.trim(),
      normalizedPhrase,
      description: input.description ?? current.description,
      target: input.target ?? current.target,
      enabled: input.enabled ?? current.enabled,
      updatedAt: new Date().toISOString(),
    };
    this.aliases.set(updated.id, updated);
    this.save();
    return updated;
  }

  delete(input: { aliasId?: string; phrase?: string }) {
    const current = input.aliasId ? this.getById(input.aliasId) : input.phrase ? this.getByPhrase(input.phrase) : null;
    if (!current) throw new Error("Alias not found.");
    this.aliases.delete(current.id);
    this.save();
    return current;
  }

  private load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as AliasFile;
      for (const alias of parsed.aliases ?? []) {
        if (!alias.id || !alias.phrase || !alias.normalizedPhrase || !alias.target?.toolName) continue;
        this.aliases.set(alias.id, alias);
      }
    } catch {
      this.aliases.clear();
    }
  }

  private save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload: AliasFile = { aliases: this.list() };
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}
