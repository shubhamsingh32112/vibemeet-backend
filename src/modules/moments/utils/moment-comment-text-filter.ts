/** Digits (ASCII + fullwidth) are not allowed in moments comments. */
const DIGIT_PATTERN = /[0-9０-９]/;

/** English number words (cardinals / scale words) are not allowed in moments comments. */
const NUMBER_WORD_PATTERN =
  /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/i;

export function momentCommentContainsNumbers(text: string): boolean {
  return DIGIT_PATTERN.test(text) || NUMBER_WORD_PATTERN.test(text);
}
