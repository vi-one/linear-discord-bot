/**
 * Pino logger factory.
 *
 * Pretty-prints in development (or when LOG_PRETTY=true); emits structured
 * JSON in production so logs can be shipped/parsed. Level is controlled by
 * LOG_LEVEL (default "info").
 */
import pino from 'pino';

const isProduction = process.env.NODE_ENV === 'production';
const usePretty = process.env.LOG_PRETTY === 'true' || (!isProduction && process.env.LOG_PRETTY !== 'false');

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined, // omit pid/hostname noise
  // Defense-in-depth: never let a secret slip into logs even if a future
  // change logs a config or error object that embeds one.
  redact: {
    paths: ['token', 'apiKey', '*.token', '*.apiKey', 'discord.token', 'linear.apiKey'],
    remove: true,
  },
  ...(usePretty
    ? {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname',
          },
        },
      }
    : {}),
});

/** Create a child logger tagged with a module/component name. */
export function childLogger(name) {
  return logger.child({ module: name });
}
