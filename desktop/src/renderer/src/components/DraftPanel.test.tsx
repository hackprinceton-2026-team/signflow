import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { DraftPanel } from './DraftPanel';
import type { ActiveDraft } from '../state/session';

const active: ActiveDraft = {
  draft: { id: 'd', text: 'How are you?', signIds: ['a', 'b'], glosses: ['HOW', 'YOU'], confidence: 0.87, createdAt: 0 },
  text: 'How are you?',
  edited: false,
};

function renderDraft(overrides: Partial<Parameters<typeof DraftPanel>[0]> = {}) {
  const props = {
    draft: active,
    status: 'idle' as const,
    error: null,
    threshold: 0.6,
    confirmLabel: 'Confirm & speak',
    canRetry: true,
    onEdit: vi.fn(),
    onConfirm: vi.fn(),
    onDiscard: vi.fn(),
    onPreview: vi.fn(),
    onRetry: vi.fn(),
    onDismissError: vi.fn(),
    ...overrides,
  };
  render(<DraftPanel {...props} />);
  return props;
}

describe('<DraftPanel />', () => {
  it('shows the editable draft with its source signs and confidence', () => {
    renderDraft();
    expect(screen.getByTestId('draft-text')).toHaveValue('How are you?');
    expect(screen.getByText('HOW · YOU')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Draft confidence' })).toHaveAttribute('aria-valuenow', '87');
  });

  it('edits, confirms (button and ⌘/Ctrl+Enter), previews, and discards', () => {
    const p = renderDraft();
    const box = screen.getByTestId('draft-text');
    fireEvent.change(box, { target: { value: 'How are you doing?' } });
    expect(p.onEdit).toHaveBeenCalledWith('How are you doing?');

    fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true });
    fireEvent.keyDown(box, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(box, { key: 'Enter' }); // plain Enter = newline, not confirm
    expect(p.onConfirm).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: /Confirm & speak/ }));
    expect(p.onConfirm).toHaveBeenCalledTimes(3);
    fireEvent.click(screen.getByRole('button', { name: 'Preview voice' }));
    expect(p.onPreview).toHaveBeenCalledWith('How are you?');
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(p.onDiscard).toHaveBeenCalled();
  });

  it('uses the confirm label it is given', () => {
    renderDraft({ confirmLabel: 'Add to notes' });
    expect(screen.getByRole('button', { name: /^Add to notes/ })).toBeInTheDocument();
  });

  it('disables confirm for an emptied draft', () => {
    renderDraft({ draft: { ...active, text: '   ', edited: true } });
    expect(screen.getByRole('button', { name: /Confirm & speak/ })).toBeDisabled();
    expect(screen.getByText('Edited')).toBeInTheDocument();
  });

  it('shows translating and error states', () => {
    const p = renderDraft({ draft: null, status: 'error', error: 'backend down' });
    expect(screen.getByRole('alert')).toHaveTextContent('Translation failed: backend down');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(p.onRetry).toHaveBeenCalled();
    expect(p.onDismissError).toHaveBeenCalled();
  });

  it('shows an empty state with no draft', () => {
    renderDraft({ draft: null });
    expect(screen.getByTestId('draft-empty')).toHaveTextContent(/Sign a phrase/);
  });
});
