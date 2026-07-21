"""Schema analysis using the real regllm SAS compiler.

Locates a clone of alektebel/regllm (REGLLM_PATH env var, or common sibling
locations), imports its ``src/sas_logic_tree.py`` and rebuilds the schema the
Angular frontend consumes: table inventory, table-flow edges and field-level
lineage. The JSON shape mirrors the TypeScript interfaces in
``sas-schema-explorer/src/app/sas/schema.ts`` exactly (camelCase).
"""

from __future__ import annotations

import os
import json
import re
import sys
import time
from functools import lru_cache
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
    MacroDefNode,
    ProcNode,
    SASLogicTree,
    _LineageWalker,
    SelectNode,
    _vars_in_expr,
)


class _ProgressLineageWalker(_LineageWalker):
    """Lineage walker that reports traversal progress without changing regllm."""

    def __init__(self, total: int, report: Callable[[int], None]) -> None:
        super().__init__()
        self._total = max(total, 1)
        self._processed = 0
        self._report = report

    def _tick(self, amount: int = 1) -> None:
        self._processed = min(self._processed + amount, self._total)
        self._report(self._processed)

    def walk(self, nodes):
        for node in nodes:
            if isinstance(node, DataStepNode):
                self._current_step = node.output_dataset
                if node.output_dataset not in self._step_order:
                    self._step_order.append(node.output_dataset)
                for _ in node.merge_datasets:
                    self._read.update()
                self._walk_body(node.body)
            elif isinstance(node, ProcNode) and node.output_table and node.select_fields:
                self._current_step = node.output_table
                if node.output_table not in self._step_order:
                    self._step_order.append(node.output_table)
                self._walk_proc_sql(node)
            elif isinstance(node, MacroDefNode):
                self.walk(node.body)
            self._tick()
        return self._build()

    def _walk_node(self, node) -> None:
        super()._walk_node(node)
        self._tick()

    def _walk_proc_sql(self, node) -> None:
        super()._walk_proc_sql(node)
        self._tick(len(node.select_fields))


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


def _ast_size(value) -> int:
    if isinstance(value, list):
        return sum(_ast_size(item) for item in value)
    if hasattr(value, "__dataclass_fields__"):
        return 1 + sum(_ast_size(getattr(value, name)) for name in value.__dataclass_fields__)
    return 0


_MACRO_LET_RE = re.compile(r"%let\s+(\w+)\s*=\s*(.*?);", re.IGNORECASE | re.DOTALL)
_MACRO_REF_RE = re.compile(r"&([A-Za-z_]\w*)\.?")
_MACRO_BLOCK_RE = re.compile(
    r"%macro\s+\w+\s*(?:\([^)]*\))?\s*;.*?%mend\b\s*;?",
    re.IGNORECASE | re.DOTALL,
)


def _resolve_macro_value(value: str, macros: dict[str, str]) -> str:
    """Resolve a %LET value against definitions already seen in the project."""
    for _ in range(8):
        updated = _MACRO_REF_RE.sub(lambda m: macros.get(m.group(1).lower(), m.group(0)), value)
        if updated == value:
            break
        value = updated
    return value.strip()


