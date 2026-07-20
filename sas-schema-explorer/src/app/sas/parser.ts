/**
 * SAS source parser — extraction subset.
 *
 * Port of the extraction pipeline built on regllm's `src/sas_logic_tree.py`
 * compiler: it does not simulate execution, it recovers the *schema* of a SAS
 * program — DATA steps and PROC SQL tables, their input/output datasets, and
 * an ordered read/write event stream per step from which field lineage and
 * source-field attribution are derived.
 */

export interface Assign {
  var: string;
  expr: string;
  /** condition context (IF/SELECT guards) active at the assignment */
  conds: string[];
}

export type StepEvent =
  | { type: 'read'; vars: Set<string> }
  | { type: 'write'; var: string };

export interface ParsedStep {
  /** normalized LIB.TABLE output names (multi-output DATA steps) */
  outputs: string[];
  inputs: string[];
  join: 'SET' | 'MERGE' | 'DATALINES' | 'PROC SQL' | null;
  byKeys: string[];
  filters: string[];
  conditions: string[];
  assigns: Assign[];
  events: StepEvent[];
  datalinesFields: string[];
  nDatalines: number;
  file: string;
}

/** SAS keywords / function-ish tokens that must never be read as field names */
const NOT_VARS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'NE', 'EQ', 'GT', 'LT', 'GE', 'LE', 'THEN',
  'ELSE', 'IF', 'DO', 'END', 'TO', 'BY', 'WHILE', 'UNTIL', 'IS', 'NULL',
  'MISSING', 'BETWEEN', 'LIKE', 'CONTAINS', 'AS', 'FROM', 'WHERE', 'GROUP',
  'ORDER', 'HAVING', 'SELECT', 'DISTINCT', 'ON', 'CASE', 'WHEN', 'OTHERWISE',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'JOIN', 'CALCULATED', 'DESC',
  'ASC', 'OUTPUT', 'DELETE', 'RETURN', 'STOP', 'ELSE', 'OF',
]);

/** names that survive the identifier scan but are aggregates/aliases, not fields */
const NOT_FIELDS = new Set(['AVG', 'COUNT', 'SUM', 'MIN', 'MAX', 'SQRT', 'COALESCE', 'N', 'COL']);

export function isField(name: string): boolean {
  return name.length > 1 && !NOT_FIELDS.has(name) && !/^_.*_$/.test(name);
}

/** Extract candidate variable names from a SAS expression or condition. */
export function varsInExpr(expr: string): Set<string> {
  const out = new Set<string>();
  const clean = expr.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ' ');
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    const name = m[0].toUpperCase();
    const rest = clean.slice(m.index + m[0].length);
    if (/^\s*\(/.test(rest)) continue; // function call
    if (NOT_VARS.has(name)) continue;
    if (isField(name)) out.add(name);
  }
  return out;
}

export function normTable(raw: string): string {
  let n = raw.trim().replace(/\(.*$/s, '').trim().toUpperCase();
  if (!n) return '';
  if (!n.includes('.')) n = 'WORK.' + n;
  return n;
}

function stripComments(code: string): string {
  let out = code.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // `* comment ;` statements (star at statement start)
  out = out.replace(/(^|;)\s*\*[^;]*;/g, '$1');
  return out;
}

interface DatalinesBlock {
  marker: string;
  rows: number;
}

/** Replace DATALINES/CARDS payloads with markers so ';' splitting stays sane. */
function extractDatalines(code: string): { code: string; blocks: Map<string, DatalinesBlock> } {
  const blocks = new Map<string, DatalinesBlock>();
  let i = 0;
  const replaced = code.replace(
    /\b(datalines4?|cards4?)\s*;([\s\S]*?)(\n\s*;)/gi,
    (_all, _kw, payload: string) => {
      const marker = `__DATALINES_${i++}__`;
      const rows = payload.split('\n').filter((l) => l.trim().length > 0).length;
      blocks.set(marker, { marker, rows });
      return ` ${marker} ;`;
    },
  );
  return { code: replaced, blocks };
}

function splitStatements(code: string): string[] {
  return code
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0);
}

