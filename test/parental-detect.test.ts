import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isEducationalHost, metaVerdict, postIsExplicit, scorePage, tokenize, type PageInput } from '../src/parental/detect.ts';
import { KNOWN_ADULT_SITES } from '../src/parental/known-sites.ts';
import { imageIsExplicit, pageExplicitByImages } from '../src/parental/policy.ts';
import { socialSiteFor } from '../src/parental/social.ts';
import type { Sensitivity } from '../src/shared/types.ts';

const page = (p: Partial<PageInput>): PageInput => ({
  url: 'https://example.com/',
  title: '',
  meta: {},
  headings: [],
  linkTexts: [],
  alts: [],
  bodySample: '',
  ...p,
});
const opts = (sensitivity: Sensitivity = 'medium', blockedWords: string[] = []) => ({ sensitivity, blockedWords });
const filler = 'The council met on Tuesday to discuss the budget for roads, schools and parks. '.repeat(40);

const CLEAN: [string, PageInput][] = [
  [
    'news article',
    page({
      url: 'https://news.example.com/world/court-sentences-offender',
      title: 'Court sentences sex offender to 8 years',
      headings: ['Judge cites risk to the public'],
      bodySample: `A man was sentenced for sex offences on Monday. ${filler}`,
    }),
  ],
  [
    'Wikipedia sex education article',
    page({
      url: 'https://en.wikipedia.org/wiki/Sex_education',
      title: 'Sex education - Wikipedia',
      headings: ['Sex education', 'History'],
      bodySample: `Sex education covers human sexuality, sex, consent, contraception, pornography and abstinence. ${filler}`,
    }),
  ],
  [
    'cooking page',
    page({
      url: 'https://recipes.example.com/chicken-breast-cocktail-sauce',
      title: 'Breast of chicken with cocktail sauce',
      headings: ['Ingredients', 'Analysis of flavours'],
      bodySample: `Season the breast of chicken and serve with a cocktail of herbs. ${filler}`,
    }),
  ],
  [
    'UK place names',
    page({
      url: 'https://travel.example.co.uk/essex-sussex-scunthorpe',
      title: 'Day trips: Essex, Sussex and Scunthorpe',
      bodySample: `Middlesex, Essex and Sussex are close to London; Scunthorpe is further north. ${filler}`,
    }),
  ],
  [
    'medical page',
    page({
      url: 'https://health.example.org/conditions/erectile-dysfunction',
      title: 'Erectile dysfunction: causes and treatment',
      meta: { description: 'Sexual health advice from doctors.' },
      bodySample: `Problems with orgasm or sex drive can have physical causes. Talk to your doctor. ${filler}`,
    }),
  ],
  [
    'recovery help page',
    page({ url: 'https://help.example.org/porn-addiction', title: 'Porn addiction: where to get help', bodySample: filler }),
  ],
  [
    'graduation news (cum laude)',
    page({ title: 'Student graduates summa cum laude', bodySample: `She graduated magna cum laude in physics. ${filler}` }),
  ],
];

const EXPLICIT: [string, PageInput][] = [
  ['explicit title', page({ url: 'https://tube.example/videos', title: 'Free porn videos - hot milf xxx' })],
  [
    'explicit meta and headings',
    page({
      title: 'Best videos',
      meta: { description: 'Watch hardcore porn, blowjob and gangbang clips', keywords: 'xxx, porn, nsfw' },
      headings: ['Top xxx videos today'],
    }),
  ],
  ['compound host and path', page({ url: 'https://freeporntube.example/category/hentai-xxx', title: 'Category' })],
  ['Spanish', page({ title: 'Videos porno gratis: follando y tetas' })],
  ['German', page({ title: 'Kostenlose Pornos: ficken, titten und mehr porno' })],
  ['Thai', page({ title: 'หนังโป๊ คลิปหลุด เย็ด' })],
];

for (const [name, p] of CLEAN) {
  test(`clean at medium: ${name}`, () => {
    const v = scorePage(p, opts('medium'));
    assert.equal(v.explicit, false, `${name}: score ${v.score}; ${v.reasons.join(' | ')}`);
  });
}

for (const [name, p] of EXPLICIT) {
  test(`explicit at medium: ${name}`, () => {
    const v = scorePage(p, opts('medium'));
    assert.equal(v.explicit, true, `${name}: score ${v.score}; ${v.reasons.join(' | ')}`);
    assert.equal(v.source, 'text');
  });
}

test('tokenizer matches whole words only', () => {
  assert.deepEqual(tokenize('Essex, Sussex! cocktail analysis'), ['essex', 'sussex', 'cocktail', 'analysis']);
  assert.equal(scorePage(page({ title: 'Essex Sussex cocktail analysis Scunthorpe' }), opts('high')).score, 0);
});

