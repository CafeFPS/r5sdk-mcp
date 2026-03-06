import * as net from "node:net";
import { EventEmitter } from "node:events";
import {
  packFrame,
  unpackFrame,
  RequestType,
  ResponseType,
  type RconResponse,
} from "./protocol.js";

export interface RconConfig {
  host: string;
  port: number;
  password: string;
}

interface PendingCommand {
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  buffer: string;
  timer: ReturnType<typeof setTimeout>;
}

const COMMAND_TIMEOUT_MS = 10_000;
const LOG_RING_SIZE = 5000;
const RECONNECT_DELAY_MS = 3000;

export class RconClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private recvBuf = Buffer.alloc(0);
  private authenticated = false;
  private config: RconConfig;

  // Console log ring buffer
  private logRing: string[] = [];
  private logWriteIdx = 0;
  private logTotalLines = 0;

  // Command response collection.
  // After sending a command, we accumulate console log lines for a short
  // window and return them as the command's "output". This is inherently
  // heuristic since RCON has no request/response correlation IDs.
  private pendingCommand: PendingCommand | null = null;

  // Connection state
  private connecting = false;
  private shouldReconnect = true;

  constructor(config: RconConfig) {
    super();
    this.config = config;
  }

  // --- Public API ---

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return;

    this.connecting = true;
    this.authenticated = false;

    return new Promise((resolve, reject) => {
      const sock = new net.Socket();
      this.socket = sock;

      const onError = (err: Error) => {
        this.connecting = false;
        sock.removeAllListeners();
        sock.destroy();
        this.socket = null;
        reject(err);
      };

      sock.once("error", onError);

      sock.connect(this.config.port, this.config.host, async () => {
        sock.removeListener("error", onError);
        this.connecting = false;

        sock.on("data", (data) => this.onData(data));
        sock.on("error", (err) => this.onSocketError(err));
        sock.on("close", () => this.onSocketClose());

        try {
          await this.authenticate();
          await this.requestConsoleLogs();
          resolve();
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.authenticated = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }

  isConnected(): boolean {
    return this.authenticated && this.socket !== null && !this.socket.destroyed;
  }

  // Execute a console command and collect output.
  async exec(command: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<string> {
    if (!this.isConnected()) {
      throw new Error("Not connected to RCON server");
    }

    // Wait for any pending command to finish
    if (this.pendingCommand) {
      await new Promise<void>((resolve) => {
        const check = () => {
          if (!this.pendingCommand) resolve();
          else setTimeout(check, 50);
        };
        check();
      });
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCommand) {
          const output = this.pendingCommand.buffer;
          this.pendingCommand = null;
          resolve(output);
        }
      }, timeoutMs);

      this.pendingCommand = { resolve, reject, buffer: "", timer };

      this.sendCommand(command);
    });
  }

  // Execute without waiting for output (fire-and-forget).
  send(command: string): void {
    if (!this.isConnected()) {
      throw new Error("Not connected to RCON server");
    }
    this.sendCommand(command);
  }

  // Get recent console log lines.
  getRecentLog(lineCount = 100): string[] {
    const count = Math.min(lineCount, this.logTotalLines, LOG_RING_SIZE);
    const lines: string[] = [];
    const start =
      this.logTotalLines > LOG_RING_SIZE
        ? this.logWriteIdx
        : 0;

    for (let i = 0; i < count; i++) {
      const idx = (start + (this.logTotalLines > LOG_RING_SIZE
        ? LOG_RING_SIZE - count + i
        : this.logTotalLines - count + i)) % LOG_RING_SIZE;
      if (this.logRing[idx] !== undefined) {
        lines.push(this.logRing[idx]);
      }
    }

    return lines;
  }

  clearLog(): void {
    this.logRing = [];
    this.logWriteIdx = 0;
    this.logTotalLines = 0;
  }

  // --- Internals ---

  private sendRaw(buf: Buffer): void {
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(buf);
    }
  }

  private sendCommand(command: string): void {
    // Match the netconsole client behavior:
    // requestMsg = command, requestVal = "" for simple commands
    const frame = packFrame({
      messageId: -1,
      requestType: RequestType.EXECCOMMAND,
      requestMsg: command,
      requestVal: "",
    });
    this.sendRaw(frame);
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("RCON authentication timed out"));
      }, 5000);

      const handler = (resp: RconResponse) => {
        if (resp.responseType === ResponseType.AUTH) {
          clearTimeout(timeout);
          this.removeListener("_response", handler);

          if (
            resp.responseMsg.includes("authenticated") ||
            resp.responseMsg.includes("Welcome")
          ) {
            this.authenticated = true;
            resolve();
          } else {
            reject(
              new Error(`RCON auth failed: ${resp.responseMsg.trim()}`)
            );
          }
        }
      };

      this.on("_response", handler);

      const frame = packFrame({
        messageId: -1,
        requestType: RequestType.AUTH,
        requestMsg: this.config.password,
        requestVal: "",
      });
      this.sendRaw(frame);
    });
  }

  private requestConsoleLogs(): void {
    const frame = packFrame({
      messageId: -1,
      requestType: RequestType.SEND_CONSOLE_LOG,
      requestMsg: "",
      requestVal: "1",
    });
    this.sendRaw(frame);
  }

  private onData(data: Buffer): void {
    this.recvBuf = Buffer.concat([this.recvBuf, data]);

    while (this.recvBuf.length > 0) {
      try {
        const result = unpackFrame(this.recvBuf);
        if (!result) break;

        this.recvBuf = this.recvBuf.subarray(result.bytesConsumed);
        this.handleResponse(result.response);
      } catch (err) {
        // Protocol error - reset buffer
        this.recvBuf = Buffer.alloc(0);
        this.emit(
          "error",
          new Error(`Protocol error: ${(err as Error).message}`)
        );
        break;
      }
    }
  }

  private handleResponse(resp: RconResponse): void {
    this.emit("_response", resp);

    if (resp.responseType === ResponseType.CONSOLE_LOG) {
      const line = resp.responseMsg;
      this.appendLog(line);

      // Feed to pending command if one exists
      if (this.pendingCommand) {
        this.pendingCommand.buffer += line;

        // Heuristic: after collecting output, use a short debounce.
        // Reset the timer on each new line so we collect the full burst.
        clearTimeout(this.pendingCommand.timer);
        const pending = this.pendingCommand;
        this.pendingCommand.timer = setTimeout(() => {
          if (this.pendingCommand === pending) {
            const output = pending.buffer;
            this.pendingCommand = null;
            pending.resolve(output);
          }
        }, 200);
      }

      this.emit("log", line);
    }
  }

  private appendLog(line: string): void {
    this.logRing[this.logWriteIdx] = line;
    this.logWriteIdx = (this.logWriteIdx + 1) % LOG_RING_SIZE;
    this.logTotalLines++;
  }

  private onSocketError(err: Error): void {
    this.emit("error", err);
  }

  private onSocketClose(): void {
    this.authenticated = false;
    this.socket = null;

    if (this.pendingCommand) {
      this.pendingCommand.reject(new Error("Connection closed"));
      clearTimeout(this.pendingCommand.timer);
      this.pendingCommand = null;
    }

    this.emit("disconnected");

    if (this.shouldReconnect) {
      setTimeout(() => {
        this.connect().catch(() => {});
      }, RECONNECT_DELAY_MS);
    }
  }
}
