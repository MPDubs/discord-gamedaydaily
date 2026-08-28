const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const axios = require('axios');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const express = require('express');

const {
  resolveTeamWithEspn,
  getEspnGamesForTeams,
  discoverLeaguesForTeam,
  getEspnPlayoffGames,
  PLAYOFF_SERIES
} = require('./espn_lookup');
const { enrichHighSignificanceGame } = require('./game_enrichment');

const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: Number(process.env.DATABASE_PORT || 5432)
});

pool
  .connect()
  .then((client) => {
    console.log('Connected to PostgreSQL using a pool');
    client.release();
  })
  .catch((err) => console.error('Connection error', err.stack));

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tracked_teams (
      id SERIAL PRIMARY KEY,
      server_id BIGINT REFERENCES servers(id) ON DELETE CASCADE,
      team_name VARCHAR(120) NOT NULL,
      espn_team_id VARCHAR(32),
      espn_sport VARCHAR(64),
      espn_league VARCHAR(64),
      espn_display_name VARCHAR(160),
      espn_confidence VARCHAR(16) DEFAULT 'low',
      emoji_name VARCHAR(64),
      emoji_id VARCHAR(32),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, team_name)
    );
  `);

  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_team_id VARCHAR(32);');
  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_sport VARCHAR(64);');
  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_league VARCHAR(64);');
  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_display_name VARCHAR(160);');
  await pool.query("ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_confidence VARCHAR(16) DEFAULT 'low';");
  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS emoji_name VARCHAR(64);');
  await pool.query('ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS emoji_id VARCHAR(32);');
  await pool.query("ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_known_leagues TEXT DEFAULT '';");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS playoff_subscriptions (
      id SERIAL PRIMARY KEY,
      server_id BIGINT REFERENCES servers(id) ON DELETE CASCADE,
      playoff_key VARCHAR(64) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, playoff_key)
    );
  `);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

const postedKeyCache = new Set();
const thumbnailAvailabilityCache = new Map();

const PLAYOFF_IMAGE_BASE = 'https://whitnode.com/wp-content/uploads/gdd-playoffs';

const PLAYOFF_VISUALS = {
  'nba-finals': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/nba-finals.png`,
    badgeLabel: 'NBA Finals'
  },
  'mls-cup-final': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/mls-cup-final.png`,
    badgeLabel: 'MLS Cup Final'
  },
  'ncaa-elite-eight': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/ncaa-elite-eight.png`,
    badgeLabel: 'NCAA Elite Eight'
  },
  'ncaa-final-four': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/ncaa-final-four.png`,
    badgeLabel: 'NCAA Final Four'
  },
  'ncaa-championship': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/ncaa-championship.png`,
    badgeLabel: 'NCAA Championship'
  },
  'nfl-conference-championship': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/nfl-conference-championship.png`,
    badgeLabel: 'NFL Conference Championship'
  },
  'super-bowl': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/super-bowl.png`,
    badgeLabel: 'Super Bowl'
  },
  'world-cup-usa': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-usa.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - USA Matches'
  },
  'world-cup-round-of-32': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-round-of-32.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - Round of 32'
  },
  'world-cup-round-of-16': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-round-of-16.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - Round of 16'
  },
  'world-cup-quarterfinals': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-quarterfinals.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - Quarterfinals'
  },
  'world-cup-semifinals': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-semifinals.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - Semifinals'
  },
  'world-cup-final': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup-final.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup - Final'
  },
  'club-world-cup-final': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/club-world-cup-final.png`,
    fallbackThumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA Club World Cup - Final'
  },
  'world-cup-generic': {
    thumbnailUrl: `${PLAYOFF_IMAGE_BASE}/world-cup.png`,
    badgeLabel: 'FIFA World Cup'
  }
};

function parseTimeToPost(timeToPost) {
  if (!timeToPost || !/^\d{2}:\d{2}(:\d{2})?$/.test(timeToPost)) {
    return null;
  }
  const [hour, minute] = timeToPost.split(':').map(Number);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
}

function shouldPostNow(serverTimezone, timeToPost) {
  const parsed = parseTimeToPost(timeToPost);
  if (!parsed) {
    return false;
  }

  const now = moment().tz(serverTimezone);
  const target = now
    .clone()
    .hour(parsed.hour)
    .minute(parsed.minute)
    .second(0)
    .millisecond(0);

  const diffMinutes = now.diff(target, 'minutes');
  return diffMinutes >= 0 && diffMinutes < 20;
}

async function ensureServerExists(discordServerId, serverName, channelId) {
  const existing = await pool.query('SELECT id FROM servers WHERE server_id = $1', [discordServerId]);
  if (existing.rowCount > 0) {
    return existing.rows[0].id;
  }

  const inserted = await pool.query(
    `
      INSERT INTO servers (server_id, name, timezone, channel_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id;
    `,
    [discordServerId, serverName, 'America/New_York', channelId]
  );

  return inserted.rows[0].id;
}

async function getFollowedTeams(serverPrimaryId) {
  const result = await pool.query(
    `
      SELECT
        id,
        team_name AS name,
        espn_team_id,
        espn_sport,
        espn_league,
        espn_display_name,
        espn_confidence,
        espn_known_leagues,
        emoji_name,
        emoji_id
      FROM tracked_teams
      WHERE server_id = $1
      ORDER BY team_name ASC;
    `,
    [serverPrimaryId]
  );

  return result.rows;
}

async function getPlayoffSubscriptions(serverPrimaryId) {
  const result = await pool.query(
    `
      SELECT playoff_key
      FROM playoff_subscriptions
      WHERE server_id = $1
      ORDER BY playoff_key ASC;
    `,
    [serverPrimaryId]
  );

  return result.rows.map((row) => row.playoff_key);
}

async function subscribePlayoff(serverPrimaryId, playoffKey) {
  await pool.query(
    `
      INSERT INTO playoff_subscriptions (server_id, playoff_key)
      VALUES ($1, $2)
      ON CONFLICT (server_id, playoff_key) DO NOTHING;
    `,
    [serverPrimaryId, playoffKey]
  );
}

async function unsubscribePlayoff(serverPrimaryId, playoffKey) {
  await pool.query(
    'DELETE FROM playoff_subscriptions WHERE server_id = $1 AND playoff_key = $2',
    [serverPrimaryId, playoffKey]
  );
}

