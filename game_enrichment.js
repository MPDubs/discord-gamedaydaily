require('dotenv').config();
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const enrichmentCache = new Map();

function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch (_err) {
    // Continue to bracket extraction.
  }

  const start = direct.indexOf('{');
  const end = direct.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(direct.slice(start, end + 1));
  } catch (_err) {
    return null;
  }
}

function cleanText(input) {
  return String(input || '').replace(/\s+/g, ' ').trim();
}

async function searchPreviewArticles(query) {
  const searchUrl = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await axios.get(searchUrl, {
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });

  const dom = new JSDOM(response.data);
  const doc = dom.window.document;
  const links = Array.from(doc.querySelectorAll('li.b_algo h2 a')).slice(0, 6);

  return links
    .map((a) => ({
      title: cleanText(a.textContent),
      url: cleanText(a.href)
    }))
    .filter((entry) => entry.title && entry.url);
}

async function extractArticleSummary(url) {
  const response = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    }
  });

  const dom = new JSDOM(response.data, { url });
  const article = new Readability(dom.window.document).parse();

  if (article?.textContent) {
    return cleanText(article.textContent).slice(0, 2600);
  }

  const paragraphs = Array.from(dom.window.document.querySelectorAll('p'))
    .map((p) => cleanText(p.textContent))
    .filter(Boolean)
    .slice(0, 8);

  return paragraphs.join(' ').slice(0, 2600);
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch (_err) {
    return '';
  }
}

async function enrichHighSignificanceGame(game, targetDate) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return null;
  }

  const cacheKey = `${targetDate}|${game.team}|${game.opponent}|${game.competition}`;
  const cached = enrichmentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const query = `${game.team} vs ${game.opponent} preview ${targetDate} ${game.competition}`;

  let articleLinks;
  try {
    articleLinks = await searchPreviewArticles(query);
  } catch (error) {
    console.error('Article search failed:', error.message);
    return null;
  }

  if (!articleLinks || articleLinks.length === 0) {
    return null;
  }

  const articlePayload = [];
  for (const link of articleLinks.slice(0, 3)) {
    try {
      const text = await extractArticleSummary(link.url);
      if (!text) {
        continue;
      }
      articlePayload.push({
        title: link.title,
        url: link.url,
        domain: extractDomain(link.url),
        text
      });
    } catch (error) {
      console.error(`Failed to extract article from ${link.url}:`, error.message);
    }
  }

  if (articlePayload.length === 0) {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || 'gemini-1.5-flash',
    generationConfig: {
      temperature: 0.2,
      topP: 0.8,
      topK: 40,
      maxOutputTokens: 450
    }
  });

  const prompt = [
    'You are a sports briefing assistant.',
    `Game: ${game.team} vs ${game.opponent}`,
    `Date: ${targetDate}`,
    `Competition: ${game.competition}`,
    'Using only the provided article excerpts, produce a short high-value pregame summary.',
    'Return strict JSON only with this schema:',
    '{',
    '  "snippet": "string",',
    '  "key_points": ["string", "string", "string"],',
    '  "sources": ["url1", "url2"]',
    '}',
    'Rules:',
    '- snippet: one short paragraph, max 2 sentences.',
    '- key_points: up to 3 concise bullets.',
    '- sources: include only URLs from provided inputs.',
    '',
    'Provided article excerpts:',
    JSON.stringify(articlePayload)
  ].join('\n');

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text() || '';
    const parsed = extractFirstJsonObject(text);
    if (!parsed || typeof parsed.snippet !== 'string') {
      return null;
    }

    const normalized = {
      snippet: cleanText(parsed.snippet).slice(0, 420),
      key_points: Array.isArray(parsed.key_points)
        ? parsed.key_points.map((p) => cleanText(p)).filter(Boolean).slice(0, 3)
        : [],
      sources: Array.isArray(parsed.sources)
        ? parsed.sources.map((u) => cleanText(u)).filter(Boolean).slice(0, 3)
        : articlePayload.map((a) => a.url).slice(0, 2)
    };

    enrichmentCache.set(cacheKey, normalized);
    return normalized;
  } catch (error) {
    console.error('High-significance enrichment failed:', error.message);
    return null;
  }
}

module.exports = {
  enrichHighSignificanceGame
};
