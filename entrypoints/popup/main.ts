import { clearCache } from '../../src/cache';
import { getSettings, saveSettings } from '../../src/settings';

const moxfieldInput = document.getElementById('moxfield') as HTMLInputElement;
const archidektInput = document.getElementById('archidekt') as HTMLInputElement;
const hoverZoomInput = document.getElementById('hover-zoom') as HTMLInputElement;
const jpPricesInput = document.getElementById('jp-prices') as HTMLInputElement;
const priceStoreSelect = document.getElementById('price-store') as HTMLSelectElement;
const clearButton = document.getElementById('clear-cache') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLSpanElement;

async function init(): Promise<void> {
  const settings = await getSettings();
  moxfieldInput.checked = settings.moxfield;
  archidektInput.checked = settings.archidekt;
  hoverZoomInput.checked = settings.hoverZoom;
  jpPricesInput.checked = settings.jpPrices;
  priceStoreSelect.value = settings.priceStore;
}

async function onChange(): Promise<void> {
  await saveSettings({
    moxfield: moxfieldInput.checked,
    archidekt: archidektInput.checked,
    hoverZoom: hoverZoomInput.checked,
    jpPrices: jpPricesInput.checked,
    priceStore: priceStoreSelect.value,
  });
}

moxfieldInput.addEventListener('change', () => void onChange());
archidektInput.addEventListener('change', () => void onChange());
hoverZoomInput.addEventListener('change', () => void onChange());
jpPricesInput.addEventListener('change', () => void onChange());
priceStoreSelect.addEventListener('change', () => void onChange());

clearButton.addEventListener('click', () => {
  void clearCache().then(() => {
    status.textContent = 'クリアしました';
    setTimeout(() => (status.textContent = ''), 2000);
  });
});

void init();