const SPORT_EMOJIS = {
  football: '🏈',
  basketball: '🏀',
  baseball: '⚾',
  hockey: '🏒',
  soccer: '⚽'
};

function getSportEmoji(sport) {
  return SPORT_EMOJIS[String(sport || '').toLowerCase()] || '';
}

function renderPlayoffChoices() {
  return Object.values(PLAYOFF_SERIES)
    .map((entry) => `${entry.key} -> ${entry.label}`)
    .join('\n');
}

function normalizeTeamLookupKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildEmojiMap(followedTeams) {
  const map = new Map();
  for (const team of followedTeams) {
    if (!team?.emoji_name || !team?.emoji_id) {
      continue;
    }

    const rendered = `<:${team.emoji_name}:${team.emoji_id}>`;
    const keys = [team.name, team.espn_display_name]
      .filter(Boolean)
      .map((value) => normalizeTeamLookupKey(value));

    keys.forEach((key) => {
      if (key) {
        map.set(key, rendered);
      }
    });
  }

  return map;
}

function compactTeamLookupKey(name) {
  return normalizeTeamLookupKey(name).replace(/\s+/g, '');
}

function getPlayoffVisuals(game) {
  const key = String(game?.subscriptionKey || '').toLowerCase();
  if (PLAYOFF_VISUALS[key]) {
    return PLAYOFF_VISUALS[key];
  }

  const league = String(game?.league || '').toLowerCase();
  if (league === 'fifa.world') {
    return PLAYOFF_VISUALS['world-cup-generic'] || null;
  }
  if (league === 'fifa.cwc') {
    return PLAYOFF_VISUALS['club-world-cup-final'] || PLAYOFF_VISUALS['world-cup-generic'] || null;
  }

  if (key.startsWith('world-cup-')) {
    return PLAYOFF_VISUALS['world-cup-generic'] || null;
  }

  return null;
}

async function isThumbnailAvailable(url) {
  if (!url) {
    return false;
  }

  if (thumbnailAvailabilityCache.has(url)) {
    return thumbnailAvailabilityCache.get(url);
  }

  try {
    const response = await axios.head(url, {
      timeout: 10000,
      validateStatus: () => true
    });
    const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
    const ok = response.status >= 200 && response.status < 300 && contentType.startsWith('image/');
    // Cache only successful lookups. Failed checks can be transient (file uploaded later).
    if (ok) {
      thumbnailAvailabilityCache.set(url, true);
    } else {
      thumbnailAvailabilityCache.delete(url);
    }
    return ok;
  } catch (_error) {
    thumbnailAvailabilityCache.delete(url);
    return false;
  }
}

async function resolvePlayoffThumbnailUrl(playoffVisuals) {
  const primary = playoffVisuals?.thumbnailUrl || '';
  const fallback = playoffVisuals?.fallbackThumbnailUrl || '';

  if (await isThumbnailAvailable(primary)) {
    return primary;
  }

  if (fallback && await isThumbnailAvailable(fallback)) {
    return fallback;
  }

  return '';
}

