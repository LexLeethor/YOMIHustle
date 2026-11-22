// Mobile web additions for the browser build, loaded from index.html.
//
// The export is a 640x360 picture the engine stretches over the window, and the
// page has no interactive chrome of its own, so a phone gets no keyboard, no way
// back out of the pause menu, and - in portrait - a game squeezed to a strip in
// the middle of the screen. Everything here is gated on a mobile user agent and
// does nothing on a desktop.
//
//   * Escape / Enter / Tab buttons that send real key events to the engine
//   * a "turn the phone sideways" notice in portrait
//   * an Add to Home Screen hint on iOS and service worker registration, so the
//     page installs to the home screen (Android Chrome shows its own prompt)
(function () {
  'use strict';

  var ua = navigator.userAgent || '';
  // iPadOS 13 and later report a desktop Mac user agent, so touch points decide.
  var iPadOS = /Macintosh|Mac OS X/.test(ua) && navigator.maxTouchPoints > 1;
  var isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone|IEMobile|Tablet/i.test(ua) || iPadOS;
  if (!isMobile) return;

  var isIOS = /iPhone|iPad|iPod/.test(ua) || iPadOS;
  var root = document.documentElement;
  root.classList.add('yomi-mobile');
  // Before the engine boots, so its own GL init cannot throw.
  guardGraphicsContext();

  var isStandalone = navigator.standalone === true ||
    (window.matchMedia && (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches
    ));
  if (isStandalone) root.classList.add('yomi-standalone');

  function storageGet(key) {
    try { return window.localStorage.getItem(key); } catch (error) { return null; }
  }

  function storageSet(key, value) {
    try { window.localStorage.setItem(key, value); } catch (error) {}
  }

  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  // --- Keys -----------------------------------------------------------------

  // The engine's key callback reads evt.code and evt.key (see the keydown
  // listener in index.js), so these use the DOM code names it maps from.
  var KEYS = {
    escape: { code: 'Escape', key: 'Escape', keyCode: 27 },
    enter: { code: 'Enter', key: 'Enter', keyCode: 13 },
    tab: { code: 'Tab', key: 'Tab', keyCode: 9 }
  };

  function sendKey(type, spec) {
    var canvas = document.getElementById('canvas');
    if (!canvas) return;
    var event;
    try {
      event = new KeyboardEvent(type, {
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        which: spec.keyCode,
        bubbles: true,
        cancelable: true
      });
    } catch (error) {
      event = document.createEvent('Event');
      event.initEvent(type, true, true);
    }
    // Chrome ignores keyCode in the KeyboardEvent init dictionary, but some
    // handlers (and the engine's modifier helpers) still ask for it.
    if (event.keyCode !== spec.keyCode) {
      try {
        Object.defineProperty(event, 'keyCode', { get: function () { return spec.keyCode; } });
        Object.defineProperty(event, 'which', { get: function () { return spec.keyCode; } });
      } catch (error) {}
    }
    canvas.dispatchEvent(event);
  }

  function tapKey(spec) {
    sendKey('keydown', spec);
    // Let the engine see the press on its own frame before releasing it.
    window.setTimeout(function () { sendKey('keyup', spec); }, 90);
  }

  function buildKeyBar() {
    var bar = element('div', 'yomi-touch-keys');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'Keyboard keys');
    [
      { spec: KEYS.escape, label: 'ESC', title: 'Escape: pause menu' },
      { spec: KEYS.enter, label: 'ENTER', title: 'Enter: confirm' },
      { spec: KEYS.tab, label: 'TAB', title: 'Tab: next control' }
    ].forEach(function (entry) {
      var button = element('button', null, entry.label);
      button.type = 'button';
      button.tabIndex = -1;
      button.setAttribute('aria-label', entry.title);
      // pointerdown fires before a touch can become a scroll or a zoom, and
      // preventing it keeps the canvas focused.
      button.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        event.stopPropagation();
        tapKey(entry.spec);
      });
      bar.appendChild(button);
    });
    document.body.appendChild(bar);
  }

  // --- Portrait notice ------------------------------------------------------

  // The game is 640x360 with "keep" aspect. Upright on a phone that is a short
  // strip at roughly 60% scale, where its own text is unreadable; sideways it
  // fills the screen.
  function buildRotateNotice() {
    var box = element('div', 'yomi-rotate');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Rotate your phone');

    var icon = element('div', 'yomi-rotate-icon', '\u21BB');
    icon.setAttribute('aria-hidden', 'true');
    box.appendChild(icon);
    box.appendChild(element('h2', null, 'Rotate your phone'));
    box.appendChild(element('p', null,
      'YOMI is drawn at 640\u00D7360. Sideways it fills the screen; upright it is squeezed into a strip and the text gets too small to read.'));

    var play = element('button', null, 'Play upright anyway');
    play.type = 'button';
    play.addEventListener('click', function () {
      root.classList.add('yomi-portrait-ok');
      storageSet('yomi-portrait-ok', '1');
    });
    box.appendChild(play);

    if (storageGet('yomi-portrait-ok') === '1') root.classList.add('yomi-portrait-ok');
    document.body.appendChild(box);
  }

  function updateOrientation() {
    root.classList.toggle('yomi-portrait', window.innerHeight > window.innerWidth);
  }

  // --- Install hint ---------------------------------------------------------

  function buildInstallHint() {
    if (!isIOS || isStandalone || storageGet('yomi-install-hint') === 'done') return;

    var hint = element('div', 'yomi-install-hint');
    var text = element('div', 'yomi-install-hint-text');
    text.appendChild(element('b', null, 'Add YOMI to your Home Screen'));
    text.appendChild(document.createTextNode(
      'Tap Share, then \u201CAdd to Home Screen\u201D to play without the browser bars.'));
    hint.appendChild(text);

    var close = element('button', 'yomi-install-hint-close', '\u00D7');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    hint.appendChild(close);

    var hide = function () {
      storageSet('yomi-install-hint', 'done');
      if (hint.parentNode) hint.parentNode.removeChild(hint);
    };
    close.addEventListener('click', hide);
    // It sits over the top of the game; the first tap in the play area is the
    // player starting, so it goes then too.
    var canvas = document.getElementById('canvas');
    if (canvas) canvas.addEventListener('pointerdown', hide, { once: true, passive: true });

    document.body.appendChild(hint);
  }

  // --- Graphics context loss ------------------------------------------------

  // A phone drops the WebGL context when the tab runs out of video memory, which
  // a screen full of large mod textures makes easy. Godot 3.5's initGL() then
  // asks the dead context for its attributes, gets null, and the page dies on
  // "null is not an object (evaluating 'gl.getContextAttributes().antialias')" -
  // a blank screen with no explanation. The shim below keeps that from throwing,
  // and the notice turns a lost context into a visible reload.
  function guardGraphicsContext() {
    var proto = window.WebGLRenderingContext && window.WebGLRenderingContext.prototype;
    if (!proto || proto.__yomiSafeAttributes) return;
    proto.__yomiSafeAttributes = true;
    var original = proto.getContextAttributes;
    proto.getContextAttributes = function () {
      var attributes = null;
      try { attributes = original.apply(this, arguments); } catch (error) { attributes = null; }
      // The engine reads antialias from this and nothing else, to pick a blit path.
      return attributes || {
        alpha: true,
        antialias: false,
        depth: true,
        stencil: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false
      };
    };
  }

  var CONTEXT_LOST_KEY = 'yomi-gl-reloads';

  function showContextLost() {
    if (document.querySelector('.yomi-gl-notice')) return;
    var box = element('div', 'yomi-gl-notice');
    box.setAttribute('role', 'alertdialog');
    box.setAttribute('aria-label', 'The game ran out of video memory');
    box.appendChild(element('h2', null, 'The graphics stopped'));
    box.appendChild(element('p', null,
      'Your device ran out of video memory, so the browser took the game\u2019s graphics away. Reloading usually brings it back.'));
    var reload = element('button', null, 'Reload');
    reload.type = 'button';
    reload.addEventListener('click', function () {
      storageSet(CONTEXT_LOST_KEY, '0');
      window.location.reload();
    });
    box.appendChild(reload);
    document.body.appendChild(box);
  }

  // The engine listens for this too, but all it does is alert() - a modal on an
  // iPhone, over a canvas that will never draw again. This runs first (capture on
  // document, before the canvas's own listener), keeps the preventDefault that
  // lets the browser restore the context, and reloads instead of stranding the
  // player. Two automatic reloads, then the button: a context that dies on every
  // attempt must not turn into a reload loop.
  function watchGraphicsContext() {
    document.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
      event.stopPropagation();
      var reloads = parseInt(storageGet(CONTEXT_LOST_KEY) || '0', 10) || 0;
      if (reloads < 2) {
        storageSet(CONTEXT_LOST_KEY, String(reloads + 1));
        window.setTimeout(function () { window.location.reload(); }, 1200);
        return;
      }
      showContextLost();
    }, true);

    document.addEventListener('webglcontextrestored', function () {
      window.location.reload();
    }, true);
  }

  // --- Boot -----------------------------------------------------------------

  function start() {
    buildKeyBar();
    buildRotateNotice();
    buildInstallHint();
    updateOrientation();
    watchGraphicsContext();
    // Half a minute of play is not a crash loop, so the next loss may reload again.
    window.setTimeout(function () { storageSet(CONTEXT_LOST_KEY, '0'); }, 25000);

    // iOS Safari ignores user-scalable=no, and a pinch-zoomed page puts the
    // canvas out of step with the finger positions the engine receives.
    document.addEventListener('gesturestart', function (event) { event.preventDefault(); });

    var refit = function () {
      updateOrientation();
      // The engine refits the canvas on window resize; this makes sure it hears
      // about the toolbar collapsing or the phone being turned.
      window.setTimeout(function () {
        window.dispatchEvent(new Event('resize'));
      }, 250);
    };
    window.addEventListener('orientationchange', refit);
    window.addEventListener('resize', updateOrientation);

    // An iPhone launched from the home screen often reports the window it had in
    // portrait (or an inset one) for the first frames, so the engine sizes the
    // 16:9 picture for a smaller screen and only refits on a later event. Nudge
    // it once the real size has settled, and again if the visual viewport moves.
    window.addEventListener('load', function () { window.setTimeout(refit, 300); });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        window.setTimeout(refit, 120);
      });
    }
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    var secure = window.location.protocol === 'https:' ||
      /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
    if (!secure) return;
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (error) {
        console.warn('PWA service worker did not register', error);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
  registerServiceWorker();
})();
