import assert from "node:assert/strict";
import test from "node:test";
import { warmDecode, type WarmImage } from "./warmDecode.ts";

class FakeImage implements WarmImage {
  src = "";
  complete = false;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  fire: "load" | "error" | "never";
  decoded = false;
  decodeRejects: boolean;

  constructor(fire: "load" | "error" | "never", decodeRejects = false) {
    this.fire = fire;
    this.decodeRejects = decodeRejects;
  }

  decode(): Promise<void> {
    this.decoded = true;
    return this.decodeRejects ? Promise.reject(new Error("decode")) : Promise.resolve();
  }

  setSrc(url: string): void {
    this.src = url;
    if (this.fire === "load") this.onload?.();
    else if (this.fire === "error") this.onerror?.();
  }
}

function factory(fire: "load" | "error" | "never", decodeRejects = false): () => WarmImage {
  return () => {
    const img = new FakeImage(fire, decodeRejects);
    const orig = img;
    return new Proxy(img, {
      set(target, prop, value) {
        if (prop === "src") { orig.setSrc(String(value)); return true; }
        return Reflect.set(target, prop, value);
      },
    });
  };
}

test("warmDecode waits for decode(), including a rejected decode", async () => {
  let img: FakeImage | null = null;
  await warmDecode(["data:image/svg+xml;base64,aaa"], () => {
    img = new FakeImage("load", true);
    const created = img;
    return new Proxy(created, {
      set(target, prop, value) {
        if (prop === "src") { created.setSrc(String(value)); return true; }
        return Reflect.set(target, prop, value);
      },
    });
  });
  assert.equal(img!.decoded, true);
});

test("warmDecode settles on image error", async () => {
  await warmDecode(["data:image/svg+xml;base64,bbb"], factory("error"));
});

test("warmDecode settles on the cap when load never fires", async () => {
  const t0 = Date.now();
  await warmDecode(["data:image/svg+xml;base64,ccc"], factory("never"), 30);
  assert.ok(Date.now() - t0 >= 25);
  assert.ok(Date.now() - t0 < 500);
});

test("warmDecode skips empty urls", async () => {
  let created = 0;
  await warmDecode(["", ""], () => { created += 1; return new FakeImage("never"); }, 20);
  assert.equal(created, 0);
});
