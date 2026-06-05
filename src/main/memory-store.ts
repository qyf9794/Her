import fs from "node:fs";
import path from "node:path";

export type MemoryType = "path_alias" | "preference" | "task_template";

export type MemoryItem = {
  id: string;
  type: MemoryType;
  key: string;
  value?: string;
  summary: string;
  content?: string;
  aliases: string[];
  tags: string[];
  confidence: number;
  source: "user" | "successful_task" | "system";
  createdAt: string;
  updatedAt: string;
};

export type MemoryLookupInput = {
  query: string;
  types?: MemoryType[];
  limit?: number;
};

export type MemorySaveInput = {
  type: MemoryType;
  key: string;
  value?: string;
  summary?: string;
  content?: string;
  aliases?: string[];
  tags?: string[];
  confidence?: number;
  source?: MemoryItem["source"];
};

export type MemoryMatch = {
  id: string;
  type: MemoryType;
  key: string;
  value?: string;
  summary: string;
  score: number;
  source: MemoryItem["source"];
  updatedAt: string;
};

export class MemoryStore {
  private memoryPath: string;

  constructor(userDataDir?: string) {
    this.memoryPath = userDataDir ? path.join(userDataDir, "memory.json") : path.join(process.cwd(), "data", "memory.json");
  }

  lookup(input: MemoryLookupInput) {
    const query = input.query.trim();
    const types = new Set(input.types ?? ["path_alias", "preference", "task_template"]);
    const limit = Math.min(10, Math.max(1, input.limit ?? 5));
    const queryTerms = tokenize(query);
    const matches = this.read()
      .filter((item) => types.has(item.type))
      .map((item) => ({ item, score: scoreMemoryItem(item, query, queryTerms) }))
      .filter((match) => match.score > 0)
      .sort((a, b) => b.score - a.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
      .slice(0, limit)
      .map(({ item, score }): MemoryMatch => ({
        id: item.id,
        type: item.type,
        key: item.key,
        value: item.value,
        summary: item.summary,
        score: Number(score.toFixed(3)),
        source: item.source,
        updatedAt: item.updatedAt,
      }));

    return {
      matches,
      count: matches.length,
      note: "Memory lookup returns compact summaries only. Providers may resolve full content by id internally.",
    };
  }

  save(input: MemorySaveInput) {
    const now = new Date().toISOString();
    const current = this.read();
    const existing = current.find((item) => item.type === input.type && normalize(item.key) === normalize(input.key));
    const next: MemoryItem = {
      id: existing?.id ?? crypto.randomUUID(),
      type: input.type,
      key: input.key.trim(),
      value: input.value?.trim(),
      summary: (input.summary ?? input.value ?? input.content ?? input.key).trim().slice(0, 600),
      content: input.content,
      aliases: normalizeList(input.aliases),
      tags: normalizeList(input.tags),
      confidence: Math.min(1, Math.max(0, input.confidence ?? existing?.confidence ?? 0.8)),
      source: input.source ?? existing?.source ?? "user",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const nextItems = existing ? current.map((item) => (item.id === existing.id ? next : item)) : [next, ...current];
    this.write(nextItems);
    return { memory: toMemoryView(next), saved: true };
  }

  forget(idOrKey: string) {
    const current = this.read();
    const normalized = normalize(idOrKey);
    const next = current.filter((item) => item.id !== idOrKey && normalize(item.key) !== normalized);
    this.write(next);
    return { removed: current.length - next.length, remaining: next.length };
  }

  status() {
    const items = this.read();
    const counts = items.reduce<Record<MemoryType, number>>(
      (acc, item) => {
        acc[item.type] += 1;
        return acc;
      },
      { path_alias: 0, preference: 0, task_template: 0 },
    );
    return { path: this.memoryPath, counts, total: items.length };
  }

  resolveForProvider(ids: string[]) {
    const wanted = new Set(ids);
    return this.read().filter((item) => wanted.has(item.id));
  }

  read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.memoryPath, "utf8")) as Partial<MemoryItem>[];
      return parsed.map(normalizeMemoryItem).filter((item): item is MemoryItem => Boolean(item));
    } catch {
      return [];
    }
  }

  private write(items: MemoryItem[]) {
    fs.mkdirSync(path.dirname(this.memoryPath), { recursive: true });
    fs.writeFileSync(this.memoryPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
  }
}

const toMemoryView = (item: MemoryItem): MemoryMatch => ({
  id: item.id,
  type: item.type,
  key: item.key,
  value: item.value,
  summary: item.summary,
  score: 1,
  source: item.source,
  updatedAt: item.updatedAt,
});

const normalizeMemoryItem = (item: Partial<MemoryItem>): MemoryItem | undefined => {
  if (!item.id || !isMemoryType(item.type) || !item.key || !item.summary) return undefined;
  return {
    id: item.id,
    type: item.type,
    key: item.key,
    value: item.value,
    summary: item.summary,
    content: item.content,
    aliases: normalizeList(item.aliases),
    tags: normalizeList(item.tags),
    confidence: Math.min(1, Math.max(0, Number(item.confidence ?? 0.8))),
    source: item.source === "successful_task" || item.source === "system" ? item.source : "user",
    createdAt: item.createdAt ?? new Date().toISOString(),
    updatedAt: item.updatedAt ?? item.createdAt ?? new Date().toISOString(),
  };
};

const isMemoryType = (value: unknown): value is MemoryType =>
  value === "path_alias" || value === "preference" || value === "task_template";

const scoreMemoryItem = (item: MemoryItem, query: string, terms: string[]) => {
  const q = normalize(query);
  const key = normalize(item.key);
  const aliases = item.aliases.map(normalize);
  const tags = item.tags.map(normalize);
  const text = normalize([item.key, item.summary, item.value, ...item.aliases, ...item.tags].filter(Boolean).join(" "));
  let score = 0;
  if (q && key === q) score += 1;
  if (q && (key.includes(q) || q.includes(key))) score += 0.7;
  if (aliases.some((alias) => alias && (q.includes(alias) || alias.includes(q)))) score += 0.6;
  score += tags.filter((tag) => tag && q.includes(tag)).length * 0.18;
  score += terms.filter((term) => term.length >= 2 && text.includes(term)).length * 0.12;
  if (item.type === "path_alias" && /(文件夹|目录|folder|directory|路径|path)/i.test(query)) score += 0.2;
  if (item.type === "task_template" && /(写|生成|报告|月报|总结|template|report)/i.test(query)) score += 0.2;
  if (item.type === "preference" && /(偏好|格式|习惯|preference|format)/i.test(query)) score += 0.15;
  return Math.min(1, score * item.confidence);
};

const tokenize = (value: string) =>
  normalize(value)
    .split(/[\s,，。；;:：/\\|()[\]{}"'`~!@#$%^&*+=<>?]+/)
    .flatMap((part) => part.match(/[\p{Script=Han}]{2,}|[a-z0-9_-]{2,}/giu) ?? [])
    .map((part) => part.toLowerCase());

const normalize = (value: string) => value.trim().toLowerCase();

const normalizeList = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
