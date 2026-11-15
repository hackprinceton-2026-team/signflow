import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionsApp } from './CaptionsApp';
import './captions.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing');

createRoot(root).render(
  <StrictMode>
    <CaptionsApp />
  </StrictMode>,
);
