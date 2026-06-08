const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, '../src/server.ts');
const outPath = path.join(__dirname, '../src/bootstrap/metrics-handler.ts');
const lines = fs.readFileSync(serverPath, 'utf8').split(/\r?\n/);
const body = lines
  .slice(286, 947)
  .join('\n')
  .replace(
    "app.get('/metrics', async (req, res) => {",
    'export async function metricsRequestHandler(req: express.Request, res: express.Response): Promise<void> {',
  );

const header = `import express from 'express';
import { isRedisConfigured, getRedis, metricsKey } from '../config/redis';
import { mongoPoolMonitor } from '../utils/mongo-pool-monitor';
import { getRequestQueueStats } from '../middlewares/request-queue.middleware';
import { getDriverMetrics } from '../utils/driver-metrics';
import { monitoring } from '../utils/monitoring';
import { logError } from '../utils/logger';

`;

const footer = `

export function registerMetricsRoute(app: express.Application): void {
  app.get('/metrics', metricsRequestHandler);
}
`;

fs.writeFileSync(outPath, header + body + footer);
console.log('Wrote', outPath);
