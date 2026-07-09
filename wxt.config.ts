import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'MTG デッキ日本語化',
    description:
      'Moxfield / Archidekt のデッキ画面・Playtest画面でカード画像を日本語版に差し替えます。ホバー拡大などの補助機能付き',
    permissions: ['storage'],
    host_permissions: ['https://api.scryfall.com/*'],
  },
});
