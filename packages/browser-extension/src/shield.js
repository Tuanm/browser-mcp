/**
 * Anti-Detection Shield — injected into MAIN world at document_start.
 *
 * Patches browser APIs that anti-bot scripts use to detect CDP/DevTools.
 * Runs BEFORE any page script, making patches invisible.
 *
 * Detection vectors neutralized:
 * - DevTools window dimension check (outerHeight/outerWidth on prototype)
 * - navigator.webdriver flag (on prototype)
 * - console.clear no-op
 * - Function constructor / setTimeout string debugger stripping
 * - chrome.csi / chrome.loadTimes normalization
 *
 * Architecture: Direct function replacement + patched Function.prototype.toString.
 * No Proxy on patched functions — survives Function.prototype.toString.call().
 * The Function constructor uses a Proxy with a get trap for .prototype.
 * Each section wrapped in try-catch for resilience.
 */

(() => {
  // Guard: Symbol.for with stable key (Symbol() would be unique per invocation)
  const _gk = Symbol.for("__s_" + 0x7a3c);
  if (window[_gk]) return;
  Object.defineProperty(window, _gk, { value: true });

  // =========================================================================
  // Core: Function.prototype.toString override
  //
  // All patched functions register their native-looking toString here.
  // This survives both fn.toString() AND Function.prototype.toString.call(fn).
  // =========================================================================

  const _nativeStrings = new WeakMap();
  const _origToString = Function.prototype.toString;

  function _registerNative(fn, name) {
    _nativeStrings.set(fn, "function " + name + "() { [native code] }");
  }

  const _patchedToString = function toString() {
    const s = _nativeStrings.get(this);
    if (s) return s;
    return _origToString.call(this);
  };
  _registerNative(_patchedToString, "toString");
  Function.prototype.toString = _patchedToString;

  // =========================================================================
  // Preserve native Date, performance.now and requestAnimationFrame clocks.
  // Idle reads, throttling, CPU stalls and sleep cannot be distinguished from
  // debugger pauses by timing gaps. Subtracting them freezes page wall clocks.
  // =========================================================================

  const _perfNow = performance.now.bind(performance);
  const _dateNow = Date.now.bind(Date);

  // Capture real chrome height before any DevTools opens
  const _chromeH = Math.min(Math.max(window.outerHeight - window.innerHeight, 20), 120) || 80;
  const _sideChrome = /Win/.test(navigator.platform) ? 14 : 0;

  // =========================================================================
  // 2. Window dimension spoofing (on prototype, matching native shape)
  // =========================================================================

  try {
    const _getOuterHeight = function outerHeight() {
      return this.innerHeight + _chromeH;
    };
    _registerNative(_getOuterHeight, "get outerHeight");
    Object.defineProperty(Window.prototype, "outerHeight", {
      get: _getOuterHeight,
      set: undefined,
      enumerable: true,
      configurable: true,
    });

    const _getOuterWidth = function outerWidth() {
      return this.innerWidth + _sideChrome;
    };
    _registerNative(_getOuterWidth, "get outerWidth");
    Object.defineProperty(Window.prototype, "outerWidth", {
      get: _getOuterWidth,
      set: undefined,
      enumerable: true,
      configurable: true,
    });
  } catch {}

  // =========================================================================
  // 3. navigator.webdriver (on prototype — false is the normal Chrome state)
  // =========================================================================

  try {
    const _getWebdriver = function webdriver() {
      return false;
    };
    _registerNative(_getWebdriver, "get webdriver");
    Object.defineProperty(Navigator.prototype, "webdriver", {
      get: _getWebdriver,
      set: undefined,
      enumerable: true,
      configurable: true,
    });
  } catch {}

  // =========================================================================
  // 4. Console-based timing detection
  // =========================================================================

  const _patchedClear = function clear() {};
  _registerNative(_patchedClear, "clear");
  console.clear = _patchedClear;

  // =========================================================================
  // 5. Error.stack cleanup — filter debugger/automation frames
  // =========================================================================

  // NOTE: Error.prepareStackTrace override removed — setting this changes
  // error handling behavior for ALL errors on the page. SPA frameworks and
  // error-reporting libraries depend on specific stack trace formatting.
  // The chrome-extension:// frames are already hidden by our toString override.

  // =========================================================================
  // 6. Debugger trap neutralization
  //
  // Strips `debugger` statements from: Function constructor,
  // setTimeout/setInterval string overloads.
  // =========================================================================

  try {
    // Regex: match standalone `debugger` statement with word boundary
    const _dbgRe = /(?:^|[;{}\s(,])debugger(?![\w$])\s*;?/g;
    function _stripDebugger(code) {
      if (typeof code !== "string" || !_dbgRe.test(code)) return code;
      _dbgRe.lastIndex = 0;
      return code.replace(_dbgRe, (m) => m.replace(/debugger(?![\w$])\s*;?/, "void 0;"));
    }

    // Function constructor
    const _origFunction = Function;
    const _funcProxy = new Proxy(_origFunction, {
      construct(target, args, newTarget) {
        if (args.length > 0) {
          const i = args.length - 1;
          if (typeof args[i] === "string") {
            args = [...args];
            args[i] = _stripDebugger(args[i]);
          }
        }
        return Reflect.construct(target, args, newTarget);
      },
      apply(target, thisArg, args) {
        if (args.length > 0) {
          const i = args.length - 1;
          if (typeof args[i] === "string") {
            args = [...args];
            args[i] = _stripDebugger(args[i]);
          }
        }
        return Reflect.apply(target, thisArg, args);
      },
      get(target, prop) {
        if (prop === "prototype") return _origFunction.prototype;
        return Reflect.get(target, prop);
      },
    });
    // Proxy get trap handles .prototype reads; set constructor on original
    _origFunction.prototype.constructor = _funcProxy;
    _registerNative(_funcProxy, "Function");
    try {
      window.Function = _funcProxy;
    } catch {}

    // NOTE: eval override removed — converting direct eval to indirect eval
    // breaks local scope access (e.g., webpack devtool:"eval", HMR).
    // The Function constructor Proxy already strips debugger from new Function().

    // setTimeout / setInterval string overloads
    for (const name of ["setTimeout", "setInterval"]) {
      const orig = window[name];
      const patched = function (handler, delay) {
        if (typeof handler === "string") {
          handler = _stripDebugger(handler);
        }
        var args = [handler, delay];
        for (var j = 2; j < arguments.length; j++) args.push(arguments[j]);
        return orig.apply(this || window, args);
      };
      _registerNative(patched, name);
      Object.defineProperty(patched, "name", { value: name });
      Object.defineProperty(patched, "length", { value: 1 });
      window[name] = patched;
    }
  } catch {}

  // =========================================================================
  // 7. Chrome-specific normalization
  // =========================================================================

  try {
    if (typeof window.chrome === "object" && window.chrome) {
      if (!window.chrome.csi) {
        var _csiOnloadT = null;
        window.chrome.csi = () => {
          if (_csiOnloadT === null) _csiOnloadT = _dateNow();
          return {
            onloadT: _csiOnloadT,
            startE: _csiOnloadT - 500,
            pageT: _perfNow(),
            tran: 15,
          };
        };
        _registerNative(window.chrome.csi, "csi");
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = () => {
          var now = _dateNow() / 1000;
          return {
            commitLoadTime: now,
            connectionInfo: "h2",
            finishDocumentLoadTime: now,
            finishLoadTime: now,
            firstPaintAfterLoadTime: 0,
            firstPaintTime: now,
            navigationType: "Other",
            npnNegotiatedProtocol: "h2",
            requestTime: now - 0.5,
            startLoadTime: now - 0.5,
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
          };
        };
        _registerNative(window.chrome.loadTimes, "loadTimes");
      }
      if (!window.chrome.app) {
        window.chrome.app = {
          isInstalled: false,
          InstallState: {
            DISABLED: "disabled",
            INSTALLED: "installed",
            NOT_INSTALLED: "not_installed",
          },
          RunningState: {
            CANNOT_RUN: "cannot_run",
            READY_TO_RUN: "ready_to_run",
            RUNNING: "running",
          },
        };
      }
    }
  } catch {}
})();
