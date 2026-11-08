// Weighted explicit-term lexicon for on-device page and post scoring.
//
// Matching is by whole token (Unicode letters/digits), never by substring, so
// "Essex", "Sussex", "cocktail", "analysis", "Scunthorpe" and "breast of
// chicken" do not match. Two-word phrases match adjacent tokens. Thai has no
// word spacing, so Thai terms match as substrings (THAI_TERMS).
//
// Weights 1–5: 5 = unambiguous pornography vocabulary, 1 = common in news,
// health and everyday text (only counts together with stronger terms).
// Identity words (gay, lesbian, trans, ...) and crime words (rape, abuse) are
// deliberately absent: they appear in news, health and support pages.

export const TERMS: Record<string, number> = {
  // English
  porn: 5,
  porno: 5,
  pornstar: 5,
  pornstars: 5,
  pornographic: 3,
  pornography: 2,
  xxx: 3,
  nsfw: 3,
  hentai: 4,
  blowjob: 5,
  blowjobs: 5,
  cumshot: 5,
  cumshots: 5,
  creampie: 5,
  gangbang: 5,
  handjob: 5,
  deepthroat: 4,
  bukkake: 5,
  milf: 4,
  milfs: 4,
  pussy: 4,
  cock: 2,
  cocks: 3,
  dick: 1,
  tits: 4,
  titties: 4,
  boobs: 3,
  anal: 3,
  orgy: 4,
  threesome: 3,
  nude: 2,
  nudes: 3,
  nudity: 1,
  naked: 1,
  erotic: 2,
  erotica: 3,
  fetish: 2,
  bdsm: 3,
  bondage: 2,
  dildo: 4,
  dildos: 4,
  vibrator: 2,
  masturbate: 3,
  masturbating: 4,
  masturbation: 2,
  orgasm: 3,
  horny: 3,
  slut: 4,
  sluts: 4,
  whore: 3,
  escort: 1,
  escorts: 2,
  camgirl: 4,
  camgirls: 4,
  sexy: 1,
  sex: 1,
  hardcore: 2,
  softcore: 3,
  stripper: 2,
  striptease: 3,
  shemale: 4,
  onlyfans: 2,
  fap: 3,
  fapping: 3,
  cum: 2,
  jizz: 4,
  boner: 2,
  upskirt: 5,
  voyeur: 2,
  incest: 2,
  // Spanish
  follando: 5,
  'coño': 4,
  tetas: 3,
  culo: 2,
  puta: 3,
  putas: 3,
  desnuda: 2,
  desnudas: 2,
  sexo: 1,
  // Portuguese
  buceta: 5,
  putaria: 4,
  gostosa: 2,
  pelada: 2,
  transando: 4,
  // French
  baise: 3,
  salope: 4,
  salopes: 4,
  branlette: 5,
  sexe: 1,
  nue: 1,
  // German
  ficken: 5,
  fick: 4,
  titten: 4,
  muschi: 2,
  geil: 2,
  schlampe: 3,
  nackt: 1,
  // Russian
  'порно': 5,
  'порнуха': 5,
  'секс': 1,
  'голые': 2,
  'шлюха': 3,
  'шлюхи': 3,
  'эротика': 3,
  'трах': 4,
  'трахает': 5,
  // Japanese (romaji)
  ecchi: 3,
  oppai: 3,
  chikan: 4,
  gokkun: 5,
  nakadashi: 5,
  jav: 3,
  ahegao: 4,
};

/** Two-word phrases, matched on adjacent tokens. */
export const PHRASES: Record<string, number> = {
  'sex video': 4,
  'sex videos': 4,
  'sex tape': 3,
  'free porn': 5,
  'live sex': 5,
  'sex cam': 4,
  'sex cams': 4,
  'sex chat': 3,
  'nude pics': 4,
  'nude photos': 3,
  'jerk off': 4,
  'adults only': 2,
  'adult videos': 4,
  'adult content': 1,
  'hot girls': 1,
  'big tits': 5,
  'teen sex': 5,
};

/** Thai terms, matched as substrings (no word spacing in Thai). */
export const THAI_TERMS: Record<string, number> = {
  'หนังโป๊': 5,
  'โป๊': 4,
  'เย็ด': 5,
  'คลิปหลุด': 3,
  'หี': 4,
};

/**
 * Host substrings that signal adult sites when they appear inside a compound
 * host name ("freeporntube", "hentaiworld"). Only stems with no common innocent
 * words around them; "sex" is excluded (Essex, Sussex, sextant).
 */
export const HOST_STEMS: Record<string, number> = {
  porn: 5,
  hentai: 4,
  xxx: 3,
  nsfw: 3,
};

/**
 * Text detection never flags these hosts (and *.edu, *.gov, *.ac.uk, ...):
 * encyclopaedias, public health and education sites discuss sexuality
 * clinically. Meta age labels and images are still checked.
 */
export const EDUCATIONAL_HOSTS: string[] = [
  'wikipedia.org',
  'wikimedia.org',
  'wiktionary.org',
  'britannica.com',
  'nih.gov',
  'who.int',
  'cdc.gov',
  'nhs.uk',
  'mayoclinic.org',
  'clevelandclinic.org',
  'webmd.com',
  'healthline.com',
  'medlineplus.gov',
  'khanacademy.org',
  'plannedparenthood.org',
  'kidshealth.org',
  'unicef.org',
  'unesco.org',
  'bbc.co.uk',
  'scholar.google.com',
  'pubmed.ncbi.nlm.nih.gov',
];

/** Public-sector and academic suffixes treated like EDUCATIONAL_HOSTS. */
export const EDUCATIONAL_SUFFIXES: string[] = ['.edu', '.gov', '.mil', '.ac.uk', '.edu.au', '.gov.uk', '.ac.jp', '.edu.cn'];
