/** Concise plain-text flow report (the «Descargar .txt» payload). */

import { Schema } from './schema';

export function buildReport(schema: Schema): string {
  const L: string[] = [];
  const tableByName = new Map(schema.tables.map((table) => [table.name, table]));
  const inputNames = schema.tables
    .filter((table) => table.role === 'source' || table.role === 'seed')
    .map((table) => table.name);
  const flows: NonNullable<Schema['flowSummaries']> = schema.flowSummaries?.length
    ? schema.flowSummaries
    : [{
        final: null,
        tables: schema.tables.map((table) => table.name),
        edges: schema.tableEdges,
      }];

  L.push('ENTRADAS DEL PROCESO');
  L.push(...(inputNames.length ? inputNames.map((name) => `  ${name}`) : ['  (ninguna)']));

  for (const flow of flows) {
    const tables = flow.tables.filter((name) => !inputNames.includes(name));
    L.push('', `FLUJO${flow.final ? ` → ${flow.final}` : ''}`);
    for (const name of tables) {
      const table = tableByName.get(name);
      const description = flow.descriptions?.[name]
        ?? (table ? `Transformación mediante ${table.join ?? 'SAS'}` : 'Tabla no encontrada');
      L.push(`  ${name} ${description}`);
    }
  }
  return L.join('\n') + '\n';
}
