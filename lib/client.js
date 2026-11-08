/**
 * Client half: pull notices from the host bridge and render them.
 *
 * No bundler, no JSX. The loader hands us `require` for the seed modules, and
 * the only transport available to an installed client plugin is a same-origin
 * fetch against a route the host plugin mounted.
 */
(function () {
  'use strict';

  if (typeof window === 'undefined') return;
  var loader = window.__ModuleLoader__;
  if (!loader || typeof loader.load !== 'function') return;

  var API = '/modapi/api';
  var POLL_WAIT_MS = 25000;
  var RETRY_MS = 5000;

  function loadFactory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    var React = require('react');

    var LEVEL_STYLE = {
      info: { border: '#5aa9ff', label: '提示' },
      success: { border: '#43c07a', label: '完成' },
      warn: { border: '#e2b53c', label: '警告' },
      error: { border: '#e2645a', label: '错误' },
    };

    var state = { items: [], cursor: 0, alive: false, timer: null, controller: null, warned: false };

    function merge(incoming, seq) {
      var changed = false;
      (incoming || []).forEach(function (item) {
        if (!item || typeof item.seq !== 'number' || item.seq <= state.cursor) return;
        state.items.push(item);
        changed = true;
        if (typeof item.duration === 'number' && item.duration > 0) {
          setTimeout(function () { dismiss(item.id); }, item.duration);
        }
      });
      if (typeof seq === 'number' && seq > state.cursor) state.cursor = seq;
      if (state.items.length > 50) state.items = state.items.slice(-50);
      return changed;
    }

    function acknowledge(ids) {
      if (!ids || ids.length === 0) return;
      try {
        fetch(API + '/notices/ack', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ids: ids }),
        }).catch(function () {});
      } catch (error) {
        // The next poll will re-deliver anything that was not acknowledged.
      }
    }

    function dismiss(id) {
      state.items = state.items.filter(function (item) { return item.id !== id; });
      acknowledge([id]);
      notify();
    }

    var listeners = new Set();
    function notify() {
      listeners.forEach(function (listener) {
        try { listener(); } catch (error) { /* a broken component must not stop the poller */ }
      });
    }

    function schedule(delay) {
      if (!state.alive) return;
      clearTimeout(state.timer);
      state.timer = setTimeout(poll, delay);
    }

    function poll() {
      if (!state.alive) return;
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      state.controller = controller;
      var url = API + '/notices?after=' + encodeURIComponent(String(state.cursor)) + '&wait=' + POLL_WAIT_MS;
      fetch(url, { credentials: 'same-origin', signal: controller ? controller.signal : undefined })
        .then(function (response) {
          if (!response.ok) throw new Error('notice poll failed: HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          if (!payload || payload.ok !== true) throw new Error((payload && payload.error && payload.error.message) || 'notice poll rejected');
          var changed = merge(payload.value && payload.value.notices, payload.value && payload.value.seq);
          if (changed) notify();
          schedule(0);
        })
        .catch(function (error) {
          if (state.alive && !state.warned) {
            state.warned = true;
            console.warn('[dsh-modapi] notice channel unavailable:', error && error.message ? error.message : error);
          }
          schedule(RETRY_MS);
        });
    }

    function ensurePolling() {
      if (state.alive) return;
      state.alive = true;
      state.warned = false;
      poll();
    }

    function stopPolling() {
      state.alive = false;
      clearTimeout(state.timer);
      state.timer = null;
      try { state.controller && state.controller.abort(); } catch (error) { /* already gone */ }
      state.controller = null;
    }

    function ToastItem(props) {
      var item = props.item;
      var style = LEVEL_STYLE[item.level] || LEVEL_STYLE.info;
      return React.createElement(
        'div',
        {
          style: {
            pointerEvents: 'auto',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            maxWidth: 420,
            padding: '10px 12px',
            borderRadius: 8,
            background: 'rgba(28, 32, 42, 0.96)',
            borderLeft: '3px solid ' + style.border,
            boxShadow: '0 6px 24px rgba(0, 0, 0, 0.35)',
            color: '#f2f4f8',
            fontSize: 13,
            lineHeight: 1.5,
          },
        },
        React.createElement(
          'div',
          { style: { flex: '1 1 auto', minWidth: 0 } },
          item.title ? React.createElement('div', { style: { fontWeight: 600, marginBottom: 2 } }, item.title) : null,
          item.body ? React.createElement('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.92 } }, item.body) : null,
        ),
        React.createElement(
          'button',
          {
            type: 'button',
            onClick: function () { dismiss(item.id); },
            title: '关闭',
            style: {
              flex: '0 0 auto',
              border: 'none',
              background: 'transparent',
              color: 'rgba(242, 244, 248, 0.6)',
              cursor: 'pointer',
              fontSize: 16,
              lineHeight: 1,
              padding: 0,
            },
          },
          '×',
        ),
      );
    }

    function NoticesOverlay() {
      var versionState = React.useState(0);
      var bump = versionState[1];
      React.useEffect(function () {
        var listener = function () { bump(function (n) { return n + 1; }); };
        listeners.add(listener);
        ensurePolling();
        return function () {
          listeners.delete(listener);
        };
      }, []);
      var items = state.items ? state.items.slice() : [];
      if (items.length === 0) return null;
      return React.createElement(
        'div',
        {
          style: {
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 9000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 8,
            pointerEvents: 'none',
          },
        },
        items.map(function (item) { return React.createElement(ToastItem, { key: item.id, item: item }); }),
      );
    }

    var uiState = { version: -1, rules: [], listeners: [], timer: null, alive: false, warned: false, cursor: 0 };

    function uiToast(level, text) {
      var id = 'ui-toast-' + (++uiState.cursor);
      state.items.push({ id: id, seq: 0, level: level || 'info', title: '', body: String(text === undefined ? '' : text), duration: 4000 });
      if (state.items.length > 50) state.items = state.items.slice(-50);
      notify();
      setTimeout(function () { dismiss(id); }, 4000);
    }

    function compileRule(rule) {
      var source = rule && rule.handler;
      if (typeof source !== 'string') return null;
      if (rule.handlerKind === 'body') {
        try { return new Function('ctx', 'event', source); } catch (error) { return null; }
      }
      try {
        var produced = (new Function('ctx', 'event', 'return (' + source + ')'))();
        if (typeof produced === 'function') return produced;
        throw new Error('handler source did not evaluate to a function');
      } catch (error) {
        try { return new Function('ctx', 'event', source); } catch (again) { return null; }
      }
    }

    function matchesText(element, text, exact) {
      var node = element;
      while (node && node !== document.body) {
        var content = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (exact ? content === text : content.indexOf(text) !== -1) return node;
        node = node.parentElement;
      }
      return null;
    }

    function findTarget(rule, event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return null;
      if (rule.selector.indexOf('text=') === 0 || rule.selector.indexOf('text*=') === 0) {
        var strict = rule.selector.indexOf('text=') === 0;
        var wanted = rule.selector.slice(strict ? 5 : 6).trim();
        if (wanted === '') return null;
        var node = matchesText(target, wanted, strict);
        if (!node) return null;
        return node.closest('button,a,[role="button"],input[type="submit"]') || node;
      }
      try { return target.closest(rule.selector); } catch (error) { return null; }
    }

    function reportHit(id) {
      try {
        fetch(API + '/ui/hit', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: id }),
        }).catch(function () {});
      } catch (error) { /* hit accounting is best effort */ }
    }

    function dispatchRule(rule, fn, event) {
      var element = findTarget(rule, event);
      if (!element) return;
      var blocked = false;
      var ctx = {
        rule: rule.id,
        selector: rule.selector,
        element: element,
        stop: function () { blocked = true; },
        preventDefault: function () { blocked = true; try { event.preventDefault(); } catch (error) {} },
        log: function () { try { console.log.apply(console, ['[modapi-ui]'].concat([].slice.call(arguments))); } catch (error) {} },
        toast: function (text, level) { uiToast(level, text); },
      };
      reportHit(rule.id);
      if (rule.once) uiState.rules = uiState.rules.filter(function (item) { return item.id !== rule.id; });
      if (rule.mode === 'after') {
        setTimeout(function () { try { fn.call(element, ctx, event); } catch (error) { console.warn('[dsh-modapi] ui handler failed:', error && error.message ? error.message : error); } }, 0);
        return;
      }
      try {
        var decision = fn.call(element, ctx, event);
        if (decision === false) blocked = true;
      } catch (error) {
        console.warn('[dsh-modapi] ui handler failed:', error && error.message ? error.message : error);
      }
      if (rule.mode === 'block' || rule.mode === 'replace' || blocked) {
        try { event.preventDefault(); } catch (error) {}
        try { event.stopPropagation(); } catch (error) {}
        try { event.stopImmediatePropagation(); } catch (error) {}
      }
    }

    function installRules(rules) {
      uiState.listeners.forEach(function (entry) {
        try { document.removeEventListener(entry.event, entry.listener, true); } catch (error) {}
      });
      uiState.listeners = [];
      var byEvent = {};
      rules.forEach(function (rule) {
        var fn = compileRule(rule);
        if (typeof fn !== 'function') {
          console.warn('[dsh-modapi] ui rule ' + rule.id + ' did not compile; skipped');
          return;
        }
        if (!byEvent[rule.event]) byEvent[rule.event] = [];
        byEvent[rule.event].push({ rule: rule, fn: fn });
      });
      Object.keys(byEvent).forEach(function (eventName) {
        var entries = byEvent[eventName];
        var listener = function (event) {
          var seen = event.__modapiSeen;
          if (!seen) {
            seen = event.__modapiSeen = {};
          }
          entries.forEach(function (entry) {
            if (seen[entry.rule.id]) return;
            seen[entry.rule.id] = true;
            dispatchRule(entry.rule, entry.fn, event);
          });
        };
        document.addEventListener(eventName, listener, true);
        uiState.listeners.push({ event: eventName, listener: listener });
      });
    }

    function pollUi() {
      if (!uiState.alive) return;
      fetch(API + '/ui', { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          if (!payload || payload.ok !== true || !payload.value) return;
          var value = payload.value;
          if (value.version === uiState.version) return;
          uiState.version = value.version;
          uiState.rules = value.rules || [];
          installRules(uiState.rules);
        })
        .catch(function (error) {
          if (uiState.alive && !uiState.warned) {
            uiState.warned = true;
            console.warn('[dsh-modapi] ui channel unavailable:', error && error.message ? error.message : error);
          }
        })
        .then(function () {
          if (!uiState.alive) return;
          uiState.timer = setTimeout(pollUi, 3000);
        });
    }

    function startUi() {
      if (uiState.alive) return;
      uiState.alive = true;
      uiState.warned = false;
      pollUi();
    }

    function stopUi() {
      uiState.alive = false;
      clearTimeout(uiState.timer);
      uiState.timer = null;
      uiState.listeners.forEach(function (entry) {
        try { document.removeEventListener(entry.event, entry.listener, true); } catch (error) {}
      });
      uiState.listeners = [];
    }

    function apply(ctx) {
      startUi();
      if (typeof ctx?.effect === 'function') {
        ctx.effect(function () {
          return function () {
            stopPolling();
            stopUi();
          };
        });
      }
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') {
        console.warn('[dsh-modapi] client: no slot registry, notice overlay is unavailable');
        return;
      }
      try {
        ctx.slots.inject('shell.overlay', function () {
          return ctx.slots.register({ name: 'shell.overlay', id: 'modapi-notices', order: 200 }, NoticesOverlay);
        });
      } catch (error) {
        console.warn('[dsh-modapi] client: cannot register the notice overlay:', error && error.message ? error.message : error);
      }
    }

    exports.apply = apply;
    exports.inject = ['slots'];
    exports.__internals = { merge: merge, dismiss: dismiss, ensurePolling: ensurePolling, stopPolling: stopPolling, get cursor() { return state.cursor; }, get items() { return state.items.slice(); } };
    return module.exports;
  }

  loader.load({ id: 'dsh-modapi', factory: loadFactory });
})();
