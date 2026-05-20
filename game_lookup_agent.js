require('dotenv').config();
const OpenAI = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

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

async function lookupGamesForTeams({ teamNames, targetDate, timezone }) {
  if (!Array.isArray(teamNames) || teamNames.length === 0) {
    return { games: [] };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

  const prompt = [
    'You are a sports schedule researcher.',
    'Use web search to verify if each team has a game on the provided date.',
    `Date: ${targetDate}`,
    `Timezone for start times: ${timezone}`,
    `Teams: ${teamNames.join(', ')}`,
    'Return strict JSON only with this schema:',
    '{',
    '  "games": [',
    '    {',
    '      "team": "string",',
    '      "opponent": "string",',
    '      "start_time_local": "string",',
    '      "venue": "string",',
    '      "location": "string",',
    '      "watch": "string",',
    '      "competition": "string",',
    '      "confidence": "high|medium|low",',
    '      "source_url": "string",',
    '      "notes": "string"',
    '    }',
    '  ]',
    '}',
    'Only include games you can verify from at least one source URL.',
    'If no games are found, return {"games": []}.'
  ].join('\n');

  const response = await openai.responses.create({
    model,
    tools: [{ type: 'web_search_preview' }],
    input: prompt
  });

  const outputText = response.output_text || '';
  const parsed = extractFirstJsonObject(outputText);

  if (!parsed || !Array.isArray(parsed.games)) {
    return { games: [] };
  }

  return parsed;
}

module.exports = {
  lookupGamesForTeams
};
