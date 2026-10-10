function attachShutdown(client, closeDatabase) {
  const cleanupTasks = new Set();
  let shutdownPromise;
  let shuttingDown = false;

  client.addCleanupTask = (cleanup) => {
    if (shuttingDown) throw new Error('Cannot register cleanup after shutdown has started.');
    if (typeof cleanup !== 'function') throw new TypeError('Cleanup task must be a function.');
    cleanupTasks.add(cleanup);
    return () => cleanupTasks.delete(cleanup);
  };

  client.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    shutdownPromise = (async () => {
      const errors = [];
      for (const cleanup of cleanupTasks) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await client.destroy();
      } catch (error) {
        errors.push(error);
      }
      try {
        await closeDatabase();
      } catch (error) {
        errors.push(error);
      }
      cleanupTasks.clear();
      if (errors.length) throw new AggregateError(errors, 'Bot shutdown completed with cleanup errors.');
    })();
    return shutdownPromise;
  };

  return client;
}

module.exports = { attachShutdown };
