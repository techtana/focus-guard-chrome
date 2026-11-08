// Social-feed filtering for parental mode: posts the site itself marks as
// NSFW/sensitive are hidden with CSS, and feed posts whose own text is
// explicit are hidden one by one, so the site stays usable.
//
// Selectors as of 2026-11. Reddit's `nsfw` attributes and X's sensitive-media
// warning are the sites' own markers; they have not been verified on a
// signed-in session and may need updates.

export interface SocialSite {
  hosts: string[];
  /** Elements the site marks as NSFW/sensitive: hidden outright. */
  nsfwSelectors: string[];
  /** Feed items whose text is checked with postIsExplicit(). */
  postSelector: string;
}

export const SOCIAL_SITES: SocialSite[] = [
  {
    hosts: ['reddit.com'],
    nsfwSelectors: [
      'shreddit-post[nsfw]',
      'shreddit-post[is-nsfw]',
      'shreddit-post[over-18]',
      '[data-nsfw="true"]',
      'shreddit-blurred-container[reason="nsfw"]',
      'shreddit-spoiler-nsfw-media',
      'search-telemetry-tracker:has(shreddit-post[nsfw])',
      '.thing.over18',
    ],
    postSelector: 'shreddit-post, .thing.link, article',
  },
  {
    hosts: ['x.com', 'twitter.com'],
    nsfwSelectors: [
      'article[data-testid="tweet"]:has(a[href$="/settings/content_you_see"])',
      'article[data-testid="tweet"]:has([aria-label*="sensitive" i])',
      'article[data-testid="tweet"]:has([data-testid="sensitiveMediaWarning"])',
    ],
    postSelector: 'article[data-testid="tweet"]',
  },
  {
    hosts: ['instagram.com'],
    nsfwSelectors: ['article:has([aria-label*="sensitive" i])'],
    postSelector: 'article',
  },
  {
    hosts: ['tumblr.com'],
    nsfwSelectors: ['article:has([data-testid="community-label-cover"])', '[data-testid="community-label-cover"]'],
    postSelector: 'article',
  },
  {
    hosts: ['tiktok.com'],
    nsfwSelectors: [],
    postSelector: '[data-e2e="recommend-list-item-container"], [data-e2e="search_top-item"], [data-e2e="user-post-item"]',
  },
];

export function socialSiteFor(host: string): SocialSite | null {
  const h = host.toLowerCase().replace(/^www\./, '');
  return SOCIAL_SITES.find((s) => s.hosts.some((d) => h === d || h.endsWith('.' + d))) ?? null;
}
