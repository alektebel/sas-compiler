/**
 * Schema builder — turns parsed steps into the table inventory and the
 * field-lineage graph. Direct port of extract_schema.py's logic:
 * roles, read-before-write source-field attribution, downstream field
 * propagation, and assigns/conditions lineage edges.
 */

import { Assign, ParsedStep, isField, parseSasFile, varsInExpr } from './parser';

export type Role = 'source' | 'seed' | 'derived' | 'final';
export type FieldKind = 'input' | 'modified' | 'computed';

export interface TableInfo {
  name: string;
  role: Role;
  libref: string;
  definedIn: string | null;
  inputs: string[];
  join: string | null;
  byKeys: string[];
  filters: string[];
  newFields: Assign[];
  fields: string[];
  nDatalines: number;
  datalinesFields: string[];
}

export interface TableEdge {
  source: string;
  target: string;
  kind: string;
}

export interface FieldNode {
  id: string;
  kind: FieldKind;
}

export interface FieldEdge {
  source: string;
  target: string;
  kind: 'assigns' | 'conditions';
  dataStep: string;
  expr: string;
}

export interface SourceFile {
  name: string;
  content: string;
  origin: 'sas' | 'egp' | 'pasted';
}

export interface Schema {
  files: string[];
  tables: TableInfo[];
  tableEdges: TableEdge[];
  fieldNodes: FieldNode[];
  fieldEdges: FieldEdge[];
  warnings: string[];
  /** which analyzer produced this: 'regllm' (backend) or 'local' (TS port) */
  engine?: string;
  /** True only when the backend completed without compiler warnings. */
  compiled?: boolean;
}

