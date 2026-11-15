import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { installFakeBridge } from '../test/setup';
import { FakeKokoro, FakeRecognizer, installFakeMediaDevices } from '../test/fakes';
import { createFakeBackend } from '../test/fakeBackend';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import { MockSpeechEngine } from '../adapters/speech';
import { TEST_PHRASE } from '../components/SpeechSettings';
import type { KokoroStatus } from '@shared/kokoro';

function renderApp(kokoro = new FakeKokoro(), backend = createFakeBackend()) {
  installFakeBridge({ kokoro });
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const system = new MockSpeechEngine();
  const fetchSpy = vi.spyOn(globalThis, 'fetch');
  const utils = render(
    <App
      adapters={{ recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech: system }}
      initialSettings={{ pauseMs: 30 }}
      backendClient={backend.client}
    />,
  );
  return { kokoro, backend, recognizer, system, fetchSpy, ...utils };
}

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const go = (label: string) => fireEvent.click(nav().getByRole('button', { name: label }));
const radio = (group: string, option: string) =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }));
const KOKORO = 'Kokoro — Local Neural Voice';

async function chooseKokoro() {
  go('Settings');
  radio('Speech engine', KOKORO);
  await screen.findByTestId('kokoro-panel');
}

async function draft(recognizer: FakeRecognizer, glosses: string[]) {
  if (screen.queryByRole('button', { name: 'Start camera' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
  }
  act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
  return screen.findByTestId('draft-text');
}

beforeEach(() => localStorage.clear());

describe('Kokoro speech engine in the app', () => {
  it('is off by default; choosing it loads the model and is remembered', async () => {
    const kokoro = new FakeKokoro({ state: 'installed' });
    kokoro.prepareResult = { state: 'ready', loadMs: 1300 };
    const first = renderApp(kokoro);
    go('Settings');
    expect(within(screen.getByRole('radiogroup', { name: 'Speech engine' })).getByRole('radio', { name: 'System voice' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(kokoro.prepare).not.toHaveBeenCalled();

    radio('Speech engine', KOKORO);
    await waitFor(() => expect(kokoro.prepare).toHaveBeenCalled());
    expect(await screen.findByTestId('kokoro-status')).toHaveTextContent('Ready · loaded in 1.3 s');
    expect(localStorage.getItem('signflow.speechEngine')).toBe('"kokoro"');
    first.unmount();

    renderApp(new FakeKokoro());
    go('Settings');
    expect(within(screen.getByRole('radiogroup', { name: 'Speech engine' })).getByRole('radio', { name: KOKORO })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('switching back to the system voice frees Kokoro; choosing it again reloads it', async () => {
    const { kokoro, system } = renderApp();
    await chooseKokoro();
    await waitFor(() => expect(kokoro.prepare).toHaveBeenCalledTimes(1));
    expect(kokoro.release).not.toHaveBeenCalled();
    radio('Speech engine', 'System voice');
    await waitFor(() => expect(kokoro.release).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(system.spoken.map((s) => s.text)).toEqual([TEST_PHRASE]);
    expect(kokoro.synthesize).not.toHaveBeenCalled();
    radio('Speech engine', KOKORO);
    await waitFor(() => expect(kokoro.prepare).toHaveBeenCalledTimes(2));
    expect(kokoro.release).toHaveBeenCalledTimes(1);
  });

  it('voice selection is applied to Test voice and persisted', async () => {
    const { kokoro, unmount } = renderApp();
    await chooseKokoro();
    radio('Kokoro voice', 'Michael');
    expect(screen.getByTestId('kokoro-voice-detail')).toHaveTextContent('Michael: US English, male');
    fireEvent.change(screen.getByRole('slider', { name: 'Rate' }), { target: { value: '1.2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(kokoro.requests).toEqual([{ id: expect.any(String), text: TEST_PHRASE, voice: 'am_michael', speed: 1.2 }]);
    expect(JSON.parse(localStorage.getItem('signflow.speech') ?? '{}')).toMatchObject({ kokoroVoiceId: 'am_michael', rate: 1.2 });
    unmount();

    renderApp();
    go('Settings');
    expect(within(screen.getByRole('radiogroup', { name: 'Kokoro voice' })).getByRole('radio', { name: 'Michael' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  it('only confirmed text is spoken: drafts, edits and discards never reach Kokoro', async () => {
    const { kokoro, recognizer, system } = renderApp();
    await chooseKokoro();
    go('Live');
    const text = await draft(recognizer, ['HOW', 'YOU']);
    fireEvent.change(text, { target: { value: 'How are you today?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(kokoro.synthesize).not.toHaveBeenCalled();

    const next = await draft(recognizer, ['THANK-YOU']);
    fireEvent.change(next, { target: { value: 'I am allergic to penicillin.' } });
    expect(kokoro.synthesize).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ })); // autoSpeak is off: confirm alone is silent
    expect(kokoro.synthesize).not.toHaveBeenCalled();

    const third = await draft(recognizer, ['HELLO']);
    fireEvent.change(third, { target: { value: 'I have never smoked.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(kokoro.requests.map((r) => r.text)).toEqual(['I have never smoked.']));
    expect(system.spoken).toHaveLength(0);
  });

  it('makes no network request: no backend call and no fetch at all in demo mode', async () => {
    const { kokoro, backend, recognizer, fetchSpy } = renderApp();
    kokoro.autoRespond = true;
    await chooseKokoro();
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    go('Live');
    const text = await draft(recognizer, ['HELLO']);
    fireEvent.change(text, { target: { value: 'My doctor’s appointment is tomorrow at three.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(kokoro.requests).toHaveLength(2));
    expect(backend.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('model missing: explains how to install, and Test voice falls back to the system voice with a notice', async () => {
    const { system } = renderApp(new FakeKokoro({ state: 'missing', message: 'The Kokoro voice model is not installed.' }));
    await chooseKokoro();
    expect(screen.getByTestId('kokoro-status')).toHaveTextContent('Not installed');
    expect(screen.getByTestId('kokoro-hint')).toHaveTextContent('cd desktop && npm run kokoro:install');
    expect(screen.getByTestId('voice-in-use')).toHaveTextContent("Kokoro isn't installed yet, so the macOS voice will speak.");
    expect(screen.getByRole('combobox', { name: 'Fallback voice' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(system.spoken.map((s) => s.text)).toEqual([TEST_PHRASE]));
    expect(screen.getByTestId('notice-toast')).toHaveTextContent("Kokoro voice isn't installed. Used the system voice instead.");
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Mock Voice · macOS voice');
  });

  it('recovers from an engine error: Check again reloads, then Kokoro speaks again', async () => {
    const kokoro = new FakeKokoro({ state: 'error', message: 'The local voice engine stopped (exit code 134). It restarts on next use.' });
    renderApp(kokoro);
    await chooseKokoro();
    expect(screen.getByTestId('kokoro-status')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('kokoro-hint')).toHaveTextContent('exit code 134');

    kokoro.prepareResult = { state: 'ready', loadMs: 800 } satisfies KokoroStatus;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByTestId('kokoro-status')).toHaveTextContent('Ready'));
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(kokoro.requests).toHaveLength(1);
  });

  it('status pushed from the main process updates the panel (loading → ready)', async () => {
    const kokoro = new FakeKokoro({ state: 'installed' });
    renderApp(kokoro);
    await chooseKokoro();
    act(() => kokoro.setStatus({ state: 'loading' }));
    expect(screen.getByTestId('kokoro-status')).toHaveTextContent('Loading model…');
    act(() => kokoro.setStatus({ state: 'ready', loadMs: 2258 }));
    expect(screen.getByTestId('kokoro-status')).toHaveTextContent('Ready · loaded in 2.3 s');
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Heart · Kokoro (on-device neural)');
  });

  it('Stop cancels a pending synthesis, and its result is never played', async () => {
    const { kokoro, recognizer } = renderApp();
    await chooseKokoro();
    go('Live');
    const text = await draft(recognizer, ['HELLO']);
    fireEvent.change(text, { target: { value: 'First sentence. Second sentence.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(kokoro.requests).toHaveLength(2));
    go('Workspace');
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    expect(kokoro.cancel).toHaveBeenCalledWith(kokoro.requests.map((r) => r.id));
    expect(kokoro.pending).toHaveLength(0);
  });

  it('live mode with the cloud voice: if the cloud fails, Kokoro (not the system voice) speaks the confirmed text', async () => {
    const { kokoro, backend, recognizer, system } = renderApp(new FakeKokoro(), createFakeBackend({ speechConfigured: false }));
    await chooseKokoro();
    radio('Mode', 'Live (SignFlow AI)');
    radio('Voice', 'Cloud voice');
    expect(screen.getByRole('combobox', { name: 'Fallback voice' })).toBeInTheDocument();
    go('Live');
    const text = await draft(recognizer, ['HELLO']);
    fireEvent.change(text, { target: { value: 'Hello, doctor.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(kokoro.requests.map((r) => r.text)).toEqual(['Hello, doctor.']));
    expect(backend.callsTo('/speak')).toHaveLength(1); // the cloud was tried first, after confirmation
    expect(system.spoken).toHaveLength(0);
  });

  it('live mode with the cloud voice: Test voice falls back to Kokoro when the backend is offline', async () => {
    const { kokoro, system } = renderApp(new FakeKokoro(), createFakeBackend({ offline: true }));
    await chooseKokoro();
    radio('Mode', 'Live (SignFlow AI)');
    radio('Voice', 'Cloud voice');
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(kokoro.requests.map((r) => r.text)).toEqual([TEST_PHRASE]));
    expect(system.spoken).toHaveLength(0);
    expect(screen.getByTestId('notice-toast')).toHaveTextContent('Used the Kokoro voice instead.');
  });
});
