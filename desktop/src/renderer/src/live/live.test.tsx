import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CameraStage } from './CameraStage';
import { SignTicker } from './SignTicker';
import { ConfirmToast } from './ConfirmToast';
import type { CameraController } from '../hooks/useCamera';
import type { RecognizedSign } from '../adapters/types';

function camera(overrides: Partial<CameraController> = {}): CameraController {
  return {
    status: 'off',
    error: null,
    stream: null,
    devices: [],
    deviceId: undefined,
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    selectDevice: vi.fn(),
    ...overrides,
  };
}

const stageProps = {
  mirrored: true,
  onToggleMirror: vi.fn(),
  recognizerStatus: { state: 'ready' as const },
  recognizerName: 'Mock recognizer',
};

describe('<CameraStage />', () => {
  it('off: invites the user to start the camera', () => {
    const cam = camera();
    render(<CameraStage camera={cam} {...stageProps} />);
    expect(screen.getByRole('heading', { name: 'Camera is off' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(cam.start).toHaveBeenCalled();
    expect(screen.queryByTestId('recognizer-status')).not.toBeInTheDocument();
  });

  it('on with the demo recognizer: says the signs are simulated', () => {
    render(<CameraStage camera={camera({ status: 'on' })} {...stageProps} recognizerSimulated />);
    const badge = screen.getByTestId('simulated-signs');
    expect(badge).toHaveTextContent('Simulated signs');
    expect(badge).toHaveAttribute('title', expect.stringMatching(/does not read your signing/));
  });

  it('on with a real recognizer: no simulated badge', () => {
    render(<CameraStage camera={camera({ status: 'on' })} {...stageProps} />);
    expect(screen.queryByTestId('simulated-signs')).not.toBeInTheDocument();
  });

  it('off: overlays are hidden, unless something is still awaiting a decision', () => {
    const { rerender } = render(
      <CameraStage camera={camera()} {...stageProps}>
        <p>pending draft</p>
      </CameraStage>,
    );
    expect(screen.queryByText('pending draft')).not.toBeInTheDocument();
    rerender(
      <CameraStage camera={camera()} {...stageProps} keepOverlays>
        <p>pending draft</p>
      </CameraStage>,
    );
    expect(screen.getByText('pending draft')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Camera is off' })).toBeInTheDocument();
  });

  it('off: the privacy note is accurate for both modes', () => {
    render(<CameraStage camera={camera()} {...stageProps} />);
    expect(screen.getByText(/Video never leaves this device\. Live mode sends only text to the SignFlow backend/)).toBeInTheDocument();
  });

  it('off: does not claim video stays local when the recognizer takes camera frames', () => {
    render(<CameraStage camera={camera()} {...stageProps} recognizerTakesVideo />);
    expect(screen.queryByText(/Video never leaves this device/)).not.toBeInTheDocument();
    expect(screen.getByText(/Camera frames are sent to the sign recognition model/)).toBeInTheDocument();
  });

  it('starting: shows progress and can be stopped', () => {
    const cam = camera({ status: 'starting' });
    render(<CameraStage camera={cam} {...stageProps} />);
    expect(screen.getByRole('status')).toHaveTextContent('Starting camera…');
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(cam.stop).toHaveBeenCalled();
  });

  it('error: explains the problem and offers a retry', () => {
    const cam = camera({ status: 'error', error: { kind: 'permission', message: 'Camera access was denied.' } });
    render(<CameraStage camera={cam} {...stageProps} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Camera unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('Camera access was denied.');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(cam.start).toHaveBeenCalled();
  });

  it('on: recognizer status, mirror toggle, device picker, stop, and overlays', () => {
    const onToggleMirror = vi.fn();
    const cam = camera({
      status: 'on',
      devices: [
        { deviceId: 'a', label: 'FaceTime HD' },
        { deviceId: 'b', label: 'USB Cam' },
      ],
      deviceId: 'a',
    });
    render(
      <CameraStage camera={cam} {...stageProps} onToggleMirror={onToggleMirror}>
        <p>overlay content</p>
      </CameraStage>,
    );
    expect(screen.getByTestId('recognizer-status')).toHaveTextContent('Recognizing');
    expect(screen.getByTestId('recognizer-status')).toHaveTextContent('Mock recognizer');
    const mirror = screen.getByRole('button', { name: 'Mirror preview' });
    expect(mirror).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(mirror);
    expect(onToggleMirror).toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Camera device' }), { target: { value: 'b' } });
    expect(cam.selectDevice).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(cam.stop).toHaveBeenCalled();
    expect(screen.getByText('overlay content')).toBeInTheDocument();
    expect(screen.getByTestId('webcam-video')).toHaveClass('is-mirrored');
  });
});

describe('<SignTicker />', () => {
  const s = (id: string, gloss: string, final = true, confidence = 0.9): RecognizedSign => ({ id, gloss, final, confidence, ts: 0 });

  it('shows accepted signs with confidence and the sign being refined', () => {
    render(<SignTicker buffer={[s('1', 'HOW'), s('2', 'YOU', true, 0.7)]} latest={s('3', 'WHAT', false)} threshold={0.6} />);
    expect(screen.getAllByTestId('sign-chip')).toHaveLength(2);
    expect(screen.getByRole('meter', { name: 'YOU confidence' })).toHaveAttribute('aria-valuenow', '70');
    expect(screen.getByLabelText('Refining WHAT')).toBeInTheDocument();
  });

  it('renders nothing when idle and caps the number of chips', () => {
    const { container, rerender } = render(<SignTicker buffer={[]} latest={s('x', 'HI')} threshold={0.6} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<SignTicker buffer={Array.from({ length: 12 }, (_, i) => s(`${i}`, `G${i}`))} latest={undefined} threshold={0.6} max={8} />);
    expect(screen.getAllByTestId('sign-chip')).toHaveLength(8);
    expect(screen.getByText('G11')).toBeInTheDocument();
  });
});

describe('<ConfirmToast />', () => {
  it('says what happened, then dismisses itself', () => {
    vi.useFakeTimers();
    const onDone = vi.fn();
    const { rerender } = render(<ConfirmToast feedback={{ id: '1', text: 'Hi.', spoken: true, noted: true }} onDone={onDone} />);
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Spoken · saved to notes');
    rerender(<ConfirmToast feedback={{ id: '2', text: 'Yo.', spoken: false, noted: false }} onDone={onDone} />);
    expect(screen.getByTestId('confirm-toast')).toHaveTextContent('Confirmed');
    act(() => vi.advanceTimersByTime(2600));
    expect(onDone).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
