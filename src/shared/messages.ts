// Runtime message contract between UI pages / content scripts and the service
// worker. The worker owns all state; pages read it with `getState` and change
// it only with `applyChange`. Pages also re-fetch when chrome.storage changes
// (keys `config`, `runtime`), see ui/dom.ts onStateChange().

import type { Change } from './changes.ts';
import type { FocusPhase } from './focus.ts';
import type { CommitmentLevel, Config, ImageScores, PageVerdict, PresetFile, Runtime } from './types.ts';

/** Proof that the commitment gate was passed for one change. Single use. */
export type GateProof =
  | { kind: 'password'; password: string }
  | { kind: 'challenge'; challengeId: string; typed: string }
  | { kind: 'delay'; challengeId: string }
  /** Parental changes: the guardian PIN. */
  | { kind: 'guardian'; pin: string };

export interface ChallengeInfo {
  id: string;
  mode: 'type' | 'delay';
  /** Passage to type (mode 'type'). */
  text?: string;
  /** When the delay alternative may be confirmed (mode 'delay'). */
  readyAt?: number;
  expiresAt: number;
}

export type ApplyResult =
  | { ok: true; id?: string }
  /** The change loosens rules and the level is password/challenge: ask, then resend with `proof`. */
  | { ok: false; error: 'gate'; level: Exclude<CommitmentLevel, 'none'> | 'guardian'; message: string }
  | { ok: false; error: 'locked' | 'forbidden' | 'invalid' | 'wrongProof'; message: string };

export interface BudgetView {
  ruleId: string;
  name: string;
  usedSec: number;
  limitSec: number;
}

/** Everything UI pages render from. Settings never include the password hash. */
export interface Snapshot {
  now: number;
  config: Config & {
    settings: Config['settings'] & { hasPassword: boolean };
    /** pinHash is stripped; hasPin tells whether one is set. */
    parental: Config['parental'] & { hasPin: boolean };
  };
  /** Size of the bundled known-adult-sites list. */
  parentalKnownSites: number;
  /** False when the user has not allowed FocusGuard in Incognito (a parental-mode loophole). */
  incognitoAllowed: boolean;
  runtime: Runtime;
  /** Phase of the running focus session, null when none. */
  focusPhase: FocusPhase | null;
  /** End of the running focus session. */
  focusEndsAt: number | null;
  /** Budget use in the current period for every budget rule. */
  budgets: BudgetView[];
  /** Rule ids currently in force (after schedules, focus, locks, pause). */
  activeRuleIds: string[];
  /** Rule ids forced on by an active Hard Lock. */
  lockedRuleIds: string[];
  /** Redirect rules that fall back to the block page because the target is blocked (FR-7.3). */
  redirectLoopRuleIds: string[];
  presets: PresetFile;
  /** Next budget reset (ms). */
  nextResetAt: number;
}

export interface TabStatus {
  /** False for chrome://, file://, the Web Store and other pages FocusGuard cannot act on. */
  supported: boolean;
  host: string | null;
  action: 'none' | 'allow' | 'block' | 'redirect';
  /** Rule that decided the navigation. */
  ruleId?: string;
  ruleName?: string;
  /** Names of hide rules active on this page. */
  hiding: string[];
  budgets: BudgetView[];
}

export interface BlockInfo {
  found: boolean;
  ruleName: string;
  /** The blocked site, from the rule target (never from the visited URL). */
  site: string;
  reason: 'lock' | 'focus' | 'schedule' | 'budget' | 'always' | 'inactive' | 'parental';
  /** For reason 'parental': the blocked host when known (detected sites), so a guardian can allow it. */
  parentalHost?: string;
  reasonText: string;
  /** When the block lifts, null = no end. */
  unblockAt: number | null;
  /** Custom message, or a default motivational one. */
  message: string;
  /** Custom image as a data: URL, or null. */
  image: string | null;
}

export type Request =
  | { type: 'getState' }
  | { type: 'applyChange'; change: Change; proof?: GateProof }
  | { type: 'requestChallenge'; mode: 'type' | 'delay' }
  | { type: 'tabStatus'; tabId: number }
  /** From the block page. `count` = record a blocked attempt (once per page load). */
  | { type: 'blockInfo'; ruleId: string; targetIndex: number; count: boolean; host?: string }
  /** From the popup: inject the element picker into a tab (FR-5.1). */
  | { type: 'startPicker'; tabId: number }
  /** From the picker: hide `selector` on `host` (tightening, never gated). */
  | { type: 'pickerAdd'; host: string; selector: string }
  /** Delete all insights data (FR-8.4). Does not touch budgets or rules. */
  | { type: 'deleteStats' }
  /** Open the options page at a section, e.g. 'rules', 'lock', 'insights'. */
  | { type: 'openOptions'; section?: string }
  /** Parental content script: verdict for the page it runs in. The worker blocks the tab if explicit. */
  | { type: 'parentalVerdict'; verdict: PageVerdict }
  /** Parental content script: classify images (absolute http(s) URLs, max 16 per call). */
  | { type: 'classifyImages'; urls: string[] };

export interface ResponseMap {
  getState: Snapshot;
  applyChange: ApplyResult;
  requestChallenge: ChallengeInfo;
  tabStatus: TabStatus;
  blockInfo: BlockInfo;
  startPicker: { ok: boolean; message?: string };
  pickerAdd: ApplyResult;
  deleteStats: { ok: true };
  openOptions: { ok: true };
  parentalVerdict: { blocked: boolean };
  /** null when the classifier is off or unavailable. */
  classifyImages: { results: ImageScores[] | null };
}

/** Worker -> offscreen document. The offscreen page answers only messages with target 'offscreen'. */
export interface OffscreenClassifyRequest {
  target: 'offscreen';
  type: 'classify';
  urls: string[];
}
export interface OffscreenClassifyResponse {
  /** One entry per URL that could be fetched and decoded; failures are left out. */
  results: ImageScores[];
  /** Set when the model failed to load. */
  error?: string;
}

export type RequestOf<T extends Request['type']> = Extract<Request, { type: T }>;

/** Send a request to the service worker and await its typed response. */
export async function send<T extends Request['type']>(req: RequestOf<T>): Promise<ResponseMap[T]> {
  const res = await chrome.runtime.sendMessage(req);
  if (res && typeof res === 'object' && 'fatal' in res) throw new Error(String((res as { fatal: string }).fatal));
  return res as ResponseMap[T];
}
