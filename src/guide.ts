// Primer served as r5://guide and returned by the `guide` tool, so an agent in
// any harness has the context it needs before touching the game.

export const GUIDE = `# R5 game control primer

You are driving a live Apex Legends (R5 SDK) game: a dedicated server and a
game client on this machine. Everything below is reachable through the tools.

## Two processes, two links
- server link (dedicated server, default 127.0.0.1:37019): gameplay authority.
  Players, teleports, weapons, legends, health, NPCs, props, map changes,
  server convars and the SERVER script VM all live here.
- client link (game client, default 127.0.0.1:37020): what the player sees.
  Client console (binds, input, cl_ convars, video settings), CLIENT and UI
  script VMs, localized names, and the window for screenshots.
- Each process opens its link only when launched with -devsdk (or -agentlink).
  The link writes a fresh token to platform/agentlink.token (server) and
  platform/agentlink_client.token (client) on every launch.

## Who and where
- "who" arguments: "me" (the first human player), "all", "humans", "bots",
  "#<playerIndex>", or a player name (exact match first, then substring).
- "where"/"to" arguments: a place name ("fragment", "skyhook"), a player name,
  "crosshair" (where "me" is looking), or coordinates "x y z".
- Places come from the map's own zone table, its forced-spawn points and any
  place saved with save_place. They are per map: call places after a map
  change. find_place shows the best matches with scores and alternatives.
- Place names are derived from localization tokens such as
  #DES_ZONE_6_FRAGMENT_WEST. When the client link is up, localized display
  names ("Fragment West") are matched too.

## Units and axes
- Source units (1 unit ~ 1 inch, a player is 72 units tall). Z is up.
- Angles are <pitch, yaw, roll> in degrees; pitch down is positive.

## Reading the game
- state: map, playlist, game state, every player (origin, health, shield,
  legend, weapons, zone), ring, event cursor.
- look_at: what a player's crosshair hits.
- screenshot: the client window as an image.
- logs / latest_error: console output of either process, including script
  errors. Every console and script tool already returns what it printed.
- events: kills, damage, connects, respawns since a cursor; wait_for_event
  blocks until one matches.

## Acting
- Prefer the typed tools (teleport, give, set_legend, player, spawn, ...).
- console runs any console command on either process and returns its output.
- script runs Squirrel on the server, client or ui VM. To return data from a
  script, call AgentLink_Reply( string ) with JSON; Agent_Json( value ) encodes
  tables/arrays/vectors. Agent_Help() lists the server API.
- Many server commands need sv_cheats 1 (noclip, host_timescale, give).
  The typed tools do not.

## Map changes
- load_map changes the level on the server; the client follows on its own.
  Both links survive a map change, but the SERVER script VM does not exist
  until the new map finishes loading: retry state after a few seconds.

## Safety
- The links are full remote code execution on this machine's game, bound to
  127.0.0.1 only and gated by a per-launch token. Never expose the ports.
`;
