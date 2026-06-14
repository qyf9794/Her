#!/usr/bin/env node

import dotenv from "dotenv";
import { createRequire } from "node:module";
import { OpenAIRealtimeWebSocket, RealtimeAgent, RealtimeSession, tool } from "@openai/agents/realtime";

dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env" });

const require = createRequire(import.meta.url);
const { buildRealtimeAgentInstructions } = require("../electron/dist/shared/realtime-agent.js");
const { realtimeToolDefinitions } = require("../electron/dist/shared/tools.js");

const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.HER_REALTIME_MODEL ?? "gpt-realtime-2";
const text = process.argv.slice(2).join(" ").trim() || "我明天要去洛杉矶，帮我安排";
const timeoutMs = Number(process.env.HER_REALTIME_INTENT_SMOKE_TIMEOUT_MS ?? "45000");
const expectedTomorrow = formatLocalDate(addDays(new Date(), 1));

if (!apiKey) {
  console.error("OPENAI_API_KEY is not configured.");
  process.exit(1);
}

const capturedCalls = [];
const tools = realtimeToolDefinitions.map((definition) =>
  tool({
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    strict: false,
    execute: async (input) => {
      const args = coerceToolArguments(input);
      capturedCalls.push({ name: definition.name, arguments: args });
      if (definition.name === "intent_route") {
        return {
          ok: true,
          captured: true,
          nextAction: "Headless smoke captured StandardIntent. Do not continue with side effects in this Realtime session.",
        };
      }
      return {
        ok: true,
        captured: true,
        nextAction: "Headless smoke captured tool call only.",
      };
    },
  }),
);

const agent = new RealtimeAgent({
  name: "HER Headless Realtime Parser Smoke",
  instructions: `${buildRealtimeAgentInstructions()}

Headless smoke-test override:
- For the next user message, do not answer conversationally first.
- Parse the message into StandardIntent JSON and call intent_route immediately.
- Stop after intent_route returns.`,
  tools,
});

const transport = new OpenAIRealtimeWebSocket({ useInsecureApiKey: true });
const session = new RealtimeSession(agent, {
  model,
  transport,
  config: {
    outputModalities: ["text"],
    toolChoice: "auto",
    parallelToolCalls: false,
    providerData: {
      max_output_tokens: 600,
      truncation: {
        type: "retention_ratio",
        retention_ratio: 0.8,
        token_limits: {
          post_instructions: 6000,
        },
      },
    },
  },
});

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    reject(new Error(`Realtime intent smoke timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  session.on("agent_tool_end", () => {
    const intentCall = capturedCalls.find((call) => call.name === "intent_route");
    if (!intentCall) return;
    clearTimeout(timeout);
    resolve({ capturedCalls, intentCall });
  });

  session.on("agent_end", (_context, _agent, output) => {
    const intentCall = capturedCalls.find((call) => call.name === "intent_route");
    if (!intentCall) {
      clearTimeout(timeout);
      reject(new Error(`Realtime completed without calling intent_route. Output: ${output}`));
      return;
    }
    clearTimeout(timeout);
    resolve({ capturedCalls, intentCall, output });
  });

  session.on("error", (event) => {
    clearTimeout(timeout);
    reject(errorFromRealtimeEvent(event));
  });

  session.connect({ apiKey, model })
    .then(() => {
      session.sendMessage(text);
    })
    .catch((error) => {
      clearTimeout(timeout);
      reject(error);
    });
}).finally(() => {
  session.close();
});

const intent = result.intentCall.arguments?.intent;
const validation = validateIntent(text, intent);
if (validation.length) {
  console.error(JSON.stringify({
    ok: false,
    model,
    text,
    errors: validation,
    capturedCalls: result.capturedCalls,
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  model,
  text,
  intent,
  capturedToolNames: result.capturedCalls.map((call) => call.name),
}, null, 2));

function coerceToolArguments(input) {
  if (typeof input === "string") {
    try {
      return coerceToolArguments(JSON.parse(input));
    } catch {
      return {};
    }
  }
  if (input && typeof input === "object" && !Array.isArray(input)) return input;
  return {};
}

function validateIntent(originalText, intent) {
  const errors = [];
  if (!intent || typeof intent !== "object") {
    return ["intent_route arguments.intent is missing."];
  }
  if (intent.originalText !== originalText) errors.push(`originalText mismatch: ${intent.originalText}`);
  if (intent.complexity !== "complex") errors.push(`Expected complexity=complex, got ${intent.complexity}`);
  if (intent.domain !== "travel") errors.push(`Expected domain=travel, got ${intent.domain}`);
  if (intent.routePreference !== "codex") errors.push(`Expected routePreference=codex, got ${intent.routePreference}`);
  const entities = intent.entities && typeof intent.entities === "object" ? intent.entities : {};
  const destination = String(entities.destination ?? entities.location ?? entities.city ?? "");
  if (!/los angeles|洛杉矶/i.test(destination)) errors.push(`Expected Los Angeles destination, got ${destination || "[missing]"}`);
  const date = String(entities.date ?? entities.startDate ?? entities.travelDate ?? "");
  if (!date.startsWith(expectedTomorrow)) errors.push(`Expected absolute tomorrow date ${expectedTomorrow}, got ${date || "[missing]"}`);
  return errors;
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function errorFromRealtimeEvent(event) {
  const raw = event?.error ?? event;
  if (raw instanceof Error) return raw;
  if (raw && typeof raw === "object") {
    const message = raw.message ?? raw.error?.message ?? JSON.stringify(raw);
    return new Error(String(message));
  }
  return new Error(String(raw));
}
