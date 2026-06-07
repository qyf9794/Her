import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("herWindow", {
  setOrbOnlyMode: (enabled: boolean) => ipcRenderer.invoke("her-window:set-orb-only", enabled),
});
