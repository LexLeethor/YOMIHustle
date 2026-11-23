// Repeated-crash guard for the web build, loaded from index.html before the engine.
//
// A broken save, a half-downloaded mod or a wasm abort can leave the game unable to
// reach its main menu: every reload lands on the same wall and the page never offers a
// way out. This runs in the HTML shell, ahead of index.js, so it does not depend on the
// engine booting - in fact it exists for the case where the engine does not.
//
//   * every load increments a counter in localStorage;
//   * a load that got somewhere clears it: the engine drew steady frames for
//     STABLE_MS without an uncaught error, which only happens once the game is running;
//   * after MAX_BOOTS loads in a row that never got there, the page is covered by a
//     prompt (the main menu is never shown) offering "Clear all data and restart".
//
// `?reset=1` (or `#reset`) shows that prompt on demand, for a player who suspects
// something is stuck without having to reload three times.
//
// The frame counter is a shell-side observation, not a game callback: the guard patches
// the WebGL draw entry points before the engine creates its context and counts calls.
(function () {
  'use strict';

  var KEY = 'yomi-boot';
  // Failures allowed before the prompt. Four loads is a crash loop; one or two is a
  // reload while the last download was still finishing.
  var MAX_BOOTS = 200;
  // A count older than this is not a loop, it is yesterday.
  var FORGET_AFTER_MS = 15 * 60 * 1000;
  // Frames have to keep arriving this long before the load counts as good: the engine
  // draws nothing until the game itself is running, so four seconds is past the menu.
  var STABLE_MS = 4000;
  // Nothing drawn for this long means this load is not going to clear the counter.
  var GIVE_UP_MS = 90 * 1000;
  // How long the reset waits for IndexedDB deletions before reloading anyway. A
  // connection the engine still holds blocks the delete until the page unloads.
  var RESET_GRACE_MS = 2500;

  function now() {
    return Date.now();
  }

  function readState() {
    try {
      var raw = window.localStorage.getItem(KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.n !== 'number') return null;
      return parsed;
    } catch (error) {
      return null;
    }
  }

  function writeState(state) {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch (error) {}
  }

  function resetRequested() {
    try {
      if (/[?&](reset|hardreset)=1\b/i.test(window.location.search)) return true;
      return /^#(reset|hardreset)$/i.test(window.location.hash);
    } catch (error) {
      return false;
    }
  }

  // --- Did the engine actually run? -----------------------------------------

  var draws = 0;
  var firstDrawAt = 0;
  var lastDrawAt = 0;

  function countDraws() {
    var protos = [
      window.WebGLRenderingContext && window.WebGLRenderingContext.prototype,
      window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype
    ];
    protos.forEach(function (proto) {
      if (!proto || proto.__yomiDrawCounted) return;
      proto.__yomiDrawCounted = true;
      [
        'drawArrays', 'drawElements',
        'drawArraysInstancedANGLE', 'drawElementsInstancedANGLE',
        'drawArraysInstanced', 'drawElementsInstanced'
      ].forEach(function (name) {
        var original = proto[name];
        if (typeof original !== 'function') return;
        proto[name] = function () {
          draws += 1;
          if (!firstDrawAt) firstDrawAt = now();
          lastDrawAt = now();
          return original.apply(this, arguments);
        };
      });
    });
  }

  var errored = false;

  function watchErrors() {
    window.addEventListener('error', function () {
      errored = true;
    }, true);
    window.addEventListener('unhandledrejection', function () {
      errored = true;
    }, true);
  }

  // Clears the counter once the engine has drawn steadily and cleanly. Nothing here
  // asks the game whether it "booted": frames plus a quiet console are the whole test,
  // and a load that crashes leaves the counter exactly where it was.
  function watchBoot(startedAt) {
    var timer = window.setInterval(function () {
      if (errored) {
        window.clearInterval(timer);
        return;
      }
      var busy = lastDrawAt && now() - lastDrawAt < 500;
      if (busy && firstDrawAt && now() - firstDrawAt >= STABLE_MS) {
        window.clearInterval(timer);
        writeState({ n: 0, t: now() });
        return;
      }
      if (now() - startedAt > GIVE_UP_MS) {
        window.clearInterval(timer);
      }
    }, 500);
  }

  // --- Clearing everything the game has on this device ----------------------

  // Godot 3.5 keeps `user://` in an IndexedDB database named `/userfs` (see IDBFS in
  // index.js). Anything else this origin owns is deleted too, because a stale save is
  // exactly the thing that bricks a boot.
  function databaseNames() {
    var names = ['/userfs'];
    if (!window.indexedDB || typeof window.indexedDB.databases !== 'function') {
      return Promise.resolve(names);
    }
    return window.indexedDB.databases().then(function (list) {
      (list || []).forEach(function (info) {
        if (info && info.name && names.indexOf(info.name) < 0) names.push(info.name);
      });
      return names;
    }, function () {
      return names;
    });
  }

  function deleteDatabase(name) {
    return new Promise(function (resolve) {
      var request;
      try {
        request = window.indexedDB.deleteDatabase(name);
      } catch (error) {
        resolve();
        return;
      }
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });
  }

  function clearAllData() {
    try { window.localStorage.clear(); } catch (error) {}
    try { window.sessionStorage.clear(); } catch (error) {}

    var chain = databaseNames().then(function (names) {
      if (!window.indexedDB) return null;
      return Promise.all(names.map(deleteDatabase));
    }).catch(function () {});

    chain = chain.then(function () {
      if (!window.caches) return null;
      return window.caches.keys().then(function (keys) {
        return Promise.all(keys.map(function (key) { return window.caches.delete(key); }));
      });
    }).catch(function () {});

    chain = chain.then(function () {
      if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return null;
      return navigator.serviceWorker.getRegistrations().then(function (list) {
        return Promise.all(list.map(function (registration) { return registration.unregister(); }));
      });
    }).catch(function () {});

    return chain;
  }

  function reloadClean() {
    // Drops `?reset=1` and the hash as well as the data, so the reload starts fresh.
    var target = window.location.pathname || '/';
    window.location.replace(target);
  }

  // --- The prompt -----------------------------------------------------------

  function element(tag, style, text) {
    var node = document.createElement(tag);
    if (style) node.setAttribute('style', style);
    if (text) node.textContent = text;
    return node;
  }

  function buildPrompt(loads, manual) {
    if (document.querySelector('.yomi-crash')) return;

    var backdrop = element('div', 'position:fixed;left:0;top:0;right:0;bottom:0;' +
      'z-index:2147483647;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:14px;padding:24px;box-sizing:border-box;' +
      'background:#0b0b10;color:#f0f0f2;text-align:center;' +
      'font:16px/1.5 "Noto Sans",Arial,sans-serif;overscroll-behavior:contain;');
    backdrop.className = 'yomi-crash';
    backdrop.setAttribute('role', 'alertdialog');
    backdrop.setAttribute('aria-modal', 'true');
    backdrop.setAttribute('aria-label', 'The game keeps crashing');

    backdrop.appendChild(element('h2', 'margin:0;font-size:22px;font-weight:700;',
      manual ? 'Reset the game\u2019s data?' : 'The game keeps crashing'));

    backdrop.appendChild(element('p', 'margin:0;max-width:26em;color:#b6b6c2;font-size:15px;',
      manual
        ? 'Clearing the game\u2019s data on this device is the fix for a boot that will ' +
          'not get past the loading screen, or a setting that will not let go.'
        : 'It has failed to reach the main menu ' + loads + ' times in a row. A broken ' +
          'save, an installed mod or a half-finished download can do that. Clearing the ' +
          'game\u2019s data on this device normally fixes it.'));

    backdrop.appendChild(element('p', 'margin:0;max-width:26em;color:#8f8f9c;font-size:13px;',
      'Clearing removes every save, setting and downloaded mod in this browser. ' +
      'Mods can be installed again from the workshop.'));

    var clear = element('button', 'min-height:48px;padding:0 22px;border:1px solid #a3423f;' +
      'border-radius:10px;background:#5a1f1d;color:#fff;font:600 16px/1 "Noto Sans",Arial,sans-serif;',
      'Clear all data and restart');
    clear.type = 'button';

    var retry = element('button', 'min-height:48px;padding:0 22px;' +
      'border:1px solid rgba(255,255,255,0.35);border-radius:10px;background:#2a2a34;' +
      'color:#f4f4f6;font:600 16px/1 "Noto Sans",Arial,sans-serif;', 'Try again');
    retry.type = 'button';

    var status = element('p', 'margin:0;min-height:1.4em;color:#b6b6c2;font-size:14px;', '');

    clear.addEventListener('click', function () {
      clear.disabled = true;
      retry.disabled = true;
      clear.textContent = 'Clearing\u2026';
      status.textContent = 'Deleting saves, settings and downloaded mods.';
      // A delete the engine still has open only finishes after the page goes away, so
      // the reload is bounded rather than waiting for every promise.
      var timeout = new Promise(function (resolve) {
        window.setTimeout(resolve, RESET_GRACE_MS);
      });
      Promise.race([clearAllData(), timeout]).then(reloadClean, reloadClean);
    });

    retry.addEventListener('click', function () {
      // Keep the local data, but stop the guard from blocking: if the next boot fails
      // as well the counter starts again from one.
      writeState({ n: 0, t: now() });
      reloadClean();
    });

    backdrop.appendChild(clear);
    backdrop.appendChild(retry);
    backdrop.appendChild(status);

    // The engine may still be starting behind this; it must not see keys or taps.
    ['keydown', 'keyup', 'keypress', 'pointerdown', 'wheel', 'touchstart'].forEach(function (name) {
      window.addEventListener(name, function (event) {
        event.stopPropagation();
      }, true);
    });
    backdrop.addEventListener('contextmenu', function (event) {
      event.preventDefault();
    });

    document.body.appendChild(backdrop);
    clear.focus();
  }

  function block(loads, manual) {
    if (document.body) {
      buildPrompt(loads, manual);
      return;
    }
    document.addEventListener('DOMContentLoaded', function () {
      buildPrompt(loads, manual);
    });
  }

  // --- Boot -----------------------------------------------------------------

  countDraws();
  watchErrors();

  var forced = resetRequested();
  var state = readState();
  var startedAt = now();

  if (forced) {
    // `?reset=1`: a deliberate way in, for a player who thinks something is stuck
    // without having reloaded three times.
    block((state && state.n) || 0, true);
    return;
  }

  if (!state || startedAt - (state.t || 0) > FORGET_AFTER_MS) {
    state = { n: 0, t: startedAt };
  }
  state.n += 1;
  state.t = startedAt;
  writeState(state);

  if (state.n > MAX_BOOTS) {
    block(state.n);
    return;
  }

  watchBoot(startedAt);
})();
