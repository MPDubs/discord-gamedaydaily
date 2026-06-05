const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const express = require('express');

const { resolveTeamWithEspn, getEspnGamesForTeams, discoverLeaguesForTeam } = require('./espn_lookup');
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

    if (teams.length === 0) {
      if (notifyOnError && !silentIfNoGames) {
        await channel.send('No teams are currently being followed in this server.');
      }
      return { ok: true, postedCount: 0, noGamesCount: 0 };
    }

    const lookup = await getEspnGamesForTeams({
      followedTeams: teams,
      targetDate,
      timezone: serverTimezone
    });

    if (lookup.error) {
      if (notifyOnError) {
        await channel.send(`ESPN lookup failed (${lookup.error.code}): ${lookup.error.message}`);
      }
      return { ok: false, code: lookup.error.code, message: lookup.error.message };
    }

    const normalizedGames = lookup.games || [];
    const noGames = lookup.noGames || [];

    if (normalizedGames.length === 0) {
      if (!silentIfNoGames) {
        await channel.send(`No games found for followed teams on ${targetDate}.`);
      }
      return { ok: true, postedCount: 0, noGamesCount: noGames.length };
    }

    const embedsToSend = [];

    for (const game of normalizedGames) {
      const teamEmoji = getTeamEmoji(emojiMap, autoEmojiMap, game.team);
      const opponentEmoji = getTeamEmoji(emojiMap, autoEmojiMap, game.opponent);
    const matchupTitle = `${teamEmoji ? `${teamEmoji} ` : ''}${game.team} vs ${opponentEmoji ? `${opponentEmoji} ` : ''}${game.opponent}`;
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

    if (game.teamLogoUrl) {
      embed.setThumbnail(game.teamLogoUrl);
    } else if (teamEmoji) {
      const emojiThumbnailUrl = emojiToAssetUrl(teamEmoji);
      if (emojiThumbnailUrl) {
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

  const resolution = await resolveTeamWithEspn(teamName);
  const resolved = resolution?.bestMatch || null;

  let knownLeagues = '';
  if (resolved?.teamId && resolved?.sport) {
    try {
      const discoveredLeagues = await discoverLeaguesForTeam(resolved.sport, resolved.teamId);
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

  if (resolved) {
    await message.channel.send(
      `Now following ${teamName}. Resolved to ESPN team: ${resolved.displayName} (${resolved.league}, confidence: ${resolved.confidence}).`
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

  let knownLeagues = '';
  try {
    const discoveredLeagues = await discoverLeaguesForTeam(sport, teamId);
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

  await message.channel.send(
    `Now following ${teamName} with manual ESPN mapping (${sport}/${league}, team ID: ${teamId}).`
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

    if (message.content.startsWith('!gdd ') && !message.content.startsWith('!gdd follow') && !message.content.startsWith('!gdd unfollow') && !message.content.startsWith('!gdd setemoji') && !message.content.startsWith('!gdd clearemoji') && !message.content.startsWith('!gdd timezone') && !message.content.startsWith('!gdd settime') && !message.content.startsWith('!gdd setchannel') && !message.content.startsWith('!gdd current') && !message.content.startsWith('!gdd help') && !message.content.startsWith('!gdd today') && !message.content.startsWith('!gdd followid')) {
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
          '!gdd followid <sport> <league> <teamId> <team name>',
          '!gdd setemoji (interactive) or !gdd setemoji <team name> <custom emoji>',
          '!gdd clearemoji <team name>',
          '!gdd unfollow',
          '!gdd current',
          '!gdd today',
          '!gdd <date> (MM/DD/YY, MM/DD/YYYY, or YYYY-MM-DD)',
          '',
          'Daily behavior:',
          'At your configured time each morning, the bot uses ESPN schedule data to check whether followed teams play today, plus time, venue, and watch info.'
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