test('sensitivity ordering: high flags at least what medium flags, medium at least what low flags', () => {
  const all = [...CLEAN, ...EXPLICIT].map(([, p]) => p);
  all.push(page({ title: 'Nude beach photos', bodySample: 'Naked sunbathing, nude and erotic art. ' }));
  for (const p of all) {
    const low = scorePage(p, opts('low')).explicit;
    const med = scorePage(p, opts('medium')).explicit;
    const high = scorePage(p, opts('high')).explicit;
    if (low) assert.ok(med, p.title);
    if (med) assert.ok(high, p.title);
  }
});

test('meta labels: RTA, rating, og age, isFamilyFriendly', () => {
  assert.equal(metaVerdict({ rating: 'RTA-5042-1996-1400-1577-RTA' })?.source, 'meta');
  assert.ok(metaVerdict({ rating: 'adult' })?.explicit);
  assert.ok(metaVerdict({ rating: 'mature' })?.explicit);
  assert.ok(metaVerdict({ 'og:restrictions:age': '18+' })?.explicit);
  assert.ok(metaVerdict({ isfamilyfriendly: 'False' })?.explicit);
  assert.equal(metaVerdict({ rating: 'general' }), null);
  assert.equal(metaVerdict({ description: 'A news site for adults and kids' }), null);
  assert.equal(metaVerdict({}), null);
});

test('guardian blocked words count as explicit, by whole word or phrase', () => {
  const p = page({ title: 'Buy vape kits online', bodySample: filler });
  assert.equal(scorePage(p, opts('medium')).explicit, false);
  assert.equal(scorePage(p, opts('medium', ['vape'])).explicit, true);
  assert.equal(scorePage(page({ title: 'Escape room' }), opts('medium', ['cape'])).explicit, false);
  assert.equal(scorePage(page({ title: 'Online casino bonus' }), opts('low', ['online casino'])).explicit, true);
  assert.ok(postIsExplicit('great vape deals', opts('low', ['vape'])));
});

test('educational hosts are never flagged by text', () => {
  assert.ok(isEducationalHost('en.wikipedia.org'));
  assert.ok(isEducationalHost('www.cdc.gov'));
  assert.ok(isEducationalHost('cs.stanford.edu'));
  assert.ok(!isEducationalHost('pornhub.com'));
  const p = page({ url: 'https://en.wikipedia.org/wiki/Pornography', title: 'Pornography - Wikipedia', bodySample: 'porn xxx hardcore porn industry' });
  assert.equal(scorePage(p, opts('high')).explicit, false);
});

test('social posts', () => {
  assert.equal(postIsExplicit('Look at my new puppy! So cute', opts('high')), false);
  assert.equal(postIsExplicit('Sex education should start earlier, says report', opts('medium')), false);
  assert.equal(postIsExplicit('New nsfw porn clip, xxx link in bio', opts('medium')), true);
  assert.equal(postIsExplicit('', opts('high')), false);
  assert.ok(socialSiteFor('old.reddit.com'));
  assert.ok(socialSiteFor('www.x.com'));
  assert.equal(socialSiteFor('example.com'), null);
});

test('image policy thresholds', () => {
  const s = (porn: number, hentai = 0, sexy = 0) => ({ url: 'https://i.example/a.jpg', porn, hentai, sexy, neutral: 1 - porn - hentai - sexy, drawing: 0 });
  assert.equal(imageIsExplicit(s(0.8), 'low'), false);
  assert.equal(imageIsExplicit(s(0.9), 'low'), true);
  assert.equal(imageIsExplicit(s(0.6, 0.15), 'medium'), true);
  assert.equal(imageIsExplicit(s(0.6), 'medium'), false);
  assert.equal(imageIsExplicit(s(0.3, 0, 0.5), 'high'), true);
  assert.equal(imageIsExplicit(s(0.3, 0, 0.5), 'medium'), false);
  assert.equal(pageExplicitByImages(1, 1, 'high'), true);
  assert.equal(pageExplicitByImages(1, 1, 'medium'), false);
  assert.equal(pageExplicitByImages(2, 10, 'medium'), false);
  assert.equal(pageExplicitByImages(3, 10, 'medium'), true);
  assert.equal(pageExplicitByImages(3, 10, 'low'), false);
  assert.equal(pageExplicitByImages(4, 10, 'low'), true);
  assert.equal(pageExplicitByImages(0, 10, 'high'), false);
});

test('known adult sites list is clean: sorted, unique, lowercase registrable domains', () => {
  assert.ok(KNOWN_ADULT_SITES.length >= 200, `${KNOWN_ADULT_SITES.length} sites`);
  assert.equal(new Set(KNOWN_ADULT_SITES).size, KNOWN_ADULT_SITES.length);
  assert.deepEqual([...KNOWN_ADULT_SITES].sort(), KNOWN_ADULT_SITES);
  for (const d of KNOWN_ADULT_SITES) {
    assert.match(d, /^[a-z0-9-]+(\.[a-z0-9-]+)+$/, d);
    assert.ok(!d.startsWith('www.'), d);
  }
  for (const general of ['reddit.com', 'x.com', 'twitter.com', 'tumblr.com', 'google.com', 'youtube.com']) assert.ok(!KNOWN_ADULT_SITES.includes(general));
});
