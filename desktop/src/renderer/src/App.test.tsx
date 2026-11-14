import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';
import { installFakeBridge } from './test/setup';

describe('<App />', () => {
  it('renders the shell and app info from the preload bridge', async () => {
    installFakeBridge();
    render(<App />);
    expect(screen.getByRole('heading', { name: 'SignFlow' })).toBeInTheDocument();
    expect(await screen.findByText(/SignFlow v0\.1\.0-test/)).toBeInTheDocument();
  });
});
