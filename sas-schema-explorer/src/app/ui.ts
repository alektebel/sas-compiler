import { Assign } from './sas/parser';
import { TableInfo } from './sas/schema';

export const ROLES: Record<string, { label: string; css: string }> = {
  source: { label: 'Fuente externa', css: 'var(--role-source)' },
  seed: { label: 'Semilla (DATALINES)', css: 'var(--role-seed)' },
  derived: { label: 'Derivada', css: 'var(--role-derived)' },
  final: { label: 'Final', css: 'var(--role-final)' },
};

export const KINDS: Record<string, { label: string; css: string }> = {
  input: { label: 'Campo fuente', css: 'var(--kind-input)' },
  modified: { label: 'Modificado', css: 'var(--kind-modified)' },
  computed: { label: 'Calculado', css: 'var(--kind-computed)' },
};

/** Dedupe a table's assignments per var, keeping each distinct formula. */
export function formulasByVar(t: TableInfo): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const a of t.newFields as Assign[]) {
    const list = m.get(a.var) ?? [];
    if (!list.includes(a.expr)) list.push(a.expr);
    m.set(a.var, list);
  }
  return m;
}

export function splitName(name: string): { lib: string; base: string } {
  return name.includes('.')
    ? { lib: name.split('.')[0], base: name.split('.').slice(1).join('.') }
    : { lib: '', base: name };
}
