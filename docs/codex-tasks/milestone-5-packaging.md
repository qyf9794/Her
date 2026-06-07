# Milestone 5: Electron Packaging, Signing, and Update Skeleton

## Goal

Add product distribution foundations while keeping the current dev workflow intact.

## Scope

Implement:

1. Electron Forge setup.
2. Package/make/publish scripts.
3. macOS zip/dmg maker.
4. Windows maker placeholder.
5. Signing/notarization config placeholders.
6. Auto-update skeleton.
7. Packaging docs.

## Out of scope

Do not implement:

- Real production signing secrets.
- Real update server.
- App Store distribution.
- Major runtime refactor.

## Required implementation details

### Scripts

Add:

```json
{
  "package": "electron-forge package",
  "make": "electron-forge make",
  "publish": "electron-forge publish"
}
```

Keep existing:

- `dev`
- `build`
- `start`

### Signing

Use env variables only.

Do not hardcode:

- Apple ID
- Apple password
- Team ID
- certificates
- private keys

### Makers

Configure at least:

- macOS zip
- macOS dmg if available
- Windows squirrel or wix placeholder

### Update skeleton

Add stable/beta/canary channel concept, but do not require a real update server.

## Suggested implementation path

1. Add Electron Forge dependencies.
2. Add `forge.config.ts`.
3. Verify package output.
4. Add packaging docs.
5. Ensure dev script still works.
6. Ensure build still works.

## Acceptance criteria

- `npm run build` passes.
- `npm run package` works locally.
- `npm run make` works or reports platform-specific missing tool clearly.
- No signing secret is hardcoded.
- README or `docs/packaging.md` explains packaging.
- Existing dev flow remains unchanged.

## Suggested files to inspect

- `package.json`
- `vite.config.ts`
- `electron/tsconfig.json`
- `src/main/main.ts`
- `index.html`

## Completion report

Report:

- Added dependencies.
- Generated artifacts location.
- Packaging commands run.
- Platform-specific limitations.
