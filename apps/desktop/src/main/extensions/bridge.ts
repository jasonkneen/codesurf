/**
 * Bridge script injected into extension tile iframes.
 * Creates the window.codesurf API using postMessage RPC.
 *
 * Returned as a string — evaluated in the iframe context.
 */

/**
 * Capability gate (P1). When a plugin declares `capabilities`, the host records
 * the granted set at enable time; this restricts the iframe bridge so the plugin
 * only receives the namespaces it was granted. Baseline SDK namespaces (tile,
 * bus, store, settings, ext, workspace, theme, actions, context, surface) are
 * always present; only chat/relay/canvas map to gateable capabilities. Plugins
 * that declare NO capabilities are ungated (enforced:false) — no regression.
 */
export interface BridgeCapabilityGate {
  enforced: boolean
  granted: string[]
}

/** Iframe-bridge namespaces that are gated by a same-named capability. */
const CAPABILITY_GATED_NAMESPACES = ['chat', 'relay', 'canvas'] as const

/**
 * JSON is valid JavaScript syntax, but raw HTML script elements terminate at
 * `</script` before the JavaScript parser runs. Escape every HTML-significant
 * code point plus the two JavaScript line separators before embedding values.
 */
export function serializeForInlineScript(value: unknown): string {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) {
    throw new TypeError('Inline script values must be JSON-serializable')
  }
  return serialized
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029')
}

