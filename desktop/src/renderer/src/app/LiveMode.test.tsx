import { beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from '../App';
import { installFakeBridge } from '../test/setup';
import { FakeRecognizer, installFakeMediaDevices } from '../test/fakes';
import { createFakeBackend } from '../test/fakeBackend';
import { MockTranslator } from '../adapters/mock/mockTranslator';
import { MockSpeechEngine } from '../adapters/speech';
import { TEST_PHRASE } from '../components/SpeechSettings';

function renderApp(backend = createFakeBackend()) {
  installFakeBridge();
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const system = new MockSpeechEngine();
  render(
    <App
      adapters={{ recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech: system }}
      initialSettings={{ pauseMs: 30 }}
      backendClient={backend.client}
    />,
  );
  return { backend, recognizer, system };
}

const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
const go = (label: string) => fireEvent.click(nav().getByRole('button', { name: label }));
const radio = (group: string, option: string) =>
  fireEvent.click(within(screen.getByRole('radiogroup', { name: group })).getByRole('radio', { name: option }));

async function goLive(opts: { voice?: 'System voice' | 'Cloud voice'; context?: 'Everyday' | 'Medical' | 'Emergency' } = {}) {
  go('Settings');
  radio('Mode', 'Live (SignFlow AI)');
  if (opts.context) radio('Translation context', opts.context);
  if (opts.voice) radio('Voice', opts.voice);
  go('Live');
}

async function signPhrase(recognizer: FakeRecognizer, glosses: string[]) {
  if (screen.queryByRole('button', { name: 'Start camera' })) {
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
  }
  act(() => glosses.forEach((g) => recognizer.emit(g, 0.9)));
}

beforeEach(() => localStorage.clear());

describe('live mode: AI translation through the backend', () => {
  it('demo mode never touches the backend', async () => {
    const { backend, recognizer } = renderApp();
    await signPhrase(recognizer, ['HOW', 'YOU']);
    expect(await screen.findByTestId('draft-text')).toHaveValue('How are you?');
    expect(backend.calls).toHaveLength(0);
    expect(screen.queryByTestId('status-backend')).not.toBeInTheDocument();
  });

  it('switching to live shows backend status and remembers the choice', async () => {
    const { backend } = renderApp();
    go('Settings');
    radio('Mode', 'Live (SignFlow AI)');
    await waitFor(() => expect(screen.getByTestId('status-backend')).toHaveTextContent('AI online'));
    expect(within(screen.getByTestId('backend-status')).getByText('Online')).toBeInTheDocument();
    expect(screen.getByText(/gemini-test · API v0\.3\.0/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('signflow.connection') ?? '{}')).toMatchObject({ mode: 'live' });
    expect(backend.callsTo('/health').length).toBeGreaterThan(0);
  });

  it('drafts come from the backend, with the chosen context', async () => {
    const { backend, recognizer } = renderApp(createFakeBackend({ translate: () => "I've had a headache since yesterday." }));
    await goLive({ context: 'Medical' });
    await signPhrase(recognizer, ['HEADACHE', 'SINCE', 'YESTERDAY']);
    expect(await screen.findByTestId('draft-text')).toHaveValue("I've had a headache since yesterday.");
    expect(backend.callsTo('/translate').map((c) => c.body)).toEqual([{ raw_signs: ['HEADACHE', 'SINCE', 'YESTERDAY'], mode: 'medical' }]);
  });

  it('cloud voice: /speak is called only after confirmation, with exactly the confirmed text', async () => {
    const { backend, recognizer, system } = renderApp();
    await goLive({ voice: 'Cloud voice' });
    await signPhrase(recognizer, ['THANK-YOU']);
    await screen.findByTestId('draft-text');
    // A draft exists, but nothing has been spoken.
    expect(backend.callsTo('/speak')).toHaveLength(0);

    fireEvent.change(screen.getByTestId('draft-text'), { target: { value: 'Thank you so much.' } });
    expect(backend.callsTo('/speak')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(backend.callsTo('/speak')).toHaveLength(1));
    // No voice chosen → Ruth, the natural Generative default.
    expect(backend.callsTo('/speak')[0]!.body).toEqual({ text: 'Thank you so much.', voice_id: 'Ruth' });
    expect(system.spoken).toHaveLength(0);
    // Order on the wire: translate first, speak only after.
    const paths = backend.calls.map((c) => c.path).filter((p) => p !== '/health');
    expect(paths).toEqual(['/translate', '/speak']);
  });

  it('sends the cloud voice the user picked', async () => {
    const { backend, recognizer } = renderApp();
    await goLive({ voice: 'Cloud voice' });
    go('Settings');
    radio('Cloud voice', 'Matthew');
    go('Live');
    await signPhrase(recognizer, ['HELLO']);
    await screen.findByTestId('draft-text');
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(backend.callsTo('/speak')[0]?.body).toEqual({ text: '[AI] hello.', voice_id: 'Matthew' }));
  });

  it('plain Confirm never calls /speak', async () => {
    const { backend, recognizer } = renderApp();
    await goLive({ voice: 'Cloud voice' });
    await signPhrase(recognizer, ['HELLO']);
    await screen.findByTestId('draft-text');
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Confirmed');
    expect(backend.callsTo('/speak')).toHaveLength(0);
  });

  it('cloud voice failure falls back to the system voice for the same confirmed text', async () => {
    const { backend, recognizer, system } = renderApp(createFakeBackend({ speechConfigured: false }));
    await goLive({ voice: 'Cloud voice' });
    await signPhrase(recognizer, ['I', 'NEED', 'HELP']);
    await screen.findByTestId('draft-text');
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    await waitFor(() => expect(system.spoken.map((s) => s.text)).toEqual(['[AI] i need help.']));
    expect(backend.callsTo('/speak')).toHaveLength(1);
    expect(screen.getByTestId('notice-toast')).toHaveTextContent(/Cloud voice unavailable: Speech is not configured.*system voice/);

    // Settings › Speech says which voice actually spoke.
    go('Settings');
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Mock Voice · macOS voice');
    expect(screen.getByTestId('voice-in-use')).toHaveTextContent(/cloud voice was unavailable last time/);
  });

  it('Settings › Speech shows the cloud voice that actually spoke, and its engine', async () => {
    const { recognizer } = renderApp();
    await goLive({ voice: 'Cloud voice' });
    go('Settings');
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Ruth · Amazon Polly Generative');
    go('Live');
    await signPhrase(recognizer, ['HELLO']);
    await screen.findByTestId('draft-text');
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    go('Settings');
    await waitFor(() => expect(screen.getByTestId('voice-in-use')).toHaveTextContent(/Last confirmed text was spoken with this cloud voice/));
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Ruth · Amazon Polly Generative');
  });

  it('Test voice previews the selected cloud voice with a fixed phrase', async () => {
    const { backend } = renderApp();
    await goLive({ voice: 'Cloud voice' });
    go('Settings');
    radio('Cloud voice', 'Danielle');
    expect(screen.getByTestId('cloud-voice-detail')).toHaveTextContent('Danielle: US English, female · Amazon Polly Generative');
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(backend.callsTo('/speak').map((c) => c.body)).toEqual([{ text: TEST_PHRASE, voice_id: 'Danielle' }]));
    await waitFor(() => expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Danielle · Amazon Polly Generative'));
    // A test phrase is not confirmed text: "Speak last" stays empty.
    go('Live');
    expect(screen.queryByRole('button', { name: 'Speak last' })).toBeNull();
  });

  it('warns before speaking when the backend has no speech credentials', async () => {
    renderApp(createFakeBackend({ speechConfigured: false }));
    await goLive({ voice: 'Cloud voice' });
    go('Settings');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(screen.getByTestId('voice-in-use')).toHaveTextContent(/no AWS credentials/));
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Mock Voice · macOS voice');
  });

  it('system voice in live mode speaks locally (no /speak)', async () => {
    const { backend, recognizer, system } = renderApp();
    await goLive({ voice: 'System voice' });
    await signPhrase(recognizer, ['HELLO']);
    await screen.findByTestId('draft-text');
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    expect(system.spoken.map((s) => s.text)).toEqual(['[AI] hello.']);
    expect(backend.callsTo('/speak')).toHaveLength(0);
  });
});

