# R5SDK MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) server for controlling an R5SDK game server via RCON. Enables AI assistants like Claude to manage a listen server — execute commands, manage players, load maps, inspect console output, and more.

## Requirements

- Node.js 18+
- An R5SDK game instance with RCON enabled

## Setup

```bash
npm install
npm run build
```

## Configuration

The server connects to RCON using environment variables:

| Variable | Default | Description |
|---|---|---|
| `R5_RCON_HOST` | `127.0.0.1` | RCON server address |
| `R5_RCON_PORT` | `37015` | RCON server port |
| `R5_RCON_PASSWORD` | *(empty)* | RCON password (auto-connects if set) |

## Claude Code Integration

```bash
claude mcp add r5sdk node C:/valk/r5sdk-mcp/dist/index.js -e R5_RCON_PASSWORD=your_password
```

Or add to your MCP settings manually:

```json
{
  "mcpServers": {
    "r5sdk": {
      "command": "node",
      "args": ["C:/valk/r5sdk-mcp/dist/index.js"],
      "env": {
        "R5_RCON_PASSWORD": "your_password"
      }
    }
  }
}
```

## Tools

| Category | Tools |
|---|---|
| Connection | `connect`, `disconnect` |
| Console | `exec`, `exec_script`, `get_console_log`, `clear_console_log` |
| Server | `start_server`, `change_level`, `stop_server`, `server_status` |
| ConVars | `get_convar`, `set_convar`, `find_convars` |
| Players | `list_players`, `kick_player`, `ban_player`, `unban_player` |
| Chat | `broadcast_message`, `send_message` |
| Playlists/Maps | `set_playlist`, `get_playlist`, `list_maps` |
| Assets | `load_pak`, `unload_pak`, `list_paks` |
| Debug | `debug_draw_box`, `debug_draw_sphere`, `clear_debug_overlays` |
| Visibility | `set_server_visibility` |
| Navigation | `nav_find_nearest` |
| Mods/Scripts | `reload_mods`, `reload_scripts` |

## Resources

- `r5://server/status` — Current server status as JSON
- `r5://console/log` — Recent console log output
- `r5://connection` — Connection state info

## Protocol

Implements the R5SDK RCON wire protocol directly (no protobufjs dependency):

- Frame format: `[4B magic 'RCon' BE][4B length BE][protobuf envelope]`
- Unencrypted mode only (`rcon_encryptframes 0`)
- Console log streaming via `SERVERDATA_REQUEST_SEND_CONSOLE_LOG`

## License

MIT
