import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { installFakeBridge } from '../test/setup';
import { FakeRecognizer, FakeRecognizerBridge, installFakeMediaDevices } from '../test/fakes';
import { createFakeBackend } from '../test/fakeBackend';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import { MockSpeechEngine } from '../adapters/speech';

/** Messages exactly as Umar's live.py sends them (ts in seconds). */
const now = () => Date.now() / 1000;
const demoSign = (sign: string, confidence: number, candidates: [string, number][] = [[sign, confidence]]) => ({
  type: 'sign',
  sign,
  confidence,
  candidates,
  ts: now(),
});
const endOfSentence = (signs: string[]) => ({ type: 'end_of_sentence', signs, ts: now() });

function renderApp(bridge = new FakeRecognizerBridge()) {
  installFakeBridge({ recognizer: bridge });
  const media = installFakeMediaDevices();
  const demo = new FakeRecognizer();
  const system = new MockSpeechEngine();
  const backend = createFakeBackend();
  render(
    <App
      adapters={{ recognizer: demo, translator: new MockTranslator({ latencyMs: 0 }), speech: system }}
      initialSettings={{ pauseMs: 30 }}
      backendClient={backend.client}
    />,
  );
  return { bridge, media, demo, system, backend };
}

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const go = (label: string) => fireEvent.click(nav().getByRole('button', { name: label }));
const radio = (group: string, option: string) =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }));
const ASL = 'SignFlow ASL model (local)';

async function chooseAsl() {
  go('Settings');
  radio('Sign recognizer', ASL);
  go('Live');
  await screen.findByTestId('external-stage');
}

async function startRecognition(bridge: FakeRecognizerBridge) {
  fireEvent.click(screen.getByRole('button', { name: 'Start recognition' }));
  await waitFor(() => expect(bridge.start).toHaveBeenCalled());
  await waitFor(() => expect(bridge.listening).toBe(true));
}

beforeEach(() => localStorage.clear());