describe('live mode: offline and error handling', () => {
  it('offline: explains the problem, and "Use demo mode" finishes the same phrase locally', async () => {
    const { backend, recognizer } = renderApp(createFakeBackend({ offline: true }));
    await goLive();
    await waitFor(() => expect(screen.getByTestId('status-backend')).toHaveTextContent('AI offline'));
    await signPhrase(recognizer, ['HOW', 'YOU']);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Can't reach the SignFlow backend at localhost:8000");

    fireEvent.click(within(alert).getByRole('button', { name: 'Use demo mode' }));
    expect(await screen.findByTestId('draft-text')).toHaveValue('How are you?');
    expect(screen.queryByTestId('status-backend')).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('signflow.connection') ?? '{}')).toMatchObject({ mode: 'demo' });
    expect(backend.callsTo('/translate')).toHaveLength(1); // the failed attempt only
  });

  it('a failed translation refreshes the status at once (no stale "AI online")', async () => {
    const { backend, recognizer } = renderApp();
    await goLive();
    await waitFor(() => expect(screen.getByTestId('status-backend')).toHaveTextContent('AI online'));
    backend.state.offline = true;
    await signPhrase(recognizer, ['HELLO']);
    await screen.findByRole('alert');
    await waitFor(() => expect(screen.getByTestId('status-backend')).toHaveTextContent('AI offline'));
  });

  it('retry succeeds once the backend is back', async () => {
    const { backend, recognizer } = renderApp(createFakeBackend({ offline: true }));
    await goLive();
    await signPhrase(recognizer, ['HELLO']);
    const alert = await screen.findByRole('alert');
    backend.state.offline = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('draft-text')).toHaveValue('[AI] hello.');
  });

  it('missing API key: shows the server explanation and setup hint', async () => {
    const { recognizer } = renderApp(createFakeBackend({ translationConfigured: false }));
    go('Settings');
    radio('Mode', 'Live (SignFlow AI)');
    await waitFor(() => expect(screen.getByTestId('status-backend')).toHaveTextContent('AI not configured'));
    expect(screen.getByTestId('backend-status')).toHaveTextContent('GOOGLE_API_KEY');
    go('Live');
    await signPhrase(recognizer, ['HELLO']);
    expect(await screen.findByRole('alert')).toHaveTextContent('Translation is not configured on the server (missing GOOGLE_API_KEY).');
  });

  it('"Check again" re-checks the backend', async () => {
    const { backend } = renderApp(createFakeBackend({ offline: true }));
    go('Settings');
    radio('Mode', 'Live (SignFlow AI)');
    await waitFor(() => expect(within(screen.getByTestId('backend-status')).getByText('Offline')).toBeInTheDocument());
    expect(screen.getByTestId('backend-status')).toHaveTextContent('uvicorn main:app');
    backend.state.offline = false;
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(within(screen.getByTestId('backend-status')).getByText('Online')).toBeInTheDocument());
  });
});

