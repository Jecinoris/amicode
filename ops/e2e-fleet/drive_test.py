#!/usr/bin/env python3
"""#1290 e2e: boot the real app against the mock hub and assert the
never-blank invariants tonight's debugging established.

PASS criteria (the fleet-client contract):
  1. The app boots to a usable state.
  2. Opening and switching between sessions NEVER leaves the route outlet
     empty (main:0) or the panel frame absent for > BLANK_TOLERANCE_MS.
  3. No uncaught errors beyond the benign ResizeObserver loop notice.

Usage: python3 drive_test.py --port 4180 [--headless]
(must be run while mock_hub.py is serving; use run_all.sh for the full
bundle: mock + headless chrome + assertions at multiple latencies.)
"""
import argparse
import json
import subprocess
import time
import urllib.request
import websocket

BLANK_TOLERANCE_MS = 400  # keyed transitions may take a few frames; blanks may not


def get_page_target(port):
    for _ in range(40):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=5))
            for t in tabs:
                if t.get("type") == "page":
                    return t
        except Exception:
            pass
        time.sleep(0.5)
    raise SystemExit("no page target on the debugger port")


class Driver:
    def __init__(self, debug_port, app_port, latency_ms):
        self.t = get_page_target(debug_port)
        self.ws = websocket.create_connection(self.t["webSocketDebuggerUrl"], timeout=90)
        self._id = 0
        self.errors: list[str] = []
        self.app_port = app_port
        self.latency_ms = latency_ms

    def send(self, method, params=None):
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("method") == "Runtime.exceptionThrown":
                d = m["params"]["exceptionDetails"]
                self.errors.append(str(d.get("exception", {}).get("description", ""))[:300])
            if m.get("method") == "Runtime.consoleAPICalled":
                d = m["params"]
                if d.get("type") == "error":
                    text = " ".join(str(a.get("value", "")) for a in d.get("args", []))
                    if "ResizeObserver loop" not in text:
                        self.errors.append(text[:300])
            if m.get("id") == self._id:
                if "error" in m:
                    raise RuntimeError(str(m["error"])[:200])
                return m.get("result", {})

    def ev(self, expr, await_promise=False):
        r = self.send("Runtime.evaluate", {"expression": expr, "returnByValue": True, "awaitPromise": await_promise})
        if r.get("exceptionDetails"):
            raise RuntimeError(str(r["exceptionDetails"])[:200])
        return r.get("result", {}).get("value")

    def navigate_and_boot(self):
        self.send("Runtime.enable")
        self.send("Page.enable")
        self.send("Emulation.setDeviceMetricsOverride", {"width": 1680, "height": 1000, "deviceScaleFactor": 1, "mobile": False})
        self.send("Page.navigate", {"url": f"http://127.0.0.1:{self.app_port}/?colorScheme=dark"})
        for _ in range(60):
            time.sleep(1)
            if self.ev("document.querySelector('main') !== null"):
                break
        else:
            raise AssertionError("app never rendered a <main>")

    def install_observer(self):
        self.ev(r"""
(() => {
  window.__blankEvents = [];
  window.__lastState = "ok";
  const snap = () => {
    const main = document.querySelector('main');
    const frame = document.querySelector('[data-amicode-panel]');
    const outlet = main ? main.childElementCount : -1;
    // noframe only counts where a frame is owed: REAL session routes.
    // Draft views and the sessions list have no [data-amicode-panel]
    // by design — the tag only mounts with a session timeline.
    const sessionRoute = /\/session\//.test(location.pathname);
    const state = (outlet === 0 || (main === null)) ? 'blank' : (frame ? 'ok' : (sessionRoute ? 'noframe' : 'ok'));
    const now = performance.now();
    const last = window.__blankEvents[window.__blankEvents.length - 1];
    if (state !== 'ok') {
      if (!last || last.state !== state) window.__blankEvents.push({state, at: now});
      else last.until = now;
    }
    requestAnimationFrame(snap);
  };
  requestAnimationFrame(snap);
})()
""")

    def blank_ms(self, since=0):
        """Total blank/noframe exposure since `since` (ms), from the observer."""
        events = self.ev("window.__blankEvents || []") or []
        total = 0
        for e in events:
            dur = (e.get("until", e["at"])) - e["at"]
            if e["at"] >= since:
                total += max(0, dur)
        return total, events

    def find_session_cards(self):
        return self.ev(r"""Array.from(document.querySelectorAll('button, [role=button], div'))
          .filter(e => e.childElementCount <= 6 && /^Alpha test session$|^Beta test session$|^Gamma test session$/.test((e.innerText||'').trim()))
          .length""")

    def ensure_draft(self):
        """The app self-creates a draft against the real hub; in the mock it
        sometimes needs the New Session button clicked."""
        for _ in range(10):
            if "draftId" in str(self.ev("location.href")):
                return True
            clicked = self.ev(r"""(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (b2 => (b2 === 'New Session'))((x.innerText||'').trim())); if (b) { b.click(); return true } return false })()""")
            if not clicked:
                clicked = self.ev(r"""(() => { const b = Array.from(document.querySelectorAll('button')).find(x => (x.innerText||'').trim() === 'New Session'); if (b) { b.click(); return true } return false })()""")
            time.sleep(2)
        return "draftId" in str(self.ev("location.href"))

    def open_sessions_view(self):
        """The titlebar buttons are aria-labeled, not text-labeled."""
        return self.ev(r"""(() => { const b = Array.from(document.querySelectorAll('button')).find(x => ((x.getAttribute('aria-label')||'') + (x.innerText||'')).includes('Sessions')); if(b){b.click(); return true} return false })()""")

    def click_card(self, title):
        return self.ev(r"""(() => {
          const txt = (e) => ((e.getAttribute && e.getAttribute('aria-label')) || '') + (e.innerText||'');
          const els = Array.from(document.querySelectorAll('button, [role=button], div'))
            .filter(e => e.childElementCount <= 6 && txt(e).trim().startsWith('""" + title + r"""'));
          if (!els.length) return 'missing';
          els[els.length-1].click(); return 'ok';
        })()""")