function appendEmojiCollectionToMap(map, emojiCollection) {
  if (!emojiCollection) {
    return;
  }

  for (const emoji of emojiCollection.values()) {
    const rendered = `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
    const key = normalizeTeamLookupKey(emoji.name);
    const compactKey = compactTeamLookupKey(emoji.name);
    if (key) {
      map.set(key, rendered);
    }
    if (compactKey) {
      map.set(compactKey, rendered);
    }
  }
}

function buildAutoEmojiMap(guild, appEmojiCollection) {
  const map = new Map();
  appendEmojiCollectionToMap(map, guild?.emojis?.cache);
  appendEmojiCollectionToMap(map, appEmojiCollection);

  return map;
}

function getTeamEmoji(emojiMap, autoEmojiMap, teamName) {
  const key = normalizeTeamLookupKey(teamName);
  if (!key) {
    return '';
  }

  const mapped = emojiMap.get(key);
  if (mapped) {
    return mapped;
  }

  if (!autoEmojiMap || autoEmojiMap.size === 0) {
    return '';
  }

  const compactKey = compactTeamLookupKey(teamName);
  if (autoEmojiMap.has(key)) {
    return autoEmojiMap.get(key);
  }
  if (compactKey && autoEmojiMap.has(compactKey)) {
    return autoEmojiMap.get(compactKey);
  }

  const tokens = key.split(' ').filter((token) => token.length >= 3);
  for (const token of tokens) {
    if (autoEmojiMap.has(token)) {
      return autoEmojiMap.get(token);
    }
  }

  const initials = key
    .split(' ')
    .map((part) => part[0])
    .filter(Boolean)
    .join('');
  if (initials.length >= 2 && autoEmojiMap.has(initials)) {
    return autoEmojiMap.get(initials);
  }

  return '';
}

function emojiToAssetUrl(renderedEmoji) {
  const match = String(renderedEmoji || '').trim().match(/^<(a?):[a-zA-Z0-9_]+:(\d+)>$/);
  if (!match) {
    return '';
  }

  const animated = match[1] === 'a';
  const emojiId = match[2];
  const extension = animated ? 'gif' : 'png';
  return `https://cdn.discordapp.com/emojis/${emojiId}.${extension}?size=128&quality=lossless`;
}

function parseCustomEmojiToken(token) {
  const match = String(token || '').trim().match(/^<a?:([a-zA-Z0-9_]+):(\d+)>$/);
  if (!match) {
    return null;
  }
  return {
    emoji_name: match[1],
    emoji_id: match[2]
  };
}

async function resolveEmojiInput(message, token) {
  const parsed = parseCustomEmojiToken(token);
  if (parsed) {
    return parsed;
  }

  const shortMatch = String(token || '').trim().match(/^:([a-zA-Z0-9_]+):$/);
  if (!shortMatch) {
    return null;
  }

  const shortName = shortMatch[1];
  try {
    await message.guild.emojis.fetch();
    let found = message.guild.emojis.cache.find((emoji) => emoji.name === shortName);
    if (!found && client.application?.emojis) {
      await client.application.emojis.fetch();
      found = client.application.emojis.cache.find((emoji) => emoji.name === shortName);
    }
    if (!found) {
      return null;
    }

    return {
      emoji_name: found.name,
      emoji_id: found.id
    };
  } catch (_err) {
    return null;
  }
}

async function findAutoEmojiForTeam(message, teamNames = []) {
  const candidates = teamNames
    .filter(Boolean)
    .map((name) => String(name).trim())
    .filter(Boolean);

  if (!message?.guild || candidates.length === 0) {
    return null;
  }

  try {
    await message.guild.emojis.fetch();

    let appEmojiCache = null;
    if (client.application?.emojis) {
      await client.application.emojis.fetch();
      appEmojiCache = client.application.emojis.cache;
    }

    const combined = [
      ...message.guild.emojis.cache.values(),
      ...(appEmojiCache ? Array.from(appEmojiCache.values()) : [])
    ];

    const byNormalized = new Map();
    const byCompact = new Map();
    for (const emoji of combined) {
      const n = normalizeTeamLookupKey(emoji.name);
      const c = compactTeamLookupKey(emoji.name);
      if (n && !byNormalized.has(n)) {
        byNormalized.set(n, emoji);
      }
      if (c && !byCompact.has(c)) {
        byCompact.set(c, emoji);
      }
    }

    for (const teamName of candidates) {
      const n = normalizeTeamLookupKey(teamName);
      const c = compactTeamLookupKey(teamName);

      const exact = (n && byNormalized.get(n)) || (c && byCompact.get(c));
      if (exact) {
        return {
          emoji_name: exact.name,
          emoji_id: exact.id
        };
      }
    }
  } catch (error) {
    console.error('Auto-emoji lookup failed:', error.message);
  }

  return null;
}

async function postDailyScheduleFromEspn(discordServerId, channel, targetDate, options = {}) {
  const {
    silentIfNoGames = false,
    notifyOnError = true
  } = options;

  try {
    const serverResult = await pool.query('SELECT id, timezone FROM servers WHERE server_id = $1', [discordServerId]);
    if (serverResult.rowCount === 0) {
      if (notifyOnError) {
        await channel.send('This server is not configured yet. Use !gdd setchannel first.');
      }
      return { ok: false, code: 'SERVER_NOT_CONFIGURED' };
    }

    const serverPrimaryId = serverResult.rows[0].id;
    const serverTimezone = serverResult.rows[0].timezone || 'America/New_York';
    const teams = await getFollowedTeams(serverPrimaryId);
    const playoffSubscriptions = await getPlayoffSubscriptions(serverPrimaryId);
    const emojiMap = buildEmojiMap(teams);
    let autoEmojiMap = new Map();
    try {
      let appEmojiCollection = null;
      if (client.application?.emojis) {
        await client.application.emojis.fetch();
        appEmojiCollection = client.application.emojis.cache;
      }

      if (channel?.guild?.emojis) {
        await channel.guild.emojis.fetch();
        autoEmojiMap = buildAutoEmojiMap(channel.guild, appEmojiCollection);
      } else {
        autoEmojiMap = buildAutoEmojiMap(null, appEmojiCollection);
      }
    } catch (error) {
      console.error('Failed to load emoji caches for auto-mapping:', error.message);
    }

    if (teams.length === 0 && playoffSubscriptions.length === 0) {
      if (notifyOnError && !silentIfNoGames) {
        await channel.send('No teams or playoff subscriptions are currently configured in this server.');
      }
      return { ok: true, postedCount: 0, noGamesCount: 0 };
    }

    const lookup = teams.length > 0
      ? await getEspnGamesForTeams({
          followedTeams: teams,
          targetDate,
          timezone: serverTimezone
        })
      : { games: [], noGames: [] };

    if (lookup.error) {
      if (notifyOnError) {
        await channel.send(`ESPN team lookup failed (${lookup.error.code}): ${lookup.error.message}`);
      }
      return { ok: false, code: lookup.error.code, message: lookup.error.message };
    }

    const playoffLookup = playoffSubscriptions.length > 0
      ? await getEspnPlayoffGames({
          subscriptions: playoffSubscriptions,
          targetDate,
          timezone: serverTimezone
        })
      : { games: [], noGames: [] };

    const followedTeamGames = (lookup.games || []).map((game) => ({
      ...game,
      _source: 'followed-team'
    }));
    const playoffSubscriptionGames = (playoffLookup.games || []).map((game) => ({
      ...game,
      _source: 'playoff-subscription'
    }));

    const normalizedGames = [...followedTeamGames, ...playoffSubscriptionGames];
    const noGames = [...(lookup.noGames || []), ...(playoffLookup.noGames || [])];

    // Deduplicate same event surfaced from team-follow and playoff subscription paths.
    // Key on sorted team names so "A vs B" and "B vs A" collapse to the same entry.
    // Prefer the playoff-subscription version (it carries subscriptionKey/label for visuals).
    const seen = new Map(); // key -> index in dedupedGames
    const dedupedGames = [];
    for (const game of normalizedGames) {
      const teamPair = [String(game.team || ''), String(game.opponent || '')].sort().join('|');
      const key = `${game.sport}|${game.league}|${teamPair}|${game.startTimeLocal || ''}`;
      if (seen.has(key)) {
        // If the already-seen entry is a playoff subscription and this one is from a followed team,
        // let the followed-team version win (it carries the correct team context and emoji).
        if (game._source === 'followed-team') {
          const existingIdx = seen.get(key);
          dedupedGames[existingIdx] = game;
        }
        continue;
      }
      seen.set(key, dedupedGames.length);
      dedupedGames.push(game);
    }

    if (dedupedGames.length === 0) {
      if (!silentIfNoGames) {
        await channel.send(`No games found for followed teams/playoff subscriptions on ${targetDate}.`);
      }
      return { ok: true, postedCount: 0, noGamesCount: noGames.length };
    }

    const embedsToSend = [];

    for (const game of dedupedGames) {
      const teamEmoji = getTeamEmoji(emojiMap, autoEmojiMap, game.team);
      const opponentEmoji = getTeamEmoji(emojiMap, autoEmojiMap, game.opponent);
      const sportEmoji = getSportEmoji(game.sport);
    const matchupTitle = `${teamEmoji ? `${teamEmoji} ` : ''}${game.team} vs ${opponentEmoji ? `${opponentEmoji} ` : ''}${game.opponent}${sportEmoji ? ` ${sportEmoji}` : ''}`;
    const significanceLevel = String(game.significanceLevel || 'low').toLowerCase();
    const significanceReasons = Array.isArray(game.significanceReasons) ? game.significanceReasons : [];
    const isPostseasonGame = significanceReasons.includes('Postseason game');
    const isPlayoffContext = significanceReasons.includes('Playoff or championship context');
    const stageLabel = game.postseasonLabel || null;
    const embedColor = isPlayoffContext ? '#b91c1c' : isPostseasonGame ? '#c2410c' : '#0f766e';

    let enrichment = null;
    let enrichmentError = null;
    if (significanceLevel === 'high') {
      const enrichmentResult = await enrichHighSignificanceGame(game, targetDate);
      if (enrichmentResult?.error) {
        enrichmentError = enrichmentResult.error;
        console.error(
          `High-significance blurb unavailable for ${game.team} vs ${game.opponent}: ` +
            `${enrichmentError.code} ${enrichmentError.message}`
        );
      } else {
        enrichment = enrichmentResult;
      }
    }

    const descriptionParts = [game.notes || 'Daily game lookup via ESPN schedule data.'];
    if (stageLabel) {
      descriptionParts.push(`Stage: ${stageLabel}`);
    }
    if (enrichment?.snippet) {
      descriptionParts.push(`Why It Matters: ${enrichment.snippet}`);
    }

    const embedFields = [
      { name: 'Start Time', value: game.startTimeLocal || 'TBD', inline: true },
      { name: 'Venue', value: game.venue || 'TBD', inline: true },
      { name: 'Location', value: game.location || 'TBD', inline: true },
      { name: 'Watch', value: game.watch || 'TBD', inline: true },
      { name: 'Competition', value: game.competition || 'TBD', inline: true }
    ];

    const playoffVisuals = getPlayoffVisuals(game);
    if (playoffVisuals?.badgeLabel) {
      embedFields.unshift({ name: 'Playoff', value: playoffVisuals.badgeLabel, inline: true });
    }

    if (game.oddsSummary) {
      embedFields.push({ name: 'Odds', value: game.oddsSummary.slice(0, 1024), inline: true });
    }

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle(matchupTitle)
      .setDescription(descriptionParts.join('\n\n'))
      .addFields(embedFields)
      .setFooter({ text: 'Source: ESPN' })
      .setTimestamp();

    if (enrichment?.key_points?.length) {
      const storylineText = enrichment.key_points.map((point) => `• ${point}`).join('\n').slice(0, 1024);
      if (storylineText) {
        embed.addFields({ name: 'Storylines', value: storylineText, inline: false });
      }
    }

    if (significanceLevel === 'high' && !enrichment && enrichmentError) {
      embed.addFields({
        name: 'Why It Matters',
        value: `Blurb unavailable (${enrichmentError.code}).`,
        inline: false
      });
    }

    const playoffThumbnailUrl = playoffVisuals ? await resolvePlayoffThumbnailUrl(playoffVisuals) : '';
    const emojiThumbnailUrl = teamEmoji ? emojiToAssetUrl(teamEmoji) : '';
    const isFollowedTeamGame = game._source === 'followed-team';

    if (isFollowedTeamGame) {
      // Followed team games prefer team visuals first, then playoff thumbnail fallback.
      if (game.teamLogoUrl) {
        embed.setThumbnail(game.teamLogoUrl);
      } else if (emojiThumbnailUrl) {
        embed.setThumbnail(emojiThumbnailUrl);
      } else if (playoffThumbnailUrl) {
        embed.setThumbnail(playoffThumbnailUrl);
      }
    } else {
      // Playoff subscription games prefer playoff visuals first.
      if (playoffThumbnailUrl) {
        embed.setThumbnail(playoffThumbnailUrl);
      } else if (game.teamLogoUrl) {
        embed.setThumbnail(game.teamLogoUrl);
      } else if (emojiThumbnailUrl) {
        embed.setThumbnail(emojiThumbnailUrl);
      }
    }

    if (game.sourceUrl) {
      embed.setURL(game.sourceUrl);
    }

      embedsToSend.push(embed);
    }

    const maxEmbedsPerMessage = 10;
    for (let index = 0; index < embedsToSend.length; index += maxEmbedsPerMessage) {
      const embedBatch = embedsToSend.slice(index, index + maxEmbedsPerMessage);
      const content =
        index === 0 ? `Game Day Daily ESPN check for ${targetDate} (${serverTimezone})` : undefined;

      await channel.send({
        content,
        embeds: embedBatch
      });
    }

    return {
      ok: true,
      postedCount: embedsToSend.length,
      noGamesCount: noGames.length
    };
  } catch (error) {
    console.error('postDailyScheduleFromEspn failed', error);
    if (notifyOnError) {
      await channel.send(`Failed while obtaining schedule data: ${error.message}`);
    }
    return {
      ok: false,
      code: 'POST_DAILY_FAILED',
      message: error.message
    };
  }
}

async function runScheduledMorningChecks() {
  try {
    const serversResult = await pool.query(
      `
        SELECT server_id, channel_id, timezone, time_to_post
        FROM servers;
      `
    );

    for (const server of serversResult.rows) {
      const serverTimezone = server.timezone || 'America/New_York';
      if (!server.channel_id || !server.time_to_post) {
        continue;
      }

      if (!shouldPostNow(serverTimezone, server.time_to_post)) {
        continue;
      }

      const localDate = moment().tz(serverTimezone).format('YYYY-MM-DD');
      const postKey = `${server.server_id}:${localDate}`;
      if (postedKeyCache.has(postKey)) {
        continue;
      }

      try {
        const channel = await client.channels.fetch(server.channel_id);
        if (!channel) {
          continue;
        }

        await postDailyScheduleFromEspn(server.server_id, channel, localDate, {
          silentIfNoGames: true,
          notifyOnError: false
        });
        postedKeyCache.add(postKey);
      } catch (err) {
        console.error(`Failed posting for server ${server.server_id}`, err);
      }
    }
  } catch (err) {
    console.error('Failed during scheduled morning checks', err);
  }
}

async function handleFollowCommand(message) {
  const teamName = message.content.split(' ').slice(2).join(' ').trim();
  if (!teamName) {
    await message.channel.send('Please provide a team name. Example: !gdd follow Bengals');
    return;
  }

  const serverPrimaryId = await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);

  const normalizedFollow = normalizeTeamLookupKey(teamName);
  const compactFollow = normalizedFollow.replace(/\s+/g, '');
  const worldCupGroupAliases = new Set([
    'worldcup',
    'fifaworldcup'
  ]);

  if (worldCupGroupAliases.has(compactFollow)) {
    const playoffKey = 'world-cup-group-stage';
    await subscribePlayoff(serverPrimaryId, playoffKey);
    await message.channel.send(
      `Subscribed this server to ${PLAYOFF_SERIES[playoffKey].label}. Daily GDD posts will include World Cup group-stage games.`
    );
    return;
  }

  const resolution = await resolveTeamWithEspn(teamName);
  const resolved = resolution?.bestMatch || null;
  const autoEmoji = await findAutoEmojiForTeam(message, [teamName, resolved?.displayName]);

  let knownLeagues = '';
  if (resolved?.teamId && resolved?.sport) {
    try {
      const discoveredLeagues = await discoverLeaguesForTeam(
        resolved.sport,
        resolved.teamId,
        resolved.displayName || teamName
      );
      knownLeagues = discoveredLeagues.join(',');
      console.log(`Discovered leagues for ${resolved.displayName}: ${knownLeagues}`);
    } catch (error) {
      console.error(`Failed to discover leagues for ${resolved.displayName}:`, error.message);
    }
  }

  await pool.query(
    `
      INSERT INTO tracked_teams (
        server_id,
        team_name,
        espn_team_id,
        espn_sport,
        espn_league,
        espn_display_name,
        espn_confidence,
        espn_known_leagues
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (server_id, team_name)
      DO UPDATE SET
        espn_team_id = EXCLUDED.espn_team_id,
        espn_sport = EXCLUDED.espn_sport,
        espn_league = EXCLUDED.espn_league,
        espn_display_name = EXCLUDED.espn_display_name,
        espn_confidence = EXCLUDED.espn_confidence,
        espn_known_leagues = EXCLUDED.espn_known_leagues;
    `,
    [
      serverPrimaryId,
      teamName,
      resolved?.teamId || null,
      resolved?.sport || null,
      resolved?.league || null,
      resolved?.displayName || null,
      resolved?.confidence || 'low',
      knownLeagues
    ]
  );

  if (autoEmoji) {
    await pool.query(
      `
        UPDATE tracked_teams
        SET emoji_name = COALESCE(emoji_name, $1),
            emoji_id = COALESCE(emoji_id, $2)
        WHERE server_id = $3 AND LOWER(team_name) = LOWER($4);
      `,
      [autoEmoji.emoji_name, autoEmoji.emoji_id, serverPrimaryId, teamName]
    );
  }

  if (resolved) {
    const discoveredText = knownLeagues
      ? `; discovered: ${knownLeagues}`
      : '';
    const emojiText = autoEmoji ? ` <:${autoEmoji.emoji_name}:${autoEmoji.emoji_id}>` : '';
    await message.channel.send(
      `Now following ${teamName}${emojiText}. Resolved to ESPN team: ${resolved.displayName} (primary: ${resolved.league}${discoveredText}, confidence: ${resolved.confidence}).`
    );
    return;
  }

  await message.channel.send(`Now following ${teamName}. ESPN match not found yet, will try name-based matching on game day.`);
}

