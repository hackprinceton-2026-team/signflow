import { beforeEach, describe, expect, it } from 'vitest';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotesPanel } from './NotesPanel';
import { useNotes, type NotesController } from '../hooks/useNotes';
import { installFakeBridge } from '../test/setup';

const handle: { current: NotesController | null } = { current: null };
function Harness() {
  const notes = useNotes('test.notes');
  useEffect(() => {
    handle.current = notes;
  });
  return <NotesPanel notes={notes} />;
}
const controller = new Proxy({} as NotesController, {
  get: (_t, key: keyof NotesController) => handle.current![key],
});

describe('<NotesPanel />', () => {
  beforeEach(() => localStorage.clear());

  it('shows appended sentences and persists them across remounts', () => {
    installFakeBridge();
    const { unmount } = render(<Harness />);
    act(() => controller.append('Hello, nice to meet you.'));
    expect((screen.getByTestId('note-body') as HTMLTextAreaElement).value).toContain('Hello, nice to meet you.');
    unmount();

    render(<Harness />);
    expect((screen.getByTestId('note-body') as HTMLTextAreaElement).value).toContain('Hello, nice to meet you.');
  });

  it('copies and exports Markdown through the bridge', async () => {
    const bridge = installFakeBridge();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Note title'), { target: { value: 'Lecture 3' } });
    fireEvent.change(screen.getByTestId('note-body'), { target: { value: 'Key point' } });

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(bridge.clipboard.writeText).toHaveBeenCalledWith(expect.stringMatching(/^# Lecture 3/)));
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Export .md' }));
    await waitFor(() =>
      expect(bridge.notes.exportMarkdown).toHaveBeenCalledWith({
        suggestedName: 'Lecture 3',
        content: expect.stringContaining('Key point'),
      }),
    );
    expect(await screen.findByText('Saved notes.md')).toBeInTheDocument();
  });

  it('disables copy/export for an empty note', () => {
    installFakeBridge();
    render(<Harness />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export .md' })).toBeDisabled();
  });

  it('creates, switches, and deletes notes with confirmation', () => {
    installFakeBridge();
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '+ New note' }));
    expect(controller.state.notes).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(controller.state.notes).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'Delete…' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(controller.state.notes).toHaveLength(1);
  });

  it('toggles timestamps', () => {
    installFakeBridge();
    render(<Harness />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Timestamps' }));
    act(() => controller.append('Plain line'));
    expect(screen.getByTestId('note-body')).toHaveValue('Plain line');
  });
});
