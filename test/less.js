const assert = require('assert');
const fs = require('fs');
const {bundle, run, assertBundleTree} = require('./utils');

describe('less', function () {
  it('should support requiring less files', async function () {
    let b = await bundle(__dirname + '/integration/less/index.js');

    assertBundleTree(b, {
      name: 'index.js',
      assets: ['index.js', 'index.less'],
      childBundles: [{
        name: 'index.css',
        assets: ['index.less'],
        childBundles: []
      }]
    });

    let output = run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = fs.readFileSync(__dirname + '/dist/index.css', 'utf8');
    assert(css.includes('.index'));
  });

  it('should support less imports', async function () {
    let b = await bundle(__dirname + '/integration/less-import/index.js');

    assertBundleTree(b, {
      name: 'index.js',
      assets: ['index.js', 'index.less'],
      childBundles: [{
        name: 'index.css',
        assets: ['index.less'],
        childBundles: []
      }]
    });

    let output = run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = fs.readFileSync(__dirname + '/dist/index.css', 'utf8');
    assert(css.includes('.index'));
    assert(css.includes('.base'));
  });

  it('should support linking to assets with url() from less', async function () {
    let b = await bundle(__dirname + '/integration/less-url/index.js');

    assertBundleTree(b, {
      name: 'index.js',
      assets: ['index.js', 'index.less'],
      childBundles: [{
        name: 'index.css',
        assets: ['index.less'],
        childBundles: []
      }, {
        type: 'woff2',
        assets: ['test.woff2'],
        childBundles: []
      }]
    });

    let output = run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), 2);

    let css = fs.readFileSync(__dirname + '/dist/index.css', 'utf8');
    assert(/url\("[0-9a-f]+\.woff2"\)/.test(css));
    assert(css.includes('url("http://google.com")'));
    assert(css.includes('.index'));

    assert(fs.existsSync(__dirname + '/dist/' + css.match(/url\("([0-9a-f]+\.woff2)"\)/)[1]));
  });

  it('should support transforming less with postcss', async function () {
    let b = await bundle(__dirname + '/integration/less-postcss/index.js');

    assertBundleTree(b, {
      name: 'index.js',
      assets: ['index.js', 'index.less'],
      childBundles: [{
        name: 'index.css',
        assets: ['index.less'],
        childBundles: []
      }]
    });

    let output = run(b);
    assert.equal(typeof output, 'function');
    assert.equal(output(), '_index_ku5n8_1');

    let css = fs.readFileSync(__dirname + '/dist/index.css', 'utf8');
    assert(css.includes('._index_ku5n8_1'));
  });
});
