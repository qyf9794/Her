import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plist = path.join(root, "node_modules", "electron", "dist", "Electron.app", "Contents", "Info.plist");
const plistBuddy = "/usr/libexec/PlistBuddy";

const run = (args) => spawnSync(plistBuddy, args, { encoding: "utf8" });

const setResult = run(["-c", "Set :NSCameraUseContinuityCameraDeviceType true", plist]);
if (setResult.status === 0) {
  console.log("Electron Info.plist Continuity Camera key is set.");
  process.exit(0);
}

const addResult = run(["-c", "Add :NSCameraUseContinuityCameraDeviceType bool true", plist]);
if (addResult.status === 0) {
  console.log("Added Electron Info.plist Continuity Camera key.");
  process.exit(0);
}

process.stderr.write(addResult.stderr || setResult.stderr || "Failed to patch Electron Info.plist.\n");
process.exit(addResult.status ?? 1);
