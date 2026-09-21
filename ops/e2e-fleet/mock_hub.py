#!/usr/bin/env python3
"""#1290 e2e harness: a mock amicode hub for headless fleet-client tests.

Serves the REAL app dist (so the built app is what's under test) plus a
minimal API surface and a scripted SSE stream. LATENCY_MS simulates the
intercontinental wire — the fleet client's honest cost — so the tests
exercise the app's holds/gates under realistic timing, not a localhost
fantasy.

  python3 mock_hub.py --dist <app-dist-dir> [--port 4180] [--latency 800]

Endpoints mirror what the app actually calls (observed against the real
hub, 2026-09-20): /global/config, /provider, /path, /project,
/config?directory=..., /session, /session?limit=N, /session/status,
/session/:id, /session/:id/message, /session/:id/touched-files,
/session/:id/diff, /session/:id/todo, /global/event (SSE), and the POST
surface for send/abort with scripted assistant replies.
"""
import argparse
import json
import os
import re
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LATENCY_MS = 0
DIST = Path(".")
NOW = int(time.time() * 1000)


def session(id_: str, title: str, directory: str) -> dict:
    # Shape captured from the real hub (2026-09-20): plain-string title,
    # numeric time fields.
    return {
        "id": id_,
        "slug": title.lower().replace(" ", "-"),
        "projectID": "global",
        "directory": directory,
        "path": directory.lstrip("/"),
        "summary": {"additions": 0, "deletions": 0, "files": 0},
        "cost": 0,
        "tokens": {"input": 100, "output": 20, "reasoning": 0, "cache": {"read": 0, "write": 0}},
        "title": title,
        "agent": "plan",
        "model": {"id": "mock-model", "providerID": "mock", "variant": "default"},
        "version": "1.18.29",
        "time": {"created": NOW - 3600_000, "updated": NOW - 60_000},
    }


PROJECTS = [
    {"id": "global", "worktree": "/", "time": {"created": NOW - 9999999, "updated": NOW}, "sandboxes": []},
    {"id": "proj_test_0001", "worktree": "/home/aaron/test-project", "vcs": "git", "time": {"created": NOW - 9999999, "updated": NOW}, "sandboxes": []},
]

SESSIONS = [
    session("ses_test_alpha_0001", "Alpha test session", "/home/aaron/test-project"),
    session("ses_test_beta_0002", "Beta test session", "/home/aaron/test-project"),
    session("ses_test_gamma_0003", "Gamma test session", "/home/aaron/test-project"),
]
BY_ID = {s["id"]: s for s in SESSIONS}
# appended by the draft-flow POST handlers (live-created sessions/messages)



EXTRA_MESSAGES: dict = {}

