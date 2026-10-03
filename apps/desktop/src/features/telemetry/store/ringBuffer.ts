/**
 * Fixed-capacity ring buffer with the few operations the telemetry store needs:
 * append, indexed read, sorted-position search and positional insert. Extracted
 * unchanged from `telemetryStore.ts` so it can be tested and benchmarked on its own.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private start = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.slots = new Array(capacity);
  }

  push(item: T): void {
    const index = (this.start + this.count) % this.capacity;
    this.slots[index] = item;
    if (this.count < this.capacity) this.count += 1;
    else this.start = (this.start + 1) % this.capacity;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  toArray(): T[] {
    const out = new Array<T>(this.count);
    for (let index = 0; index < this.count; index += 1) {
      out[index] = this.slots[(this.start + index) % this.capacity] as T;
    }
    return out;
  }

  get length(): number {
    return this.count;
  }

  get(index: number): T | undefined {
    if (index < 0 || index >= this.count) return undefined;
    return this.slots[(this.start + index) % this.capacity] as T;
  }

  /** Upper-bound binary search: first logical index whose `key` exceeds `target`, assuming the buffer is already sorted ascending by `key`. Ties land after existing equal-key entries (stable). */
  upperBound(key: (item: T) => number, target: number): number {
    let lo = 0;
    let hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (key(this.get(mid) as T) <= target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Inserts `item` at logical `index`, shifting later elements right; `index`
   * past the end appends. At capacity the oldest element (index 0) is evicted
   * to make room, i.e. the result is "insert, then drop the front". An item that
   * would land at index 0 of a full buffer is older than everything retained and
   * is dropped.
   *
   * An in-order append (the overwhelmingly common case) is exactly `push`, so it
   * must not pay for a shift: at 200,000 rows a shifting append cost ~450 us
   * against ~0.1 us for `push`. An out-of-order insert only moves the elements
   * after it, so it costs in proportion to how far from the end it lands.
   */
  insertAt(index: number, item: T): void {
    if (index >= this.count) {
      this.push(item);
      return;
    }
    const at = Math.max(0, index);
    if (this.count < this.capacity) {
      for (let i = this.count; i > at; i -= 1) {
        this.slots[(this.start + i) % this.capacity] = this.slots[(this.start + i - 1) % this.capacity];
      }
      this.slots[(this.start + at) % this.capacity] = item;
      this.count += 1;
      return;
    }
    if (at === 0) return; // older than everything retained: evicted straight away
    // Full: evict the oldest by advancing `start`. Every remaining element is then
    // already at its new logical position except that the ones from `at` onward must
    // each move one place later to open a slot at `at - 1` (the freed physical slot
    // becomes the new last position).
    this.start = (this.start + 1) % this.capacity;
    for (let i = this.capacity - 1; i >= at; i -= 1) {
      this.slots[(this.start + i) % this.capacity] = this.slots[(this.start + i - 1) % this.capacity];
    }
    this.slots[(this.start + at - 1) % this.capacity] = item;
  }
}
