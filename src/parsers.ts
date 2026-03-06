// Parsers for R5SDK console command output.

export interface PlayerInfo {
  index: number;
  name: string;
  steamId: string;
  address: string;
  ping: number;
  connected: string;
  state: string;
}

export interface ServerStatus {
  hostname: string;
  version: string;
  map: string;
  playlist: string;
  players: number;
  maxPlayers: number;
  cpuUsage: string;
  uptime: string;
  playerList: PlayerInfo[];
}

// Parse the output of the 'status' command.
export function parseStatus(output: string): ServerStatus {
  const status: ServerStatus = {
    hostname: "",
    version: "",
    map: "",
    playlist: "",
    players: 0,
    maxPlayers: 0,
    cpuUsage: "",
    uptime: "",
    playerList: [],
  };

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    const hostMatch = trimmed.match(/^hostname:\s*(.+)/i);
    if (hostMatch) {
      status.hostname = hostMatch[1].trim();
      continue;
    }

    const versionMatch = trimmed.match(/^version\s*:\s*(.+)/i);
    if (versionMatch) {
      status.version = versionMatch[1].trim();
      continue;
    }

    const mapMatch = trimmed.match(/^map\s*:\s*(\S+)/i);
    if (mapMatch) {
      status.map = mapMatch[1];
      continue;
    }

    const playlistMatch = trimmed.match(/^playlist\s*:\s*(\S+)/i);
    if (playlistMatch) {
      status.playlist = playlistMatch[1];
      continue;
    }

    const playerCountMatch = trimmed.match(
      /^players\s*:\s*(\d+)\s*.*?\/\s*(\d+)/i
    );
    if (playerCountMatch) {
      status.players = parseInt(playerCountMatch[1]);
      status.maxPlayers = parseInt(playerCountMatch[2]);
      continue;
    }

    const cpuMatch = trimmed.match(/^cpu\s*:\s*(.+)/i);
    if (cpuMatch) {
      status.cpuUsage = cpuMatch[1].trim();
      continue;
    }

    // Player line: # index "name" steamid address ping connected state
    const playerMatch = trimmed.match(
      /^#\s*(\d+)\s+"([^"]+)"\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)/
    );
    if (playerMatch) {
      status.playerList.push({
        index: parseInt(playerMatch[1]),
        name: playerMatch[2],
        steamId: playerMatch[3],
        address: playerMatch[4],
        ping: parseInt(playerMatch[5]),
        connected: playerMatch[6],
        state: playerMatch[7],
      });
    }
  }

  return status;
}

export interface ConVarInfo {
  name: string;
  value: string;
  defaultValue: string;
  flags: string;
  helpString: string;
}

// Parse the output of a single convar query (typing the name in console).
export function parseConVar(output: string): ConVarInfo | null {
  const lines = output.split("\n");

  for (const line of lines) {
    // Format: "varname" = "value" ( def. "default" )
    const match = line.match(
      /"([^"]+)"\s*=\s*"([^"]*)"(?:\s*\(\s*def\.\s*"([^"]*)"\s*\))?/
    );
    if (match) {
      const info: ConVarInfo = {
        name: match[1],
        value: match[2],
        defaultValue: match[3] ?? match[2],
        flags: "",
        helpString: "",
      };

      // Next lines may contain flags and help text
      const idx = lines.indexOf(line);
      for (let i = idx + 1; i < lines.length && i < idx + 4; i++) {
        const fl = lines[i].trim();
        if (fl.startsWith("-")) {
          info.helpString = fl.substring(1).trim();
        } else if (fl.includes("replicated") || fl.includes("cheat") || fl.includes("release")) {
          info.flags = fl.trim();
        }
      }

      return info;
    }
  }

  return null;
}

// Parse cvarlist output into an array of convar names.
export function parseCvarList(output: string): string[] {
  const names: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    // cvarlist output lines start with the convar name followed by spaces
    // and flags. Skip header/footer lines.
    if (
      trimmed.startsWith("-") ||
      trimmed.startsWith("total") ||
      !trimmed ||
      trimmed.includes("cvarlist")
    ) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length >= 1 && parts[0].length > 0) {
      names.push(parts[0]);
    }
  }

  return names;
}
