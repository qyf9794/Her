# Packaging

Her uses Electron Forge for local packaging and maker output.

## Commands

```bash
npm run build
npm run package
npm run make
npm run publish
```

`npm run package`, `npm run make`, and `npm run publish` run the existing build first through npm lifecycle scripts. The current development commands remain unchanged:

```bash
npm run dev
npm run start
```

## Local Artifacts

Forge writes packaged apps and maker artifacts to `out/`.

On macOS:

- `npm run package` creates `out/Her-darwin-<arch>/Her.app`.
- `npm run make` creates macOS zip and dmg artifacts when the local maker tools are available.

On Windows:

- The Forge config includes a Squirrel maker placeholder for `win32`.
- Build this target on Windows or CI with the required Windows maker toolchain.

## Signing And Notarization

Signing is configured only through environment variables. Do not commit real signing credentials.

```bash
HER_APP_BUNDLE_ID=com.example.her
HER_MAC_SIGN_IDENTITY="Developer ID Application: Example Team"
HER_NOTARIZE_APPLE_ID=developer@example.com
HER_NOTARIZE_APPLE_PASSWORD=app-specific-password
HER_NOTARIZE_TEAM_ID=TEAMID1234
```

If `HER_MAC_SIGN_IDENTITY` is not set, Forge packages unsigned local builds. If the notarization variables are missing, notarization is skipped.

## Auto-Update Skeleton

M5 adds only an update skeleton. It does not configure a real update server.

Channels:

- `stable`
- `beta`
- `canary`

Configuration:

```bash
HER_UPDATE_CHANNEL=stable
HER_UPDATE_FEED_URL=https://updates.example.com/her
```

Updates are disabled in development and disabled in packaged builds unless `HER_UPDATE_FEED_URL` is set. When enabled, Her appends `channel`, `platform`, and `version` query parameters to the feed URL.

## Packaged Files

The Forge config excludes local source, docs, scripts, generated data, `.env*`, `.git`, and local npm cache files from packaged builds. The app ships compiled main-process code from `electron/dist`, renderer assets from `dist/renderer`, production dependencies, and package metadata.
