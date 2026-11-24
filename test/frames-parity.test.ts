import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAME_CONTROL as TS_CONTROL,
  FRAME_IN as TS_IN,
  FRAME_OUT as TS_OUT,
  FrameDecoder as TsDecoder,
  encodeFrame as tsEncode,
} from '../src/proto/frames.ts';
import {
  FRAME_CONTROL as JS_CONTROL,
  FRAME_IN as JS_IN,
  FRAME_OUT as JS_OUT,
  FrameDecoder as JsDecoder,
  encodeFrame as jsEncode,
} from '../public/js/frames.js';

/**
 * Одна спецификация протокола живёт в двух местах: TypeScript на сервере и ES-модуль
 * в браузере (сборщика в проекте нет). Рассинхрон здесь выглядит как «терминал молча
 * ничего не делает», поэтому константы и байты сверяются тестом, а не вниманием.
 */

test('константы кадров совпадают в серверной и браузерной реализации', () => {
  assert.equal(JS_CONTROL, TS_CONTROL);
  assert.equal(JS_OUT, TS_OUT);
  assert.equal(JS_IN, TS_IN);
});

test('серверный энкодер и браузерный дают одинаковые байты', () => {
  const payload = Buffer.from([0x1b, 0x5b, 0x41, 0x00, 0xff]);
  const fromTs = tsEncode(TS_OUT, payload);
  const fromJs = Buffer.from(jsEncode(JS_OUT, payload));
  assert.deepEqual(fromJs, fromTs);
});

test('кадры читаются перекрёстно: сервер→браузер и браузер→сервер', () => {
  const text = JSON.stringify({ t: 'attach', from: 42 });
  const fromServer = tsEncode(TS_CONTROL, text);

  const jsFrames = new JsDecoder().push(new Uint8Array(fromServer));
  assert.equal(jsFrames.length, 1);
  assert.equal(Buffer.from(jsFrames[0]!.payload).toString('utf8'), text);

  const fromBrowser = Buffer.from(jsEncode(JS_IN, 'ls -la\r'));
  const tsFrames = new TsDecoder().push(fromBrowser);
  assert.equal(tsFrames.length, 1);
  assert.equal(tsFrames[0]!.type, TS_IN);
  assert.equal(tsFrames[0]!.payload.toString('utf8'), 'ls -la\r');
});

test('браузерный декодер собирает кадр из двух половин', () => {
  const frame = Buffer.from(jsEncode(JS_OUT, 'половина-кадра'));
  const cut = 4;
  const decoder = new JsDecoder();
  assert.equal(decoder.push(new Uint8Array(frame.subarray(0, cut))).length, 0);
  const rest = decoder.push(new Uint8Array(frame.subarray(cut)));
  assert.equal(rest.length, 1);
  assert.equal(Buffer.from(rest[0]!.payload).toString('utf8'), 'половина-кадра');
});
