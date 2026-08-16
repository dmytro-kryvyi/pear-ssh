/**
 * Exact-string replacement for the edit_file tool. Pure so the permission
 * bridge can build the same before/after diff the executor will apply.
 * Error messages are written for the model: they say what to do next.
 */
export function applyEdit(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): { content: string; count: number } {
  if (oldString === '') throw new Error('old_string must not be empty');
  if (oldString === newString) throw new Error('old_string and new_string are identical');
  let count = 0;
  for (let i = content.indexOf(oldString); i !== -1; i = content.indexOf(oldString, i + 1)) {
    count += 1;
  }
  if (count === 0) {
    throw new Error(
      'old_string not found in the file — read_file and retry with the exact text (whitespace included)',
    );
  }
  if (count > 1 && !replaceAll) {
    throw new Error(
      `old_string matches ${count} times — expand it with surrounding context to make it unique, or set replace_all`,
    );
  }
  return { content: content.split(oldString).join(newString), count };
}
