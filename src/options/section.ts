// Contract between the options shell (options.ts) and its sections
// (options/sections/*.ts). Each section module default-exports a Section.

import type { Snapshot } from '../shared/messages.ts';

export interface SectionCtx {
  /** Re-fetch the snapshot and re-render the current section. */
  refresh(): Promise<void>;
  /** setInterval that the shell clears when the section re-renders or is left. */
  every(ms: number, fn: () => void): void;
  /** Mark the section as having unsaved edits; while dirty the shell will not re-render it on state changes. */
  setDirty(dirty: boolean): void;
  /** Navigate to another section, e.g. ctx.go('lock'). */
  go(sectionId: string): void;
}

export interface Section {
  id: string;
  title: string;
  /** Render into `root` (already empty). Called on show and after every state change while not dirty. */
  render(root: HTMLElement, snap: Snapshot, ctx: SectionCtx): void;
}
