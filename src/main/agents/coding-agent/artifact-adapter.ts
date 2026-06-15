import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  CodingAgentApplyInput,
  CodingAgentApplyResult,
  CodingAgentChangedFile,
  CodingAgentReview,
  CodingAgentTaskView,
} from "../../../shared/agents/coding-agent";

const defaultDiffLimit = 24000;

const emptyReview = (summary: string): CodingAgentReview => ({
  generatedAt: new Date().toISOString(),
  summary,
  changedFiles: [],
  diffPreview: "",
  diffTruncated: false,
  tests: [],
  followUps: [summary],
  applyAvailable: false,
});

export const buildCodingAgentReview = async (
  task: CodingAgentTaskView,
  maxDiffChars = defaultDiffLimit,
): Promise<CodingAgentReview> => {
  if (!task.worktreePath) return emptyReview("No isolated worktree is available for this task.");

  const changedFiles = await readChangedFiles(task.worktreePath);
  const rawDiff = await git(task.worktreePath, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"]).catch(() => "");
  const diffTruncated = rawDiff.length > maxDiffChars;
  const diffPreview = diffTruncated ? `${rawDiff.slice(0, maxDiffChars)}\n\n[diff truncated]` : rawDiff;
  const tests = extractTestSignals(task.resultText ?? "");
  const followUps = extractFollowUps(task.resultText ?? "", changedFiles);

  return {
    generatedAt: new Date().toISOString(),
    summary: summarizeReview(task, changedFiles, tests),
    changedFiles,
    diffPreview,
    diffTruncated,
    tests,
    followUps,
    applyAvailable: task.status === "completed" && Boolean(task.repoPath && task.worktreePath) && changedFiles.length > 0,
  };
};

export const applyCodingAgentReviewToRepo = async (
  task: CodingAgentTaskView,
  input: CodingAgentApplyInput,
): Promise<Omit<CodingAgentApplyResult, "task">> => {
  if (task.status !== "completed") throw new Error(`Cannot apply a coding-agent task with status ${task.status}.`);
  if (!task.worktreePath) throw new Error("Cannot apply because the coding-agent worktree is missing.");
  const review = task.review ?? await buildCodingAgentReview(task);
  if (!review.applyAvailable) throw new Error("No coding-agent changes are available to apply.");

  const requested = new Set((input.paths ?? []).filter(Boolean));
  const changedFiles = requested.size
    ? review.changedFiles.filter((file) => requested.has(file.path))
    : review.changedFiles;
  if (!changedFiles.length) throw new Error("No matching changed files were found for apply.");

  const appliedPaths: string[] = [];
  const deletedPaths: string[] = [];
  for (const file of changedFiles) {
    const targetPath = safeJoin(task.repoPath, file.path);
    const sourcePath = safeJoin(task.worktreePath, file.path);
    if (file.status === "deleted") {
      if (fs.existsSync(targetPath)) {
        fs.rmSync(targetPath, { recursive: false, force: true });
        deletedPaths.push(file.path);
      }
      continue;
    }
    if (!fs.existsSync(sourcePath)) throw new Error(`Changed file is missing from worktree: ${file.path}`);
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) throw new Error(`Refusing to apply non-file path from worktree: ${file.path}`);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    appliedPaths.push(file.path);
  }

  return { appliedPaths, deletedPaths, review };
};

const readChangedFiles = async (worktreePath: string): Promise<CodingAgentChangedFile[]> => {
  const output = await git(worktreePath, ["status", "--porcelain", "--untracked-files=all"]);
  const files = output
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map(parsePorcelainStatus)
    .filter((file): file is CodingAgentChangedFile => Boolean(file));
  return dedupeFiles(files);
};

const parsePorcelainStatus = (line: string): CodingAgentChangedFile | undefined => {
  if (line.length < 4) return undefined;
  const code = line.slice(0, 2);
  const rawPath = line.slice(3).trim();
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
  const filePath = normalizeRelativePath(renamedPath.replace(/^"|"$/g, ""));
  if (!filePath) return undefined;
  return {
    path: filePath,
    status: statusFromCode(code),
  };
};

const statusFromCode = (code: string): CodingAgentChangedFile["status"] => {
  if (code === "??") return "untracked";
  if (code.includes("D")) return "deleted";
  if (code.includes("R")) return "renamed";
  if (code.includes("C")) return "copied";
  if (code.includes("A")) return "added";
  if (code.includes("M")) return "modified";
  return "unknown";
};

const normalizeRelativePath = (filePath: string) => {
  const normalized = path.posix.normalize(filePath.replaceAll(path.sep, "/"));
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.startsWith("/") || normalized.includes("/.git/")) {
    return undefined;
  }
  return normalized;
};

const safeJoin = (root: string, relativePath: string) => {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) throw new Error(`Unsafe relative path: ${relativePath}`);
  const resolved = path.resolve(root, normalized);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(`${rootResolved}${path.sep}`)) {
    throw new Error(`Path escapes repository: ${relativePath}`);
  }
  return resolved;
};

const dedupeFiles = (files: CodingAgentChangedFile[]) => {
  const seen = new Map<string, CodingAgentChangedFile>();
  for (const file of files) seen.set(file.path, file);
  return [...seen.values()].sort((a, b) => a.path.localeCompare(b.path));
};

const summarizeReview = (task: CodingAgentTaskView, changedFiles: CodingAgentChangedFile[], tests: string[]) => {
  if (!changedFiles.length) return `Codex ${task.mode} task completed with no worktree file changes.`;
  return `Codex ${task.mode} task completed with ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}${tests.length ? ` and ${tests.length} test signal${tests.length === 1 ? "" : "s"}` : ""}.`;
};

const extractTestSignals = (text: string) => {
  const signals = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /\b(npm\s+run\s+(test|check|build|typecheck)|npm\s+test|vitest|tsc|pytest|cargo\s+test|go\s+test)\b/i.test(line))
    .slice(0, 8);
  return [...new Set(signals)];
};

const extractFollowUps = (text: string, changedFiles: CodingAgentChangedFile[]) => {
  const explicit = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(todo|follow[- ]?up|next|remaining|risk|note)[:\-\s]/i.test(line))
    .slice(0, 6);
  if (explicit.length) return explicit;
  if (!changedFiles.length) return ["Review the Codex result text before deciding whether another turn is needed."];
  return ["Review the diff preview, then apply selected files only if the changes match the user's intent."];
};

const git = (cwd: string, args: string[]) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error((stderr || stdout || `git ${args.join(" ")} exited with code ${code}`).trim()));
    });
  });
