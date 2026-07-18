/**
 * Entry point: load .env + config, wire up store/Linear/Discord, start the
 * bot, and shut down cleanly on SIGINT/SIGTERM.
 */
import 'dotenv/config';
import { loadConfig, ConfigError } from './config.js';
import { logger } from './logger.js';
import { ProcessedStore } from './store.js';
import { LinearService } from './linear.js';
import { createBot } from './discord.js';

async function main() {
  let config;
  try {
    config = loadConfig(process.argv[2]); // optional CLI arg: path to config.yml
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal(`\n${err.message}`);
      process.exit(1);
    }
    throw err;
  }

  const forumCount = config.guilds.reduce((n, g) => n + g.forums.length, 0);
  logger.info({ guilds: config.guilds.length, forums: forumCount }, 'Configuration loaded');

  const store = new ProcessedStore(config.store.path);
  await store.load();

  const linear = new LinearService(config.linear.apiKey);
  try {
    await linear.verifyAuth();
  } catch (err) {
    logger.fatal({ err: err.message }, 'Linear authentication failed; check LINEAR_API_KEY');
    process.exit(1);
  }

  const bot = createBot({ config, store, linear });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) {
      // A second signal while a graceful shutdown is hanging: force-exit now
      // (registering our own handler removed Node's default terminate-on-signal).
      logger.warn({ signal }, 'Received a second shutdown signal; forcing exit');
      process.exit(130);
    }
    shuttingDown = true;
    logger.info({ signal }, 'Shutting down');
    try {
      await bot.stop();
      await store.flush();
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Last-resort safety nets: log, do not crash the whole bot on a stray
  // rejection from a third-party lib; uncaught exceptions still exit.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Uncaught exception; exiting');
    process.exit(1);
  });

  await bot.start();
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
