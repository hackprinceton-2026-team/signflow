import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { installFakeBridge } from '../test/setup';
import { FakeRecognizer, installFakeMediaDevices } from '../test/fakes';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import { MockSpeechEngine } from '../adapters/speech';

// jsdom is not macOS, so "Mod" is Ctrl here.
const press = (key: string, mods: KeyboardEventInit = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key, ...mods });

function renderApp() {
  installFakeBridge();
  let fullScreenListener: (v: boolean) => void = () => undefined;
  window.signflow.view.onFullScreenChange = vi.fn((cb: (v: boolean) => void) => {
    fullScreenListener = cb;
    return () => undefined;
  });
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const speech = new MockSpeechEngine();
  render(<App adapters={{ recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech }} initialSettings={{ pauseMs: 30 }} />);
  return { recognizer, speech, osLeavesFullScreen: () => act(() => fullScreenListener(false)) };
}

async function withDraft(recognizer: FakeRecognizer, glosses = ['HELLO']) {
  fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
  await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
  act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
  await screen.findByTestId('draft-text');
}

const shell = () => document.querySelector('.shell')!;

beforeEach(() => localStorage.clear());

describe('Focus Mode', () => {
  it('hides the chrome, goes fullscreen, and exits with Esc', () => {
    renderApp();
    fireEvent.click(screen.getByTestId('focus-enter'));
    expect(shell()).toHaveAttribute('data-focus', 'true');
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    expect(screen.getByRole('main', { name: 'Focus Mode' })).toBeInTheDocument();
    expect(window.signflow.view.setFullScreen).toHaveBeenCalledWith(true);
    const hint = screen.getAllByRole('status').find((el) => el.classList.contains('focus-hint'));
    // The key name is spoken (sr-only), not just drawn (the <kbd> glyph is aria-hidden).
    expect(within(hint as HTMLElement).getByText('Escape')).toHaveClass('sr-only');
    expect(hint?.querySelector('.ui-kbd')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByTestId('focus-exit')).toHaveAccessibleName(/Exit Focus Mode/);

    press('Escape');
    expect(shell()).not.toHaveAttribute('data-focus');
    expect(window.signflow.view.setFullScreen).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
  });

  it('⌘⇧F toggles it from any screen and always lands on Live', () => {
    renderApp();
    press('2', { ctrlKey: true });
    expect(screen.getByRole('heading', { name: 'Live signs' })).toBeInTheDocument();
    press('F', { ctrlKey: true, shiftKey: true });
    expect(shell()).toHaveAttribute('data-focus', 'true');
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
    press('2', { ctrlKey: true }); // navigation is disabled in Focus Mode
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
    press('F', { ctrlKey: true, shiftKey: true });
    expect(shell()).not.toHaveAttribute('data-focus');
  });

  it('controls fade after the pointer idles and return on movement', () => {
    vi.useFakeTimers();
    renderApp();
    fireEvent.click(screen.getByTestId('focus-enter'));
    expect(shell()).not.toHaveClass('is-idle');
    act(() => vi.advanceTimersByTime(2600));
    expect(shell()).toHaveClass('is-idle');
    fireEvent.pointerMove(window);
    expect(shell()).not.toHaveClass('is-idle');
    press('Escape');
    act(() => vi.advanceTimersByTime(5000));
    expect(shell()).not.toHaveClass('is-idle'); // never idle outside Focus Mode
    vi.useRealTimers();
  });

  it('leaving fullscreen through the OS leaves Focus Mode too', () => {
    const { osLeavesFullScreen } = renderApp();
    fireEvent.click(screen.getByTestId('focus-enter'));
    osLeavesFullScreen();
    expect(shell()).not.toHaveAttribute('data-focus');
  });

  it('the draft stays usable in Focus Mode; Esc in the editor only blurs it', async () => {
    const { recognizer, speech } = renderApp();
    fireEvent.click(screen.getByTestId('focus-enter'));
    await withDraft(recognizer);
    const box = screen.getByTestId('draft-text');
    box.focus();
    press('Escape', {}, box);
    expect(shell()).toHaveAttribute('data-focus', 'true');
    expect(box).not.toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    expect(speech.spoken.map((s) => s.text)).toEqual(['Hello.']);
  });
});

describe('global shortcuts', () => {
  it('⌘1/⌘2/⌘3/⌘, navigate', () => {
    renderApp();
    press('2', { ctrlKey: true });
    expect(screen.getByRole('heading', { level: 2, name: 'Workspace' })).toBeInTheDocument();
    press('3', { ctrlKey: true });
    expect(screen.getByLabelText('Note title')).toBeInTheDocument();
    press(',', { ctrlKey: true });
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
    press('1', { ctrlKey: true });
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
  });

  it('⌘↵ confirms from anywhere, exactly once even inside the editor', async () => {
    const { recognizer, speech } = renderApp();
    await withDraft(recognizer, ['HOW', 'YOU']);
    press('2', { ctrlKey: true });
    const box = screen.getByTestId('draft-text');
    box.focus();
    press('Enter', { ctrlKey: true }, box);
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('utterance')).toHaveLength(1);
    expect(speech.spoken).toHaveLength(0);
  });

  it('⌘⇧↵ speaks the confirmed draft; ⌘⌫ discards (but not while typing)', async () => {
    const { recognizer, speech } = renderApp();
    await withDraft(recognizer, ['THANK-YOU']);
    press('Enter', { ctrlKey: true, shiftKey: true });
    expect(speech.spoken.map((s) => s.text)).toEqual(['Thank you.']);

    act(() => void recognizer.emit('HELLO', 0.9));
    const box = await screen.findByTestId('draft-text');
    box.focus();
    press('Backspace', { ctrlKey: true }, box);
    expect(screen.getByTestId('draft-text')).toBeInTheDocument();
    box.blur();
    press('Backspace', { ctrlKey: true });
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    expect(speech.spoken).toHaveLength(1);
  });

  it('⌘E focuses the draft, bringing it into view from Settings', async () => {
    const { recognizer } = renderApp();
    await withDraft(recognizer);
    press(',', { ctrlKey: true });
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    press('e', { ctrlKey: true });
    await waitFor(() => expect(screen.getByTestId('draft-text')).toHaveFocus());
  });

  it('draft shortcuts do nothing without a draft', () => {
    const { speech } = renderApp();
    press('Enter', { ctrlKey: true });
    press('Enter', { ctrlKey: true, shiftKey: true });
    expect(speech.spoken).toHaveLength(0);
  });

  it('⌘⇧C toggles floating captions', async () => {
    renderApp();
    press('C', { ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(screen.getByTestId('captions-toggle')).toHaveAttribute('aria-pressed', 'true'));
  });

  it('Settings lists every shortcut', () => {
    renderApp();
    press(',', { ctrlKey: true });
    for (const label of ['Confirm draft', 'Confirm and speak draft', 'Edit draft', 'Discard draft', 'Toggle Focus Mode']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
