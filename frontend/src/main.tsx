import '@fontsource/manrope/400.css';
import '@fontsource/manrope/500.css';
import '@fontsource/manrope/600.css';
import '@fontsource/manrope/700.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AppRoot } from './app/app-root.js';
import { getFrontendEnv } from './platform/env/index.js';
import './styles/global.css';

// Fail fast on invalid public env before mounting the UI.
getFrontendEnv();

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <AppRoot />
  </StrictMode>,
);
