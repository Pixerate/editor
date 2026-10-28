/**
 * The option value a select reported: the option whose value is `value`, else the one whose
 * string form is (a string-only host select turns `2` into `"2"`), else `value` itself.
 */
export function matchParameterOptionValue(options: readonly { value: string | number }[], value: string | number): string | number {
  return options.find((o) => o.value === value)?.value ?? options.find((o) => String(o.value) === String(value))?.value ?? value;
}
