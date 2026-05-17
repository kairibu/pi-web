# @jmfederico/pi-web

## 1.202605.7

### Patch Changes

- aab9ffb: Preserve newly started empty sessions and their prompt drafts across browser reloads until the user deletes them.
- c5bc855: Improve `pi-web doctor` and `pi-web install` to use the detected bash, zsh, or fish login shell, verify the systemd user service context can find required commands before installation, and print shell-specific PATH setup advice without persisting transient PATH values.
- 9b1b1bb: Fix the docs mobile navigation so FAQ pages no longer overflow and compact the GitHub/theme controls on small screens.
- 0aa0a13: Fix chat history reloads so previously displayed messages are not duplicated from the browser cache.
- 42cad58: Add remote-first development positioning to the website and docs, including a philosophy page and laptop-versus-server FAQ guidance.
- c66d834: Add a static Pi Web website with installation docs, troubleshooting FAQ, and GitHub Pages deployment.
- 6a8f8b6: Add global web UI `/login` and `/logout` flows for configuring API key and subscription provider authentication.

## 1.202605.6

### Patch Changes

- 559436c: Install Pi Web services from the Pi extension using the normal login-shell command shims instead of hardcoded Node paths, so sessions use the same PATH for node and npm.
- c547478: Keep mobile workspace selection in the Sessions view so users can confirm the remembered session before opening chat, and restore mobile URLs without an explicit view back to Sessions.
- 42b9c53: Remove unsupported direct GitHub install instructions from the README.

## 1.202605.5

### Patch Changes

- a807569: Fix browser terminal sizing so progress/status lines update in place instead of wrapping when the PTY size has not caught up with the visible terminal.
- d064c4e: Improve package gallery discoverability for remote web UI and browser control plane searches.

## 1.202605.4

### Patch Changes

- 7a9e7db: Copying selected rendered chat markdown now places the raw markdown source on the clipboard.
- cf43c95: Formalize release notes with Changesets and project-local skills for changelog and npm publishing workflows.
- e12382c: Keep a new prompt separate from the stopped prompt after aborting a session turn.