def messages_for(id_: str) -> list:
    # Shape captured from the real hub: [{info: {..., id, sessionID, role,
    # time}, parts: [{type: "text", text, id, sessionID, messageID}]}]
    out = []
    for i in range(1, 9):
        user_id = f"msg_user_{i:04d}"
        asst_id = f"msg_asst_{i:04d}"
        out.append({
            "info": {
                "id": user_id,
                "sessionID": id_,
                "role": "user",
                "agent": "plan",
                "model": {"id": "mock-model", "providerID": "mock", "variant": "default"},
                "summary": f"user message {i}",
                "time": {"created": NOW - 3000_000 + i * 2000},
            },
            "parts": [{
                "type": "text",
                "text": f"user message {i}",
                "id": f"prt_user_{i:04d}",
                "sessionID": id_,
                "messageID": user_id,
            }],
        })
        out.append({
            "info": {
                "id": asst_id,
                "sessionID": id_,
                "parentID": user_id,
                "role": "assistant",
                "mode": "plan",
                "agent": "plan",
                "path": {"cwd": "/home/aaron/test-project", "root": "/"},
                "cost": 0,
                "tokens": {"total": 50, "input": 40, "output": 10, "reasoning": 0, "cache": {"write": 0, "read": 0}},
                "modelID": "mock-model",
                "providerID": "mock",
                "finish": "stop",
                "time": {"created": NOW - 3000_000 + i * 2000 + 500, "completed": NOW - 3000_000 + i * 2000 + 900},
            },
            "parts": [
                {"type": "step-start", "id": f"prt_step_{i:04d}", "sessionID": id_, "messageID": asst_id},
                {"type": "text", "text": f"assistant reply {i}", "id": f"prt_asst_{i:04d}", "sessionID": id_, "messageID": asst_id},
            ],
        })
    # Live-sent messages (draft-flow /prompt handler) land after the scripted ones.
    out.extend(EXTRA_MESSAGES.get(id_, []))
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        try:
            line = fmt % a
            if "GET /" in line or "POST" in line:
                with open("/tmp/e2e_mock_requests.log", "a") as f:
                    f.write(line.split('"')[1] + "\n" if '"' in line else line + "\n")
        except Exception:
            pass
        print(f"REQ {self.path} {fmt % a}", flush=True)

    def _delay(self):
        if LATENCY_MS:
            time.sleep(LATENCY_MS / 1000.0)

    def _fixture(self, name):
        """Serve a response captured verbatim from the live hub (fixtures/)."""
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", name)) as f:
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                body = f.read().encode()
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except FileNotFoundError:
            self._json({"data": []})

    def _json(self, obj, status=200):
        self._delay()
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, ctype: str, cache: str | None = None):
        try:
            body = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self._delay()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        if cache:
            self.send_header("Cache-Control", cache)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        if self.path.split("?")[0] == "/__test/emit":
            try:
                payload_in = json.loads(body.decode() or "{}")
            except Exception:
                payload_in = {}
            payload = {"id": Events.next_id(), "type": payload_in.get("type", "session.updated"), "properties": payload_in.get("properties", {})}
            Events.emit_v1(payload, payload_in.get("directory"))
            self._json({"ok": True, "id": payload["id"]})
            return
        if self.path.split("?")[0] == "/__test/kill_sse":
            n = len(Events.members)
            Events.kill_all()
            self._json({"ok": True, "killed": n})
            return
        if self.path.split("?")[0] == "/__amicode_client_log":
            try:
                with open("/tmp/e2e-client-errors.log", "ab") as f:
                    f.write(body.rstrip(b"\r\n") + b"\n")
            except Exception:
                pass
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # Draft flow (first message in a new chat): create the session
        # for real, then let /prompt land the user message + emit the
        # events the app's stream applies.
        if re.match(r"^/session(\?|$)", self.path):
            try:
                params_in = json.loads(body.decode() or "{}")
            except Exception:
                params_in = {}
            directory = params_in.get("directory", "/home/aaron/test-project")
            new_id = f"ses_mock_{len(SESSIONS) + 1:04d}"
            info = {
                "id": new_id,
                "slug": f"mock-{len(SESSIONS) + 1}",
                "projectID": "global",
                "directory": directory,
                "path": directory,
                "title": params_in.get("title") or "",
                "time": {"created": int(time.time() * 1000), "updated": int(time.time() * 1000)},
            }
            SESSIONS.append(info)
            BY_ID[new_id] = info
            Events.emit_v1({"id": Events.next_id(), "type": "session.created", "properties": {"info": info}}, directory)
            self._json(info)
            return
        if m := re.match(r"^/session/([^/]+)/prompt$", self.path):
            sid = m.group(1)
            try:
                params_in = json.loads(body.decode() or "{}")
            except Exception:
                params_in = {}
            text_out = "\n".join(p.get("text", "") for p in params_in.get("parts", []) if p.get("type") == "text") or "sent"
            directory = (BY_ID.get(sid) or {}).get("directory", "/home/aaron/test-project")
            user_id = f"{sid}_user_{int(time.time() * 1000) % 100000}"
            EXTRA_MESSAGES.setdefault(sid, []).append({
                "info": {"id": user_id, "sessionID": sid, "role": "user", "agent": "plan",
                         "model": {"id": "mock-model", "providerID": "mock", "variant": "default"},
                         "time": {"created": int(time.time() * 1000)}},
                "parts": [{"type": "text", "text": text_out, "id": f"{user_id}_p", "sessionID": sid, "messageID": user_id}],
            })
            Events.emit_v1({"id": Events.next_id(), "type": "message.updated",
                            "properties": {"info": {"id": user_id, "sessionID": sid, "role": "user",
                                                    "agent": "plan", "time": {"created": int(time.time() * 1000)}}}}, directory)
            Events.emit_v1({"id": Events.next_id(), "type": "session.updated",
                            "properties": {"info": {**BY_ID.get(sid, {}), "title": text_out[:32]}}}, directory)
            self._json({"id": user_id, "ok": True})
            return
        if m := re.match(r"^/session/([^/]+)/message$", self.path):
            # Scripted send: emit an assistant reply on the SSE stream.
            text = json.loads(body or b"{}").get("prompt", "sent")
            Events.broadcast(json.dumps({
                "type": "session.user.message.updated",
                "properties": {"sessionID": m.group(1), "info": {"preview": text}},
            }))
            self._json({"id": m.group(1) + "_user_new", "ok": True})
            return
        if m := re.match(r"^/session/([^/]+)/abort$", self.path):
            self._json({"ok": True})
            return
        self._json({"ok": True})

    def do_GET(self):
        raw = self.path
        path = raw.split("?")[0]
        v2 = path.startswith("/api/")
        if v2:
            path = path[len("/api"):]
        # ---- v2 surface (wrapped {data: ...} shapes; captured from the
        # real hub 2026-09-20). The SSE fan-out is shared with v1.
        if v2 and path == "/event":
            self.handle_sse()
            return
        if v2 and path == "/session" and "limit" in raw:
            # #1294c: serve the REAL v2 list shape (location:{directory},
            # no top-level directory/slug) — the fixture captured from the
            # live hub. The mock's friendlier top-level shape let a raw-
            # remember crash pass the rig while the real panel crashed.
            import copy
            real_shaped = []
            for s in SESSIONS:
                r = dict(s)
                r.pop("directory", None)
                r.pop("path", None)
                r.pop("slug", None)
                r["location"] = {"directory": s.get("directory", "/home/aaron/test-project")}
                r.setdefault("model", {"id": "jev-1.13-free", "providerID": "opencode", "variant": "default"})
                real_shaped.append(r)
            self._json({"data": real_shaped, "cursor": {"next": None, "previous": None}})
            return
        if v2 and path == "/session/active":
            self._json({"data": {}})
            return
        if v2 and path == "/provider":
            self._fixture("provider.json")
            return
        if v2 and path == "/model":
            self._fixture("model.json")
            return
        if v2 and path == "/model/default":
            self._json({"data": {"modelID": "mock-model", "providerID": "mock"}})
            return
        if v2 and path == "/config":
            self._json({"data": {"default_agent": "plan", "theme": "opencode"}})
            return
        if v2 and path == "/project":
            # v2 project shape: {"location": ..., "data": [project...]}
            self._json({"location": {"directory": "/home/aaron/test-project", "project": {"id": "global", "directory": "/"}}, "data": PROJECTS})
            returnreturn
        if v2 and path == "/path":
            self._json({"home": "/home/aaron", "state": "/home/aaron/.local/state/opencode", "config": "/home/aaron/.config/opencode", "worktree": "/", "directory": "/home/aaron/test-project"})
            return
        if v2:
            # unknown /api path: the honest empty page
            self._json({"data": [], "cursor": {"next": None, "previous": None}})
            return
        if path == "/":
            self._file(DIST / "index.html", "text/html; charset=utf-8", "no-cache")
            return
        if path.startswith("/assets/"):
            rel = path[len("/assets/"):]
            if ".." in rel:
                self.send_error(403)
                return
            ctype = ("text/javascript" if rel.endswith(".js")
                     else "text/css" if rel.endswith(".css")
                     else "font/woff2" if rel.endswith(".woff2")
                     else "image/png" if rel.endswith(".png")
                     else "application/octet-stream")
            self._file(DIST / "assets" / rel, ctype, "public, max-age=31536000, immutable")
            return
        if path == "/global/event":
            self.handle_sse()
            return
        if path == "/global/config":
            # Real shape (live hub): the "model" field is the default
            # model as "provider/modelID" — the draft composer resolves its
            # default model chip from here; without it the submit is gated
            # behind "Select model" and no send ever fires.
            self._json({"$schema": "https://opencode.ai/config.json", "model": "opencode/jev-1.13-free", "provider": {}})
            return
        if path == "/provider":
            self._json([{"id": "mock", "env": {"MOCK": "1"}}])
            return
        if path == "/path":
            self._json({"home": "/home/aaron", "state": "/home/aaron/.local/state/opencode", "config": "/home/aaron/.config/opencode", "worktree": "/", "directory": "/home/aaron/test-project"})
            return
        if path == "/project":
            self._json(PROJECTS)
            return
        if path.startswith("/config"):
            self._json({"default_agent": "plan"})
            return
        if path == "/snapshot":
            # #1306: the hub frontdoor's snapshot contract — the whole recent
            # fleet state in ONE request (v1 shapes; trimmed list = sessions
            # whose pages had oversized tool strings cut by the frontdoor).
            top = 30
            for kv in self.path.split("?", 1)[1].split("&") if "?" in self.path else []:
                if kv.startswith("top="):
                    try: top = max(1, min(int(kv[4:]), 100))
                    except Exception: pass
            snap = {
                "snapshot": 1,
                "ts": time.time(),
                "health": {"healthy": True, "version": "1.18.29"},
                "sessions": SESSIONS,
                "messages": {s["id"]: messages_for(s["id"]) for s in SESSIONS[:top]},
                "trimmed": [],
            }
            self._json(snap)
            return
        if path == "/session" or path.startswith("/session?"):
            if "limit" in self.path:
                self._json(SESSIONS)
                return
            self._json(SESSIONS)
            return
        if path == "/session/status":
            self._json({s["id"]: {"type": "idle"} for s in SESSIONS})
            return
        if m := re.match(r"^/session/([^/]+)/message$", path):
            self._json(messages_for(m.group(1)))
            return
        if m := re.match(r"^/session/([^/]+)$", path):
            s = BY_ID.get(m.group(1))
            self._json(s if s else {"error": "not found"}, 200 if s else 404)
            return
        if m := re.match(r"^/session/([^/]+)/touched-files$", path):
            self._json([])
            return
        if m := re.match(r"^/session/([^/]+)/diff$", path):
            self._json([])
            return
        if m := re.match(r"^/session/([^/]+)/todo$", path):
            self._json([])
            return
        # Exact shapes from the live hub: /global/health is what
        # detectServerProtocol probes FIRST — {healthy:true} makes the app
        # pick the v1 protocol (the real fleet client runs v1; its request
        # log is all /global/config, /project, /global/event). A generic
        # {ok:true} here made headless clients pick v2 and diverge.
        # v1 per-directory bootstrap instance surfaces (real-hub shapes):
        # question/permission poll as bare arrays; agent/command are
        # fixtures captured verbatim (normalizeAgentList/the command list
        # parse real entries; hand-rolled ones tripped the bootstrap).
        if path == "/question":
            self._json([])
            return
        if path == "/permission":
            self._json([])
            return
        # amicode capsule poll (real-hub shape).
        if path == "/amicode/warrants":
            self._json({"ok": True, "warrants": []})
            return
        # v1 project current: resolve ?directory= to a project (global as
        # the catch-all, like the real hub's scaffold dir).
        if path == "/project/current":
            import urllib.parse as _up
            qs = _up.parse_qs(raw.split("?", 1)[1]) if "?" in raw else {}
            d = (qs.get("directory") or ["/"])[0]
            match = next((p for p in PROJECTS if p.get("worktree") == d), PROJECTS[0])
            self._json(match)
            return
        # v1 per-directory polls (real-hub shapes, all with ?directory=):
        # mcp/experimental/resource -> {}, lsp -> [], vcs -> null-branch.
        # 404ing these trips the bootstrap instance retry (console noise).
        if path == "/mcp":
            self._json({})
            return
        if path == "/lsp":
            self._json([])
            return
        if path == "/experimental/resource":
            self._json({})
            return
        if path == "/vcs":
            self._json({"branch": None, "default_branch": None})
            return
        if path == "/agent":
            self._fixture("agent.json")
            return
        if path == "/command":
            self._fixture("command.json")
            return
        if path == "/global/health":
            self._json({"healthy": True, "version": "1.18.29"})
            return
        if path == "/api/health":
            self._json({"healthy": True})
            return
        # SPA fallback: deep routes (/server/.../session/..., any history
        # URL) must serve the app shell, like the real frontdoor. A reload
        # on a session URL 404ing here broke the reload test entirely.
        if not re.search(r"/[^/]*\.[^/]*$", path) and not path.startswith("/assets/"):
            self.serve_index()
            return
        self.send_error(404)

    def serve_index(self):
        self._file(DIST / "index.html", "text/html; charset=utf-8", "no-cache")

    def handle_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        # close-delimited streaming: the app's fetch-stream reader needs
        # either chunked framing or a declared close; raw HTTP/1.1
        # keep-alive without Content-Length reads as a broken stream.
        self.send_header("Connection", "close")
        self.close_connection = True
        self.end_headers()
        try:
            # v1 wire shape: the id lets clients track Last-Event-ID
            # (#1264) — the bare {"type":...} never advanced the cursor.
            self.wfile.write(b"data: "
                + json.dumps({"payload": {"id": Events.next_id(), "type": "server.connected", "properties": {}}}).encode()
                + b"\n\n")
            self.wfile.flush()
            # #1264: replay the gap when the client brings lastEventID
            import urllib.parse as _up
            qs = self.path.split("?", 1)[1] if "?" in self.path else ""
            last_eid = None
            for kv in qs.split("&"):
                if kv.startswith("lastEventID="):
                    last_eid = _up.unquote(kv[len("lastEventID="):]) or None
            if last_eid is not None:
                for _, raw in Events.replay_after(last_eid):
                    self.wfile.write(b"data: " + raw.encode() + b"\n\n")
                self.wfile.flush()
            Events.join(self)
        except (BrokenPipeError, ConnectionResetError):
            pass


