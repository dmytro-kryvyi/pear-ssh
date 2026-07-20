import { Component, ElementRef, inject, viewChild } from '@angular/core';
import { Pane } from './pane';
import { Workspace } from './workspace';

/** Horizontal row of resizable panes with drag dividers between them. */
@Component({
  selector: 'pear-pane-grid',
  imports: [Pane],
  templateUrl: './pane-grid.html',
  styleUrl: './pane-grid.scss',
})
export class PaneGrid {
  readonly ws = inject(Workspace);
  private readonly container = viewChild.required<ElementRef<HTMLElement>>('container');

  startDivider(index: number, event: MouseEvent): void {
    event.preventDefault();
    const width = this.container().nativeElement.getBoundingClientRect().width;
    const panes = this.ws.panes();
    const total = panes.reduce((a, p) => a + p.flex, 0);
    const startX = event.clientX;
    const leftFlex = panes[index].flex;
    const rightFlex = panes[index + 1].flex;
    const move = (ev: MouseEvent) => {
      const delta = ((ev.clientX - startX) / width) * total;
      let left = leftFlex + delta;
      let right = rightFlex - delta;
      const min = 0.2;
      if (left < min) {
        right -= min - left;
        left = min;
      }
      if (right < min) {
        left -= min - right;
        right = min;
      }
      this.ws.setPaneFlexPair(index, left, right);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    document.body.style.cursor = 'col-resize';
  }
}
