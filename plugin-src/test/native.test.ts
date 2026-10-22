import { expect, test } from "vitest";
import { NativeEngine, fnv1a } from "../src/host/NativeEngine";

const ok = (value: unknown) => ({ json: JSON.stringify({ ok: true, value }), buffer: new ArrayBuffer(0) });

test("bridge copies a subview without leaking unrelated bytes", async () => {
  let received: number[] = [];
  const native = new NativeEngine({ cancel() {}, submit(_op, _json, buffer) { received = [...new Uint8Array(buffer)]; return 1; },
    take: () => ok(null) }, async () => {});
  await native.request("x", {}, Uint8Array.of(8, 1, 2, 9).subarray(1, 3));
  expect(received).toEqual([1, 2]);
});

test("cancel discards a late result and allows the next request", async () => {
  let calls = 0, cancelled = 0;
  const native: NativeEngine = new NativeEngine({ submit: () => 7, cancel(id) { cancelled = id; },
    take: () => (++calls === 1 ? null : ok(17)) }, async () => { native.cancel(); });
  await expect(native.request("x", {})).rejects.toMatchObject({ code: "CANCELLED" });
  expect(cancelled).toBe(7); expect(native.busy).toBe(false);
  expect((await native.request("next", {})).value).toBe(17);
});

test("concurrent operations are rejected", async () => {
  let release!: () => void, ready = false;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const native = new NativeEngine({ cancel() {}, submit: () => 1, take: () => (ready ? ok(null) : null) }, () => wait);
  const first = native.request("first", {});
  await expect(native.request("second", {})).rejects.toMatchObject({ code: "BUSY" });
  ready = true; release(); await first;
});

test("non-finite device values never reach C++ as null", async () => {
  const requests: any[] = [];
  const engine = new NativeEngine({ cancel() {}, submit(_op, options) { requests.push(JSON.parse(options)); return 1; }, take: () => ok({}) });
  for (const device of [NaN, Infinity, undefined, null, .5, -3, -1, 0]) await engine.initialize("model", device as any);
  expect(requests.map(item => item.device)).toEqual([-2, -2, -2, -2, -2, -2, -1, 0]);
});

test("prompt checksum is verified across the native boundary", async () => {
  let corrupt = false;
  const engine = new NativeEngine({ cancel() {}, submit: () => 1, take: () => ok({ instances: [],
    prompt: { sourceBytes: 3, sourcePaintedPixels: 2, alphaChecksum: corrupt ? 0 : 2947504159 } }) });
  const prompt = Uint8Array.of(0, 1, 255);
  expect(fnv1a(prompt).checksum).toBe(2947504159);
  expect(await engine.segment(1, prompt, { confidence: .25, mode: "current" })).toEqual([]);
  expect(engine.lastPromptDiagnostics!.transferMatches).toBe(true);
  corrupt = true;
  await expect(engine.segment(1, prompt, { confidence: .25, mode: "current" })).rejects.toMatchObject({ code: "PROMPT_TRANSFER" });
});

test("resmooth re-runs only post-processing for the last result", async () => {
  const requests: { op: string; options: any }[] = [];
  let resultId = 4;
  const masks = new Uint8Array([255, 128]);
  const engine = new NativeEngine({ cancel() {}, submit(op, options) { requests.push({ op, options: JSON.parse(options) }); return 1; },
    take: () => ({ json: JSON.stringify({ ok: true, value: { resultId, prompt: { sourceBytes: 1, sourcePaintedPixels: 1, alphaChecksum: fnv1a(Uint8Array.of(1)).checksum },
      instances: [{ id: 3, left: 0, top: 0, width: 2, height: 1, offset: 0, length: 2, confidence: 1 }] } }), buffer: masks.buffer }) });
  await expect(engine.resmooth(1, { smooth: .2, expand: .8 })).rejects.toMatchObject({ code: "STALE_RESULT" });
  await engine.segment(1, Uint8Array.of(1), { confidence: .25, mode: "current", smooth: .5, expand: .5 });
  const found = await engine.resmooth(1, { smooth: .2, expand: .8 });
  expect(requests.at(-1)).toEqual({ op: "resmooth", options: { sessionId: 1, resultId: 4, smooth: .2, expand: .8 } });
  expect([...found[0].mask]).toEqual([255, 128]);
});

test("unload frees the model and invalidates the last result", async () => {
  const ops: string[] = [];
  const engine = new NativeEngine({ cancel() {}, submit(op) { ops.push(op); return 1; },
    take: () => ok({ resultId: 2, instances: [], prompt: { sourceBytes: 1, sourcePaintedPixels: 1, alphaChecksum: fnv1a(Uint8Array.of(1)).checksum } }) });
  await engine.segment(1, Uint8Array.of(1), { confidence: .25, mode: "current" });
  expect(engine.lastResultId).toBe(2);
  await engine.unload();
  expect(ops.at(-1)).toBe("unload");
  expect(engine.lastResultId).toBeNull();
  await expect(engine.resmooth(1, { smooth: .5, expand: .5 })).rejects.toMatchObject({ code: "STALE_RESULT" });
});

test("load options reach the native loader as a strict boolean and a positive integer size", async () => {
  const requests: any[] = [];
  const engine = new NativeEngine({ cancel() {}, submit(_op, options) { requests.push(JSON.parse(options)); return 1; }, take: () => ok({}) });
  await engine.initialize("model", -2, true, { lowVram: true, inputSize: 672 });
  await engine.initialize("model", -2, true);
  await engine.initialize("model", -2, true, { lowVram: "yes" as any, inputSize: 840.5 });
  await engine.initialize("model", -2, true, { inputSize: -1 });
  expect(requests.map(item => [item.lowVram, item.inputSize])).toEqual([[true, 672], [false, 0], [false, 0], [false, 0]]);
});
