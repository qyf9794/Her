import type { AuditEvent } from "../../shared/events";

const LOCAL_API = "http://127.0.0.1:3939";

type LocalApiBridgeResponse<T> = {
  ok: boolean;
  status: number;
  payload: T;
};

declare global {
  interface Window {
    herLocalApi?: {
      request: <T>(request: { method?: "GET" | "POST"; path: string; body?: unknown }) => Promise<LocalApiBridgeResponse<T>>;
    };
  }
}

export const localApiUrl = (path: string) => new URL(path, LOCAL_API).toString();

export const getJson = async <T>(path: string): Promise<T> => requestJson<T>("GET", path);

export const postJson = async <T>(path: string, body: unknown): Promise<T> =>
  requestJson<T>("POST", path, body);

export const writeAudit = (
  action: string,
  summary: string,
  status: AuditEvent["status"],
  details?: Record<string, unknown>,
) => {
  void postJson("/api/audit", {
    action,
    summary,
    status,
    ...(details ? { details } : {}),
  }).catch(() => undefined);
};

const requestJson = async <T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> => {
  if (!window.herLocalApi) {
    throw new Error("Local API bridge is unavailable.");
  }

  const response = await window.herLocalApi.request<T & { error?: string }>({ method, path, body });
  const payload = response.payload;
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`);
  return payload as T;
};
