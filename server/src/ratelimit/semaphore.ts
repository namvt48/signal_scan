export class Semaphore {
  private inFlight = 0;

  constructor(private readonly max: number) {}

  get full(): boolean {
    return this.inFlight >= this.max;
  }

  get count(): number {
    return this.inFlight;
  }

  acquire(): void {
    this.inFlight++;
  }

  release(): void {
    if (this.inFlight > 0) this.inFlight--;
  }
}
