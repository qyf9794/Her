import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("herWindow", {
  setOrbOnlyMode: (enabled: boolean) => ipcRenderer.invoke("her-window:set-orb-only", enabled),
});

contextBridge.exposeInMainWorld("herLocalApi", {
  request: (request: { method?: "GET" | "POST"; path: string; body?: unknown }) =>
    ipcRenderer.invoke("her-local-api:request", request),
});
