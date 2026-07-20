import { Component, computed, inject, signal } from '@angular/core';
import { StateService } from './state.service';
import { ROLES, splitName } from './ui';

interface FlowNode {
  name: string;
  x: number;
  y: number;
  base: string;
  lib: string;
  roleCss: string;
  nFields: number;
}

interface FlowEdge {
  source: string;
  target: string;
  path: string;
  label: string;
  lx: number;
  ly: number;
}

const NW = 196;
const NH = 46;
const GX = 96;
const GY = 26;
const PAD = 18;

@Component({
  selector: 'app-flow-view',
  template: `
    <p class="meta">Flujo de datos entre tablas — pulsa un nodo para abrir su detalle. La franja de color indica el rol.</p>
    <div class="gwrap">
      <svg [attr.viewBox]="'0 0 ' + w() + ' ' + h()" [attr.width]="w()" [attr.height]="h()"
           role="img" aria-label="Grafo de dependencias entre tablas">
        <defs>
          <marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0.5 L7.5,4 L0,7.5 z" fill="var(--line-2)"/>
          </marker>
        </defs>
        @for (e of edges(); track $index) {
          <path class="gedge" [class.hl]="hover() === e.source || hover() === e.target"
                [attr.d]="e.path" marker-end="url(#arr)"/>
          <text class="gelbl" [attr.x]="e.lx" [attr.y]="e.ly" text-anchor="middle">{{ e.label }}</text>
        }
        @for (n of nodes(); track n.name) {
          <g class="gnode" [class.on]="n.name === state.currentTable()?.name" tabindex="0" role="button"
             [attr.aria-label]="n.name"
             (click)="state.selectTable(n.name)"
             (keydown.enter)="state.selectTable(n.name)"
             (keydown.space)="state.selectTable(n.name)"
             (mouseenter)="hover.set(n.name)" (mouseleave)="hover.set(null)">
            <rect [attr.x]="n.x" [attr.y]="n.y" [attr.width]="nw" [attr.height]="nh" rx="8"/>
            <rect [attr.x]="n.x" [attr.y]="n.y + 6" width="4" [attr.height]="nh - 12" rx="2"
                  [attr.fill]="n.roleCss" stroke="none"/>
            <text [attr.x]="n.x + 14" [attr.y]="n.y + 20">{{ n.base.length > 24 ? n.base.slice(0, 23) + '…' : n.base }}</text>
            <text class="sub" [attr.x]="n.x + 14" [attr.y]="n.y + 35">{{ n.lib }} · {{ n.nFields }} campos</text>
          </g>
        }
      </svg>
    </div>
  `,
})
export class FlowViewComponent {
  readonly state = inject(StateService);
  readonly hover = signal<string | null>(null);
  readonly nw = NW;
  readonly nh = NH;

  private readonly layout = computed(() => {
    const s = this.state.schema();
    if (!s || !s.tables.length) {
      return { nodes: [] as FlowNode[], edges: [] as FlowEdge[], w: 100, h: 100 };
    }
    // longest-path layering
    const memo = new Map<string, number>();
    const depth = (name: string, stack: Set<string>): number => {
      const got = memo.get(name);
      if (got !== undefined) return got;
      if (stack.has(name)) return 0;
      const t = s.tables.find((x) => x.name === name);
      if (!t || !t.inputs.length) {
        memo.set(name, 0);
        return 0;
      }
      stack.add(name);
      const d = 1 + Math.max(...t.inputs.map((i) => depth(i, stack)));
      stack.delete(name);
      memo.set(name, d);
      return d;
    };
    const layers: string[][] = [];
    for (const t of s.tables) {
      const d = depth(t.name, new Set());
      (layers[d] = layers[d] ?? []).push(t.name);
    }
    const packed = layers.filter((l) => l && l.length);

    const H = Math.max(...packed.map((l) => l.length)) * (NH + GY) - GY + PAD * 2;
    const W = packed.length * (NW + GX) - GX + PAD * 2;

    const pos = new Map<string, { x: number; y: number }>();
    packed.forEach((layer, li) => {
      const colH = layer.length * (NH + GY) - GY;
      layer.forEach((name, i) => {
        pos.set(name, {
          x: PAD + li * (NW + GX),
          y: PAD + (H - PAD * 2 - colH) / 2 + i * (NH + GY),
        });
      });
    });

    const nodes: FlowNode[] = s.tables.map((t) => {
      const p = pos.get(t.name)!;
      const { lib, base } = splitName(t.name);
      return { name: t.name, x: p.x, y: p.y, base, lib, roleCss: ROLES[t.role].css, nFields: t.fields.length };
    });

    const edges: FlowEdge[] = [];
    for (const e of s.tableEdges) {
      const a = pos.get(e.source);
      const b = pos.get(e.target);
      if (!a || !b) continue;
      const x1 = a.x + NW;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      edges.push({
        source: e.source,
        target: e.target,
        path: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
        label: e.kind,
        lx: mx,
        ly: (y1 + y2) / 2 - 5,
      });
    }
    return { nodes, edges, w: W, h: H };
  });

  readonly nodes = computed(() => this.layout().nodes);
  readonly edges = computed(() => this.layout().edges);
  readonly w = computed(() => this.layout().w);
  readonly h = computed(() => this.layout().h);
}
