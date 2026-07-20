import { Injectable, computed, signal } from '@angular/core';
import { buildSchema, Schema, SourceFile, TableInfo } from './sas/schema';
import { readEgp } from './sas/egp';

export type View = 'tabla' | 'flujo' | 'campos';
export type Engine = 'regllm' | 'local';
export type AnalysisPhase = 'idle' | 'preparing' | 'compiling' | 'local' | 'complete';
export type AnalysisResult = 'idle' | 'running' | 'compiled' | 'local' | 'failed';

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
  readonly analysisPhase = signal<AnalysisPhase>('idle');
  readonly analysisProgress = signal(0);
  readonly analysisProcessed = signal(0);
  readonly analysisTotal = signal(0);
  readonly analysisStage = signal('Preparando programas');
  readonly analysisResult = signal<AnalysisResult>('idle');
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
    this.analysisPhase.set('idle');
    this.analysisProgress.set(0);
    this.analysisProcessed.set(0);
    this.analysisTotal.set(0);
    this.analysisStage.set('Preparando programas');
    this.analysisResult.set('idle');
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
      this.analysisResult.set('idle');
      return;
    }
    this.analyzing.set(true);
    this.analysisResult.set('running');
    this.analysisPhase.set('preparing');
    this.analysisProgress.set(0);
    this.analysisProcessed.set(0);
    this.analysisTotal.set(0);
    this.analysisStage.set('Preparando programas');
    try {
      this.analysisPhase.set('compiling');
      const schema = await this.analyzeRemote(files);
      this.schema.set(schema);
      this.engine.set('regllm');
      this.analysisResult.set(schema.compiled === false ? 'failed' : 'compiled');
    } catch {
      try {
        this.analysisPhase.set('local');
        this.analysisStage.set('Analizando localmente');
        const schema = await this.analyzeLocal(files);
        schema.warnings = [
          'Backend no disponible — análisis local aproximado (sin expansión de macros). ' +
            'Arranca el backend (uvicorn backend.main:app) para usar el compilador regllm.',
          ...schema.warnings,
        ];
        this.schema.set(schema);
        this.engine.set('local');
        this.analysisResult.set('local');
      } catch (e) {
        this.loadError.set(`No se pudo analizar: ${String(e)}`);
        this.schema.set(null);
        this.engine.set(null);
        this.analysisResult.set('failed');
      }
    } finally {
      this.analysisProgress.set(100);
      this.analysisPhase.set('complete');
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
    if (!res.body) throw new Error('La respuesta no contiene progreso de compilación');

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      buffer += chunk.value ?? '';
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as {
          type: string;
          processed?: number;
          total?: number;
          stage?: string;
          result?: Schema;
          message?: string;
        };
        if (event.type === 'progress') {
          const processed = event.processed ?? 0;
          const total = event.total ?? 0;
          this.analysisProcessed.set(processed);
          this.analysisTotal.set(total);
          this.analysisProgress.set(total ? Math.round((processed / total) * 100) : 100);
          this.analysisStage.set(event.stage ?? 'Compilando programa');
        } else if (event.type === 'result' && event.result) {
          return event.result;
        } else if (event.type === 'error') {
          throw new Error(event.message ?? 'Error de compilación');
        }
      }
      if (chunk.done) break;
    }
    throw new Error('La compilación no devolvió un resultado');
  }

  private async analyzeLocal(files: LoadedFile[]): Promise<Schema> {
    const sources: SourceFile[] = [];
    let total = 0;
    for (const f of files) {
      if (f.origin === 'egp') {
        const extracted = await readEgp(new File([f.blob], f.name));
        sources.push(...extracted);
        total += extracted.reduce((sum, source) => sum + source.content.length, 0);
      } else {
        const content = await f.blob.text();
        sources.push({ name: f.name, content, origin: f.origin });
        total += content.length;
      }
      const processed = sources.reduce((sum, source) => sum + source.content.length, 0);
      this.analysisTotal.set(total);
      this.analysisProcessed.set(processed);
      this.analysisProgress.set(total ? Math.round((processed / total) * 100) : 100);
      this.analysisStage.set(`Preparando ${f.name}`);
    }
    this.analysisStage.set('Generando tablas y linaje');
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
