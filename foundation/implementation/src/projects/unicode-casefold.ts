import {CASE_FOLD_17} from './unicode-casefold-17.generated.ts';

export const CASE_FOLD_VERSION = '17.0.0';

/** Default full C+F folding of scalar text. Normalization, path validation and
 * inventory collision policy belong to the calling layer. */
export function unicodeDefaultCaseFold17(value: string): string {
  if (typeof value !== 'string') throw new TypeError('Casefold requires a string');
  let result = '';
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError('Casefold requires Unicode scalar text');
    result += CASE_FOLD_17[point] ?? character;
  }
  return result;
}
