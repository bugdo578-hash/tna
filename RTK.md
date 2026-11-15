<!-- rtk-owned: written by `rtk init --codex`, removed by `rtk init --codex --uninstall` -->

# Command output

Use `./.tools/rtk/rtk.exe git status`, `git diff --stat`, or `read <file>`
explicitly for supported commands. Compression can omit context; inspect the
original output if a diagnostic is unclear. Use scoped `rg` for searches.

Build this Roblox project with `npx.cmd rbxtsc`, not ordinary `tsc`.
The local Codex hook only runs in hosts that support project PreToolUse hooks;
its presence does not prove that commands in this session are being rewritten.
