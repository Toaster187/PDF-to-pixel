import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import Home from '@/app/page';
import '@/app/globals.css';
import './windows.css';

const root = document.getElementById('root');
if (!root) throw new Error('Desktop-Oberfläche konnte nicht gestartet werden.');

createRoot(root).render(
  <StrictMode>
    <Home />
  </StrictMode>,
);
