import { Component, inject, input, output } from '@angular/core';
import type { Favourite } from '@pear/core';
import { PmIcon } from '../icons/icon';
import { PearSession } from '../state/session';

/**
 * Favourite folders: a horizontal card strip on the phone's Hosts screen, a
 * compact list in the tablet rail. Renders nothing while the list is empty.
 */
@Component({
  selector: 'pm-favourites',
  imports: [PmIcon],
  template: `
    @if (session.favouriteRows().length) {
      <div class="sec-label">Favourites</div>
      <div class="favs noscroll" [class.list]="list()">
        @for (r of session.favouriteRows(); track r.fav.id) {
          <div class="fav" [class.active]="session.isCurrent(r.fav)">
            <button class="go" (click)="open.emit(r.fav)">
              <pm-icon name="starFilled" [size]="14" class="star" />
              <span class="text">
                <span class="name">{{ r.label }}</span>
                <span class="meta">{{ r.host.name }} · {{ r.fav.path }}</span>
              </span>
            </button>
            <button class="rm" title="Remove from favourites" (click)="session.removeFavourite(r.fav.id)">
              <pm-icon name="close" [size]="13" />
            </button>
          </div>
        }
      </div>
    }
  `,
  styles: `
    :host { display: block; }
    :host:empty { display: none; }
    .favs { display: flex; gap: 10px; overflow-x: auto; padding-bottom: 4px; }
    .fav {
      flex-shrink: 0; width: 168px; display: flex; align-items: stretch;
      border-radius: 14px; background: var(--bg-2); border: 1px solid var(--border-soft);
      &.active { background: var(--accent-soft); border-color: var(--accent-line); }
    }
    .go {
      flex: 1; min-width: 0; display: flex; align-items: center; gap: 9px;
      padding: 11px 0 11px 12px; text-align: left;
    }
    .star { color: var(--accent); flex-shrink: 0; }
    .text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .name, .meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .name { font-size: 13.5px; font-weight: 600; }
    .meta { font-family: var(--mono); font-size: 10.5px; color: var(--fg-3); }
    .rm { flex-shrink: 0; width: 34px; display: grid; place-items: center; color: var(--fg-3); }

    .favs.list {
      flex-direction: column; gap: 2px; overflow-x: visible; overflow-y: auto;
      max-height: 26vh; padding-bottom: 0;
      .fav { width: auto; border-radius: 10px; background: none; border-color: transparent; }
      .fav.active { background: var(--bg-2); }
      .go { padding: 8px 0 8px 10px; }
    }
  `,
})
export class PmFavourites {
  /** Vertical list (tablet rail) instead of the card strip. */
  readonly list = input(false);
  readonly open = output<Favourite>();

  protected readonly session = inject(PearSession);
}
