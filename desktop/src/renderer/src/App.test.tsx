import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { installFakeBridge } from './test/setup';
import { FakeRecognizer, installFakeMediaDevices } from './test/fakes';
import { MockTranslator } from './adapters/mock/mockTranslator';
import { MockSpeechEngine } from './adapters/speech';
import type { SpeechEngine } from './adapters/types';

class UnavailableSpeech extends MockSpeechEngine {
  override readonly available = false;
}

function renderApp(opts: { speech?: SpeechEngine } = {}) {
  installFakeBridge();
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const speech = opts.speech ?? new MockSpeechEngine();
  const adapters = { recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech };
  render(<App adapters={adapters} initialSettings={{ pauseMs: 30 }} />);
  return { recognizer, adapters, speech: speech as MockSpeechEngine };
}

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const go = (label: 'Live' | 'Workspace' | 'Notes' | 'Settings') => fireEvent.click(nav().getByRole('button', { name: label }));

async function startCamera(recognizer: FakeRecognizer) {
  fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
  await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
}

async function produceDraft(recognizer: FakeRecognizer, glosses: string[]) {
  act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
  await screen.findByTestId('draft-text');
}

beforeEach(() => localStorage.clear());

describe('<App /> shell', () => {
  it('opens on Live with the camera CTA, status, and main navigation', () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'SignFlow', level: 1 })).toBeInTheDocument();
    expect(nav().getByRole('button', { name: 'Live' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Live', level: 2 })).toBeInTheDocument();
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
    expect(screen.getByTestId('status-camera')).toHaveTextContent('Camera off');
  });

  it('navigates between Live, Workspace, Notes, and Settings', () => {
    renderApp();
    go('Workspace');
    expect(nav().getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('heading', { name: 'Live signs' })).toBeInTheDocument();
    go('Notes');
    expect(screen.getByLabelText('Note title')).toBeInTheDocument();
    go('Settings');
    expect(screen.getByRole('heading', { name: 'Recognition' })).toBeInTheDocument();
    go('Live');
    expect(screen.getByText('Camera is off')).toBeInTheDocument();
  });

  it('shows app info from the preload bridge in Settings › About', async () => {
    renderApp();
    go('Settings');
    expect(await screen.findByText(/SignFlow v0\.1\.0-test/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for the official backend schema')).toBeInTheDocument();
  });
});

describe('<App /> Live: camera → signs → draft', () => {
  it('camera on → recognizer runs → signs stream over the camera → draft appears', async () => {
    const { recognizer } = renderApp();
    await startCamera(recognizer);
    expect(await screen.findByRole('button', { name: 'Stop camera' })).toBeInTheDocument();
    expect(await screen.findByTestId('recognizer-status')).toHaveTextContent('Recognizing');
    expect(screen.getByTestId('status-camera')).toHaveTextContent('Camera on');

    act(() => {
      recognizer.emit('HELLO', 0.95);
      recognizer.emit('NICE', 0.9);
      recognizer.emit('MEET', 0.87);
      recognizer.emit('YOU', 0.93);
    });
    expect(screen.getAllByTestId('sign-chip')).toHaveLength(4);
    expect(screen.getByRole('meter', { name: 'MEET confidence' })).toHaveAttribute('aria-valuenow', '87');

    await waitFor(() => expect(screen.getByTestId('draft-text')).toHaveValue('Hello, nice to meet you.'));

    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(recognizer.stop).toHaveBeenCalled();
  });

  it('recognition keeps running on other screens; the draft follows as a dock', async () => {
    const { recognizer } = renderApp();
    await startCamera(recognizer);
    go('Workspace');
    act(() => {
      recognizer.emit('HOW', 0.9);
      recognizer.emit('UM', 0.3);
    });
    const rows = screen.getAllByTestId('sign-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('low confidence')).toBeInTheDocument();
    act(() => void recognizer.emit('YOU', 0.9));
    expect(await screen.findByTestId('draft-text')).toHaveValue('How are you?');
    expect(screen.getByRole('button', { name: /Confirm/ })).toBeInTheDocument();
  });
});

describe('<App /> confirmation and speech safety', () => {
  it('Confirm commits the (edited) text without speaking by default', async () => {
    const { recognizer, speech } = renderApp();
    await startCamera(recognizer);
    await produceDraft(recognizer, ['HOW', 'YOU']);
    fireEvent.change(screen.getByTestId('draft-text'), { target: { value: 'How are you today?' } });
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));

    expect(speech.spoken).toHaveLength(0);
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Confirmed');

    go('Workspace');
    expect(screen.getByTestId('utterance')).toHaveTextContent('How are you today?');
    expect(screen.getByTestId('utterance')).toHaveTextContent('edited');
  });

  it('Speak confirms first, then speaks exactly the confirmed text', async () => {
    const { recognizer, speech } = renderApp();
    await startCamera(recognizer);
    await produceDraft(recognizer, ['THANK-YOU']);
    fireEvent.change(screen.getByTestId('draft-text'), { target: { value: 'Thank you so much.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));

    expect(speech.spoken.map((s) => s.text)).toEqual(['Thank you so much.']);
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Spoken');
    go('Workspace');
    expect(screen.getByTestId('utterance')).toHaveTextContent('Thank you so much.');
  });

  it('never speaks a draft that was not confirmed (discard)', async () => {
    const { recognizer, speech } = renderApp();
    await startCamera(recognizer);
    await produceDraft(recognizer, ['HELLO']);
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.queryByTestId('draft-text')).not.toBeInTheDocument();
    expect(speech.spoken).toHaveLength(0);
    go('Workspace');
    expect(screen.queryByTestId('utterance')).not.toBeInTheDocument();
  });

  it('"Speak when confirming" (opt-in, persisted) makes Confirm speak', async () => {
    const { recognizer, speech } = renderApp();
    go('Settings');
    fireEvent.click(screen.getByRole('switch', { name: 'Speak when confirming' }));
    expect(JSON.parse(localStorage.getItem('signflow.session') ?? '{}').autoSpeak).toBe(true);
    go('Live');
    await startCamera(recognizer);
    await produceDraft(recognizer, ['HELLO']);
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(speech.spoken.map((s) => s.text)).toEqual(['Hello.']);
  });

  it('without a speech engine, Speak is disabled but Confirm still works', async () => {
    const { recognizer } = renderApp({ speech: new UnavailableSpeech() });
    await startCamera(recognizer);
    await produceDraft(recognizer, ['HELLO']);
    expect(screen.getByRole('button', { name: /^Speak/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Confirmed');
  });
});

describe('<App /> notes capture', () => {
  it('captures confirmed sentences into the open note (silently) and remembers the choice', async () => {
    const { recognizer, speech } = renderApp();
    go('Notes');
    fireEvent.click(screen.getByRole('switch', { name: 'Capture from Live' }));
    expect(localStorage.getItem('signflow.captureNotes')).toBe('true');
    expect(screen.getByText('Capturing to notes')).toBeInTheDocument();

    go('Live');
    await startCamera(recognizer);
    go('Notes');
    await produceDraft(recognizer, ['I', 'NEED', 'HELP']);
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));

    expect((screen.getByTestId('note-body') as HTMLTextAreaElement).value).toContain('I need help.');
    expect(speech.spoken).toHaveLength(0);
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('saved to notes');
  });

  it('migrates the old "notes mode" preference to capture-on', () => {
    localStorage.setItem('signflow.mode', '"notes"');
    renderApp();
    expect(screen.getByText('Capturing to notes')).toBeInTheDocument();
  });
});

describe('<App /> settings persistence', () => {
  it('recognition settings persist (validated) across launches', () => {
    renderApp();
    go('Settings');
    fireEvent.change(screen.getByRole('slider', { name: 'Pause before translating' }), { target: { value: '2400' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Minimum confidence' }), { target: { value: '0.75' } });
    expect(JSON.parse(localStorage.getItem('signflow.session') ?? '{}')).toMatchObject({ pauseMs: 2400, minConfidence: 0.75 });
  });

  it('section navigation marks the current section', () => {
    renderApp();
    go('Settings');
    const sections = within(screen.getByRole('navigation', { name: 'Settings sections' }));
    expect(sections.getByRole('button', { name: 'Camera' })).toHaveAttribute('aria-current', 'location');
    fireEvent.click(sections.getByRole('button', { name: 'Speech' }));
    expect(sections.getByRole('button', { name: 'Speech' })).toHaveAttribute('aria-current', 'location');
    expect(sections.getByRole('button', { name: 'Camera' })).not.toHaveAttribute('aria-current');
  });

  it('mirror preference persists', () => {
    renderApp();
    go('Settings');
    const mirror = screen.getByRole('switch', { name: 'Mirror preview' });
    expect(mirror).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(mirror);
    expect(localStorage.getItem('signflow.mirror')).toBe('false');
  });
});

describe('<App /> floating captions', () => {
  it('the CC toggle opens the overlay and streams confirmed sentences to it', async () => {
    const { recognizer } = renderApp();
    const toggle = screen.getByTestId('captions-toggle');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-pressed', 'true'));
    expect(window.signflow.captions.setVisible).toHaveBeenCalledWith(true);
    expect(toggle).toHaveAccessibleName('Hide floating captions');

    await startCamera(recognizer);
    await produceDraft(recognizer, ['THANK-YOU']);
    expect(window.signflow.captions.update).toHaveBeenLastCalledWith(expect.objectContaining({ live: 'Thank you.' }));
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(window.signflow.captions.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ lines: [expect.objectContaining({ text: 'Thank you.' })], live: '' }),
    );
  });
});
