import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { RconClient } from "./rcon.js";
import { parseStatus, parseConVar, parseCvarList } from "./parsers.js";

// --- Configuration ---

const RCON_HOST = process.env.R5_RCON_HOST ?? "127.0.0.1";
const RCON_PORT = parseInt(process.env.R5_RCON_PORT ?? "37015", 10);
const RCON_PASSWORD = process.env.R5_RCON_PASSWORD ?? "";

// --- RCON client singleton ---

const rcon = new RconClient({
  host: RCON_HOST,
  port: RCON_PORT,
  password: RCON_PASSWORD,
});

rcon.on("error", (err: Error) => {
  process.stderr.write(`[r5sdk-mcp] RCON error: ${err.message}\n`);
});

rcon.on("disconnected", () => {
  process.stderr.write("[r5sdk-mcp] RCON disconnected, will reconnect...\n");
});

// --- MCP Server ---

const server = new McpServer({
  name: "r5sdk",
  version: "1.0.0",
});

// ============================================================
// TOOLS
// ============================================================

// --- Connection management ---

server.tool(
  "connect",
  "Connect to the R5SDK RCON server. Uses env vars R5_RCON_HOST, R5_RCON_PORT, R5_RCON_PASSWORD by default.",
  {
    host: z.string().optional().describe("RCON host (default: 127.0.0.1)"),
    port: z.number().optional().describe("RCON port (default: 37015)"),
    password: z.string().optional().describe("RCON password"),
  },
  async ({ host, port, password }) => {
    if (host) (rcon as any).config.host = host;
    if (port) (rcon as any).config.port = port;
    if (password) (rcon as any).config.password = password;

    try {
      await rcon.connect();
      return { content: [{ type: "text", text: `Connected to ${(rcon as any).config.host}:${(rcon as any).config.port}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Connection failed: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "disconnect",
  "Disconnect from the RCON server.",
  {},
  async () => {
    rcon.disconnect();
    return { content: [{ type: "text", text: "Disconnected" }] };
  }
);

// --- Console command execution ---

server.tool(
  "exec",
  "Execute a console command on the game server and return its output.",
  {
    command: z.string().describe("Console command to execute (e.g. 'status', 'map mp_rr_canyonlands_staging')"),
    timeout: z.number().optional().describe("Response collection timeout in ms (default: 2000)"),
  },
  async ({ command, timeout }) => {
    try {
      const output = await rcon.exec(command, timeout ?? 2000);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "exec_script",
  "Execute VScript code on a specific VM (server, client, or ui).",
  {
    vm: z.enum(["server", "client", "ui"]).describe("Which script VM to target"),
    code: z.string().describe("VScript code to execute"),
  },
  async ({ vm, code }) => {
    const cmdMap = { server: "script", client: "script_client", ui: "script_ui" };
    const cmd = `${cmdMap[vm]} ${code}`;
    try {
      const output = await rcon.exec(cmd, 3000);
      return { content: [{ type: "text", text: output || "(no output)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Console log ---

server.tool(
  "get_console_log",
  "Get recent console log output from the game.",
  {
    lines: z.number().optional().describe("Number of recent lines to return (default: 100, max: 5000)"),
  },
  async ({ lines }) => {
    const count = Math.min(lines ?? 100, 5000);
    const logLines = rcon.getRecentLog(count);
    return { content: [{ type: "text", text: logLines.join("") || "(no log data)" }] };
  }
);

server.tool(
  "clear_console_log",
  "Clear the captured console log buffer.",
  {},
  async () => {
    rcon.clearLog();
    return { content: [{ type: "text", text: "Console log buffer cleared" }] };
  }
);

// --- Server lifecycle ---

server.tool(
  "start_server",
  "Start a listen server on the specified map and playlist.",
  {
    map: z.string().describe("Map name (e.g. 'mp_rr_canyonlands_staging', 'mp_rr_desertlands_64k_x_64k')"),
    playlist: z.string().optional().describe("Playlist/gamemode (e.g. 'survival', 'firingrange', 'custom_tdm')"),
  },
  async ({ map, playlist }) => {
    try {
      if (playlist) {
        await rcon.exec(`sv_playlist ${playlist}`, 1000);
      }
      const output = await rcon.exec(`map ${map}`, 5000);
      return { content: [{ type: "text", text: output || `Loading map: ${map}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "change_level",
  "Change the current map on the running server.",
  {
    map: z.string().describe("Map name to change to"),
  },
  async ({ map }) => {
    try {
      const output = await rcon.exec(`changelevel ${map}`, 5000);
      return { content: [{ type: "text", text: output || `Changing level to: ${map}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "stop_server",
  "Stop the current server and disconnect all players.",
  {},
  async () => {
    try {
      const output = await rcon.exec("disconnect", 2000);
      return { content: [{ type: "text", text: output || "Server stopped" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "server_status",
  "Get the current server status including map, players, and performance.",
  {},
  async () => {
    try {
      const output = await rcon.exec("status", 2000);
      const status = parseStatus(output);
      return {
        content: [{
          type: "text",
          text: JSON.stringify(status, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- ConVar management ---

server.tool(
  "get_convar",
  "Get the current value of a console variable.",
  {
    name: z.string().describe("ConVar name"),
  },
  async ({ name }) => {
    try {
      const output = await rcon.exec(name, 1500);
      const info = parseConVar(output);
      if (info) {
        return { content: [{ type: "text", text: JSON.stringify(info, null, 2) }] };
      }
      return { content: [{ type: "text", text: output || `(no output for '${name}')` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "set_convar",
  "Set a console variable to a new value.",
  {
    name: z.string().describe("ConVar name"),
    value: z.string().describe("New value"),
  },
  async ({ name, value }) => {
    try {
      const output = await rcon.exec(`${name} ${value}`, 1500);
      return { content: [{ type: "text", text: output || `Set ${name} = ${value}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "find_convars",
  "Search for console variables matching a pattern.",
  {
    pattern: z.string().describe("Search pattern"),
  },
  async ({ pattern }) => {
    try {
      const output = await rcon.exec(`cvarlist ${pattern}`, 3000);
      const names = parseCvarList(output);
      return { content: [{ type: "text", text: names.length > 0 ? names.join("\n") : output }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Player management ---

server.tool(
  "list_players",
  "List all connected players with details.",
  {},
  async () => {
    try {
      const output = await rcon.exec("status", 2000);
      const status = parseStatus(output);
      if (status.playerList.length === 0) {
        return { content: [{ type: "text", text: `No players connected (${status.players}/${status.maxPlayers})` }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(status.playerList, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "kick_player",
  "Kick a player from the server.",
  {
    target: z.string().describe("Player name or user ID"),
    reason: z.string().optional().describe("Kick reason"),
    byId: z.boolean().optional().describe("If true, treat target as a user ID"),
  },
  async ({ target, reason, byId }) => {
    const cmd = byId ? "kickid" : "kick";
    const reasonStr = reason ? ` "${reason}"` : "";
    try {
      const output = await rcon.exec(`${cmd} "${target}"${reasonStr}`, 2000);
      return { content: [{ type: "text", text: output || `Kicked: ${target}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "ban_player",
  "Ban a player from the server.",
  {
    target: z.string().describe("Player name or user ID"),
    byId: z.boolean().optional().describe("If true, treat target as a user ID"),
  },
  async ({ target, byId }) => {
    const cmd = byId ? "banid" : "ban";
    try {
      const output = await rcon.exec(`${cmd} "${target}"`, 2000);
      return { content: [{ type: "text", text: output || `Banned: ${target}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "unban_player",
  "Unban a player.",
  {
    target: z.string().describe("IP address or Steam ID to unban"),
  },
  async ({ target }) => {
    try {
      const output = await rcon.exec(`unban "${target}"`, 2000);
      return { content: [{ type: "text", text: output || `Unbanned: ${target}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Chat ---

server.tool(
  "broadcast_message",
  "Broadcast a chat message to all players (via VScript).",
  {
    message: z.string().describe("Message text"),
  },
  async ({ message }) => {
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      const output = await rcon.exec(
        `script BroadcastServerTextMessage("${escaped}")`,
        2000
      );
      return { content: [{ type: "text", text: output || `Broadcast: ${message}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "send_message",
  "Send a chat message to a specific player by index (via VScript).",
  {
    playerIndex: z.number().describe("Player entity index"),
    message: z.string().describe("Message text"),
  },
  async ({ playerIndex, message }) => {
    const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    try {
      const output = await rcon.exec(
        `script SendServerTextMessage(GetPlayerByIndex(${playerIndex}), "${escaped}")`,
        2000
      );
      return { content: [{ type: "text", text: output || `Sent to player ${playerIndex}: ${message}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Playlist and maps ---

server.tool(
  "set_playlist",
  "Set the active playlist/gamemode.",
  {
    playlist: z.string().describe("Playlist name (e.g. 'survival', 'firingrange', 'custom_tdm')"),
  },
  async ({ playlist }) => {
    try {
      const output = await rcon.exec(`sv_playlist ${playlist}`, 1500);
      return { content: [{ type: "text", text: output || `Playlist set to: ${playlist}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "get_playlist",
  "Get the current active playlist.",
  {},
  async () => {
    try {
      const output = await rcon.exec("sv_playlist", 1500);
      return { content: [{ type: "text", text: output || "(no playlist set)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_maps",
  "List available maps.",
  {},
  async () => {
    try {
      const output = await rcon.exec("maps *", 3000);
      return { content: [{ type: "text", text: output || "(no maps listed)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Pak/Asset management ---

server.tool(
  "load_pak",
  "Load a pak file asynchronously.",
  {
    pakName: z.string().describe("Pak file path (e.g. 'common.rpak')"),
  },
  async ({ pakName }) => {
    try {
      const output = await rcon.exec(`pak_requestload ${pakName}`, 5000);
      return { content: [{ type: "text", text: output || `Requested load: ${pakName}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "unload_pak",
  "Unload a pak file by its handle.",
  {
    handle: z.string().describe("Pak handle ID"),
  },
  async ({ handle }) => {
    try {
      const output = await rcon.exec(`pak_requestunload ${handle}`, 3000);
      return { content: [{ type: "text", text: output || `Requested unload: ${handle}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "list_paks",
  "List all currently loaded pak files.",
  {},
  async () => {
    try {
      const output = await rcon.exec("pak_listpaks", 3000);
      return { content: [{ type: "text", text: output || "(no paks loaded)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Debug overlays ---

server.tool(
  "debug_draw_box",
  "Draw a debug box at a position in 3D space (via VScript).",
  {
    x: z.number().describe("Origin X"),
    y: z.number().describe("Origin Y"),
    z: z.number().describe("Origin Z"),
    minSize: z.number().optional().describe("Box min extent (default: -16)"),
    maxSize: z.number().optional().describe("Box max extent (default: 16)"),
    r: z.number().optional().describe("Red 0-255 (default: 255)"),
    g: z.number().optional().describe("Green 0-255 (default: 0)"),
    b: z.number().optional().describe("Blue 0-255 (default: 0)"),
    duration: z.number().optional().describe("Duration in seconds (default: 10)"),
  },
  async (params) => {
    const min = params.minSize ?? -16;
    const max = params.maxSize ?? 16;
    const r = params.r ?? 255;
    const g = params.g ?? 0;
    const b = params.b ?? 0;
    const dur = params.duration ?? 10;
    try {
      const output = await rcon.exec(
        `script DebugDrawBox(<${params.x}, ${params.y}, ${params.z}>, <${min}, ${min}, ${min}>, <${max}, ${max}, ${max}>, ${r}, ${g}, ${b}, 128, ${dur})`,
        2000
      );
      return { content: [{ type: "text", text: output || "Box drawn" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "debug_draw_sphere",
  "Draw a debug sphere at a position in 3D space (via VScript).",
  {
    x: z.number().describe("Origin X"),
    y: z.number().describe("Origin Y"),
    z: z.number().describe("Origin Z"),
    radius: z.number().optional().describe("Sphere radius (default: 32)"),
    r: z.number().optional().describe("Red 0-255 (default: 0)"),
    g: z.number().optional().describe("Green 0-255 (default: 255)"),
    b: z.number().optional().describe("Blue 0-255 (default: 0)"),
    duration: z.number().optional().describe("Duration in seconds (default: 10)"),
  },
  async (params) => {
    const radius = params.radius ?? 32;
    const r = params.r ?? 0;
    const g = params.g ?? 255;
    const b = params.b ?? 0;
    const dur = params.duration ?? 10;
    try {
      const output = await rcon.exec(
        `script DebugDrawSphere(<${params.x}, ${params.y}, ${params.z}>, ${radius}, ${r}, ${g}, ${b}, 128, ${dur})`,
        2000
      );
      return { content: [{ type: "text", text: output || "Sphere drawn" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

server.tool(
  "clear_debug_overlays",
  "Clear all debug overlay drawings.",
  {},
  async () => {
    try {
      const output = await rcon.exec("clear_debug_overlays", 1500);
      return { content: [{ type: "text", text: output || "Overlays cleared" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Server visibility (pylon/master server) ---

server.tool(
  "set_server_visibility",
  "Set the server's visibility on the master server.",
  {
    visibility: z.enum(["offline", "hidden", "public"]).describe("Server visibility level"),
  },
  async ({ visibility }) => {
    const values = { offline: "0", hidden: "1", public: "2" };
    try {
      const output = await rcon.exec(
        `pylon_host_visibility ${values[visibility]}`,
        1500
      );
      return { content: [{ type: "text", text: output || `Visibility set to: ${visibility}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- AI / Navigation (server-side VScript) ---

server.tool(
  "nav_find_nearest",
  "Find the nearest valid navmesh position to a point (via VScript).",
  {
    x: z.number().describe("Position X"),
    y: z.number().describe("Position Y"),
    z: z.number().describe("Position Z"),
    hull: z.number().optional().describe("Hull type index (default: 0 = small)"),
  },
  async (params) => {
    const hull = params.hull ?? 0;
    try {
      const output = await rcon.exec(
        `script printl(NavMesh_FindNearest(<${params.x}, ${params.y}, ${params.z}>, ${hull}))`,
        2000
      );
      return { content: [{ type: "text", text: output || "(no result)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Mod management ---

server.tool(
  "reload_mods",
  "Reload mod configurations.",
  {},
  async () => {
    try {
      const output = await rcon.exec("reload_mods", 3000);
      return { content: [{ type: "text", text: output || "Mods reloaded" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// --- Auto-reload / Hot reload support ---

server.tool(
  "reload_scripts",
  "Trigger a VScript auto-reload (recompile and reload all scripts).",
  {},
  async () => {
    try {
      const output = await rcon.exec("script_auto_reload 1", 2000);
      return { content: [{ type: "text", text: output || "Script auto-reload enabled" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true };
    }
  }
);

// ============================================================
// RESOURCES
// ============================================================

server.resource(
  "server_status",
  "r5://server/status",
  async (uri) => {
    try {
      const output = await rcon.exec("status", 2000);
      const status = parseStatus(output);
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(status, null, 2),
        }],
      };
    } catch {
      return {
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ error: "Not connected" }),
        }],
      };
    }
  }
);

server.resource(
  "console_log",
  "r5://console/log",
  async (uri) => {
    const lines = rcon.getRecentLog(500);
    return {
      contents: [{
        uri: uri.href,
        mimeType: "text/plain",
        text: lines.join("") || "(empty log)",
      }],
    };
  }
);

server.resource(
  "connection_info",
  "r5://connection",
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({
          connected: rcon.isConnected(),
          host: (rcon as any).config.host,
          port: (rcon as any).config.port,
        }, null, 2),
      }],
    };
  }
);

// ============================================================
// Entrypoint
// ============================================================

async function main() {
  // Auto-connect if password is provided
  if (RCON_PASSWORD) {
    try {
      await rcon.connect();
      process.stderr.write(
        `[r5sdk-mcp] Connected to ${RCON_HOST}:${RCON_PORT}\n`
      );
    } catch (err) {
      process.stderr.write(
        `[r5sdk-mcp] Auto-connect failed: ${(err as Error).message}\n`
      );
      process.stderr.write(
        "[r5sdk-mcp] Use the 'connect' tool to connect manually.\n"
      );
    }
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[r5sdk-mcp] MCP server started on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`[r5sdk-mcp] Fatal: ${err}\n`);
  process.exit(1);
});
