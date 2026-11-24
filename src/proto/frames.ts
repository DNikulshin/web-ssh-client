/**
 * Кадры между веб-слоем, хабом и воркерами сессий.
 *
 * Формат: [4 байта BE — длина полезной нагрузки][1 байт тип][payload].
 * Терминальный вывод — поток байт, а не JSON: base64 на каждый keystroke раздувает трафик
 * и ломает escape-последовательности при побайтовой нарезке. Control-сообщения остаются JSON,
 * чтобы протокол можно было читать глазами в логах.
 */

export const FRAME_CONTROL = 1;
export const FRAME_OUT = 2;
export const FRAME_IN = 3;

export type FrameType = typeof FRAME_CONTROL | typeof FRAME_OUT | typeof FRAME_IN;

export const MAX_FRAME = 1024 * 1024; // 1 МиБ на кадр: больше — уже не терминал

export type Control =
  | { t: 'hello'; sessionId: string; status: SessionStatus; rows: number; cols: number; lastSeq: number; pid: number }
  | { t: 'attach'; from?: number }
  | { t: 'attached'; fromSeq: number; replayedBytes: number }
  | { t: 'detach' }
  | { t: 'resize'; rows: number; cols: number }
  | { t: 'status'; status: SessionStatus; message?: string }
  | { t: 'exit'; code: number | null; signal?: string }
  | { t: 'error'; message: string }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number };

export type SessionStatus = 'starting' | 'active' | 'detached' | 'exited' | 'lost';

export function encodeFrame(type: FrameType, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > MAX_FRAME) throw new Error(`кадр ${body.length} байт больше предела ${MAX_FRAME}`);
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(body.length, 0);
  head.writeUInt8(type, 4);
  return Buffer.concat([head, body]);
}

export function encodeControl(msg: Control): Buffer {
  return encodeFrame(FRAME_CONTROL, JSON.stringify(msg));
}

export interface DecodedFrame {
  type: FrameType;
  payload: Buffer;
}

/**
 * Потоковый декодер: TCP/Unix-сокет не обязан отдавать кадр целиком, поэтому буфер
 * накапливается, а кадры выдаются по мере готовности. Ошибка длины — фатальная: продолжать
 * читать поток с неизвестной границей нельзя, поэтому вызывающий обязан закрыть соединение.
 */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.#buf = this.#buf.length === 0 ? chunk : Buffer.concat([this.#buf, chunk]);
    const out: DecodedFrame[] = [];
    while (this.#buf.length >= 5) {
      const len = this.#buf.readUInt32BE(0);
      const type = this.#buf.readUInt8(4) as FrameType;
      if (len > MAX_FRAME) throw new Error(`кадр ${len} байт больше предела ${MAX_FRAME}`);
      if (type !== FRAME_CONTROL && type !== FRAME_OUT && type !== FRAME_IN) {
        throw new Error(`неизвестный тип кадра ${type}`);
      }
      if (this.#buf.length < 5 + len) break;
      out.push({ type, payload: this.#buf.subarray(5, 5 + len) });
      this.#buf = this.#buf.subarray(5 + len);
    }
    return out;
  }

  get pending(): number {
    return this.#buf.length;
  }
}

export function decodeControl(frame: DecodedFrame): Control {
  if (frame.type !== FRAME_CONTROL) throw new Error(`ожидался control-кадр, получен ${frame.type}`);
  const parsed = JSON.parse(frame.payload.toString('utf8')) as Control;
  if (typeof (parsed as { t?: unknown }).t !== 'string') throw new Error('control-кадр без поля t');
  return parsed;
}
