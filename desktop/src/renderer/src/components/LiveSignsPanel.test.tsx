import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { LiveSignsPanel } from './LiveSignsPanel';
import { DEFAULT_SETTINGS } from '../state/session';
import type { RecognizedSign } from '../adapters/types';

const s = (id: string, gloss: string, confidence: number, final = true): RecognizedSign => ({
  id,
  gloss,
  confidence,
  final,
  ts: 0,
});

function renderPanel(overrides: Partial<Parameters<typeof LiveSignsPanel>[0]> = {}) {
  const props = {
    liveSigns: [s('3', 'YOU', 0.5, false), s('2', 'UM', 0.3), s('1', 'HOW', 0.91)],
    buffer: [s('1', 'HOW', 0.91)],
    settings: DEFAULT_SETTINGS,
    translating: false,
    onThresholdChange: vi.fn(),
    onClearBuffer: vi.fn(),
    onTranslateNow: vi.fn(),
    ...overrides,
  };
  render(<LiveSignsPanel {...props} />);
  return props;
}

describe('<LiveSignsPanel />', () => {
  it('shows each sign with confidence and its state', () => {
    renderPanel();
    const rows = screen.getAllByTestId('sign-row');
    expect(rows).toHaveLength(3);
    expect(within(rows[0]!).getByText('refining')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('low confidence')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('30%')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('accepted')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'HOW confidence' })).toHaveAttribute('aria-valuenow', '91');
  });

  it('shows the current phrase and wires its actions', () => {
    const props = renderPanel();
    expect(within(screen.getByTestId('phrase-buffer')).getByText('HOW')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Translate now' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(props.onTranslateNow).toHaveBeenCalled();
    expect(props.onClearBuffer).toHaveBeenCalled();
  });

  it('changes the confidence threshold', () => {
    const props = renderPanel();
    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.75' } });
    expect(props.onThresholdChange).toHaveBeenCalledWith(0.75);
  });

  it('shows empty states', () => {
    renderPanel({ liveSigns: [], buffer: [] });
    expect(screen.getByText(/will stream here/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for signs…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Translate now' })).toBeDisabled();
  });
});
