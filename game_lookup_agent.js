require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

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

async function lookupGamesForTeams({ teamNames, targetDate, timezone }) {
  if (!Array.isArray(teamNames) || teamNames.length === 0) {
    return { games: [] };
  }

  const prompt = `You are a sports schedule researcher. Use web search to find if each team has a game on the provided date.

Date: ${targetDate}
Timezone for start times: ${timezone}
Teams: ${teamNames.join(', ')}

For each team with a game today, return strict JSON ONLY with this exact schema:
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

Only include games you can verify from at least one source URL. If no games found, return {"games": []}.`;

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
      contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const outputText = result.response.text() || '';
    const parsed = extractFirstJsonObject(outputText);

    if (!parsed || !Array.isArray(parsed.games)) {
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
