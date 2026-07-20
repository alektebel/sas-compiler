import { Component, computed, inject } from '@angular/core';
import { StateService } from './state.service';
import { ROLES, formulasByVar } from './ui';

interface FieldRow {
  name: string;
  badge: string;
  badgeCss: string;
  exprs: string[];
  inGraph: boolean;
}

@Component({
  selector: 'app-table-view',
  template: `
    @if (table(); as t) {
      <div class="thead">
        <h2>{{ t.name }}</h2>
        <span class="chip" [style.background]="roleCss()">{{ roleLabel() }}</span>
      </div>
      <p class="meta">
        @if (t.definedIn) {
          Definida en <code>{{ t.definedIn }}</code> · paso <code>{{ t.join }}</code>
        } @else {
          No definida en los ficheros cargados — llega desde fuera (librería externa).
        }
        · {{ t.fields.length }} campos, {{ newCount() }} creados aquí
      </p>
      <div class="iogrid">
        <div class="iocard">
          <h3>Entradas (lee de)</h3>
          @for (n of t.inputs; track n) {
            <button type="button" class="tbtn" (click)="state.selectTable(n)">
              <span class="dot" [style.background]="roleCssOf(n)"></span>{{ n }}
            </button>
          } @empty {
            <span class="none">{{ t.role === 'seed' ? 'DATALINES embebidos (' + t.nDatalines + ' filas)' : 'externa a los ficheros cargados' }}</span>
          }
        </div>
        <div class="iocard">
          <h3>Salidas (alimenta a)</h3>
          @for (n of consumers(); track n) {
            <button type="button" class="tbtn" (click)="state.selectTable(n)">
              <span class="dot" [style.background]="roleCssOf(n)"></span>{{ n }}
            </button>
          } @empty {
            <span class="none">ninguna — tabla terminal</span>
          }
        </div>
        <div class="iocard">
          <h3>Filtros y claves</h3>
          @for (f of t.filters; track $index) {
            <span class="cond">WHERE {{ f }}</span>
          }
          @if (t.byKeys.length) {
            <span class="cond">BY {{ t.byKeys.join(', ') }}</span>
          }
          @if (!t.filters.length && !t.byKeys.length) {
            <span class="none">sin filtros ni claves BY</span>
          }
        </div>
      </div>
      <div class="fieldwrap">
        <table class="fields">
          <thead><tr><th>Campo</th><th>Origen</th><th>Fórmula / expresión</th></tr></thead>
          <tbody>
            @for (r of rows(); track r.name) {
              <tr>
                <td class="fname">
                  @if (r.inGraph) {
                    <button type="button" class="flink" [attr.title]="'Ver linaje de ' + r.name"
                      (click)="state.showFieldLineage(r.name)">{{ r.name }}</button>
                  } @else {
                    {{ r.name }}
                  }
                </td>
                <td><span class="okind" [style.background]="r.badgeCss">{{ r.badge }}</span></td>
                <td class="fexpr">
                  @for (e of r.exprs; track $index) {
                    <div>{{ e }}</div>
                  } @empty {
                    <span class="dim">—</span>
                  }
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    } @else {
      <div class="empty">Selecciona una tabla en la lista lateral</div>
    }
  `,
})
export class TableViewComponent {
  readonly state = inject(StateService);
  readonly table = this.state.currentTable;

  readonly roleLabel = computed(() => ROLES[this.table()?.role ?? 'derived'].label);
  readonly roleCss = computed(() => ROLES[this.table()?.role ?? 'derived'].css);
  readonly newCount = computed(() => formulasByVar(this.table()!).size);

  readonly consumers = computed(() => {
    const s = this.state.schema();
    const t = this.table();
    if (!s || !t) return [];
    return s.tables.filter((x) => x.inputs.includes(t.name)).map((x) => x.name);
  });

  readonly rows = computed<FieldRow[]>(() => {
    const t = this.table();
    const s = this.state.schema();
    if (!t || !s) return [];
    const fmap = formulasByVar(t);
    const graphIds = new Set(s.fieldNodes.map((n) => n.id));
    return t.fields.map((f) => {
      const isNew = fmap.has(f);
      const fromSeed = t.role === 'source' || t.role === 'seed';
      return {
        name: f,
        badge: isNew ? 'nuevo aquí' : fromSeed ? 'de origen' : 'heredado',
        badgeCss: isNew ? 'var(--kind-computed)' : fromSeed ? 'var(--kind-input)' : 'var(--kind-modified)',
        exprs: fmap.get(f) ?? [],
        inGraph: graphIds.has(f),
      };
    });
  });

  roleCssOf(name: string): string {
    const t = this.state.schema()?.tables.find((x) => x.name === name);
    return t ? ROLES[t.role].css : 'var(--ink-3)';
  }
}
