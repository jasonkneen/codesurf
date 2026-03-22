/**
 * Bridge script injected into extension tile iframes.
 * Creates the window.contex API using postMessage RPC.
 *
 * Returned as a string — evaluated in the iframe context.
 */

export function getBridgeScript(tileId: string, extId: string): string {
  return `
;(function() {
  const _tileId = ${JSON.stringify(tileId)};
  const _extId = ${JSON.stringify(extId)};
  let _reqId = 0;
  const _pending = new Map();
  const _listeners = new Map();

  function _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++_reqId;
      _pending.set(id, { resolve, reject });
      window.parent.postMessage({
        type: 'contex-rpc',
        id,
        method,
        params: params ?? null,
        tileId: _tileId,
        extId: _extId,
      }, '*');
      setTimeout(() => {
        if (_pending.has(id)) {
          _pending.delete(id);
          reject(new Error('RPC timeout: ' + method));
        }
      }, 10000);
    });
  }

  function _on(event, cb) {
    if (!_listeners.has(event)) _listeners.set(event, []);
    _listeners.get(event).push(cb);
    return () => {
      const arr = _listeners.get(event);
      if (arr) {
        const idx = arr.indexOf(cb);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function _emit(event, data) {
    const cbs = _listeners.get(event);
    if (cbs) cbs.forEach(cb => { try { cb(data); } catch(e) { console.error('[contex bridge]', e); } });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    // RPC response
    if (msg.type === 'contex-rpc-response' && msg.id) {
      const p = _pending.get(msg.id);
      if (p) {
        _pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }

    // Event push from host
    if (msg.type === 'contex-event') {
      _emit(msg.event, msg.data);
      return;
    }
  });

  window.contex = {
    tileId: _tileId,
    extId: _extId,

    tile: {
      getState: () => _rpc('tile.getState'),
      setState: (data) => _rpc('tile.setState', data),
      getSize: () => _rpc('tile.getSize'),
      onResize: (cb) => _on('tile.resize', cb),
      getMeta: () => _rpc('tile.getMeta'),
    },

    bus: {
      publish: (channel, type, payload) => _rpc('bus.publish', { channel, type, payload }),
      subscribe: (channel, cb) => {
        _on('bus.event.' + channel, cb);
        _on('bus.event.*', (evt) => {
          if (evt && evt.channel === channel) cb(evt);
        });
        return _rpc('bus.subscribe', { channel });
      },
    },

    canvas: {
      createTile: (type, opts) => _rpc('canvas.createTile', { type, ...(opts || {}) }),
      listTiles: () => _rpc('canvas.listTiles'),
    },

    settings: {
      get: (key) => _rpc('settings.get', { key }),
    },

    workspace: {
      getPath: () => _rpc('workspace.getPath'),
    },

    theme: {
      getColors: () => _rpc('theme.getColors'),
      onChanged: (cb) => _on('theme.changed', cb),
    },
  };

  // Signal ready
  window.parent.postMessage({ type: 'contex-bridge-ready', tileId: _tileId, extId: _extId }, '*');
})();
`
}
