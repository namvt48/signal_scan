import { buildSpecs } from './spec.js';
import { LimiterRegistry } from './registry.js';
import { config } from '../config.js';

export const limiters = new LimiterRegistry(
  buildSpecs(config.gmgnPlanWeight, config.gmgnApiKeys.length, config.gmgnPlanWeights),
);
export type { RunOpts, Priority } from './types.js';
