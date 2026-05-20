require('dotenv').config();
const axios = require('axios');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const enrichmentCache = new Map();
const NOISE_PATTERNS = [
  /\/video\//i,
  /\/clip\//i,
  /fantasy/i,
  /betting/i,
  /odds/i,
  /dfs/i,
  /draft/i,
  /offseason/i,
  /mock draft/i,
  /free agency/i
];

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

function normalizeForMatch(input) {
  return cleanText(input)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getTeamKeywordTokens(teamName) {
  return normalizeForMatch(teamName)
    .split(' ')
    .filter((token) => token.length > 2)
    .filter((token) => !['the', 'and', 'for', 'with'].includes(token));
}

function hasNoise(text, url) {
  const blob = `${text || ''} ${url || ''}`;
  return NOISE_PATTERNS.some((pattern) => pattern.test(blob));
}

function scoreArticleRelevance(article, game) {
  const title = normalizeForMatch(article.title);
  const snippet = normalizeForMatch(article.snippet || '');
  const text = `${title} ${snippet}`;
  const url = String(article.url || '');

  if (hasNoise(text, url)) {
    return -100;
  }

  const teamTokens = getTeamKeywordTokens(game.team);
  const oppTokens = getTeamKeywordTokens(game.opponent);

  let score = 0;
  if (teamTokens.some((token) => text.includes(token))) {
    score += 30;
  }
  if (oppTokens.some((token) => text.includes(token))) {
    score += 30;
  }

  const contextTerms = ['preview', 'game', 'matchup', 'finals', 'playoff', 'series', 'tonight'];
  contextTerms.forEach((term) => {
    if (text.includes(term)) {
      score += 5;
    }
  });

  if (/espn\.com\/nba\/story/i.test(url)) {
    score += 8;
  }

  return score;
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
  let resultNodes = Array.from(doc.querySelectorAll('li.b_algo')).slice(0, 8);
  if (resultNodes.length === 0) {
    resultNodes = Array.from(doc.querySelectorAll('main li, #b_content li')).slice(0, 12);
  }

  return resultNodes
    .map((node) => {
      const anchor = node.querySelector('h2 a, a');
      const snippetNode = node.querySelector('.b_caption p, p');
      return {
        title: cleanText(anchor?.textContent || ''),
        url: cleanText(anchor?.href || ''),
        snippet: cleanText(snippetNode?.textContent || '')
      };
    })
    .filter((entry) => entry.title && entry.url);
}

async function searchGoogleCustomSearch(query) {
  const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
  const cseId = process.env.GOOGLE_SEARCH_CSE_ID;
  if (!apiKey || !cseId) {
    return [];
  }

  const url = 'https://www.googleapis.com/customsearch/v1';
  const response = await axios.get(url, {
    timeout: 15000,
    params: {
      key: apiKey,
      cx: cseId,
      q: query,
      num: 10,
      safe: 'active'
    }
  });

  const items = response.data?.items || [];
  return items
    .map((item) => ({
      title: cleanText(item.title || ''),
      url: cleanText(item.link || ''),
      snippet: cleanText(item.snippet || '')
    }))
    .filter((entry) => entry.title && entry.url);
}

async function searchWithPreferredProviders(query) {
  const googleResults = await searchGoogleCustomSearch(query);
  if (googleResults.length > 0) {
    return googleResults;
  }

  return searchPreviewArticles(query);
}

async function collectSearchResults(queries) {
  const dedup = new Map();
  for (const q of queries) {
    try {
      const found = await searchWithPreferredProviders(q);
      for (const item of found) {
        if (!dedup.has(item.url)) {
          dedup.set(item.url, item);
        }
      }
      if (dedup.size >= 8) {
        break;
      }
    } catch (error) {
      console.error(`Search query failed (${q}):`, error.message);
    }
  }
  return Array.from(dedup.values());
}

async function fetchEspnNewsFallback(game) {
  const results = [];
  const candidates = [];

  if (game?.sport && game?.league && game?.teamEspnId) {
    candidates.push(
      `https://site.api.espn.com/apis/site/v2/sports/${game.sport}/${game.league}/teams/${game.teamEspnId}/news`
    );
  }
  if (game?.sport && game?.league) {
    candidates.push(`https://site.api.espn.com/apis/site/v2/sports/${game.sport}/${game.league}/news`);
  }

  for (const url of candidates) {
    try {
      const response = await axios.get(url, { timeout: 12000 });
      const articles = response.data?.articles || [];
      for (const article of articles.slice(0, 6)) {
        const link = cleanText(article?.links?.web?.href || article?.links?.api?.self?.href || '');
        const title = cleanText(article?.headline || article?.title || '');
        const description = cleanText(article?.description || article?.summary || '');
        if (link && title) {
          results.push({
            title,
            url: link,
            domain: extractDomain(link) || 'espn.com',
            text: `${title}. ${description}`.slice(0, 2600)
          });
        }
      }
      if (results.length > 0) {
        const ranked = results
          .map((item) => ({ item, score: scoreArticleRelevance({ ...item, snippet: item.text }, game) }))
          .filter((entry) => entry.score >= 35)
          .sort((a, b) => b.score - a.score)
          .map((entry) => entry.item);

        if (ranked.length > 0) {
          return ranked;
        }
      }
    } catch (error) {
      console.error(`ESPN news fallback failed (${url}):`, error.message);
    }
  }

  return [];
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

function buildSearchQueries(game, targetDate) {
  const matchup = `${game.team} vs ${game.opponent}`;
  const competition = cleanText(game.competition || '');
  const contextTerms = [competition, targetDate].filter(Boolean).join(' ');

  return [
    `${matchup} preview ${contextTerms}`.trim(),
    `${matchup} game preview ${contextTerms}`.trim(),
    `${matchup} keys to the game ${contextTerms}`.trim(),
    `${matchup} things to watch ${contextTerms}`.trim(),
    `${matchup} article ${contextTerms}`.trim(),
    `${matchup} analysis ${contextTerms}`.trim()
  ];
}

async function enrichHighSignificanceGame(game, targetDate) {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return {
      error: {
        code: 'MISSING_API_KEY',
        message: 'GOOGLE_API_KEY is not configured'
      }
    };
  }

  const cacheKey = `${targetDate}|${game.team}|${game.opponent}|${game.competition}`;
  const cached = enrichmentCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const queries = buildSearchQueries(game, targetDate);

  let articleLinks = await collectSearchResults(queries);

  if (articleLinks.length > 0) {
    articleLinks = articleLinks
      .map((entry) => ({
        ...entry,
        relevanceScore: scoreArticleRelevance(entry, game)
      }))
      .filter((entry) => entry.relevanceScore >= 35)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 8);
  }

  if (!articleLinks || articleLinks.length === 0) {
    const espnFallback = await fetchEspnNewsFallback(game);
    if (espnFallback.length > 0) {
      articleLinks = espnFallback.map((a) => ({ title: a.title, url: a.url, snippet: a.text }));
    }
  }

  if (!articleLinks || articleLinks.length === 0) {
    return {
      error: {
        code: 'NO_ARTICLES_FOUND',
        message: 'No preview articles found via web search or ESPN news fallback'
      }
    };
  }

  const articlePayload = [];
  for (const link of articleLinks.slice(0, 4)) {
    try {
      const text = await extractArticleSummary(link.url);
      if (!text) {
        throw new Error('empty extracted text');
      }
      articlePayload.push({
        title: link.title,
        url: link.url,
        domain: extractDomain(link.url),
        text
      });
    } catch (error) {
      const fallbackSnippet = cleanText(link.snippet || '');
      if (fallbackSnippet) {
        articlePayload.push({
          title: link.title,
          url: link.url,
          domain: extractDomain(link.url),
          text: `${link.title}. ${fallbackSnippet}`.slice(0, 2600)
        });
      } else {
        console.error(`Failed to extract article from ${link.url}:`, error.message);
      }
    }
  }

  if (articlePayload.length === 0) {
    return {
      error: {
        code: 'ARTICLE_EXTRACTION_FAILED',
        message: 'Could not extract readable content from candidate articles'
      }
    };
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
      return {
        error: {
          code: 'LLM_PARSE_FAILED',
          message: 'LLM response did not contain expected JSON snippet'
        }
      };
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
    return {
      error: {
        code: 'LLM_REQUEST_FAILED',
        message: error.message
      }
    };
  }
}

module.exports = {
  enrichHighSignificanceGame
};
