import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { StateService } from './state.service';
import { FieldEdge } from './sas/schema';
import { KINDS } from './ui';

interface FNode {
  id: string;
  x: number;
  y: number;
  w: number;
  css: string;
  isTarget: boolean;
}

interface FEdge {
  edge: FieldEdge;
  path: string;
  dashed: boolean;
}

const NH = 30;
const GY = 14;
const GX = 74;
const PAD = 16;
const CHAR_W = 7.2;

@Component({
  selector: 'app-lineage-view',
  imports: [FormsModule],
  template: `
    <div class="fieldbar">
      <label for="field-select">Campo</label>
      <select id="field-select" [ngModel]="field()" (ngModelChange)="state.selectedField.set($event)">
        @for (n of allFields(); track n.id) {
          <option [value]="n.id">{{ n.id }}</option>
        }
      </select>
      <select id="dir-select" aria-label="Dirección del linaje"
              [ngModel]="state.lineageDir()" (ngModelChange)="state.lineageDir.set($event)">
        <option value="up">⇦ ¿De dónde viene? (ancestros)</option>
        <option value="down">⇨ ¿A qué afecta? (descendientes)</option>
      </select>
      <div class="klegend">
        @for (k of kinds; track k.label) {
          <span><span class="dot" [style.background]="k.css"></span>{{ k.label }}</span>
        }
      </div>
    </div>

    @if (graph(); as g) {
      @if (g.nodes.length > 1) {
        <p class="meta">
          @if (up()) {
            Todos los campos que alimentan <code>{{ field() }}</code>, por capas de profundidad.
          } @else {
            Todos los campos afectados por <code>{{ field() }}</code>.
          }
          Línea discontinua = influencia por condición (IF/WHERE).
        </p>
        <div class="gwrap">
          <svg [attr.viewBox]="'0 0 ' + g.w + ' ' + g.h" [attr.width]="g.w" [attr.height]="g.h"
               role="img" aria-label="Grafo de linaje de campos">
            <defs>
              <marker id="arr2" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
                <path d="M0,0.5 L7.5,4 L0,7.5 z" fill="var(--line-2)"/>
              </marker>
            </defs>
            @for (e of g.edges; track $index) {
              <path class="gedge" [class.hl]="hoverEdge() === e"
                    [attr.d]="e.path" marker-end="url(#arr2)"
                    [attr.stroke-dasharray]="e.dashed ? '4 3' : null"
                    (mousemove)="onEdgeMove($event, e)" (mouseleave)="hoverEdge.set(null)"/>
            }
            @for (n of g.nodes; track n.id) {
              <g class="fnode" tabindex="0" role="button" [attr.aria-label]="n.id"
                 (click)="state.selectedField.set(n.id)"
                 (keydown.enter)="state.selectedField.set(n.id)"
                 (keydown.space)="state.selectedField.set(n.id)">
                <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="n.w" height="30"
                      [attr.stroke]="n.css" [attr.fill]="n.isTarget ? 'var(--accent-wash)' : 'var(--bg)'"/>
                <text [attr.x]="n.x + 13" [attr.y]="n.y + 19">{{ n.id }}</text>
              </g>
            }
          </svg>
        </div>
        @if (direct().length) {
          <div class="predlist">
            <h3>{{ up() ? 'Entradas directas' : 'Salidas directas' }} de {{ field() }}</h3>
            <div class="fieldwrap">
              @for (e of direct(); track $index) {
                <div class="pred">
                  <code>{{ e.source }}</code><span class="arrow">→</span><code>{{ e.target }}</code>
                  @if (e.expr) {
                    <code class="dim2">{{ e.kind === 'conditions' ? 'si ' + e.expr : '= ' + e.expr }}</code>
                  } @else {
                    <span class="viacond">vía condición</span>
                  }
                  <span class="step">{{ e.dataStep }}</span>
                </div>
              }
            </div>
          </div>
        }
      } @else {
        <div class="empty">{{ field() }} no tiene {{ up() ? 'ancestros' : 'descendientes' }} en los ficheros cargados.</div>
      }
    }

    @if (hoverEdge(); as he) {
      <div class="tooltip show" [style.left.px]="ttX()" [style.top.px]="ttY()">
        <div class="tt-head">{{ he.edge.source }} → {{ he.edge.target }} ·
          {{ he.edge.kind === 'conditions' ? 'condiciona' : 'asigna' }} · {{ he.edge.dataStep }}</div>
        @if (he.edge.expr) { {{ he.edge.expr }} }
      </div>
    }
  `,
})
export class LineageViewComponent {
  readonly state = inject(StateService);
  readonly kinds = Object.values(KINDS);
  readonly hoverEdge = signal<FEdge | null>(null);
  readonly ttX = signal(0);
  readonly ttY = signal(0);

