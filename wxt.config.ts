import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'MTG Playtest 日本語化',
    description:
      'Moxfield / Archidekt のPlaytest画面でカード画像を日本語版に差し替えます。ホバー拡大などの補助機能付き',
    permissions: ['storage'],
    host_permissions: ['https://api.scryfall.com/*'],
  },
});
