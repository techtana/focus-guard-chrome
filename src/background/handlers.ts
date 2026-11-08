// Runtime message handlers (see shared/messages.ts for the contract).

import { isRedirectLoop } from '../shared/dnr.ts';
import { currentPhase, sessionEndsAt } from '../shared/focus.ts';
import { newId } from '../shared/defaults.ts';
import type { BlockInfo, BudgetView, Request, ResponseMap, Snapshot, TabStatus } from '../shared/messages.ts';
import {
  budgetLimitSec,
  budgetUsed,
  decideUrl,
  isBudgetExhausted,
  lockedRuleIds,
  ruleNormallyActive,
  ruleUnblockAt,
  type EngineState,
} from '../shared/rules.ts';
import { describeSchedule, localDateKey, nextBudgetReset } from '../shared/schedule.ts';
import type { Rule } from '../shared/types.ts';
import { expandTargets, hostOf, normalizeHost, targetHost, targetLabel } from '../shared/url.ts';
import { applyChange, recordDetection, requestChallenge } from './apply.ts';
import { KNOWN_ADULT_SITES } from '../parental/known-sites.ts';
import type { OffscreenClassifyResponse } from '../shared/messages.ts';
import { isAllowedHost, PARENTAL_REASON, PARENTAL_RULE_ID, parentalBlockPath } from '../shared/parental.ts';
import type { PageVerdict } from '../shared/types.ts';
import { currentEntries, isSupportedUrl, syncOffscreen } from './engine.ts';
import { dayRecord, getPresets, updateStats } from './state.ts';

function budgetViews(es: EngineState, rules: Rule[]): BudgetView[] {
  return rules
    .filter((r) => !r.allow && r.action.kind === 'budget')
    .map((r) => ({ ruleId: r.id, name: r.name || 'Budget', usedSec: Math.round(budgetUsed(r, es)), limitSec: budgetLimitSec(r) }));
}

async function snapshot(): Promise<Snapshot> {
  const { es, entries } = await currentEntries();
  const { config, runtime, now } = es;
  const { passwordHash, ...settings } = config.settings;
  const { pinHash, ...parental } = config.parental;
  return {
    now,
    config: { ...config, settings: { ...settings, hasPassword: !!passwordHash }, parental: { ...parental, hasPin: !!pinHash } },
    parentalKnownSites: KNOWN_ADULT_SITES.length,
    incognitoAllowed: await chrome.extension.isAllowedIncognitoAccess(),
    runtime,
    focusPhase: runtime.focus ? currentPhase(runtime.focus, now) : null,
    focusEndsAt: runtime.focus ? sessionEndsAt(runtime.focus) : null,
    budgets: budgetViews(es, config.rules),
    activeRuleIds: [...new Set(entries.filter((e) => !e.ruleId.startsWith('lock:')).map((e) => e.ruleId))],
    lockedRuleIds: [...lockedRuleIds(runtime, now)],
    redirectLoopRuleIds: entries.filter((e) => isRedirectLoop(e, entries)).map((e) => e.ruleId),
    presets: await getPresets(),
    nextResetAt: nextBudgetReset(now, config.settings.resetTime),
  };
}

async function tabStatus(tabId: number): Promise<TabStatus> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const url = tab?.url;
  const none: TabStatus = { supported: false, host: url ? hostOf(url) : null, action: 'none', hiding: [], budgets: [] };
  if (!url || !isSupportedUrl(url)) return none;
  const { es, entries } = await currentEntries();
  const d = decideUrl(url, entries);
  const byId = (id: string) => es.config.rules.find((r) => r.id === id);
  // Budgets that apply here, including exhausted ones (those show up as the blocking entry).
  const budgetRules = [...d.budgetRuleIds, ...(d.entry?.cause === 'budget' ? [d.entry.ruleId] : [])]
    .map(byId)
    .filter((r): r is Rule => !!r);
  return {
    supported: true,
    host: hostOf(url),
    action: d.action,
    ruleId: d.entry?.ruleId,
    ruleName: d.entry?.name,
    hiding: d.hideRuleIds.map((id) => byId(id)?.name || 'Hidden elements'),
    budgets: budgetViews(es, budgetRules),
  };
}

const DEFAULT_MESSAGES = [
  'The work you are avoiding is the work that matters. Go back to it.',
  'You decided this earlier, with a clearer head. Trust that decision.',
  'Five minutes of focus now beats an hour of catching up later.',
  'Nothing new happened here since you last checked.',
  'Close the loop on one small task, then decide again.',
  'Your attention is the scarcest thing you own. Spend it on purpose.',
  'Boredom is where good ideas start. Let it sit for a minute.',
  'Future you will thank you for this one.',
];

