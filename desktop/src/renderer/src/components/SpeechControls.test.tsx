import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { SpeechControls } from './SpeechControls';
import { useSpeech } from '../hooks/useSpeech';
import { MockSpeechEngine } from '../adapters/speech';

function Harness({ engine, lastText, onAuto }: { engine: MockSpeechEngine; lastText?: string; onAuto: (v: boolean) => void }) {
  const speech = useSpeech(engine);
  return <SpeechControls speech={speech} autoSpeak onAutoSpeakChange={onAuto} lastText={lastText} />;
}

describe('<SpeechControls /> + useSpeech', () => {
  beforeEach(() => localStorage.clear());

  it('replays the last sentence and drives pause/resume/stop', () => {
    const engine = new MockSpeechEngine(1000);
    render(<Harness engine={engine} lastText="Thank you." onAuto={vi.fn()} />);
    expect(screen.getByTestId('speech-state')).toHaveTextContent('Idle');
    expect(screen.getByRole('button', { name: 'Pause' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /Speak last/ }));
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
    render(<Harness engine={new MockSpeechEngine()} onAuto={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Speak last/ })).toBeDisabled();
  });

  it('applies voice, rate, pitch, and volume to speech', () => {
    const engine = new MockSpeechEngine();
    render(<Harness engine={engine} lastText="Hi." onAuto={vi.fn()} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'mock-voice' } });
    const [rate, pitch, volume] = screen.getAllByRole('slider');
    fireEvent.change(rate!, { target: { value: '1.5' } });
    fireEvent.change(pitch!, { target: { value: '0.8' } });
    fireEvent.change(volume!, { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Speak last/ }));
    expect(engine.spoken.at(-1)?.opts).toEqual({ voiceId: 'mock-voice', rate: 1.5, pitch: 0.8, volume: 0.5 });
  });

  it('toggles auto-speak', () => {
    const onAuto = vi.fn();
    render(<Harness engine={new MockSpeechEngine()} onAuto={onAuto} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /Auto-speak/ }));
    expect(onAuto).toHaveBeenCalledWith(false);
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
