import { parentPort } from 'node:worker_threads';
import { config } from './config.js';
import { getDb, openReadOnly } from './db.js';
import { exportFomoTokens } from './public-export.js';
import { assembleSignals } from './signals.js';

if (!parentPort) throw new Error('snapshot worker requires parent port');

try {
  openReadOnly(config.dbPath, config.marketDbPath);
  const snapshot = getDb().transaction(() => {
    const generatedAt = Date.now();
    const signals = assembleSignals(generatedAt, true);
    const { tokens: fomoTokens } = exportFomoTokens(generatedAt, signals);
    const tokens = fomoTokens.map(({ fomoUsers: _fomoUsers, ...token }) => token);
    return { generatedAt, tokens, fomoTokens };
  })();
  parentPort.postMessage(snapshot);
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
