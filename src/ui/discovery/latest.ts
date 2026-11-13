/** Request counter: an async answer is applied only if no newer request was started meanwhile (a stale response never overwrites a newer one). */
export class LatestGuard {
  private n = 0;
  next(): number { return ++this.n; }
  isCurrent(token: number): boolean { return token === this.n; }
  /** Invalidate every request in flight. */
  cancel(): void { this.n++; }
}
