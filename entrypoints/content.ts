import { startHoverZoom } from '../src/hover-zoom';
import { startPriceOverlay } from '../src/price-overlay';
import { createProgressBadge } from '../src/progress-badge';
import { setProgressListener } from '../src/progress';
import { createArchidektAdapter } from '../src/sites/archidekt';
import { createMoxfieldAdapter } from '../src/sites/moxfield';
import { getSettings, watchSettings, type Settings } from '../src/settings';
import { startSwapper } from '../src/swapper';

export default defineContentScript({
  matches: [
    '*://moxfield.com/*',
    '*://www.moxfield.com/*',
    '*://archidekt.com/*',
    '*://www.archidekt.com/*',
  ],
  async main() {
    const site = location.hostname.includes('moxfield')
      ? ('moxfield' as const)
      : ('archidekt' as const);
    const adapter =
      site === 'moxfield' ? createMoxfieldAdapter() : createArchidektAdapter();

    let settings: Settings = await getSettings();

    setProgressListener(createProgressBadge());

    const { rescan, restoreAll } = startSwapper(adapter, () => settings[site]);

    startPriceOverlay(
      adapter,
      () => settings.jpPrices && adapter.isTargetPage(),
      () => settings.priceStore,
    );

    if (adapter.zoomSrc) {
      const zoomSrc = adapter.zoomSrc.bind(adapter);
      const isZoomPage = () =>
        adapter.isZoomPage ? adapter.isZoomPage() : adapter.isTargetPage();
      startHoverZoom(zoomSrc, () => settings.hoverZoom && isZoomPage());
    }

    watchSettings((next) => {
      const wasEnabled = settings[site];
      settings = next;
      if (wasEnabled && !next[site]) restoreAll();
      if (!wasEnabled && next[site]) rescan();
    });
  },
});
