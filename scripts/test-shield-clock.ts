import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const source = readFileSync(new URL("../packages/browser-extension/src/shield.js", import.meta.url), "utf8");

// Controllable host clocks let us exercise hours of idle time and suspended
// timers without waiting. The actual shield runs unchanged in its own realm.
function fixture() {
  const context = createContext({});
  runInContext(`
    let elapsed = 1000, wall = 1700000001000;
    const RealDate = Date;
    Date = new Proxy(RealDate, {
      construct(target, args) { return Reflect.construct(target, args.length ? args : [wall]); },
      apply() { return new RealDate(wall).toString(); },
      get(target, key) { return key === 'now' ? () => wall : Reflect.get(target, key); }
    });
    class Performance { now() { return elapsed; } }
    const performance = new Performance();
    const window = globalThis;
    class Window {}
    class Navigator {}
    const navigator = new Navigator();
    navigator.platform = 'MacIntel';
    const listeners = {};
    function listen(name, fn) { (listeners[name] ||= []).push(fn); }
    function dispatch(name, event = {}) { for (const fn of listeners[name] || []) fn(event); }
    const document = { hidden: false, addEventListener: listen };
    window.addEventListener = listen;
    window.outerHeight = 900; window.innerHeight = 800;
    const timers = new Map();
    let timerId = 0;
    window.setInterval = fn => { timers.set(++timerId, fn); return timerId; };
    window.clearInterval = id => timers.delete(id);
    window.setTimeout = () => ++timerId;
    window.requestAnimationFrame = fn => { fn(elapsed - 5); return 1; };
    window.chrome = {};
    function advance(ms, tick = false) {
      elapsed += ms; wall += ms;
      if (tick) for (const fn of timers.values()) fn();
    }
  `, context);
  runInContext(source, context);
  return (code: string) => runInContext(code, context);
}

test("ordinary sparse reads retain a full hour of elapsed and wall time", () => {
  const run = fixture();
  expect(run(`(() => {
    const p = performance.now(), d = Date.now();
    for (let i = 0; i < 3600; i++) { advance(1000); performance.now(); }
    return [performance.now() - p, Date.now() - d, +new Date() - d];
  })()`)).toEqual([3600000, 3600000, 3600000]);
});

test("delayed foreground timers do not subtract elapsed time", () => {
  const run = fixture();
  expect(run(`const start = Date.now(); advance(1500, true); Date.now() - start`)).toBe(1500);
});

test("background, sleep and bfcache restoration retain native clocks", () => {
  const run = fixture();
  expect(run(`(() => {
    const p = performance.now(), d = Date.now();
    document.hidden = true; dispatch('visibilitychange'); dispatch('pagehide');
    advance(28800000);
    document.hidden = false; dispatch('visibilitychange'); dispatch('pageshow', { persisted: true });
    return [performance.now() - p, Date.now() - d];
  })()`)).toEqual([28800000, 28800000]);
});

test("wall clock corrections are not clamped", () => {
  const run = fixture();
  expect(run(`const start = Date.now(); wall -= 5000; Date.now() - start`)).toBe(-5000);
});

test("animation callbacks receive the browser's frame timestamp", () => {
  const run = fixture();
  expect(run(`let stamp; requestAnimationFrame(t => stamp = t); stamp`)).toBe(995);
});

test("Chrome timing fallbacks use unmodified clocks", () => {
  const run = fixture();
  expect(run(`chrome.csi(); advance(5000); [chrome.csi().pageT, chrome.loadTimes().finishLoadTime]`))
    .toEqual([6000, 1700000006]);
});
