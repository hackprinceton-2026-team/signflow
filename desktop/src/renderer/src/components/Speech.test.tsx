import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { SpeechTransport } from './SpeechTransport';
import { describeVoiceInUse, SpeechSettings, TEST_PHRASE } from './SpeechSettings';
import { useSpeech } from '../hooks/useSpeech';
import { MockSpeechEngine } from '../adapters/speech';

function Transport({ engine, lastText }: { engine: MockSpeechEngine; lastText?: string }) {
  const speech = useSpeech(engine);
  return <SpeechTransport speech={speech} lastText={lastText} />;
}

function Settings({ engine, onAuto = vi.fn(), autoSpeak = false }: { engine: MockSpeechEngine; onAuto?: (v: boolean) => void; autoSpeak?: boolean }) {
  const speech = useSpeech(engine);
  return <SpeechSettings speech={speech} autoSpeak={autoSpeak} onAutoSpeakChange={onAuto} />;
}

beforeEach(() => localStorage.clear());

describe('<SpeechTransport />', () => {
  it('replays the last confirmed sentence and drives pause/resume/stop', () => {
    const engine = new MockSpeechEngine(1000);
    render(<Transport engine={engine} lastText="Thank you." />);
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Idle');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Speak last' }));
    expect(engine.spoken.at(-1)?.text).toBe('Thank you.');
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Speaking');

    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Paused');
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Speaking');
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Idle');
  });

  it('disables "Speak last" with nothing confirmed yet', () => {
    render(<Transport engine={new MockSpeechEngine()} />);
    expect(screen.getByRole('button', { name: 'Speak last' })).toBeDisabled();
  });
});

