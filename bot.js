const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const { Pool } = require('pg'); 
const moment = require('moment-timezone');
const OpenAI = require('openai');
const openai = new OpenAI();
const { startGettingGameDetails } = require('./news');

// Configure PostgreSQL connection pool
const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.PORT, 
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
const sportEmojis = {
	'American Football': '🏈',
	'Men\'s Basketball': '🏀',
	'Baseball': '⚾',
	'Football': '⚽',
	'Hockey': '🏒',
	'Tennis': '🎾',
	'Golf': '⛳',
	// Add more sports and their corresponding emojis as needed
};

// Function to send the daily schedule to all servers at midnight in their local time zone
async function hourlyServerCheck() {
  try {
    // Fetch all servers and their time_to_post and timezone from the database
    const serversResult = await pool.query(`
      SELECT server_id, channel_id, time_to_post, timezone
      FROM servers;
    `);
    
    const servers = serversResult.rows;

    servers.forEach(async (server) => {
      const serverTimezone = server.timezone || 'America/New_York'; // Default to EST if not set
      const currentTimeInServerTimezone = moment().tz(serverTimezone);

      // Check if the server has a valid time_to_post
      if (!server.time_to_post) {
        console.log(`Skipping server: ${server.server_id} because time_to_post is not set.`);
        return;
      }

      // Parse time_to_post into a moment object
      const [postHour, postMinute] = server.time_to_post.split(':');
      const timeToPostMoment = currentTimeInServerTimezone.clone().hour(postHour).minute(postMinute).second(0);

      // Calculate the difference in minutes between the current time and the time_to_post
      const timeDifference = currentTimeInServerTimezone.diff(timeToPostMoment, 'minutes');

      // Post if it's within the same hour (timeDifference is between 0 and 59 minutes)
      if (timeDifference >= 0 && timeDifference < 30) {
        console.log(`Posting schedule for server: ${server.server_id} at ${currentTimeInServerTimezone.format('HH:mm')}`);

        // Get the channel to post in
        const channel = await client.channels.fetch(server.channel_id);
        if (!channel) {
          console.error(`Cannot find channel for server: ${server.server_id}`);
          return;
        }

        // Fetch the followed teams and post the daily schedule for this server
        await postDailyScheduleForServer(server.server_id, channel);
      } else {
        console.log(`Skipping server: ${server.server_id} at ${currentTimeInServerTimezone.format('HH:mm')} (Time difference: ${timeDifference} minutes)`);
      }
    });
  } catch (error) {
    console.error('Error fetching or posting schedules:', error);
  }
}
// Function to send the daily schedule to a specific server
async function postDailyScheduleForServer(serverId, channel) {
  try {
    // Check if the server exists in the 'servers' table and get its 'id' and timezone
    const serverCheckResult = await pool.query('SELECT id, timezone FROM servers WHERE server_id = $1', [serverId]);
    let serverPrimaryKeyId;
    let serverTimezone = 'America/New_York'; // Default to EST if not set

    if (serverCheckResult.rowCount === 0) {
      channel.send(`⚠️ Timezone has not been set for this server. Defaulting to EST (America/New_York). Use "!gdd timezone" to set the correct timezone.`);
      return;
    } else {
      serverPrimaryKeyId = serverCheckResult.rows[0].id;
      serverTimezone = serverCheckResult.rows[0].timezone || 'America/New_York';
    }

    // Get the current date in the server's timezone
    const currentDate = moment.tz(serverTimezone).format('YYYY-MM-DD');

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
      channel.send(`No teams are currently being followed in this server.`);
      return;
    }

    let gamesMessage = `**Let's Go! It's game day! (${currentDate})**:\n\n`;
    let gamesFound = false;
    const allGames = []; // Array to collect all games for sorting

    // Retrieve all scheduled games for the followed teams on the current date from the schedules table
    const gamesResult = await pool.query(
      `
        SELECT 
          s.id, 
          s.game_key, 
          s.home_team_id, 
          s.away_team_id, 
          s.game_date, 
          s.game_time, 
          s.sportsdataio_game_id, 
          c.name AS competition,
          sp.name AS sport_name,
          -- Convert game_time to the server's timezone and extract the date
          CASE 
            WHEN s.game_time IS NOT NULL 
            THEN (timezone($3, s.game_time))::date
            ELSE (timezone($3, s.game_date))::date
          END AS local_game_date
        FROM schedules s
        JOIN competitions c ON s.competition_id = c.id
        JOIN sports sp ON s.sport_id = sp.id
        WHERE 
          (CASE 
            WHEN s.game_time IS NOT NULL 
            THEN (timezone($3, s.game_time))::date
            ELSE (timezone($3, s.game_date))::date
          END) = $1
        AND (s.home_team_id = ANY($2::int[]) OR s.away_team_id = ANY($2::int[]));
      `,
      [currentDate, followedTeamIds, serverTimezone]
    );

    console.log(gamesResult.rows);

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
      const sportName = game.sport_name;  // This is the sport name retrieved from the sports table
      let gameTimeFormatted = "TBD";

      if (game.game_time !== null) {
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
        sportsName: sportName,
        sportsdataioGameId: game.sportsdataio_game_id,
      });

      gamesFound = true;
    });

    // Sort games by time
    allGames.sort((a, b) => {
      if (a.time === "TBD") return 1; // Move "TBD" times to the end
      if (b.time === "TBD") return -1;
      return new Date(a.time) - new Date(b.time); // Sort based on actual date objects
    });

    // Format the games message with emojis, using server's timezone and sorted games
    allGames.forEach((game) => {
      const emoji = sportEmojis[game.sportsName] || "";
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
      channel.send(`No games found on ${currentDate} for followed teams in this server.`);
      return;
    }

    // Get the current date to determine the timezone abbreviation (e.g., PDT, EST)
    const currentMoment = moment.tz(moment(), serverTimezone);
    const timezoneAbbreviation = currentMoment.format('z');

    // Modify the gamesMessage to include the timezone abbreviation
    gamesMessage += `\n*Server is using the ${serverTimezone} timezone. Type "!gdd timezone" to change.*`;
    gamesMessage += `\n*Type "/!gdd info" for more help.*`;
    channel.send(gamesMessage);

  } catch (error) {
    console.error('Error retrieving games:', error);
    channel.send(`There was an error checking the games for today. Please try again later.`);
  }
}
// Store server and channel settings for notifications
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
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
			
			const matchingTeamsResult = await pool.query(
				`
					SELECT 
						t.id AS team_id, 
						t.name AS team_name, 
						s.name AS sport_name,  -- Get the sport name from the sports table
						string_agg(c.full_name, ', ') AS leagues
					FROM teams t
					JOIN team_competitions tc ON t.id = tc.team_id
					JOIN competitions c ON tc.competition_id = c.id
					JOIN sports s ON t.sport_id = s.id  -- Join the sports table to get the sport name
					WHERE LOWER(t.name) LIKE LOWER($1) OR LOWER(t.abbreviation) LIKE LOWER($1)
					GROUP BY t.id, t.name, s.name;
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
				const emoji = sportEmojis[team.sport_name] || '';  // Get the emoji for the sport or an empty string if not found
				responseMessage += `**${index + 1}. ${team.team_name}** *${emoji} ${team.sport_name} - ${team.leagues}*\n\n`;
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
						s.name AS sport_name,   -- Change this to fetch the sport name
						string_agg(c.name, ', ') AS leagues
					FROM server_teams st
					JOIN teams t ON st.team_id = t.id
					JOIN team_competitions tc ON t.id = tc.team_id
					JOIN competitions c ON tc.competition_id = c.id
					JOIN sports s ON t.sport_id = s.id  -- Join with sports table to get the sport name
					WHERE st.server_id = $1
					GROUP BY st.team_id, t.name, s.name;
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
				const emoji = sportEmojis[team.sport_name] || '';  // Get the emoji for the sport or an empty string if not found
				responseMessage += `**${index + 1}. ${team.team_name}** *${emoji} ${team.sport_name} - ${team.leagues}*\n\n`;
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
						s.name AS sport_name, -- Get the sport name
						string_agg(c.name, ', ') AS leagues
					FROM server_teams st
					JOIN teams t ON st.team_id = t.id -- Changed global_team_id to team_id
					JOIN team_competitions tc ON t.id = tc.team_id -- Changed global_team_id to team_id
					JOIN competitions c ON tc.competition_id = c.id
					JOIN sports s ON t.sport_id = s.id -- Join with the sports table to get the sport name
					WHERE st.server_id = $1
					GROUP BY t.id, t.name, s.name;
				`,
				[serverPrimaryKeyId]
			);
	
			const followedTeams = followedTeamsResult.rows;
	
			if (followedTeams.length === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}
	
			console.log(followedTeams);
	
			// Create a message listing all followed teams with their full names, sports, emojis, and their competitions
			let followedTeamsMessage = `**Currently followed teams in this server**:\n\n`;
			followedTeams.forEach((team, index) => {
				const emoji = sportEmojis[team.sport_name] || '';  // Get the emoji for the sport or an empty string if not found
				followedTeamsMessage += `**${index + 1}. ${team.team_name}** *${emoji} ${team.sport_name} - ${team.leagues}*\n\n`;
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

			// let gamesMessage = `**Events for (${normalizedDate})**:\n\n`;
			let gamesMessage = "";
			let gamesFound = false;
			const allGames = []; // Array to collect all games for sorting

			// Retrieve all scheduled games for the followed teams on the given date from the schedules table using internal team_id
			const gamesResult = await pool.query(
				`
					SELECT 
						s.id, 
						s.game_key, 
						s.home_team_id, 
						s.away_team_id, 
						s.game_date, 
						s.game_time, 
						s.sportsdataio_game_id, 
						c.name AS competition,
						sp.name AS sport_name,  -- Get the sport name from the sports table
						-- Convert game_time to the server's timezone and extract the date
						CASE 
							WHEN s.game_time IS NOT NULL 
							THEN (timezone($3, s.game_time))::date -- Convert game_time to the server's timezone
							ELSE (timezone($3, s.game_date))::date -- If game_time is null, use game_date in the server's timezone
						END AS local_game_date
					FROM schedules s
					JOIN competitions c ON s.competition_id = c.id
					JOIN sports sp ON s.sport_id = sp.id -- Join with the sports table using sport_id
					WHERE 
						-- Compare the local_game_date with the user's queried date
						(CASE 
							WHEN s.game_time IS NOT NULL 
							THEN (timezone($3, s.game_time))::date -- Convert game_time to the server's timezone
							ELSE (timezone($3, s.game_date))::date -- If game_time is null, use game_date in the server's timezone
						END) = $1
					AND (s.home_team_id = ANY($2::int[]) OR s.away_team_id = ANY($2::int[]));
				`,
				[normalizedDate, followedTeamIds, serverTimezone]
			);
			console.log(gamesResult.rows);
			// Extract all team IDs from the games (both home and away teams)
			const allTeamIds = Array.from(new Set([
				...gamesResult.rows.map(game => game.home_team_id),
				...gamesResult.rows.map(game => game.away_team_id)
			]));

			// Retrieve full names of all relevant teams (both followed and opponent teams)
			const teamNamesResult = await pool.query(
				`
					SELECT t.id, t.name, t.logo_url
					FROM teams t
					WHERE t.id = ANY($1::int[]);
				`,
				[allTeamIds]
			);

			const teamIdToFullNameMap = {};
			const teamIdToLogoUrlMap = {}; // New map for team logos
			teamNamesResult.rows.forEach(row => {
				teamIdToFullNameMap[row.id] = row.name;
				teamIdToLogoUrlMap[row.id] = row.logo_url; // Store logo_url for each team
			});

			// Process each game and format the message correctly
			gamesResult.rows.forEach((game) => {
				// Convert game time to server's timezone
				const sportName = game.sport_name;  // This is the sport name retrieved from the sports table
				let gameTimeFormatted = "TBD";
				console.log("GAME TIME: " + game.game_time);
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
					sportsName: sportName,
					sportsdataioGameId: game.sportsdataio_game_id,
				});

				gamesFound = true;
			});

			// Sort games by time
			allGames.sort((a, b) => {
				if (a.time === "TBD") return 1; // Move "TBD" times to the end
				if (b.time === "TBD") return -1;
				return new Date(a.time) - new Date(b.time); // Sort based on actual date objects
			});

			const date = new Date(normalizedDate);

			// Format the date to 'October 28, 2024'
			const formattedDate = date.toLocaleDateString('en-US', {
				year: 'numeric',
				month: 'long',
				day: 'numeric'
			});

			console.log(formattedDate); // Output: "October 28, 2024"
			// Format the games message with emojis, using server's timezone and sorted games
			for (const game of allGames) {

				const emoji = sportEmojis[game.sportsName] || "";
				const vsOrAt = followedTeamIds.includes(game.homeTeamId) ? "vs" : "@";
				const userTeamName = followedTeamIds.includes(game.homeTeamId) ? game.homeTeamName : game.awayTeamName;
				const opponentTeamName = followedTeamIds.includes(game.homeTeamId) ? game.awayTeamName : game.homeTeamName;
				const homeTeamLogo = teamIdToLogoUrlMap[game.homeTeamId];
				console.log("HOME TEAM LOGO: " + homeTeamLogo);
				const awayTeamLogo = teamIdToLogoUrlMap[game.awayTeamId];

				// Convert game time to server's set timezone and format it
				const serverTime = game.time !== "TBD" ? game.time : "TBD";
		
				// Format the message with the user's team, opponent, competition, and adjusted time
				let gameSummaryPrompt = `${normalizedDate} ${game.homeTeamName} ${vsOrAt} ${game.awayTeamName} (${game.competition})\n`;
				// gamesMessage += `${emoji}  **${serverTime} ${userTeamName} ${vsOrAt} ${opponentTeamName} (${game.competition})**\n`;
		
				// Await the OpenAI response inside the loop
				//let open_ai_details = await getGameDetails(gamesMessage);
				let open_ai_details = await startGettingGameDetails(gameSummaryPrompt)
				console.log(open_ai_details)
				// gamesMessage += `\n${open_ai_details}\n`;
				const url = open_ai_details.url;
				const mainUrl = new URL(url).hostname.split('.').slice(-2).join('.');
				console.log(mainUrl); // Output: "espn.com"
				const embed = new EmbedBuilder()
				.setColor('#0099ff')
				.setTitle(`${emoji} ${serverTime} - ${game.homeTeamName} ${vsOrAt} ${game.awayTeamName}`)
				.setURL(open_ai_details.url)
				// .setAuthor({
				// 		name: 'Article Author',
				// 		iconURL: 'https://example.com/author-avatar.png',
				// 		url: 'https://example.com/author-profile'
				// })
				.setDescription(open_ai_details.content)
				.setThumbnail(null)
				.addFields(
						{ name: 'Game Start', value: `${formattedDate} at ${serverTime}`, inline: true },
						{ name: 'League', value: `${game.competition}`, inline: true },
						{ name: 'Article From', value: `${mainUrl}`, inline: true },
				)
				.setImage(null)
				.setFooter({
						text: 'Summarized by OpenAI',
						iconURL: null
				})
				.setTimestamp();

				// Send the embed
				message.channel.send({ embeds: [embed] });



			}

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
	else if (message.content === '!gdd settime') {
		console.log("SETTIME COMMAND RECEIVED");
		const serverId = message.guild.id;
	
		// Display a list of times from 00:00 to 23:00
		let timeOptions = '';
		for (let i = 0; i < 24; i++) {
			const hour = i.toString().padStart(2, '0');
			timeOptions += `${i + 1}. ${hour}:00\n`;
		}
	
		// Send the options to the user
		message.channel.send(
			`Please select a time for the daily schedule (type the number corresponding to your choice):\n\n${timeOptions}`
		);
	
		// Set up a message collector to wait for the user's response
		const filter = response => {
			return response.author.id === message.author.id && /^\d+$/.test(response.content) && parseInt(response.content) > 0 && parseInt(response.content) <= 24;
		};
	
		const collector = message.channel.createMessageCollector({ filter, time: 30000 });
	
		collector.on('collect', async (response) => {
			const selectedOption = parseInt(response.content);
			const selectedTime = `${(selectedOption - 1).toString().padStart(2, '0')}:00`; // Convert the option to HH:00 format
	
			try {
				// Check if the server exists in the 'servers' table
				const serverCheckResult = await pool.query('SELECT id FROM servers WHERE server_id = $1', [serverId]);
				let serverPrimaryKeyId;
	
				if (serverCheckResult.rowCount === 0) {
					message.channel.send(`The server is not yet set. Please set the channel first using !gdd setchannel.`);
					return;
				} else {
					serverPrimaryKeyId = serverCheckResult.rows[0].id;
	
					// Update the time_to_post in the servers table
					await pool.query(
						`
							UPDATE servers
							SET time_to_post = $1
							WHERE id = $2;
						`,
						[selectedTime, serverPrimaryKeyId]
					);
					message.channel.send(`The daily schedule will now be posted at ${selectedTime}.`);
				}
			} catch (error) {
				console.error('Error setting time:', error);
				message.channel.send('There was an error setting the time. Please try again later.');
			}
	
			collector.stop(); // Stop the collector once the user selects a time
		});
	
		collector.on('end', (collected, reason) => {
			if (reason === 'time') {
				message.channel.send('You did not select a time in time. Please try again.');
			}
		});
	}
});

const express = require('express');
const app = express();
console.log("PORT", process.env.PORT);
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
cron.schedule('0 * * * *', () => {
  console.log('Running scheduled task every hour...');
  hourlyServerCheck();
});
// cron.schedule('*/5 * * * *', () => {
//   console.log('Running scheduled task every 5 minutes...');
//   hourlyServerCheck();
// });

client.login(process.env.DISCORD_TOKEN);