describe('the local ASL recognizer in the app', () => {
  it('is opt-in: the demo recognizer stays the default', () => {
    renderApp();
    go('Settings');
    expect(within(screen.getByRole('radiogroup', { name: 'Sign recognizer' })).getByRole('radio', { name: 'Demo (simulated)' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    go('Live');
    expect(screen.getByRole('button', { name: 'Start camera' })).toBeInTheDocument();
  });

  it('never opens the camera: the recognizer process owns it (one capture session)', async () => {
    const { bridge, media } = renderApp();
    await chooseAsl();
    expect(screen.queryByRole('button', { name: 'Start camera' })).toBeNull();
    await startRecognition(bridge);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId('status-camera')).toHaveTextContent('Recognition on');
    expect(screen.getByTestId('recognizer-status')).toHaveTextContent(/Recognizing\s*· SignFlow ASL model \(14-sign model\)/);
    go('Settings');
    expect(screen.getByTestId('camera-external-note')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start camera' })).toBeNull();
    expect(JSON.parse(localStorage.getItem('signflow.recognizer') ?? '{}')).toEqual({ source: 'asl', allowKeyword: false });
  });

  it('switching to the ASL recognizer releases a camera the app already had open', async () => {
    const { media } = renderApp();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(screen.getByTestId('status-camera')).toHaveTextContent('Camera on'));
    await chooseAsl();
    await waitFor(() => expect(media.streams[0]!.track.stop).toHaveBeenCalled());
    expect(screen.getByTestId('status-camera')).toHaveTextContent('Recognition off');
  });

  it('recorded signs → draft at the end of the sentence → spoken only after confirmation', async () => {
    const { bridge, system } = renderApp();
    await chooseAsl();
    await startRecognition(bridge);
    act(() => void bridge.send(demoSign('HELP', 0.91, [['HELP', 0.91], ['STOP', 0.05], ['DOCTOR', 0.02]])));
    act(() => void bridge.send(demoSign('DOCTOR', 0.84)));
    expect(screen.getAllByTestId('sign-chip').map((c) => c.textContent)).toEqual(['HELP', 'DOCTOR']);
    expect(screen.queryByTestId('draft-text')).toBeNull(); // still signing: no draft yet

    act(() => void bridge.send(endOfSentence(['HELP', 'DOCTOR'])));
    const draft = await screen.findByTestId('draft-text');
    expect(draft).toHaveValue('Help doctor.');
    expect(system.spoken).toHaveLength(0);

    fireEvent.change(draft, { target: { value: 'I need a doctor.' } });
    expect(system.spoken).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    expect(system.spoken.map((s) => s.text)).toEqual(['I need a doctor.']);
  });

  it('a duplicated message never becomes a duplicated sign or translation', async () => {
    const { bridge } = renderApp();
    await chooseAsl();
    await startRecognition(bridge);
    const msg = demoSign('YES', 0.9);
    act(() => {
      bridge.send(msg);
      bridge.send(msg);
    });
    act(() => void bridge.send(endOfSentence(['YES'])));
    expect(await screen.findByTestId('draft-text')).toHaveValue('Yes.');
    act(() => void bridge.send(msg)); // replayed after drafting
    act(() => void bridge.send(endOfSentence(['YES'])));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByTestId('draft-text')).toHaveValue('Yes.');
  });

  it('low confidence is shown honestly and never used', async () => {
    const { bridge } = renderApp();
    await chooseAsl();
    await startRecognition(bridge);
    act(() => void bridge.send(demoSign('YES', 0.55, [['YES', 0.55], ['DRINK', 0.3]]))); // threshold is 0.6
    const rejected = screen.getByTestId('sign-chip-rejected');
    expect(rejected).toHaveTextContent('YES?');
    expect(rejected).toHaveTextContent('not used · 55%');
    expect(rejected).toHaveAttribute('title', expect.stringContaining('Also possible: DRINK 30%'));
    act(() => void bridge.send(endOfSentence(['YES'])));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('draft-text')).toBeNull();
  });

  it('the 116-sign keyword model is opt-in; uncertain top-5 candidates are shown, never used', async () => {
    const { bridge } = renderApp();
    go('Settings');
    radio('Sign recognizer', ASL);
    fireEvent.click(screen.getByRole('switch', { name: /Allow the 116-sign keyword model/ }));
    go('Live');
    await startRecognition(bridge);
    expect(bridge.allowKeyword).toBe(true);

    act(
      () =>
        void bridge.send({
          type: 'sign',
          candidates: [['HELP', 0.19], ['HOW', 0.08], ['AGAIN', 0.08], ['THIN', 0.07], ['STOP', 0.06]],
          top1: 'HELP',
          confident: false,
          ts: now(),
        }),
    );
    expect(screen.getByTestId('sign-chip-rejected')).toHaveTextContent('not used · model unsure');
    act(() => void bridge.send({ type: 'sign', candidates: [['MOTHER', 0.99], ['FATHER', 0.01]], top1: 'MOTHER', confident: true, ts: now() }));
    expect(screen.getAllByTestId('sign-chip').map((c) => c.textContent)).toEqual(['MOTHER']);

    go('Workspace');
    const rows = screen.getAllByTestId('sign-row');
    expect(rows[1]).toHaveTextContent('model unsure');
    expect(within(rows[1]!).getByTestId('sign-alternatives')).toHaveTextContent('or HOW 8% · AGAIN 8% · THIN 7%');
  });

  it('recognizer not running: explains how to start it, and offers the demo recognizer', async () => {
    const bridge = new FakeRecognizerBridge();
    bridge.startResult = { state: 'connecting', message: 'Waiting for the SignFlow ASL recognizer on ws://127.0.0.1:8765. Start it with: python src/live.py' };
    renderApp(bridge);
    await chooseAsl();
    await startRecognition(bridge);
    expect(screen.getByTestId('external-stage-message')).toHaveTextContent('Start it with: python src/live.py');
    fireEvent.click(screen.getByRole('button', { name: 'Use the demo recognizer instead' }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalled());
    expect(await screen.findByRole('button', { name: 'Start camera' })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('signflow.recognizer') ?? '{}')).toMatchObject({ source: 'demo' });
  });

  it('Stop recognition disconnects; signs that still arrive are ignored', async () => {
    const { bridge } = renderApp();
    await chooseAsl();
    await startRecognition(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Stop recognition' }));
    await waitFor(() => expect(bridge.stop).toHaveBeenCalled());
    expect(bridge.listening).toBe(false);
    act(() => void bridge.send(demoSign('HELP', 0.9)));
    expect(screen.queryByTestId('sign-chip')).toBeNull();
    expect(screen.getByTestId('status-camera')).toHaveTextContent('Recognition off');
  });

  it('makes no backend call in demo mode (signs come from the local recognizer, drafts from the demo translator)', async () => {
    const { bridge, backend } = renderApp();
    await chooseAsl();
    await startRecognition(bridge);
    act(() => void bridge.send(demoSign('THANKYOU', 0.95)));
    act(() => void bridge.send(endOfSentence(['THANKYOU'])));
    expect(await screen.findByTestId('draft-text')).toHaveValue('Thank you.');
    expect(backend.calls).toHaveLength(0);
  });
});
