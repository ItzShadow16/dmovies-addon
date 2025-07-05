// updateIndex.js
// 1) Load existing index
const fs      = require('fs').promises;
const axios   = require('axios');
const cheerio = require('cheerio');
const INDEX_PATH = 'docs/myIndex.json';

(async () => {
  const index = JSON.parse(await fs.readFile(INDEX_PATH, 'utf8'));
  const existing = new Set(index.map(item => item.link));

  // 2) Fetch only page 1 (where new movies show up)
  const html = (await axios.get('https://desiremovies.cologne/')).data;
  const $    = cheerio.load(html);

  // 3) Parse the listing posts
  const fresh = $('article.mh-loop-item').map((_, el) => {
    const a     = $(el).find('h3.entry-title a').first();
    const title = a.text().trim();
    const link  = a.attr('href');
    return title && link ? { title, link } : null;
  }).get().filter(Boolean);

  // 4) Filter out ones already in index
  const newItems = fresh.filter(item => !existing.has(item.link));
  if (!newItems.length) {
    console.log('No new movies found on page 1.');
    return;
  }

  // 5) Prepend or append as you like
  const updated = [...newItems, ...index];
  await fs.writeFile(INDEX_PATH, JSON.stringify(updated, null, 2));
  console.log(`Added ${newItems.length} new movie(s) to index.json`);
})();