def _resolve_project_macros(programs: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Apply sequential %LET scope across programs before regllm parses them.

    SAS projects commonly redefine a reference such as ``&PREFIX`` between
    programs. Resolving each statement in source order prevents a later value
    from leaking backwards into an earlier table reference.
    """
    macros: dict[str, str] = {}
    resolved: list[tuple[str, str]] = []
    for filename, code in programs:
        protected = list(_MACRO_BLOCK_RE.finditer(code))
        chunks: list[str] = []
        cursor = 0

        def resolve_segment(segment: str) -> str:
            nonlocal macros
            pieces: list[str] = []
            segment_cursor = 0
            for match in _MACRO_LET_RE.finditer(segment):
                before = segment[segment_cursor:match.start()]
                pieces.append(_MACRO_REF_RE.sub(
                    lambda m: macros.get(m.group(1).lower(), m.group(0)), before,
                ))
                value = _resolve_macro_value(match.group(2), macros)
                macros[match.group(1).lower()] = value
                pieces.append(f"%let {match.group(1)} = {value};")
                segment_cursor = match.end()
            pieces.append(_MACRO_REF_RE.sub(
                lambda m: macros.get(m.group(1).lower(), m.group(0)), segment[segment_cursor:],
            ))
            return "".join(pieces)

        for block in protected:
            chunks.append(resolve_segment(code[cursor:block.start()]))
            chunks.append(block.group(0))
            cursor = block.end()
        chunks.append(resolve_segment(code[cursor:]))
        resolved.append((filename, "".join(chunks)))
    return resolved


def _are_valid_gguf_descriptions(value, expected: set[str]) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == expected
        and all(isinstance(value[name], str) and value[name].strip() for name in expected)
    )


def _build_summary(
    tables: dict[str, dict], order: list[str], edges: list[dict], final_tables: list[str],
) -> tuple[list[str], list[str], list[dict], str]:
    relevant = set(final_tables)
    inputs_by_target: dict[str, set[str]] = {}
    for edge in edges:
        inputs_by_target.setdefault(edge["target"], set()).add(edge["source"])
    pending = list(final_tables)
    while pending:
        current = pending.pop()
        for source in inputs_by_target.get(current, set()):
            if source not in relevant:
                relevant.add(source)
                pending.append(source)

    flow_edges = [
        edge for edge in edges
        if edge["source"] in relevant and edge["target"] in relevant
    ]
    flow_summaries: list[dict] = []
    lines = [
        "RESUMEN DEL FLUJO FINAL",
        f"Tablas finales inferidas: {', '.join(final_tables) if final_tables else '(ninguna)'}",
        f"Tablas relevantes: {len(relevant)} de {len(tables)}",
        "\nGRAFO MINIMO DE DEPENDENCIAS:",
    ]
    if flow_edges:
        for edge in flow_edges:
            lines.append(f"  {edge['source']} -> {edge['target']} [{edge['kind']}]")
    else:
        lines.append("  (sin relaciones entre tablas)")

    lines.append("\nTABLAS UTILIZADAS:")
    for name in order:
        if name in relevant:
            table = tables[name]
            lines.append(
                f"  {name} [{table['role']}]"
                f" ({table['join'] or 'fuente externa'})"
            )

    lines.append("\nCAMINOS HACIA LAS TABLAS FINALES:")
    for final in final_tables:
        lines.append(f"  salida: {final}")
        path_seen: set[str] = set()
        path_pending = [final]
        while path_pending:
            target = path_pending.pop()
            if target in path_seen:
                continue
            path_seen.add(target)
            sources = sorted(inputs_by_target.get(target, set()))
            if sources:
                lines.append(f"    {', '.join(sources)} -> {target}")
                path_pending.extend(sources)

    final_name = final_tables[0] if len(final_tables) == 1 else None
    final_table = tables.get(final_name) if final_name else None
    fallback_explanation = (
        f"{final_name} se crea a partir de "
        f"{', '.join(final_table['inputs']) if final_table and final_table['inputs'] else 'fuentes externas'} "
        f"mediante {final_table['join'] if final_table else 'el flujo analizado'}; "
        f"incluye {len(final_table['newFields']) if final_table else 0} campos nuevos."
    )
    flow_summaries.append({
        "final": final_name,
        "tables": [name for name in order if name in relevant],
        "edges": flow_edges,
        "explanation": fallback_explanation,
    })
    return (
        final_tables,
        [name for name in order if name in relevant],
        flow_summaries,
        "\n".join(lines) + "\n",
    )


def _clean_flow_with_gguf(
    flow: dict, tables: dict[str, dict], warnings: list[str],
) -> dict:
    """Use GGUF only to describe and order the deterministic table set."""
    descriptions = {
        name: (
            f"{name} se alimenta de {', '.join(tables[name]['inputs']) or 'una fuente externa'} "
            f"y se genera mediante {tables[name]['join'] or 'un paso SAS'}."
        )
        for name in flow["tables"]
    }
    flow = {**flow, "descriptions": descriptions}
    model = _load_gguf_model(os.environ.get("GGUF_MODEL_PATH", "").strip())
    if model is None:
        return flow
    context = {
        "final_table": flow["final"],
        "tables": [
            {
                "name": name,
                "role": tables[name]["role"],
                "join": tables[name]["join"],
                "inputs": tables[name]["inputs"],
            }
            for name in flow["tables"]
        ],
        "edges": flow["edges"],
    }
    prompt = (
        "Resume este flujo de datos. Devuelve exactamente JSON con un array "
        "'tables' que contenga cada tabla suministrada una sola vez y un objeto "
        "'descriptions' con una frase corta en español para cada tabla. Incluye "
        "también una frase corta 'explanation' que explique por qué se crea la "
        "tabla final y qué incluye de forma diferente. No inventes tablas ni "
        "datos; usa solo la información suministrada.\n\n"
        + json.dumps(context, ensure_ascii=True)
    )
    try:
        response = model.create_chat_completion(
            messages=[
                {"role": "system", "content": "You compress one deterministic table flow."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            top_p=1,
            seed=42,
            max_tokens=320,
            response_format={"type": "json_object"},
        )
        data = json.loads(response["choices"][0]["message"]["content"])
        ordered = data.get("tables")
        explanation = data.get("explanation")
        generated = data.get("descriptions")
        expected = set(flow["tables"])
        if (
            isinstance(ordered, list)
            and set(ordered) == expected
            and len(ordered) == len(expected)
            and isinstance(explanation, str)
            and explanation.strip()
            and _are_valid_gguf_descriptions(generated, expected)
        ):
            return {
                **flow,
                "tables": ordered,
                "descriptions": {name: generated[name].strip() for name in expected},
                "explanation": explanation.strip(),
            }
        warnings.append("El resumen GGUF no conservó el grafo mínimo; se usa el resumen determinista.")
    except Exception as exc:  # noqa: BLE001 — optional summarization must not block analysis
        warnings.append(f"Falló el resumen GGUF ({exc}); se usa el resumen determinista.")
    return flow


@lru_cache(maxsize=4)
def _load_gguf_model(path: str):
    if not path:
        return None
    try:
        from llama_cpp import Llama

        return Llama(
            model_path=path,
            n_ctx=int(os.environ.get("GGUF_N_CTX", "4096")),
            n_threads=int(os.environ.get("GGUF_THREADS", "4")),
            verbose=False,
        )
    except Exception:
        return None


def _resolve_final_tables(
    tables: dict[str, dict], order: list[str], edges: list[dict], warnings: list[str],
) -> list[str]:
    candidates = [name for name in order if tables[name]["role"] == "final"]
    if len(candidates) <= 1:
        return candidates

    # Deterministic fallback: preserve source order and select the last terminal
    # derived table when no scoped resolver can make a validated decision.
    fallback = candidates[-1]
    model = _load_gguf_model(os.environ.get("GGUF_MODEL_PATH", "").strip())
    if model is None:
        if os.environ.get("GGUF_MODEL_PATH"):
            warnings.append("No se pudo cargar el modelo GGUF; se usa la tabla final determinista.")
        return [fallback]

    inputs_by_target: dict[str, list[str]] = {}
    for edge in edges:
        inputs_by_target.setdefault(edge["target"], []).append(edge["source"])
    context = {
        "candidates": candidates,
        "evidence": [
            {
                "table": name,
                "definedIn": tables[name]["definedIn"],
                "join": tables[name]["join"],
                "inputs": inputs_by_target.get(name, []),
                "fields": tables[name]["fields"][:30],
            }
            for name in candidates
        ],
    }
    prompt = (
        "Choose the single most likely final output table from the candidates. "
        "Use only the supplied evidence. Return JSON exactly as "
        '{"decision":"CANDIDATE","confidence":0.0,"reason":"short reason"}.\n\n'
        + json.dumps(context, ensure_ascii=True)
    )
    try:
        response = model.create_chat_completion(
            messages=[
                {"role": "system", "content": "You resolve one narrow data-lineage ambiguity."},
                {"role": "user", "content": prompt},
            ],
            temperature=0,
            top_p=1,
            seed=42,
            max_tokens=160,
            response_format={"type": "json_object"},
        )
        content = response["choices"][0]["message"]["content"]
        decision = json.loads(content)
        selected = decision.get("decision")
        confidence = float(decision.get("confidence", 0))
        if selected in candidates and confidence >= 0.75:
            warnings.append(f"Resolutor GGUF seleccionó {selected} entre {len(candidates)} tablas finales.")
            return [selected]
        warnings.append("El resolutor GGUF no dio una decisión válida; se usa la tabla final determinista.")
    except Exception as exc:  # noqa: BLE001 — ambiguity resolution must never block analysis
        warnings.append(f"Falló el resolutor GGUF ({exc}); se usa la tabla final determinista.")
    return [fallback]


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
    programs = _resolve_project_macros(programs)
    tree = SASLogicTree()
    tables: dict[str, dict] = {}
    order: list[str] = []
    events_by_table: dict[str, list] = {}
    warnings: list[str] = []
    parsed_nodes: list = []
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

        parsed_nodes.extend(nodes)
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
    final_tables = _resolve_final_tables(tables, order, table_edges, warnings)
    final_tables, relevant_tables, flow_summaries, summary_text = _build_summary(
        tables, order, table_edges, final_tables,
    )
    flow_summaries = [
        _clean_flow_with_gguf(flow, tables, warnings) for flow in flow_summaries
    ]
    if flow_summaries and flow_summaries[0].get("explanation"):
        summary_text += "\nEXPLICACIÓN DEL FLUJO:\n  " + flow_summaries[0]["explanation"] + "\n"
    if flow_summaries and flow_summaries[0].get("descriptions"):
        summary_text += "\nDESCRIPCIONES DE TABLAS:\n"
        for name in flow_summaries[0]["tables"]:
            summary_text += f"  {name}: {flow_summaries[0]['descriptions'][name]}\n"

    if on_progress:
        on_progress(processed_chars, total_chars, "Calculando linaje de campos", 90)

    # ── Field lineage straight from the compiler ─────────────────────
    lineage_total = _ast_size(parsed_nodes)
    lineage_started = time.monotonic()
    last_report = lineage_started
    report_every = max(1000, lineage_total // 100)

    def report_lineage(processed: int) -> None:
        nonlocal last_report
        now = time.monotonic()
        if processed < lineage_total and processed % report_every != 0:
            return
        elapsed = now - lineage_started
        rate = processed / elapsed if elapsed > 0 else 0
        remaining = max(lineage_total - processed, 0) / rate if rate else 0
        eta = f", quedan aprox. {remaining:.0f}s" if remaining else ""
        overall = 90 + round(8 * processed / max(lineage_total, 1))
        if on_progress:
            on_progress(
                processed_chars,
                total_chars,
                f"Linaje de campos: {processed:,}/{lineage_total:,} elementos{eta}",
                min(overall, 98),
            )
        last_report = now

    lineage = _ProgressLineageWalker(lineage_total, report_lineage).walk(parsed_nodes)
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
    if on_progress:
        on_progress(total_chars, total_chars, "Finalizando resultado", 100)

    return {
        "files": [name for name, _ in programs],
        "tables": [tables[n] for n in order],
        "tableEdges": table_edges,
        "fieldNodes": field_nodes,
        "fieldEdges": field_edges,
        "warnings": warnings,
        "engine": "regllm",
        "finalTables": final_tables,
        "relevantTables": relevant_tables,
        "flowSummaries": flow_summaries,
        "summaryText": summary_text,
    }
