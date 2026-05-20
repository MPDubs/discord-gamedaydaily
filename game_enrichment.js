require('dotenv').config();
const axios = require('axios');
const { JSDOM, VirtualConsole } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const enrichmentCache = new Map();
const MAX_SNIPPET_SENTENCES = 8;
const MAX_SNIPPET_CHARS = 900;
const MAX_ARTICLES_FOR_ENRICHMENT = 3;
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

function previewForLog(input, max = 220) {
  const text = cleanText(input);
  if (!text) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function buildSnippetFromLlmText(text) {
  const cleaned = cleanText(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .replace(/^json\s*/i, '');

  const normalized = cleanText(cleaned);

  if (!normalized) {
    return '';
  }

  const parsedObj = extractFirstJsonObject(normalized);
  if (parsedObj && typeof parsedObj.snippet === 'string') {
    return cleanText(parsedObj.snippet).slice(0, MAX_SNIPPET_CHARS);
  }

  const snippetFieldMatch = normalized.match(/"snippet"\s*:\s*"([\s\S]*?)"(?:\s*,\s*"key_points"|\s*,\s*"sources"|\s*\})/i);
  if (snippetFieldMatch && snippetFieldMatch[1]) {
    return cleanText(snippetFieldMatch[1]).replace(/\\"/g, '"').slice(0, MAX_SNIPPET_CHARS);
  }

  const partialSnippetMatch = normalized.match(/"snippet"\s*:\s*"([\s\S]*)$/i);
  if (partialSnippetMatch && partialSnippetMatch[1]) {
    const partial = cleanText(partialSnippetMatch[1])
      .replace(/\\n/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/^"+/, '')
      .replace(/"+$/, '')
      .replace(/"\s*,\s*$/, '')
      .replace(/[{}]+/g, '')
      .trim();

    if (partial) {
      return partial.slice(0, MAX_SNIPPET_CHARS);
    }
  }

  const stripped = normalized
    .replace(/^\{+/, '')
    .replace(/\}+$/, '')
    .replace(/^"?snippet"?\s*:\s*/i, '')
    .split(/"key_points"\s*:/i)[0]
    .split(/"sources"\s*:/i)[0]
    .replace(/^"+|"+$/g, '')
    .replace(/^'+|'+$/g, '')
    .replace(/,$/, '');

  if (stripped && stripped.length > 0) {
    const cleanedSnippet = cleanText(stripped).slice(0, MAX_SNIPPET_CHARS);
    if (cleanedSnippet) {
      return cleanedSnippet;
    }
  }

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanText(s))
    .filter(Boolean)
    .slice(0, MAX_SNIPPET_SENTENCES);

  return cleanText(sentences.join(' ')).slice(0, MAX_SNIPPET_CHARS);
}

function buildSnippetFromArticleText(text) {
  const cleaned = cleanText(text);
  if (!cleaned) {
    return '';
  }

  const sentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => cleanText(s))
    .filter(Boolean)
    .slice(0, MAX_SNIPPET_SENTENCES);

  return cleanText(sentences.join(' ')).slice(0, MAX_SNIPPET_CHARS);
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

async function searchBraveSearch(query) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;
  if (!apiKey) {
    console.error('[BRAVE] BRAVE_SEARCH_API_KEY is not set');
    return [];
  }

  const url = 'https://api.search.brave.com/res/v1/web/search';
  let response;
  try {
    response = await axios.get(url, {
      timeout: 15000,
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': apiKey
      },
      params: {
        q: query,
        count: 3,
        safesearch: 'moderate'
      }
    });
  } catch (error) {
    const status = error?.response?.status;
    const providerError = error?.response?.data;
    console.error(`[BRAVE] Request failed - HTTP ${status ?? 'no-status'}`);
    console.error(`[BRAVE] Key prefix: ${apiKey.slice(0, 8)}...`);
    if (providerError) {
      console.error(`[BRAVE] Provider error: ${typeof providerError === 'string' ? providerError : JSON.stringify(providerError).slice(0, 500)}`);
    } else {
      console.error(`[BRAVE] Raw error: ${error.message}`);
    }
    throw error;
  }

  const results = response.data?.web?.results || [];
  console.log(`[BRAVE] Query returned ${results.length} results for: ${query.slice(0, 60)}`);
  const normalizedResults = results
    .map((item) => ({
      title: cleanText(item.title || ''),
      url: cleanText(item.url || ''),
      snippet: cleanText(item.description || '')
    }))
    .filter((entry) => entry.title && entry.url);

  console.log(
    '[BRAVE] Parsed result preview:',
    normalizedResults.map((r, idx) => ({
      rank: idx + 1,
      title: previewForLog(r.title, 90),
      url: r.url,
      snippet: previewForLog(r.snippet, 120)
    }))
  );

  return normalizedResults;
}

async function searchWithPreferredProviders(query) {
  const braveResults = await searchBraveSearch(query);
  return braveResults;
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
      console.error(`[BRAVE] Search query failed - ${error.message} | query: ${q.slice(0, 80)}`);
    }
  }
  console.log(`[BRAVE] collectSearchResults: ${dedup.size} unique results across ${queries.length} queries`);
  console.log(
    '[BRAVE] Dedup result URLs:',
    Array.from(dedup.values()).map((entry) => entry.url)
  );
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

  const virtualConsole = new VirtualConsole();
  virtualConsole.on('error', () => {});
  virtualConsole.on('warn', () => {});
  const dom = new JSDOM(response.data, { url, virtualConsole });
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
    `${matchup} preview ${contextTerms}`.trim()
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
    const scoredArticleLinks = articleLinks
      .map((entry) => ({
        ...entry,
        relevanceScore: scoreArticleRelevance(entry, game)
      }))
      .slice(0, MAX_ARTICLES_FOR_ENRICHMENT);

    articleLinks = scoredArticleLinks;

    console.log(
      '[ENRICH] Selected Brave article candidates:',
      articleLinks.map((entry) => ({
        url: entry.url,
        title: previewForLog(entry.title, 100),
        relevanceScore: entry.relevanceScore
      }))
    );
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
  for (const link of articleLinks.slice(0, MAX_ARTICLES_FOR_ENRICHMENT)) {
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
      console.log(`[ENRICH] Extracted article text from ${link.url} (${text.length} chars)`);
    } catch (error) {
      const fallbackSnippet = cleanText(link.snippet || '');
      if (fallbackSnippet) {
        articlePayload.push({
          title: link.title,
          url: link.url,
          domain: extractDomain(link.url),
          text: `${link.title}. ${fallbackSnippet}`.slice(0, 2600)
        });
        console.log(`[ENRICH] Using search snippet fallback for ${link.url}`);
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

  console.log(`[ENRICH] LLM article payload count: ${articlePayload.length}`);
  articlePayload.forEach((article, idx) => {
    console.log(`[ENRICH] ARTICLE_PAYLOAD_${idx + 1}_START url=${article.url} domain=${article.domain} chars=${article.text.length}`);
    console.log(article.text);
    console.log(`[ENRICH] ARTICLE_PAYLOAD_${idx + 1}_END`);
  });

  const genAI = new GoogleGenerativeAI(apiKey);
  const configuredModel = cleanText(process.env.GEMINI_MODEL || '');
  const candidateModels = Array.from(
    new Set([configuredModel, 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-flash-latest'].filter(Boolean))
  );

  const prompt = [
    'You are a sports briefing assistant.',
    `Game: ${game.team} vs ${game.opponent}`,
    `Date: ${targetDate}`,
    `Competition: ${game.competition}`,
    'Using only the provided article excerpts, produce a short high-value pregame summary.',
    'Return plain text only (no JSON, no markdown, no code fences).',
    'Rules:',
    '- snippet: one short paragraph, up to 8 sentences.',
    '- Focus on actionable matchup context from the provided excerpts.',
    '- Synthesize across sources and avoid copying long passages verbatim.',
    '- Do not include labels like "snippet:".',
    '',
    'Provided article excerpts:',
    JSON.stringify(articlePayload)
  ].join('\n');

  try {
    let lastError = null;
    const articleTextFallback = buildSnippetFromArticleText(
      articlePayload.map((a) => a.text).filter(Boolean).join(' ')
    );
    for (const modelName of candidateModels) {
      try {
        console.log(`[LLM] Trying model: ${modelName} | articlePayload=${articlePayload.length}`);
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            temperature: 0.2,
            topP: 0.8,
            topK: 40,
            maxOutputTokens: 450
          }
        });

        const result = await model.generateContent(prompt);
        const text = result.response.text() || '';
        console.log(`[LLM] Raw response preview (${modelName}): ${previewForLog(text, 320)}`);
        const parsed = extractFirstJsonObject(text);
        console.log(
          '[LLM] Parsed JSON preview:',
          parsed
            ? {
                snippet: previewForLog(parsed.snippet || '', 180),
                key_points: Array.isArray(parsed.key_points) ? parsed.key_points.length : 0,
                sources: Array.isArray(parsed.sources) ? parsed.sources.length : 0
              }
            : 'null'
        );
        const llmSnippet = parsed && typeof parsed.snippet === 'string'
          ? buildSnippetFromLlmText(parsed.snippet)
          : buildSnippetFromLlmText(text);
        console.log(`[LLM] Non-JSON fallback snippet preview: ${previewForLog(llmSnippet, 180)}`);

        if (!llmSnippet) {
          console.error(`[LLM] Empty/invalid summary from ${modelName}; trying next model`);
          lastError = new Error(`EMPTY_LLM_SUMMARY_${modelName}`);
          continue;
        }

        const normalized = {
          snippet: llmSnippet,
          key_points: [],
          sources: articlePayload.map((a) => a.url).slice(0, MAX_ARTICLES_FOR_ENRICHMENT)
        };

          console.log(`[LLM] Final normalized snippet preview: ${previewForLog(normalized.snippet, 220)}`);

        enrichmentCache.set(cacheKey, normalized);
        return normalized;
      } catch (modelError) {
        lastError = modelError;
        const message = String(modelError?.message || '');
        const isUnavailableModel = /404|not found|not supported/i.test(message);
        console.error(`Gemini model failed (${modelName}):`, modelError.message);
        if (!isUnavailableModel) {
          break;
        }
      }
    }

    if (articleTextFallback) {
      console.log('[LLM] All models failed or returned empty output; using deterministic article-text fallback');
      const fallbackNormalized = {
        snippet: articleTextFallback,
        key_points: [],
        sources: articlePayload.map((a) => a.url).slice(0, MAX_ARTICLES_FOR_ENRICHMENT)
      };
      enrichmentCache.set(cacheKey, fallbackNormalized);
      return fallbackNormalized;
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error('No Gemini model candidates available');
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
