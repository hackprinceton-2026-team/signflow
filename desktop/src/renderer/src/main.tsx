import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/app.css';
import { App } from './App';

// macOS uses an inset title bar; the layout reserves room for the traffic lights.
if (/Macintosh|Mac OS X/.test(navigator.userAgent)) document.documentElement.dataset['platform'] = 'mac';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
