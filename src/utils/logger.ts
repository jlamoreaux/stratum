import pino from 'pino';

export interface LoggerContext {
  requestId?: string | undefined;
  userId?: string | undefined;
  path?: string | undefined;
  method?: string | undefined;
  [key: string]: unknown | undefined;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface Logger {
  trace: (msg: string, meta?: Record<string, unknown>) => void;
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, error?: Error, meta?: Record<string, unknown>) => void;
  fatal: (msg: string, error?: Error, meta?: Record<string, unknown>) => void;
  child: (context: LoggerContext) => Logger;
}

export function createLogger(context: LoggerContext = {}): Logger {
  const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
    base: {
      service: 'stratum',
      ...context,
    },
  });

  return {
    trace: (msg, meta) => logger.trace(meta || {}, msg),
    debug: (msg, meta) => logger.debug(meta || {}, msg),
    info: (msg, meta) => logger.info(meta || {}, msg),
    warn: (msg, meta) => logger.warn(meta || {}, msg),
    error: (msg, error, meta) => logger.error({ err: error, ...meta }, msg),
    fatal: (msg, error, meta) => logger.fatal({ err: error, ...meta }, msg),
    child: (childContext) => createLogger({ ...context, ...childContext }),
  };
}

export const defaultLogger = createLogger();
