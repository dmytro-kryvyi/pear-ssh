import {
  Component,
  DestroyRef,
  ElementRef,
  Injectable,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { PearIcon } from '../icons/icon';

export interface MenuItem {
  label?: string;
  /** pear-icon name. */
  icon?: string;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  onClick?: () => void;
}

export interface OpenMenu {
  x: number;
  y: number;
  items: MenuItem[];
}

/** One menu at a time, opened from anywhere, rendered once in the app root. */
@Injectable({ providedIn: 'root' })
export class ContextMenuService {
  readonly menu = signal<OpenMenu | null>(null);

  open(x: number, y: number, items: MenuItem[]): void {
    this.menu.set({ x, y, items });
  }

  close(): void {
    this.menu.set(null);
  }
}

@Component({
  selector: 'pear-context-menu',
  imports: [PearIcon],
  templateUrl: './context-menu.html',
  styleUrl: './context-menu.scss',
})
export class ContextMenu {
  readonly service = inject(ContextMenuService);
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');

  /** Viewport-clamped position, settled after the panel is measured. */
  readonly pos = signal<{ x: number; y: number } | null>(null);

  constructor() {
    effect(() => {
      const menu = this.service.menu();
      const el = this.panel()?.nativeElement;
      if (!menu || !el) {
        this.pos.set(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      let { x, y } = menu;
      if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
      if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
      this.pos.set({ x: Math.max(8, x), y: Math.max(8, y) });
    });

    const dismissDown = (e: MouseEvent) => {
      const el = this.panel()?.nativeElement;
      if (el && !el.contains(e.target as Node)) this.service.close();
    };
    const dismissKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') this.service.close();
    };
    const dismiss = () => this.service.close();
    window.addEventListener('mousedown', dismissDown, true);
    window.addEventListener('keydown', dismissKey);
    window.addEventListener('blur', dismiss);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('mousedown', dismissDown, true);
      window.removeEventListener('keydown', dismissKey);
      window.removeEventListener('blur', dismiss);
    });
  }

  run(item: MenuItem): void {
    if (item.disabled) return;
    this.service.close();
    item.onClick?.();
  }
}
