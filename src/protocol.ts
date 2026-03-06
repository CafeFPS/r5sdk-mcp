// R5SDK RCON wire protocol implementation.
// Frame format: [4B magic BE][4B length BE][protobuf envelope]
// Envelope: { encrypted: bool, nonce: bytes, data: bytes }
// Data: protobuf request or response (unencrypted mode)

const RCON_FRAME_MAGIC = 0x52436f6e; // 'RCon' in big-endian
const FRAME_HEADER_SIZE = 8;

// --- Protobuf wire format helpers ---
// We hand-roll encode/decode for these 5-field messages since they're trivial
// and it avoids pulling in the full protobufjs runtime.

const enum WireType {
  Varint = 0,
  Fixed64 = 1,
  LengthDelimited = 2,
  Fixed32 = 5,
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let v = value >>> 0;
  while (v > 0x7f) {
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

function encodeTag(fieldNumber: number, wireType: WireType): Buffer {
  return encodeVarint((fieldNumber << 3) | wireType);
}

function encodeString(fieldNumber: number, value: string): Buffer {
  const strBuf = Buffer.from(value, "utf-8");
  return Buffer.concat([
    encodeTag(fieldNumber, WireType.LengthDelimited),
    encodeVarint(strBuf.length),
    strBuf,
  ]);
}

function encodeBytes(fieldNumber: number, value: Buffer): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WireType.LengthDelimited),
    encodeVarint(value.length),
    value,
  ]);
}

function encodeInt32(fieldNumber: number, value: number): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WireType.Varint),
    encodeVarint(value & 0xffffffff),
  ]);
}

function encodeBool(fieldNumber: number, value: boolean): Buffer {
  return Buffer.concat([
    encodeTag(fieldNumber, WireType.Varint),
    encodeVarint(value ? 1 : 0),
  ]);
}

// --- Protobuf decode ---

interface DecodedField {
  fieldNumber: number;
  wireType: WireType;
  value: number | Buffer;
}

function decodeProtobuf(buf: Buffer): DecodedField[] {
  const fields: DecodedField[] = [];
  let offset = 0;

  while (offset < buf.length) {
    const [tag, tagLen] = readVarint(buf, offset);
    offset += tagLen;

    const fieldNumber = tag >>> 3;
    const wireType = (tag & 0x7) as WireType;

    switch (wireType) {
      case WireType.Varint: {
        const [value, len] = readVarint(buf, offset);
        offset += len;
        fields.push({ fieldNumber, wireType, value });
        break;
      }
      case WireType.LengthDelimited: {
        const [length, lenLen] = readVarint(buf, offset);
        offset += lenLen;
        const value = buf.subarray(offset, offset + length);
        offset += length;
        fields.push({ fieldNumber, wireType, value: Buffer.from(value) });
        break;
      }
      case WireType.Fixed32: {
        const value = buf.readUInt32LE(offset);
        offset += 4;
        fields.push({ fieldNumber, wireType, value });
        break;
      }
      case WireType.Fixed64: {
        // Skip 8 bytes, store as buffer
        const value = buf.subarray(offset, offset + 8);
        offset += 8;
        fields.push({ fieldNumber, wireType, value: Buffer.from(value) });
        break;
      }
      default:
        throw new Error(`Unknown wire type ${wireType} at offset ${offset}`);
    }
  }

  return fields;
}

function readVarint(buf: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let bytesRead = 0;

  while (offset < buf.length) {
    const byte = buf[offset++];
    bytesRead++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }

  return [result >>> 0, bytesRead];
}

// --- Message types ---

export const enum RequestType {
  EXECCOMMAND = 0,
  AUTH = 1,
  SEND_CONSOLE_LOG = 2,
}

export const enum ResponseType {
  AUTH = 0,
  CONSOLE_LOG = 1,
}

export interface RconRequest {
  messageId?: number;
  messageType?: number;
  requestType: RequestType;
  requestMsg: string;
  requestVal: string;
}

export interface RconResponse {
  messageId: number;
  messageType: number;
  responseType: ResponseType;
  responseMsg: string;
  responseVal: string;
}

