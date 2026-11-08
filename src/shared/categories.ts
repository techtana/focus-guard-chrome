// Built-in domain -> category map for insights (FR-8.2). Users override per
// domain in Insights; overrides are stored in config.categoryOverrides.

import type { Category } from './types.ts';

export const CATEGORIES: Category[] = ['social', 'video', 'news', 'shopping', 'work', 'ai', 'other'];

export const CATEGORY_LABELS: Record<Category, string> = {
  social: 'Social',
  video: 'Video',
  news: 'News',
  shopping: 'Shopping',
  work: 'Work',
  ai: 'AI chat',
  other: 'Other',
};

const LIST: Record<Exclude<Category, 'other'>, string[]> = {
  social: [
    'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'reddit.com', 'tiktok.com', 'snapchat.com',
    'pinterest.com', 'linkedin.com', 'tumblr.com', 'threads.net', 'bsky.app', 'mastodon.social', 'discord.com',
    'quora.com', 'vk.com', 'weibo.com', 'messenger.com', 'web.whatsapp.com', 'telegram.org', 'web.telegram.org',
    '9gag.com', 'imgur.com', 'lemmy.world', 'nextdoor.com', 'line.me',
  ],
  video: [
    'youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'hulu.com',
    'disneyplus.com', 'primevideo.com', 'max.com', 'hbomax.com', 'crunchyroll.com', 'bilibili.com', 'kick.com',
    'spotify.com', 'open.spotify.com', 'soundcloud.com', 'music.youtube.com', 'peacocktv.com', 'paramountplus.com',
    'tv.apple.com', 'rumble.com', 'nicovideo.jp',
  ],
  news: [
    'cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'washingtonpost.com', 'reuters.com',
    'apnews.com', 'foxnews.com', 'nbcnews.com', 'cnbc.com', 'bloomberg.com', 'wsj.com', 'ft.com', 'economist.com',
    'news.google.com', 'news.yahoo.com', 'huffpost.com', 'npr.org', 'aljazeera.com', 'theverge.com',
    'techcrunch.com', 'wired.com', 'arstechnica.com', 'news.ycombinator.com', 'buzzfeed.com', 'vox.com',
    'axios.com', 'politico.com', 'usatoday.com', 'dailymail.co.uk', 'espn.com', 'theatlantic.com',
  ],
  shopping: [
    'amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.co.jp', 'ebay.com', 'etsy.com', 'aliexpress.com',
    'walmart.com', 'target.com', 'bestbuy.com', 'temu.com', 'shein.com', 'shopee.com', 'lazada.com', 'ikea.com',
    'wayfair.com', 'zalando.com', 'asos.com', 'costco.com', 'homedepot.com', 'rakuten.com', 'taobao.com',
    'jd.com', 'nike.com', 'craigslist.org',
  ],
  work: [
    'github.com', 'gitlab.com', 'bitbucket.org', 'stackoverflow.com', 'stackexchange.com', 'docs.google.com',
    'drive.google.com', 'mail.google.com', 'calendar.google.com', 'meet.google.com', 'outlook.com',
    'outlook.office.com', 'office.com', 'teams.microsoft.com', 'slack.com', 'notion.so', 'notion.site',
    'atlassian.net', 'trello.com', 'asana.com', 'linear.app', 'figma.com', 'miro.com', 'zoom.us', 'dropbox.com',
    'developer.mozilla.org', 'developer.chrome.com', 'npmjs.com', 'pypi.org', 'aws.amazon.com',
    'console.cloud.google.com', 'portal.azure.com', 'vercel.com', 'netlify.com', 'jira.com', 'confluence.com',
    'monday.com', 'clickup.com', 'airtable.com', 'canva.com', 'overleaf.com', 'wikipedia.org', 'coursera.org',
    'udemy.com', 'khanacademy.org',
  ],
  ai: [
    'chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'bard.google.com', 'perplexity.ai',
    'copilot.microsoft.com', 'poe.com', 'character.ai', 'chat.mistral.ai', 'chat.deepseek.com', 'grok.com',
    'you.com', 'pi.ai', 'huggingface.co', 'meta.ai', 'notebooklm.google.com', 'aistudio.google.com',
  ],
};

/** domain -> category for the built-in list. */
export const BUILTIN_CATEGORIES: Readonly<Record<string, Category>> = (() => {
  const map: Record<string, Category> = {};
  for (const [cat, domains] of Object.entries(LIST) as [Category, string[]][]) {
    for (const d of domains) map[d] = cat;
  }
  return map;
})();

/**
 * Category of a domain. The most specific match wins, checking overrides
 * before the built-in map at each level: "m.youtube.com" -> "youtube.com".
 */
export function categoryOf(domain: string, overrides: Record<string, Category> = {}): Category {
  let d = domain.trim().toLowerCase().replace(/\.$/, '');
  if (d.startsWith('www.')) d = d.slice(4);
  while (d) {
    if (overrides[d]) return overrides[d];
    if (BUILTIN_CATEGORIES[d]) return BUILTIN_CATEGORIES[d];
    const i = d.indexOf('.');
    if (i < 0) break;
    d = d.slice(i + 1);
    if (!d.includes('.')) break; // stop at the TLD
  }
  return 'other';
}
