import { Injectable, computed, signal } from '@angular/core';
import { buildSchema, Schema, SourceFile, TableInfo } from './sas/schema';
import { readEgp } from './sas/egp';

export type View = 'tabla' | 'flujo' | 'campos';

@Injectable({ providedIn: 'root' })
export class StateService {
  readonly files = signal<SourceFile[]>([]);
  readonly view = signal<View>('tabla');
  readonly selectedTable = signal<string | null>(null);
  readonly selectedField = signal<string | null>(null);
  readonly lineageDir = signal<'up' | 'down'>('up');
  readonly search = signal('');
  readonly loadError = signal<string | null>(null);

  readonly schema = computed<Schema | null>(() => {
    const files = this.files();
    return files.length ? buildSchema(files) : null;
  });

  readonly filteredTables = computed<TableInfo[]>(() => {
    const s = this.schema();
    if (!s) return [];
    const q = this.search().trim().toUpperCase();
    if (!q) return s.tables;
    return s.tables.filter(
      (t) => t.name.includes(q) || t.fields.some((f) => f.includes(q)),
    );
  });

  readonly currentTable = computed<TableInfo | null>(() => {
    const s = this.schema();
    if (!s || !s.tables.length) return null;
    const sel = this.selectedTable();
    return s.tables.find((t) => t.name === sel) ?? s.tables[s.tables.length - 1];
  });

  async addFiles(list: FileList | File[]): Promise<void> {
    this.loadError.set(null);
    const added: SourceFile[] = [];
    for (const file of Array.from(list)) {
      try {
        if (/\.egp$/i.test(file.name)) {
          const programs = await readEgp(file);
          if (!programs.length) {
            this.loadError.set(`${file.name}: el proyecto EGP no contiene programas SAS.`);
          }
          added.push(...programs);
        } else {
          added.push({ name: file.name, content: await file.text(), origin: 'sas' });
        }
      } catch (e) {
        this.loadError.set(`No se pudo leer ${file.name}: ${String(e)}`);
      }
    }
    if (added.length) {
      this.files.update((cur) => {
        const names = new Set(cur.map((f) => f.name));
        return [...cur, ...added.filter((f) => !names.has(f.name))];
      });
      this.selectedTable.set(null);
      this.selectedField.set(null);
    }
  }

  addPasted(code: string): void {
    if (!code.trim()) return;
    const n = this.files().filter((f) => f.origin === 'pasted').length + 1;
    this.files.update((cur) => [...cur, { name: `pegado_${n}.sas`, content: code, origin: 'pasted' }]);
    this.selectedTable.set(null);
    this.selectedField.set(null);
  }

  removeFile(name: string): void {
    this.files.update((cur) => cur.filter((f) => f.name !== name));
    this.selectedTable.set(null);
    this.selectedField.set(null);
  }

  clear(): void {
    this.files.set([]);
    this.selectedTable.set(null);
    this.selectedField.set(null);
    this.loadError.set(null);
  }

  selectTable(name: string): void {
    this.selectedTable.set(name);
    this.view.set('tabla');
  }

  showFieldLineage(field: string): void {
    this.selectedField.set(field);
    this.view.set('campos');
  }
}
