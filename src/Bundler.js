const fs = require('./utils/fs');
const Resolver = require('./Resolver');
const Parser = require('./Parser');
const WorkerFarm = require('./WorkerFarm');
const worker = require('./utils/promisify')(require('./worker.js'));
const Path = require('path');
const Bundle = require('./Bundle');
const {FSWatcher} = require('chokidar');
const FSCache = require('./FSCache');
const HMRServer = require('./HMRServer');
const Server = require('./Server');
const {EventEmitter} = require('events');
const Logger = require('./Logger');
const PackagerRegistry = require('./packagers');

/**
 * The Bundler is the main entry point. It resolves and loads assets,
 * creates the bundle tree, and manages the worker farm, cache, and file watcher.
 */
class Bundler extends EventEmitter {
  constructor(main, options = {}) {
    super();
    this.mainFile = Path.resolve(main || '');
    this.options = this.normalizeOptions(options);

    this.resolver = new Resolver(this.options);
    this.parser = new Parser(this.options);
    this.packagers = new PackagerRegistry;
    this.cache = this.options.cache ? new FSCache(this.options) : null;
    this.logger = new Logger(this.options);
    this.delegate = options.delegate || {};

    this.pending = true;
    this.loadedAssets = new Map;
    this.farm = null;
    this.watcher = null;
    this.hmr = null;
    this.bundleHashes = null;
    this.errored = false;
  }

  normalizeOptions(options) {
    const isProduction = options.production || process.env.NODE_ENV === 'production';
    const publicURL = options.publicURL || '/' + Path.basename(options.outDir || 'dist');
    const watch = typeof options.watch === 'boolean' ? options.watch : !isProduction;
    return {
      outDir: Path.resolve(options.outDir || 'dist'),
      publicURL: publicURL,
      watch: watch,
      cache: typeof options.cache === 'boolean' ? options.cache : true,
      killWorkers: typeof options.killWorkers === 'boolean' ? options.killWorkers : true,
      minify: typeof options.minify === 'boolean' ? options.minify : isProduction,
      hmr: typeof options.hmr === 'boolean' ? options.hmr : watch,
      logLevel: typeof options.logLevel === 'number' ? options.logLevel : 3
    };
  }

  addAssetType(extension, path) {
    if (typeof path !== 'string') {
      throw new Error('Asset type should be a module path.');
    }

    if (this.farm) {
      throw new Error('Asset types must be added before bundling.');
    }

    this.parser.registerExtension(extension, path);
  }

  addPackager(type, packager) {
    if (this.farm) {
      throw new Error('Packagers must be added before bundling.');
    }

    this.packagers.add(type, packager);
  }

  async bundle() {
    this.options.extensions = Object.assign({}, this.parser.extensions);
    this.farm = WorkerFarm.getShared(this.options);

    if (this.options.watch) {
      this.watcher = new FSWatcher;
      this.watcher.on('change', this.onChange.bind(this));
    }

    if (this.options.hmr) {
      this.hmr = new HMRServer;
      this.options.hmrPort = this.hmr.port;
    }

    this.logger.status('⏳', 'Building...');

    try {
      await fs.mkdirp(this.options.outDir);

      this.mainAsset = await this.resolveAsset(this.mainFile);
      return await this.buildAsset(this.mainAsset, true);
    } catch (err) {
      this.errored = true;
      this.logger.error(err);
    } finally {
      if (!this.watcher && this.options.killWorkers) {
        this.stop();
      }
    }
  }

  stop() {
    if (this.farm) {
      this.farm.end();
    }

    if (this.watcher) {
      this.watcher.close();
    }

    if (this.hmr) {
      this.hmr.stop();
    }
  }

  async buildAsset(asset, isInitialBundle = false) {
    let startTime = Date.now();
    this.pending = true;
    this.errored = false;

    // Invalidate the asset, unless this is the initial bundle
    if (!isInitialBundle) {
      asset.invalidate();
      if (this.cache) {
        this.cache.invalidate(asset.name);
      }
    }

    // Load the asset, and its dependencies
    await this.loadAsset(asset);

    // Emit an HMR update for any new assets (that don't have a parent bundle yet)
    // plus the asset that actually changed.
    if (this.hmr && !isInitialBundle) {
      let assets = [...this.findOrphanAssets(), asset];
      this.hmr.emitUpdate(assets);
    }

    // Invalidate bundles
    for (let asset of this.loadedAssets.values()) {
      asset.invalidateBundle();
    }

    // Create a new bundle tree and package everything up.
    let bundle = this.createBundleTree(this.mainAsset);
    this.bundleHashes = await bundle.package(this, this.bundleHashes);

    // Unload any orphaned assets
    this.unloadOrphanedAssets();

    this.pending = false;
    this.emit('bundled', bundle);

    let buildTime = Date.now() - startTime;
    let time = buildTime < 1000 ? `${buildTime}ms` : `${(buildTime / 1000).toFixed(2)}s`;
    this.logger.status('✨', `Built in ${time}.`, 'green');

    return bundle;
  }

  async resolveAsset(name, parent) {
    let {path, pkg} = await this.resolver.resolve(name, parent);
    if (this.loadedAssets.has(path)) {
      return this.loadedAssets.get(path);
    }

    let asset = this.parser.getAsset(path, pkg, this.options);
    this.loadedAssets.set(path, asset);

    if (this.watcher) {
      this.watcher.add(path);
    }

    return asset;
  }