  readonly up = computed(() => this.state.lineageDir() === 'up');
  readonly allFields = computed(() => this.state.schema()?.fieldNodes ?? []);

  readonly field = computed(() => {
    const nodes = this.allFields();
    const sel = this.state.selectedField();
    if (sel && nodes.some((n) => n.id === sel)) return sel;
    const ecl = nodes.find((n) => n.id === 'ECL');
    return ecl?.id ?? nodes[nodes.length - 1]?.id ?? '';
  });

  readonly graph = computed(() => {
    const s = this.state.schema();
    const target = this.field();
    if (!s || !target) return null;
    const up = this.up();

    const adj = new Map<string, FieldEdge[]>();
    for (const e of s.fieldEdges) {
      const key = up ? e.target : e.source;
      const list = adj.get(key) ?? [];
      list.push(e);
      adj.set(key, list);
    }
    const depth = new Map<string, number>([[target, 0]]);
    const keepEdges: FieldEdge[] = [];
    let frontier = [target];
    while (frontier.length) {
      const next: string[] = [];
      for (const n of frontier) {
        for (const e of adj.get(n) ?? []) {
          keepEdges.push(e);
          const other = up ? e.source : e.target;
          if (!depth.has(other)) {
            depth.set(other, (depth.get(n) ?? 0) + 1);
            next.push(other);
          }
        }
      }
      frontier = next;
    }

    const cols: string[][] = [];
    for (const [f, d] of depth) (cols[d] = cols[d] ?? []).push(f);
    const colW = cols.map((c) => Math.max(...c.map((f) => f.length)) * CHAR_W + 26);
    const colX: number[] = [];
    let acc = PAD;
    for (let i = 0; i < cols.length; i++) {
      colX[i] = acc;
      acc += colW[i] + GX;
    }
    const W = acc - GX + PAD;
    const H = Math.max(...cols.map((c) => c.length)) * (NH + GY) - GY + PAD * 2;

    const kindOf = new Map(s.fieldNodes.map((n) => [n.id, n.kind]));
    const pos = new Map<string, { x: number; y: number; w: number }>();
    const nodes: FNode[] = [];
    cols.forEach((col, ci) => {
      col.sort();
      const colH = col.length * (NH + GY) - GY;
      col.forEach((f, i) => {
        const x = up ? W - colX[ci] - colW[ci] : colX[ci];
        const y = PAD + (H - PAD * 2 - colH) / 2 + i * (NH + GY);
        pos.set(f, { x, y, w: colW[ci] });
        nodes.push({
          id: f,
          x,
          y,
          w: colW[ci],
          css: KINDS[kindOf.get(f) ?? 'computed'].css,
          isTarget: f === target,
        });
      });
    });

    const edges: FEdge[] = [];
    for (const e of keepEdges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const x1 = a.x + a.w;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      edges.push({
        edge: e,
        path: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        dashed: e.kind === 'conditions',
      });
    }
    return { nodes, edges, w: W, h: H };
  });

  readonly direct = computed<FieldEdge[]>(() => {
    const g = this.graph();
    const target = this.field();
    if (!g) return [];
    const up = this.up();
    const seen = new Set<string>();
    return g.edges
      .map((e) => e.edge)
      .filter((e) => (up ? e.target : e.source) === target)
      .filter((e) => {
        const k = `${e.source}|${e.target}|${e.kind}|${e.expr}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
  });

  onEdgeMove(ev: MouseEvent, e: FEdge): void {
    this.hoverEdge.set(e);
    this.ttX.set(Math.min(ev.clientX + 14, window.innerWidth - 360));
    this.ttY.set(ev.clientY + 14);
  }
}
