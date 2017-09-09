const Asset = require('../Asset');
const posthtml = require('posthtml');
const parse = require('posthtml-parser');
const api = require('posthtml/lib/api');
const path = require('path');
const md5 = require('../utils/md5');
const render = require('posthtml-render');
const posthtmlTransform = require('../transforms/posthtml');

// A list of all attributes that should produce a dependency
// Based on https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes
const ATTRS = {
  src: ['script', 'img', 'audio', 'video', 'source', 'track', 'iframe', 'embed'],
  href: ['link', 'a'],
  poster: ['video']
};

class HTMLAsset extends Asset {
  constructor(name, pkg, options) {
    super(name, pkg, options);
    this.type = 'html';
    this.isAstDirty = false;
  }

  parse(code) {
    let res = parse(code);
    res.walk = api.walk;
    res.match = api.match;
    return res;
  }

  collectDependencies() {
    this.ast.walk(node => {
      if (node.attrs) {
        for (let attr in node.attrs) {
          let elements = ATTRS[attr];
          if (elements && elements.includes(node.tag)) {
            node.attrs[attr] = this.addURLDependency(node.attrs[attr]);
            this.isAstDirty = true;
          }
        }
      }

      return node;
    });
  }

  async transform() {
    await posthtmlTransform(this);
  }

  generate() {
    let html = this.isAstDirty ? render(this.ast) : this.contents;
    return {html};
  }
}

module.exports = HTMLAsset;
