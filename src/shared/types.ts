// FocusGuard data model. Follows the PRD's "Data model" section, with the few
// fields the PRD left implicit (names, lock targets, lock schedules, pause).

/** A host is stored lowercase, punycode, without a leading "www.". */
export type Target =
  | { kind: 'domain'; host: string; includeSubdomains: boolean }
  /** `url` = host + path (+ query), no scheme, e.g. "youtube.com/shorts". Matches the host and its subdomains. */
  | { kind: 'prefix'; url: string }
  /** `url` = host + path (+ query), no scheme. Trailing slash and fragment are ignored. */
  | { kind: 'exact'; url: string }
  | { kind: 'group'; groupId: string };

/** A target after group expansion: never `group`. */
export type PlainTarget = Exclude<Target, { kind: 'group' }>;

export type Action =
  | { kind: 'block' }
  | { kind: 'redirect'; url: string }
  /** `selectors` are custom CSS selectors; `presetId` + `presetOptions` pull selectors from presets.json. */
  | { kind: 'hide'; selectors: string[]; presetId?: string; presetOptions?: string[] }
  | { kind: 'budget'; minutesPerDay: number };

export type ActionKind = Action['kind'];

export interface TimeWindow {
  /** 'HH:mm' local time. */
  start: string;
  /** 'HH:mm' local time; '24:00' allowed. end <= start means the window runs past midnight. */
  end: string;
}

export interface Schedule {
  /** 0 = Sunday ... 6 = Saturday. */
  days: number[];
  /** Empty = all day on the listed days. */
  windows: TimeWindow[];
}

export interface Rule {
  id: string;
  name?: string;
  targets: Target[];
  /** Ignored when `allow` is true. */
  action: Action;
  /** Absent = always active. */
  schedule?: Schedule;
  /** Active only during focus-session work intervals. This is the "focus list". */
  onlyDuringFocus?: boolean;
  /** Allowlist exception (FR-1.5): overrides less specific block/redirect/hide/budget rules. */
  allow?: boolean;
  enabled: boolean;
  createdAt: number;
}

export interface Group {
  id: string;
  name: string;
  /** Plain targets only; groups do not nest. */
  targets: PlainTarget[];
}

export interface HardLock {
  id: string;
  /** Existing rules that are forced active and cannot be loosened until endsAt. */
  ruleIds: string[];
  /** Extra sites blocked only by this lock. */
  targets: Target[];
  startedAt: number;
  endsAt: number;
  /** Set when a recurring lock schedule started this lock. */
  scheduleId?: string;
}

/** A recurring Hard Lock (FR-3.1 "optionally recurring days"). */
export interface LockSchedule {
  id: string;
  name?: string;
  days: number[];
  /** 'HH:mm' local start time. */
  start: string;
  durationMin: number;
  ruleIds: string[];
  targets: Target[];
  enabled: boolean;
}

export interface FocusConfig {
  workMin: number;
  breakMin: number;
  longBreakMin: number;
  cycles: number;
}

export interface FocusSession extends FocusConfig {
  /** Snapshot of the focus-list rule ids when the session started (informational). */
  ruleIds: string[];
  startedAt: number;
  /** Index of the last phase the worker announced; used to notify on phase changes. */
  lastPhaseIndex?: number;
}

export type CommitmentLevel = 'none' | 'password' | 'challenge';

export interface Settings {
  commitment: CommitmentLevel;
  /** 'pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>'. Never sent to UI pages. */
  passwordHash?: string;
  /** Characters to type for the Challenge. Default 300. */
  challengeLength: number;
  /** Accessible alternative to typing: wait this many minutes instead. Default 5. */
  challengeDelayMin: number;
  /** 'HH:mm', default '00:00'. Daily budgets reset at this local time. */
  resetTime: string;
  /** Seconds without input before the user counts as idle. Default 60, min 15. */
  idleSeconds: number;
  /** Opened by Chrome when the extension is removed (accountability page). '' = none. */
  uninstallUrl: string;
  /** Estimated minutes saved per blocked visit, for "time saved". Default 3. */
  minutesPerBlockedAttempt: number;
}

export interface BlockPageConfig {
  /** Custom message; '' = rotate the default motivational messages. */
  message: string;
  /** True when a custom image is stored under the `blockImage` storage key. */
  hasImage: boolean;
}

export type Category = 'social' | 'video' | 'news' | 'shopping' | 'work' | 'ai' | 'other';

/** User-editable configuration. Stored under storage key `config`. */
export interface Config {
  schemaVersion: 1;
  rules: Rule[];
  groups: Group[];
  settings: Settings;
  focusConfig: FocusConfig;
  lockSchedules: LockSchedule[];
  blockPage: BlockPageConfig;
  /** domain -> category, overriding the built-in map. */
  categoryOverrides: Record<string, Category>;
  onboarded: boolean;
}

export interface BudgetState {
  /** Budget period key: 'YYYY-MM-DD' of the local date the current period started (see resetTime). */
  period: string;
  /** ruleId -> seconds used in this period. */
  used: Record<string, number>;
  /** ruleIds already warned at 2 minutes left in this period. */
  warned: string[];
}

/** Worker-owned state. Stored under storage key `runtime`. */
export interface Runtime {
  locks: HardLock[];
  focus: FocusSession | null;
  /** All non-locked rules are off until this time. null = not paused. Infinity is not allowed; use a far date. */
  pausedUntil: number | null;
  budget: BudgetState;
}

export interface DomainDay {
  /** Active seconds. */
  active: number;
  /** Blocked attempts. */
  blocked: number;
}

/** One local calendar day of usage. Only domains, durations and counts (privacy NFR). */
export interface DayRecord {
  date: string;
  domains: Record<string, DomainDay>;
  focusSeconds: number;
  /** ruleId -> budget limit and use for that day, for "time saved". */
  budgets: Record<string, { name: string; limit: number; used: number }>;
}

/** Stored under storage key `stats`: date -> DayRecord. Kept for 120 days. */
export type StatsStore = Record<string, DayRecord>;

// ---- Element-hiding presets (presets/presets.json, FR-5.2 / FR-5.4) ----

export interface PresetOption {
  id: string;
  label: string;
  selectors: string[];
}

export interface Preset {
  id: string;
  name: string;
  /** Hosts this preset is for, e.g. ["youtube.com"]. Rules created from a preset target these domains. */
  sites: string[];
  options: PresetOption[];
}

export interface PresetFile {
  /** Bumped whenever selectors change. */
  version: number;
  updated: string;
  presets: Preset[];
}

// ---- Content-script hide index (storage key `hideIndex`) ----

export interface HideEntry {
  targets: PlainTarget[];
  /** Priority per target, same order as targets. */
  priorities: number[];
  selectors: string[];
}

export interface AllowEntry {
  targets: PlainTarget[];
  priorities: number[];
}

export interface HideIndex {
  /** Changes every recompute that changes the index. */
  rev: number;
  hide: HideEntry[];
  allow: AllowEntry[];
}
