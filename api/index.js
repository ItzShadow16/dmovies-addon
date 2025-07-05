// api/index.js
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const cheerio = require('cheerio');

////////////////////////////////////////////////////////////////////////////////
// 1) Load your DesireMovies index.json
////////////////////////////////////////////////////////////////////////////////
const INDEX = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../myIndex.json'), 'utf8')
);

////////////////////////////////////////////////////////////////////////////////
// 2) Your add-on manifest
////////////////////////////////////////////////////////////////////////////////
const manifest = {
  id:         'org.desiremovies.multistream',
  version:    '1.0.12',
  version:    '1.0.13',
  name:       'DesireMovies Multi-Quality',
  description:'IMDb scrape, "&"→"and", captures 4K/2160p, quality scoring, skips non-GD links',
  resources:  ['stream'],
  types:      ['movie'],
  idPrefixes: ['tt'],
  catalogs:   []
};

////////////////////////////////////////////////////////////////////////////////
// 3) Helper functions
////////////////////////////////////////////////////////////////////////////////
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '');
}

function containsBannedWords(title) {
  const banned = ['CAMRip','WEBRip','TAM','TEL','1XBET','4RABET'];
  return banned.some(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(title)
  );
}

function scoreTitle(title) {
  const t = title.toLowerCase();
  let score = 0;
  if (t.includes('org'))                    score += 5;
  if (t.includes('dual audio'))             score += 4;
  if (t.includes('hindi'))                  score += 3;
  if (t.includes('4k') || t.includes('2160p')) score += 3;
  if (t.includes('1080p'))                  score += 2;
  if (t.includes('web-hdrip'))              score += 2;
  if (t.includes('voice over'))             score -= 5;
  if (t.includes('multi audio') && !t.includes('dual audio')) score -= 3;
  return score;
}

