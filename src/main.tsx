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
import { adoptedIds, appWindow, initAssetUrls, launchFiles, storeGet, storeSet } from './lib/platform';
import { applySettings, useSettings } from './lib/settings';
import { openTour, startDraftSync, useApp } from './lib/store';
import { toast } from './lib/toast';

async function boot() {
  try {
    await Promise.all([useSettings.getState().load(), initAssetUrls()]);
    const { settings, systemDark } = useSettings.getState();
    applySettings(settings, systemDark);

    // Files passed on the command line (double-clicked in Explorer) win over the restored session's focus.
    const [launch] = await Promise.all([launchFiles().catch(() => [] as string[]), useApp.getState().init()]);
    if (launch.length) await useApp.getState().openPaths(launch);

    // Very first launch with nothing to show: open the tour once.
    if (!(await storeGet<boolean>('seen-tour'))) {
      void storeSet('seen-tour', true);
      if (!useApp.getState().docs.length) await openTour();
    }
  } catch (err) {
    // Whatever went wrong while restoring, the window still opens with something to type on.
    console.error('Margin could not restore everything', err);
    useApp.setState({ ready: true });
    startDraftSync();
    toast.error("Margin couldn't restore everything", 'Your drafts are still in the drafts folder. Restart Margin to try again.');
  }
  // Like Notepad: starting Margin (Win+R "note") with nothing open gives a page to type on.
  if (!useApp.getState().docs.length) useApp.getState().newDoc();

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );

  // The window starts hidden so there is never a white flash: reveal it once the first frame is painted.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    performance.mark('margin-visible'); // read by tools/e2e/bench.mjs
    // A torn-off window must not take focus while its tab is still being dragged: the drop does that.
    void (adoptedIds().length ? appWindow.reveal() : appWindow.show());
  }));

  // The other reading fonts and the editor are only needed later: load them when the app is idle.
  const idle = (fn: () => void) =>
    'requestIdleCallback' in window ? window.requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 400);
  idle(() => {
    void preloadEditor().catch(() => undefined);
    void import('./fonts-extra');
  });
}

// Last resort: never leave the hidden window hidden.
void boot().catch((err) => {
  console.error(err);
  void appWindow.show();
});
