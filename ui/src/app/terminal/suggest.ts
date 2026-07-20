import type { Terminal } from '@xterm/xterm';

/**
 * Inline history suggestions, rendered entirely on the client.
 *
 * The remote shell never sees any of this: ghost text is written straight into
 * xterm (`xterm.write`), while only real keystrokes go down the SSH channel.
 * Nothing has to be installed on the host.
 *
 * The remote shell — not us — owns line editing, so rather than trying to
 * model what it does to the line, we read the line back off the screen. xterm
 * has already applied whatever the shell did, so tab completion, history
 * recall and line kills all come out right without being special-cased. All we
 * have to remember is the column the input started at.
 *
 * Ghost text is never included in what we read: it is drawn *after* the cursor
 * and we only ever read up to the cursor.
 */

/** Keys that accept the whole suggestion, as zsh-autosuggestions does. */
const ACCEPT_KEYS = new Set([
  '\x1b[C', // Right
  '\x1bOC', // Right, application cursor mode
  '\x05', // Ctrl+E
  '\x1b[F', // End
  '\x1bOF', // End, application cursor mode
]);

const ENTER = new Set(['\r', '\n']);
/** Ctrl+C, Ctrl+D, Ctrl+G: the line is abandoned, a fresh prompt follows. */
const ABANDON_KEYS = new Set(['\x03', '\x04', '\x07']);

const DIM = '\x1b[90m';
const RESET_SGR = '\x1b[0m';
const ERASE_TO_EOL = '\x1b[K';

export interface InlineSuggestOptions {
  /** Best completion for a prefix, or undefined. Must be cheap: runs per keystroke. */
  lookup: (prefix: string) => string | undefined;
  /** Sends bytes to the remote PTY. */
  send: (data: string) => void;
  /** Fires when the user submits a line, with the line as read off the screen. */
  onCommand?: (command: string) => void;
}

/**
 * Tracking state for the current line:
 *  - `idle`    nothing typed since the last prompt; the next printable key anchors us
 *  - `active`  we know where the input starts, so the line can be read back
 *  - `blocked` the line gained content before we could anchor it; silent until Enter
 */
type State = 'idle' | 'active' | 'blocked';

export class InlineSuggest {
  private state: State = 'idle';
  /** Column the input starts at — just past the prompt. */
  private anchorX = 0;
  /** Absolute row (scrollback included) the input starts on. */
  private anchorRow = 0;
  /** The full not-yet-typed remainder, even when drawn truncated. */
  private suffix = '';
  /** How many columns of ghost text are currently on screen. */
  private drawn = 0;
  private enabled = true;

  constructor(
    private readonly xterm: Terminal,
    private readonly options: InlineSuggestOptions,
  ) {}

  /** Turns suggestions off without losing command tracking for history. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.erase();
      this.suffix = '';
    }
  }

  /**
   * Handles one chunk from `xterm.onData`. Forwards to the remote unless the
   * key was consumed to accept a suggestion.
   */
  handleInput(data: string): void {
    const showing = this.drawn > 0 && !!this.suffix;
    this.erase();

    if (showing && this.enabled && ACCEPT_KEYS.has(data)) {
      // Type the suggestion for the user: the remote echoes it back, so the
      // ghost turns into real text with no local redraw needed.
      const accepted = this.suffix;
      this.suffix = '';
      this.options.send(accepted);
      return;
    }
    // Any other key changes the line, so the pending suffix is now stale.
    // It gets recomputed from the screen once the echo lands.
    this.suffix = '';

    if (ENTER.has(data)) {
      const command = this.readInput();
      if (command.trim()) this.options.onCommand?.(command);
      this.state = 'idle';
    } else if (ABANDON_KEYS.has(data)) {
      this.state = 'idle';
    } else if (this.state === 'idle' && isPrintable(data)) {
      // First key of a new line: the cursor is sitting just past the prompt.
      const buffer = this.xterm.buffer.active;
      this.anchorX = buffer.cursorX;
      this.anchorRow = buffer.baseY + buffer.cursorY;
      this.state = 'active';
    } else if (this.state === 'idle' && !isPrintable(data)) {
      // Something that can put text on the line before we ever saw a
      // keystroke — history recall, a paste, Ctrl+R. We have no anchor and
      // cannot invent one, so stay quiet until the next prompt.
      this.state = 'blocked';
    }

    this.options.send(data);
  }

