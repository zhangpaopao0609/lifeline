import './styles/tokens.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { installPageZoomLock } from './lib/page-zoom';
import { bindSocket } from './net/bind';

installPageZoomLock();
bindSocket();

// History mode: the URL is the real path (`/` landing, `/console` console); back/forward is left to the browser.
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
