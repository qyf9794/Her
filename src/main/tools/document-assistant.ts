import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { FileManager } from "./file-manager";
import { isCredentialLikePath, redactSensitiveText } from "./secret-redaction";

const supported = new Set([".txt", ".md", ".markdown", ".pdf", ".docx"]);

export class DocumentAssistant {
  constructor(private files: FileManager) {}

  async extract(inputPath: string, maxChars: number) {
    const filePath = this.files.resolveAllowed(inputPath);
    if (isCredentialLikePath(filePath)) {
      throw new Error("Refusing to extract credential-like document contents. Her will not expose secrets.");
    }
    const ext = path.extname(filePath).toLowerCase();
    if (!supported.has(ext)) throw new Error(`Unsupported document type: ${ext || "unknown"}`);

    let content: string;
    if (ext === ".pdf") content = await extractPdf(filePath);
    else if (ext === ".docx") content = await extractDocx(filePath);
    else content = await fs.readFile(filePath, "utf8");

    const redacted = redactSensitiveText(content.slice(0, maxChars));
    return {
      path: filePath,
      chars: redacted.content.length,
      truncated: content.length > maxChars,
      content: redacted.content,
      redacted: redacted.redacted,
    };
  }

  async folderDigest(rootInput: string, query: string | undefined, limit: number, charsPerFile: number) {
    const root = this.files.resolveAllowed(rootInput);
    const matches = await this.files.search(root, query || "", 8, 200);
    const docs = matches
      .filter((item) => item.type === "file" && supported.has(path.extname(item.path).toLowerCase()))
      .slice(0, limit);

    const extracted = [];
    for (const doc of docs) {
      try {
        extracted.push(await this.extract(doc.path, charsPerFile));
      } catch (error) {
        extracted.push({
          path: doc.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { root, count: extracted.length, documents: extracted };
  }

  async prepareEdit(inputPath: string, newContent: string) {
    const current = await this.files.readText(inputPath, 60000);
    return {
      path: current.path,
      diffPreview: makeDiffPreview(current.content, newContent),
      currentChars: current.chars,
      newChars: newContent.length,
    };
  }
}

const extractPdf = async (filePath: string) => {
  const { PDFParse } = (await import("pdf-parse")) as unknown as {
    PDFParse: new (input: { data: Buffer }) => { getText: () => Promise<{ text: string }>; destroy: () => Promise<void> };
  };
  const parser = new PDFParse({ data: await fs.readFile(filePath) });
  try {
    const parsed = await parser.getText();
    return parsed.text;
  } finally {
    await parser.destroy();
  }
};

const extractDocx = async (filePath: string) => {
  const mammoth = await import("mammoth");
  const parsed = await mammoth.extractRawText({ path: filePath });
  return parsed.value;
};

const makeDiffPreview = (before: string, after: string) => {
  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines: string[] = [];
  for (let index = 0; index < max && lines.length < 80; index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] !== undefined) lines.push(`- ${beforeLines[index]}`);
    if (afterLines[index] !== undefined) lines.push(`+ ${afterLines[index]}`);
  }
  return lines.length ? lines.join("\n") : "No textual changes detected.";
};

export const commandExists = (command: string) =>
  new Promise<boolean>((resolve) => {
    const child = spawn("which", [command], { stdio: "ignore" });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