/** Dedupe attempts: the same rule in the same tab within 3 s counts once. */
const recentAttempts = new Map<string, number>();

const PARENTAL_TEXT: Record<number, string> = {
  [PARENTAL_REASON.known]: 'This site is on the list of adult sites.',
  [PARENTAL_REASON.detectedSite]: 'FocusGuard found adult content on this site.',
  [PARENTAL_REASON.detectedPage]: 'FocusGuard found adult content on this page.',
};

async function parentalInfo(t: number, host: string | undefined, count: boolean, tabId: number | undefined): Promise<BlockInfo> {
  const h = host ? normalizeHost(host) : undefined;
  if (count) {
    const now = Date.now();
    const key = `${tabId}:parental`;
    if (now - (recentAttempts.get(key) ?? 0) > 3000) {
      recentAttempts.set(key, now);
      await updateStats((stats) => {
        const d = (dayRecord(stats, localDateKey(now)).domains[h ?? '(parental filter)'] ??= { active: 0, blocked: 0 });
        d.blocked += 1;
      });
    }
  }
  return {
    found: true,
    ruleName: 'Parental controls',
    site: h ?? 'This site',
    reason: 'parental',
    reasonText: PARENTAL_TEXT[t] ?? PARENTAL_TEXT[0],
    unblockAt: null,
    message: 'If you think this is a mistake, ask a parent or guardian.',
    image: null,
    parentalHost: t === PARENTAL_REASON.known ? undefined : h,
  };
}

async function blockInfo(ruleId: string, t: number, count: boolean, tabId: number | undefined, host?: string): Promise<BlockInfo> {
  if (ruleId === PARENTAL_RULE_ID) return parentalInfo(t, host, count, tabId);
  const { es, entries } = await currentEntries();
  const { config, runtime, now } = es;
  const rule = config.rules.find((r) => r.id === ruleId);
  const lock = ruleId.startsWith('lock:') ? runtime.locks.find((l) => `lock:${l.id}` === ruleId) : undefined;
  const targets = rule ? expandTargets(rule.targets, config.groups) : lock ? expandTargets(lock.targets, config.groups) : [];
  const target = targets[t] ?? targets[0];
  const site = target ? (target.kind === 'domain' ? target.host : targetLabel(target, config.groups)) : 'This site';
  const got = await chrome.storage.local.get('blockImage');
  const message = config.blockPage.message.trim() || DEFAULT_MESSAGES[Math.floor(Math.random() * DEFAULT_MESSAGES.length)];
  const base = { found: !!(rule || lock), ruleName: rule?.name || (lock ? 'Hard Lock' : 'Rule'), site, message, image: (got.blockImage as string) ?? null };

  if (count && target) {
    const key = `${tabId}:${ruleId}`;
    if (now - (recentAttempts.get(key) ?? 0) > 3000) {
      recentAttempts.set(key, now);
      const host = targetHost(target);
      await updateStats((stats) => {
        const day = dayRecord(stats, localDateKey(now));
        const d = (day.domains[host] ??= { active: 0, blocked: 0 });
        d.blocked += 1;
      });
    }
  }

  const entry = entries.find((e) => e.ruleId === ruleId && (e.kind === 'block' || e.kind === 'redirect'));
  if (!entry) return { ...base, reason: 'inactive', reasonText: 'This rule is not blocking right now.', unblockAt: null };
  const unblockAt = ruleUnblockAt(ruleId, es);
  const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (entry.locked) {
    return { ...base, reason: 'lock', reasonText: `A Hard Lock is active${unblockAt ? ` until ${clock(unblockAt)}` : ''}. It cannot be cancelled.`, unblockAt };
  }
  if (rule && rule.action.kind === 'budget' && isBudgetExhausted(rule, es)) {
    return { ...base, reason: 'budget', reasonText: `You used your ${rule.action.minutesPerDay}-minute daily budget. It resets at ${clock(nextBudgetReset(now, config.settings.resetTime))}.`, unblockAt };
  }
  if (rule?.onlyDuringFocus && ruleNormallyActive(rule, es)) {
    return { ...base, reason: 'focus', reasonText: 'You are in a focus interval. This site opens at your next break.', unblockAt };
  }
  if (rule?.schedule) {
    return { ...base, reason: 'schedule', reasonText: `Blocked on a schedule: ${describeSchedule(rule.schedule)}.`, unblockAt };
  }
  return { ...base, reason: 'always', reasonText: `Blocked by your rule “${base.ruleName}”.`, unblockAt };
}

