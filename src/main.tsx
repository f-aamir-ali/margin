import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
// The default plain-text font: needed on first paint for .txt files.
import '@fontsource/ia-writer-mono/400.css';
import '@fontsource/ia-writer-mono/400-italic.css';
import '@fontsource/ia-writer-mono/700.css';
import 'katex/dist/katex.min.css';
import '@milkdown/crepe/theme/common/style.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './styles/prose.css';
import './styles/crepe.css';

import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { preloadEditor } from './App';
import { appWindow, initAssetUrls, launchFiles, storeGet, storeSet } from './lib/platform';
import { applySettings, useSettings } from './lib/settings';
import { openTour, useApp } from './lib/store';

async function boot() {
  await Promise.all([useSettings.getState().load(), initAssetUrls()]);
  const { settings, systemDark } = useSettings.getState();
  applySettings(settings, systemDark);

  // Files passed on the command line (double-clicked in Explorer) win over the restored session's focus.
  const launch = await launchFiles().catch(() => [] as string[]);
  await useApp.getState().init();
  if (launch.length) await useApp.getState().openPaths(launch);

  // Very first launch with nothing to show: open the tour once.
  if (!(await storeGet<boolean>('seen-tour'))) {
    void storeSet('seen-tour', true);
    if (!useApp.getState().docs.length) await openTour();
  }
  // Like Notepad: starting Margin (Win+R "note") with nothing open gives a page to type on.
  if (!useApp.getState().docs.length) useApp.getState().newDoc();

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // The window starts hidden so there is never a white flash: reveal it once the first frame is painted.
  requestAnimationFrame(() => requestAnimationFrame(() => void appWindow.show()));

  // The other reading fonts are only needed if chosen: load them after first paint.
  setTimeout(() => {
    void import('./fonts-extra');
    void preloadEditor().catch(() => undefined);
  }, 400);
}

void boot();