export function buildSchema(files: SourceFile[]): Schema {
  const tables = new Map<string, TableInfo>();
  const order: string[] = [];
  const stepsByTable = new Map<string, ParsedStep>();
  const warnings: string[] = [];

  const getTable = (name: string): TableInfo => {
    let t = tables.get(name);
    if (!t) {
      t = {
        name,
        role: 'source',
        libref: name.includes('.') ? name.split('.')[0] : '',
        definedIn: null,
        inputs: [],
        join: null,
        byKeys: [],
        filters: [],
        newFields: [],
        fields: [],
        nDatalines: 0,
        datalinesFields: [],
      };
      tables.set(name, t);
      order.push(name);
    }
    return t;
  };

  const allSteps: ParsedStep[] = [];
  for (const f of files) {
    try {
      allSteps.push(...parseSasFile(f.content, f.name));
    } catch (e) {
      warnings.push(`No se pudo analizar ${f.name}: ${String(e)}`);
    }
  }
  if (!allSteps.length) {
    warnings.push('No se encontró ningún paso DATA ni PROC SQL CREATE TABLE en los ficheros cargados.');
  }

  for (const step of allSteps) {
    for (const src of step.inputs) getTable(src);
    for (const out of step.outputs) {
      const t = getTable(out);
      t.role = step.nDatalines > 0 || step.datalinesFields.length ? 'seed' : 'derived';
      t.definedIn = step.file;
      t.inputs = [...step.inputs].sort();
      t.join = step.join ?? (step.inputs.length ? 'SET' : 'DATALINES');
      t.byKeys = step.byKeys;
      t.filters = step.filters;
      t.newFields = step.assigns;
      t.nDatalines = step.nDatalines;
      t.datalinesFields = step.datalinesFields;
      stepsByTable.set(out, step);
    }
  }

  // ── Read-before-write walk: fields read before any step produced them
  //    must come from external source tables. ─────────────────────────
  const produced = new Set<string>();
  const external = new Set<string>();
  for (const name of order) {
    const t = tables.get(name)!;
    if (t.role === 'source') continue;
    for (const f of t.datalinesFields) produced.add(f);
    const step = stepsByTable.get(name);
    if (!step) continue;
    for (const ev of step.events) {
      if (ev.type === 'read') {
        for (const v of ev.vars) if (!produced.has(v)) external.add(v);
      } else {
        produced.add(ev.var);
      }
    }
    for (const k of t.byKeys) if (!produced.has(k)) external.add(k);
  }

  const stepReads = (t: TableInfo): Set<string> => {
    const reads = new Set<string>();
    const step = t.definedIn ? stepsByTable.get(t.name) : undefined;
    if (step) {
      for (const ev of step.events) {
        if (ev.type === 'read') for (const v of ev.vars) reads.add(v);
      }
    }
    for (const k of t.byKeys) reads.add(k);
    return new Set([...reads].filter(isField));
  };

  // Direct per-consumer reads → source table fields.
  const consumed = new Map<string, Set<string>>();
  for (const name of order) consumed.set(name, new Set());
  for (const t of tables.values()) {
    if (t.role === 'source') continue;
    const reads = stepReads(t);
    for (const src of t.inputs) {
      const c = consumed.get(src);
      if (c) for (const v of reads) c.add(v);
    }
  }
  const sourceNames = order.filter((n) => tables.get(n)!.role === 'source');
  if (sourceNames.length === 1) {
    const c = consumed.get(sourceNames[0])!;
    for (const v of external) if (isField(v)) c.add(v);
  }
  for (const n of sourceNames) {
    tables.get(n)!.fields = [...consumed.get(n)!].sort();
  }

  // ── Downstream propagation: fields(t) = seed ∪ inherited ∪ assigned ∪ read.
  const resolved = new Map<string, Set<string>>();
  const resolve = (name: string, stack: Set<string>): Set<string> => {
    const memo = resolved.get(name);
    if (memo) return memo;
    if (stack.has(name)) return new Set();
    const t = tables.get(name)!;
    if (t.role === 'source') return new Set(t.fields);
    const fields = new Set<string>(t.datalinesFields);
    stack.add(name);
    for (const src of t.inputs) for (const f of resolve(src, stack)) fields.add(f);
    stack.delete(name);
    for (const a of t.newFields) fields.add(a.var);
    for (const f of stepReads(t)) fields.add(f);
    resolved.set(name, fields);
    return fields;
  };
  for (const name of order) {
    const t = tables.get(name)!;
    if (t.role !== 'source') t.fields = [...resolve(name, new Set())].sort();
  }

  // final = derived table never used as input
  for (const t of tables.values()) {
    if (t.role === 'derived') {
      const used = [...tables.values()].some((o) => o.inputs.includes(t.name));
      if (!used) t.role = 'final';
    }
  }

  // ── Table edges ───────────────────────────────────────────────────
  const tableEdges: TableEdge[] = [];
  for (const t of tables.values()) {
    for (const src of t.inputs) {
      tableEdges.push({ source: src, target: t.name, kind: t.join ?? 'SET' });
    }
  }

  // ── Field lineage edges ───────────────────────────────────────────
  const fieldEdges: FieldEdge[] = [];
  const seenEdge = new Set<string>();
  const pushEdge = (e: FieldEdge) => {
    if (e.source === e.target) return;
    const key = `${e.source}→${e.target}|${e.kind}|${e.dataStep}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    fieldEdges.push(e);
  };
  const written = new Set<string>();
  const read = new Set<string>();
  for (const step of allSteps) {
    const stepName = step.outputs[0]?.toLowerCase() ?? '';
    for (const a of step.assigns) {
      const target = a.var;
      written.add(target);
      for (const src of varsInExpr(a.expr)) {
        if (!isField(src) || src === target) continue;
        read.add(src);
        pushEdge({ source: src, target, kind: 'assigns', dataStep: stepName, expr: a.expr });
      }
      for (const cond of a.conds) {
        for (const src of varsInExpr(cond)) {
          if (!isField(src) || src === target) continue;
          read.add(src);
          pushEdge({ source: src, target, kind: 'conditions', dataStep: stepName, expr: cond });
        }
      }
    }
    for (const f of step.filters) for (const v of varsInExpr(f)) if (isField(v)) read.add(v);
  }

  const fieldNodes: FieldNode[] = [];
  const inGraph = new Set<string>();
  for (const e of fieldEdges) {
    inGraph.add(e.source);
    inGraph.add(e.target);
  }
  for (const id of [...inGraph].sort()) {
    const kind: FieldKind = !written.has(id) ? 'input' : read.has(id) ? 'modified' : 'computed';
    fieldNodes.push({ id, kind });
  }

  return {
    files: files.map((f) => f.name),
    tables: order.map((n) => tables.get(n)!),
    tableEdges,
    fieldNodes,
    fieldEdges,
    warnings,
  };
}
