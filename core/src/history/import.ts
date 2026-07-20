/**
 * Optional import of a host's own shell history files.
 *
 * Strictly opt-in: nothing here runs unless the caller asks for it. Reading
 * someone's ~/.bash_history is a meaningful thing to do to a server, so the
 * decision belongs to the user, not to a background task.
 */

/**
 * Files worth looking at, in the order they are tried. Paths are relative:
 * SFTP resolves them against the login home, so no tilde expansion is needed.
 */
export const HISTORY_FILES = [
  '.bash_history',
  '.zsh_history',
  '.histfile',
  '.local/share/fish/fish_history',
] as const;

/** Refuse anything absurd; real history files sit far below this. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Keep only the tail: the most recent commands are the useful ones. */
const MAX_LINES_PER_FILE = 2000;

export interface ImportResult {
  /** Files that existed and parsed to at least one command. */
  files: string[];
  commands: string[];
}

/**
 * Parses one history file's contents. The format is inferred from the path,
 * falling back to one-command-per-line.
 */
export function parseHistoryFile(path: string, raw: string): string[] {
  if (path.includes('fish_history')) return parseFish(raw);
  if (path.includes('zsh') || path.includes('histfile')) return parseZsh(raw);
  return parseBash(raw);
}

/** Plain lines; `#1699999999` timestamp lines when HISTTIMEFORMAT is set. */
function parseBash(raw: string): string[] {
  return raw
    .split('\n')
    .filter((line) => line.trim() && !/^#\d+$/.test(line.trim()));
}

/**
 * zsh extended history: `: <started>:<elapsed>;<command>`, where a command
 * can continue onto following lines when the previous one ends in a backslash.
 */
function parseZsh(raw: string): string[] {
  const commands: string[] = [];
  let pending: string | null = null;
  for (const line of raw.split('\n')) {
    if (pending !== null) {
      pending = `${pending}\n${line}`;
      if (!line.endsWith('\\')) {
        commands.push(pending);
        pending = null;
      }
      continue;
    }
    const match = /^: \d+:\d+;(.*)$/.exec(line);
    const command = match ? match[1] : line;
    if (!command.trim()) continue;
    if (command.endsWith('\\')) pending = command;
    else commands.push(command);
  }
  if (pending !== null) commands.push(pending);
  return commands;
}

/** fish history is YAML-ish: `- cmd: <command>` followed by `  when: <ts>`. */
function parseFish(raw: string): string[] {
  const commands: string[] = [];
  for (const line of raw.split('\n')) {
    const match = /^- cmd:\s*(.*)$/.exec(line);
    if (match) commands.push(unescapeFish(match[1]));
  }
  return commands;
}

function unescapeFish(value: string): string {
  return value.replace(/\\(.)/g, '$1');
}

/**
 * Reads the candidate history files from a host and returns the commands
 * found. Missing files are skipped silently — most hosts have only one or two.
 *
 * @param readFile resolves a remote path's contents; rejects when absent.
 */
export async function importShellHistory(
  readFile: (path: string, maxBytes?: number) => Promise<string>,
  files: readonly string[] = HISTORY_FILES,
): Promise<ImportResult> {
  const result: ImportResult = { files: [], commands: [] };
  for (const path of files) {
    let raw: string;
    try {
      raw = await readFile(path, MAX_BYTES);
    } catch {
      continue; // absent or unreadable
    }
    const commands = parseHistoryFile(path, raw).slice(-MAX_LINES_PER_FILE);
    if (!commands.length) continue;
    result.files.push(path);
    result.commands.push(...commands);
  }
  return result;
}
