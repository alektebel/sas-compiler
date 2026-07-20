import { Injectable, computed, signal } from '@angular/core';
import { buildSchema, Schema, SourceFile, TableInfo } from './sas/schema';
import { readEgp } from './sas/egp';

export type View = 'tabla' | 'flujo' | 'campos';
export type Engine = 'regllm' | 'local';

export interface LoadedFile {
  name: string;
  blob: Blob;
  origin: 'sas' | 'egp' | 'pasted';
}

/** Same-origin when served by the FastAPI backend; proxied under ng serve. */
const API_ANALYZE = 'api/analyze';

@Injectable({ providedIn: 'root' })
export class StateService {
  readonly files = signal<LoadedFile[]>([]);
  readonly schema = signal<Schema | null>(null);
  readonly engine = signal<Engine | null>(null);
  readonly analyzing = signal(false);
  readonly view = signal<View>('tabla');
  readonly selectedTable = signal<string | null>(null);
  readonly selectedField = signal<string | null>(null);
  readonly lineageDir = signal<'up' | 'down'>('up');
  readonly search = signal('');
  readonly loadError = signal<string | null>(null);

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
    const added: LoadedFile[] = [];
    for (const file of Array.from(list)) {
      added.push({
        name: file.name,
        blob: file,
        origin: /\.egp$/i.test(file.name) ? 'egp' : 'sas',
      });
    }
    if (added.length) {
      this.files.update((cur) => {
        const names = new Set(cur.map((f) => f.name));
        return [...cur, ...added.filter((f) => !names.has(f.name))];
      });
      await this.analyze();
    }
  }

  async addPasted(code: string): Promise<void> {
    if (!code.trim()) return;
    const n = this.files().filter((f) => f.origin === 'pasted').length + 1;
    this.files.update((cur) => [
      ...cur,
      { name: `pegado_${n}.sas`, blob: new Blob([code], { type: 'text/plain' }), origin: 'pasted' },
    ]);
    await this.analyze();
  }

  async removeFile(name: string): Promise<void> {
    this.files.update((cur) => cur.filter((f) => f.name !== name));
    await this.analyze();
  }

  clear(): void {
    this.files.set([]);
    this.schema.set(null);
    this.engine.set(null);
    this.selectedTable.set(null);
    this.selectedField.set(null);
    this.loadError.set(null);
  }

  /** Backend first (real regllm compiler); local TS parser as fallback. */
  async analyze(): Promise<void> {
    this.loadError.set(null);
    this.selectedTable.set(null);
    this.selectedField.set(null);
    const files = this.files();
    if (!files.length) {
      this.schema.set(null);
      this.engine.set(null);
      return;
    }
    this.analyzing.set(true);
    try {
      const schema = await this.analyzeRemote(files);
      this.schema.set(schema);
      this.engine.set('regllm');
    } catch {
      try {
        const schema = await this.analyzeLocal(files);
        schema.warnings = [
          'Backend no disponible — análisis local aproximado (sin expansión de macros). ' +
            'Arranca el backend (uvicorn backend.main:app) para usar el compilador regllm.',
          ...schema.warnings,
        ];
        this.schema.set(schema);
        this.engine.set('local');
      } catch (e) {
        this.loadError.set(`No se pudo analizar: ${String(e)}`);
        this.schema.set(null);
        this.engine.set(null);
      }
    } finally {
      this.analyzing.set(false);
    }
  }

  private async analyzeRemote(files: LoadedFile[]): Promise<Schema> {
    const form = new FormData();
    for (const f of files) {
      if (f.origin === 'pasted') form.append('pasted', await f.blob.text());
      else form.append('files', f.blob, f.name);
    }
    const res = await fetch(API_ANALYZE, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as Schema;
  }

  private async analyzeLocal(files: LoadedFile[]): Promise<Schema> {
    const sources: SourceFile[] = [];
    for (const f of files) {
      if (f.origin === 'egp') {
        sources.push(...(await readEgp(new File([f.blob], f.name))));
      } else {
        sources.push({ name: f.name, content: await f.blob.text(), origin: f.origin });
      }
    }
    return buildSchema(sources);
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
