const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const { Pool } = require('pg');
const moment = require('moment-timezone');
const express = require('express');

const { lookupGamesForTeams } = require('./game_lookup_agent');

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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (server_id, team_name)
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
      SELECT id, team_name AS name
      FROM tracked_teams
      WHERE server_id = $1
      ORDER BY team_name ASC;
    `,
    [serverPrimaryId]
  );

  return result.rows;
}

function normalizeLookupResponse(data, teamNameFallbackList) {
  const teams = Array.isArray(teamNameFallbackList) ? teamNameFallbackList : [];
  const games = Array.isArray(data?.games) ? data.games : [];

  const normalizedGames = games
    .filter((g) => g && typeof g === 'object')
    .map((g) => ({
      team: String(g.team || '').trim(),
      opponent: String(g.opponent || 'TBD').trim(),
      startTimeLocal: String(g.start_time_local || g.startTimeLocal || 'TBD').trim(),
      venue: String(g.venue || 'TBD').trim(),
      location: String(g.location || 'TBD').trim(),
      watch: String(g.watch || 'TBD').trim(),
      competition: String(g.competition || 'TBD').trim(),
      confidence: String(g.confidence || 'medium').trim().toLowerCase(),
      sourceUrl: String(g.source_url || g.sourceUrl || '').trim(),
      notes: String(g.notes || '').trim()
    }))
    .filter((g) => g.team.length > 0);

  const withGames = new Set(normalizedGames.map((g) => g.team.toLowerCase()));
  const noGames = teams.filter((team) => !withGames.has(team.toLowerCase()));

  return { normalizedGames, noGames };
}

async function postAiScheduleForServer(discordServerId, channel, targetDate) {
  const serverResult = await pool.query('SELECT id, timezone FROM servers WHERE server_id = $1', [discordServerId]);
  if (serverResult.rowCount === 0) {
    await channel.send('This server is not configured yet. Use !gdd setchannel first.');
    return;
  }

  const serverPrimaryId = serverResult.rows[0].id;
  const serverTimezone = serverResult.rows[0].timezone || 'America/New_York';
  const teams = await getFollowedTeams(serverPrimaryId);

  if (teams.length === 0) {
    await channel.send('No teams are currently being followed in this server.');
    return;
  }

  const teamNames = teams.map((t) => t.name);
  const lookup = await lookupGamesForTeams({
    teamNames,
    targetDate,
    timezone: serverTimezone
  });

  if (lookup?.error) {
    await channel.send(
      `AI lookup failed (${lookup.error.code}). ${lookup.error.message}`
    );
    return;
  }

  const { normalizedGames, noGames } = normalizeLookupResponse(lookup, teamNames);

  if (normalizedGames.length === 0) {
    await channel.send(`No games found for followed teams on ${targetDate}.`);
    return;
  }

  await channel.send(`Game Day Daily AI check for ${targetDate} (${serverTimezone})`);

  for (const game of normalizedGames) {
    const confidenceLabel = game.confidence.toUpperCase();

    const embed = new EmbedBuilder()
      .setColor('#0f766e')
      .setTitle(`${game.team} vs ${game.opponent}`)
      .setDescription(game.notes || 'Daily game lookup via AI web search.')
      .addFields(
        { name: 'Start Time', value: game.startTimeLocal || 'TBD', inline: true },
        { name: 'Venue', value: game.venue || 'TBD', inline: true },
        { name: 'Location', value: game.location || 'TBD', inline: true },
        { name: 'Watch', value: game.watch || 'TBD', inline: true },
        { name: 'Competition', value: game.competition || 'TBD', inline: true },
        { name: 'Confidence', value: confidenceLabel, inline: true }
      )
      .setFooter({ text: 'Source found by AI web search' })
      .setTimestamp();

    if (game.sourceUrl) {
      embed.setURL(game.sourceUrl);
    }

    await channel.send({ embeds: [embed] });
  }

  if (noGames.length > 0) {
    await channel.send(`No game found today for: ${noGames.join(', ')}`);
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

        await postAiScheduleForServer(server.server_id, channel, localDate);
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

  await pool.query(
    `
      INSERT INTO tracked_teams (server_id, team_name)
      VALUES ($1, $2)
      ON CONFLICT (server_id, team_name) DO NOTHING;
    `,
    [serverPrimaryId, teamName]
  );

  await message.channel.send(`Now following ${teamName}.`);
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
    prompt += `${idx + 1}. ${team.name}\n`;
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

      await message.channel.send(`Followed teams:\n${teams.map((t, i) => `${i + 1}. ${t.name}`).join('\n')}`);
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
      await postAiScheduleForServer(message.guild.id, message.channel, date);
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
          '!gdd unfollow',
          '!gdd current',
          '!gdd today',
          '',
          'Daily behavior:',
          'At your configured time each morning, the bot asks an AI web-search agent to check whether followed teams play today, plus time, venue, and watch info.'
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
  console.log('Running scheduled AI game checks...');
  await runScheduledMorningChecks();
});

ensureSchema()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('Startup failed while preparing schema', err);
    process.exit(1);
  });