def run(debug_port, app_port, latency_ms):
    d = Driver(debug_port, app_port, latency_ms)
    d.navigate_and_boot()
    d.ensure_draft()
    d.install_observer()
    boot_blank, _ = d.blank_ms()

    # Flow 1: open the sessions list, then two sessions, and switch tabs.
    d.open_sessions_view()
    time.sleep(5)
    cards = d.find_session_cards()
    if cards == 0:
        raise AssertionError("session cards not found — the mock's list shape needs updating")
    assert d.click_card("Alpha test session") == "ok"
    time.sleep(6)
    d.open_sessions_view()
    time.sleep(4)
    assert d.click_card("Beta test session") == "ok"
    time.sleep(6)
    # switch back and forth via the tab strip
    for title in ("Alpha test session", "Beta test session", "Alpha test session"):
        clicked = d.ev(r"""(() => {
          const txt = (e) => ((e.getAttribute && e.getAttribute('aria-label')) || '') + (e.innerText||'');
          // The tab strip renders tabs as <a> anchors; titlebar buttons are
          // aria-labeled. Match both, smallest first.
          const all = Array.from(document.querySelectorAll('a, button, [role=button]'))
            .filter(e => txt(e).trim().startsWith('""" + title + r"""') && e.childElementCount <= 8);
          const tabs = all.filter(e => e.tagName === 'A');
          const any = tabs.length ? tabs : all;
          if (!any.length) return 'missing';
          any[0].click(); return 'ok';
        })()""")
        if clicked != "ok":
            raise AssertionError(f"tab for {title} not found — selector drift?")
        time.sleep(4)

    total_blank, events = d.blank_ms()
    verdict = "PASS"
    if total_blank > BLANK_TOLERANCE_MS:
        verdict = "FAIL"
    print(f"[latency={latency_ms}ms] boot_blank={boot_blank:.0f}ms flow_blank={total_blank - boot_blank:.0f}ms "
          f"(tolerance {BLANK_TOLERANCE_MS}ms) errors={len(d.errors)} -> {verdict}")
    if events:
        print("  blank events:", json.dumps(events)[:400])
    for e in d.errors[:5]:
        print("  error:", e[:200])
    return verdict == "PASS" and not d.errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--debug-port", type=int, default=9334)
    ap.add_argument("--app-port", type=int, default=4180)
    ap.add_argument("--latency", type=int, default=0)
    args = ap.parse_args()
    ok = run(args.debug_port, args.app_port, args.latency)
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
