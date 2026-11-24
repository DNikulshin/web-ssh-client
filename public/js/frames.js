// Протокол кадров, браузерная сторона. Спецификация одна с src/proto/frames.ts,
// расхождение ловится тестом test/frames-parity.test.ts (сравнение байт в обе стороны).

export const FRAME_CONTROL = 1;
export const FRAME_OUT = 2;
export const FRAME_IN = 3;
export const MAX_FRAME = 1024 * 1024;

export function encodeFrame(type, payload) {
  const body = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
  if (body.length > MAX_FRAME) throw new Error(`кадр ${body.length} больше предела`);
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out[4] = type;
  out.set(body, 5);
  return out;
}

export function encodeControl(msg) {
  return encodeFrame(FRAME_CONTROL, JSON.stringify(msg));
}

export class FrameDecoder {
  #buf = new Uint8Array(0);

  push(chunk) {
    if (this.#buf.length === 0) {
      this.#buf = chunk;
    } else {
      const merged = new Uint8Array(this.#buf.length + chunk.length);
      merged.set(this.#buf, 0);
      merged.set(chunk, this.#buf.length);
      this.#buf = merged;
    }
    const out = [];
    while (this.#buf.length >= 5) {
      const view = new DataView(this.#buf.buffer, this.#buf.byteOffset, 5);
      const len = view.getUint32(0);
      const type = this.#buf[4];
      if (len > MAX_FRAME) throw new Error(`кадр ${len} больше предела`);
      if (this.#buf.length < 5 + len) break;
      out.push({ type, payload: this.#buf.subarray(5, 5 + len) });
      this.#buf = this.#buf.subarray(5 + len);
    }
    return out;
  }
}

export function decodeControl(frame) {
  if (frame.type !== FRAME_CONTROL) throw new Error('ожидался control-кадр');
  return JSON.parse(new TextDecoder().decode(frame.payload));
}
