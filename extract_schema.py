#!/usr/bin/env python3
"""Extract table + field-lineage schema from the regllm SAS pipelines.

Uses the SAS compiler (``src/sas_logic_tree.py`` in alektebel/regllm) to parse
every SAS pipeline in the repo and emit a single ``schema.json`` consumed by
the explorer UI (``index.html``).

Usage:
    python extract_schema.py --regllm /workspace/regllm --out schema.json
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


PIPELINES = [
    {
        "id": "debug_lgd",
        "name": "Sesión debug_lgd",
        "description": "Pipeline de depuración LGD: carga de ciclos, enriquecimiento EAD y suelos regulatorios (3 ficheros).",
        "files": [
            "data/sas/sessions/debug_lgd/proj_01_carga_ciclos.sas",
            "data/sas/sessions/debug_lgd/proj_02_enriquecimiento_ead.sas",
            "data/sas/sessions/debug_lgd/proj_03_suelos_lgd.sas",
        ],
    },
    {
        "id": "sample_lgd",
        "name": "Calibración LGD (sample)",
        "description": "Calibración LGD cartera retail/hipotecario: suelos, métricas por segmento, MoC, ECL y no conformes.",
        "files": ["data/samples/sample_lgd.sas"],
    },
    {
        "id": "dqc_stress",
        "name": "Pipeline DQC ciclos_calibrados",
        "description": "Pipeline completo PD/LGD desde BASILEA en 7 capas — base de stress-test del agente DQC.",
        "files": ["DQC/eval/sas/ciclos_calibrados_pipeline.sas"],
    },
]


def _norm(name: str) -> str:
    return name.strip().upper()


# SQL aggregate names that slip through _vars_in_expr, plus 1-letter IN=/alias
# markers (IN=a, table aliases b, c, col) — never real dataset fields.
_NOT_FIELDS = {"AVG", "COUNT", "SUM", "MIN", "MAX", "SQRT", "COALESCE", "N", "COL"}


def _is_field(name: str) -> bool:
    return len(name) > 1 and name not in _NOT_FIELDS


def _clean(names) -> set[str]:
    return {n for n in names if _is_field(n)}


def _collect_events(body, assigns, conditions, events):
    """Walk a step body in statement order collecting assignments, branch
    conditions, and an ordered read/write event stream (for read-before-write
    source-field detection)."""
    from src.sas_logic_tree import (
        AssignNode, IfNode, DoLoopNode, SelectNode, _vars_in_expr,
    )

    for node in body:
        if isinstance(node, AssignNode):
            assigns.append({"var": _norm(node.var), "expr": node.expr})
            events.append({"type": "read",
                           "vars": _clean({_norm(v) for v in _vars_in_expr(node.expr)})})
            events.append({"type": "write", "var": _norm(node.var)})
        elif isinstance(node, IfNode):
            conditions.append(node.condition)
            events.append({"type": "read",
                           "vars": _clean({_norm(v) for v in _vars_in_expr(node.condition)})})
            _collect_events(node.then_branch, assigns, conditions, events)
            _collect_events(node.else_branch, assigns, conditions, events)
        elif isinstance(node, DoLoopNode):
            for cond in (node.while_cond, node.until_cond):
                if cond:
                    conditions.append(cond)
                    events.append({"type": "read",
                                   "vars": _clean({_norm(v) for v in _vars_in_expr(cond)})})
            _collect_events(node.body, assigns, conditions, events)
        elif isinstance(node, SelectNode):
            if node.select_expr:
                conditions.append(node.select_expr)
                events.append({"type": "read",
                               "vars": _clean({_norm(v) for v in _vars_in_expr(node.select_expr)})})
            for when in node.whens:
                _collect_events(when.body, assigns, conditions, events)
            _collect_events(node.otherwise, assigns, conditions, events)


def _collect_filters(body, out):
    from src.sas_logic_tree import FilterNode, IfNode, DoLoopNode

    for node in body:
        if isinstance(node, FilterNode):
            out.append({"kind": "WHERE", "condition": node.condition})
        elif isinstance(node, IfNode):
            _collect_filters(node.then_branch, out)
            _collect_filters(node.else_branch, out)
        elif isinstance(node, DoLoopNode):
            _collect_filters(node.body, out)


def extract_pipeline(regllm: Path, spec: dict) -> dict:
    from src.sas_logic_tree import (
        SASLogicTree, DataStepNode, ProcNode, _vars_in_expr,
    )

    tree = SASLogicTree()
    tables: dict[str, dict] = {}
    order: list[str] = []

    def get_table(name: str) -> dict:
        key = _norm(name)
        if key not in tables:
            tables[key] = {
                "name": key,
                "role": "source",  # upgraded to derived/final if written
                "libref": key.split(".")[0] if "." in key else "",
                "defined_in": None,
                "inputs": [],
                "join": None,
                "by_keys": [],
                "filters": [],
                "conditions": [],
                "ordered_events": [],
                "new_fields": [],
                "fields": [],
                "n_datalines": 0,
                "comment": "",
            }
            order.append(key)
        return tables[key]

    all_code = []
    for rel in spec["files"]:
        path = regllm / rel
        code = path.read_text(encoding="utf-8")
        all_code.append(code)
        nodes = tree.parse(code)

        for node in nodes:
            if isinstance(node, DataStepNode):
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
                    if _norm(out_name) == "_NULL_":
                        continue
                    t = get_table(out_name)
                    t["role"] = "derived"
                    t["defined_in"] = rel
                    t["inputs"] = sorted({_norm(s) for s in srcs})
                    t["join"] = "MERGE" if node.merge_datasets else ("SET" if srcs else "DATALINES")
                    t["by_keys"] = [_norm(k) for k in node.by_keys]
                    t["filters"] = filters
                    t["conditions"] = conditions
                    t["ordered_events"] = events
                    t["new_fields"] = assigns
                    if node.datalines_data:
                        t["n_datalines"] = len(node.datalines_data)
                        t["join"] = "DATALINES"
                        t["role"] = "seed"
                        keys = []
                        for row in node.datalines_data:
                            for k in row:
                                ku = _norm(k)
                                if ku not in keys:
                                    keys.append(ku)
                        t["datalines_fields"] = keys
            elif isinstance(node, ProcNode) and node.output_table:
                t = get_table(node.output_table)
                t["role"] = "derived"
                t["defined_in"] = rel
                t["inputs"] = sorted({_norm(s) for s in node.input_tables})
                t["join"] = f"PROC {node.kind.upper()}"
                for src in node.input_tables:
                    get_table(src)
                from src.sas_logic_tree import _vars_in_expr as _vie
                for alias, expr in node.select_fields:
                    if alias == "*":
                        continue
                    t["new_fields"].append({"var": _norm(alias), "expr": expr})
                    t["ordered_events"].append(
                        {"type": "read", "vars": _clean({_norm(v) for v in _vie(expr)})})
                    t["ordered_events"].append({"type": "write", "var": _norm(alias)})

    # Field lineage over the whole pipeline (files concatenated in order).
    full_nodes = tree.parse("\n".join(all_code))
    lineage = tree.lineage(full_nodes)

    def step_reads(t: dict) -> set[str]:
        reads: set[str] = set()
        for a in t["new_fields"]:
            reads |= _clean({_norm(v) for v in _vars_in_expr(a["expr"])})
        for c in t.get("conditions", []):
            reads |= _clean({_norm(v) for v in _vars_in_expr(c)})
        for f in t["filters"]:
            reads |= _clean({_norm(v) for v in _vars_in_expr(f["condition"])})
        reads |= set(t["by_keys"])
        reads.discard("")
        return reads

    # Read-before-write walk in step order: any field read before any step of
    # the pipeline has produced it must come from the external source tables.
    produced: set[str] = set()
    external: set[str] = set()
    for name in order:
        t = tables[name]
        if t["role"] == "source":
            continue
        produced |= set(t.get("datalines_fields", []))
        for c in t.get("ordered_events", []):
            if c["type"] == "read":
                external |= {v for v in c["vars"] if v not in produced}
            else:
                produced.add(c["var"])
        for f in t["filters"]:
            external |= _clean(
                {_norm(v) for v in _vars_in_expr(f["condition"])}
            ) - produced
        external |= set(t["by_keys"]) - produced
    external.discard("")

    # Direct per-consumer reads, for multi-source pipelines.
    consumed: dict[str, set[str]] = {n: set() for n in tables}
    for name, t in tables.items():
        if t["role"] == "source":
            continue
        for src in t["inputs"]:
            consumed[src] |= step_reads(t)
    source_names = [n for n, t in tables.items() if t["role"] == "source"]
    if len(source_names) == 1:
        consumed[source_names[0]] |= external
    for name in source_names:
        tables[name]["fields"] = sorted(consumed[name])

    # Propagate schemas downstream: fields(t) = seed/source ∪ inherited ∪ assigned ∪ read.
    resolved: dict[str, set[str]] = {}

    def resolve(name: str, stack: frozenset = frozenset()) -> set[str]:
        if name in resolved:
            return resolved[name]
        if name in stack:
            return set()
        t = tables[name]
        if t["role"] == "source":
            return set(t["fields"])
        fields: set[str] = set(t.get("datalines_fields", []))
        for src in t["inputs"]:
            fields |= resolve(src, stack | {name})
        for a in t["new_fields"]:
            fields.add(a["var"])
        fields |= step_reads(t)
        resolved[name] = fields
        return fields

    for name, t in tables.items():
        if t["role"] != "source":
            t["fields"] = sorted(resolve(name))
        # final = never used as input to another table in this pipeline
        used_as_input = any(name in o["inputs"] for o in tables.values())
        if t["role"] == "derived" and not used_as_input:
            t["role"] = "final"

    edges = []
    for name, t in tables.items():
        t.pop("ordered_events", None)  # internal, not JSON-serialisable
        for src in t["inputs"]:
            edges.append({"source": src, "target": name, "kind": t["join"] or "SET"})

    return {
        "id": spec["id"],
        "name": spec["name"],
        "description": spec["description"],
        "files": spec["files"],
        "tables": [tables[n] for n in order],
        "table_edges": edges,
        "field_nodes": lineage.nodes,
        "field_edges": lineage.edges,
        "data_steps": lineage.data_steps,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--regllm", default="/workspace/regllm", type=Path)
    ap.add_argument("--out", default="schema.json", type=Path)
    args = ap.parse_args()

    sys.path.insert(0, str(args.regllm))

    result = {
        "generated_from": "alektebel/regllm — src/sas_logic_tree.py (compilador SAS)",
        "pipelines": [extract_pipeline(args.regllm, spec) for spec in PIPELINES],
    }
    args.out.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")

    n_tables = sum(len(p["tables"]) for p in result["pipelines"])
    n_edges = sum(len(p["field_edges"]) for p in result["pipelines"])
    print(f"OK — {len(result['pipelines'])} pipelines, {n_tables} tablas, {n_edges} aristas de campos → {args.out}")


if __name__ == "__main__":
    main()
