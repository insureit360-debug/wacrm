import { describe, expect, it } from "vitest";
import { limitToRoom, runPool, sendInOrder } from "./attachments";

describe("limitToRoom", () => {
  it("keeps everything when there is room", () => {
    expect(limitToRoom(0, [1, 2, 3], 10)).toEqual({ accepted: [1, 2, 3], dropped: 0 });
  });
  it("keeps only what fits and reports how many were left out", () => {
    expect(limitToRoom(8, [1, 2, 3, 4], 10)).toEqual({ accepted: [1, 2], dropped: 2 });
  });
  it("accepts nothing when the tray is full", () => {
    expect(limitToRoom(10, [1], 10)).toEqual({ accepted: [], dropped: 1 });
    expect(limitToRoom(12, [1], 10)).toEqual({ accepted: [], dropped: 1 });
  });
});

describe("runPool", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("returns results in the order the files were picked, even if uploads finish out of order", async () => {
    const delays = [40, 5, 25, 1, 15];
    const out = await runPool(delays, 3, async (ms, i) => {
      await sleep(ms);
      return `file-${i}`;
    });
    expect(out.map((r) => (r.ok ? r.value : "x"))).toEqual(["file-0", "file-1", "file-2", "file-3", "file-4"]);
  });

  it("never runs more than the concurrency limit at once", async () => {
    let running = 0;
    let peak = 0;
    await runPool(Array.from({ length: 9 }, (_, i) => i), 3, async () => {
      running++;
      peak = Math.max(peak, running);
      await sleep(5);
      running--;
    });
    expect(peak).toBe(3);
  });

  it("a failed upload does not stop the others and is reported in place", async () => {
    const out = await runPool([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n * 10;
    });
    expect(out[0]).toEqual({ ok: true, value: 10 });
    expect(out[1].ok).toBe(false);
    expect(out[2]).toEqual({ ok: true, value: 30 });
  });

  it("reports progress and handles an empty list", async () => {
    const seen: Array<[number, number]> = [];
    await runPool([1, 2, 3], 2, async (n) => n, (d, t) => seen.push([d, t]));
    expect(seen.map(([d]) => d)).toEqual([1, 2, 3]);
    expect(seen.every(([, t]) => t === 3)).toBe(true);
    expect(await runPool([], 3, async () => 1)).toEqual([]);
  });
});

describe("sendInOrder", () => {
  it("waits for each send so messages arrive in the order picked", async () => {
    const log: string[] = [];
    await sendInOrder(["a", "b", "c"], async (x, i) => {
      await new Promise((r) => setTimeout(r, i === 0 ? 20 : 1));
      log.push(x);
    });
    expect(log).toEqual(["a", "b", "c"]);
  });
  it("keeps going when one send throws", async () => {
    const log: string[] = [];
    await sendInOrder(["a", "b", "c"], async (x) => {
      if (x === "b") throw new Error("fail");
      log.push(x);
    });
    expect(log).toEqual(["a", "c"]);
  });
});
