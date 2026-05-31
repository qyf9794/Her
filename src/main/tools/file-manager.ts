import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { config } from "../config";

const textExtensions = new Set([".txt", ".md", ".markdown", ".json", ".csv", ".log", ".yaml", ".yml"]);

const home = os.homedir();

const expandPath = (input: string) => {
  if (input === "Desktop" || input === "Documents" || input === "Downloads") {
    return path.join(home, input);
  }
  if (input === "~") return home;
  if (input.startsWith("~/")) return path.join(home, input.slice(2));
  return input;
};

export class FileManager {
  resolveAllowed(input: string) {
    const resolved = path.resolve(expandPath(input));
    const allowed = config.allowedDirectories.some((dir) => resolved === dir || resolved.startsWith(`${dir}${path.sep}`));
    if (!allowed) {
      throw new Error(`Path is outside allowed directories: ${input}`);
    }
    return resolved;
  }

  async list(inputPath: string, includeHidden = false) {
    const folder = this.resolveAllowed(inputPath);
    const stat = await fs.stat(folder);
    if (!stat.isDirectory()) throw new Error(`Not a folder: ${inputPath}`);
    const entries = await fs.readdir(folder, { withFileTypes: true });
    const visible = entries.filter((entry) => includeHidden || !entry.name.startsWith(".")).slice(0, 200);
    return Promise.all(
      visible.map(async (entry) => {
        const fullPath = path.join(folder, entry.name);
        const itemStat = await fs.stat(fullPath);
        return {
          name: entry.name,
          path: fullPath,
          type: entry.isDirectory() ? "folder" : "file",
          size: itemStat.size,
          modifiedAt: itemStat.mtime.toISOString(),
        };
      }),
    );
  }

  async search(rootInput: string, query: string, maxDepth: number, limit: number) {
    const root = this.resolveAllowed(rootInput);
    const q = query.toLowerCase();
    const results: Array<{ name: string; path: string; type: "file" | "folder"; size: number; modifiedAt: string }> = [];

    const walk = async (folder: string, depth: number) => {
      if (depth > maxDepth || results.length >= limit) return;
      let entries;
      try {
        entries = await fs.readdir(folder, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = path.join(folder, entry.name);
        const stat = await fs.stat(fullPath).catch(() => null);
        if (!stat) continue;
        if (entry.name.toLowerCase().includes(q)) {
          results.push({
            name: entry.name,
            path: fullPath,
            type: entry.isDirectory() ? "folder" : "file",
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        }
        if (results.length >= limit) break;
        if (entry.isDirectory()) await walk(fullPath, depth + 1);
      }
    };

    await walk(root, 0);
    return results;
  }

  async readText(inputPath: string, maxChars: number) {
    const filePath = this.resolveAllowed(inputPath);
    const ext = path.extname(filePath).toLowerCase();
    if (!textExtensions.has(ext)) {
      throw new Error(`Use document_extract for ${ext || "this file type"}.`);
    }
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${inputPath}`);
    const content = await fs.readFile(filePath, "utf8");
    return {
      path: filePath,
      chars: content.length,
      truncated: content.length > maxChars,
      content: content.slice(0, maxChars),
    };
  }

  async open(inputPath: string, appName?: string) {
    const filePath = this.resolveAllowed(inputPath);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(`Not a file: ${inputPath}`);
    await runOpen(appName ? ["-a", appName, filePath] : [filePath]);
    return { opened: filePath, appName: appName || undefined };
  }

  async rename(inputPath: string, newName: string) {
    if (newName.includes("/") || newName.includes("\\")) throw new Error("newName must be a filename, not a path.");
    const from = this.resolveAllowed(inputPath);
    const to = this.resolveAllowed(path.join(path.dirname(from), newName));
    await fs.rename(from, to);
    return { from, to };
  }

  async createFolder(parentInput: string, folderName: string) {
    if (folderName.includes("/") || folderName.includes("\\")) {
      throw new Error("folderName must be a folder name, not a path.");
    }

    const trimmedName = folderName.trim();
    if (!trimmedName || trimmedName === "." || trimmedName === "..") {
      throw new Error("folderName must be a valid folder name.");
    }

    const parent = this.resolveAllowed(parentInput);
    const parentStat = await fs.stat(parent);
    if (!parentStat.isDirectory()) throw new Error(`Parent is not a folder: ${parentInput}`);

    const folderPath = this.resolveAllowed(path.join(parent, trimmedName));
    if (await exists(folderPath)) {
      throw new Error(`Folder already exists: ${folderPath}`);
    }

    await fs.mkdir(folderPath);
    return { path: folderPath, parent, name: trimmedName };
  }

  async move(fromInput: string, toInput: string) {
    const from = this.resolveAllowed(fromInput);
    const to = this.resolveAllowed(toInput);
    await fs.rename(from, to);
    return { from, to };
  }

  async copy(fromInput: string, toInput: string) {
    const from = this.resolveAllowed(fromInput);
    const to = this.resolveAllowed(toInput);
    const stat = await fs.stat(from);
    if (stat.isDirectory()) await fs.cp(from, to, { recursive: true, errorOnExist: true });
    else await fs.copyFile(from, to);
    return { from, to, type: stat.isDirectory() ? "folder" : "file" };
  }

  async trash(inputPath: string) {
    const from = this.resolveAllowed(inputPath);
    const trashDir = path.join(home, ".Trash");
    const parsed = path.parse(from);
    let to = path.join(trashDir, parsed.base);
    let counter = 1;
    while (await exists(to)) {
      to = path.join(trashDir, `${parsed.name} ${counter}${parsed.ext}`);
      counter += 1;
    }
    await fs.rename(from, to);
    return { from, to, note: "Moved to Trash; not permanently deleted." };
  }

  async writeText(inputPath: string, content: string) {
    const filePath = this.resolveAllowed(inputPath);
    const ext = path.extname(filePath).toLowerCase();
    if (!new Set([".txt", ".md", ".markdown"]).has(ext)) {
      throw new Error("Only .txt and .md files can be edited by this tool.");
    }
    await fs.writeFile(filePath, content, "utf8");
    return { path: filePath, chars: content.length };
  }
}

const exists = async (inputPath: string) => {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
};

const runOpen = (args: string[]) =>
  new Promise<void>((resolve, reject) => {
    const child = spawn("open", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`open exited with code ${code}`));
    });
  });
