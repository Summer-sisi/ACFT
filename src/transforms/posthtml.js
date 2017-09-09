const loadPlugins = require('../utils/loadPlugins');
const posthtml = require('posthtml');
const Config = require('../utils/config');

module.exports = async function (asset) {
  let config = await getConfig(asset);
  if (!config) {
    return;
  }

  await asset.parseIfNeeded();
  let res = await posthtml(config.plugins).process(asset.ast, config);

  asset.ast = res.tree;
  asset.isAstDirty = true;
}

async function getConfig(asset) {
  let config = asset.package.posthtml || await Config.load(asset.name, ['.posthtmlrc', '.posthtmlrc.js', 'posthtml.config.js']);
  if (!config) {
    return;
  }

  config = config || {};
  config.plugins = loadPlugins(config.plugins, asset.name);
  config.skipParse = true;
  return config;
}
