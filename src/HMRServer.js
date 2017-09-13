const WebSocket = require('ws');
const getPackager = require('./packagers');
const path = require('path');

class HMRServer {
  constructor() {
    this.wss = new WebSocket.Server({port: 5555});
  }

  emitUpdate(assets) {
    let msg = JSON.stringify({
      type: 'update',
      assets: assets.map(asset => {
        let deps = {};
        for (let dep of asset.dependencies.values()) {
          let mod = asset.depAssets.get(dep.name);
          deps[dep.name] = mod.id;
        }

        return {
          id: asset.id,
          generated: asset.generated,
          deps: deps
        };
      })
    });

    for (let ws of this.wss.clients) {
      ws.send(msg);
    }
  }
}

module.exports = HMRServer;
