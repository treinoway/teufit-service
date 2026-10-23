// Step 1 of the public exercise catalog: YouTube -> reviewed JSON (no database).
//
// Titles come from YouTube's public oEmbed endpoint, which also works for UNLISTED
// videos, so a plain list of links is enough. A playlist can be expanded too, but
// that needs `yt-dlp` on PATH (or --yt-dlp <path>).
//
// Usage:
//   npm run catalog:fetch -- https://www.youtube.com/shorts/xdEZIvUOoPE ...
//   npm run catalog:fetch -- --urls-file links.txt
//   npm run catalog:fetch -- --playlist https://www.youtube.com/playlist?list=...
//
// The output file is merged, not overwritten: names/types already in it (possibly
// edited by hand) are kept. Review the diff before committing it.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mergeCatalog, parseYoutubeId, youtubeWatchUrl } from './lib/public-exercise-catalog.js';

const DEFAULT_CATALOG_PATH = 'prisma/seeds/data/teufit-exercise-catalog.json';
const OEMBED_URL = 'https://www.youtube.com/oembed';

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'urls-file': { type: 'string' },
    playlist: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: DEFAULT_CATALOG_PATH },
    'yt-dlp': { type: 'string', default: 'yt-dlp' },
  },
});

function readIdsFromFile(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function expandPlaylist(url, ytDlp) {
  const raw = execFileSync(ytDlp, ['--flat-playlist', '--print', '%(id)s\t%(title)s', url], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { youtubeId: line.slice(0, tab), title: line.slice(tab + 1).trim() };
    });
}

async function fetchTitle(youtubeId) {
  const url = `${OEMBED_URL}?format=json&url=${encodeURIComponent(youtubeWatchUrl(youtubeId))}`;
  const response = await fetch(url);
  if (!response.ok) {
    // 401/403: embedding disabled or private video; 404: removed.
    throw new Error(`oEmbed ${response.status} for ${youtubeId}`);
  }
  const { title } = await response.json();
  return title;
}

async function main() {
  const inputs = [...positionals];
  if (args['urls-file']) inputs.push(...readIdsFromFile(args['urls-file']));

  const invalid = inputs.filter((input) => !parseYoutubeId(input));
  if (invalid.length > 0) {
    throw new Error(`Not a YouTube link or id:\n- ${invalid.join('\n- ')}`);
  }

  const videos = new Map();
  for (const playlist of args.playlist) {
    for (const video of expandPlaylist(playlist, args['yt-dlp'])) videos.set(video.youtubeId, video);
  }

  const failures = [];
  for (const youtubeId of new Set(inputs.map(parseYoutubeId))) {
    if (videos.has(youtubeId)) continue;
    try {
      videos.set(youtubeId, { youtubeId, title: await fetchTitle(youtubeId) });
    } catch (error) {
      failures.push(error.message);
    }
  }

  if (videos.size === 0 && failures.length === 0) {
    throw new Error('Nothing to fetch. Pass links, --urls-file or --playlist.');
  }

  const existing = existsSync(args.out) ? JSON.parse(readFileSync(args.out, 'utf8')) : null;
  const { catalog, added, updated } = mergeCatalog(existing, [...videos.values()]);
  writeFileSync(args.out, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  console.log(`Fetched ${videos.size} video(s): ${added} new, ${updated} title(s) changed.`);
  console.log(`Catalog: ${catalog.entries.length} entries -> ${args.out}`);
  if (failures.length > 0) {
    console.error(`Failed ${failures.length}:\n- ${failures.join('\n- ')}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