export function getBridgeScript(tileId: string, extId: string, gate?: BridgeCapabilityGate): string {
  return `
;(function() {
  const _tileId = ${serializeForInlineScript(tileId)};
  const _extId = ${serializeForInlineScript(extId)};
  let _reqId = 0;
  const _pending = new Map();
  const _listeners = new Map();
  const _actionHandlers = new Map();

  function _rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++_reqId;
      const timeoutMs = method === 'ext.invoke' ? 15 * 60 * 1000 : 10000;
      _pending.set(id, { resolve, reject });
      window.parent.postMessage({
        type: 'codesurf-rpc',
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
      }, timeoutMs);
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
    if (cbs) cbs.forEach(cb => { try { cb(data); } catch(e) { console.error('[codesurf bridge]', e); } });
  }

  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (!msg || typeof msg !== 'object') return;

    // Theme CSS variable injection from host
    if (msg.type === 'codesurf-theme-vars' && msg.vars) {
      var style = document.getElementById('__contex_theme__');
      if (!style) {
        style = document.createElement('style');
        style.id = '__contex_theme__';
        (document.head || document.documentElement).appendChild(style);
      }
      style.textContent = ':root{' + Object.entries(msg.vars).map(function(e) { return e[0]+':'+e[1]; }).join(';') + '}';
      var mode = String(msg.vars['--ct-mode'] || '').replace(/"/g, '');
      if (mode) {
        document.documentElement.setAttribute('data-ct-mode', mode);
        document.documentElement.style.colorScheme = mode;
      }
      return;
    }

    // RPC response
    if (msg.type === 'codesurf-rpc-response' && msg.id) {
      const p = _pending.get(msg.id);
      if (p) {
        _pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error));
        else p.resolve(msg.result);
      }
      return;
    }

    // Event push from host
    if (msg.type === 'codesurf-event') {
      _emit(msg.event, msg.data);
      return;
    }

    // Action invocation from a connected peer
    if (msg.type === 'codesurf-action-invoke') {
      console.log('[codesurf bridge] action invoke:', msg.action, 'registered:', Array.from(_actionHandlers.keys()));
      var handler = _actionHandlers.get(msg.action);
      if (handler) {
        Promise.resolve().then(function() { return handler(msg.params || {}); }).then(function(result) {
          window.parent.postMessage({ type: 'codesurf-action-result', requestId: msg.requestId, tileId: _tileId, result: result }, '*');
        }).catch(function(err) {
          window.parent.postMessage({ type: 'codesurf-action-result', requestId: msg.requestId, tileId: _tileId, error: err.message || String(err) }, '*');
        });
      } else {
        window.parent.postMessage({ type: 'codesurf-action-result', requestId: msg.requestId, tileId: _tileId, error: 'Unknown action: ' + msg.action }, '*');
      }
      return;
    }
  });

  window.codesurf = {
    tileId: _tileId,
    extId: _extId,

    tile: {
      getState: (key) => _rpc('tile.getState', { key: key ?? null }),
      setState: (keyOrData, maybeValue) => {
        if (typeof keyOrData === 'string') {
          return _rpc('tile.setState', { key: keyOrData, value: maybeValue });
        }
        return _rpc('tile.setState', { data: keyOrData });
      },
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
      set: (settings) => _rpc('settings.set', settings),
    },

    store: {
      get: () => _rpc('store.get'),
      set: (patch) => _rpc('store.set', { patch }),
      replace: (value) => _rpc('store.replace', { value }),
      subscribe: (cb) => {
        var _ch = 'plugin:' + _extId + ':state';
        _on('bus.event.' + _ch, function(evt) { try { cb((evt && evt.payload && evt.payload.state) || {}); } catch (e) { /* noop */ } });
        _on('bus.event.*', function(evt) { if (evt && evt.channel === _ch) { try { cb((evt.payload && evt.payload.state) || {}); } catch (e) { /* noop */ } } });
        return _rpc('bus.subscribe', { channel: _ch });
      },
    },

    ext: {
      invoke: (method, ...args) => _rpc('ext.invoke', { method, args }),
    },

    workspace: {
      getPath: () => _rpc('workspace.getPath'),
    },

    chat: {
      send: (request) => _rpc('chat.send', { request }),
      stop: (cardId) => _rpc('chat.stop', { cardId }),
      clearSession: (cardId) => _rpc('chat.clearSession', { cardId }),
      openSurface: (extIdOrRequest, maybeSurfaceId) => {
        var request = (extIdOrRequest && typeof extIdOrRequest === 'object')
          ? extIdOrRequest
          : { extId: extIdOrRequest, surfaceId: maybeSurfaceId };
        return _rpc('chat.openSurface', { request });
      },
      onStream: (cb) => _on('chat.stream', cb),
    },

    relay: {
      init: () => _rpc('relay.init'),
      listParticipants: () => _rpc('relay.listParticipants'),
      listChannels: () => _rpc('relay.listChannels'),
      listCentralFeed: (limit) => _rpc('relay.listCentralFeed', { limit }),
      listMessages: (participantId, mailbox, limit) => _rpc('relay.listMessages', { participantId, mailbox, limit }),
      readMessage: (participantId, mailbox, filename) => _rpc('relay.readMessage', { participantId, mailbox, filename }),
      sendDirectMessage: (from, draft) => _rpc('relay.sendDirectMessage', { from, draft }),
      sendChannelMessage: (from, draft) => _rpc('relay.sendChannelMessage', { from, draft }),
      setWorkContext: (participantId, work) => _rpc('relay.setWorkContext', { participantId, work }),
      analyzeRelationships: () => _rpc('relay.analyzeRelationships'),
      spawnAgent: (request) => _rpc('relay.spawnAgent', { request }),
      stopAgent: (participantId) => _rpc('relay.stopAgent', { participantId }),
      waitForReady: (ids, timeoutMs) => _rpc('relay.waitForReady', { ids, timeoutMs }),
      waitForAny: (ids, timeoutMs) => _rpc('relay.waitForAny', { ids, timeoutMs }),
      onEvent: (cb) => _on('relay.event', cb),
    },

    theme: {
      getColors: () => _rpc('theme.getColors'),
      onChanged: (cb) => {
        const offA = _on('theme.change', cb)
        const offB = _on('theme.changed', cb)
        return () => { offA(); offB(); }
      },
    },

    actions: {
      register: (name, description, handler) => {
        _actionHandlers.set(name, handler);
        return _rpc('actions.register', { name, description: description || '' });
      },
      invoke: (peerId, action, params) => _rpc('actions.invoke', { peerId, action, params: params || {} }),
      list: () => Array.from(_actionHandlers.keys()),
    },

    context: {
      get: (key) => _rpc('context.get', { key }),
      set: (key, value) => _rpc('context.set', { key, value }),
      getAll: (tagPrefix) => _rpc('context.getAll', { tagPrefix }),
      delete: (key) => _rpc('context.delete', { key }),
      getPeerContext: (peerId, tagPrefix) => _rpc('context.getPeerContext', { peerId, tagPrefix }),
      getAllPeerContext: (tagPrefix) => _rpc('context.getAllPeerContext', { tagPrefix }),
      onChanged: (cb) => _on('context.changed', cb),
      onPeerContextChanged: (cb) => _on('context.peerChanged', cb),
    },

    // Chat surface API — extensions that contribute a "chatSurfaces" entry
    // mount above the chat composer. setPayload caches the current payload
    // with the host; when the user sends, the host emits 'surface.requestFlush'
    // and the extension should respond with setPayload({ kind, data, ... }).
    surface: {
      /**
       * Cache the current outgoing payload on the host.
       *   payload = { kind: 'image'|'text', data: base64-or-string, mime?: string, ext?: string }
       */
      setPayload: (payload) => _rpc('surface.setPayload', { payload: payload || null }),
      clear: () => _rpc('surface.setPayload', { payload: null }),
      onRequestFlush: (cb) => _on('surface.requestFlush', cb),
      onClear: (cb) => _on('surface.clear', cb),
    },
  };

  ${gate?.enforced ? `
  // Capability gate (P1): this plugin declared capabilities, so it only keeps the
  // namespaces it was granted at enable time. Baseline namespaces stay; only the
  // capability-gated ones (${CAPABILITY_GATED_NAMESPACES.join(', ')}) are pruned.
  (function() {
    var _granted = ${serializeForInlineScript(gate.granted)};
    ${serializeForInlineScript([...CAPABILITY_GATED_NAMESPACES])}.forEach(function(ns) {
      if (_granted.indexOf(ns) === -1 && window.codesurf[ns]) { delete window.codesurf[ns]; }
    });
  })();
  ` : ''}

  // Back-compat alias for older extensions that still call window.contex.
  window.contex = window.codesurf;

  // Inject base component stylesheet (uses --ct-* vars; structural styles baked in at load time)
  (function() {
    var baseStyle = document.createElement('style');
    baseStyle.id = '__codesurf_base__';
    baseStyle.textContent = [
      '*,*::before,*::after{box-sizing:border-box}',
      'html,body{margin:0;padding:0;font-family:var(--ct-font-primary,var(--ct-font-sans,sans-serif));font-size:var(--ct-font-primary-size,var(--ct-font-size,13px));line-height:var(--ct-font-primary-line,var(--ct-font-line,1.5));font-weight:var(--ct-font-primary-weight,var(--ct-font-weight,400));color:var(--ct-text,#111);background:var(--ct-bg,transparent)}',
      'a{color:var(--ct-accent,#4f46e5);text-decoration:none}',
      'a:hover{text-decoration:underline}',
      'button{cursor:pointer;background:var(--ct-panel,rgba(0,0,0,.06));color:var(--ct-text,#111);border:1px solid var(--ct-border,rgba(0,0,0,.12));border-radius:var(--ct-radius,6px);padding:5px 12px;font-size:var(--ct-font-secondary-size,var(--ct-font-size,13px));font-family:var(--ct-font-secondary,var(--ct-font-sans,inherit));transition:background 0.15s,opacity 0.15s;outline:none}',
      'button:hover:not(:disabled){background:var(--ct-hover,rgba(0,0,0,.1))}',
      'button:disabled{opacity:0.45;cursor:default}',
      'button.primary,button[data-primary]{background:var(--ct-accent,#4f46e5);color:#fff;border-color:transparent}',
      'button.primary:hover:not(:disabled),button[data-primary]:hover:not(:disabled){opacity:0.88}',
      'button.danger,button[data-danger]{background:rgba(220,38,38,.1);color:#dc2626;border-color:rgba(220,38,38,.25)}',
      'button.danger:hover:not(:disabled),button[data-danger]:hover:not(:disabled){background:rgba(220,38,38,.18)}',
      'input,textarea,select{background:var(--ct-panel,rgba(0,0,0,.04));color:var(--ct-text,#111);border:1px solid var(--ct-border,rgba(0,0,0,.12));border-radius:var(--ct-radius,6px);padding:5px 10px;font-size:var(--ct-font-primary-size,var(--ct-font-size,13px));font-family:var(--ct-font-primary,var(--ct-font-sans,inherit));outline:none;transition:border-color 0.15s,box-shadow 0.15s}',
      'input:focus,textarea:focus,select:focus{border-color:var(--ct-accent,#4f46e5);box-shadow:0 0 0 2px var(--ct-accent-s,rgba(79,70,229,.15))}',
      'input::placeholder,textarea::placeholder{color:var(--ct-dim,#888)}',
      'select option{background:var(--ct-panel,#fff);color:var(--ct-text,#111)}',
      'label{color:var(--ct-text,#111);font-size:var(--ct-font-subtle-size,var(--ct-font-secondary-size,12px));font-family:var(--ct-font-subtle,var(--ct-font-secondary,var(--ct-font-sans,inherit)));line-height:var(--ct-font-subtle-line,var(--ct-font-secondary-line,1.4));font-weight:var(--ct-font-subtle-weight,var(--ct-font-secondary-weight,500))}',
      'hr{border:none;border-top:1px solid var(--ct-border,rgba(0,0,0,.1));margin:12px 0}',
      '::-webkit-scrollbar{width:6px;height:6px}',
      '::-webkit-scrollbar-track{background:transparent}',
      '::-webkit-scrollbar-thumb{background:var(--ct-border,rgba(0,0,0,.2));border-radius:3px}',
      '::-webkit-scrollbar-thumb:hover{background:var(--ct-muted,rgba(0,0,0,.35))}',
      '.ct-card{background:var(--ct-panel,rgba(0,0,0,.04));border:1px solid var(--ct-border,rgba(0,0,0,.1));border-radius:var(--ct-radius,8px);padding:12px}',
      '.ct-card-2{background:var(--ct-panel-2,var(--ct-panel,rgba(0,0,0,.06)));border:1px solid var(--ct-border,rgba(0,0,0,.1));border-radius:var(--ct-radius,8px);padding:12px}',
      '.ct-badge{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;font-size:var(--ct-font-subtle-size,var(--ct-font-secondary-size,11px));font-family:var(--ct-font-subtle,var(--ct-font-secondary,var(--ct-font-sans,inherit)));line-height:var(--ct-font-subtle-line,var(--ct-font-secondary-line,1.4));font-weight:var(--ct-font-subtle-weight,var(--ct-font-secondary-weight,500));background:var(--ct-accent-s,rgba(79,70,229,.1));color:var(--ct-accent,#4f46e5)}',
      '.ct-toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--ct-border,rgba(0,0,0,.1))}',
      '.ct-toolbar-title{font-family:var(--ct-font-title,var(--ct-font-sans,inherit));font-size:var(--ct-font-title-size,13px);font-weight:var(--ct-font-title-weight,700);color:var(--ct-text,#111)}',
      '.ct-section{display:flex;flex-direction:column;gap:8px;padding:12px}',
      '.ct-list{display:flex;flex-direction:column;gap:6px}',
      '.ct-list-row{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--ct-panel,rgba(0,0,0,.04));border:1px solid var(--ct-border,rgba(0,0,0,.1));border-radius:var(--ct-radius,8px)}',
      '.ct-empty{display:flex;align-items:center;justify-content:center;min-height:96px;color:var(--ct-dim,#999);text-align:center}',
      '.ct-stat{display:flex;flex-direction:column;gap:2px;padding:10px 12px;background:var(--ct-panel-2,var(--ct-panel,rgba(0,0,0,.06)));border:1px solid var(--ct-border,rgba(0,0,0,.1));border-radius:var(--ct-radius,8px)}',
      '.ct-stat-label{font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--ct-dim,#999);font-family:var(--ct-font-secondary,var(--ct-font-subtle,var(--ct-font-sans,inherit)))}',
      '.ct-stat-value{font-size:20px;font-weight:700;color:var(--ct-text,#111);font-variant-numeric:tabular-nums;font-family:var(--ct-font-title,var(--ct-font-sans,inherit))}',
      '.ct-kbd{display:inline-flex;align-items:center;padding:1px 6px;border-radius:6px;background:var(--ct-panel-2,var(--ct-panel,rgba(0,0,0,.06)));border:1px solid var(--ct-border,rgba(0,0,0,.1));font-size:11px;font-family:var(--ct-font-mono,monospace)}',
      '.ct-pill{display:inline-flex;align-items:center;padding:2px 8px;border-radius:999px;background:var(--ct-panel-2,var(--ct-panel,rgba(0,0,0,.06)));border:1px solid var(--ct-border,rgba(0,0,0,.1));font-size:var(--ct-font-subtle-size,var(--ct-font-secondary-size,11px));font-family:var(--ct-font-subtle,var(--ct-font-secondary,var(--ct-font-sans,inherit)));line-height:var(--ct-font-subtle-line,var(--ct-font-secondary-line,1.4));font-weight:var(--ct-font-subtle-weight,var(--ct-font-secondary-weight,400))}',
      '.ct-success{color:var(--ct-success,#1f8f5f)}',
      '.ct-warning{color:var(--ct-warning,#c07b12)}',
      '.ct-danger{color:var(--ct-danger,#dc2626)}',
      '.ct-muted{color:var(--ct-muted,#666)}',
      '.ct-dim{color:var(--ct-dim,#999)}',
      // ── Form controls: the "basics" that must look identical across every plugin ──
      // Native checkbox/radio/range themed via accent-color (one line, consistent).
      'input[type=checkbox],input[type=radio]{accent-color:var(--ct-accent,#4f46e5);width:14px;height:14px;cursor:pointer}',
      'input[type=range]{accent-color:var(--ct-accent,#4f46e5);cursor:pointer}',
      'input[type=color]{padding:0;width:28px;height:22px;border-radius:var(--ct-radius,6px);border:1px solid var(--ct-border,rgba(0,0,0,.12));background:none;cursor:pointer}',
      // Switch/toggle — HTML has no native switch; .ct-switch turns a checkbox into one.
      'input[type=checkbox].ct-switch{appearance:none;-webkit-appearance:none;width:32px;height:18px;border-radius:999px;background:var(--ct-border,rgba(0,0,0,.25));position:relative;cursor:pointer;transition:background .15s;border:none;flex:0 0 auto}',
      'input[type=checkbox].ct-switch:checked{background:var(--ct-accent,#4f46e5)}',
      'input[type=checkbox].ct-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:999px;background:#fff;transition:transform .15s}',
      'input[type=checkbox].ct-switch:checked::after{transform:translateX(14px)}',
      'input[type=checkbox].ct-switch:disabled{opacity:.45;cursor:default}',
      // Field / row / col / grid layout helpers — the scaffolding for "put together UIs easily".
      '.ct-field{display:flex;flex-direction:column;gap:4px;margin-bottom:12px}',
      '.ct-field>label,.ct-field-label{color:var(--ct-text,#111);font-size:var(--ct-font-secondary-size,12px);font-weight:500}',
      '.ct-field-hint{color:var(--ct-dim,#999);font-size:11px}',
      '.ct-row{display:flex;align-items:center;gap:8px}',
      '.ct-row-between{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.ct-col{display:flex;flex-direction:column;gap:8px}',
      '.ct-grid{display:grid;gap:8px}',
      '.ct-spacer{flex:1 1 auto}',
      // Segmented control / tabs — consistent tab strip.
      '.ct-seg{display:inline-flex;gap:2px;padding:2px;border-radius:var(--ct-radius,6px);background:var(--ct-panel,rgba(0,0,0,.06));border:1px solid var(--ct-border,rgba(0,0,0,.1))}',
      '.ct-seg>button,.ct-seg-item{background:transparent;border:none;border-radius:calc(var(--ct-radius,6px) - 2px);padding:4px 10px;color:var(--ct-muted,#666);cursor:pointer;font:inherit}',
      '.ct-seg>button[aria-selected=true],.ct-seg-item.active{background:var(--ct-bg,#fff);color:var(--ct-text,#111);box-shadow:0 1px 2px rgba(0,0,0,.12)}',
      // Button sizing variants (defaults already styled above).
      '.ct-btn-sm{padding:3px 8px;font-size:11px}',
      '.ct-btn-lg{padding:8px 16px}',
      '.ct-btn-block{display:flex;width:100%;justify-content:center}',
    ].join('');
    (document.head || document.documentElement).appendChild(baseStyle);
  })();

  // Signal ready
  window.parent.postMessage({ type: 'codesurf-bridge-ready', tileId: _tileId, extId: _extId }, '*');
})();
`
}
