import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { installFakeBridge } from '../test/setup';
import { FakeRecognizer, FakeRecognizerBridge, installFakeMediaDevices } from '../test/fakes';
import { createFakeBackend } from '../test/fakeBackend';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import { MockSpeechEngine } from '../adapters/speech';

function renderApp(backend = createFakeBackend(), bridge = new FakeRecognizerBridge()) {
  installFakeBridge({ recognizer: bridge });
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const system = new MockSpeechEngine(5);
  render(
    <App
      adapters={{ recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech: system }}
      initialSettings={{ pauseMs: 30 }}
      backendClient={backend.client}
    />,
  );
  return { backend, recognizer, system, bridge };
}

const mode = (label: 'Words' | 'Sentence (Gemini)' | 'Review') =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: label }));
const spoken = (system: MockSpeechEngine) => system.spoken.map((s) => s.text);

async function startCamera(recognizer: FakeRecognizer) {
  fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
  await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
}

beforeEach(() => localStorage.clear());

describe('Live modes', () => {
  it('Review stays the default; the mode is remembered', () => {
    renderApp();
    expect(within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: 'Review' })).toHaveAttribute('aria-checked', 'true');
    mode('Words');
    expect(localStorage.getItem('signflow.commMode')).toBe('"words"');
    expect(screen.getByTestId('mode-safety')).toHaveTextContent(/isn.t validated for medical or emergency use/);
  });
});

