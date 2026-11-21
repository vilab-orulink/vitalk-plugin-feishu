// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  buildModifierPreviewHotkey,
  buildPluginHotkeyFromKeyboardEvent,
  detectHotkeyPlatform,
  formatHotkeyParts,
  formatHotkeyText,
} from './hotkeys';

describe('hotkey formatting and capture helpers', () => {
  it('formats ViTalk canonical modifier tokens per platform', () => {
    expect(formatHotkeyParts('CommandOrControl+Alt+U', 'windows')).toEqual(['Ctrl', 'Alt', 'U']);
    expect(formatHotkeyParts('CommandOrControl+Alt+U', 'macos')).toEqual(['Cmd', 'Option', 'U']);
    expect(formatHotkeyParts('CommandOrControl+Super+Space', 'windows')).toEqual(['Ctrl', 'Win', 'Space']);
    expect(formatHotkeyParts('Alt+Ctrl+K', 'macos')).toEqual(['Option', 'Control', 'K']);
    expect(formatHotkeyText('CommandOrControl+U', 'windows')).toBe('Ctrl+U');
    expect(formatHotkeyText('CommandOrControl+U', 'macos')).toBe('Cmd+U');
  });

  it('builds ViTalk-compatible plugin accelerators from keyboard events and rejects incomplete combos', () => {
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: 'KeyU', key: 'u' },
        'windows',
      ),
    ).toBe('CommandOrControl+U');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: 'F8', key: 'F8' },
        'windows',
      ),
    ).toBe('CommandOrControl+Alt+F8');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: false, altKey: false, shiftKey: false, metaKey: true, code: 'Space', key: ' ' },
        'macos',
      ),
    ).toBe('CommandOrControl+Space');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: true, altKey: false, shiftKey: true, metaKey: false, code: 'ArrowUp', key: 'ArrowUp' },
        'linux',
      ),
    ).toBe('CommandOrControl+Shift+Up');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: false, altKey: true, shiftKey: false, metaKey: false, code: 'Semicolon', key: ';' },
        'windows',
      ),
    ).toBe('Alt+;');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, code: 'KeyU', key: 'u' },
        'windows',
      ),
    ).toBe('');
    expect(
      buildPluginHotkeyFromKeyboardEvent(
        { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false, code: 'ControlLeft', key: 'Control' },
        'windows',
      ),
    ).toBe('');
  });

  it('builds live modifier-only preview chords while modifier keys are held', () => {
    expect(buildModifierPreviewHotkey(new Set(['ControlLeft', 'AltLeft']), 'windows')).toBe(
      'CommandOrControl+Alt',
    );
    expect(buildModifierPreviewHotkey(new Set(['MetaLeft', 'ShiftLeft']), 'macos')).toBe(
      'Shift+CommandOrControl',
    );
    expect(buildModifierPreviewHotkey(new Set(), 'windows')).toBeNull();
  });

  it('detects platform safely from navigator', () => {
    expect(['macos', 'windows', 'linux']).toContain(detectHotkeyPlatform());
  });
});
