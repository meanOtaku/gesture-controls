/**
 * Keeps a stream of angles continuous for plotting. An angle in degrees jumps from +180 to -180 as it turns through the
 * back of the circle, which a graph draws as a sharp spike although nothing moved quickly. This adds or removes whole
 * turns of 360 so each reading stays within 180 of the one before it. Only for display: recorded values are untouched.
 * Turning round and round makes the plotted value grow past 180; that is the angle turned, and the graph rescales.
 */
export class AngleUnwrapper {
  private last: number[] | null = null;
  private turns: number[] = [];

  /** The same angles, with whole turns added so none is more than half a turn from the one before it. */
  next(angles: readonly number[]): number[] {
    const last = this.last;
    const result = angles.map((angle, index) => {
      if (!Number.isFinite(angle)) return angle;
      let turns = this.turns[index] ?? 0;
      const before = last?.[index];
      if (before !== undefined && Number.isFinite(before)) {
        const delta = angle - before;
        if (delta > 180) turns -= 360 * Math.round(delta / 360);
        else if (delta < -180) turns -= 360 * Math.round(delta / 360);
      }
      this.turns[index] = turns;
      return angle + turns;
    });
    // The next reading is compared with this one as it came in (before the turns were added).
    this.last = [...angles];
    return result;
  }

  reset(): void {
    this.last = null;
    this.turns = [];
  }
}
