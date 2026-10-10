const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = process.env.LOG_LEVEL || 'info';
const threshold = levels[configuredLevel] ?? levels.info;

function write(level, message, details) {
  if (levels[level] > threshold) return;
  const entry = { time: new Date().toISOString(), level, message };
  if (details !== undefined) entry.details = details;
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
}

module.exports = Object.fromEntries(
  Object.keys(levels).map((level) => [level, (message, details) => write(level, message, details)]),
);
