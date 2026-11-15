import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  Button,
  Card,
  ConfidenceMeter,
  formatPercent,
  Icon,
  ICON_NAMES,
  IconButton,
  Kbd,
  RangeField,
  SelectField,
  shortcutKeys,
  shortcutLabel,
  StatusPill,
  Switch,
} from './index';

describe('Icon', () => {
  it('is decorative by default and labeled when given a title', () => {
    const { container } = render(
      <>
        <Icon name="camera" />
        <Icon name="speaker" title="Speaking" />
      </>,
    );
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('img', { name: 'Speaking' })).toBeInTheDocument();
  });

  it('renders drawable geometry for every icon in the set', () => {
    for (const name of ICON_NAMES) {
      const { container, unmount } = render(<Icon name={name} />);
      expect(container.querySelectorAll('path, rect, circle').length, name).toBeGreaterThan(0);
      unmount();
    }
  });
});

describe('Button / IconButton', () => {
  it('renders label, icon, and a decorative shortcut hint', () => {
    const onClick = vi.fn();
    render(
      <Button variant="primary" icon="check" shortcut={<Kbd combo="Mod+Enter" />} onClick={onClick}>
        Confirm
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Confirm' });
    expect(btn).toHaveAttribute('type', 'button');
    expect(btn).toHaveClass('ui-btn-primary');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalled();
  });

  it('icon-only buttons always have an accessible name and tooltip', () => {
    render(<IconButton icon="close" label="Close captions" />);
    const btn = screen.getByRole('button', { name: 'Close captions' });
    expect(btn).toHaveAttribute('title', 'Close captions');
  });

  it('supports toggle state through aria-pressed', () => {
    render(<IconButton icon="captions" label="Captions" aria-pressed={true} />);
    expect(screen.getByRole('button', { name: 'Captions' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Switch', () => {
  it('is a labeled, described switch that toggles', () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Capture to notes" description="Adds confirmed text" />);
    const sw = screen.getByRole('switch', { name: 'Capture to notes' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription('Adds confirmed text');
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('respects disabled', () => {
    const onChange = vi.fn();
    render(<Switch checked onChange={onChange} label="X" disabled />);
    fireEvent.click(screen.getByRole('switch', { name: 'X' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('RangeField / SelectField', () => {
  it('labels the slider, shows formatted value, and emits numbers', () => {
    const onChange = vi.fn();
    render(<RangeField label="Rate" value={1} min={0.5} max={2} step={0.1} format={(v) => `${v.toFixed(1)}×`} onChange={onChange} />);
    const slider = screen.getByRole('slider', { name: 'Rate' });
    expect(slider).toHaveAttribute('aria-valuetext', '1.0×');
    expect(screen.getByText('1.0×')).toBeInTheDocument();
    fireEvent.change(slider, { target: { value: '1.5' } });
    expect(onChange).toHaveBeenCalledWith(1.5);
  });

  it('select keeps option value types', () => {
    const onChange = vi.fn();
    render(
      <SelectField
        label="Lines"
        value={2}
        options={[1, 2, 3].map((n) => ({ value: n, label: String(n) }))}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: 'Lines' }), { target: { value: '3' } });
    expect(onChange).toHaveBeenCalledWith(3);
  });
});

describe('StatusPill / Kbd / Card / ConfidenceMeter', () => {
  it('status pills carry text, not only color', () => {
    render(<StatusPill tone="success">Ready</StatusPill>);
    expect(screen.getByText('Ready')).toBeInTheDocument();
  });

  it('formats shortcuts per platform', () => {
    expect(shortcutKeys('Mod+Shift+Enter', true)).toEqual(['⌘', '⇧', '↵']);
    expect(shortcutKeys('Mod+Shift+Enter', false)).toEqual(['Ctrl', 'Shift', 'Enter']);
    expect(shortcutLabel('Mod+1', true)).toBe('⌘1');
    expect(shortcutLabel('Mod+1', false)).toBe('Ctrl+1');
  });

  it('cards expose a heading', () => {
    render(<Card title="Conversation">body</Card>);
    expect(screen.getByRole('heading', { name: 'Conversation', level: 2 })).toBeInTheDocument();
  });

  it('confidence meter announces value and threshold state', () => {
    render(<ConfidenceMeter confidence={0.42} threshold={0.6} label="HELLO confidence" />);
    const meter = screen.getByRole('meter', { name: 'HELLO confidence' });
    expect(meter).toHaveAttribute('aria-valuenow', '42');
    expect(meter).toHaveAttribute('aria-valuetext', '42 percent, below threshold');
  });

  it('never shows a below-threshold confidence as reaching the threshold', () => {
    // 59.6% is rejected at a 60% threshold, so it must not read "60%".
    expect(formatPercent(0.596)).toBe('59%');
    expect(formatPercent(0.6)).toBe('60%');
    expect(formatPercent(0.57)).toBe('57%'); // 0.57 * 100 is 56.999… in floating point
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(1.4)).toBe('100%');
    expect(formatPercent(-0.2)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
    render(<ConfidenceMeter confidence={0.596} threshold={0.6} label="Edge" />);
    expect(screen.getByRole('meter', { name: 'Edge' })).toHaveAttribute('aria-valuetext', '59 percent, below threshold');
  });
});
