import { Component, computed, inject, signal } from '@angular/core';
import { StateService, View } from './state.service';
import { TableViewComponent } from './table-view.component';
import { FlowViewComponent } from './flow-view.component';
import { LineageViewComponent } from './lineage-view.component';
import { ROLES, splitName } from './ui';
import { buildReport } from './sas/report';

@Component({
  selector: 'app-root',
  imports: [TableViewComponent, FlowViewComponent, LineageViewComponent],
  templateUrl: './app.component.html',
})
export class AppComponent {
  readonly state = inject(StateService);
  readonly roles = Object.values(ROLES);
  readonly dragOver = signal(false);
  readonly pasteOpen = signal(false);
  readonly pasteText = signal('');
  readonly splitName = splitName;
  readonly rolesMap = ROLES;

  readonly stats = computed(() => {
    const s = this.state.schema();
    if (!s) return [];
    const fields = new Set<string>();
    s.tables.forEach((t) => t.fields.forEach((f) => fields.add(f)));
    return [
      { v: s.files.length, l: 'programas' },
      { v: s.tables.length, l: 'tablas' },
      { v: fields.size, l: 'campos' },
      { v: s.fieldEdges.length, l: 'relaciones' },
    ];
  });

  setView(v: View): void {
    this.state.view.set(v);
  }

  async onFileInput(ev: Event): Promise<void> {
    const input = ev.target as HTMLInputElement;
    if (input.files?.length) await this.state.addFiles(input.files);
    input.value = '';
  }

  async onDrop(ev: DragEvent): Promise<void> {
    ev.preventDefault();
    this.dragOver.set(false);
    if (ev.dataTransfer?.files?.length) await this.state.addFiles(ev.dataTransfer.files);
  }

  onDragOver(ev: DragEvent): void {
    ev.preventDefault();
    this.dragOver.set(true);
  }

  submitPaste(): void {
    this.state.addPasted(this.pasteText());
    this.pasteText.set('');
    this.pasteOpen.set(false);
  }

  onPasteInput(ev: Event): void {
    this.pasteText.set((ev.target as HTMLTextAreaElement).value);
  }

  onSearch(ev: Event): void {
    this.state.search.set((ev.target as HTMLInputElement).value);
  }

  download(): void {
    const s = this.state.schema();
    if (!s) return;
    const blob = new Blob([buildReport(s)], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'tablas_sas.txt';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }
}