  async resolveDep(asset, dep) {
    try {
      return await this.resolveAsset(dep.name, asset.name);
    } catch (err) {
      err.message = `Cannot resolve dependency '${dep.name}'`;

      // Generate a code frame where the dependency was used
      if (dep.loc) {
        await asset.loadIfNeeded();
        err.loc = dep.loc;
        err = asset.generateErrorMessage(err);
      }

      err.fileName = asset.name;
      throw err;
    }
  }

  async loadAsset(asset) {
    if (asset.processed) {
      return;
    }

    if (!this.errored) {
      this.logger.status('⏳', `Building ${asset.basename}...`);
    }

    // Mark the asset processed so we don't load it twice
    asset.processed = true;

    // First try the cache, otherwise load and compile in the background
    let processed = this.cache && await this.cache.read(asset.name);
    if (!processed) {
      processed = await this.farm.run(asset.name, asset.package, this.options);
      if (this.cache) {
        this.cache.write(asset.name, processed);
      }
    }

    asset.generated = processed.generated;
    asset.hash = processed.hash;

    // Call the delegate to get implicit dependencies
    let dependencies = processed.dependencies;
    if (this.delegate.getImplicitDependencies) {
      let implicitDeps = await this.delegate.getImplicitDependencies(asset);
      if (implicitDeps) {
        dependencies = dependencies.concat(implicitDeps);
      }
    }

    // Process asset dependencies
    await Promise.all(dependencies.map(async dep => {
      let assetDep = await this.resolveDep(asset, dep);
      if (dep.includedInParent) {
        // This dependency is already included in the parent's generated output,
        // so no need to load it. We map the name back to the parent asset so
        // that changing it triggers a recompile of the parent.
        this.loadedAssets.set(dep.name, asset);
      } else {
        asset.dependencies.set(dep.name, dep);
        asset.depAssets.set(dep.name, assetDep);
        await this.loadAsset(assetDep);
      }
    }));
  }

  createBundleTree(asset, dep, bundle) {
    if (dep) {
      asset.parentDeps.add(dep);
    }

    if (asset.parentBundle) {
      // If the asset is already in a bundle, it is shared. Move it to the lowest common ancestor.
      if (asset.parentBundle !== bundle) {
        let commonBundle = bundle.findCommonAncestor(asset.parentBundle);
        if (asset.parentBundle !== commonBundle && asset.parentBundle.type === commonBundle.type) {
          this.moveAssetToBundle(asset, commonBundle);
        }
      }

      return;
    }

    // Create the root bundle if it doesn't exist
    if (!bundle) {
      bundle = new Bundle(asset.type, Path.join(this.options.outDir, asset.generateBundleName(true)));
      bundle.entryAsset = asset;
    }

    // Create a new bundle for dynamic imports
    if (dep && dep.dynamic) {
      bundle = bundle.createChildBundle(asset.type, Path.join(this.options.outDir, asset.generateBundleName()));
      bundle.entryAsset = asset;
    }

    // Add the asset to the bundle of the asset's type
    bundle.getSiblingBundle(asset.type).addAsset(asset);

    // If the asset generated a representation for the parent bundle type, also add it there
    if (asset.generated[bundle.type] != null) {
      bundle.addAsset(asset);
    }

    asset.parentBundle = bundle;

    for (let dep of asset.dependencies.values()) {
      let assetDep = asset.depAssets.get(dep.name);
      this.createBundleTree(assetDep, dep, bundle);
    }

    return bundle;
  }

  moveAssetToBundle(asset, commonBundle) {
    for (let bundle of Array.from(asset.bundles)) {
      bundle.removeAsset(asset);
      commonBundle.getSiblingBundle(bundle.type).addAsset(asset);
    }

    let oldBundle = asset.parentBundle;
    asset.parentBundle = commonBundle;

    // Move all dependencies as well
    for (let child of asset.depAssets.values()) {
      if (child.parentBundle === oldBundle) {
        this.moveAssetToBundle(child, commonBundle);
      }
    }
  }

  *findOrphanAssets() {
    for (let asset of this.loadedAssets.values()) {
      if (!asset.parentBundle) {
        yield asset;
      }
    }
  }

  unloadOrphanedAssets() {
    for (let asset of this.findOrphanAssets()) {
      this.unloadAsset(asset);
    }
  }

  unloadAsset(asset) {
    this.loadedAssets.delete(asset.name);
    if (this.watcher) {
      this.watcher.unwatch(asset.name);
    }
  }

  async onChange(path) {
    let asset = this.loadedAssets.get(path);
    if (!asset) {
      return;
    }

    this.logger.clear();
    this.logger.status('⏳', `Rebuilding ${path}...`);

    try {
      await this.buildAsset(asset);
    } catch (err) {
      this.errored = true;
      this.logger.error(err);
    }
  }

  middleware() {
    return Server.middleware(this);
  }

  serve(port = 1234) {
    this.logger.persistent('Server running at ' + this.logger.chalk.cyan(`http://localhost:${port}`));
    this.bundle();
    return Server.serve(this, port);
  }
}

module.exports = Bundler;