describe('<SpeechSettings />', () => {
  it('applies voice, rate, pitch, and volume; Test voice speaks a fixed phrase only', () => {
    const engine = new MockSpeechEngine();
    render(<Settings engine={engine} />);
    fireEvent.change(screen.getByRole('combobox', { name: 'System voice' }), { target: { value: 'mock-voice' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Rate' }), { target: { value: '1.5' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Pitch' }), { target: { value: '0.8' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(engine.spoken.at(-1)).toEqual({ text: TEST_PHRASE, opts: { voiceId: 'mock-voice', rate: 1.5, pitch: 0.8, volume: 0.5 } });
  });

  it('shows the system voice in use, and the cloud voices only when the cloud voice is selected', () => {
    const engine = new MockSpeechEngine();
    render(<Settings engine={engine} />);
    expect(screen.getByTestId('voice-in-use-pill')).toHaveTextContent('Mock Voice · system voice');
    expect(screen.queryByRole('radiogroup', { name: 'Cloud voice' })).toBeNull();
    expect(screen.getByText(/Amazon Polly Generative: Ruth, Danielle, Matthew/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(screen.getByTestId('voice-in-use')).toHaveTextContent('Last confirmed text was spoken with this voice.');
  });

  it('toggles "Speak when confirming" and resets options', () => {
    const onAuto = vi.fn();
    const engine = new MockSpeechEngine();
    render(<Settings engine={engine} onAuto={onAuto} />);
    const sw = screen.getByRole('switch', { name: 'Speak when confirming' });
    expect(sw).toHaveAccessibleDescription(/Unconfirmed drafts are never spoken/);
    fireEvent.click(sw);
    expect(onAuto).toHaveBeenCalledWith(true);

    fireEvent.change(screen.getByRole('slider', { name: 'Rate' }), { target: { value: '1.8' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByRole('slider', { name: 'Rate' })).toHaveValue('1');
  });

  it('Test voice does not become the "last spoken" text', () => {
    const engine = new MockSpeechEngine();
    const { result } = renderHook(() => useSpeech(engine));
    act(() => result.current.preview(TEST_PHRASE));
    expect(engine.spoken.at(-1)?.text).toBe(TEST_PHRASE);
    expect(result.current.lastSpoken).toBeNull();
  });

  it('persists options across sessions and ignores corrupt storage', () => {
    const engine = new MockSpeechEngine();
    const first = renderHook(() => useSpeech(engine));
    act(() => first.result.current.updateOptions({ rate: 1.7 }));
    first.unmount();
    expect(renderHook(() => useSpeech(engine)).result.current.options.rate).toBe(1.7);

    localStorage.setItem('signflow.speech', '{"rate":"fast"}');
    expect(renderHook(() => useSpeech(engine)).result.current.options.rate).toBe(1);
  });
});

describe('describeVoiceInUse', () => {
  const sam = { id: 'v-sam', name: 'Samantha', lang: 'en-US', isDefault: true };
  const base = { cloudVoice: true, cloudStatus: 'ready' as const, cloudVoiceId: undefined, systemVoice: sam, systemLabel: 'macOS voice', last: null };

  it('before anything is spoken: Ruth (Generative), or the macOS voice when the cloud is unavailable', () => {
    expect(describeVoiceInUse(base)).toMatchObject({ tone: 'accent', label: 'Ruth · Amazon Polly Generative' });
    expect(describeVoiceInUse(base).detail).toMatch(/Samantha \(macOS voice\) speaks instead/);
    expect(describeVoiceInUse({ ...base, cloudStatus: 'offline' })).toMatchObject({ tone: 'warning', label: 'Samantha · macOS voice' });
    expect(describeVoiceInUse({ ...base, cloudStatus: 'not_configured' }).detail).toMatch(/no AWS credentials/);
    expect(describeVoiceInUse({ ...base, cloudVoice: false })).toMatchObject({ tone: 'neutral', label: 'Samantha · macOS voice' });
  });

  it('after speaking: the voice and engine that actually spoke', () => {
    const cloud = { source: 'cloud' as const, id: 'Ruth', name: 'Ruth', engine: 'generative', fallback: false };
    expect(describeVoiceInUse({ ...base, last: cloud })).toMatchObject({ tone: 'success', label: 'Ruth · Amazon Polly Generative' });
    expect(describeVoiceInUse({ ...base, last: { ...cloud, engine: 'neural' } })).toMatchObject({
      tone: 'warning',
      label: 'Ruth · Amazon Polly Neural',
    });
    const fallback = { source: 'system' as const, id: 'v-sam', name: 'Samantha', fallback: true };
    expect(describeVoiceInUse({ ...base, last: fallback })).toMatchObject({ tone: 'warning', label: 'Samantha · macOS voice' });
  });

  it('ignores a last voice that no longer matches the settings', () => {
    const cloud = { source: 'cloud' as const, id: 'Ruth', name: 'Ruth', engine: 'generative', fallback: false };
    expect(describeVoiceInUse({ ...base, cloudVoiceId: 'Matthew', last: cloud })).toMatchObject({
      tone: 'accent',
      label: 'Matthew · Amazon Polly Generative',
    });
  });
});

describe('describeVoiceInUse with Kokoro', () => {
  const sam = { id: 'v-sam', name: 'Samantha', lang: 'en-US', isDefault: true };
  const base = {
    cloudVoice: false,
    cloudStatus: 'unknown' as const,
    cloudVoiceId: undefined,
    systemVoice: sam,
    systemLabel: 'macOS voice',
    last: null,
    engine: 'kokoro' as const,
    kokoroVoiceId: 'af_bella',
  };

  it('before speaking: Kokoro when ready or loading, the macOS voice when missing or broken', () => {
    expect(describeVoiceInUse({ ...base, kokoroStatus: { state: 'ready' } })).toMatchObject({
      tone: 'accent',
      label: 'Bella · Kokoro (on-device neural)',
      detail: 'Runs entirely on this device. No network needed.',
    });
    expect(describeVoiceInUse({ ...base, kokoroStatus: { state: 'loading' } }).detail).toMatch(/Loading the voice model/);
    expect(describeVoiceInUse({ ...base, kokoroStatus: { state: 'missing' } })).toMatchObject({ tone: 'warning', label: 'Samantha · macOS voice' });
    expect(describeVoiceInUse({ ...base, kokoroStatus: { state: 'error', message: 'x' } }).detail).toMatch(/isn't working/);
  });

  it('after speaking: Kokoro itself, or the macOS voice standing in for it', () => {
    const spoke = { source: 'kokoro' as const, id: 'af_bella', name: 'Bella', engine: 'kokoro', fallback: false };
    expect(describeVoiceInUse({ ...base, last: spoke })).toMatchObject({ tone: 'success', label: 'Bella · Kokoro (on-device neural)' });
    const fellBack = { source: 'system' as const, id: 'v-sam', name: 'Samantha', fallback: true };
    expect(describeVoiceInUse({ ...base, last: fellBack })).toMatchObject({ tone: 'warning', detail: expect.stringMatching(/Kokoro was unavailable/) });
    // A different Kokoro voice chosen since: describe the new one.
    expect(describeVoiceInUse({ ...base, kokoroVoiceId: 'am_michael', last: spoke, kokoroStatus: { state: 'ready' } }).label).toBe(
      'Michael · Kokoro (on-device neural)',
    );
  });

  it('with the cloud voice: Kokoro is named as the fallback, and shown when it stood in', () => {
    const cloud = { ...base, cloudVoice: true, cloudStatus: 'ready' as const, kokoroStatus: { state: 'ready' as const } };
    expect(describeVoiceInUse(cloud).detail).toMatch(/Bella \(Kokoro\) speaks instead/);
    expect(describeVoiceInUse({ ...cloud, cloudStatus: 'offline' })).toMatchObject({ label: 'Bella · Kokoro (on-device neural)' });
    const stoodIn = { source: 'kokoro' as const, id: 'af_bella', name: 'Bella', engine: 'kokoro', fallback: true };
    expect(describeVoiceInUse({ ...cloud, last: stoodIn })).toMatchObject({ tone: 'warning', detail: expect.stringMatching(/so Kokoro spoke instead/) });
  });
});
