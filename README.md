# nordvpn-mcp

Local stdio MCP server that exposes a thin tool layer around a user-supplied checkout of the NordVPN CLI project.

The intended CLI backend is your fork:

- https://github.com/AlejandroAkbal/nordvpn-macos-cli

## Required startup argument

This MCP requires the NordVPN CLI project root as its first startup argument, or via the `NORDVPN_PROJECT_ROOT` environment variable.

Example:

```bash
node dist/index.js /Users/lume/Projects/nordvpn-operator
```

## Tools

- `vpn_status`
- `vpn_list_countries`
- `vpn_list_servers`
- `vpn_connect`
- `vpn_disconnect`
- `vpn_rotate`
- `vpn_setup`

## Development

```bash
pnpm install
pnpm build
pnpm test
node dist/index.js /Users/lume/Projects/nordvpn-operator
```

OpenCode should launch this server through `~/.config/opencode/opencode.json` using stdio.

## Verification semantics

`vpn_status` parsing now recognizes verification outcomes emitted by the CLI backend:

- `verified`
- `country_mismatch`
- `country_unconfirmed`
- `unavailable` (for explicit server connections without country scope)

`vpn_connect` and `vpn_rotate` follow-up verification (`verifyAfterConnect` / `verifyAfterRotate`) prioritizes these parsed states before falling back to plain observed-country comparison.

## PATH behavior

At startup the server ensures Homebrew binary paths are present in `PATH`:

- `/opt/homebrew/bin`
- `/opt/homebrew/sbin`

This allows MCP-launched subprocesses to discover `openvpn` when it is installed via Homebrew.
