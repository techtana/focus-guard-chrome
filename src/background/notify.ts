// Notifications (FR-2.3 warning, FR-6.3 interval changes) and the toolbar badge (FR-2.4, FR-6.3).

export function notify(id: string, title: string, message: string): void {
  chrome.notifications.create(
    `fg-${id}-${Date.now()}`,
    { type: 'basic', iconUrl: chrome.runtime.getURL('icons/icon128.png'), title, message, priority: 1 },
    () => void chrome.runtime.lastError,
  );
}

const COLORS = { focus: '#17803d', break: '#1d4ed8', lock: '#c0262d', budget: '#b45309', budgetLow: '#c0262d', pause: '#6b7280' };

export interface BadgeGlobal {
  text: string;
  color: keyof typeof COLORS;
  title: string;
}

let lastGlobal = '';

export async function setGlobalBadge(b: BadgeGlobal | null): Promise<void> {
  const key = b ? `${b.text}|${b.color}|${b.title}` : '';
  if (key === lastGlobal) return;
  lastGlobal = key;
  await chrome.action.setBadgeText({ text: b?.text ?? '' });
  if (b) await chrome.action.setBadgeBackgroundColor({ color: COLORS[b.color] });
  await chrome.action.setTitle({ title: b ? `FocusGuard — ${b.title}` : 'FocusGuard' });
}

/** Per-tab badge with remaining budget minutes; '' clears it so the global badge shows. */
export async function setTabBadge(tabId: number, remainingSec: number | null): Promise<void> {
  try {
    if (remainingSec === null) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      return;
    }
    const min = Math.max(0, Math.ceil(remainingSec / 60));
    await chrome.action.setBadgeText({ tabId, text: `${min}m` });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: remainingSec <= 120 ? COLORS.budgetLow : COLORS.budget });
  } catch {
    // Tab closed.
  }
}
