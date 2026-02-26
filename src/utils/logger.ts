import { featureFlags } from '../config/feature-flags';
import { getRequestContext } from './request-context';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogMeta = Record<string, unknown> | undefined;

const shouldUseStructuredLogging = (): boolean => featureFlags.structuredLogging;

const emitStructuredLog = (level: LogLevel, message: string, meta?: LogMeta): void => {
  const context = getRequestContext();
  const payload: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };

  if (context) {
    payload.requestId = context.requestId;
    payload.source = context.source;
    if (context.path) payload.path = context.path;
    if (context.socketId) payload.socketId = context.socketId;
  }

  if (meta && Object.keys(meta).length > 0) {
    payload.meta = meta;
  }

  const line = JSON.stringify(payload);
  if (level === 'error') {
    console.error(line);
    return;
  }
  if (level === 'warn') {
    console.warn(line);
    return;
  }
  console.log(line);
};

const emitFallbackLog = (level: LogLevel, message: string, meta?: LogMeta): void => {
  const method = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  method(message, meta ?? {});
};

const log = (level: LogLevel, message: string, meta?: LogMeta): void => {
  if (shouldUseStructuredLogging()) {
    emitStructuredLog(level, message, meta);
    return;
  }
  emitFallbackLog(level, message, meta);
};

export const logger = {
  debug: (message: string, meta?: LogMeta): void => log('debug', message, meta),
  info: (message: string, meta?: LogMeta): void => log('info', message, meta),
  warn: (message: string, meta?: LogMeta): void => log('warn', message, meta),
  error: (message: string, meta?: LogMeta): void => log('error', message, meta),
};

