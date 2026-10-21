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
