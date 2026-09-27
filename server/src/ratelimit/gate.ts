import type { GateSpec } from './types.js';

const MARGIN_MS = 2_000;

export class Gate {
  private untilMs = 0;

  constructor(
    private readonly spec: GateSpec,
    private readonly marginMs = MARGIN_MS,
  ) {}

  blocked(now: number): boolean {
    return now < this.untilMs;
  }

  get until(): number {
    return this.untilMs;
  }

  note(status: number, headerVal: string | null, now: number): void {
    const cooldown = this.spec.statusesWithCooldown?.find((s) => s.status === status);
    if (cooldown) {
      this.untilMs = now + cooldown.cooldownMs;
      return;
    }
    if (this.spec.statuses.includes(status) && this.spec.header && headerVal) {
      const sec = Number(headerVal);
      if (Number.isFinite(sec)) this.untilMs = sec * 1000 + this.marginMs;
    }
  }
}
