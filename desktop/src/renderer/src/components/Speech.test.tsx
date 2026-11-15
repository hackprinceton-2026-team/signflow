import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { SpeechTransport } from './SpeechTransport';
import { SpeechSettings, TEST_PHRASE } from './SpeechSettings';
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
    fireEvent.change(screen.getByRole('combobox', { name: 'Voice' }), { target: { value: 'mock-voice' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Rate' }), { target: { value: '1.5' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Pitch' }), { target: { value: '0.8' } });
    fireEvent.change(screen.getByRole('slider', { name: 'Volume' }), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test voice' }));
    expect(engine.spoken.at(-1)).toEqual({ text: TEST_PHRASE, opts: { voiceId: 'mock-voice', rate: 1.5, pitch: 0.8, volume: 0.5 } });
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
