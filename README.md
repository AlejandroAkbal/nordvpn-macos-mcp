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
node dist/index.js /Users/lume/Projects/nordvpn-operator
```

OpenCode should launch this server through `~/.config/opencode/opencode.json` using stdio.
