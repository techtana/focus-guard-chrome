// Challenge passage (FR-4.2): a random passage of about `length` characters,
// built from common words so it is typeable but not memorable.

const WORDS = (
  'the quiet river runs past old stone walls while morning light falls on green hills and small birds ' +
  'sing above the fields a patient mind finds calm in steady work each careful step builds strength over ' +
  'time focus grows when attention rests on one thing at a time clear goals guide the hand through long ' +
  'hours of practice notice the breath return to the task and let the noise fade into the distance ' +
  'every page written moves the project forward small wins add up to great results by the end of the week ' +
  'distraction is a habit and habits can change with gentle effort choose the harder path today'
).split(' ');

/** Uniform random integer in [0, n) from crypto. */
function randInt(n: number, rand: () => number): number {
  return Math.floor(rand() * n);
}

function cryptoRand(): number {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

export function makePassage(length: number, rand: () => number = cryptoRand): string {
  const target = Math.max(20, Math.min(length, 2000));
  const parts: string[] = [];
  let len = 0;
  let sentenceStart = true;
  while (len < target) {
    let w = WORDS[randInt(WORDS.length, rand)];
    if (sentenceStart) w = w[0].toUpperCase() + w.slice(1);
    sentenceStart = false;
    if (len + w.length + 1 >= target || rand() < 0.08) {
      w += '.';
      sentenceStart = true;
    }
    parts.push(w);
    len += w.length + 1;
  }
  let s = parts.join(' ');
  if (!s.endsWith('.')) s += '.';
  return s;
}

/** Exact comparison after normalizing line endings and surrounding whitespace. */
export function passageMatches(expected: string, typed: string): boolean {
  return expected.trim() === typed.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}
