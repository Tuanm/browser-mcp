/**
 * Anti-Detection Shield — injected into MAIN world at document_start.
 *
 * Patches browser APIs that anti-bot scripts use to detect CDP/DevTools.
 * Runs BEFORE any page script, making patches invisible.
 *
 * Detection vectors neutralized:
 * 1. debugger statement timing (performance.now / Date.now / Date() / rAF offset)
 * 2. DevTools window dimension check (outerHeight/outerWidth on prototype)
 * 3. navigator.webdriver flag (on prototype)
 * 4. console.clear no-op
 * 5. Function constructor / setTimeout string debugger stripping
 * 6. chrome.csi / chrome.loadTimes normalization
 *
 * Architecture: Direct function replacement + patched Function.prototype.toString.
 * No Proxy on patched functions — survives Function.prototype.toString.call().
 * Date and Function constructors use Proxy with get traps for .prototype.
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
  // 1. Debugger statement timing neutralization
  //
  // Detection: performance.now() / Date.now() / new Date() / rAF timestamp
  // gaps reveal debugger pauses.
  //
  // Fix: Track cumulative pause time via setInterval detector with
  // visibility guard, delta cap, adaptive baseline, and monotonicity.
  // =========================================================================

  const _perfNow = performance.now.bind(performance);
  const _dateNow = Date.now;
  const _OrigDate = Date;
  let _offset = 0;
  let _highWater = 0;
  let _detectorActive = true;

  // Capture real chrome height before any DevTools opens
  const _chromeH = Math.min(Math.max(window.outerHeight - window.innerHeight, 20), 120) || 80;
  const _sideChrome = /Win/.test(navigator.platform) ? 14 : 0;

  // Adaptive baseline for interval timing (handles CPU variance)
  let _baseline = 50;
  let _lastCheck = _perfNow();
  let _lastCorrectionTime = 0; // Prevents double correction (inline + tick)

  function _detectorTick() {
    if (!_detectorActive || document.hidden) {
      _lastCheck = _perfNow();
      return;
    }
    const now = _perfNow();
    const delta = now - _lastCheck;
    if (delta > 200 && delta < 30000) {
      // Only correct if inline correction hasn't already handled this pause
      if (now - _lastCorrectionTime > _baseline * 2) {
        _offset += delta - _baseline;
        _lastCorrectionTime = now;
      }
    } else if (delta < 200) {
      _baseline = _baseline * 0.9 + delta * 0.1;
    }
    _lastCheck = now;
  }

  let _detector = setInterval(_detectorTick, 50);

  // Pause detector when tab is backgrounded (Chrome throttles to 1000ms+)
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      _detectorActive = false;
    } else {
      _lastCheck = _perfNow();
      _detectorActive = true;
    }
  });

  // Monotonic performance.now() with offset — shared high-water for all APIs.
  // Inline anomaly detection closes the race window between debugger pause
  // and setInterval correction (synchronous reads before tick fires).
  // Coordination flag (_lastCorrectionTime) prevents double correction.
  function _adjustedPerfNow() {
    var now = _perfNow();
    var raw = now - _offset;
    if (_highWater > 0 && raw > _highWater + 200) {
      _offset += raw - _highWater - 1;
      _lastCorrectionTime = now;
      raw = now - _offset;
    }
    if (raw > _highWater) _highWater = raw;
    return _highWater;
  }

  // Patch Performance.prototype.now (not instance — avoids hasOwnProperty)
  const _origPerfNowDesc = Object.getOwnPropertyDescriptor(Performance.prototype, "now");
  const _patchedPerfNow = function now() {
    return _adjustedPerfNow();
  };
  _registerNative(_patchedPerfNow, "now");
  Object.defineProperty(Performance.prototype, "now", {
    ...(_origPerfNowDesc || {}),
    value: _patchedPerfNow,
    writable: true,
    configurable: true,
  });

  // Patch Date.now() — same offset, rounded to integer, monotonic
  let _lastDateNow = 0;
  const _patchedDateNow = function now() {
    var v = Math.round(_dateNow.call(_OrigDate) - _offset);
    if (v < _lastDateNow) v = _lastDateNow;
    _lastDateNow = v;
    return v;
  };
  _registerNative(_patchedDateNow, "now");
  Date.now = _patchedDateNow;

  // Patch Date constructor — new Date() / Date() consistency with Date.now()
  const _DateProxy = new Proxy(_OrigDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) {
        return Reflect.construct(target, [_patchedDateNow()], newTarget);
      }
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) {
      if (args.length === 0) {
        return new target(_patchedDateNow()).toString();
      }
      return Reflect.apply(target, thisArg, args);
    },
    get(target, prop) {
      if (prop === "now") return _patchedDateNow;
      if (prop === "prototype") return _OrigDate.prototype;
      return Reflect.get(target, prop);
    },
  });
  // Proxy get trap handles .prototype reads; set constructor on original
  _OrigDate.prototype.constructor = _DateProxy;
  _registerNative(_DateProxy, "Date");
  try {
    window.Date = _DateProxy;
  } catch {}

  // Patch requestAnimationFrame — route through shared monotonic high-water
  const _origRAF = window.requestAnimationFrame;
  const _patchedRAF = function requestAnimationFrame(callback) {
    return _origRAF.call(window, (timestamp) => {
      callback(_adjustedPerfNow());
    });
  };
  _registerNative(_patchedRAF, "requestAnimationFrame");
  window.requestAnimationFrame = _patchedRAF;

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
          if (_csiOnloadT === null) _csiOnloadT = _patchedDateNow();
          return {
            onloadT: _csiOnloadT,
            startE: _csiOnloadT - 500,
            pageT: _adjustedPerfNow(),
            tran: 15,
          };
        };
        _registerNative(window.chrome.csi, "csi");
      }
      if (!window.chrome.loadTimes) {
        window.chrome.loadTimes = () => {
          var now = _patchedDateNow() / 1000;
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

  // =========================================================================
  // Cleanup: stop pause detector on unload, restart on bfcache restore
  // =========================================================================

  window.addEventListener("pagehide", () => {
    clearInterval(_detector);
  });
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      _lastCheck = _perfNow();
      _detectorActive = true;
      _detector = setInterval(_detectorTick, 50);
    }
  });
})();
