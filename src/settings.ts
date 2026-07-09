import { browser } from 'wxt/browser';

export interface Settings {
  moxfield: boolean;
  archidekt: boolean;
  /** Archidektのホバー拡大表示(Moxfieldには標準機能があるため不要) */
  hoverZoom: boolean;
  /** 日本の店舗価格(晴れる屋/Wisdom Guild)の表示 */
  jpPrices: boolean;
}

const DEFAULTS: Settings = {
  moxfield: true,
  archidekt: true,
  hoverZoom: true,
  jpPrices: true,
};
const KEY = 'settings';

export async function getSettings(): Promise<Settings> {
  const stored = await browser.storage.sync.get(KEY);
  return { ...DEFAULTS, ...(stored[KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await browser.storage.sync.set({ [KEY]: settings });
}

export function watchSettings(callback: (settings: Settings) => void): void {
  browser.storage.sync.onChanged.addListener((changes) => {
    if (changes[KEY]) {
      callback({ ...DEFAULTS, ...(changes[KEY].newValue as Partial<Settings>) });
    }
  });
}
