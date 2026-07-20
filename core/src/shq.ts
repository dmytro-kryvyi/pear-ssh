/** POSIX single-quote escaping for values interpolated into remote commands. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
