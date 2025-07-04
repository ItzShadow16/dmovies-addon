#!/usr/bin/env node
// server.js
// Stremio add-on: DesireMovies Multi-Quality
// Matches IMDb IDs by scraping IMDb page title (no APIs, no keys)
// Handles "&"→"and", filters CAMRip/WEBRip/TAM/TEL/1XBET/4RABET,
// prioritizes best entry, captures both 2160p and 4K, skips non-GD links.

const fs      = require('fs')
const path    = require('path')
const axios   = require('axios')
const cheerio = require('cheerio')
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk')

////////////////////////////////////////////////////////////////////////////////
// 1) Load your DesireMovies index.json
////////////////////////////////////////////////////////////////////////////////
const INDEX = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'myIndex.json'), 'utf8')
)

////////////////////////////////////////////////////////////////////////////////
// 2) Manifest – only `stream`
////////////////////////////////////////////////////////////////////////////////
const manifest = {
  id:         'org.desiremovies.multistream',
  version:    '1.0.12',
  name:       'DesireMovies Multi-Quality',
  description:'IMDb scrape, "&"→"and", captures 4K/2160p, quality scoring, skips non-GD links',
  resources:  ['stream'],
  types:      ['movie'],
  idPrefixes: [''],
  catalogs:   []
}

const builder = new addonBuilder(manifest)

////////////////////////////////////////////////////////////////////////////////
// 3) Helpers
////////////////////////////////////////////////////////////////////////////////
function normalize(s) {
  return s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]/g, '')
}

function containsBannedWords(title) {
  const banned = ['CAMRip','WEBRip','TAM','TEL','1XBET','4RABET']
  return banned.some(w =>
    new RegExp(`\\b${w}\\b`, 'i').test(title)
  )
}

function scoreTitle(title) {
  const t = title.toLowerCase()
  let score = 0
  if (t.includes('org'))           score += 5
  if (t.includes('dual audio'))    score += 4
  if (t.includes('hindi'))         score += 3
  if (t.includes('4k') || t.includes('2160p')) score += 3
  if (t.includes('1080p'))         score += 2
  if (t.includes('web-hdrip'))     score += 2
  if (t.includes('voice over'))    score -= 5
  if (t.includes('multi audio') && !t.includes('dual audio')) score -= 3
  return score
}