describe('connection settings', () => {
  it('context and voice are only editable in live mode; cloud voice disables pitch', () => {
    renderApp();
    go('Settings');
    for (const group of ['Translation context', 'Voice']) {
      for (const r of within(screen.getByRole('radiogroup', { name: group })).getAllByRole('radio')) expect(r).toBeDisabled();
    }
    radio('Mode', 'Live (SignFlow AI)');
    radio('Voice', 'Cloud voice');
    expect(screen.getByText('Not supported by the cloud voice.')).toBeInTheDocument();
    const cloudVoices = within(screen.getByRole('radiogroup', { name: 'Cloud voice' })).getAllByRole('radio');
    expect(cloudVoices.map((r) => r.textContent)).toEqual(['Ruth', 'Danielle', 'Matthew']);
    expect(cloudVoices[0]).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('combobox', { name: 'Fallback voice' })).toHaveTextContent('Automatic (Mock Voice)');
  });

  it('arrow keys move the selection in a segmented control', () => {
    renderApp();
    go('Settings');
    const live = within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: 'Demo' });
    fireEvent.keyDown(live, { key: 'ArrowRight' });
    expect(within(screen.getByRole('radiogroup', { name: 'Mode' })).getByRole('radio', { name: 'Live (SignFlow AI)' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
