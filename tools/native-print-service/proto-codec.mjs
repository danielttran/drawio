// Binary frame codec for the native print engine stdio protocol.
// Matches the C++ encode_frame / FrameDecoder exactly.
//
// Wire format: [uint32 frameLen LE][uint8 frameType][uint32 streamId LE][payload]
// frameLen = 1 (frameType) + 4 (streamId) + payload.length
//
// FrameType: 0x01 = Control (UTF-8 JSON), 0x02 = Binary (e.g. PNG bytes)

export const FrameType = { Control: 0x01, Binary: 0x02 };

const MAX_FRAME_LEN = 64 * 1024 * 1024;

export function encodeFrame(type, streamId, payload) {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const frameLen = 1 + 4 + p.length;
  const out = Buffer.allocUnsafe(4 + frameLen);
  out.writeUInt32LE(frameLen, 0);
  out[4] = type;
  out.writeUInt32LE(streamId >>> 0, 5);
  p.copy(out, 9);
  return out;
}

export function encodeControl(json) {
  return encodeFrame(FrameType.Control, 0, Buffer.from(JSON.stringify(json)));
}

// Streaming decoder: accumulate chunks, pop complete frames.
export class FrameDecoder {
  constructor() {
    this._buf = Buffer.alloc(0);
    this._ready = [];
    this.failed = false;
    this.error = null;
  }

  feed(chunk) {
    if (this.failed) return;
    this._buf = Buffer.concat([this._buf, chunk]);
    let pos = 0;
    while (pos + 4 <= this._buf.length) {
      const frameLen = this._buf.readUInt32LE(pos);
      if (frameLen < 5 || frameLen > MAX_FRAME_LEN) {
        this.failed = true;
        this.error = `frame length out of range: ${frameLen}`;
        return;
      }
      const totalLen = 4 + frameLen;
      if (pos + totalLen > this._buf.length) break;
      const type = this._buf[pos + 4];
      if (type !== FrameType.Control && type !== FrameType.Binary) {
        this.failed = true;
        this.error = `unknown frame type: ${type}`;
        return;
      }
      const streamId = this._buf.readUInt32LE(pos + 5);
      const payload = Buffer.from(this._buf.subarray(pos + 9, pos + totalLen));
      this._ready.push({ type, streamId, payload });
      pos += totalLen;
    }
    if (pos > 0) {
      this._buf = Buffer.from(this._buf.subarray(pos));
    }
  }

  next() {
    return this._ready.length > 0 ? this._ready.shift() : null;
  }
}