/** Parse an INPUT statement's variable names (drops $ markers and informats). */
function inputVars(stmt: string): string[] {
  const body = stmt.replace(/^input\b/i, '');
  const out: string[] = [];
  for (const tok of body.split(/\s+/)) {
    const t = tok.replace(/\$$/, '').trim();
    if (!t || t === '$') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) {
      const u = t.toUpperCase();
      if (!out.includes(u)) out.push(u);
    }
  }
  return out;
}

/** Dataset list after SET/MERGE, honoring `(IN=a WHERE=(..))` options. */
function datasetList(stmt: string, kw: string): string[] {
  let body = stmt.replace(new RegExp(`^${kw}\\b`, 'i'), '');
  // strip parenthesized dataset options
  let depth = 0;
  let out = '';
  for (const ch of body) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s))
    .map(normTable);
}

interface Block {
  kind: 'if' | 'else' | 'do' | 'select';
  cond?: string;
}

/** Parse one DATA step's body statements (between DATA ...; and RUN;). */
function parseDataStep(
  header: string,
  body: string[],
  blocks: Map<string, DatalinesBlock>,
  file: string,
): ParsedStep {
  const outputs = header
    .replace(/^data\b/i, '')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(s) && s.toUpperCase() !== '_NULL_')
    .map(normTable);

  const step: ParsedStep = {
    outputs,
    inputs: [],
    join: null,
    byKeys: [],
    filters: [],
    conditions: [],
    assigns: [],
    events: [],
    datalinesFields: [],
    nDatalines: 0,
    file,
  };

  const stack: Block[] = [];
  let lastCond = '';

  const condsNow = () =>
    stack.filter((b) => b.cond).map((b) => b.cond as string);

  const readEvent = (expr: string) => {
    const vars = varsInExpr(expr);
    if (vars.size) step.events.push({ type: 'read', vars });
  };

  const handleAssign = (stmt: string, extraCond?: string): boolean => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/s.exec(stmt);
    if (!m) return false;
    const conds = [...condsNow()];
    if (extraCond) conds.push(extraCond);
    step.assigns.push({ var: m[1].toUpperCase(), expr: m[2].trim(), conds });
    readEvent(m[2]);
    for (const c of conds) readEvent(c);
    step.events.push({ type: 'write', var: m[1].toUpperCase() });
    return true;
  };

  const handleStmt = (stmt: string): void => {
    const low = stmt.toLowerCase();

    if (/^set\b/i.test(stmt)) {
      step.inputs.push(...datasetList(stmt, 'set'));
      step.join = step.join === 'MERGE' ? step.join : 'SET';
      return;
    }
    if (/^merge\b/i.test(stmt)) {
      step.inputs.push(...datasetList(stmt, 'merge'));
      step.join = 'MERGE';
      return;
    }
    if (/^by\b/i.test(stmt)) {
      step.byKeys = stmt
        .replace(/^by\b/i, '')
        .replace(/\b(descending|notsorted|groupformat)\b/gi, ' ')
        .split(/\s+/)
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z_][A-Z0-9_]*$/.test(s));
      return;
    }
    if (/^where\b/i.test(stmt)) {
      const cond = stmt.replace(/^where\b/i, '').trim();
      step.filters.push(cond);
      readEvent(cond);
      return;
    }
    if (/^input\b/i.test(stmt)) {
      step.datalinesFields.push(...inputVars(stmt));
      return;
    }
    const dl = /^__DATALINES_\d+__$/.exec(stmt);
    if (dl) {
      const b = blocks.get(stmt);
      if (b) {
        step.nDatalines = b.rows;
        step.join = 'DATALINES';
      }
      return;
    }
    if (/^do\b/i.test(stmt)) {
      // iterative DO var = a TO b / DO WHILE / DO UNTIL / bare DO
      const mIter = /^do\s+([A-Za-z_]\w*)\s*=\s*(.+)$/i.exec(stmt);
      const mWhile = /^do\s+(while|until)\s*\((.+)\)\s*$/i.exec(stmt);
      if (mWhile) {
        step.conditions.push(mWhile[2]);
        readEvent(mWhile[2]);
        stack.push({ kind: 'do', cond: mWhile[2] });
      } else if (mIter) {
        readEvent(mIter[2]);
        step.events.push({ type: 'write', var: mIter[1].toUpperCase() });
        stack.push({ kind: 'do' });
      } else {
        stack.push({ kind: 'do' });
      }
      return;
    }
    if (/^select\b/i.test(stmt)) {
      const mSel = /^select\s*\((.+)\)\s*$/i.exec(stmt);
      const cond = mSel ? mSel[1].trim() : '';
      if (cond) {
        step.conditions.push(cond);
        readEvent(cond);
      }
      stack.push({ kind: 'select', cond: cond || undefined });
      return;
    }
    if (/^when\b/i.test(stmt)) {
      const mWhen = /^when\s*\((.+?)\)\s*([\s\S]*)$/i.exec(stmt);
      if (mWhen && mWhen[2].trim()) process(mWhen[2].trim());
      return;
    }
    if (/^otherwise\b/i.test(stmt)) {
      const rest = stmt.replace(/^otherwise\b/i, '').trim();
      if (rest) process(rest);
      return;
    }
    if (/^end\b/i.test(low)) {
      stack.pop();
      return;
    }
    if (/^(length|format|informat|label|attrib|keep|drop|rename|retain|array|call|output|delete|return|stop|goto|link|put|file|infile|title\d?|options|libname|footnote\d?)\b/i.test(stmt)) {
      return;
    }
    handleAssign(stmt);
  };

  /** Run one statement under an extra guard condition (single-branch IF/ELSE). */
  const dispatchGuarded = (stmt: string, cond: string | undefined) => {
    if (cond) stack.push({ kind: 'if', cond });
    process(stmt);
    if (cond) stack.pop();
  };

  function process(stmt: string): void {
    if (/^if\b/i.test(stmt)) {
      const mThen = /^if\s+([\s\S]+?)\s+then\s*([\s\S]*)$/i.exec(stmt);
      if (mThen) {
        const cond = mThen[1].trim();
        const rest = mThen[2].trim();
        step.conditions.push(cond);
        readEvent(cond);
        lastCond = cond;
        if (/^do\b\s*$/i.test(rest) || rest === '') stack.push({ kind: 'if', cond });
        else dispatchGuarded(rest, cond);
        return;
      }
      // subsetting IF (no THEN) acts as a filter
      const cond = stmt.replace(/^if\b/i, '').trim();
      step.filters.push(cond);
      readEvent(cond);
      return;
    }
    if (/^else\b/i.test(stmt)) {
      const rest = stmt.replace(/^else\b/i, '').trim();
      if (/^do\b\s*$/i.test(rest) || rest === '') {
        stack.push({ kind: 'else', cond: lastCond || undefined });
        return;
      }
      if (rest) dispatchGuarded(rest, lastCond || undefined);
      return;
    }
    handleStmt(stmt);
  }

  for (const stmt of body) process(stmt);
  step.inputs = [...new Set(step.inputs)];
  return step;
}

