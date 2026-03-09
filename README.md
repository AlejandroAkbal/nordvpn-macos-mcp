# nordvpn-mcp

Local stdio MCP server that exposes a thin tool layer around the local NordVPN CLI project at `/Users/lume/Projects/nordvpn-operator`.

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
node dist/index.js
```

OpenCode should launch this server through `~/.config/opencode/opencode.json` using stdio.
