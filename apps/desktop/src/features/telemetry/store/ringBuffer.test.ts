import { describe, expect, it } from "vitest";
import { RingBuffer } from "./ringBuffer";

/** The semantics `insertAt` documents, written the obvious way: insert, then drop from the front if over capacity. */
function referenceInsert(model: number[], capacity: number, index: number, item: number): number[] {
  const next = [...model];
  next.splice(Math.min(Math.max(index, 0), next.length), 0, item);
  return next.length > capacity ? next.slice(next.length - capacity) : next;
}

describe("RingBuffer", () => {
  it("push evicts the oldest at capacity and keeps order", () => {
    const buffer = new RingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach((value) => buffer.push(value));
    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.length).toBe(3);
    expect(buffer.get(0)).toBe(3);
    expect(buffer.get(3)).toBeUndefined();
  });

  it("upperBound lands after equal keys", () => {
    const buffer = new RingBuffer<number>(8);
    [1, 2, 2, 2, 5].forEach((value) => buffer.push(value));
    expect(buffer.upperBound((v) => v, 2)).toBe(4);
    expect(buffer.upperBound((v) => v, 0)).toBe(0);
    expect(buffer.upperBound((v) => v, 9)).toBe(5);
  });

  describe("insertAt below capacity", () => {
    it("inserts in the middle, at the front, and at the end", () => {
      const buffer = new RingBuffer<number>(10);
      [10, 20, 30].forEach((value) => buffer.push(value));
      buffer.insertAt(1, 15);
      buffer.insertAt(0, 5);
      buffer.insertAt(buffer.length, 99);
      expect(buffer.toArray()).toEqual([5, 10, 15, 20, 30, 99]);
    });
  });

  // Before the fix, a full buffer was scrambled: inserting 99 at the end of
  // [10,20,30,40,50] produced [30,40,50,99,20].
  describe("insertAt at capacity", () => {
    const full = () => {
      const buffer = new RingBuffer<number>(5);
      [10, 20, 30, 40, 50].forEach((value) => buffer.push(value));
      return buffer;
    };

    it("an in-order append is a push", () => {
      const buffer = full();
      buffer.insertAt(5, 99);
      expect(buffer.toArray()).toEqual([20, 30, 40, 50, 99]);
    });

    it("an out-of-order insert lands in order and evicts the oldest", () => {
      const middle = full();
      middle.insertAt(3, 99);
      expect(middle.toArray()).toEqual([20, 30, 99, 40, 50]);

      const second = full();
      second.insertAt(1, 99);
      expect(second.toArray()).toEqual([99, 20, 30, 40, 50]);
    });

    it("an item older than everything retained is dropped", () => {
      const buffer = full();
      buffer.insertAt(0, 99);
      expect(buffer.toArray()).toEqual([10, 20, 30, 40, 50]);
    });

    it("works after the buffer has wrapped around", () => {
      const wrapped = new RingBuffer<number>(5);
      [1, 2, 3, 4, 5, 6, 7].forEach((value) => wrapped.push(value)); // logical [3,4,5,6,7]
      wrapped.insertAt(5, 99);
      expect(wrapped.toArray()).toEqual([4, 5, 6, 7, 99]);

      const again = new RingBuffer<number>(5);
      [1, 2, 3, 4, 5, 6, 7].forEach((value) => again.push(value));
      again.insertAt(3, 99);
      expect(again.toArray()).toEqual([4, 5, 99, 6, 7]);
    });
  });

  it("matches the reference model over thousands of random pushes and inserts, including wraparound", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 12345;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (const capacity of [1, 2, 3, 7, 16]) {
      const buffer = new RingBuffer<number>(capacity);
      let model: number[] = [];
      for (let step = 0; step < 4000; step += 1) {
        const value = step;
        if (random(4) === 0) {
          buffer.push(value);
          model = model.length >= capacity ? [...model.slice(1), value] : [...model, value];
        } else {
          const index = random(model.length + 2) - (random(8) === 0 ? 1 : 0); // sometimes -1 and past-the-end
          buffer.insertAt(index, value);
          model = referenceInsert(model, capacity, index, value);
        }
        expect(buffer.toArray()).toEqual(model);
        expect(buffer.length).toBe(model.length);
      }
    }
  });
});
