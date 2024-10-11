const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const { Pool } = require('pg'); 
const moment = require('moment-timezone');

// Configure PostgreSQL connection pool
const pool = new Pool({
  user: 'postgres',
  host: '74.215.78.207',
  database: 'discord_gamedaydaily',
  password: 'sh3s!3Vc',
  port: 5432, 
});

// Connect to the pool and log success or failure
pool.connect()
  .then(client => {
    console.log("Connected to PostgreSQL using a pool");
    client.release(); // Release the client back to the pool
  })
  .catch(err => console.error("Connection error", err.stack));

// Create a new Discord client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});

// Function to send the daily schedule to all servers at midnight in their local time zone
const checkForHourlyUpdates = async () => {
  try {
    // Use pool to query the database
    const result = await pool.query('SELECT id, timezone, channel_id FROM servers');
    const servers = result.rows;

    for (const server of servers) {
      const serverTimezone = server.timezone || 'America/New_York';

      // Get the current time in the server's time zone
      const serverCurrentTime = moment.tz(moment(), serverTimezone);

      // Check if the current time is at the beginning of any hour
      if (serverCurrentTime.minute() === 0) {
        console.log(`Running hourly tasks for server ${server.id} (${serverTimezone})`);
        // Call function to send the hourly schedule to the server
        await sendDailyScheduleToServer(server.id, serverTimezone, server.channel_id);
      }
    }
  } catch (error) {
    console.error('Error sending hourly updates:', error);
  }
};

// Function to send the daily schedule to a specific server
const sendDailyScheduleToServer = async (serverId, serverTimezone, channelId) => {
  try {
    const normalizedDate = moment.tz(moment(), serverTimezone).format('YYYY-MM-DD');
    console.log(`Sending schedule for ${normalizedDate} to server ${serverId}...`);

    // Use pool to query the database
    const followsResult = await pool.query('SELECT team_id FROM server_teams WHERE server_id = $1', [serverId]);
    const followedTeams = followsResult.rows.map(row => row.team_id);

    if (followedTeams.length === 0) {
      console.log(`No teams are currently being followed in server ${serverId}.`);
      return;
    }

    let gamesMessage = `**Let's gooo! It's game day! (${normalizedDate})**:\n\n`;
    let gamesFound = false;
    const allGames = []; // Array to collect all games for sorting

    // Create a map to store the team IDs and their full names
    const sportEmojiMap = {
      american_football_nfl: "🏈",
      nba: "🏀",
      mlb: "⚾",
      nhl: "🏒",
    };

    // Retrieve all games on this day that involve the followed teams
    const gamesQuery = `
      SELECT s.*, ht.name as home_team_name, at.name as away_team_name
      FROM schedules s
      JOIN teams ht ON s.home_team_id = ht.id
      JOIN teams at ON s.away_team_id = at.id
      WHERE s.game_date = $1 AND (s.home_team_id = ANY($2::int[]) OR s.away_team_id = ANY($2::int[]))
    `;
    const gamesResult = await pool.query(gamesQuery, [normalizedDate, followedTeams]);

    for (const game of gamesResult.rows) {
      const gameTime = game.game_time ? moment.tz(game.game_time, 'UTC').tz(serverTimezone).format('h:mm A') : "TBD";
      allGames.push({
        sportId: game.sport_type,
        homeTeamId: game.home_team_id,
        homeTeamName: game.home_team_name,
        awayTeamId: game.away_team_id,
        awayTeamName: game.away_team_name,
        time: gameTime,
        channel: game.channel,
        timezone: serverTimezone,
      });

      gamesFound = true;
    }

    if (gamesFound) {
      allGames.sort((a, b) => {
        if (a.time === "TBD") return 1;
        if (b.time === "TBD") return -1;
        return new Date(a.date) - new Date(b.date);
      });

      allGames.forEach((game) => {
        const emoji = sportEmojiMap[game.sportId] || "";
        const vsOrAt = followedTeams.includes(game.homeTeamId) ? "vs" : "@";
        const userTeamName = followedTeams.includes(game.homeTeamId) ? game.homeTeamName : game.awayTeamName;
        const opponentTeamName = followedTeams.includes(game.homeTeamId) ? game.awayTeamName : game.homeTeamName;
        gamesMessage += `${emoji}  ${game.time} ${userTeamName} ${vsOrAt} ${opponentTeamName} ${game.channel ? `- on ${game.channel}` : ""}\n`;
      });

      if (channelId) {
        const channel = discordClient.channels.cache.get(channelId);
        if (channel) {
          await channel.send(gamesMessage);
        } else {
          console.error(`Channel with ID ${channelId} not found.`);
        }
      } else {
        console.error(`No channel ID found for server ${serverId}.`);
      }
    } else {
      if (channelId) {
        const channel = discordClient.channels.cache.get(channelId);
        if (channel) {
          await channel.send("There are no games scheduled today. :(");
        }
      }
    }
  } catch (error) {
    console.error(`Error sending daily schedule to server ${serverId}:`, error);
  }
};
// Store server and channel settings for notifications
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  // Follow a team
 // Follow a team
