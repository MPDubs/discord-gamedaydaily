require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const { JSDOM } = require('jsdom');

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

function extractFirstJsonObject(text) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const direct = text.trim();
  try {
    return JSON.parse(direct);
  } catch (_) {
    // Continue to bracket extraction.
  }

  const start = direct.indexOf('{');
  const end = direct.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const candidate = direct.slice(start, end + 1);
  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

function normalizeTeamName(teamName) {
  if (!teamName) {
    return '';
  }

  return String(teamName)
    .replace(/^(nba|nfl|nhl|mlb|wnba|ncaa|ncaaf|ncaab|epl|mls|uefa|fifa)\s+/i, '')
    .trim();
}

async function searchWebResults(query) {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await axios.get(url, {
    timeout: 12000,
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
      title: (a.textContent || '').trim(),
      url: (a.href || '').trim()
    }))
    .filter((item) => item.title && item.url);
}

function buildPrompt({ teamNames, targetDate, timezone, webContext }) {
  return `You are a sports schedule researcher.

Task:
- Determine if each team has a game on ${targetDate}.
- Use the provided web results as grounding evidence.
- Return start times converted to ${timezone} when possible.

Teams:
${teamNames.join(', ')}

Grounding web results:
${webContext}

Return strict JSON ONLY with this exact schema:
{
  "games": [
    {
      "team": "string",
      "opponent": "string",
      "start_time_local": "string",
      "venue": "string",
      "location": "string",
      "watch": "string",
      "competition": "string",
      "confidence": "high|medium|low",
      "source_url": "string",
      "notes": "string"
    }
  ]
}

Rules:
- Include only games that are explicitly supported by a source URL.
- Use team names exactly as one of the provided Teams values.
- If no verified games are found, return {"games": []}.`;
}

async function lookupGamesForTeams({ teamNames, targetDate, timezone }) {
  if (!Array.isArray(teamNames) || teamNames.length === 0) {
    return { games: [] };
  }

  const normalizedTeams = teamNames.map((team) => normalizeTeamName(team));

  let webContext = '';
  for (const team of normalizedTeams) {
    try {
      const queries = [
        `${team} game ${targetDate}`,
        `${team} schedule ${targetDate}`,
        `${team} where to watch ${targetDate}`
      ];

      for (const q of queries) {
        const results = await searchWebResults(q);
        if (results.length > 0) {
          webContext += `\nQuery: ${q}\n`;
          results.forEach((result, idx) => {
            webContext += `${idx + 1}. ${result.title} | ${result.url}\n`;
          });
        }
      }
    } catch (error) {
      console.error(`Search fallback failed for team "${team}":`, error.message);
    }
  }

  const prompt = buildPrompt({
    teamNames,
    targetDate,
    timezone,
    webContext: webContext || 'No web results retrieved.'
  });

  try {
    const model = genAI.getGenerativeModel({ 
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.3,
        topP: 0.8,
        topK: 40
      }
    });

    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }]
    });

    const outputText = result.response.text() || '';
    const parsed = extractFirstJsonObject(outputText);

    if (!parsed || !Array.isArray(parsed.games)) {
      console.error('Gemini response did not contain parseable games JSON:', outputText.slice(0, 400));
      return { games: [] };
    }

    return parsed;
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    return { games: [] };
  }
}

module.exports = {
  lookupGamesForTeams
};