////////////////////////////////////////////////////////////////////////////////
// 4) Full resolveFinalUrl implementation
////////////////////////////////////////////////////////////////////////////////
async function resolveFinalUrl(gdLink) {
  // Step 1: Fetch the initial page
  let html = (await axios.get(gdLink)).data;
  let $    = cheerio.load(html);

  // Try to find a form action or a direct "download" link
  const form    = $('form').first();
  let openUrl   = form.length
    ? form.attr('action')
    : $('a').filter((i,a) => /link|download/i.test($(a).text())).attr('href');
  openUrl = openUrl.startsWith('http')
    ? openUrl
    : new URL(openUrl, gdLink).href;

  // Step 2: Follow to the next page (gyanigurus → HubCloud)
  html = (await axios.get(openUrl)).data;
  $    = cheerio.load(html);

  // Find the HubCloud link
  const hubLink = $('a').map((i,a) => $(a).attr('href')).get()
    .find(u => u && u.includes('hubcloud'));
  if (!hubLink) throw new Error('HubCloud link not found');

  // GET the HubCloud page
  html = (await axios.get(hubLink)).data;
  let $hc = cheerio.load(html);

  // Step 3: Look for a "Generate direct download link" form
  const genForm = $hc('form').filter((i,el) => {
    return $hc(el).find('input[type="submit"]').filter((j,btn) =>
      /generate direct download link/i.test($hc(btn).attr('value')||'')
    ).length > 0;
  }).first();

  // If that form exists, submit it
  if (genForm.length) {
    const action   = genForm.attr('action');
    const formData = new URLSearchParams();
    genForm.find('input[type="hidden"]').each((i,inp) => {
      formData.append($hc(inp).attr('name'), $hc(inp).attr('value'));
    });
    genForm.find('input[type="submit"]').each((i,btn) => {
      const n = $hc(btn).attr('name'), v = $hc(btn).attr('value');
      if (n) formData.append(n, v);
    });
    html = (await axios.post(action, formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })).data;
    $hc = cheerio.load(html);
  }

  // Step 4: Find the actual download trigger
  let trigger = $hc('a').map((i,a) => $hc(a).attr('href')).get()
    .find(u =>
      u &&
      /download/i.test($hc(`a[href="${u}"]`).text()) &&
      !/\.(mkv|mp4|webm)(\?.*)?$/i.test(u)
    );
  if (trigger) {
    trigger = trigger.startsWith('http')
      ? trigger
      : new URL(trigger, hubLink).href;
    html    = (await axios.get(trigger)).data;
    $hc     = cheerio.load(html);
  }

  // Step 5: Finally pick the .mkv/.mp4/.webm link
  let finalUrl = $hc('a').map((i,a) => $hc(a).attr('href')).get()
    .find(u => /\.(mkv|mp4|webm)(\?.*)?$/i.test(u));
  if (!finalUrl) {
    finalUrl = $hc('video source').attr('src')
             || (html.match(/https?:\/\/[^\s'"]+\.mkv/)||[])[0];
  }
  if (!finalUrl) throw new Error('No video link found');
  return finalUrl.startsWith('http')
    ? finalUrl
    : new URL(finalUrl, hubLink).href;
}

////////////////////////////////////////////////////////////////////////////////
// 5) Stream‐handler logic
////////////////////////////////////////////////////////////////////////////////
async function handleStream(id) {
  // 5.1 Scrape IMDb for title & year
  let scrapedTitle = '', scrapedYear = '';
  if (/^tt\d+$/.test(id)) {
    try {
      const res  = await axios.get(`https://www.imdb.com/title/${id}/`, {
        headers: {
          'User-Agent':      'Mozilla/5.0',
          'Accept-Language': 'en-US,en;q=0.9'
        }
      });
      const $    = cheerio.load(res.data);
      const raw  = $('meta[property="og:title"]').attr('content') || $('title').text();
      const match= raw.match(/^(.+?)\s*\((\d{4})\)/);
      if (match) {
        scrapedTitle = match[1].trim();
        scrapedYear  = match[2];
      }
    }
    catch (_) { return { streams: [] }; }
  }
  if (!scrapedTitle || !scrapedYear) { return { streams: [] }; }

  // 5.2 Find matching entries in INDEX
  const base       = scrapedTitle.split(':')[0].trim();
  const year       = scrapedYear;
  const candidates = INDEX.filter(item => {
    if (containsBannedWords(item.title)) return false;
    const norm = normalize(item.title);
    return norm.includes(normalize(base)) && norm.includes(year);
  });
  if (!candidates.length) { return { streams: [] }; }

  // 5.3 Choose the best‐scoring entry
  const prefix = normalize(`${base} ${year}`);
  const exact  = candidates.filter(item =>
    normalize(item.title).startsWith(prefix)
  );
  const pool   = exact.length ? exact : candidates;
  const entry  = pool.sort((a,b) => scoreTitle(b.title) - scoreTitle(a.title))[0];

  // 5.4 Scrape available qualities from the detail page
  const detailHtml = (await axios.get(entry.link)).data;
  const $d         = cheerio.load(detailHtml);
  const qualities  = [];
  $d('p').filter((i,p) => {
    const txt = $d(p).text().trim();
    return /(\d{3,4}p|4k)/i.test(txt)
        && /\[\s*[\d.]+\s*(GB|MB)\s*\]/i.test(txt);
  }).each((i,p) => {
    const label    = $d(p).text().trim();
    const gdAnchor = $d(p).nextAll('p:has(a:contains("GD & DOWNLOAD"))')
                        .first().find('a:contains("GD & DOWNLOAD")');
    const gdLink   = gdAnchor.attr('href');
    if (gdLink) qualities.push({ label, link: gdLink });
  });

  // 5.5 Resolve each to a streaming URL
  const streams = await Promise.all(qualities.map(async q => {
    const quality = (q.label.match(/(\d{3,4}p|4k)/i)||[])[0].toUpperCase() || 'SD';
    const size    = (q.label.match(/[\d.]+\s*(GB|MB)/i)||[])[0] || '';
    try {
      const url = await resolveFinalUrl(q.link);
      return {
        title:     `DesireMovies – ${quality} [${size}]`,
        url,
        quality,
        size,
        release:   q.label,
        pkg:       { provider: 'HubCloud' },
        streaming: 'progressive'
      };
    }
    catch (_) {
      return {
        title:   `DesireMovies – ${quality} [${size}] Not Available`,
        url:     null,
        quality,
        size,
        release: `${q.label} Not Available`
      };
    }
  }));

  return { streams };
}

////////////////////////////////////////////////////////////////////////////////
// 6) Vercel entrypoint
////////////////////////////////////////////////////////////////////////////////
// at the top of your file, keep all your existing imports, helpers, manifest, etc.

////////////////////////////////////////////////////////////////////////////////
// Vercel entrypoint with CORS
////////////////////////////////////////////////////////////////////////////////
module.exports = async (req, res) => {
  // 1) Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 2) Reply to preflight and return
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

// 3) Log every incoming request for Stremio-debugging
  console.log('STREMIO REQUEST:', req.method, req.url);

  // 3) Your existing logic follows
  try {
    // Log requests if you want
    console.log('→ Request URL:', req.url);

    const urlObj   = new URL(req.url, `https://${req.headers.host}`);
    const pathname = urlObj.pathname;
    const params   = urlObj.searchParams;

    if (pathname === '/manifest.json') {
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(manifest));
    }

    if (pathname === '/stream') {
      const id = params.get('id');
      if (!id) {
        res.statusCode = 400;
        return res.end('Error: missing id parameter');
      }
      const result = await handleStream(id);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(result));
    }

    // fallback
    res.statusCode = 404;
    return res.end('Not found');
  }
  catch (err) {
    console.error('Uncaught error:', err);
    res.statusCode = 500;
    return res.end('Internal Server Error');
  }
};