describe('Words mode (instant, no AI)', () => {
  it('speaks each accepted sign right away; no backend request, no draft, no confirmation', async () => {
    const { backend, recognizer, system } = renderApp();
    mode('Words');
    await startCamera(recognizer);
    act(() => void recognizer.emit('HELP', 0.9));
    expect(spoken(system)).toEqual(['help']);
    expect(screen.getByTestId('words-text')).toHaveTextContent('help');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    act(() => void recognizer.emit('THANK-YOU', 0.95));
    await waitFor(() => expect(spoken(system)).toEqual(['help', 'thank you']));
    expect(screen.queryByTestId('draft-text')).toBeNull();
    expect(backend.calls).toHaveLength(0);
  });

  it('never speaks rejected, uncertain or duplicated signs', async () => {
    const { recognizer, system } = renderApp();
    mode('Words');
    await startCamera(recognizer);
    act(() => {
      recognizer.emit('YES', 0.9, { id: 'yes-1' });
      recognizer.emit('YES', 0.9, { id: 'yes-1' }); // the same sign again
      recognizer.emit('SICK', 0.95, { uncertain: true }); // the model wasn't sure
      recognizer.emit('UM', 0.3); // below the 60% threshold
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(spoken(system)).toEqual(['yes']);
    expect(screen.getByTestId('sign-chip-rejected')).toBeInTheDocument();
  });

  it('shows the measured sign → speech latency, and Stop silences everything queued', async () => {
    const { recognizer, system } = renderApp();
    mode('Words');
    await startCamera(recognizer);
    act(() => void recognizer.emit('HELP', 0.9, { ts: Date.now() - 200 }));
    act(() => {
      recognizer.emit('DOCTOR', 0.9); // arrive while "help" is being spoken
      recognizer.emit('PLEASE', 0.9);
    });
    expect(screen.getByTestId('words-latency')).toHaveTextContent(/\d+ ms sign → speech/);
    expect(screen.getByTestId('words-queued')).toHaveTextContent('Next: doctor please');
    fireEvent.click(screen.getByTestId('realtime-stop'));
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(spoken(system)).toEqual(['help']);
  });
});

describe('Sentence mode (Gemini composes, spoken automatically)', () => {
  it('sends the signed glosses to Gemini through the backend and speaks its sentence without a Confirm', async () => {
    const backend = createFakeBackend({ translate: () => 'I am allergic to penicillin.' });
    const { recognizer, system } = renderApp(backend);
    mode('Sentence (Gemini)');
    await startCamera(recognizer);
    act(() => ['I', 'ALLERGIC', 'PENICILLIN'].forEach((g) => recognizer.emit(g, 0.9)));
    await waitFor(() => expect(spoken(system)).toEqual(['I am allergic to penicillin.']));
    expect(backend.callsTo('/translate').map((c) => c.body)).toEqual([{ raw_signs: ['I', 'ALLERGIC', 'PENICILLIN'], mode: 'chat' }]);
    expect(screen.getByTestId('sentence-source')).toHaveTextContent('Gemini');
    expect(screen.getByTestId('sentence-text')).toHaveTextContent('I am allergic to penicillin.');
    expect(screen.queryByTestId('draft-text')).toBeNull();
  });

  it('uses the Medical context from Settings', async () => {
    const backend = createFakeBackend({ translate: () => 'My head hurts.' });
    const { recognizer } = renderApp(backend);
    mode('Sentence (Gemini)');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Translation context' })).getByRole('radio', { name: 'Medical' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Live' }));
    await startCamera(recognizer);
    act(() => ['HEAD', 'HURT'].forEach((g) => recognizer.emit(g, 0.9)));
    await waitFor(() => expect(backend.callsTo('/translate')).toHaveLength(1));
    expect(backend.callsTo('/translate')[0]!.body).toEqual({ raw_signs: ['HEAD', 'HURT'], mode: 'medical' });
  });

  it('Gemini error (503): speaks the local sentence at once, labelled as a fallback', async () => {
    const { recognizer, system } = renderApp(createFakeBackend({ translateStatus: 503 }));
    mode('Sentence (Gemini)');
    await startCamera(recognizer);
    act(() => ['HELP', 'DOCTOR'].forEach((g) => recognizer.emit(g, 0.9)));
    await waitFor(() => expect(spoken(system)).toEqual(['Help doctor.']));
    expect(screen.getByTestId('sentence-source')).toHaveTextContent('Local fallback');
    expect(screen.getByTestId('sentence-reason')).toHaveTextContent(/Gemini unavailable/);
  });

  it('slow Gemini: Speak now says the local sentence; the late Gemini answer is never spoken', async () => {
    const backend = createFakeBackend({ translateDelayMs: 400, translate: () => 'Could I have some water?' });
    const { recognizer, system } = renderApp(backend);
    mode('Sentence (Gemini)');
    await startCamera(recognizer);
    act(() => void recognizer.emit('WATER', 0.9));
    const speakNow = await screen.findByRole('button', { name: /Speak now/ });
    expect(screen.getByTestId('sentence-status')).toHaveTextContent('Gemini is composing');
    fireEvent.click(speakNow);
    expect(spoken(system)).toEqual(['Water.']);
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(spoken(system)).toEqual(['Water.']);
    expect(screen.getByTestId('sentence-source')).toHaveTextContent('Local (not AI)');
  });

  it('Stop or a mode switch while Gemini is composing: nothing is spoken when it answers', async () => {
    const backend = createFakeBackend({ translateDelayMs: 300 });
    const { recognizer, system } = renderApp(backend);
    mode('Sentence (Gemini)');
    await startCamera(recognizer);
    act(() => void recognizer.emit('HELLO', 0.9));
    await screen.findByRole('button', { name: /Speak now/ });
    fireEvent.click(screen.getByTestId('realtime-stop'));
    await act(() => new Promise((r) => setTimeout(r, 600)));
    expect(spoken(system)).toEqual([]);
    expect(screen.getByTestId('sentence-latest')).toHaveAttribute('data-status', 'stopped');

    act(() => void recognizer.emit('BYE', 0.9));
    await screen.findByRole('button', { name: /Speak now/ });
    mode('Words');
    await act(() => new Promise((r) => setTimeout(r, 600)));
    expect(spoken(system)).toEqual([]);
  });

  it('holds a sentence that adds a detail (here a number) for review instead of auto-speaking it', async () => {
    const backend = createFakeBackend({ translate: () => 'My appointment is tomorrow at 3.' });
    const { recognizer, system } = renderApp(backend);
    mode('Sentence (Gemini)');
    await startCamera(recognizer);
    act(() => ['APPOINTMENT', 'TOMORROW'].forEach((g) => recognizer.emit(g, 0.9)));
    const review = await screen.findByTestId('sentence-review');
    expect(review).toHaveTextContent('Number not signed: 3.');
    expect(spoken(system)).toEqual([]);
    fireEvent.click(within(review).getByRole('button', { name: /Speak Gemini/ }));
    expect(spoken(system)).toEqual(['My appointment is tomorrow at 3.']);
  });

  it('with the ASL recognizer, the sentence ends on its end_of_sentence (or Finish sentence)', async () => {
    const backend = createFakeBackend({ translate: () => 'I need a doctor.' });
    const { system, bridge } = renderApp(backend);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sign recognizer' })).getByRole('radio', { name: 'SignFlow ASL model (local)' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Live' }));
    mode('Sentence (Gemini)');
    fireEvent.click(screen.getByRole('button', { name: 'Start recognition' }));
    await waitFor(() => expect(bridge.listening).toBe(true));
    const ts = Date.now() / 1000;
    act(() => void bridge.send({ type: 'sign', sign: 'HELP', confidence: 0.91, ts }));
    act(() => void bridge.send({ type: 'sign', sign: 'DOCTOR', confidence: 0.84, ts: ts + 0.01 }));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(backend.callsTo('/translate')).toHaveLength(0); // still signing
    expect(screen.getByTestId('sentence-pending')).toHaveTextContent('HELP DOCTOR');
    fireEvent.click(screen.getByRole('button', { name: 'Finish sentence' }));
    await waitFor(() => expect(spoken(system)).toEqual(['I need a doctor.']));
    expect(backend.callsTo('/translate')[0]!.body).toMatchObject({ raw_signs: ['HELP', 'DOCTOR'] });
  });
});

