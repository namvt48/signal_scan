import { buildSpecs } from './spec.js';
import { LimiterRegistry } from './registry.js';
import { config } from '../config.js';

export const limiters = new LimiterRegistry(buildSpecs(config.gmgnPlanWeight));
export type { RunOpts, Priority } from './types.js';
