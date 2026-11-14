import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App } from './App';
import { installFakeBridge } from './test/setup';
import { FakeRecognizer, installFakeMediaDevices } from './test/fakes';
import { MockTranslator } from './adapters/mock/mockTranslator';
import { MockSpeechEngine } from './adapters/speech';

function renderApp() {
  installFakeBridge();
  installFakeMediaDevices();
  const recognizer = new FakeRecognizer();
  const adapters = { recognizer, translator: new MockTranslator({ latencyMs: 0 }), speech: new MockSpeechEngine() };
  render(<App adapters={adapters} initialSettings={{ pauseMs: 30 }} />);
  return { recognizer, adapters };
}

describe('<App />', () => {
  it('renders the shell and app info from the preload bridge', async () => {
    renderApp();
    expect(screen.getByRole('heading', { name: 'SignFlow' })).toBeInTheDocument();
    expect(await screen.findByText(/SignFlow v0\.1\.0-test/)).toBeInTheDocument();
  });

  it('camera on → recognizer runs → signs stream → draft appears', async () => {
    const { recognizer } = renderApp();
    expect(screen.getByText('Camera is off')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start camera' }));
    expect(await screen.findByRole('button', { name: 'Stop camera' })).toBeInTheDocument();
    await waitFor(() => expect(recognizer.start).toHaveBeenCalled());
    expect(await screen.findByTestId('recognizer-status')).toHaveTextContent('Recognizing');

    act(() => {
      recognizer.emit('HELLO', 0.95);
      recognizer.emit('NICE', 0.9);
      recognizer.emit('MEET', 0.87);
      recognizer.emit('YOU', 0.93);
    });
    expect(screen.getAllByTestId('sign-row')).toHaveLength(4);
    expect(within(screen.getByTestId('phrase-buffer')).getByText('MEET')).toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId('draft-preview')).toHaveTextContent('Hello, nice to meet you.'));

    fireEvent.click(screen.getByRole('button', { name: 'Stop camera' }));
    expect(recognizer.stop).toHaveBeenCalled();
  });
});
