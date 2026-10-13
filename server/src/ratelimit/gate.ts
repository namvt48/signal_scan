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
      this.untilMs = Math.max(this.untilMs, now + cooldown.cooldownMs);
      return;
    }
    if (!this.spec.statuses.includes(status)) return;

    const resetSec = headerVal === null ? NaN : Number(headerVal);
    const resetMs = resetSec * 1000 + this.marginMs;
    if (Number.isFinite(resetSec) && resetMs > now) {
      this.untilMs = Math.max(this.untilMs, resetMs);
      return;
    }
    if (this.spec.fallbackCooldownMs !== undefined) {
      this.untilMs = Math.max(this.untilMs, now + this.spec.fallbackCooldownMs);
    }
  }
}
