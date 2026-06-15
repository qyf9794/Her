import type { DesktopContextRoutingMetadata } from "../../shared/context";

export type ToolBundleName =
  | "core"
  | "file"
  | "document"
  | "desktop"
  | "browser"
  | "comms"
  | "media"
  | "system"
  | "coding";

export type ToolBundleSelection = {
  bundles: ToolBundleName[];
  confidence: number;
  reason: string;
  shouldAskModelToSelect: boolean;
};

export const realtimeToolBundleNames = [
  "core",
  "file",
  "document",
  "desktop",
  "browser",
  "comms",
  "media",
  "system",
  "coding",
] as const satisfies readonly ToolBundleName[];

const bundleRules: Array<{ bundle: Exclude<ToolBundleName, "core">; pattern: RegExp; reason: string }> = [
  { bundle: "file", pattern: /\b(file|folder|directory|path|finder|rename|move|copy|trash|delete|open file|read file|list files?|downloads?|documents?|desktop)\b|文件|文件夹|目录|路径|桌面|下载|重命名|移动|复制|删除/u, reason: "file terms" },
  { bundle: "document", pattern: /\b(document|docx|pdf|markdown|digest|summarize document|extract|edit document|contract)\b|文档|论文|摘要|提取|改文档|合同/u, reason: "document terms" },
  { bundle: "browser", pattern: /\b(browser|web|website|url|link|form|click|page|search online|google|bing|duckduckgo)\b|网页|网站|浏览器|表单|点击|打开链接|搜索网页/u, reason: "browser terms" },
  { bundle: "comms", pattern: /\b(email|mail|calendar|meeting|draft|publish|contact|call|message|reminder|note|weather|news|stock|market)\b|邮件|日历|会议|草稿|发布|联系人|电话|提醒|备忘录|天气|新闻|股票|行情/u, reason: "communications terms" },
  { bundle: "media", pattern: /\b(music|song|spotify|netease|qq music|video|youtube|movie|tv|playback|pause|volume)\b|音乐|歌曲|播放|视频|电影|电视|油管|暂停/u, reason: "media terms" },
  { bundle: "desktop", pattern: /\b(window|app|application|desktop|arrange|minimize|maximize|focus|quit|open app)\b|窗口|应用|桌面|排列|平铺|最小化|最大化|切换|退出应用/u, reason: "desktop terms" },
  { bundle: "system", pattern: /\b(system|settings|sleep|lock|brightness|clipboard|screenshot|shortcut|keyboard|notification|speak)\b|系统|设置|睡眠|锁屏|亮度|剪贴板|截图|快捷键|键盘|通知/u, reason: "system terms" },
  { bundle: "coding", pattern: /\b(code|coding|repo|repository|git|test|tests|pr|pull request|codex|build|lint|typecheck)\b|代码|仓库|测试|构建|提交|拉取请求/u, reason: "coding terms" },
];

export const selectToolBundles = (transcript: string, context?: DesktopContextRoutingMetadata): ToolBundleSelection => {
  const text = transcript.trim().toLowerCase();
  if (!text) {
    return {
      bundles: contextBundles(context),
      confidence: context ? 0.2 : 0,
      reason: context ? "empty transcript; compact desktop context available" : "empty transcript",
      shouldAskModelToSelect: true,
    };
  }

  const matched = bundleRules.filter((rule) => rule.pattern.test(text));
  const contextMatched = contextBundleRules(context);
  const bundles = uniqueBundles(["core", ...matched.map((rule) => rule.bundle), ...contextMatched.map((rule) => rule.bundle)]);

  if (bundles.includes("file") && !bundles.includes("document") && /\b(document|docx|pdf|markdown)\b|文档/u.test(text)) {
    bundles.push("document");
  }
  if (bundles.includes("document") && !bundles.includes("file")) {
    bundles.push("file");
  }
  if (bundles.includes("desktop") && !bundles.includes("system") && /\b(arrange|window|desktop|app)\b|窗口|桌面|应用|平铺/u.test(text)) {
    bundles.push("system");
  }
  if (bundles.includes("system") && !bundles.includes("desktop") && /\b(app|window|desktop)\b|窗口|桌面|应用/u.test(text)) {
    bundles.push("desktop");
  }

  if (matched.length === 0) {
    return {
      bundles: contextMatched.length ? uniqueBundles(["core", ...contextMatched.map((rule) => rule.bundle)]) : ["core"],
      confidence: contextMatched.length ? 0.35 : 0.25,
      reason: contextMatched.length ? `context terms: ${contextMatched.map((rule) => rule.reason).join(", ")}` : "no deterministic bundle terms matched",
      shouldAskModelToSelect: true,
    };
  }

  return {
    bundles: uniqueBundles(bundles),
    confidence: Math.min(0.95, 0.55 + matched.length * 0.15 + contextMatched.length * 0.05),
    reason: [...matched.map((rule) => rule.reason), ...contextMatched.map((rule) => `context ${rule.reason}`)].join(", "),
    shouldAskModelToSelect: false,
  };
};

export const isToolBundleName = (value: string): value is ToolBundleName =>
  (realtimeToolBundleNames as readonly string[]).includes(value);

const uniqueBundles = (bundles: readonly ToolBundleName[]) => {
  const seen = new Set<ToolBundleName>();
  const result: ToolBundleName[] = [];
  for (const bundle of bundles) {
    if (seen.has(bundle)) continue;
    seen.add(bundle);
    result.push(bundle);
  }
  return result;
};

const contextBundles = (context: DesktopContextRoutingMetadata | undefined): ToolBundleName[] =>
  uniqueBundles(["core", ...contextBundleRules(context).map((rule) => rule.bundle)]);

const contextBundleRules = (context: DesktopContextRoutingMetadata | undefined): Array<{ bundle: Exclude<ToolBundleName, "core">; reason: string }> => {
  if (!context) return [];
  const rules: Array<{ bundle: Exclude<ToolBundleName, "core">; reason: string }> = [];
  const appText = `${context.activeApp ?? ""} ${context.activeWindowTitle ?? ""}`.toLowerCase();
  if (appText && /\b(finder|desktop|downloads|documents)\b|访达|桌面|下载|文档/u.test(appText)) rules.push({ bundle: "file", reason: "frontmost file app" });
  if (appText && /\b(safari|chrome|browser|arc|edge|firefox)\b|浏览器/u.test(appText)) rules.push({ bundle: "browser", reason: "frontmost browser app" });
  if (appText && /\b(mail|calendar|notes|reminders)\b|邮件|日历|备忘录|提醒/u.test(appText)) rules.push({ bundle: "comms", reason: "frontmost productivity app" });
  if (context.activeApp) rules.push({ bundle: "desktop", reason: "frontmost app metadata" });
  if (context.clipboard?.status === "available") rules.push({ bundle: "system", reason: "clipboard summary available" });
  return rules;
};
