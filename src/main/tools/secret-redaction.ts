import path from "node:path";

const sensitivePathPattern = /(^|[._\-/\\\s])(authkey|private[-_\s]?key|secret|credential|token|cookie|password)([._\-/\\\s]|$)/i;
const sensitiveExtensions = new Set([".p8", ".pem", ".key"]);

const redactionPatterns: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[redacted private key]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[redacted api key]"],
  [
    /\b(api[-_\s]?key|token|secret|password|cookie|authorization|private[-_\s]?key)\b(\s*[:=]\s*)(["']?)[^\s"',;]+/gi,
    "$1$2$3[redacted]",
  ],
];

export const isCredentialLikePath = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath);
  return sensitiveExtensions.has(ext) || sensitivePathPattern.test(base);
};

export const redactSensitiveText = (value: string) => {
  let redacted = value;
  for (const [pattern, replacement] of redactionPatterns) {
    redacted = redacted.replace(pattern, replacement);
  }
  return {
    content: redacted,
    redacted: redacted !== value,
  };
};
