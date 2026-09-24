// Client for the SDK agent link: a loopback line protocol served by the
// dedicated server (server.dll) and by the game client (client.dll).
//
//   AUTH <token>                          -> OK | ERR ...
//   INFO <id>                             -> RESULT <id> ok {...}
//   EVAL <id> <server|client|ui> <code>   -> RESULT <id> ok|err {ran,error,reply,log,...}
//   EVAL64 <id> <server|client|ui> <b64>  (same; the code keeps its newlines)
//   CMD  <id> <console line>              -> RESULT <id> ok {ran,error,reply,log}
//   LOG  <id> <sinceSeq> [max]            -> RESULT <id> ok {lines,next}
//
// The token is rewritten on every game launch, so it is re-read on every
// connect.

import * as net from "node:net";
import * as fs from "node:fs";

export type LinkRole = "server" | "client";

export interface LinkConfig {
  role: LinkRole;
  host: string;
  port: number;
  tokenFile: string;
}

export interface LogLine {
  seq?: number;
  level: "info" | "warn" | "error";
  source: string;
  text: string;
}

export interface ExecResult {
  ok: boolean;
  ran: boolean;
  error: boolean;
  reply: string | null;
  log: LogLine[];
  logDropped: number;
  message?: string;
}

interface Pending {
  resolve: (v: { ok: boolean; payload: any }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const CONNECT_TIMEOUT_MS = 3000;
// The game refuses longer lines.
const MAX_LINE = 65536;

export class LinkError extends Error {}

export class AgentLink {
  readonly config: LinkConfig;
  private socket: net.Socket | null = null;
  private buffer = "";
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private connecting: Promise<void> | null = null;
  private lineWaiters: ((line: string) => void)[] = [];
  private greeting = "";

  constructor(config: LinkConfig) {
    this.config = config;
  }

  isConnected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  describe(): string {
    return `${this.config.role} link 127.0.0.1:${this.config.port}`;
  }

  async ensure(): Promise<void> {
    if (this.isConnected()) return;
    if (!this.connecting) {
      this.connecting = this.open().finally(() => {
        this.connecting = null;
      });
    }
    return this.connecting;
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }

  private readToken(): string {
    let token: string;
    try {
      token = fs.readFileSync(this.config.tokenFile, "utf8").trim();
    } catch {
      throw new LinkError(
        `${this.describe()}: no token at ${this.config.tokenFile}. ` +
          (this.config.role === "server"
            ? "Start the dedicated server with -devsdk (or -agentlink)."
            : "Start the game client with -devsdk (or -agentlink).")
      );
    }
    if (!/^[0-9a-f]{64}$/.test(token)) throw new LinkError(`${this.config.tokenFile} does not hold a link token`);
    return token;
  }

  private async open(): Promise<void> {
    const token = this.readToken();
    const sock = new net.Socket();
    sock.setNoDelay(true);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new LinkError(`${this.describe()}: connect timed out`));
      }, CONNECT_TIMEOUT_MS);
      sock.once("error", (err) => {
        clearTimeout(timer);
        reject(
          new LinkError(
            `${this.describe()}: ${err.message}. Is the ${this.config.role === "server" ? "dedicated server" : "game client"} running with -devsdk?`
          )
        );
      });
      sock.connect(this.config.port, this.config.host, () => {
        clearTimeout(timer);
        resolve();
      });
    });

    sock.removeAllListeners("error");
    this.socket = sock;
    this.buffer = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", () => this.drop("socket error"));
    sock.on("close", () => this.drop("link closed"));

    this.greeting = await this.nextLine();
    if (!this.greeting.startsWith("AGENTLINK ")) {
      this.close();
      throw new LinkError(`${this.describe()}: unexpected greeting '${this.greeting}'`);
    }
    if (!this.greeting.startsWith("AGENTLINK 2")) {
      this.close();
      throw new LinkError(`${this.describe()}: game speaks '${this.greeting}', this MCP needs AGENTLINK 2 (update the SDK)`);
    }
    sock.write(`AUTH ${token}\n`);
    const auth = await this.nextLine();
    if (auth !== "OK") {
      this.close();
      throw new LinkError(`${this.describe()}: auth refused (${auth}); the token file may be from an older launch`);
    }
  }

  private nextLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new LinkError(`${this.describe()}: no reply`)), CONNECT_TIMEOUT_MS);
      this.lineWaiters.push((line) => {
        clearTimeout(timer);
        resolve(line);
      });
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (line.startsWith("RESULT ")) {
      const m = /^RESULT (\S+) (ok|err) (.*)$/s.exec(line);
      if (!m) return;
      const p = this.pending.get(m[1]);
      if (!p) return;
      this.pending.delete(m[1]);
      clearTimeout(p.timer);
      let payload: any;
      try {
        payload = JSON.parse(m[3]);
      } catch {
        payload = { raw: m[3] };
      }
      p.resolve({ ok: m[2] === "ok", payload });
      return;
    }
    const waiter = this.lineWaiters.shift();
    if (waiter) waiter(line);
  }

  private drop(reason: string): void {
    this.socket = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new LinkError(`${this.describe()}: ${reason}`));
    }
    this.pending.clear();
    for (const w of this.lineWaiters.splice(0)) w("ERR " + reason);
  }

  async request(op: string, args: string, timeoutMs = 15000): Promise<{ ok: boolean; payload: any }> {
    await this.ensure();
    const id = `r${this.nextId++}`;
    const line = `${op} ${id}${args ? " " + args : ""}`;
    if (line.includes("\n")) throw new LinkError("request must be a single line");
    if (Buffer.byteLength(line, "utf8") > MAX_LINE)
      throw new LinkError(`request is ${Buffer.byteLength(line, "utf8")} bytes; the link accepts at most ${MAX_LINE}`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new LinkError(
            `${this.describe()}: ${op} timed out after ${timeoutMs} ms (the game may be loading a map or paused). ` +
              "The request stays queued in the game and may still run later."
          )
        );
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(line + "\n");
    });
  }

  async info(): Promise<any> {
    return (await this.request("INFO", "")).payload;
  }

  async evalScript(vm: "server" | "client" | "ui", code: string, timeoutMs?: number): Promise<ExecResult> {
    // Base64 keeps newlines, so // comments do not swallow the rest of the script.
    const b64 = Buffer.from(code, "utf8").toString("base64");
    const r = await this.request("EVAL64", `${vm} ${b64}`, timeoutMs);
    return { ok: r.ok, logDropped: 0, log: [], reply: null, ran: false, error: !r.ok, ...r.payload };
  }

  async command(line: string, timeoutMs?: number): Promise<ExecResult> {
    const oneLine = line.replace(/\r?\n/g, ";");
    const r = await this.request("CMD", oneLine, timeoutMs);
    return { ok: r.ok, logDropped: 0, log: [], reply: null, ran: false, error: !r.ok, ...r.payload };
  }

  async logs(since: number, max: number): Promise<{ lines: LogLine[]; next: number }> {
    return (await this.request("LOG", `${since} ${max}`)).payload;
  }

  // Calls an Agent_* script function and returns its parsed JSON reply.
  async call(vm: "server" | "client" | "ui", code: string, timeoutMs?: number): Promise<any> {
    const r = await this.evalScript(vm, code, timeoutMs);
    if (r.reply !== null && r.reply !== undefined) {
      try {
        return JSON.parse(r.reply);
      } catch {
        return { ok: false, error: "reply was not JSON", reply: r.reply, log: r.log };
      }
    }
    const errors = r.log.filter((l) => l.level !== "info").map((l) => l.text);
    return {
      ok: false,
      error: r.message ?? "script produced no reply",
      log: errors.length ? errors : r.log.map((l) => l.text),
    };
  }
}
