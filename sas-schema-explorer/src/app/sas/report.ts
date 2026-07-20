/** Plain-text inventory report (the «Descargar .txt» payload). */

import { Schema } from './schema';

const ROLE_LABEL: Record<string, string> = {
  source: 'Fuente externa',
  seed: 'Semilla (DATALINES)',
  derived: 'Derivada',
  final: 'Final',
};

export function buildReport(schema: Schema): string {
  const L: string[] = [];
  const bar = '='.repeat(78);
  L.push(
    bar,
    'INVENTARIO DE TABLAS SAS',
    'Generado por el Explorador de esquemas SAS (análisis 100% local)',
    'Fecha: ' + new Date().toISOString().slice(0, 10),
    'Ficheros: ' + schema.files.join(', '),
    bar,
  );
  if (schema.summaryText) {
    L.push('', schema.summaryText.trim(), bar);
  }
  L.push('', 'GRAFO COMPLETO DE TABLAS:');
  for (const edge of schema.tableEdges) {
    L.push(`  ${edge.source} -> ${edge.target} [${edge.kind}]`);
  }
  const relevant = schema.relevantTables?.length ? new Set(schema.relevantTables) : null;
  for (const t of schema.tables) {
    if (relevant && !relevant.has(t.name)) continue;
    const fmap = new Map<string, string[]>();
    for (const a of t.newFields) {
      const list = fmap.get(a.var) ?? [];
      if (!list.includes(a.expr)) list.push(a.expr);
      fmap.set(a.var, list);
    }
    L.push('', `TABLA: ${t.name}`, `  rol: ${ROLE_LABEL[t.role]}`);
    if (t.definedIn) L.push(`  definida en: ${t.definedIn} (${t.join ?? ''})`);
    L.push(`  entradas: ${t.inputs.length ? t.inputs.join(', ') : '(externa / semilla)'}`);
    const consumers = schema.tables.filter((x) => x.inputs.includes(t.name)).map((x) => x.name);
    L.push(`  alimenta a: ${consumers.length ? consumers.join(', ') : '(terminal)'}`);
    if (t.byKeys.length) L.push(`  claves BY: ${t.byKeys.join(', ')}`);
    for (const f of t.filters) L.push(`  filtro: WHERE ${f}`);
    L.push(`  campos (${t.fields.length}):`);
    for (const f of t.fields) {
      const exprs = fmap.get(f);
      if (exprs) L.push(`    ${f.padEnd(28)} [nuevo]  = ${exprs.join('  |  ')}`);
      else L.push(`    ${f}`);
    }
  }
  L.push('', `RELACIONES ENTRE CAMPOS (${schema.fieldEdges.length}):`);
  for (const e of schema.fieldEdges) {
    L.push(
      `  ${e.source} -> ${e.target}  [${e.kind === 'conditions' ? 'condiciona' : 'asigna'}]` +
        `  paso ${e.dataStep}${e.expr ? '  expr: ' + e.expr : ''}`,
    );
  }
  return L.join('\n') + '\n';
}
