"""Schema analysis using the real regllm SAS compiler.

Locates a clone of alektebel/regllm (REGLLM_PATH env var, or common sibling
locations), imports its ``src/sas_logic_tree.py`` and rebuilds the schema the
Angular frontend consumes: table inventory, table-flow edges and field-level
lineage. The JSON shape mirrors the TypeScript interfaces in
``sas-schema-explorer/src/app/sas/schema.ts`` exactly (camelCase).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Callable

_REGLLM_CANDIDATES = [
    os.environ.get("REGLLM_PATH", ""),
    "../regllm",
    "../../regllm",
    "/workspace/regllm",
]


def _find_regllm() -> Path:
    here = Path(__file__).resolve().parent
    for cand in _REGLLM_CANDIDATES:
        if not cand:
            continue
        p = Path(cand)
        if not p.is_absolute():
            p = (here / p).resolve()
        if (p / "src" / "sas_logic_tree.py").exists():
            return p
    raise RuntimeError(
        "No se encontró el compilador de regllm. Clona alektebel/regllm y "
        "define REGLLM_PATH=/ruta/al/clon (debe contener src/sas_logic_tree.py)."
    )


REGLLM = _find_regllm()
if str(REGLLM) not in sys.path:
    sys.path.insert(0, str(REGLLM))

from src.sas_logic_tree import (  # noqa: E402
    AssignNode,
    DataStepNode,
    DoLoopNode,
    FilterNode,
    IfNode,
    ProcNode,
    SASLogicTree,
    SelectNode,
    _vars_in_expr,
)


def _norm(name: str) -> str:
    n = name.strip().upper()
    if n and "." not in n:
        n = "WORK." + n
    return n


_NOT_FIELDS = {"AVG", "COUNT", "SUM", "MIN", "MAX", "SQRT", "COALESCE", "N", "COL"}


def _is_field(name: str) -> bool:
    return len(name) > 1 and name not in _NOT_FIELDS


def _clean(names) -> set[str]:
    return {n for n in names if _is_field(n)}


def _collect_events(body, assigns, conditions, events):
    """Statement-ordered read/write events + assignments + branch conditions."""
    for node in body:
        if isinstance(node, AssignNode):
            assigns.append({"var": node.var.upper(), "expr": node.expr, "conds": []})
            events.append(("read", _clean({v.upper() for v in _vars_in_expr(node.expr)})))
            events.append(("write", node.var.upper()))
        elif isinstance(node, IfNode):
            conditions.append(node.condition)
            events.append(("read", _clean({v.upper() for v in _vars_in_expr(node.condition)})))
            _collect_events(node.then_branch, assigns, conditions, events)
            _collect_events(node.else_branch, assigns, conditions, events)
        elif isinstance(node, DoLoopNode):
            for cond in (node.while_cond, node.until_cond):
                if cond:
                    conditions.append(cond)
                    events.append(("read", _clean({v.upper() for v in _vars_in_expr(cond)})))
            _collect_events(node.body, assigns, conditions, events)
        elif isinstance(node, SelectNode):
            if node.select_expr:
                conditions.append(node.select_expr)
                events.append(("read", _clean({v.upper() for v in _vars_in_expr(node.select_expr)})))
            for when in node.whens:
                _collect_events(when.body, assigns, conditions, events)
            _collect_events(node.otherwise, assigns, conditions, events)


def _collect_filters(body, out):
    for node in body:
        if isinstance(node, FilterNode):
            out.append(node.condition)
        elif isinstance(node, IfNode):
            _collect_filters(node.then_branch, out)
            _collect_filters(node.else_branch, out)
        elif isinstance(node, DoLoopNode):
            _collect_filters(node.body, out)


def analyze(
    programs: list[tuple[str, str]],
    on_progress: Callable[[int, int, str, int], None] | None = None,
) -> dict:
    """programs: list of (name, sas_code). Returns the frontend Schema dict."""
    tree = SASLogicTree()
    tables: dict[str, dict] = {}
    order: list[str] = []
    events_by_table: dict[str, list] = {}
    warnings: list[str] = []
    total_chars = sum(len(code) for _, code in programs)
    processed_chars = 0

    def report(filename: str) -> None:
        if on_progress:
            overall = round((processed_chars / total_chars) * 60) if total_chars else 0
            on_progress(processed_chars, total_chars, f"Analizando {filename}", overall)

    if on_progress:
        on_progress(0, total_chars, "Preparando programas", 0)

    def get_table(name: str) -> dict:
        key = _norm(name)
        if key not in tables:
            tables[key] = {
                "name": key,
                "role": "source",
                "libref": key.split(".")[0] if "." in key else "",
                "definedIn": None,
                "inputs": [],
                "join": None,
                "byKeys": [],
                "filters": [],
                "newFields": [],
                "fields": [],
                "nDatalines": 0,
                "datalinesFields": [],
            }
            order.append(key)
        return tables[key]

    any_step = False
    for fname, code in programs:
        try:
            nodes = tree.parse(code)
        except Exception as e:  # noqa: BLE001 — surface parse errors to the UI
            warnings.append(f"No se pudo analizar {fname}: {e}")
            processed_chars += len(code)
            report(fname)
            continue

        processed_chars += len(code)
        report(fname)

        for node in nodes:
            if isinstance(node, DataStepNode):
                any_step = True
                outs = [node.output_dataset] + list(node.output_datasets)
                srcs = list(node.merge_datasets) or (
                    [node.input_dataset] if node.input_dataset else []
                )
                assigns: list = []
                conditions: list = []
                events: list = []
                _collect_events(node.body, assigns, conditions, events)
                filters: list = []
                _collect_filters(node.body, filters)
                for src in srcs:
                    get_table(src)
                for out_name in outs:
                    if out_name.strip().upper() == "_NULL_":
                        continue
                    t = get_table(out_name)
                    t["role"] = "seed" if node.datalines_data else "derived"
                    t["definedIn"] = fname
                    t["inputs"] = sorted({_norm(s) for s in srcs})
                    t["join"] = (
                        "DATALINES" if node.datalines_data
                        else "MERGE" if node.merge_datasets
                        else "SET" if srcs else "DATALINES"
                    )
                    t["byKeys"] = [k.upper() for k in node.by_keys]
                    t["filters"] = filters
                    t["newFields"] = assigns
                    events_by_table[t["name"]] = events
                    if node.datalines_data:
                        t["nDatalines"] = len(node.datalines_data)
                        keys: list[str] = []
                        for row in node.datalines_data:
                            for k in row:
                                ku = k.upper()
                                if ku not in keys:
                                    keys.append(ku)
                        t["datalinesFields"] = keys
            elif isinstance(node, ProcNode) and node.output_table:
                any_step = True
                t = get_table(node.output_table)
                t["role"] = "derived"
                t["definedIn"] = fname
                t["inputs"] = sorted({_norm(s) for s in node.input_tables})
                t["join"] = f"PROC {node.kind.upper()}"
                events: list = []
                for src in node.input_tables:
                    get_table(src)
                for alias, expr in node.select_fields:
                    if alias == "*":
                        continue
                    t["newFields"].append({"var": alias.upper(), "expr": expr, "conds": []})
                    reads = _clean({v.upper() for v in _vars_in_expr(expr)}) - {alias.upper()}
                    if reads:
                        events.append(("read", reads))
                    events.append(("write", alias.upper()))
                events_by_table[t["name"]] = events

    if not any_step and not warnings:
        warnings.append(
            "No se encontró ningún paso DATA ni PROC SQL CREATE TABLE en los ficheros cargados."
        )

    if on_progress:
        on_progress(processed_chars, total_chars, "Construyendo tablas y esquema", 60)

    # ── Read-before-write source attribution ─────────────────────────
    produced: set[str] = set()
    external: set[str] = set()
    for name in order:
        t = tables[name]
        if t["role"] == "source":
            continue
        produced |= set(t["datalinesFields"])
        for ev in events_by_table.get(name, []):
            if ev[0] == "read":
                external |= {v for v in ev[1] if v not in produced}
            else:
                produced.add(ev[1])
        for f in t["filters"]:
            external |= _clean({v.upper() for v in _vars_in_expr(f)}) - produced
        external |= set(t["byKeys"]) - produced

    def step_reads(t: dict) -> set[str]:
        reads: set[str] = set()
        for ev in events_by_table.get(t["name"], []):
            if ev[0] == "read":
                reads |= ev[1]
        for f in t["filters"]:
            reads |= _clean({v.upper() for v in _vars_in_expr(f)})
        reads |= set(t["byKeys"])
        return _clean(reads)

    consumed: dict[str, set[str]] = {n: set() for n in tables}
    for name, t in tables.items():
        if t["role"] == "source":
            continue
        reads = step_reads(t)
        for src in t["inputs"]:
            if src in consumed:
                consumed[src] |= reads
    source_names = [n for n, t in tables.items() if t["role"] == "source"]
    if len(source_names) == 1:
        consumed[source_names[0]] |= _clean(external)
    for n in source_names:
        tables[n]["fields"] = sorted(consumed[n])

    if on_progress:
        on_progress(processed_chars, total_chars, "Resolviendo dependencias y campos", 80)

    # ── Downstream propagation ───────────────────────────────────────
    resolved: dict[str, set[str]] = {}

    def resolve(name: str, stack: frozenset = frozenset()) -> set[str]:
        if name in resolved:
            return resolved[name]
        if name in stack:
            return set()
        t = tables[name]
        if t["role"] == "source":
            return set(t["fields"])
        fields: set[str] = set(t["datalinesFields"])
        for src in t["inputs"]:
            fields |= resolve(src, stack | {name})
        for a in t["newFields"]:
            fields.add(a["var"])
        fields |= step_reads(t)
        resolved[name] = fields
        return fields

    for name, t in tables.items():
        if t["role"] != "source":
            t["fields"] = sorted(resolve(name))

    for t in tables.values():
        if t["role"] == "derived":
            used = any(t["name"] in o["inputs"] for o in tables.values())
            if not used:
                t["role"] = "final"

    table_edges = [
        {"source": src, "target": t["name"], "kind": t["join"] or "SET"}
        for t in tables.values()
        for src in t["inputs"]
    ]

    if on_progress:
        on_progress(processed_chars, total_chars, "Calculando linaje de campos", 90)

    # ── Field lineage straight from the compiler ─────────────────────
    full = tree.parse("\n".join(code for _, code in programs))
    lineage = tree.lineage(full)
    if on_progress:
        on_progress(total_chars, total_chars, "Finalizando resultado", 98)
    field_nodes = [
        {"id": n["id"], "kind": n.get("kind", "computed")}
        for n in lineage.nodes
        if _is_field(n["id"])
    ]
    field_edges = [
        {
            "source": e["source"].upper(),
            "target": e["target"].upper(),
            "kind": e.get("kind", "assigns"),
            "dataStep": e.get("data_step", ""),
            "expr": e.get("expr", ""),
        }
        for e in lineage.edges
        if _is_field(e["source"].upper()) and _is_field(e["target"].upper())
    ]

    return {
        "files": [name for name, _ in programs],
        "tables": [tables[n] for n in order],
        "tableEdges": table_edges,
        "fieldNodes": field_nodes,
        "fieldEdges": field_edges,
        "warnings": warnings,
        "engine": "regllm",
    }
