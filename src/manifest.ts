import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'YouTube LyricFlow',
  version: '0.2',
  description: 'YouTubeを、最高の音楽体験へ。〜美しい歌詞表示と多彩なビジュアルモードで、音楽に包まれる新しい視聴体験に。',
  permissions: ['scripting', 'storage'],
  content_scripts: [
    {
      matches: ['https://www.youtube.com/*'],
      js: ['src/content/main.tsx']
    }
  ]
});