  /**
   * Handles one chunk from the remote. Owns the actual `xterm.write` so the
   * ghost can be erased before the output lands and redrawn after it.
   */
  handleOutput(chunk: string): void {
    this.erase();
    this.xterm.write(chunk, () => this.draw());
  }

  /**
   * The current input line, read back from the screen: everything between the
   * anchor and the cursor, following wrapped rows. Returns '' whenever the
   * line cannot be read with confidence.
   */
  private readInput(): string {
    if (this.state !== 'active') return '';
    const buffer = this.xterm.buffer.active;
    const cursorRow = buffer.baseY + buffer.cursorY;
    if (cursorRow < this.anchorRow) return '';
    if (cursorRow === this.anchorRow && buffer.cursorX < this.anchorX) {
      // The cursor is behind where we believe the input starts, so the anchor
      // is wrong — a redrawn prompt, or one we misread. Reading from it would
      // silently chop the front off the line, so stop until the next prompt.
      this.state = 'blocked';
      return '';
    }
    if (cursorRow === this.anchorRow && buffer.cursorX === this.anchorX) return '';

    let text = '';
    for (let row = this.anchorRow; row <= cursorRow; row++) {
      const line = buffer.getLine(row);
      if (!line) return '';
      // Rows after the first must be continuations. If one is not, the prompt
      // has scrolled or been redrawn and the anchor no longer means anything.
      if (row > this.anchorRow && !line.isWrapped) return '';
      const from = row === this.anchorRow ? this.anchorX : 0;
      const to = row === cursorRow ? buffer.cursorX : this.xterm.cols;
      text += line.translateToString(false, from, to);
    }
    return text;
  }

  /**
   * Whether the cursor sits at the end of the input. Only the cell directly
   * under the cursor is checked: a zsh right-hand prompt lives further out and
   * should not stop us suggesting.
   */
  private atInputEnd(): boolean {
    const buffer = this.xterm.buffer.active;
    const line = buffer.getLine(buffer.baseY + buffer.cursorY);
    if (!line) return false;
    const chars = line.getCell(buffer.cursorX)?.getChars() ?? '';
    return chars === '' || chars === ' ';
  }

  /**
   * Draws the ghost at the cursor and steps back onto it. Only ever drawn on
   * the cursor's own row: keeping it inside one line means a single
   * erase-to-end-of-line takes it away again, with no wrap to unpick.
   */
  private draw(): void {
    if (this.drawn || !this.enabled || this.state !== 'active') return;
    if (this.xterm.buffer.active.type === 'alternate') return; // vim, less, htop…

    this.suffix = '';
    const input = this.readInput();
    if (!input.trim() || !this.atInputEnd()) return;

    const match = this.options.lookup(input);
    if (!match || match.length <= input.length || !match.startsWith(input)) return;

    const room = this.xterm.cols - this.xterm.buffer.active.cursorX - 1;
    if (room < 1) return;
    const text = match.slice(input.length, input.length + room);
    if (!text) return;

    // Keep the whole remainder for the accept key even when it is shown clipped.
    this.suffix = match.slice(input.length);
    this.xterm.write(`${DIM}${text}${RESET_SGR}\x1b[${text.length}D`);
    this.drawn = text.length;
  }

  private erase(): void {
    if (!this.drawn) return;
    this.xterm.write(ERASE_TO_EOL);
    this.drawn = 0;
  }
}

function isPrintable(data: string): boolean {
  // eslint-disable-next-line no-control-regex
  return data.length > 0 && !/[\x00-\x1f\x7f]/.test(data);
}
