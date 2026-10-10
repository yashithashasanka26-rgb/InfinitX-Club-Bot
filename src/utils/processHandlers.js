function attachProcessHandlers(client, { processEmitter = process, logger }) {
  let shutdownPromise;
  let exitCode = 0;

  const beginShutdown = (reason, fatal = false) => {
    if (fatal) exitCode = 1;
    if (reason) logger.info(`Received ${reason}; shutting down bot`);
    if (!shutdownPromise) {
      shutdownPromise = Promise.resolve()
        .then(() => client.shutdown())
        .catch((error) => {
          exitCode = 1;
          logger.error('Bot shutdown failed', { error: error.message });
        })
        .then(() => {
          processEmitter.exitCode = exitCode;
        });
    }
    return shutdownPromise;
  };

  const onSignal = (signal) => {
    void beginShutdown(signal);
  };
  const onUncaughtException = (error) => {
    logger.error('Uncaught exception; bot will shut down', {
      name: error.name,
      error: error.message,
      stack: error.stack,
    });
    void beginShutdown('uncaught exception', true);
  };
  const onUnhandledRejection = (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled promise rejection; bot will shut down', {
      name: error.name,
      error: error.message,
      stack: error.stack,
    });
    void beginShutdown('unhandled promise rejection', true);
  };

  processEmitter.on('SIGINT', onSignal);
  processEmitter.on('SIGTERM', onSignal);
  processEmitter.on('uncaughtException', onUncaughtException);
  processEmitter.on('unhandledRejection', onUnhandledRejection);

  return () => {
    processEmitter.removeListener('SIGINT', onSignal);
    processEmitter.removeListener('SIGTERM', onSignal);
    processEmitter.removeListener('uncaughtException', onUncaughtException);
    processEmitter.removeListener('unhandledRejection', onUnhandledRejection);
  };
}

module.exports = { attachProcessHandlers };
