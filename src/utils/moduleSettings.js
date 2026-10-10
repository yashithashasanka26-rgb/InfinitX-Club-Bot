function isModuleEnabled(config, moduleName) {
  const modules = config?.modules;
  if (modules instanceof Map) return modules.get(moduleName) === true;
  return modules?.[moduleName] === true;
}

function isModuleDisabled(config, moduleName) {
  const modules = config?.modules;
  if (modules instanceof Map) return modules.has(moduleName) && modules.get(moduleName) === false;
  return Boolean(modules && Object.hasOwn(modules, moduleName) && modules[moduleName] === false);
}

module.exports = { isModuleDisabled, isModuleEnabled };
