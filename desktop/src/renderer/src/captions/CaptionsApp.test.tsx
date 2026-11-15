import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CaptionsApp } from './CaptionsApp';
import { installFakeBridge } from '../test/setup';
import { DEFAULT_CAPTION_SETTINGS, type CaptionPayload } from '@shared/captions';

describe('<CaptionsApp />', () => {
  it('loads current state, then renders pushed updates', async () => {
    installFakeBridge();
    let push: (p: CaptionPayload) => void = () => undefined;
    window.signflow.captions.getState = vi.fn(async () => ({
      lines: [{ id: '1', text: 'Hello, nice to meet you.' }],
      live: '',
      settings: DEFAULT_CAPTION_SETTINGS,
    }));
    window.signflow.captions.onRender = vi.fn((cb: (p: CaptionPayload) => void) => {
      push = cb;
      return () => undefined;
    });

    render(<CaptionsApp />);
    expect(await screen.findByText('Hello, nice to meet you.')).toBeInTheDocument();

    act(() =>
      push({
        lines: [{ id: '2', text: 'How are you?' }],
        live: 'I NEED …',
        settings: { ...DEFAULT_CAPTION_SETTINGS, fontSize: 48, opacity: 0.5 },
      }),
    );
    expect(screen.getByTestId('caption-line')).toHaveTextContent('How are you?');
    expect(screen.getByTestId('caption-live')).toHaveTextContent('I NEED …');
    expect(screen.getByTestId('captions')).toHaveStyle({ fontSize: '48px' });
  });

  it('hides in-progress text when showLive is off and shows an idle hint', async () => {
    installFakeBridge();
    window.signflow.captions.getState = vi.fn(async () => ({
      lines: [],
      live: 'HELLO …',
      settings: { ...DEFAULT_CAPTION_SETTINGS, showLive: false },
    }));
    render(<CaptionsApp />);
    expect(await screen.findByText('Waiting for signs…')).toBeInTheDocument();
    expect(screen.queryByTestId('caption-live')).not.toBeInTheDocument();
  });

  it('close button asks main to close the overlay', () => {
    const bridge = installFakeBridge();
    render(<CaptionsApp />);
    fireEvent.click(screen.getByRole('button', { name: 'Close captions' }));
    expect(bridge.captions.close).toHaveBeenCalled();
  });
});