async function handleManualFollowCommand(message) {
  const parts = message.content.trim().split(/\s+/);
  if (parts.length < 6) {
    await message.channel.send(
      'Usage: !gdd followid <sport> <league> <teamId> <team name>. Example: !gdd followid basketball nba 24 San Antonio Spurs'
    );
    return;
  }

  const sport = String(parts[2] || '').toLowerCase();
  const league = String(parts[3] || '').toLowerCase();
  const teamId = String(parts[4] || '').trim();
  const teamName = parts.slice(5).join(' ').trim();

  if (!sport || !league || !teamId || !teamName) {
    await message.channel.send(
      'Usage: !gdd followid <sport> <league> <teamId> <team name>. Example: !gdd followid basketball nba 24 San Antonio Spurs'
    );
    return;
  }

  const serverPrimaryId = await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
  const autoEmoji = await findAutoEmojiForTeam(message, [teamName]);

  let knownLeagues = '';
  try {
    const discoveredLeagues = await discoverLeaguesForTeam(sport, teamId, teamName);
    knownLeagues = discoveredLeagues.join(',');
    console.log(`Discovered leagues for ${teamName}: ${knownLeagues}`);
  } catch (error) {
    console.error(`Failed to discover leagues for ${teamName}:`, error.message);
  }

  await pool.query(
    `
      INSERT INTO tracked_teams (
        server_id,
        team_name,
        espn_team_id,
        espn_sport,
        espn_league,
        espn_display_name,
        espn_confidence,
        espn_known_leagues
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (server_id, team_name)
      DO UPDATE SET
        espn_team_id = EXCLUDED.espn_team_id,
        espn_sport = EXCLUDED.espn_sport,
        espn_league = EXCLUDED.espn_league,
        espn_display_name = EXCLUDED.espn_display_name,
        espn_confidence = EXCLUDED.espn_confidence,
        espn_known_leagues = EXCLUDED.espn_known_leagues;
    `,
    [serverPrimaryId, teamName, teamId, sport, league, teamName, 'manual', knownLeagues]
  );

  if (autoEmoji) {
    await pool.query(
      `
        UPDATE tracked_teams
        SET emoji_name = COALESCE(emoji_name, $1),
            emoji_id = COALESCE(emoji_id, $2)
        WHERE server_id = $3 AND LOWER(team_name) = LOWER($4);
      `,
      [autoEmoji.emoji_name, autoEmoji.emoji_id, serverPrimaryId, teamName]
    );
  }

  const discoveredText = knownLeagues
    ? `; discovered: ${knownLeagues}`
    : '';
  const emojiText = autoEmoji ? ` <:${autoEmoji.emoji_name}:${autoEmoji.emoji_id}>` : '';

  await message.channel.send(
    `Now following ${teamName}${emojiText} with manual ESPN mapping (primary: ${sport}/${league}${discoveredText}, team ID: ${teamId}).`
  );
}