/** Split a top-level SELECT list on commas (paren-aware). */
function splitSelectList(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Parse `CREATE TABLE x AS SELECT … FROM …` inside a PROC SQL block. */
function parseSqlCreate(stmt: string, file: string): ParsedStep | null {
  const m = /create\s+table\s+([A-Za-z_][\w.]*)\s+as\s+select\s+([\s\S]+)$/i.exec(stmt);
  if (!m) return null;
  const out = normTable(m[1]);
  const rest = m[2];

  // top-level FROM: scan paren depth
  let depth = 0;
  let fromIdx = -1;
  const lower = rest.toLowerCase();
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && lower.startsWith('from', i) && /\s/.test(rest[i - 1] ?? ' ') && /[\s(]/.test(rest[i + 4] ?? ' ')) {
      fromIdx = i;
      break;
    }
  }
  const selectList = fromIdx >= 0 ? rest.slice(0, fromIdx) : rest;
  const fromPart = fromIdx >= 0 ? rest.slice(fromIdx) : '';

  const step: ParsedStep = {
    outputs: [out],
    inputs: [],
    join: 'PROC SQL',
    byKeys: [],
    filters: [],
    conditions: [],
    assigns: [],
    events: [],
    datalinesFields: [],
    nDatalines: 0,
    file,
  };

  for (const frag of splitSelectList(selectList)) {
    if (!frag || frag === '*' || /\.\*$/.test(frag)) continue;
    const mAs = /^([\s\S]+?)\s+as\s+([A-Za-z_]\w*)\s*$/i.exec(frag);
    let alias: string;
    let expr: string;
    if (mAs) {
      alias = mAs[2].toUpperCase();
      expr = mAs[1].trim();
    } else {
      const simple = /^(?:[A-Za-z_]\w*\.)?([A-Za-z_]\w*)$/.exec(frag);
      if (!simple) continue;
      alias = simple[1].toUpperCase();
      expr = frag;
    }
    const reads = new Set([...varsInExpr(expr)].filter((v) => v !== alias));
    step.assigns.push({ var: alias, expr, conds: [] });
    if (reads.size) step.events.push({ type: 'read', vars: reads });
    step.events.push({ type: 'write', var: alias });
  }

  // table refs after FROM/JOIN anywhere in the FROM clause (covers subqueries)
  const refRe = /\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi;
  let rm: RegExpExecArray | null;
  while ((rm = refRe.exec(fromPart))) {
    step.inputs.push(normTable(rm[1]));
  }
  step.inputs = [...new Set(step.inputs)].filter((t) => t !== out);

  // WHERE / ON conditions → reads (helps source attribution)
  const condRe = /\b(?:where|on|having)\s+([\s\S]*?)(?=\b(?:group|order|left|right|inner|full|join|where|having)\b|$)/gi;
  let cm: RegExpExecArray | null;
  while ((cm = condRe.exec(fromPart))) {
    const vars = varsInExpr(cm[1]);
    if (vars.size) step.events.push({ type: 'read', vars });
  }
  return step;
}

/** Parse a whole SAS file into schema steps. */
export function parseSasFile(raw: string, file: string): ParsedStep[] {
  const { code, blocks } = extractDatalines(stripComments(raw));
  const stmts = splitStatements(code);
  const steps: ParsedStep[] = [];

  let i = 0;
  while (i < stmts.length) {
    const s = stmts[i];
    if (/^data\b/i.test(s) && !/^data\s*=/i.test(s)) {
      const body: string[] = [];
      i++;
      while (i < stmts.length && !/^run\b/i.test(stmts[i]) && !/^data\b/i.test(stmts[i]) && !/^proc\b/i.test(stmts[i])) {
        body.push(stmts[i]);
        i++;
      }
      if (i < stmts.length && /^run\b/i.test(stmts[i])) i++;
      const step = parseDataStep(s, body, blocks, file);
      if (step.outputs.length) steps.push(step);
      continue;
    }
    if (/^proc\s+sql\b/i.test(s)) {
      i++;
      while (i < stmts.length && !/^quit\b/i.test(stmts[i])) {
        const created = parseSqlCreate(stmts[i], file);
        if (created) steps.push(created);
        i++;
      }
      if (i < stmts.length) i++;
      continue;
    }
    i++;
  }
  return steps;
}
