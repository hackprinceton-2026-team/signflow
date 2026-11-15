import { describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DraftOverlay, type DraftOverlayProps } from './DraftOverlay';
import type { ActiveDraft } from '../state/session';

const active: ActiveDraft = {
  draft: { id: 'd', text: 'How are you?', signIds: ['a', 'b'], glosses: ['HOW', 'YOU'], confidence: 0.87, createdAt: 0 },
  text: 'How are you?',
  edited: false,
};

function renderDraft(overrides: Partial<DraftOverlayProps> = {}) {
  const props: DraftOverlayProps = {
    draft: active,
    status: 'idle',
    error: null,
    threshold: 0.6,
    canRetry: true,
    canSpeak: true,
    onEdit: vi.fn(),
    onConfirm: vi.fn(),
    onSpeak: vi.fn(),
    onDiscard: vi.fn(),
    onRetry: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  render(<DraftOverlay {...props} />);
  return props;
}

describe('<DraftOverlay />', () => {
  it('shows the editable draft with its source signs and confidence', () => {
    renderDraft();
    expect(screen.getByRole('region', { name: 'English draft' })).toBeInTheDocument();
    expect(screen.getByTestId('draft-text')).toHaveValue('How are you?');
    expect(screen.getByLabelText(/Draft text/)).toBe(screen.getByTestId('draft-text'));
    expect(screen.getByText('HOW · YOU')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Draft confidence' })).toHaveAttribute('aria-valuenow', '87');
    expect(screen.getByText('Draft ready: How are you?')).toBeInTheDocument(); // live region
  });

  it('offers Confirm, Speak, Edit, and Discard', () => {
    const p = renderDraft();
    fireEvent.click(screen.getByRole('button', { name: /^Confirm/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Speak/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(p.onConfirm).toHaveBeenCalledTimes(1);
    expect(p.onSpeak).toHaveBeenCalledTimes(1);
    expect(p.onDiscard).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByTestId('draft-text')).toHaveFocus();
  });

  it('edits text; ⌘/Ctrl+Enter confirms, ⌘/Ctrl+Shift+Enter speaks, plain Enter does neither', () => {
    const p = renderDraft();
    const box = screen.getByTestId('draft-text');
    fireEvent.change(box, { target: { value: 'How are you doing?' } });
    expect(p.onEdit).toHaveBeenCalledWith('How are you doing?');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(p.onConfirm).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true, shiftKey: true });
    expect(p.onSpeak).toHaveBeenCalledTimes(1);
    expect(p.onConfirm).toHaveBeenCalledTimes(2);
  });

  it('Speak is disabled (button and shortcut) when no speech engine is available', () => {
    const p = renderDraft({ canSpeak: false });
    const speak = screen.getByRole('button', { name: /^Speak/ });
    expect(speak).toBeDisabled();
    expect(speak).toHaveAttribute('title', 'Speech is unavailable on this system');
    fireEvent.keyDown(screen.getByTestId('draft-text'), { key: 'Enter', metaKey: true, shiftKey: true });
    expect(p.onSpeak).not.toHaveBeenCalled();
  });

  it('an emptied draft cannot be confirmed or spoken', () => {
    renderDraft({ draft: { ...active, text: '   ', edited: true } });
    expect(screen.getByRole('button', { name: /^Confirm/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Speak/ })).toBeDisabled();
    expect(screen.getByText('Edited')).toBeInTheDocument();
  });

  it('shows translating and error states', () => {
    const first = renderDraft({ draft: null, status: 'translating' });
    expect(screen.getByRole('status')).toHaveTextContent('Translating…');
    expect(first.onConfirm).not.toHaveBeenCalled();
    cleanup();

    const p = renderDraft({ draft: null, status: 'error', error: 'backend down' });
    expect(screen.getByRole('alert')).toHaveTextContent('Translation failed: backend down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(p.onRetry).toHaveBeenCalled();
    expect(p.onDismissError).toHaveBeenCalled();
  });

  it('shows the hint only when asked, otherwise renders nothing without a draft', () => {
    renderDraft({ draft: null });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.queryByTestId('draft-empty')).not.toBeInTheDocument();
    cleanup();
    renderDraft({ draft: null, showHint: true });
    expect(screen.getByTestId('draft-empty')).toHaveTextContent(/Sign a phrase, then pause/);
  });
});
