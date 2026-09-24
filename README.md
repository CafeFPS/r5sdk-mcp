# R5SDK MCP Server

[Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI agent full control of a local R5 SDK Apex game: the dedicated server and the game client. It can move players, give items, switch legends, spawn things, change maps, run console commands and Squirrel on any VM, read logs, and take screenshots.

It talks to the SDK **agent link**: a loopback line socket built into `server.dll` and `client.dll`. RCON is not used.

## Requirements

- Windows (screenshots use PrintWindow through Windows PowerShell)
- Node.js 18+
- An SDK build that includes the agent link (protocol 2), plus the `agent/` scripts in `platform/scripts/vscripts`
- The dedicated server and/or client started with `-devsdk` (or `-agentlink [port]`)

## Setup

```bash
npm install
npm run build
claude mcp add r5sdk node <path-to>/r5sdk-mcp/dist/index.js -e R5_GAME_DIR=<your game folder>
```

| Variable | Default | Meaning |
|---|---|---|
| `R5_GAME_DIR` | working directory | Game install root (the folder holding `platform/`) |
| `R5_SERVER_LINK_PORT` | `37019` | Dedicated server link |
| `R5_CLIENT_LINK_PORT` | `37020` | Game client link |
| `R5_SERVER_TOKEN_FILE` | `<game>/platform/agentlink.token` | Override the server token path |
| `R5_CLIENT_TOKEN_FILE` | `<game>/platform/agentlink_client.token` | Override the client token path |
| `R5_CLIENT_PROCESS` | `r5apex` | Process whose window `screenshot` captures |

Each game launch writes a new random token; the MCP re-reads it on every connect, so restarting the game needs no MCP restart.

## Tools

| Area | Tools |
|---|---|
| Context | `guide`, `status` |
| Observe | `state`, `players`, `places`, `find_place`, `look_at`, `screenshot`, `events`, `wait_for_event`, `logs`, `latest_error`, `catalog` |
| Players | `teleport`, `give`, `take_weapons`, `set_legend`, `player` (health, shield, god, noclip, view), `life` (kill, respawn), `input` (hold forward/jump/attack/...) |
| World | `spawn` (dummy, bots, prop), `save_place`, `say`, `load_map` |
| Raw | `console` (server or client), `convar`, `script` (server, client or ui VM) |

Selectors used by many tools:

- **who**: `me` (first human), `all`, `humans`, `bots`, `#<playerIndex>`, or a player name
- **where / to**: a place name (`fragment`, `skyhook`), a player name, `crosshair`, or `x y z`

Place names come from the map's own zone table and spawn points, so "teleport me to fragment" works on any map that has named zones, with no coordinate lists to maintain. When the client link is up, localized names ("Fragment East") match too.

## Resources

- `r5://guide`: primer for agents (links, selectors, units, map changes)
- `r5://game/state`: live match state
- `r5://map/places`: named places on the current map
- `r5://api/server`: the server-side `Agent_*` script API

## Agent link protocol

One request per line, one reply line per request:

```
AGENTLINK 2 server|client           (greeting)
AUTH <token>                         -> OK | ERR ...
INFO <id>                            -> RESULT <id> ok {...}
EVAL <id> <server|client|ui> <code>  -> RESULT <id> ok|err {ran,error,reply,log,...}
CMD  <id> <console line>             -> RESULT <id> ok {ran,error,reply,log}
LOG  <id> <sinceSeq> [max]           -> RESULT <id> ok {lines,next}
```

`EVAL` and `CMD` return everything the request printed. A script returns structured data by calling `AgentLink_Reply( string )`; `Agent_Json( value )` encodes tables, arrays and vectors.

## Security

The links execute arbitrary code in the game. They bind to `127.0.0.1` only, need a per-launch token that only local processes can read, and are off unless the game is started with `-devsdk` or `-agentlink`. Never forward the ports.

## License

MIT
