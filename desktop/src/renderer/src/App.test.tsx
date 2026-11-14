import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { installFakeBridge } from './test/setup';
import { FakeRecognizer, installFakeMediaDevices } from './test/fakes';
import { MockTranslator } from './adapters/mock/mockTranslator';
import { MockSpeechEngine } from './adapters/speech';

function renderApp() {
  installFakeBridge();
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const adapters = { recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech: new MockSpeechEngine() };
  render(<App adapters={adapters} initialSettings={{ pauseMs: 30 }} />);
  return { recognizer, adapters };
}

async function produceDraft(recognizer: FakeRecognizer, glosses: string[]) {
  fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
  await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
  act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
  await screen.findByTestId('draft-text');
}

beforeEach(() => localStorage.clear());

describe('<App />', () => {
  it('renders the shell and app info from the preload bridge', async () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'SignFlow' })).toBeInTheDocument();
    expect(await screen.findByText(/SignFlow v0\.1\.0-test/)).toBeInTheDocument();
  });

  it('camera on → recognizer runs → signs stream → draft appears', async () => {
    const { recognizer } = renderApp();
    expect(screen.getByText('Camera is off')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(await screen.findByRole('button', { name: 'Stop camera' })).toBeInTheDocument();
    await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
    expect(await screen.findByTestId('recognizer-status')).toHaveTextContent('Recognizing');

    act(() => {
      recognizer.emit('HELLO', 0.95);
      recognizer.emit('NICE', 0.9);
      recognizer.emit('MEET', 0.87);
      recognizer.emit('YOU', 0.93);
    });
    expect(screen.getAllByTestId('sign-row')).toHaveLength(4);
    expect(within(screen.getByTestId('phrase-buffer')).getByText('MEET')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('draft-text')).toHaveValue('Hello, nice to meet you.'));

    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(recognizer.stop).toHaveBeenCalled();
  });
});

describe('<App /> draft confirmation + speech', () => {
  it('edit → confirm speaks the sentence and adds it to the conversation', async () => {
    const { recognizer, adapters } = renderApp();
    await produceDraft(recognizer, ['HOW', 'YOU']);
    fireEvent.change(screen.getByTestId('draft-text'), { target: { value: 'How are you today?' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm & speak/ }));

    expect(adapters.speech.spoken.at(-1)?.text).toBe('How are you today?');
    expect(screen.getByTestId('utterance')).toHaveTextContent('How are you today?');
    expect(screen.getByTestId('utterance')).toHaveTextContent('edited');
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
  });

  it('with auto-speak off, confirming does not speak', async () => {
    const { recognizer, adapters } = renderApp();
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-speak/ }));
    await produceDraft(recognizer, ['THANK-YOU']);
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(adapters.speech.spoken).toHaveLength(0);
    expect(screen.getByTestId('utterance')).toHaveTextContent('Thank you.');
  });

  it('discarding drops the draft without speaking', async () => {
    const { recognizer, adapters } = renderApp();
    await produceDraft(recognizer, ['HELLO']);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    expect(screen.queryByTestId('utterance')).not.toBeInTheDocument();
    expect(adapters.speech.spoken).toHaveLength(0);
  });
});

describe('<App /> notes mode', () => {
  it('confirmed sentences go into notes silently; mode is remembered', async () => {
    const { recognizer, adapters } = renderApp();
    fireEvent.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('heading', { name: 'Text to speech' })).not.toBeInTheDocument();

    await produceDraft(recognizer, ['I', 'NEED', 'HELP']);
    fireEvent.click(screen.getByRole('button', { name: /Add to notes/ }));

    expect((screen.getByTestId('note-body') as HTMLTextAreaElement).value).toContain('I need help.');
    expect(adapters.speech.spoken).toHaveLength(0);
    expect(localStorage.getItem('signflow.mode')).toBe('"notes"');
  });

  it('arrow keys switch modes', () => {
    renderApp();
    const tab = screen.getByRole('tab', { name: 'Conversation' });
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Notes' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('<App /> floating captions', () => {
  it('CC toggles the overlay and streams confirmed sentences to it', async () => {
    const { recognizer } = renderApp();
    const toggle = screen.getByTestId('captions-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    expect(window.signflow.captions.setVisible).toHaveBeenCalledWith(true);
    expect(screen.getByRole('button', { name: 'Hide captions' })).toBeInTheDocument();

    await produceDraft(recognizer, ['THANK-YOU']);
    expect(window.signflow.captions.update).toHaveBeenLastCalledWith(expect.objectContaining({ live: 'Thank you.' }));
    fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
    expect(window.signflow.captions.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ lines: [expect.objectContaining({ text: 'Thank you.' })], live: '' }),
    );
  });
});
