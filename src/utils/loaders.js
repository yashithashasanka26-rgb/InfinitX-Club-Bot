const fs = require('node:fs');
const path = require('node:path');

function loadModules(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => require(path.join(directory, entry.name)));
}

module.exports = { loadModules };
