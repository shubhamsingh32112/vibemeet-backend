import express from 'express';
import { createServer, type Server as HttpServer } from 'http';
import type { Server } from 'socket.io';
import { registerHealthRoutes } from './health-routes';
import { registerMetricsRoute } from './metrics-handler';
import { initializeHeadlessSocketIo } from './bootstrap-socket';
import { getServiceRole } from '../config/service-role';
import { logInfo } from '../utils/logger';

export type WorkerHealthServer = {
  httpServer: HttpServer;
  io: Server | null;
};

export function createWorkerHealthApp(options?: { includeMetrics?: boolean }): express.Application {
  const workerApp = express();
  registerHealthRoutes(workerApp);
  if (options?.includeMetrics) {
    registerMetricsRoute(workerApp);
  }
  return workerApp;
}

export function createWorkerHealthServer(options?: {
  includeMetrics?: boolean;
  headlessSocket?: boolean;
}): WorkerHealthServer {
  const workerApp = createWorkerHealthApp(options);
  const httpServer = createServer(workerApp);
  let io: Server | null = null;
  if (options?.headlessSocket) {
    io = initializeHeadlessSocketIo(httpServer);
  }
  return { httpServer, io };
}

export function listenWorkerHealthServer(
  httpServer: HttpServer,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    httpServer.listen(port, '0.0.0.0', () => {
      logInfo('Worker health server started', {
        port,
        interface: '0.0.0.0',
        serviceRole: getServiceRole(),
      });
      resolve();
    });
    httpServer.on('error', reject);
  });
}
