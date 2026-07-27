import { Component, computed, input } from '@angular/core';

const W = 100;
const H = 28;
const PAD = 1.5;

/**
 * Tiny history line. Null points break the line (no sample yet / counter
 * reset), so a fresh host shows a line growing from the left. The vertical
 * scale is max(max, data peak) — pass a low `max` to auto-scale (network).
 */
@Component({
  selector: 'pear-sparkline',
  template: `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path [attr.d]="area()" [attr.fill]="color()" opacity="0.12" stroke="none" />
      <path
        [attr.d]="line()"
        fill="none"
        [attr.stroke]="color()"
        stroke-width="1.3"
        vector-effect="non-scaling-stroke"
        stroke-linejoin="round"
      />
    </svg>
  `,
  styles: `
    :host { display: block; }
    svg { display: block; width: 100%; height: 100%; overflow: visible; }
  `,
})
export class Sparkline {
  readonly points = input.required<(number | null)[]>();
  readonly max = input(100);
  readonly tone = input<'accent' | 'warn' | 'err' | 'muted'>('accent');

  readonly color = computed(
    () =>
      ({
        accent: 'var(--accent)',
        warn: 'var(--warn)',
        err: 'var(--err)',
        muted: 'var(--fg-3)',
      })[this.tone()],
  );

  /** Line and filled area paths, one subpath per contiguous non-null run. */
  private readonly paths = computed(() => {
    const pts = this.points();
    const n = pts.length;
    if (n < 2) return { line: '', area: '' };
    const values = pts.filter((v): v is number => v != null);
    if (values.length === 0) return { line: '', area: '' };
    const peak = Math.max(this.max(), ...values) || 1;
    let line = '';
    let area = '';
    let run: { x: number; y: number }[] = [];
    const flush = () => {
      if (run.length >= 2) {
        line += 'M' + run.map((p) => `${p.x} ${p.y}`).join('L');
        area +=
          'M' +
          run.map((p) => `${p.x} ${p.y}`).join('L') +
          `L${run[run.length - 1].x} ${H}L${run[0].x} ${H}Z`;
      }
      run = [];
    };
    pts.forEach((v, i) => {
      if (v == null) {
        flush();
        return;
      }
      const x = +((i / (n - 1)) * W).toFixed(2);
      const y = +(H - PAD - (Math.min(v, peak) / peak) * (H - 2 * PAD)).toFixed(2);
      run.push({ x, y });
    });
    flush();
    return { line, area };
  });

  readonly line = computed(() => this.paths().line);
  readonly area = computed(() => this.paths().area);
}
