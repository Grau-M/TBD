# VSCE setup and PAT (installation + publishing prep)

This file contains instructions for installing `vsce` (if you don't have it) and creating a Personal Access Token (PAT) for CLI publishing.

1) Install `vsce` globally (optional; you can use `npx` instead):

```powershell
npm install -g vsce
```

2) Create a Personal Access Token (PAT) for publishing

- Sign in to https://dev.azure.com with the account that manages your Marketplace publisher.
- Open your profile (top-right) → Personal access tokens → New Token.
- Give it a name (e.g., `vsce-publish`), pick an expiration, and grant it the scopes needed to publish extensions (Extension Management / Marketplace publish scopes).
- Create the token and copy it immediately — you cannot view it again.

3) Make the PAT available to `vsce`

- For the current PowerShell session (temporary):

```powershell
$env:VSCE_PAT = 'PASTE_YOUR_TOKEN_HERE'
```

- To persist across sessions (Windows):

```powershell
setx VSCE_PAT "PASTE_YOUR_TOKEN_HERE"
# Restart terminal for setx to take effect
```

4) Optional: interactive login

```powershell
# prompts for token and stores it in OS keychain
vsce login <publisher>
```

Replace `<publisher>` with the `publisher` value from your `package.json`.

Security note: do not share the PAT. Store it in your CI secrets if you automate publishing.
