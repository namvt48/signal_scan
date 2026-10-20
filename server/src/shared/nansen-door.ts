import { HttpError } from '../ratelimit/types.js';

export type DoorClassification = 'ok' | 'throttle' | 'interstitial' | 'real403' | '5xx' | 'transport' | 'unavailable';

const CLASSIFICATIONS: Record<DoorClassification, true> = {
  ok: true,
  throttle: true,
  interstitial: true,
  real403: true,
  '5xx': true,
  transport: true,
  unavailable: true,
};

export function parseDoorClassification(value: unknown): DoorClassification | null {
  return typeof value === 'string' && value in CLASSIFICATIONS ? value as DoorClassification : null;
}

export class NansenDoorError extends HttpError {
  readonly transient: boolean;

  constructor(status: number, readonly classification: DoorClassification) {
    super(status, null, `nansen door ${classification} ${status}`);
    this.name = 'NansenDoorError';
    this.transient = classification === 'interstitial' || classification === 'transport' || classification === 'throttle' || classification === '5xx' || classification === 'unavailable';
  }
}