// --- Encode request ---

function encodeRequest(req: RconRequest): Buffer {
  const parts: Buffer[] = [];
  if (req.messageId !== undefined)
    parts.push(encodeInt32(1, req.messageId));
  if (req.messageType !== undefined)
    parts.push(encodeInt32(2, req.messageType));
  parts.push(encodeInt32(3, req.requestType));
  if (req.requestMsg) parts.push(encodeString(4, req.requestMsg));
  if (req.requestVal) parts.push(encodeString(5, req.requestVal));
  return Buffer.concat(parts);
}

// --- Decode response ---

function decodeResponse(buf: Buffer): RconResponse {
  const fields = decodeProtobuf(buf);
  const resp: RconResponse = {
    messageId: 0,
    messageType: 0,
    responseType: ResponseType.AUTH,
    responseMsg: "",
    responseVal: "",
  };

  for (const f of fields) {
    switch (f.fieldNumber) {
      case 1:
        resp.messageId = f.value as number;
        break;
      case 2:
        resp.messageType = f.value as number;
        break;
      case 3:
        resp.responseType = f.value as number;
        break;
      case 4:
        resp.responseMsg = (f.value as Buffer).toString("utf-8");
        break;
      case 5:
        resp.responseVal = (f.value as Buffer).toString("utf-8");
        break;
    }
  }

  return resp;
}

// --- Envelope encode/decode (unencrypted only) ---

interface Envelope {
  encrypted: boolean;
  nonce: Buffer;
  data: Buffer;
}

function encodeEnvelope(env: Envelope): Buffer {
  const parts: Buffer[] = [];
  parts.push(encodeBool(1, env.encrypted));
  if (env.nonce.length > 0) parts.push(encodeBytes(2, env.nonce));
  parts.push(encodeBytes(3, env.data));
  return Buffer.concat(parts);
}

function decodeEnvelope(buf: Buffer): Envelope {
  const fields = decodeProtobuf(buf);
  const env: Envelope = { encrypted: false, nonce: Buffer.alloc(0), data: Buffer.alloc(0) };

  for (const f of fields) {
    switch (f.fieldNumber) {
      case 1:
        env.encrypted = (f.value as number) !== 0;
        break;
      case 2:
        env.nonce = f.value as Buffer;
        break;
      case 3:
        env.data = f.value as Buffer;
        break;
    }
  }

  return env;
}

// --- Frame-level pack/unpack ---

export function packFrame(req: RconRequest): Buffer {
  const requestBuf = encodeRequest(req);
  const envelope = encodeEnvelope({
    encrypted: false,
    nonce: Buffer.alloc(0),
    data: requestBuf,
  });

  const frame = Buffer.alloc(FRAME_HEADER_SIZE + envelope.length);
  frame.writeUInt32BE(RCON_FRAME_MAGIC, 0);
  frame.writeUInt32BE(envelope.length, 4);
  envelope.copy(frame, FRAME_HEADER_SIZE);
  return frame;
}

export function unpackFrame(
  buf: Buffer
): { response: RconResponse; bytesConsumed: number } | null {
  if (buf.length < FRAME_HEADER_SIZE) return null;

  const magic = buf.readUInt32BE(0);
  if (magic !== RCON_FRAME_MAGIC) {
    throw new Error(
      `Invalid RCON frame magic: 0x${magic.toString(16)} (expected 0x${RCON_FRAME_MAGIC.toString(16)})`
    );
  }

  const envelopeLen = buf.readUInt32BE(4);
  const totalLen = FRAME_HEADER_SIZE + envelopeLen;

  if (buf.length < totalLen) return null;

  const envelopeBuf = buf.subarray(FRAME_HEADER_SIZE, totalLen);
  const envelope = decodeEnvelope(envelopeBuf);

  if (envelope.encrypted) {
    throw new Error("Encrypted RCON frames not supported. Set rcon_encryptframes 0");
  }

  const response = decodeResponse(envelope.data);
  return { response, bytesConsumed: totalLen };
}
