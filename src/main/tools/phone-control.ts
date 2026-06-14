import { spawn } from "node:child_process";

export type PhoneCallMode = "phone" | "facetime_audio" | "facetime_video";

const run = (command: string, args: string[], timeoutMs = 8000) =>
  new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });

export class PhoneControl {
  async searchContacts(query: string, limit: number) {
    try {
      const output = await run("osascript", ["-l", "JavaScript", "-e", contactsSearchJxa(query, limit)], 8000);
      return { matches: parseContactRows(output).slice(0, limit), timedOut: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/timed out/i.test(message)) throw error;
      return {
        matches: [],
        timedOut: true,
        warning: "Contacts search timed out. macOS Contacts may be unavailable, waiting for privacy permission, or too large to scan through the current adapter.",
      };
    }
  }

  async call(phoneNumber: string, mode: PhoneCallMode = "phone", contactName?: string) {
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) throw new Error("A valid phone number is required.");
    const url =
      mode === "facetime_audio"
        ? `facetime-audio://${encodeURIComponent(normalized)}`
        : mode === "facetime_video"
          ? `facetime://${encodeURIComponent(normalized)}`
          : `tel:${encodeURIComponent(normalized)}`;
    await run("open", [url]);
    return {
      status: "opened_call_url",
      mode,
      contactName,
      phoneNumber: maskPhone(normalized),
      note:
        mode === "facetime_audio"
          ? "Opened FaceTime audio call URL. macOS may still require account setup or user confirmation."
          : mode === "facetime_video"
            ? "Opened FaceTime video call URL. macOS may still require account setup or user confirmation."
            : "Opened tel: call URL. Calling requires macOS/iPhone Continuity or a configured calling app.",
    };
  }
}

const contactsSearchJxa = (query: string, limit: number) => `
  const app = Application("Contacts");
  const q = ${JSON.stringify(query.toLowerCase())};
  const limit = ${Math.max(1, Math.min(10, Math.floor(limit)))};
  const sep = String.fromCharCode(31);
  const rows = [];
  for (const person of app.people()) {
    const name = person.name() || "";
    const phones = person.phones();
    let matched = !q || name.toLowerCase().includes(q);
    for (const phone of phones) {
      const value = phone.value() || "";
      if (q && value.includes(q)) matched = true;
    }
    if (!matched) continue;
    for (const phone of phones) {
      rows.push([person.id(), name, phone.label() || "", phone.value() || ""].join(sep));
      if (rows.length >= limit) break;
    }
    if (rows.length >= limit) break;
  }
  rows.join("\\n");
`;

const parseContactRows = (output: string) =>
  output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [contactId, name, label, phoneNumber] = line.split("\u001f");
      return {
        contactId,
        name,
        label: label || undefined,
        phoneNumber,
        maskedPhoneNumber: maskPhone(phoneNumber),
      };
    })
    .filter((item) => item.name && item.phoneNumber);

const normalizePhoneNumber = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length < 3) return "";
  return `${hasPlus ? "+" : ""}${digits}`;
};

const maskPhone = (value: string) => {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length <= 4) return value;
  return `${value.startsWith("+") ? "+" : ""}${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
};
