import type { ToolBundle } from "./define-tool";
import { toolManifest, type ToolManifestEntry } from "./manifest";

export const domainManifests = Object.fromEntries(
  (["core", "filesystem", "documents", "comms", "media", "desktop", "browser", "shell"] as ToolBundle[]).map((bundle) => [
    bundle,
    Object.fromEntries(
      Object.values(toolManifest)
        .filter((entry) => entry.bundle === bundle)
        .map((entry) => [entry.name, entry]),
    ) as Partial<Record<ToolManifestEntry["name"], ToolManifestEntry>>,
  ]),
) as Record<ToolBundle, Partial<Record<ToolManifestEntry["name"], ToolManifestEntry>>>;

export const coreManifest = domainManifests.core;
export const filesystemManifest = domainManifests.filesystem;
export const documentsManifest = domainManifests.documents;
export const commsManifest = domainManifests.comms;
export const mediaManifest = domainManifests.media;
export const desktopManifest = domainManifests.desktop;
export const browserManifest = domainManifests.browser;
export const shellManifest = domainManifests.shell;
