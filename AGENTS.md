@RTK.md

## Project tools (Windows)

- This is a roblox-ts/Rojo game. Follow the project rules in CLAUDE.md.
- RTK is project-local: use `./.tools/rtk/rtk.exe` in PowerShell, not a global `rtk` command. Prefer its git, read and supported build filters for large output. Keep searches scoped and inspect full errors when needed.
- The Codex hook requires a new session and host support. Until verified, invoke RTK explicitly; never assume automatic compression.
- Headroom is a development tool only, outside src/. For large saved logs use `./.tools/headroom/Scripts/python.exe tools/compress-log.py path/to/log.txt`. Never compress source edits or hide failed commands. Read the original when diagnosing missing context.
- Headroom does not automatically compress this Codex conversation. Do not add Python/Node provider packages to the Roblox runtime.
- Structure check: run `powershell -NoProfile -ExecutionPolicy Bypass -File tools/check-structure.ps1` (`./tools/check-structure.ps1`) at the end of every task to audit `src/` files over 500 lines, cross-imports between `client` and `server`, `Vector3`/`Color3`/`UDim2` usage in `src/shared/`, and Remote name string literals outside `Remotes.ts`.
