import type { ToolGroup } from "./metadata";
import type { ToolBundle } from "./define-tool";

export type ToolBundleMetadata = {
  title: string;
  groups: ToolGroup[];
};

export const toolBundles: Record<ToolBundle, ToolBundleMetadata> = {
  core: { title: "Core runtime", groups: ["permissions", "agents"] },
  filesystem: { title: "Files", groups: ["files"] },
  documents: { title: "Documents", groups: ["documents"] },
  comms: { title: "Communications and productivity", groups: ["text", "phone", "social", "research"] },
  media: { title: "Media", groups: ["media"] },
  desktop: { title: "Desktop, apps, windows, system", groups: ["apps", "windows", "system"] },
  browser: { title: "Browser", groups: ["browser"] },
  shell: { title: "Shell", groups: ["shell"] },
};
