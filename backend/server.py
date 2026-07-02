import os
import re
import sys
import json
import asyncio
import threading
import zipfile
import shutil
from io import BytesIO
from pathlib import Path
from datetime import datetime
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, PlainTextResponse, FileResponse
from pydantic import BaseModel

# Force Rich / CrewAI to render narrower box-drawing to fit the UI
os.environ["COLUMNS"] = "57"

WORKSPACES_ROOT = Path("./workspaces")
WORKSPACES_ROOT.mkdir(exist_ok=True)

ENV_PATH = Path("./.env")

from main import execute_agenthub_run

app = FastAPI(title="AgentHub Studio Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─── stdout interceptor (with log persistence) ────────────────────────────

class WSOutputRedirector:
    """
    Intercepts print() and:
    1. Fans output to all connected WebSocket clients (live streaming).
    2. Appends output to workspaces/{active_session}/terminal.log (persistence).
    """
    def __init__(self, original_stdout):
        self.original_stdout = original_stdout
        self.clients: set = set()
        self.loop = None
        self.active_session_path: Optional[Path] = None  # set per-run
        self._log_lock = threading.Lock()

    def set_active_session(self, session_path: Optional[Path]):
        self.active_session_path = session_path

    def write(self, msg):
        self.original_stdout.write(msg)
        self.original_stdout.flush()

        # Persist to terminal.log
        if msg.strip() and self.active_session_path:
            with self._log_lock:
                try:
                    log_file = self.active_session_path / "terminal.log"
                    with open(log_file, "a", encoding="utf-8") as f:
                        f.write(msg)
                except Exception:
                    pass

        # Stream to WebSocket clients
        if self.loop and self.loop.is_running() and self.clients:
            for ws in list(self.clients):
                try:
                    asyncio.run_coroutine_threadsafe(ws.send_text(msg), self.loop)
                except Exception:
                    pass

    def flush(self):
        self.original_stdout.flush()


# ─── stdin interceptor (HITL) ──────────────────────────────────────────────

class StdinInterceptor:
    """Blocks CrewAI's input() call until the frontend sends a HUMAN_INPUT: reply."""
    def __init__(self):
        self._event = threading.Event()
        self._value: str = ""

    def readline(self) -> str:
        self._event.clear()
        self._value = ""
        if ws_redirector.loop and ws_redirector.loop.is_running():
            for client in list(ws_redirector.clients):
                try:
                    asyncio.run_coroutine_threadsafe(
                        client.send_text("__HUMAN_INPUT_REQUIRED__"),
                        ws_redirector.loop
                    )
                except Exception:
                    pass
        ws_redirector.original_stdout.write("[SERVER] Waiting for human input from UI...\n")
        ws_redirector.original_stdout.flush()
        self._event.wait()
        return self._value + "\n"

    def provide(self, value: str):
        self._value = value
        self._event.set()

    def readable(self): return True
    def writable(self): return False
    def flush(self): pass


ws_redirector = WSOutputRedirector(sys.stdout)
sys.stdout = ws_redirector

stdin_interceptor = StdinInterceptor()
sys.stdin = stdin_interceptor


@app.on_event("startup")
async def startup_event():
    ws_redirector.loop = asyncio.get_running_loop()


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    ws_redirector.clients.add(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            if data.startswith("HUMAN_INPUT:"):
                human_text = data[len("HUMAN_INPUT:"):]
                ws_redirector.original_stdout.write(f"[SERVER] Human input received: {human_text}\n")
                ws_redirector.original_stdout.flush()
                stdin_interceptor.provide(human_text)
            else:
                ws_redirector.original_stdout.write(f"WEB_MSG:{data}\n")
                ws_redirector.original_stdout.flush()
    except WebSocketDisconnect:
        ws_redirector.clients.discard(websocket)


# ─── Session helpers ───────────────────────────────────────────────────────

def _slugify(text: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", text.lower())
    slug = re.sub(r"[\s_-]+", "_", slug).strip("_")
    return slug[:48] or "session"


def _unique_session_id(base: str) -> str:
    if not (WORKSPACES_ROOT / base).exists():
        return base
    counter = 2
    while (WORKSPACES_ROOT / f"{base}_{counter}").exists():
        counter += 1
    return f"{base}_{counter}"


def _write_meta(session_path: Path, data: dict):
    (session_path / "meta.json").write_text(json.dumps(data, indent=2, default=str))


def _read_meta(session_path: Path) -> dict:
    f = session_path / "meta.json"
    return json.loads(f.read_text()) if f.exists() else {}


def _broadcast(msg: str):
    if ws_redirector.loop and ws_redirector.loop.is_running():
        for ws in list(ws_redirector.clients):
            try:
                asyncio.run_coroutine_threadsafe(ws.send_text(msg), ws_redirector.loop)
            except Exception:
                pass


def _guard(session_id: str) -> Path:
    target = (WORKSPACES_ROOT / session_id).resolve()
    if not str(target).startswith(str(WORKSPACES_ROOT.resolve())):
        raise HTTPException(status_code=403, detail="Access denied.")
    if not target.exists():
        raise HTTPException(status_code=404, detail="Session not found.")
    return target


# ─── Kickoff ───────────────────────────────────────────────────────────────

class PromptRequest(BaseModel):
    user_prompt: str
    session_name: Optional[str] = None
    agents: Optional[list[str]] = None
    resume_session_id: Optional[str] = None
    llm_keys: Optional[dict] = None
    llm_provider: Optional[str] = "gemini"


@app.post("/api/kickoff")
async def kickoff_agent(request: PromptRequest):
    """Create (or resume) a session folder, then run CrewAI in a background thread."""

    # ── Resume an existing session ──────────────────────────────────────────
    if request.resume_session_id:
        session_id = request.resume_session_id
        session_path = (WORKSPACES_ROOT / session_id).resolve()
        if not str(session_path).startswith(str(WORKSPACES_ROOT.resolve())) or not session_path.exists():
            raise HTTPException(status_code=404, detail="Session not found.")
        meta = _read_meta(session_path)
        meta["status"] = "running"
        meta["finished_at"] = None
        history = meta.get("history", [])
        history.append({"prompt": request.user_prompt, "at": datetime.now().isoformat()})
        meta["history"] = history
        _write_meta(session_path, meta)
        display_name = meta.get("name", session_id)

    # ── Create a brand-new session ──────────────────────────────────────────
    else:
        raw_name = (request.session_name or "").strip() or request.user_prompt
        base_slug = _slugify(raw_name)
        session_id = _unique_session_id(base_slug)
        session_path = WORKSPACES_ROOT / session_id
        session_path.mkdir(parents=True, exist_ok=True)
        display_name = (request.session_name or "").strip() or session_id.replace("_", " ").title()
        meta = {
            "id": session_id,
            "name": display_name,
            "prompt": request.user_prompt,
            "status": "running",
            "started_at": datetime.now().isoformat(),
            "finished_at": None,
            "history": [],
        }
        _write_meta(session_path, meta)

    def thread_runner():
        # Wire the log file to this session
        ws_redirector.set_active_session(session_path)
        _broadcast(f"__SESSION_STARTED__:{session_id}")
        print(f"\n[SERVER] Session '{session_id}' started: {request.user_prompt}")
        try:
            execute_agenthub_run(
                request.user_prompt,
                str(session_path),
                request.agents or [],
                request.llm_keys or {},
                request.llm_provider or "gemini"
            )
            meta["status"] = "done"
            meta["finished_at"] = datetime.now().isoformat()
            _write_meta(session_path, meta)
            print(f"\n[SERVER] Session '{session_id}' complete.")
            _broadcast("__EXECUTION_COMPLETE__")
        except Exception as exc:
            meta["status"] = "error"
            meta["finished_at"] = datetime.now().isoformat()
            _write_meta(session_path, meta)
            print(f"\n[SERVER] Session '{session_id}' failed: {exc}")
            _broadcast("__EXECUTION_FAILED__")
        finally:
            ws_redirector.set_active_session(None)

    threading.Thread(target=thread_runner, daemon=True).start()
    return {"status": "running", "session_id": session_id, "name": display_name}


# ─── Sessions API ──────────────────────────────────────────────────────────

@app.get("/api/sessions")
async def list_sessions():
    sessions = []
    for path in sorted(WORKSPACES_ROOT.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
        if path.is_dir():
            meta = _read_meta(path)
            if meta:
                file_count = sum(1 for f in path.rglob("*")
                                 if f.is_file() and f.name not in ("meta.json", "terminal.log"))
                sessions.append({**meta, "file_count": file_count})
    return {"sessions": sessions}


@app.get("/api/sessions/{session_id}/files")
async def list_session_files(session_id: str):
    sp = _guard(session_id)
    files = []
    for p in sorted(sp.rglob("*")):
        if p.is_file() and p.name not in ("meta.json", "terminal.log"):
            rel = p.relative_to(sp)
            files.append({
                "path": str(rel).replace("\\", "/"),
                "size": p.stat().st_size,
                "modified": p.stat().st_mtime,
            })
    return {"files": files}


@app.get("/api/sessions/{session_id}/logs")
async def get_session_logs(session_id: str):
    """Return the full terminal.log content for a session (for history restore)."""
    sp = _guard(session_id)
    log_file = sp / "terminal.log"
    if not log_file.exists():
        return PlainTextResponse("")
    return PlainTextResponse(log_file.read_text(encoding="utf-8", errors="replace"))


@app.get("/api/sessions/{session_id}/read")
async def read_session_file(session_id: str, path: str):
    sp = _guard(session_id)
    target = (sp / path).resolve()
    if not str(target).startswith(str(sp)):
        raise HTTPException(status_code=403, detail="Access denied.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    return PlainTextResponse(target.read_text(encoding="utf-8", errors="replace"))


@app.get("/api/sessions/{session_id}/download")
async def download_session_file(session_id: str, path: str):
    sp = _guard(session_id)
    target = (sp / path).resolve()
    if not str(target).startswith(str(sp)):
        raise HTTPException(status_code=403, detail="Access denied.")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    return FileResponse(target, filename=target.name)


@app.get("/api/sessions/{session_id}/export")
async def export_session_zip(session_id: str):
    """Stream a .zip of the entire session workspace."""
    sp = _guard(session_id)

    def generate():
        buf = BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in sp.rglob("*"):
                if fp.is_file() and fp.name not in ("meta.json", "terminal.log"):
                    zf.write(fp, fp.relative_to(sp))
        buf.seek(0)
        yield buf.read()

    return StreamingResponse(
        generate(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{session_id}.zip"'},
    )


@app.delete("/api/sessions/{session_id}")
async def delete_session(session_id: str):
    """Permanently delete a session folder and all its files."""
    sp = _guard(session_id)
    try:
        shutil.rmtree(sp)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete session: {e}")
    return {"deleted": session_id}


class RenameRequest(BaseModel):
    name: str


@app.post("/api/sessions/{session_id}/rename")
async def rename_session(session_id: str, body: RenameRequest):
    """Update the display name of a session in its meta.json."""
    sp = _guard(session_id)
    new_name = body.name.strip()
    if not new_name:
        raise HTTPException(status_code=400, detail="Name cannot be empty.")
    meta = _read_meta(sp)
    meta["name"] = new_name
    _write_meta(sp, meta)
    return {"id": session_id, "name": new_name}

