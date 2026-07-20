import { Component, computed, input } from '@angular/core';
import { PearIcon } from '../icons/icon';
import { tone } from './format';

@Component({
  selector: 'pear-gauge',
  imports: [PearIcon],
  template: `
    <div class="gauge">
      <div class="top">
        <span class="label"><pear-icon [name]="icon()" [size]="11" />{{ label() }}</span>
        <span class="val">{{ valText() }}</span>
      </div>
      <div class="track"><div class="fill" [class]="fillTone()" [style.width.%]="clamped()"></div></div>
    </div>
  `,
  styleUrl: './gauge.scss',
})
export class Gauge {
  readonly icon = input('cpu');
  readonly label = input('');
  readonly valText = input('—');
  readonly pct = input(0);

  readonly clamped = computed(() => Math.max(2, Math.min(100, this.pct())));
  readonly fillTone = computed(() => tone(this.pct()));
}
