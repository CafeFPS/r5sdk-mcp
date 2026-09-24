import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as path from "node:path";
import { AgentLink, LinkError, type ExecResult, type LogLine } from "./link.js";
import { captureGameWindow } from "./screenshot.js";
import { GUIDE } from "./guide.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

const GAME_DIR = env("R5_GAME_DIR", process.cwd());
const PLATFORM_DIR = path.join(GAME_DIR, "platform");

const serverLink = new AgentLink({
  role: "server",
  host: "127.0.0.1",
  port: Number(env("R5_SERVER_LINK_PORT", "37019")),
  tokenFile: env("R5_SERVER_TOKEN_FILE", path.join(PLATFORM_DIR, "agentlink.token")),
});

const clientLink = new AgentLink({
  role: "client",
  host: "127.0.0.1",
  port: Number(env("R5_CLIENT_LINK_PORT", "37020")),
  tokenFile: env("R5_CLIENT_TOKEN_FILE", path.join(PLATFORM_DIR, "agentlink_client.token")),
});

const CLIENT_PROCESS = env("R5_CLIENT_PROCESS", "r5apex");

function link(target: "server" | "client"): AgentLink {
  return target === "server" ? serverLink : clientLink;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function text(value: unknown) {
  const body = typeof value === "string" ? value : JSON.stringify(value, null, 1);
  return { content: [{ type: "text" as const, text: body }] };
}

function failure(value: unknown) {
  return { ...text(value), isError: true as const };
}

function asError(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return failure({ ok: false, error: message, hint: err instanceof LinkError ? "call the status tool for link details" : undefined });
}

// Squirrel string literal.
function sq(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ") + '"';
}

function sqVec(v: [number, number, number]): string {
  return `<${v.map((n) => Number(n).toFixed(3)).join(", ")}>`;
}

function sqAsset(p: string): string {
  if (!/^[\w\/.\-]+$/.test(p)) throw new Error(`bad asset path '${p}'`);
  return `$"${p}"`;
}

async function serverCall(code: string, timeoutMs?: number) {
  const r = await serverLink.call("server", code, timeoutMs);
  return r?.ok === false ? failure(r) : text(r);
}

function summarizeExec(r: ExecResult) {
  return {
    ok: r.ok && !r.error,
    ran: r.ran,
    error: r.error,
    reply: r.reply,
    message: r.message,
    output: r.log.map((l) => (l.level === "info" ? l.text : `[${l.level}] ${l.text}`)),
    outputDropped: r.logDropped || undefined,
  };
}

const whoSchema = z
  .string()
  .default("me")
  .describe('Player selector: "me" (first human), "all", "humans", "bots", "#<playerIndex>", or a player name');

// ---------------------------------------------------------------------------
// Place names: the server matches localization tokens; when the client link
// is up we also match the localized names the player actually reads.
// ---------------------------------------------------------------------------

interface Place {
  name: string;
  token: string;
  kind: string;
  origin: [number, number, number];
  tier?: number;
  displayName?: string;
}

const placeCache = new Map<string, Place[]>();

async function loadPlaces(): Promise<{ map: string; places: Place[] }> {
  const r = await serverLink.call("server", "Agent_Places()");
  if (!r.ok) throw new Error(r.error ?? "Agent_Places failed");
  const map: string = r.map;
  const places: Place[] = r.places;
  const cached = placeCache.get(map);
  if (cached && cached.length === places.length) return { map, places: cached };

  const tokens = places.map((p) => p.token).filter((t) => t.startsWith("#"));
  if (tokens.length && clientLink.isConnected()) {
    try {
      const loc = await clientLink.call("client", `AgentCl_Localize( [ ${tokens.map(sq).join(", ")} ] )`);
      if (loc.ok) for (const p of places) p.displayName = loc.names[p.token] ?? undefined;
    } catch {
      // Localized names are a bonus; tokens still match.
    }
  }
  placeCache.set(map, places);
  return { map, places };
}

function words(s: string): string[] {
  return s.toLowerCase().replace(/#/g, "").split(/[^a-z0-9]+/).filter(Boolean);
}

function scorePlace(p: Place, query: string[]): number {
  const hay = words(`${p.displayName ?? ""} ${p.name} ${p.token}`);
  let score = 0;
  for (const q of query) {
    let best = 0;
    for (const w of hay) {
      if (w === q) best = Math.max(best, 10);
      else if (w.startsWith(q)) best = Math.max(best, 6);
      else if (w.includes(q)) best = Math.max(best, 3);
    }
    if (!best) return 0;
    score += best;
  }
  const full = query.join(" ");
  if ((p.displayName ?? "").toLowerCase() === full || p.name === full) score += 20;
  return score;
}

function matchPlaces(places: Place[], query: string, n = 5) {
  const q = words(query);
  return places
    .map((p) => ({ p, score: scorePlace(p, q) }))
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((m) => ({ ...m.p, score: m.score }));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer(
  { name: "r5sdk", version: "2.0.0" },
  {
    instructions:
      "Full control of a local R5 SDK Apex game (dedicated server + client). Read the `guide` tool (or r5://guide) first; call `state` to see the map and players. Use typed tools (teleport, give, set_legend, spawn, ...) before raw `console`/`script`.",
  }
);

server.tool("guide", "How this game is organised and how to drive it: links, player/place selectors, units, map changes. Read once per session.", {}, async () => text(GUIDE));

server.tool(
  "status",
  "Connection state of the server and client links, with their protocol info. Use this when a tool reports a link error.",
  {},
  async () => {
    const out: Record<string, unknown> = { gameDir: GAME_DIR };
    for (const l of [serverLink, clientLink]) {
      try {
        out[l.config.role] = { connected: true, ...(await l.info()) };
      } catch (err) {
        out[l.config.role] = { connected: false, port: l.config.port, tokenFile: l.config.tokenFile, error: (err as Error).message };
      }
    }
    return text(out);
  }
);

// --- observe ---------------------------------------------------------------

server.tool(
  "state",
  "Snapshot of the match: map, playlist, game state, ring, and every player (origin, eye angles, health, shield, legend, weapons, zone). Includes the client's own view when the client link is up.",
  {},
  async () => {
    try {
      const s = await serverLink.call("server", "Agent_State()");
      if (clientLink.isConnected() || (await clientLink.ensure().then(() => true).catch(() => false))) {
        try {
          s.client = await clientLink.call("client", "AgentCl_State()");
        } catch (err) {
          s.client = { ok: false, error: (err as Error).message };
        }
      }
      return s.ok === false ? failure(s) : text(s);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool("players", "All players with position, health, shield, legend, weapons and zone.", {}, async () => {
  try {
    return await serverCall("Agent_Players()");
  } catch (err) {
    return asError(err);
  }
});

server.tool(
  "places",
  "Named places on the current map (zones, spawn points, saved places) with world origins. Localized display names are included when the client link is up.",
  { filter: z.string().optional().describe("Only places whose name contains this text") },
  async ({ filter }) => {
    try {
      const { map, places } = await loadPlaces();
      const f = (filter ?? "").toLowerCase();
      const list = f ? places.filter((p) => `${p.displayName ?? ""} ${p.name} ${p.token}`.toLowerCase().includes(f)) : places;
      return text({ ok: true, map, count: list.length, places: list });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "find_place",
  "Resolve a spoken place name (e.g. 'fragment', 'skyhook', 'the pit') to candidate locations on the current map, best first.",
  { query: z.string() },
  async ({ query }) => {
    try {
      const { map, places } = await loadPlaces();
      const matches = matchPlaces(places, query);
      return matches.length ? text({ ok: true, map, query, matches }) : failure({ ok: false, map, query, error: "no match", hint: "call places to list every place" });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "save_place",
  "Remember a player's current position under a name so teleport/spawn can use it (lives until the map changes).",
  { name: z.string(), who: whoSchema },
  async ({ name, who }) => {
    try {
      return await serverCall(`Agent_SavePlace( ${sq(name)}, ${sq(who)} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "look_at",
  "What a player's crosshair is on: hit position, distance, surface normal, entity (class, model, name) and zone.",
  { who: whoSchema, distance: z.number().optional() },
  async ({ who, distance }) => {
    try {
      return await serverCall(`Agent_Trace( ${sq(who)}, ${(distance ?? 20000).toFixed(1)} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "screenshot",
  "Capture the game client window as an image (works while the window is in the background, not while minimised).",
  {
    max_width: z.number().int().min(320).max(3840).optional().describe("Downscale to this width (default 1280)"),
    save_dir: z.string().optional().describe("Also keep the JPEG in this folder"),
  },
  async ({ max_width, save_dir }) => {
    try {
      const shot = await captureGameWindow(CLIENT_PROCESS, max_width ?? 1280, 80, save_dir);
      return {
        content: [
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
          { type: "text" as const, text: JSON.stringify({ width: shot.width, height: shot.height, source: [shot.sourceWidth, shot.sourceHeight], path: shot.path || undefined }) },
        ],
      };
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "events",
  "Game events since a cursor: kills, damage, connects, disconnects, respawns. Pass the returned `next` back as `since`.",
  { since: z.number().int().optional() },
  async ({ since }) => {
    try {
      return await serverCall(`Agent_Events( ${since ?? 0} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "wait_for_event",
  "Block until a game event matches (e.g. a kill by a player), or time out. Returns the matching events.",
  {
    kind: z.enum(["kill", "damage", "connect", "disconnect", "respawn", "any"]).default("any"),
    player: z.string().optional().describe("Only events naming this player (victim, attacker or player)"),
    timeout_s: z.number().min(1).max(300).default(30),
  },
  async ({ kind, player, timeout_s }) => {
    try {
      const start = await serverLink.call("server", "Agent_Events( 0 )");
      let cursor: number = start.next ?? 0;
      const deadline = Date.now() + timeout_s * 1000;
      const p = player?.toLowerCase();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 400));
        const r = await serverLink.call("server", `Agent_Events( ${cursor} )`);
        cursor = r.next ?? cursor;
        const hits = (r.events ?? []).filter(
          (e: any) =>
            (kind === "any" || e.kind === kind) &&
            (!p || [e.victim, e.attacker, e.player].some((n: string | undefined) => n?.toLowerCase().includes(p)))
        );
        if (hits.length) return text({ ok: true, events: hits, next: cursor });
      }
      return failure({ ok: false, error: `no ${kind} event within ${timeout_s}s`, next: cursor });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "logs",
  "Recent console output of the server or client, newest last. Pass the returned `next` back as `since` to follow the log.",
  {
    target: z.enum(["server", "client"]).default("server"),
    since: z.number().int().optional(),
    max: z.number().int().min(1).max(1000).default(200),
    level: z.enum(["all", "warn", "error"]).default("all"),
    contains: z.string().optional().describe("Only lines containing this text (case-insensitive)"),
  },
  async ({ target, since, max, level, contains }) => {
    try {
      const r = await link(target).logs(since ?? 0, max);
      const c = contains?.toLowerCase();
      const lines = r.lines.filter(
        (l: LogLine) =>
          (level === "all" || (level === "warn" ? l.level !== "info" : l.level === "error")) && (!c || l.text.toLowerCase().includes(c))
      );
      return text({ ok: true, target, next: r.next, lines: lines.map((l) => `${l.seq} ${l.level === "info" ? "" : `[${l.level}] `}${l.text}`) });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "latest_error",
  "The most recent error on the server or client with the lines leading up to it (script errors include their call stack).",
  { target: z.enum(["server", "client"]).default("server"), context: z.number().int().min(0).max(100).default(30) },
  async ({ target, context }) => {
    try {
      const r = await link(target).logs(0, 1000);
      let i = -1;
      for (let k = r.lines.length - 1; k >= 0; k--) {
        if (r.lines[k].level === "error") {
          i = k;
          break;
        }
      }
      if (i < 0) return text({ ok: true, target, error: null, note: "no error in the last 1000 lines" });
      let end = i;
      while (end + 1 < r.lines.length && end - i < 20 && r.lines[end + 1].level !== "info") end++;
      const lines = r.lines.slice(Math.max(0, i - context), end + 1);
      return text({ ok: true, target, lines: lines.map((l) => `${l.seq} ${l.level === "info" ? "" : `[${l.level}] `}${l.text}`) });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "catalog",
  "What exists in this build: legends, weapons (loot refs), all loot, or the current playlist and its maps.",
  { kind: z.enum(["legends", "weapons", "loot", "playlist"]) },
  async ({ kind }) => {
    try {
      return await serverCall(`Agent_Catalog( ${sq(kind)} )`, 30000);
    } catch (err) {
      return asError(err);
    }
  }
);

// --- act on players --------------------------------------------------------

server.tool(
  "teleport",
  "Move player(s) to a named place ('fragment'), another player, or coordinates 'x y z'. Finds floor the player fits on.",
  { who: whoSchema, to: z.string().describe("Place name, player name (or 'player:<name>'), or 'x y z'") },
  async ({ who, to }) => {
    try {
      const r = await serverLink.call("server", `Agent_Teleport( ${sq(who)}, ${sq(to)} )`);
      if (r.ok !== false || !String(r.error ?? "").startsWith("no place matches")) return r.ok === false ? failure(r) : text(r);

      // Fall back to localized names ("Skyhook") the server cannot read.
      const { places } = await loadPlaces();
      const matches = matchPlaces(places, to);
      if (!matches.length) return failure(r);
      const best = matches[0];
      const moved = await serverLink.call("server", `Agent_TeleportTo( ${sq(who)}, ${sqVec(best.origin)}, true )`);
      return moved.ok === false ? failure(moved) : text({ ...moved, to: best, alternatives: matches.slice(1) });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "give",
  "Give an item: a weapon (e.g. mp_weapon_r97) goes into a weapon slot, anything else (ammo, armor, heals, attachments) into the inventory. See catalog for refs.",
  { who: whoSchema, item: z.string(), count: z.number().int().min(1).max(999).default(1) },
  async ({ who, item, count }) => {
    try {
      return await serverCall(`Agent_Give( ${sq(who)}, ${sq(item)}, ${count} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool("take_weapons", "Remove both main weapons from player(s).", { who: whoSchema }, async ({ who }) => {
  try {
    return await serverCall(`Agent_TakeWeapons( ${sq(who)} )`);
  } catch (err) {
    return asError(err);
  }
});

server.tool(
  "set_legend",
  "Switch player(s) to a legend by name (e.g. 'wraith', 'character_bangalore').",
  { who: whoSchema, legend: z.string() },
  async ({ who, legend }) => {
    try {
      return await serverCall(`Agent_SetLegend( ${sq(who)}, ${sq(legend)} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "player",
  "Adjust player(s): health, shield, god mode, noclip, view angles. Only the fields you pass change.",
  {
    who: whoSchema,
    health: z.number().int().min(0).optional(),
    shield: z.number().int().min(0).optional(),
    god: z.boolean().optional(),
    noclip: z.boolean().optional(),
    pitch: z.number().optional().describe("View pitch in degrees (down is positive); needs yaw too"),
    yaw: z.number().optional().describe("View yaw in degrees"),
  },
  async ({ who, health, shield, god, noclip, pitch, yaw }) => {
    try {
      const results: Record<string, unknown> = {};
      const w = sq(who);
      if (health !== undefined || shield !== undefined)
        results.health = await serverLink.call("server", `Agent_SetHealth( ${w}, ${health ?? -1}, ${shield ?? -1} )`);
      if (god !== undefined) results.god = await serverLink.call("server", `Agent_God( ${w}, ${god} )`);
      if (noclip !== undefined) results.noclip = await serverLink.call("server", `Agent_Noclip( ${w}, ${noclip} )`);
      if (yaw !== undefined) results.look = await serverLink.call("server", `Agent_Look( ${w}, ${sqVec([pitch ?? 0, yaw, 0])} )`);
      if (!Object.keys(results).length) return failure({ ok: false, error: "nothing to change" });
      const bad = Object.values(results).some((r: any) => r?.ok === false);
      return bad ? failure(results) : text({ ok: true, ...results });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "life",
  "Kill or respawn player(s).",
  { who: whoSchema, action: z.enum(["kill", "respawn"]) },
  async ({ who, action }) => {
    try {
      return await serverCall(action === "kill" ? `Agent_Kill( ${sq(who)} )` : `Agent_Respawn( ${sq(who)} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "spawn",
  "Spawn things: 'dummy' (combat dummies), 'bots' (fake players), or 'prop' (a model, e.g. mdl/barriers/concrete/concrete_barrier_01.rmdl).",
  {
    kind: z.enum(["dummy", "bots", "prop"]),
    where: z.string().default("crosshair").describe("'crosshair', a place, a player name, or 'x y z' (not used for bots)"),
    count: z.number().int().min(1).max(32).default(1),
    shield_level: z.number().int().min(0).max(5).default(0).describe("dummy only"),
    model: z.string().optional().describe("prop only: model path"),
    yaw: z.number().default(0).describe("prop only"),
  },
  async ({ kind, where, count, shield_level, model, yaw }) => {
    try {
      if (kind === "bots") return await serverCall(`Agent_SpawnBots( ${count} )`);
      if (kind === "dummy") return await serverCall(`Agent_SpawnDummy( ${sq(where)}, ${count}, ${shield_level} )`);
      if (!model) return failure({ ok: false, error: "prop needs model" });
      return await serverCall(`Agent_SpawnProp( ${sqAsset(model)}, ${sq(where)}, ${sqVec([0, yaw, 0])} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "say",
  "Show a message on screen for player(s).",
  { text: z.string(), who: whoSchema.default("all") },
  async ({ text: msg, who }) => {
    try {
      return await serverCall(`Agent_Say( ${sq(msg)}, ${sq(who)} )`);
    } catch (err) {
      return asError(err);
    }
  }
);

const INPUT_ACTIONS = ["forward", "back", "moveleft", "moveright", "jump", "duck", "attack", "zoom", "reload", "use", "speed", "melee", "offhand1", "offhand4"] as const;

server.tool(
  "input",
  "Hold a player input on the game client for a duration (e.g. forward for 1500 ms, attack for 300 ms). 'speed' is sprint, 'offhand1' the tactical, 'offhand4' the ultimate.",
  {
    action: z.enum(INPUT_ACTIONS),
    ms: z.number().int().min(16).max(30000).default(200),
  },
  async ({ action, ms }) => {
    try {
      await clientLink.command(`+${action}`);
      await new Promise((r) => setTimeout(r, ms));
      await clientLink.command(`-${action}`);
      return text({ ok: true, action, ms });
    } catch (err) {
      try {
        await clientLink.command(`-${action}`);
      } catch {
        // Release is best effort once the link is gone.
      }
      return asError(err);
    }
  }
);

// --- world and raw access -------------------------------------------------

server.tool(
  "load_map",
  "Change the map on the dedicated server (the client follows). Optionally switch playlist first.",
  { map: z.string().regex(/^[A-Za-z0-9_]{3,63}$/), playlist: z.string().regex(/^[A-Za-z0-9_]{1,63}$/).optional() },
  async ({ map, playlist }) => {
    try {
      placeCache.clear();
      const out: Record<string, unknown> = {};
      if (playlist) out.playlist = summarizeExec(await serverLink.command(`sv_playlist ${playlist}`));
      let loaded = false;
      try {
        const s = await serverLink.call("server", "Agent_State()", 5000);
        loaded = s.ok !== false && !!s.map;
      } catch {
        loaded = false;
      }
      out.command = loaded ? "changelevel" : "map";
      out.result = summarizeExec(await serverLink.command(`${out.command} ${map}`));
      out.note = "the server VM is rebuilt during the load; call state again in a few seconds";
      return text({ ok: true, ...out });
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "console",
  "Run console command(s) on the server or client and return what they printed. Separate several with ';'.",
  { command: z.string(), target: z.enum(["server", "client"]).default("server") },
  async ({ command, target }) => {
    try {
      const r = summarizeExec(await link(target).command(command));
      return r.ok ? text(r) : failure(r);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "convar",
  "Read a convar, or set it when value is given. Server convars (sv_, mp_, host_) on target=server; client ones (cl_, r_, mat_, bindings) on target=client.",
  { name: z.string().regex(/^[A-Za-z0-9_.]+$/), value: z.string().optional(), target: z.enum(["server", "client"]).default("server") },
  async ({ name, value, target }) => {
    try {
      const cmd = value === undefined ? name : `${name} ${value.includes(" ") ? sq(value) : value}`;
      const r = summarizeExec(await link(target).command(cmd));
      return r.ok ? text(r) : failure(r);
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "script",
  "Run Squirrel on the server, client or ui VM. Return data with AgentLink_Reply( Agent_Json( value ) ); printed output and script errors come back in `output`. Agent_Help() lists the server API.",
  { code: z.string(), vm: z.enum(["server", "client", "ui"]).default("server") },
  async ({ code, vm }) => {
    try {
      const r = summarizeExec(await link(vm === "server" ? "server" : "client").evalScript(vm, code));
      let parsed: unknown = undefined;
      if (r.reply) {
        try {
          parsed = JSON.parse(r.reply);
        } catch {
          parsed = undefined;
        }
      }
      const out = { ...r, reply: parsed ?? r.reply };
      return r.ok ? text(out) : failure(out);
    } catch (err) {
      return asError(err);
    }
  }
);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

server.resource("guide", "r5://guide", async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: GUIDE }] }));

server.resource("game_state", "r5://game/state", async (uri) => {
  let body: unknown;
  try {
    body = await serverLink.call("server", "Agent_State()");
  } catch (err) {
    body = { ok: false, error: (err as Error).message };
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 1) }] };
});

server.resource("map_places", "r5://map/places", async (uri) => {
  let body: unknown;
  try {
    body = await loadPlaces();
  } catch (err) {
    body = { ok: false, error: (err as Error).message };
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 1) }] };
});

server.resource("server_api", "r5://api/server", async (uri) => {
  let body: unknown;
  try {
    body = await serverLink.call("server", "Agent_Help()");
  } catch (err) {
    body = { ok: false, error: (err as Error).message };
  }
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(body, null, 1) }] };
});

// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[r5sdk-mcp] ready (game dir ${GAME_DIR}; links connect on first use)\n`);
}

main().catch((err) => {
  process.stderr.write(`[r5sdk-mcp] fatal: ${err}\n`);
  process.exit(1);
});
