"""FastAPI backend for the SAS schema explorer.

- ``POST /api/analyze`` — multipart upload of .sas/.egp files (field ``files``)
  and/or pasted code (field ``pasted``); analyzes them with the real regllm
  compiler and returns the frontend Schema JSON.
- Serves the built Angular app (``sas-schema-explorer/dist``) at ``/`` when
  present, so one process runs the whole tool.

Run:  REGLLM_PATH=/ruta/a/regllm uvicorn backend.main:app --port 8000
"""

from __future__ import annotations

import json
from queue import Queue
from threading import Thread
from pathlib import Path

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from .analyzer import REGLLM, analyze
from .egp import extract_egp

app = FastAPI(title="SAS schema explorer backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:4200", "http://127.0.0.1:4200"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _decode(data: bytes) -> str:
    if data[:2] == b"\xff\xfe":
        return data.decode("utf-16-le", errors="replace")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("windows-1252", errors="replace")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "engine": "regllm", "regllm_path": str(REGLLM)}


@app.post("/api/analyze")
async def analyze_endpoint(
    files: list[UploadFile] = File(default=[]),
    pasted: list[str] = Form(default=[]),
) -> JSONResponse:
    programs: list[tuple[str, str]] = []
    warnings: list[str] = []

    for up in files:
        name = up.filename or "sin_nombre"
        data = await up.read()
        if name.lower().endswith(".egp"):
            try:
                extracted = extract_egp(name, data)
                if not extracted:
                    warnings.append(f"{name}: el proyecto EGP no contiene programas SAS.")
                programs.extend(extracted)
            except Exception as e:  # noqa: BLE001
                warnings.append(f"No se pudo leer {name}: {e}")
        else:
            programs.append((name, _decode(data)))

    for i, code in enumerate(pasted, 1):
        if code.strip():
            programs.append((f"pegado_{i}.sas", code))

    def events():
        queue: Queue[dict | None] = Queue()

        def progress(processed: int, total: int, stage: str, overall: int) -> None:
            queue.put({
                "type": "progress",
                "processed": processed,
                "total": total,
                "stage": stage,
                "overall": overall,
            })

        def compile_programs() -> None:
            try:
                result = analyze(programs, on_progress=progress)
                result["warnings"] = warnings + result.get("warnings", [])
                result["compiled"] = not result["warnings"]
                queue.put({"type": "result", "result": result})
            except Exception as e:  # noqa: BLE001 — return compiler errors to the UI
                queue.put({"type": "error", "message": str(e)})
            finally:
                queue.put(None)

        Thread(target=compile_programs, daemon=True).start()
        while True:
            event = queue.get()
            if event is None:
                break
            yield json.dumps(event) + "\n"

    return StreamingResponse(events(), media_type="application/x-ndjson")


_DIST = Path(__file__).resolve().parent.parent / "sas-schema-explorer" / "dist" / "sas-schema-explorer" / "browser"
if _DIST.exists():
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="app")
