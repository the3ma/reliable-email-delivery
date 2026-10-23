/** Joins truthy class names (CSS module lookups are `string | undefined` under strict indexing). */
export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