async function startPicker(tabId: number): Promise<{ ok: boolean; message?: string }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || !isSupportedUrl(tab.url)) return { ok: false, message: 'FocusGuard cannot hide elements on this page.' };
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['picker.js'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: `Could not start the picker: ${String(err)}` };
  }
}

async function pickerAdd(host: string, selector: string) {
  const h = normalizeHost(host);
  const sel = selector.trim();
  if (!h || !sel || sel.length > 500) return { ok: false as const, error: 'invalid' as const, message: 'That selector is not valid.' };
  const { es } = await currentEntries();
  const existing = es.config.rules.find(
    (r) =>
      !r.allow &&
      r.action.kind === 'hide' &&
      !r.action.presetId &&
      r.targets.length === 1 &&
      r.targets[0].kind === 'domain' &&
      r.targets[0].host === h,
  );
  const rule: Rule =
    existing && existing.action.kind === 'hide'
      ? { ...existing, enabled: true, action: { ...existing.action, selectors: [...new Set([...existing.action.selectors, sel])] } }
      : {
          id: newId(),
          name: `Hidden on ${h}`,
          targets: [{ kind: 'domain', host: h, includeSubdomains: true }],
          action: { kind: 'hide', selectors: [sel] },
          enabled: true,
          createdAt: Date.now(),
        };
  return applyChange({ kind: 'rule.upsert', rule });
}

async function openOptions(section?: string): Promise<{ ok: true }> {
  const base = chrome.runtime.getURL('options.html');
  const url = section ? `${base}#${section}` : base;
  const [tab] = await chrome.tabs.query({ url: `${base}*` });
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { url, active: true });
    if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  return { ok: true };
}

export async function handle(req: Request, sender: chrome.runtime.MessageSender): Promise<ResponseMap[Request['type']]> {
  switch (req.type) {
    case 'getState':
      return snapshot();
    case 'applyChange':
      return applyChange(req.change, req.proof);
    case 'requestChallenge':
      return requestChallenge(req.mode === 'delay' ? 'delay' : 'type');
    case 'tabStatus':
      return tabStatus(req.tabId);
    case 'blockInfo':
      return blockInfo(String(req.ruleId), Number(req.targetIndex) || 0, !!req.count, sender.tab?.id, req.host ? String(req.host) : undefined);
    case 'startPicker':
      return startPicker(req.tabId);
    case 'pickerAdd':
      return pickerAdd(String(req.host), String(req.selector));
    case 'deleteStats':
      await chrome.storage.local.remove('stats');
      return { ok: true };
    case 'openOptions':
      return openOptions(req.section);
    case 'parentalVerdict':
      return parentalVerdict(req.verdict, sender);
    case 'classifyImages':
      return classifyImages(req.urls);
  }
}

/** The parental content script found an explicit page: learn the site (scope 'site') and block the tab. */
async function parentalVerdict(v: PageVerdict, sender: chrome.runtime.MessageSender): Promise<{ blocked: boolean }> {
  const { es } = await currentEntries();
  const p = es.config.parental;
  const tabId = sender.tab?.id;
  const url = sender.tab?.url ?? sender.url;
  const host = url ? hostOf(url) : null;
  if (!v?.explicit || !p.enabled || (!p.detectPages && v.source !== 'images') || tabId === undefined || !host) return { blocked: false };
  if (v.source === 'images' && !p.scanImages) return { blocked: false };
  if (isAllowedHost(host, p.allowedSites)) return { blocked: false };
  const site = p.detectScope === 'site';
  if (site) await recordDetection(host, Number(v.score) || 0, v.source);
  const path = parentalBlockPath(site ? PARENTAL_REASON.detectedSite : PARENTAL_REASON.detectedPage, host);
  await chrome.tabs.update(tabId, { url: chrome.runtime.getURL(path.slice(1)) }).catch(() => undefined);
  return { blocked: true };
}

/** Forward image URLs to the offscreen classifier. */
async function classifyImages(urls: string[]): Promise<{ results: OffscreenClassifyResponse['results'] | null }> {
  const { es } = await currentEntries();
  const p = es.config.parental;
  if (!p.enabled || !p.scanImages) return { results: null };
  const list = (Array.isArray(urls) ? urls : []).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u)).slice(0, 16);
  if (!list.length) return { results: [] };
  await syncOffscreen(true);
  try {
    const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type: 'classify', urls: list })) as OffscreenClassifyResponse | undefined;
    if (!res || res.error) return { results: null };
    return { results: res.results };
  } catch {
    return { results: null };
  }
}
