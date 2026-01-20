# Publish and increment (super simple)

Assumptions: you are in the repository root in the VS Code terminal, and `vsce` is installed globally.

Steps:

1. Confirm `publisher` and `engines.vscode` in `package.json` are correct.

2. Publish and increment the version in one command (patch/minor/major):

```powershell
vsce publish patch
```

What this does:
- Increments the package version (patch/minor/major) in `package.json`.
- Packages the extension.
- Uploads the new version to the Marketplace.

Semver (patch / minor / major):
- `patch`: increments the last number (0.0.1 → 0.0.(1+1)) → 0.0.2 Use for bug fixes and small, backwards-compatible changes.
- `minor`: increments the middle number (0.1.0 → 0.(1+1).0) → 0.2.0 Use for new, backwards-compatible features; resets patch to 0.
- `major`: increments the first number (1.0.0 → (1+1).0.0) → 2.0.0 Use for breaking changes that may require users to update their code/config.

Notes:
- This requires a PAT configured for `vsce` (see `VSCE_SETUP.md`).
- If you want to keep a local `.vsix` copy before publishing, run `vsce package --out "vsix Versions\\tbd-logger.vsix"` first (optional).

That's it.