class EventFan:
    """Minimal SSE fan-out with per-member queues (frontdoor-style)."""

    def __init__(self):
        self.members: list = []
        self.lock = threading.Lock()

    def join(self, member):
        with self.lock:
            self.members.append(member)
        try:
            while True:
                time.sleep(30)
                member.wfile.write(b": keepalive\n\n")
                member.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with self.lock:
                if member in self.members:
                    self.members.remove(member)

    def broadcast(self, frame: str):
        data = f"data: {frame}\n\n".encode()
        with self.lock:
            members = list(self.members)
        for m in members:
            try:
                m.wfile.write(data)
                m.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                with self.lock:
                    if m in self.members:
                        self.members.remove(m)

    # --- #1264: replay surface (the real frontdoor's contract). History
    # holds id-carrying events only; reconnects with ?lastEventID=<id>
    # get the gap replayed. Id-less frames (heartbeats) skip history.
    HISTORY_MAX = 512

    def __init__(self):
        self.members: list = []
        self.lock = threading.Lock()
        self.history: list = []   # [(evt_id, frame_bytes)]
        self.seq = 0

    def next_id(self):
        with self.lock:
            self.seq += 1
            return f"evt_mock_{self.seq:04d}"

    def emit_v1(self, payload: dict, directory: str | None = None):
        """Emit a wire-exact v1 event: {"directory"?, "payload": {...}}"""
        frame = {"payload": payload}
        if directory is not None:
            frame["directory"] = directory
        raw = json.dumps(frame)
        eid = payload.get("id")
        if eid:
            with self.lock:
                self.history.append((eid, raw))
                if len(self.history) > self.HISTORY_MAX:
                    del self.history[: len(self.history) - self.HISTORY_MAX]
        self.broadcast(raw)

    def replay_after(self, last_eid):
        with self.lock:
            if not self.history:
                return []
            index = None
            for i, (eid, _) in enumerate(self.history):
                if eid == last_eid:
                    index = i
                    break
            items = self.history[index + 1:] if index is not None else self.history
            return list(items)

    def kill_all(self):
        with self.lock:
            members = list(self.members)
        for m in members:
            try:
                m.connection.close()
            except Exception:
                pass


Events = EventFan()


def main():
    global LATENCY_MS, DIST
    ap = argparse.ArgumentParser()
    ap.add_argument("--dist", required=True)
    ap.add_argument("--port", type=int, default=4180)
    ap.add_argument("--latency", type=int, default=0)
    args = ap.parse_args()
    LATENCY_MS = args.latency
    DIST = Path(args.dist)
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"mock-hub listening on 127.0.0.1:{args.port} (latency {LATENCY_MS}ms, dist {DIST})")
    srv.serve_forever()


if __name__ == "__main__":
    main()