// Follow a team
	else if (message.content.startsWith('!gdd follow')) {
		console.log("FOLLOW COMMAND RECEIVED");
		const serverId = message.guild.id;
		const userId = message.author.id;
		const teamNameQuery = message.content.split(' ')[2]; // Get the team name from the command
		const channelId = message.channel.id; // Get the ID of the channel where the command was sent
		const channelName = message.guild.name;

		if (!teamNameQuery) {
			message.channel.send('Please provide a team name to follow.');
			return;
		}

		try {
			console.log("TRYING TO FOLLOW");
			message.channel.send('Searching... this can take a couple minutes.');

			// Check if the server exists in the 'servers' table and get its 'id'
			const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);
			let serverPrimaryKeyId;

			if (serverCheckResult.rowCount === 0) {
				// If server does not exist, insert it and get the 'id' of the inserted row
				const insertServerResult = await pool.query(
					`
						INSERT INTO servers (server_id, name, timezone, channel_id)
						VALUES ($1, $2, $3, $4)
						RETURNING id;
					`,
					[serverId, message.guild.name, 'America/New_York', message.channel.id] // Default values for timezone and channel_id
				);
				serverPrimaryKeyId = insertServerResult.rows[0].id; // Retrieve the id of the newly inserted server
				console.log(`Inserted server with ID ${serverId} into servers table with internal ID ${serverPrimaryKeyId}.`);
			} else {
				// If server already exists, get its 'id'
				serverPrimaryKeyId = serverCheckResult.rows[0].id;
			}

			// Search for matching teams in the PostgreSQL database, and aggregate all competitions for each team
			const matchingTeamsResult = await pool.query(
				`
					SELECT 
						t.id AS team_id, 
						t.name AS team_name, 
						t.sport_type AS sport,
						string_agg(c.name, ', ') AS leagues
					FROM teams t
					JOIN team_competitions tc ON t.id = tc.team_id
					JOIN competitions c ON tc.competition_id = c.id
					WHERE LOWER(t.name) LIKE LOWER($1) OR LOWER(t.abbreviation) LIKE LOWER($1)
					GROUP BY t.id, t.name, t.sport_type;
				`,
				[`%${teamNameQuery}%`]
			);
			const matchingTeams = matchingTeamsResult.rows;

			if (matchingTeams.length === 0) {
				message.channel.send(`No teams found matching "${teamNameQuery}".`);
				return;
			}

			// Send a numbered list of matching teams for the user to choose
			let responseMessage = `Found ${matchingTeams.length} team(s) matching "${teamNameQuery}":\n\n`;
			matchingTeams.forEach((team, index) => {
				responseMessage += `**${index + 1}. ${team.team_name}** *${team.sport} - ${team.leagues}*\n\n`;
			});
			responseMessage += `\nReply with the number of the team you want to follow.`;

			const filter = (response) => response.author.id === userId;
			message.channel.send(responseMessage).then(() => {
				// Wait for the user's response
				message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
					.then(async (collected) => {
						const selection = parseInt(collected.first().content);
						if (isNaN(selection) || selection < 1 || selection > matchingTeams.length) {
							message.channel.send(`Invalid selection. Please try again.`);
							return;
						}

						const selectedTeam = matchingTeams[selection - 1];
						const nowUTC = moment.utc().format('YYYY-MM-DD HH:mm:ss');
						console.log(`Current time in UTC: ${nowUTC}`);

						// Add the team to the server's follows in the PostgreSQL database using team_id
						await pool.query(
							`
								INSERT INTO server_teams (server_id, team_id, tracking_since)
								VALUES ($1, $2, $3)
								ON CONFLICT (server_id, team_id) DO NOTHING;
							`,
							[serverPrimaryKeyId, selectedTeam.team_id, nowUTC]
						);

						message.channel.send(`You have successfully followed ${selectedTeam.team_name}.`);
					})
					.catch((error) => {
						console.error('Error following team:', error);
						message.channel.send('You did not reply in time. Please try again.');
					});
			});
		} catch (error) {
			console.error('Error following team:', error);
			message.channel.send(`There was an error following the team. Please try again later.`);
		}
	}


	// Handle the !gdd unfollow command
	else if (message.content.startsWith('!gdd unfollow')) {
		console.log("UNFOLLOW COMMAND RECEIVED");
		const serverId = message.guild.id;
		const userId = message.author.id;

		try {
			console.log("TRYING TO UNFOLLOW");
			message.channel.send('Retrieving followed teams...');

			// Check if the server exists in the 'servers' table and get its 'id'
			const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);
			let serverPrimaryKeyId;

			if (serverCheckResult.rowCount === 0) {
				message.channel.send(`No followed teams found for this server.`);
				console.log(`Server ID ${serverId} does not exist in servers table.`);
				return;
			} else {
				// Get the internal 'id' of the server
				serverPrimaryKeyId = serverCheckResult.rows[0].id;
			}

			// Retrieve all followed teams for the server from the 'server_teams' table with their competitions
			const followedTeamsResult = await pool.query(
				`
					SELECT 
						st.team_id, 
						t.name AS team_name, 
						t.sport_type AS sport,
						string_agg(c.name, ', ') AS leagues
					FROM server_teams st
					JOIN teams t ON st.team_id = t.id
					JOIN team_competitions tc ON t.id = tc.team_id
					JOIN competitions c ON tc.competition_id = c.id
					WHERE st.server_id = $1
					GROUP BY st.team_id, t.name, t.sport_type;
				`,
				[serverPrimaryKeyId]
			);

			const followedTeams = followedTeamsResult.rows;

			if (followedTeams.length === 0) {
				message.channel.send(`You are not currently following any teams.`);
				return;
			}

			// Send a numbered list of followed teams for the user to choose which one to unfollow
			let responseMessage = `You are currently following the following team(s):\n\n`;
			followedTeams.forEach((team, index) => {
				responseMessage += `**${index + 1}. ${team.team_name}** *${team.sport} - ${team.leagues}*\n\n`;
			});
			responseMessage += `\nReply with the number of the team you want to unfollow.`;

			const filter = (response) => response.author.id === userId;
			message.channel.send(responseMessage).then(() => {
				// Wait for the user's response
				message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
					.then(async (collected) => {
						const selection = parseInt(collected.first().content);
						if (isNaN(selection) || selection < 1 || selection > followedTeams.length) {
							message.channel.send(`Invalid selection. Please try again.`);
							return;
						}

						const selectedTeam = followedTeams[selection - 1];

						// Remove the selected team from the server's follows in the PostgreSQL database using team_id
						await pool.query(
							`
								DELETE FROM server_teams
								WHERE server_id = $1 AND team_id = $2;
							`,
							[serverPrimaryKeyId, selectedTeam.team_id]
						);

						message.channel.send(`You have successfully unfollowed ${selectedTeam.team_name}.`);
					})
					.catch((error) => {
						console.error('Error unfollowing team:', error);
						message.channel.send('You did not reply in time. Please try again.');
					});
			});
		} catch (error) {
			console.error('Error unfollowing team:', error);
			message.channel.send(`There was an error unfollowing the team. Please try again later.`);
		}
	}
	// Handle !gdd timezone command
	else if (message.content === '!gdd timezone') {
		console.log("timezone COMMAND RECEIVED");
		const serverId = message.guild.id;
		const userId = message.author.id;

		// Define a list of popular timezones
		const timezones = [
			'America/New_York',     // Eastern Time (automatically handles EST and EDT)
			'America/Chicago',      // Central Time (automatically handles CST and CDT)
			'America/Denver',       // Mountain Time (automatically handles MST and MDT)
			'America/Los_Angeles',  // Pacific Time (automatically handles PST and PDT)
			'Europe/London',        // London Time (handles GMT and BST)
			'Europe/Berlin',        // Central European Time (handles CET and CEST)
			'Asia/Tokyo',           // Japan Standard Time (no DST)
			'Asia/Kolkata',         // India Standard Time (no DST)
			'Australia/Sydney',     // Australian Eastern Time (handles AEST and AEDT)
			'Pacific/Auckland',     // New Zealand Standard Time (handles NZST and NZDT)
			'Africa/Johannesburg'   // South Africa Standard Time (no DST)
		];

		// Display the list of timezones to the user
		let timezoneMessage = `**Select your server's timezone by replying with the corresponding number:**\n\n`;
		timezones.forEach((timezone, index) => {
				timezoneMessage += `${index + 1}. ${timezone}\n`;
		});

		// Send the list and wait for the user's response
		message.channel.send(timezoneMessage).then(() => {
				const filter = (response) => response.author.id === userId;
				message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
						.then(async (collected) => {
								const selection = parseInt(collected.first().content);
								if (isNaN(selection) || selection < 1 || selection > timezones.length) {
										message.channel.send(`Invalid selection. Please try again.`);
										return;
								}

								// Get the selected timezone (e.g., "America/New_York")
								const selectedTimezone = timezones[selection - 1].split(' ')[0]; 

								try {
										// Check if the server exists in the database
										const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);
										
										if (serverCheckResult.rowCount === 0) {
												// If server does not exist, insert it with the default timezone
												await pool.query(
														`
														INSERT INTO servers (server_id, name, timezone, channel_id)
														VALUES ($1, $2, $3, $4)
														ON CONFLICT (server_id) DO NOTHING;
														`,
														[serverId, message.guild.name, selectedTimezone, message.channel.id]
												);
												console.log(`Inserted new server with ID ${serverId} and set its timezone to ${selectedTimezone}.`);
										} else {
												// If server exists, update the timezone
												await pool.query(
														`
														UPDATE servers
														SET timezone = $1
														WHERE server_id = $2;
														`,
														[selectedTimezone, serverId]
												);
												console.log(`Updated server timezone to ${selectedTimezone} for server with ID ${serverId}.`);
										}

										message.channel.send(`Server timezone has been set to: **${selectedTimezone}**`);
								} catch (error) {
										console.error('Error updating server timezone:', error);
										message.channel.send(`There was an error updating the timezone. Please try again later.`);
								}
						})
						.catch(() => {
								message.channel.send('You did not reply in time. Please try again.');
						});
		});
	}

	// Handle !gdd current command
	else if (message.content === '!gdd current') {
		console.log("CURRENT COMMAND RECEIVED");
		const serverId = message.guild.id;

		try {
			// Retrieve the server's internal ID from the 'servers' table
			const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);

			if (serverCheckResult.rowCount === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}

			const serverPrimaryKeyId = serverCheckResult.rows[0].id;

			// Retrieve the list of teams followed by the server from the 'server_teams' table with a comma-separated list of competitions
			const followedTeamsResult = await pool.query(
				`
					SELECT 
						t.name AS team_name, 
						t.sport_type AS sport, 
						string_agg(c.name, ', ') AS leagues
					FROM server_teams st
					JOIN teams t ON st.global_team_id = t.global_team_id
					JOIN team_competitions tc ON t.global_team_id = tc.global_team_id
					JOIN competitions c ON tc.competition_id = c.id
					WHERE st.server_id = $1
					GROUP BY t.global_team_id, t.name, t.sport_type;
				`,
				[serverPrimaryKeyId]
			);

			const followedTeams = followedTeamsResult.rows;

			if (followedTeams.length === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}

			console.log(followedTeams);
			// Create a message listing all followed teams with their full names and their competitions
			let followedTeamsMessage = `**Currently followed teams in this server**:\n\n`;
			followedTeams.forEach((team, index) => {
				followedTeamsMessage += `**${index + 1}. ${team.team_name}** *${team.sport} - ${team.leagues}*\n\n`;
			});

			message.channel.send(followedTeamsMessage);

		} catch (error) {
			console.error('Error retrieving followed teams:', error);
			message.channel.send(`There was an error retrieving the list of followed teams. Please try again later.`);
		}
	}
	// Handle !gdd setchannel command
	else if (message.content === '!gdd setchannel') {
		console.log("SETCHANNEL COMMAND RECEIVED");
		const serverId = message.guild.id;
		const channelId = message.channel.id; // Get the ID of the channel where the command was sent
		const serverName = message.guild.name;

		try {
			// Check if the server exists in the 'servers' table
			const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);
			let serverPrimaryKeyId;

			if (serverCheckResult.rowCount === 0) {
				// If server does not exist, insert it and get the 'id' of the inserted row
				const insertServerResult = await pool.query(
					`
						INSERT INTO servers (server_id, name, timezone, channel_id)
						VALUES ($1, $2, $3, $4)
						RETURNING id;
					`,
					[serverId, serverName, 'America/New_York', channelId] // Default values for timezone and channel_id
				);
				serverPrimaryKeyId = insertServerResult.rows[0].id; // Retrieve the id of the newly inserted server
				console.log(`Inserted server with ID ${serverId} into servers table with internal ID ${serverPrimaryKeyId}.`);
			} else {
				// If server already exists, get its 'id'
				serverPrimaryKeyId = serverCheckResult.rows[0].id;

				// Update the channel ID for the existing server
				await pool.query(
					`
						UPDATE servers
						SET channel_id = $1
						WHERE id = $2;
					`,
					[channelId, serverPrimaryKeyId]
				);
				console.log(`Updated channel ID for server with ID ${serverId}.`);
			}

			message.channel.send(`This channel has been set as the channel for daily schedules.`);
		} catch (error) {
			console.error('Error setting channel:', error);
			message.channel.send('There was an error setting this channel. Please try again later.');
		}
	}
	else if (message.content === '!gdd help') {
		const helpMessage = `
			**__Get Started with Game Day Daily (GDD):__**
			
			1. **Set Channel**: Type \`/!gdd setchannel\` in the channel where you want GDD to automatically post the daily schedule.
			2. **Set Timezone**: Type \`/!gdd timezone\` to set your server's timezone for accurate game times.
			3. **Follow Teams**: Type \`/!gdd follow [search]\` — replace \`[search]\` with a keyword from your team's name like \`Bengals\` or \`Los Angeles\`. *Note: It may take a few minutes for GDD to respond with results.*
			4. **Unfollow Teams**: Type \`/!gdd unfollow\` to remove a team from your follow list.
			5. **Check Followed Teams**: Type \`/!gdd current\` to see your currently followed teams.
			6. **Look Up a Schedule**: Type \`/!gdd YYYY-MM-DD\` to look up scheduled events for a specific date.\n
*Need more help or have feedback?\n Feel free to reach out to Mike\nhttps://github.com/MPDubs*\n\`dudewhy.\` on Discord*
		`;

		message.channel.send(helpMessage);
	}
	// Handle !gdd current command for a specific date
	else if (message.content.match(/^!gdd \d{4}-\d{1,2}-\d{1,2}$/)) {
		const serverId = message.guild.id;

		// Get the date from the command
		const dateQuery = message.content.split(' ')[1];

		// Normalize the date input to YYYY-MM-DD format
		let [year, month, day] = dateQuery.split('-');
		month = month.padStart(2, '0');
		day = day.padStart(2, '0');
		const normalizedDate = `${year}-${month}-${day}`;

		try {
			// Check if the server exists in the 'servers' table and get its 'id' and timezone
			const serverCheckResult = await pool.query('SELECT id, timezone FROM servers WHERE server_id = $1', [serverId]);
			let serverPrimaryKeyId;
			let serverTimezone = 'America/New_York'; // Default to EST if not set

			if (serverCheckResult.rowCount === 0) {
				message.channel.send(`⚠️ Timezone has not been set for this server. Defaulting to EST (America/New_York). Use "!gdd timezone" to set the correct timezone.`);
				return;
			} else {
				serverPrimaryKeyId = serverCheckResult.rows[0].id;
				serverTimezone = serverCheckResult.rows[0].timezone || 'America/New_York';
			}

			// Retrieve the list of teams followed by the server from 'server_teams' using team_id (internal ID)
			const followedTeamsResult = await pool.query(
				`
				SELECT st.team_id
				FROM server_teams st
				WHERE st.server_id = $1;
				`,
				[serverPrimaryKeyId]
			);
			const followedTeamIds = followedTeamsResult.rows.map(row => row.team_id);

			if (followedTeamIds.length === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}

			let gamesMessage = `**Events for (${normalizedDate})**:\n\n`;
			let gamesFound = false;
			const allGames = []; // Array to collect all games for sorting

			// Retrieve all scheduled games for the followed teams on the given date from the schedules table using internal team_id
			const gamesResult = await pool.query(
				`
					SELECT s.id, s.game_key, s.home_team_id, s.away_team_id, s.game_date, s.game_time, s.sportsdataio_game_id, 
												c.name AS competition
					FROM schedules s
					JOIN competitions c ON s.competition_id = c.id
					WHERE s.game_date = $1 AND (s.home_team_id = ANY($2::int[]) OR s.away_team_id = ANY($2::int[]));
				`,
				[normalizedDate, followedTeamIds]
			);

			// Extract all team IDs from the games (both home and away teams)
			const allTeamIds = Array.from(new Set([
				...gamesResult.rows.map(game => game.home_team_id),
				...gamesResult.rows.map(game => game.away_team_id)
			]));

			// Retrieve full names of all relevant teams (both followed and opponent teams)
			const teamNamesResult = await pool.query(
				`
					SELECT t.id, t.name
					FROM teams t
					WHERE t.id = ANY($1::int[]);
				`,
				[allTeamIds]
			);

			const teamIdToFullNameMap = {};
			teamNamesResult.rows.forEach(row => {
				teamIdToFullNameMap[row.id] = row.name;
			});

			// Process each game and format the message correctly
			gamesResult.rows.forEach((game) => {
				// Convert game time to server's timezone
				let gameTimeFormatted = "TBD";
				if (game.game_time !== null) {
					// Convert game time to the server's timezone
					gameTimeFormatted = moment.tz(game.game_time, 'UTC').tz(serverTimezone).format('h:mm A');
				}

				allGames.push({
					competition: game.competition,
					homeTeamId: game.home_team_id,
					homeTeamName: teamIdToFullNameMap[game.home_team_id] || game.home_team_id,
					awayTeamId: game.away_team_id,
					awayTeamName: teamIdToFullNameMap[game.away_team_id] || game.away_team_id,
					time: gameTimeFormatted,
					gameKey: game.game_key,
					sportsdataioGameId: game.sportsdataio_game_id,
				});

				gamesFound = true;
			});

			const sportEmojiMap = {
				american_football_nfl: "🏈",
				nba: "🏀",
				mlb: "⚾",
				nhl: "🏒",
			};

			// Sort games by time
			allGames.sort((a, b) => {
				if (a.time === "TBD") return 1; // Move "TBD" times to the end
				if (b.time === "TBD") return -1;
				return new Date(a.time) - new Date(b.time); // Sort based on actual date objects
			});

			// Format the games message with emojis, using server's timezone and sorted games
			allGames.forEach((game) => {
				const emoji = sportEmojiMap[game.sport] || "";
				const vsOrAt = followedTeamIds.includes(game.homeTeamId) ? "vs" : "@";
				const userTeamName = followedTeamIds.includes(game.homeTeamId) ? game.homeTeamName : game.awayTeamName;
				const opponentTeamName = followedTeamIds.includes(game.homeTeamId) ? game.awayTeamName : game.homeTeamName;

				// Convert game time to server's set timezone and format it
				const serverTime = game.time !== "TBD" ? game.time : "TBD";

				// Format the message with the user's team, opponent, competition, and adjusted time
				gamesMessage += `${emoji}  ${serverTime} ${userTeamName} ${vsOrAt} ${opponentTeamName} (${game.competition})\n`;
			});

			// If no games were found, send a message indicating this
			if (!gamesFound) {
				message.channel.send(`No games found on ${normalizedDate} for followed teams in this server.`);
				return;
			}

			// Get the current date to determine the timezone abbreviation (e.g., PDT, EST)
			const currentMoment = moment.tz(moment(), serverTimezone);
			const timezoneAbbreviation = currentMoment.format('z');

			// Modify the gamesMessage to include the timezone abbreviation
			gamesMessage += `\n*Server is using the ${serverTimezone} timezone. Type "!gdd timezone" to change.*`;
			gamesMessage += `\n*type "/!gdd info" for more help.*`;
			message.channel.send(gamesMessage);
		} catch (error) {
			console.error('Error retrieving games:', error);
			message.channel.send(`There was an error checking the games for ${normalizedDate}. Please try again later.`);
		}
	}
});

const express = require('express');
const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('Discord bot is running.');
});

app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}`);
});

// Keep the bot login at the end of the file
// Schedule the job to run at 12:00 AM daily
// Schedule the function to run every hour
// cron.schedule('0 * * * *', () => {
//   console.log('Running scheduled task every hour...');
//   checkForHourlyUpdates();
// });
console.log("DISCORD TROKEN:  " + process.env.DISCORD_TOKEN)
client.login(process.env.DISCORD_TOKEN);