async function handleSetEmojiCommand(message) {
  const args = message.content.trim().split(/\s+/);
  const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
  if (serverResult.rowCount === 0) {
    await message.channel.send('This server has no followed teams yet. Follow a team first.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const followedTeams = await getFollowedTeams(serverPrimaryId);
  if (followedTeams.length === 0) {
    await message.channel.send('No teams are currently being followed. Follow a team first.');
    return;
  }

  // Optional direct one-line mode: !gdd setemoji <team name> <emoji>
  if (args.length >= 4) {
    const emojiToken = args[args.length - 1];
    const parsedEmoji = await resolveEmojiInput(message, emojiToken);
    if (!parsedEmoji) {
      await message.channel.send('Please provide a server emoji as <:name:id> or :name: (from this server).');
      return;
    }

    const teamName = args.slice(2, -1).join(' ').trim();
    const update = await pool.query(
      `
        UPDATE tracked_teams
        SET emoji_name = $1, emoji_id = $2
        WHERE server_id = $3 AND LOWER(team_name) = LOWER($4)
        RETURNING team_name;
      `,
      [parsedEmoji.emoji_name, parsedEmoji.emoji_id, serverPrimaryId, teamName]
    );

    if (update.rowCount === 0) {
      await message.channel.send(`No followed team matched "${teamName}". Use !gdd current to see exact names.`);
      return;
    }

    await message.channel.send(`Emoji set for ${update.rows[0].team_name}: <:${parsedEmoji.emoji_name}:${parsedEmoji.emoji_id}>`);
    return;
  }

  let teamListMessage = 'Reply with the number of the team you want to set an emoji for:\n\n';
  followedTeams.forEach((team, idx) => {
    const mapped = team.emoji_name && team.emoji_id ? ` (current: <:${team.emoji_name}:${team.emoji_id}>)` : '';
    teamListMessage += `${idx + 1}. ${team.name}${mapped}\n`;
  });

  await message.channel.send(teamListMessage);

  const filter = (response) => response.author.id === message.author.id;

  let selectedTeam;
  try {
    const selectionCollected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: 30000,
      errors: ['time']
    });

    const selection = Number.parseInt(selectionCollected.first().content, 10);
    if (!Number.isInteger(selection) || selection < 1 || selection > followedTeams.length) {
      await message.channel.send('Invalid selection. Run !gdd setemoji again.');
      return;
    }

    selectedTeam = followedTeams[selection - 1];
  } catch (_err) {
    await message.channel.send('Timed out waiting for team selection. Run !gdd setemoji again.');
    return;
  }

  await message.channel.send(`Now send the custom emoji for ${selectedTeam.name} in this format: <:name:id> or :name:`);

  let parsedEmoji;
  try {
    const emojiCollected = await message.channel.awaitMessages({
      filter,
      max: 1,
      time: 30000,
      errors: ['time']
    });

    parsedEmoji = await resolveEmojiInput(message, emojiCollected.first().content);
    if (!parsedEmoji) {
      await message.channel.send('Invalid emoji format. Run !gdd setemoji again and use <:name:id> or :name: from this server.');
      return;
    }
  } catch (_err) {
    await message.channel.send('Timed out waiting for emoji input. Run !gdd setemoji again.');
    return;
  }

  await pool.query(
    `
      UPDATE tracked_teams
      SET emoji_name = $1, emoji_id = $2
      WHERE server_id = $3 AND id = $4;
    `,
    [parsedEmoji.emoji_name, parsedEmoji.emoji_id, serverPrimaryId, selectedTeam.id]
  );

  await message.channel.send(`Emoji set for ${selectedTeam.name}: <:${parsedEmoji.emoji_name}:${parsedEmoji.emoji_id}>`);
}

