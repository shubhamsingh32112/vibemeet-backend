/**
 * 🔥 FIX 46: Structured Logging Strategy (Production Optimized)
 * 
 * Replaces console.log with structured logging using Winston.
 * Optimized for production deployment with 200-300 creators and 1000 users/day.
 * 
 * Production optimizations:
 * - File logging disabled on Railway (they have built-in log aggregation)
 * - Reduced log retention periods
 * - Efficient console output (JSON in production)
 * - Respects LOG_LEVEL environment variable
 * - Minimal overhead for high-traffic scenarios
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import fs from 'fs';

// Environment detection
const isDevelopment = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV;
const isProduction = process.env.NODE_ENV === 'production';
// Railway and most cloud platforms have built-in log aggregation, so file logging is redundant
// Set ENABLE_FILE_LOGGING=true if you need local file logs (e.g., for debugging)
const enableFileLogging = process.env.ENABLE_FILE_LOGGING === 'true' || isDevelopment;

// Ensure logs directory exists only if file logging is enabled
let logsDir: string | null = null;
if (enableFileLogging) {
  logsDir = path.join(process.cwd(), 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
}

// Log levels
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
};

// Log level colors
const colors = {
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
};

winston.addColors(colors);

// Custom format for structured logging (production)
const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
  winston.format.errors({ stack: true }),
  winston.format.splat(),
  winston.format.json()
);

// Human-readable format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss.SSS' }),
  winston.format.colorize({ all: true }),
  winston.format.printf((info) => {
    const { timestamp, level, message, ...meta } = info;
    
    // Format metadata
    let metaStr = '';
    if (Object.keys(meta).length > 0) {
      // Remove internal winston fields
      const cleanMeta = { ...meta };
      delete cleanMeta[Symbol.for('level')];
      delete cleanMeta[Symbol.for('message')];
      delete cleanMeta[Symbol.for('splat')];
      
      if (Object.keys(cleanMeta).length > 0) {
        metaStr = '\n' + JSON.stringify(cleanMeta, null, 2);
      }
    }
    
    return `${timestamp} [${level}]: ${message}${metaStr}`;
  })
);

// Build transports array
const transports: winston.transport[] = [];

// File transports (only if enabled)
if (enableFileLogging && logsDir) {
  // File transport for all logs (JSON format) - reduced retention for production
  const allLogsFile = new DailyRotateFile({
    filename: path.join(logsDir, 'app-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: isProduction ? '7d' : '14d', // 7 days in production, 14 in dev
    format: logFormat,
    level: 'debug',
  });

  // File transport for error logs only - reduced retention for production
  const errorLogsFile = new DailyRotateFile({
    filename: path.join(logsDir, 'error-%DATE%.log'),
    datePattern: 'YYYY-MM-DD',
    maxSize: '20m',
    maxFiles: isProduction ? '14d' : '30d', // 14 days in production, 30 in dev
    format: logFormat,
    level: 'error',
  });

  transports.push(allLogsFile, errorLogsFile);
}

// Console transport (human-readable in development, JSON in production)
// In production, Railway/cloud platforms capture stdout/stderr, so JSON format is better
const consoleTransport = new winston.transports.Console({
  format: isDevelopment ? consoleFormat : logFormat,
  // In production, default to 'info' to reduce noise (respects LOG_LEVEL env var)
  level: isDevelopment ? 'debug' : 'info',
  // Use stderr for errors in production (better for log aggregation)
  stderrLevels: ['error'],
});

transports.push(consoleTransport);

// Determine log level from environment or default
const logLevel = process.env.LOG_LEVEL || (isDevelopment ? 'debug' : 'info');

// Create logger instance
const logger = winston.createLogger({
  levels,
  level: logLevel,
  format: logFormat,
  transports,
  // Handle exceptions and rejections
  exceptionHandlers: enableFileLogging && logsDir ? [
    new DailyRotateFile({
      filename: path.join(logsDir, 'exceptions-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: isProduction ? '14d' : '30d',
      format: logFormat,
    }),
    // Also log to console
    new winston.transports.Console({
      format: isDevelopment ? consoleFormat : logFormat,
      stderrLevels: ['error'],
    }),
  ] : [
    // Only console in production (Railway captures stderr)
    new winston.transports.Console({
      format: isDevelopment ? consoleFormat : logFormat,
      stderrLevels: ['error'],
    }),
  ],
  rejectionHandlers: enableFileLogging && logsDir ? [
    new DailyRotateFile({
      filename: path.join(logsDir, 'rejections-%DATE%.log'),
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: isProduction ? '14d' : '30d',
      format: logFormat,
    }),
    // Also log to console
    new winston.transports.Console({
      format: isDevelopment ? consoleFormat : logFormat,
      stderrLevels: ['error'],
    }),
  ] : [
    // Only console in production (Railway captures stderr)
    new winston.transports.Console({
      format: isDevelopment ? consoleFormat : logFormat,
      stderrLevels: ['error'],
    }),
  ],
  exitOnError: false,
});

// Log configuration on startup (only in development or if explicitly enabled)
if (isDevelopment || process.env.LOG_CONFIG === 'true') {
  logger.info('Logger initialized', {
    environment: process.env.NODE_ENV || 'development',
    logLevel,
    fileLogging: enableFileLogging,
    transports: transports.map(t => t.constructor.name),
  });
}

/**
 * Logger interface for structured logging
 * 
 * Usage:
 *   logger.error('Failed to process payment', { userId, orderId, error });
 *   logger.warn('Rate limit approaching', { userId, requests: 95 });
 *   logger.info('User logged in', { userId, email });
 *   logger.debug('Processing request', { method, path, query });
 */
export default logger;

/**
 * Helper function to create child logger with default metadata
 * Useful for module-specific logging with context
 */
export function createChildLogger(defaultMeta: Record<string, any>) {
  return logger.child(defaultMeta);
}

/**
 * Helper function for HTTP request logging
 */
export function logRequest(method: string, path: string, ip: string, meta?: Record<string, any>) {
  logger.http('HTTP Request', {
    method,
    path,
    ip,
    ...meta,
  });
}

/**
 * Helper function for HTTP response logging
 */
export function logResponse(method: string, path: string, statusCode: number, duration: number, meta?: Record<string, any>) {
  logger.http('HTTP Response', {
    method,
    path,
    statusCode,
    duration,
    ...meta,
  });
}

/**
 * Helper function for error logging with context
 */
export function logError(message: string, error: Error | unknown, context?: Record<string, any>) {
  const errorDetails = error instanceof Error 
    ? { message: error.message, stack: error.stack, name: error.name }
    : { error };
    
  logger.error(message, {
    ...errorDetails,
    ...context,
  });
}

/**
 * Helper function for warning logging
 */
export function logWarning(message: string, context?: Record<string, any>) {
  logger.warn(message, context);
}

/**
 * Helper function for info logging
 */
export function logInfo(message: string, context?: Record<string, any>) {
  logger.info(message, context);
}

/**
 * Helper function for debug logging
 */
export function logDebug(message: string, context?: Record<string, any>) {
  logger.debug(message, context);
}