////////////////////////////////////////////////////////////////////////////////
// 4) resolveFinalUrl: multi-step gyanigurus→HubCloud→.mkv
////////////////////////////////////////////////////////////////////////////////
async function resolveFinalUrl(gdLink) {
  let html = (await axios.get(gdLink)).data
  let $    = cheerio.load(html)

  const form = $('form').first()
  let openUrl = form.length
    ? form.attr('action')
    : $('a').filter((i,a) => /link|download/i.test($(a).text())).attr('href')
  openUrl = openUrl.startsWith('http') ? openUrl : new URL(openUrl, gdLink).href

  html = (await axios.get(openUrl)).data
  $    = cheerio.load(html)
  const hubLink = $('a').map((i,a) => $(a).attr('href')).get()
    .find(u => u && u.includes('hubcloud'))
  if (!hubLink) throw new Error('HubCloud link not found')

  html = (await axios.get(hubLink)).data
  let $hc = cheerio.load(html)
  const genForm = $hc('form').filter((i,el) => {
    return $hc(el).find('input[type="submit"]').filter((j,btn) =>
      /generate direct download link/i.test($hc(btn).attr('value')||'')
    ).length > 0
  }).first()
  if (genForm.length) {
    const action   = genForm.attr('action')
    const formData = new URLSearchParams()
    genForm.find('input[type="hidden"]').each((i,inp) => {
      formData.append($hc(inp).attr('name'), $hc(inp).attr('value'))
    })
    genForm.find('input[type="submit"]').each((i,btn) => {
      const n = $hc(btn).attr('name'), v = $hc(btn).attr('value')
      if (n) formData.append(n, v)
    })
    html = (await axios.post(action, formData.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    })).data
    $hc  = cheerio.load(html)
  }

  let trigger = $hc('a').map((i,a) => $hc(a).attr('href')).get()
    .find(u => u
      && /download/i.test($hc(`a[href="${u}"]`).text())
      && !/\.(mkv|mp4|webm)(\?.*)?$/i.test(u)
    )
  if (trigger) {
    trigger = trigger.startsWith('http') ? trigger : new URL(trigger, hubLink).href
    html    = (await axios.get(trigger)).data
    $hc     = cheerio.load(html)
  }

  let finalUrl = $hc('a').map((i,a) => $hc(a).attr('href')).get()
    .find(u => /\.(mkv|mp4|webm)(\?.*)?$/i.test(u))
  if (!finalUrl) {
    finalUrl = $hc('video source').attr('src')
             || (html.match(/https?:\/\/[^\s'"]+\.mkv/)||[])[0]
  }
  if (!finalUrl) throw new Error('No video link found')
  return finalUrl.startsWith('http') ? finalUrl : new URL(finalUrl, hubLink).href
}

////////////////////////////////////////////////////////////////////////////////
// 5) Stream handler: scrape IMDb, match & prioritize
////////////////////////////////////////////////////////////////////////////////
builder.defineStreamHandler(async ({ type, id }) => {
  if (type !== 'movie') return { streams: [] }

  console.log(`Incoming ID: ${id}`)
  let scrapedTitle = '', scrapedYear = ''
  if (/^tt\d+$/.test(id)) {
    try {
      const imdbUrl = `https://www.imdb.com/title/${id}/`
      const html = (await axios.get(imdbUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept': 'text/html,application/xhtml+xml',
          'Referer': 'https://www.google.com/'
        }
      })).data
      const $   = cheerio.load(html)
      const raw = $('meta[property="og:title"]').attr('content') || $('title').text()
      const m   = raw.match(/^(.+?)\s*\((\d{4})\)/)
      if (m) {
        scrapedTitle = m[1].trim()
        scrapedYear  = m[2]
      }
    } catch (err) {
      console.warn(`⚠️ IMDb scrape failed: ${err.message}`)
      return { streams: [] }
    }
  }
  if (!scrapedTitle || !scrapedYear) {
    console.warn(`⚠️ Could not extract title/year for ${id}`)
    return { streams: [] }
  }
  console.log(`✔ IMDb title: ${scrapedTitle} (${scrapedYear})`)

  // Base title before colon, handle "&"→"and"
  const base = scrapedTitle.split(':')[0].trim()
  const year = scrapedYear

  // Find candidates matching base + year, excluding banned pages
  const candidates = INDEX.filter(item => {
    if (containsBannedWords(item.title)) return false
    const norm = normalize(item.title)
    return norm.includes(normalize(base)) && norm.includes(year)
  })
  if (!candidates.length) {
    console.warn(`No match for "${base} (${year})"`)
    return { streams: [] }
  }

  // Prefer entries whose normalized title starts with "base year"
  const prefix = normalize(`${base} ${year}`)
  const exact  = candidates.filter(item =>
    normalize(item.title).startsWith(prefix)
  )
  const pool = exact.length ? exact : candidates

  // Pick highest-scoring entry
  const entry = pool.sort((a,b) => scoreTitle(b.title) - scoreTitle(a.title))[0]
  console.log(`✔ Selected: ${entry.title} → ${entry.link}`)

  // Scrape quality blocks, capturing 2160p or 4K and skipping non-GD
  const detailHtml = (await axios.get(entry.link)).data
  const $d         = cheerio.load(detailHtml)
  const qualities  = []
  $d('p').filter((i,p) => {
    const txt = $d(p).text().trim()
    return /(\d{3,4}p|4k)/i.test(txt)
        && /\[\s*[\d.]+\s*(GB|MB)\s*\]/i.test(txt)
  }).each((i,p) => {
    const label     = $d(p).text().trim()
    const gdAnchor  = $d(p)
      .nextAll('p:has(a:contains("GD & DOWNLOAD"))')
      .first()
      .find('a:contains("GD & DOWNLOAD")')
    const gdLink    = gdAnchor.attr('href')
    if (gdLink) qualities.push({ label, link: gdLink })
  })

  // Resolve streams and include size in title
  const streams = await Promise.all(qualities.map(async q => {
    const quality = (q.label.match(/(\d{3,4}p|4k)/i)||[])[0].toUpperCase() || 'SD'
    const size    = (q.label.match(/[\d.]+\s*(GB|MB)/i)||[])[0] || ''
    try {
      const url = await resolveFinalUrl(q.link)
      console.log(`[OK] ${q.label} → ${url}`)
      return {
        title:     `DesireMovies – ${quality} [${size}]`,
        url,
        quality,
        size,
        release:   q.label,
        pkg:       { provider: 'HubCloud' },
        streaming: 'progressive'
      }
    } catch (err) {
      console.warn(`[ERR] ${q.label} → ${err.message}`)
      return {
        title:     `DesireMovies – ${quality} [${size}] Not Available`,
        url:       null,
        quality,
        size,
        release:   `${q.label} Not Available`
      }
    }
  }))

  return { streams }
})

////////////////////////////////////////////////////////////////////////////////
// 6) Start HTTP server
////////////////////////////////////////////////////////////////////////////////
serveHTTP(builder.getInterface(), {
  port: process.env.PORT || 7003
})