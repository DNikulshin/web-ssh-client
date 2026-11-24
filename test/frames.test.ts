import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameDecoder,
  decodeControl,
  encodeControl,
  encodeFrame,
  FRAME_CONTROL,
  FRAME_IN,
  FRAME_OUT,
  MAX_FRAME,
} from '../src/proto/frames.ts';

test('кадр собирается и разбирается целиком', () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(encodeFrame(FRAME_OUT, 'hello'));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.type, FRAME_OUT);
  assert.equal(frames[0]!.payload.toString('utf8'), 'hello');
});

test('разрезанный по байту поток не ломает разбор', () => {
  const decoder = new FrameDecoder();
  const data = Buffer.concat([encodeFrame(FRAME_IN, 'ls -la'), encodeControl({ t: 'ping', at: 1 })]);
  const got = [];
  for (const byte of data) {
    got.push(...decoder.push(Buffer.from([byte])));
  }
  assert.equal(got.length, 2);
  assert.equal(got[0]!.payload.toString('utf8'), 'ls -la');
  assert.deepEqual(decodeControl(got[1]!), { t: 'ping', at: 1 });
});

test('бинарный вывод не портится: эскейпы и нулевые байты', () => {
  const decoder = new FrameDecoder();
  const payload = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00, 0x7f, 0xff]);
  const [frame] = decoder.push(encodeFrame(FRAME_OUT, payload));
  assert.deepEqual(frame!.payload, payload);
});

test('несколько кадров одним чанком отдаются по порядку', () => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(
    Buffer.concat([
      encodeFrame(FRAME_OUT, 'a'),
      encodeFrame(FRAME_OUT, 'b'),
      encodeFrame(FRAME_CONTROL, JSON.stringify({ t: 'detach' })),
    ]),
  );
  assert.deepEqual(
    frames.map((f) => f.payload.toString('utf8')),
    ['a', 'b', '{"t":"detach"}'],
  );
});

test('слишком длинный кадр отвергается, а не съедает память', () => {
  const head = Buffer.alloc(5);
  head.writeUInt32BE(MAX_FRAME + 1, 0);
  head.writeUInt8(FRAME_OUT, 4);
  assert.throws(() => new FrameDecoder().push(head), /больше предела/);
});

test('неизвестный тип кадра — фатальная ошибка', () => {
  const frame = encodeFrame(FRAME_OUT, 'x');
  frame.writeUInt8(9, 4);
  assert.throws(() => new FrameDecoder().push(frame), /неизвестный тип/);
});

test('без поля t control-кадр не считается валидным', () => {
  const [frame] = new FrameDecoder().push(encodeFrame(FRAME_CONTROL, JSON.stringify({ x: 1 })));
  assert.throws(() => decodeControl(frame!), /без поля t/);
});