describe('embedded camera preview (from the recognizer, never a second capture)', () => {
  it('shows the recognizer’s frames on the stage and drops them when they stop', async () => {
    const { bridge } = renderApp();
    const media = installFakeMediaDevices();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sign recognizer' })).getByRole('radio', { name: 'SignFlow ASL model (local)' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Live' }));
    mode('Sentence (Gemini)');
    fireEvent.click(screen.getByRole('button', { name: 'Start recognition' }));
    await waitFor(() => expect(bridge.listening).toBe(true));
    expect(screen.queryByTestId('recognizer-preview')).toBeNull(); // plain live.py: external-preview card
    act(() => bridge.sendPreview({ jpeg: '/9j/AAAA', width: 320, height: 180 }));
    const img = screen.getByTestId('recognizer-preview');
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,/9j/AAAA');
    expect(screen.getByTestId('sentence-panel')).toBeInTheDocument(); // glosses and sentence alongside
    expect(media.getUserMedia).not.toHaveBeenCalled();
    await act(() => new Promise((r) => setTimeout(r, 2100)));
    expect(screen.queryByTestId('recognizer-preview')).toBeNull();
  });
});

describe('switching Words → Sentence with the ASL recognizer', () => {
  it('a sentence end from Words mode does not cut the next sentence short', async () => {
    const backend = createFakeBackend({ translate: (g) => g.join(' ') });
    const { bridge } = renderApp(backend);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sign recognizer' })).getByRole('radio', { name: 'SignFlow ASL model (local)' }));
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Live' }));
    mode('Words');
    fireEvent.click(screen.getByRole('button', { name: 'Start recognition' }));
    await waitFor(() => expect(bridge.listening).toBe(true));
    const ts = Date.now() / 1000;
    act(() => {
      bridge.send({ type: 'sign', sign: 'HELP', confidence: 0.9, ts });
      bridge.send({ type: 'end_of_sentence', signs: ['HELP'], ts });
    });
    mode('Sentence (Gemini)');
    act(() => void bridge.send({ type: 'sign', sign: 'I', confidence: 0.9, ts: ts + 0.1 }));
    act(() => void bridge.send({ type: 'sign', sign: 'HUNGRY', confidence: 0.9, ts: ts + 0.2 }));
    await act(() => new Promise((r) => setTimeout(r, 200)));
    expect(backend.callsTo('/translate')).toHaveLength(0);
    act(() => void bridge.send({ type: 'end_of_sentence', signs: ['I', 'HUNGRY'], ts: ts + 0.3 }));
    await waitFor(() => expect(backend.callsTo('/translate')).toHaveLength(1));
    expect(backend.callsTo('/translate')[0]!.body).toMatchObject({ raw_signs: ['I', 'HUNGRY'] });
  });
});

describe('Settings › Camera with the ASL recognizer', () => {
  it('shows the camera the recognizer reports, and how to choose another', async () => {
    const { bridge } = renderApp();
    const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
    fireEvent.click(nav().getByRole('button', { name: 'Settings' }));
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Sign recognizer' })).getByRole('radio', { name: 'SignFlow ASL model (local)' }));
    fireEvent.click(nav().getByRole('button', { name: 'Live' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start recognition' }));
    await waitFor(() => expect(bridge.listening).toBe(true));
    act(() =>
      bridge.setStatus({
        state: 'ready',
        camera: {
          active: 'MacBook Air Camera', index: 1, selection: 'automatic', verified: true, note: 'built-in camera preferred',
          available: [{ name: 'MacBook Air Camera', kind: 'built-in' }, { name: 'iPhone Camera', kind: 'iPhone' }],
        },
      }),
    );
    fireEvent.click(nav().getByRole('button', { name: 'Settings' }));
    const panel = screen.getByTestId('recognizer-camera');
    expect(panel).toHaveTextContent('MacBook Air Camera');
    expect(panel).toHaveTextContent('automatic');
    expect(panel).toHaveTextContent('iPhone Camera (iPhone)');
    expect(panel).toHaveTextContent('--camera-name iPhone');
  });
});
