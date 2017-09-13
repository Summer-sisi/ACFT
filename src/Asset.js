const Parser = require('./Parser');
const path = require('path');
const fs = require('./utils/fs');
const crypto = require('crypto');
const md5 = require('./utils/md5');

const PROTOCOL_RE = /^[a-z]+:/;

let ASSET_ID = 1;

/**
 * An Asset represents a file in the dependency tree. Assets can have multiple
 * parents that depend on it, and can be added to multiple output bundles.
 * The base Asset class doesn't to much by itself, but sets up an interface
 * for subclasses to implement.
 */
class Asset {
  constructor(name, pkg, options) {
    this.id = ASSET_ID++;
    this.name = name;
    this.basename = path.basename(this.name);
    this.package = pkg;
    this.options = options;
    this.encoding = 'utf8';
    this.type = path.extname(this.name).slice(1);

    this.processed = false;
    this.contents = null;
    this.ast = null;
    this.generated = null;
    this.hash = null;
    this.parentDeps = new Set;
    this.dependencies = new Map;
    this.depAssets = new Map;
    this.parentBundle = null;
    this.bundles = new Set;
  }

  async loadIfNeeded() {
    if (this.contents == null) {
      this.contents = await this.load();
    }
  }

  async parseIfNeeded() {
    await this.loadIfNeeded();
    if (!this.ast) {
      this.ast = await this.parse(this.contents);
    }
  }

  async getDependencies() {
    await this.loadIfNeeded();

    if (this.mightHaveDependencies()) {
      await this.parseIfNeeded();
      this.collectDependencies();
    }
  }

  addDependency(name, opts) {
    this.dependencies.set(name, Object.assign({name}, opts));
  }

  addURLDependency(url, from = this.name) {
    if (!url || PROTOCOL_RE.test(url)) {
      return url;
    }

    let resolved = path.resolve(path.dirname(from), url);
    this.addDependency('./' + path.relative(path.dirname(this.name), resolved), {dynamic: true});
    return md5(resolved) + path.extname(url);
  }

  mightHaveDependencies() {
    return true;
  }

  async load() {
    return await fs.readFile(this.name, this.encoding);
  }

  parse() {
    // do nothing by default
  }

  collectDependencies() {
    // do nothing by default
  }

  async transform() {
    // do nothing by default
  }

  generate() {
    return {
      [this.type]: this.contents,
      js: `module.exports = ${JSON.stringify(md5(this.name) + path.extname(this.name))};`
    };
  }

  async process() {
    if (!this.generated) {
      await this.getDependencies();
      await this.transform();
      this.generated = this.generate();
      this.hash = this.generateHash();
    }

    return this.generated;
  }

  generateHash() {
    let hash = crypto.createHash('md5');
    for (let key in this.generated) {
      hash.update(this.generated[key]);
    }

    return hash.digest('hex');
  }

  invalidate() {
    this.processed = false;
    this.contents = null;
    this.ast = null;
    this.generated = null;
    this.hash = null;
    this.dependencies.clear();
    this.depAssets.clear();
  }

  invalidateBundle() {
    this.parentBundle = null;
    this.bundles.clear();
    this.parentDeps.clear();
  }
}

module.exports = Asset;
