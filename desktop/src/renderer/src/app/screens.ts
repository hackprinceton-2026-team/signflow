import type { IconName } from '../ui';

export type ScreenId = 'live' | 'workspace' | 'notes' | 'settings';

export interface ScreenMeta {
  id: ScreenId;
  label: string;
  icon: IconName;
  title: string;
  subtitle: string;
  /** Keyboard shortcut (see app/shortcuts.ts). */
  shortcut: string;
}

export const SCREENS: Record<ScreenId, ScreenMeta> = {
  live: {
    id: 'live',
    label: 'Live',
    icon: 'live',
    title: 'Live',
    subtitle: 'Sign naturally. Nothing is spoken or saved until you confirm.',
    shortcut: 'Mod+1',
  },
  workspace: {
    id: 'workspace',
    label: 'Workspace',
    icon: 'workspace',
    title: 'Workspace',
    subtitle: 'Recognition details, conversation history, and playback.',
    shortcut: 'Mod+2',
  },
  notes: {
    id: 'notes',
    label: 'Notes',
    icon: 'notes',
    title: 'Notes',
    subtitle: 'Confirmed sentences, captured as you sign.',
    shortcut: 'Mod+3',
  },
  settings: {
    id: 'settings',
    label: 'Settings',
    icon: 'settings',
    title: 'Settings',
    subtitle: 'Camera, recognition, speech, captions, and notes.',
    shortcut: 'Mod+,',
  },
};

export const PRIMARY_SCREENS: ScreenId[] = ['live', 'workspace', 'notes'];