async function handleClearEmojiCommand(message) {
  const teamName = message.content.split(' ').slice(2).join(' ').trim();
  if (!teamName) {
    await message.channel.send('Usage: !gdd clearemoji <team name>');
    return;
  }

  const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
  if (serverResult.rowCount === 0) {
    await message.channel.send('This server has no followed teams yet.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const update = await pool.query(
    `
      UPDATE tracked_teams
      SET emoji_name = NULL, emoji_id = NULL
      WHERE server_id = $1 AND LOWER(team_name) = LOWER($2)
      RETURNING team_name;
    `,
    [serverPrimaryId, teamName]
  );

  if (update.rowCount === 0) {
    await message.channel.send(`No followed team matched "${teamName}". Use !gdd current to see exact names.`);
    return;
  }

  await message.channel.send(`Emoji cleared for ${update.rows[0].team_name}.`);
}

async function handleUnfollowCommand(message) {
  const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
  if (serverResult.rowCount === 0) {
    await message.channel.send('This server has no followed teams yet.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const followed = await getFollowedTeams(serverPrimaryId);

  if (followed.length === 0) {
    await message.channel.send('No teams are currently being followed.');
    return;
  }

  let prompt = 'Choose a team to unfollow:\n';
  followed.forEach((team, idx) => {
    const resolvedLabel = team.espn_display_name ? ` -> ${team.espn_display_name}` : '';
    prompt += `${idx + 1}. ${team.name}${resolvedLabel}\n`;
  });

  await message.channel.send(prompt);

  const filter = (response) => response.author.id === message.author.id;
  const collected = await message.channel.awaitMessages({
    filter,
    max: 1,
    time: 30000,
    errors: ['time']
  });

  const selection = Number.parseInt(collected.first().content, 10);
  if (!Number.isInteger(selection) || selection < 1 || selection > followed.length) {
    await message.channel.send('Invalid selection.');
    return;
  }

  const selected = followed[selection - 1];

  await pool.query(
    'DELETE FROM tracked_teams WHERE server_id = $1 AND id = $2',
    [serverPrimaryId, selected.id]
  );

  await message.channel.send(`Stopped following ${selected.name}.`);
}

async function handleFollowUsmntCommand(message) {
  const serverPrimaryId = await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
  const teamName = 'USA Mens Soccer';
  const sport = 'soccer';
  const primaryLeague = 'fifa.world';
  const teamId = '660';
  const displayName = 'United States';
  const autoEmoji = await findAutoEmojiForTeam(message, [teamName, displayName, 'usa mens soccer', 'usmnt']);

  let knownLeagues = '';
  try {
    const discoveredLeagues = await discoverLeaguesForTeam(sport, teamId, displayName);
    // Prefer World Cup first in stored ordering for readability.
    discoveredLeagues.sort((a, b) => {
      if (a === primaryLeague) {
        return -1;
      }
      if (b === primaryLeague) {
        return 1;
      }
      return a.localeCompare(b);
    });
    knownLeagues = discoveredLeagues.join(',');
  } catch (error) {
    console.error('Failed to discover USMNT leagues:', error.message);
  }

  await pool.query(
    `
      INSERT INTO tracked_teams (
        server_id,
        team_name,
        espn_team_id,
        espn_sport,
        espn_league,
        espn_display_name,
        espn_confidence,
        espn_known_leagues
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (server_id, team_name)
      DO UPDATE SET
        espn_team_id = EXCLUDED.espn_team_id,
        espn_sport = EXCLUDED.espn_sport,
        espn_league = EXCLUDED.espn_league,
        espn_display_name = EXCLUDED.espn_display_name,
        espn_confidence = EXCLUDED.espn_confidence,
        espn_known_leagues = EXCLUDED.espn_known_leagues;
    `,
    [serverPrimaryId, teamName, teamId, sport, primaryLeague, displayName, 'manual', knownLeagues]
  );

  if (autoEmoji) {
    await pool.query(
      `
        UPDATE tracked_teams
        SET emoji_name = COALESCE(emoji_name, $1),
            emoji_id = COALESCE(emoji_id, $2)
        WHERE server_id = $3 AND LOWER(team_name) = LOWER($4);
      `,
      [autoEmoji.emoji_name, autoEmoji.emoji_id, serverPrimaryId, teamName]
    );
  }

  const discoveredText = knownLeagues ? `; discovered: ${knownLeagues}` : '';
  const emojiText = autoEmoji ? ` <:${autoEmoji.emoji_name}:${autoEmoji.emoji_id}>` : '';
  await message.channel.send(
    `Now following ${teamName}${emojiText}. Resolved to ESPN team: ${displayName} (primary: ${primaryLeague}${discoveredText}, team ID: ${teamId}).`
  );
}

async function handleSubscribePlayoffsCommand(message) {
  const serverPrimaryId = await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
  const playoffKey = String(message.content.split(' ').slice(2).join(' ').trim() || '').toLowerCase();

  if (!playoffKey) {
    await message.channel.send(
      `Usage: !gdd subplayoff <key>\nAvailable keys:\n${renderPlayoffChoices()}`
    );
    return;
  }

  const def = PLAYOFF_SERIES[playoffKey];
  if (!def) {
    await message.channel.send(
      `Unknown playoff key: ${playoffKey}\nAvailable keys:\n${renderPlayoffChoices()}`
    );
    return;
  }

  await subscribePlayoff(serverPrimaryId, playoffKey);
  await message.channel.send(`Subscribed this server to ${def.label}.`);
}

async function handleUnsubscribePlayoffsCommand(message) {
  const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
  if (serverResult.rowCount === 0) {
    await message.channel.send('This server has no subscriptions yet.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const playoffKey = String(message.content.split(' ').slice(2).join(' ').trim() || '').toLowerCase();
  if (!playoffKey) {
    await message.channel.send('Usage: !gdd unsubplayoff <key>');
    return;
  }

  await unsubscribePlayoff(serverPrimaryId, playoffKey);
  const def = PLAYOFF_SERIES[playoffKey];
  await message.channel.send(`Unsubscribed ${def ? def.label : playoffKey}.`);
}

async function handleCurrentPlayoffSubscriptionsCommand(message) {
  const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
  if (serverResult.rowCount === 0) {
    await message.channel.send('No playoff subscriptions are configured in this server.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const subscribed = await getPlayoffSubscriptions(serverPrimaryId);
  if (subscribed.length === 0) {
    await message.channel.send('No playoff subscriptions are configured in this server.');
    return;
  }

  await message.channel.send(
    `Playoff subscriptions:\n${subscribed
      .map((key, idx) => `${idx + 1}. ${key} -> ${(PLAYOFF_SERIES[key]?.label || key)}`)
      .join('\n')}`
  );
}

function formatPlayoffKeyList() {
  return Object.values(PLAYOFF_SERIES)
    .map((entry) => `${entry.key} -> ${entry.label}`)
    .join('\n');
}

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) {
    return;
  }

  try {
    if (message.content.startsWith('!gdd setemoji') || message.content.startsWith('!setemoji')) {
      await handleSetEmojiCommand(message);
      return;
    }

    if (message.content.startsWith('!gdd clearemoji') || message.content.startsWith('!clearemoji')) {
      await handleClearEmojiCommand(message);
      return;
    }

    if (message.content.startsWith('!gdd followid')) {
      await handleManualFollowCommand(message);
      return;
    }

    if (message.content === '!gdd followusmnt') {
      await handleFollowUsmntCommand(message);
      return;
    }

    if (message.content.startsWith('!gdd subplayoff')) {
      await handleSubscribePlayoffsCommand(message);
      return;
    }

    if (message.content.startsWith('!gdd unsubplayoff')) {
      await handleUnsubscribePlayoffsCommand(message);
      return;
    }

    if (message.content === '!gdd playoffsubs') {
      await handleCurrentPlayoffSubscriptionsCommand(message);
      return;
    }

    if (message.content.startsWith('!gdd follow')) {
      await handleFollowCommand(message);
      return;
    }

    if (message.content === '!gdd unfollow') {
      await handleUnfollowCommand(message);
      return;
    }

    if (message.content === '!gdd current') {
      const serverResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [message.guild.id]);
      if (serverResult.rowCount === 0) {
        await message.channel.send('No teams are currently being followed in this server.');
        return;
      }

      const teams = await getFollowedTeams(serverResult.rows[0].id);
      if (teams.length === 0) {
        await message.channel.send('No teams are currently being followed in this server.');
        return;
      }

      await message.channel.send(
        `Followed teams:\n${teams
          .map((t, i) => `${i + 1}. ${t.name}${t.espn_display_name ? ` -> ${t.espn_display_name}` : ''}`)
          .join('\n')}`
      );
      return;
    }

    if (message.content === '!gdd timezone') {
      const timezones = [
        'America/New_York',
        'America/Chicago',
        'America/Denver',
        'America/Los_Angeles',
        'Europe/London',
        'Europe/Berlin',
        'Asia/Tokyo',
        'Asia/Kolkata',
        'Australia/Sydney',
        'Pacific/Auckland',
        'Africa/Johannesburg'
      ];

      let timezoneMessage = 'Select your server timezone by replying with a number:\n\n';
      timezones.forEach((tz, idx) => {
        timezoneMessage += `${idx + 1}. ${tz}\n`;
      });

      await message.channel.send(timezoneMessage);

      const filter = (response) => response.author.id === message.author.id;
      const collected = await message.channel.awaitMessages({
        filter,
        max: 1,
        time: 30000,
        errors: ['time']
      });

      const selection = Number.parseInt(collected.first().content, 10);
      if (!Number.isInteger(selection) || selection < 1 || selection > timezones.length) {
        await message.channel.send('Invalid selection. Please run !gdd timezone again.');
        return;
      }

      const selectedTimezone = timezones[selection - 1];
      await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
      await pool.query('UPDATE servers SET timezone = $1 WHERE server_id = $2', [selectedTimezone, message.guild.id]);
      await message.channel.send(`Timezone set to ${selectedTimezone}.`);
      return;
    }

    if (message.content.startsWith('!gdd settime')) {
      const parts = message.content.split(' ');
      const time = parts[2];
      if (!parseTimeToPost(time)) {
        await message.channel.send('Usage: !gdd settime HH:MM (24-hour). Example: !gdd settime 07:30');
        return;
      }

      await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
      await pool.query('UPDATE servers SET time_to_post = $1 WHERE server_id = $2', [time, message.guild.id]);
      await message.channel.send(`Morning post time set to ${time}.`);
      return;
    }

    if (message.content === '!gdd setchannel') {
      await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
      await pool.query('UPDATE servers SET channel_id = $1 WHERE server_id = $2', [message.channel.id, message.guild.id]);
      await message.channel.send('This channel is now your Game Day Daily post channel.');
      return;
    }

    if (message.content === '!gdd today') {
      await ensureServerExists(message.guild.id, message.guild.name, message.channel.id);
      const tzResult = await pool.query('SELECT timezone FROM servers WHERE server_id = $1', [message.guild.id]);
      const tz = tzResult.rows[0]?.timezone || 'America/New_York';
      const date = moment().tz(tz).format('YYYY-MM-DD');
      const progressMessage = await message.channel.send(`Working on it. Fetching games for ${date} (${tz})...`);
      const result = await postDailyScheduleFromEspn(message.guild.id, message.channel, date, {
        notifyOnError: true
      });

      if (result?.ok) {
        if (result.postedCount > 0) {
          await progressMessage.edit(`Done. Posted ${result.postedCount} game${result.postedCount === 1 ? '' : 's'} for ${date}.`);
        } else {
          await progressMessage.edit(`Done. No games were found for ${date}.`);
        }
      } else {
        const errorCode = result?.code ? ` (${result.code})` : '';
        await progressMessage.edit(`Done with errors${errorCode}. Check messages above for details.`);
      }
      return;
    }

    if (message.content.startsWith('!gdd ') && !message.content.startsWith('!gdd follow') && !message.content.startsWith('!gdd followusmnt') && !message.content.startsWith('!gdd unfollow') && !message.content.startsWith('!gdd setemoji') && !message.content.startsWith('!gdd clearemoji') && !message.content.startsWith('!gdd timezone') && !message.content.startsWith('!gdd settime') && !message.content.startsWith('!gdd setchannel') && !message.content.startsWith('!gdd current') && !message.content.startsWith('!gdd help') && !message.content.startsWith('!gdd today') && !message.content.startsWith('!gdd followid')) {
      // Assume it's a date command: !gdd MM/DD/YY or !gdd YYYY-MM-DD
      const dateStr = message.content.slice(5).trim();
      let parsedDate = null;

      // Try parsing various date formats
      if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(dateStr)) {
        // MM/DD/YY or MM/DD/YYYY
        parsedDate = moment(dateStr, ['MM/DD/YY', 'MM/DD/YYYY']);
      } else if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        // YYYY-MM-DD
        parsedDate = moment(dateStr, 'YYYY-MM-DD');
      }

      if (!parsedDate || !parsedDate.isValid()) {
        await message.channel.send('Invalid date format. Use MM/DD/YY, MM/DD/YYYY, or YYYY-MM-DD. Example: !gdd 12/5/26');
        return;
      }

      const formattedDate = parsedDate.format('YYYY-MM-DD');
      const progressMessage = await message.channel.send(`Working on it. Fetching games for ${formattedDate}...`);
      const result = await postDailyScheduleFromEspn(message.guild.id, message.channel, formattedDate, {
        notifyOnError: true
      });

      if (result?.ok) {
        if (result.postedCount > 0) {
          await progressMessage.edit(`Done. Posted ${result.postedCount} game${result.postedCount === 1 ? '' : 's'} for ${formattedDate}.`);
        } else {
          await progressMessage.edit(`Done. No games were found for ${formattedDate}.`);
        }
      } else {
        const errorCode = result?.code ? ` (${result.code})` : '';
        await progressMessage.edit(`Done with errors${errorCode}. Check messages above for details.`);
      }
      return;
    }

    if (message.content === '!gdd help') {
      await message.channel.send(
        [
          'Game Day Daily commands:',
          '!gdd setchannel',
          '!gdd timezone',
          '!gdd settime HH:MM (24-hour)',
          '!gdd follow <team name>',
          '!gdd followusmnt (quick follow for USA men\'s soccer)',
          '!gdd followid <sport> <league> <teamId> <team name>',
          '!gdd subplayoff <key> (examples: !gdd subplayoff nba-finals)',
          '!gdd unsubplayoff <key>',
          '!gdd playoffsubs',
          '!gdd setemoji (interactive) or !gdd setemoji <team name> <custom emoji>',
          '!gdd clearemoji <team name>',
          '!gdd unfollow',
          '!gdd current',
          '!gdd today',
          '!gdd <date> (MM/DD/YY, MM/DD/YYYY, or YYYY-MM-DD)',
          '',
          'Daily behavior:',
          'At your configured time each morning, the bot uses ESPN schedule data to check whether followed teams play today, plus time, venue, and watch info.',
          'Team follow spans all discovered leagues for that team (for example, USA soccer can include friendlies and World Cup).',
          'Use playoff subscriptions for stage-based games where teams vary each year (for example, World Cup knockout rounds).',
          `Available playoff keys:\n${formatPlayoffKeyList()}`
        ].join('\n')
      );
    }
  } catch (error) {
    console.error('Command handling error', error);
    await message.channel.send('There was an error processing your request.');
  }
});

const app = express();
const port = Number(process.env.PORT || 8080);

app.get('/', (req, res) => {
  res.send('Game Day Daily bot is running.');
});

app.listen(port, () => {
  console.log(`HTTP server listening on port ${port}`);
});

cron.schedule('*/15 * * * *', async () => {
  console.log('Running scheduled ESPN game checks...');
  await runScheduledMorningChecks();
});

ensureSchema()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('Startup failed while preparing schema', err);
    process.exit(1);
  });
