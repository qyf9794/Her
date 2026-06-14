import type { ForgeConfig } from "@electron-forge/shared-types";
import { AutoUnpackNativesPlugin } from "@electron-forge/plugin-auto-unpack-natives";

const appBundleId = process.env.HER_APP_BUNDLE_ID ?? "com.her.voice-agent";
const macSignIdentity = process.env.HER_MAC_SIGN_IDENTITY;
const notarizeAppleId = process.env.HER_NOTARIZE_APPLE_ID;
const notarizeApplePassword = process.env.HER_NOTARIZE_APPLE_PASSWORD;
const notarizeTeamId = process.env.HER_NOTARIZE_TEAM_ID ?? process.env.APPLE_TEAM_ID;

const osxSign = macSignIdentity
  ? {
      identity: macSignIdentity,
      hardenedRuntime: true,
      entitlements: "packaging/entitlements.mac.plist",
      "entitlements-inherit": "packaging/entitlements.mac.plist",
      "gatekeeper-assess": false,
    }
  : undefined;

const osxNotarize = notarizeAppleId && notarizeApplePassword && notarizeTeamId
  ? {
      appleId: notarizeAppleId,
      appleIdPassword: notarizeApplePassword,
      teamId: notarizeTeamId,
    }
  : undefined;

const config: ForgeConfig = {
  outDir: "out",
  packagerConfig: {
    name: "Her",
    executableName: "Her",
    appBundleId,
    appCategoryType: "public.app-category.productivity",
    asar: true,
    osxSign,
    osxNotarize,
    ignore: [
      /^\/\.env(?:\.|$)/,
      /^\/\.npm-cache(?:\/|$)/,
      /^\/\.git(?:\/|$)/,
      /^\/\.gitignore$/,
      /^\/node_modules\/\.vite(?:\/|$)/,
      /^\/node_modules\/\.package-lock\.json$/,
      /^\/AGENTS\.md$/,
      /^\/agent\.md$/,
      /^\/forge\.config\.ts$/,
      /^\/index\.html$/,
      /^\/src(?:\/|$)/,
      /^\/docs(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/data(?:\/|$)/,
      /^\/packaging(?:\/|$)/,
      /^\/electron\/tsconfig\.json$/,
      /^\/tsconfig\.json$/,
      /^\/vite\.config\.ts$/,
      /^\/package-lock\.json$/,
      /^\/HER工具清单\.xlsx(?:\.bak)?$/,
    ],
  },
  rebuildConfig: {},
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {
        name: "Her",
        format: "ULFO",
      },
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "Her",
        setupExe: "HerSetup.exe",
        noMsi: true,
      },
    },
  ],
  plugins: [new AutoUnpackNativesPlugin({})],
  publishers: [],
};

export default config;
