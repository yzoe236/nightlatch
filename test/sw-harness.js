/* Loads the real background.js into Node against a fake chrome.* API.
 *
 * background.js is a service worker: it starts with importScripts() and
 * registers listeners at top level, so it cannot be require()d. This runs the
 * real source text instead of a copy, for the same reason autolock.test.js
 * slices it — a test that drifts from the shipped code proves nothing.
 *
 * The fake storage is deliberately asynchronous with a settable latency, so
 * handlers that straddle awaits interleave here the way they do in Chrome.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join(__dirname, '..');

function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

function makeArea(latency) {
  const data = {};
  return {
    _data: data,
    get: async function (defaults) {
      await tick(latency());
      const out = {};
      if (defaults && typeof defaults === 'object' && !Array.isArray(defaults)) {
        Object.keys(defaults).forEach(function (k) {
          out[k] = Object.prototype.hasOwnProperty.call(data, k)
            ? JSON.parse(JSON.stringify(data[k])) : defaults[k];
        });
      }
      return out;
    },
    set: async function (obj) {
      await tick(latency());
      Object.keys(obj).forEach(function (k) { data[k] = JSON.parse(JSON.stringify(obj[k])); });
    },
    remove: async function (keys) {
      await tick(latency());
      (Array.isArray(keys) ? keys : [keys]).forEach(function (k) { delete data[k]; });
    },
    clear: async function () { await tick(latency()); Object.keys(data).forEach(function (k) { delete data[k]; }); }
  };
}

function createHarness(opts) {
  opts = opts || {};
  const log = [];
  let latencyMs = opts.latencyMs === undefined ? 1 : opts.latencyMs;
  const latency = function () { return latencyMs; };

  const listeners = {
    message: [], alarm: [], idle: [], command: [],
    focus: [], activated: [], updated: [], installed: [], startup: []
  };

  let tabs = opts.tabs || [{ id: 1, url: 'https://example.com/', audible: false }];
  let idleState = 'active';
  let idleMode = 'normal';
  let refuseChromeNav = false;
  let nextTabId = 900;
  const hooks = { beforeTabsQuery: null, beforeSessionRemove: null };

  const chrome = {
    runtime: {
      getURL: function (p) { return 'chrome-extension://nightlatchtestid/' + p; },
      openOptionsPage: function () { log.push('openOptionsPage'); },
      onMessage: { addListener: function (f) { listeners.message.push(f); } },
      onInstalled: { addListener: function (f) { listeners.installed.push(f); } },
      onStartup: { addListener: function (f) { listeners.startup.push(f); } },
      lastError: null
    },
    storage: {
      sync: makeArea(latency),
      session: makeArea(latency),
      local: makeArea(latency)
    },
    tabs: {
      query: async function (q) {
        if (hooks.beforeTabsQuery) { const h = hooks.beforeTabsQuery; hooks.beforeTabsQuery = null; await h(); }
        await tick(latency());
        if (q && q.audible) return tabs.filter(function (t) { return t.audible; });
        return tabs.slice();
      },
      sendMessage: function (id, msg) { log.push('tabs.sendMessage:' + id + ':' + msg.type + ':' + msg.locked); return Promise.resolve(); },
      update: function (id, o) {
        log.push('tabs.update:' + id + ':' + o.url);
        if (refuseChromeNav && /^chrome:/i.test(o.url)) {
          return Promise.reject(new Error('Cannot navigate to a chrome:// URL'));
        }
        tabs = tabs.map(function (t) { return t.id === id ? Object.assign({}, t, { url: o.url }) : t; });
        return Promise.resolve();
      },
      remove: function (id) {
        log.push('tabs.remove:' + id);
        tabs = tabs.filter(function (t) { return t.id !== id; });
        return Promise.resolve();
      },
      create: function (o) {
        const t = { id: nextTabId++, url: (o && o.url) || 'chrome://newtab/', audible: false };
        log.push('tabs.create:' + t.id + ':' + t.url);
        tabs = tabs.concat([t]);
        return Promise.resolve(t);
      },
      onActivated: { addListener: function (f) { listeners.activated.push(f); } },
      onUpdated: { addListener: function (f) { listeners.updated.push(f); } }
    },
    scripting: { executeScript: async function () { await tick(latency()); return []; } },
    action: { setBadgeText: async function (o) { log.push('badge:' + JSON.stringify(o.text)); }, setBadgeBackgroundColor: async function () {} },
    alarms: {
      create: function (n, o) { log.push('alarms.create:' + n + ':' + JSON.stringify(o)); },
      onAlarm: { addListener: function (f) { listeners.alarm.push(f); } }
    },
    idle: {
      onStateChanged: { addListener: function (f) { listeners.idle.push(f); } },
      queryState: function (secs, cb) {
        const s = idleState;
        if (idleMode === 'throw') throw new Error('idle API unavailable');
        if (idleMode === 'silent') return;              // callback never fires
        if (typeof cb !== 'function') return undefined; // old Chrome: no promise
        setTimeout(function () {
          if (idleMode === 'lastError') {
            chrome.runtime.lastError = { message: 'boom' };
            cb(undefined);
            chrome.runtime.lastError = null;
            return;
          }
          cb(idleMode === 'undefined' ? undefined : s);
        }, latencyMs);
      },
      setDetectionInterval: function (s) { log.push('idle.setDetectionInterval:' + s); }
    },
    commands: { onCommand: { addListener: function (f) { listeners.command.push(f); } } },
    windows: { WINDOW_ID_NONE: -1, onFocusChanged: { addListener: function (f) { listeners.focus.push(f); } } }
  };

  const self = { crypto: globalThis.crypto };

  const ROOT = opts.root || DEFAULT_ROOT;
  const cryptoSrc = fs.readFileSync(path.join(ROOT, 'crypto.js'), 'utf8');
  const bgSrc = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8')
    .replace(/^\s*importScripts\([^)]*\);\s*$/m, '');

  const body =
    cryptoSrc +
    '\nconst NightlatchCrypto = self.NightlatchCrypto;\n' +
    bgSrc +
    '\nreturn { lockNow, unlockNow, isLocked, getCfg, setCfgPatch, noteActivity, effectiveAutolockMin, getLocalPrefs };';

  const api = new Function('chrome', 'self', 'console', 'TextEncoder', 'btoa', 'atob', body)(
    chrome, self, { log: function () {}, warn: function () {}, error: function () {} },
    TextEncoder, btoa, atob
  );

  return {
    chrome: chrome, api: api, log: log, listeners: listeners, hooks: hooks, PLK: self.NightlatchCrypto,
    setLatency: function (ms) { latencyMs = ms; },
    setTabs: function (t) { tabs = t; },
    setIdleState: function (s) { idleState = s; },
    setIdleMode: function (m) { idleMode = m; },
    setRefuseChromeNav: function (v) { refuseChromeNav = v; },
    session: chrome.storage.session._data,
    sync: chrome.storage.sync._data,
    local: chrome.storage.local._data,

    fireAlarm: function (name) {
      listeners.alarm.forEach(function (f) { f({ name: name || 'plk-idle-check' }); });
    },
    fireIdle: function (state) {
      listeners.idle.forEach(function (f) { f(state); });
    },
    send: function (msg, fromExtPage, tabId) {
      return new Promise(function (resolve) {
        const sender = { url: fromExtPage
          ? 'chrome-extension://nightlatchtestid/locked.html'
          : 'https://example.com/page' };
        if (typeof tabId === 'number') sender.tab = { id: tabId };
        let done = false;
        listeners.message.forEach(function (f) {
          f(msg, sender, function (resp) { if (!done) { done = true; resolve(resp); } });
        });
      });
    },
    // Give the whole event loop room to settle (handlers are fire-and-forget).
    settle: async function (ms) { await tick(ms === undefined ? 500 : ms); }
  };
}

module.exports = { createHarness: createHarness, tick: tick };
