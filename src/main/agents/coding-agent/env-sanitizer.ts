const allowedEnvKeys = new Set([
  "HOME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "CODEX_HOME",
]);

const secretPattern = /(token|secret|cookie|authorization|credential|password|passwd|api[_-]?key|oauth|session|bearer|openai|realtime|local[_-]?api|npm[_-]?)/i;

export const sanitizeCodexEnv = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const key of allowedEnvKeys) {
    const value = env[key];
    if (typeof value === "string" && value) sanitized[key] = value;
  }
  for (const key of Object.keys(sanitized)) {
    if (secretPattern.test(key)) delete sanitized[key];
  }
  return sanitized;
};

export const isSecretEnvKey = (key: string) => secretPattern.test(key);
