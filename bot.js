const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();
const cron = require('node-cron');
const admin = require('firebase-admin');
const { Timestamp } = require('firebase-admin').firestore;
const moment = require('moment-timezone');

// Initialize Firestore
const serviceAccount = require('./gamedaydaily-b98a9-firebase-adminsdk-xjkcu-7aaff15be1.json'); // Replace with your Firebase service account file
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();
db.settings({
  connectTimeout: 60000, // Connection timeout in milliseconds (60 seconds)
  maxIdleChannels: 10,    // Maximum number of idle channels
});

// Create a new Discord client instance
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  ]
});
// Utility function to format the game time from a date string
function formatGameTime(dateString) {
  const date = new Date(dateString);
  const hours = date.getHours() > 12 ? date.getHours() - 12 : date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = date.getHours() >= 12 ? 'p' : 'a';
  return `${hours}:${minutes}${ampm}`;
}
// Function to send the daily schedule to all servers at midnight in their local time zone
const checkForHourlyUpdates = async () => {
  try {
    const serversSnapshot = await db.collection('servers').get();

    for (const serverDoc of serversSnapshot.docs) {
      const serverData = serverDoc.data();
      const serverTimezone = serverData.timezone || 'America/New_York';

      // Get the current time in the server's time zone
      const serverCurrentTime = moment.tz(moment(), serverTimezone);
      console.log("serverCurrentTime", serverCurrentTime);

      // Check if the current time is around the beginning of any hour
      if (serverCurrentTime.minute() === 0) {
        console.log(`Running hourly tasks for server ${serverDoc.id} (${serverTimezone})`);

        // Call function to send the hourly schedule to the server
        await sendDailyScheduleToServer(serverDoc.id, serverTimezone);
      }
    }
  } catch (error) {
    console.error('Error sending hourly updates:', error);
  }
};


// Function to send the daily schedule to a specific server
const sendDailyScheduleToServer = async (serverId, serverTimezone) => {
  try {
    // const normalizedDate = moment.tz(moment(), serverTimezone).format('YYYY-MM-DD');
		const normalizedDate = moment.tz(moment(), serverTimezone).format('YYYY-MM-DD');
    console.log(`Sending schedule for ${normalizedDate} to server ${serverId}...`);

    // Get followed teams for the server
    const followsSnapshot = await db.collection('servers').doc(serverId).collection('follows').get();
    const followedTeams = followsSnapshot.docs.map(doc => doc.data().team_id);

    if (followedTeams.length === 0) {
      console.log(`No teams are currently being followed in server ${serverId}.`);
      return;
    }

    // Retrieve all available sports in the 'schedules' collection
    const sportsCollectionsSnapshot = await db.collection('schedules').listDocuments();
    const sportsCollections = sportsCollectionsSnapshot.map(doc => doc.id);

    let gamesMessage = `**Let's gooo! It's game day! (${normalizedDate})**:\n\n`;
    let gamesFound = false;
    const allGames = []; // Array to collect all games for sorting

    // Create a map to store the team IDs and their full names
    const teamIdToFullNameMap = {};

    // Create a map to associate sports with emojis
    const sportEmojiMap = {
      american_football_nfl: "🏈",
      football_copa: "⚽",
      football_deb: "⚽",
      football_eflc: "⚽",
      football_epl: "⚽",
      football_esp: "⚽",
      football_fifaf: "⚽",
      football_lec: "⚽",
      football_mls: "⚽",
      football_uel: "⚽",
      nba: "🏀",
      basketball_mens_ncaa: "🏀",
      mlb: "⚾",
      nhl: "🏒",
    };

    for (const sportId of sportsCollections) {
      const followedTeamsInSport = followedTeams.filter(teamId => teamId.startsWith(sportId));
      if (followedTeamsInSport.length === 0) continue;

      for (const teamId of followedTeamsInSport) {
        // Query games with valid time
        const gamesWithTimeSnapshot = await db.collection('schedules')
          .doc(sportId)
          .collection(teamId)
          .where('day', '==', normalizedDate)
          .get();

        // Query games with "TBD" time
        const gamesWithTBDTimeSnapshot = await db.collection('schedules')
          .doc(sportId)
          .collection(teamId)
          .where('day', '==', normalizedDate)
          .get();

        const allGamesMap = new Map();

        gamesWithTimeSnapshot.forEach((doc) => {
          const gameData = doc.data();
          allGamesMap.set(doc.id, gameData);
        });

        gamesWithTBDTimeSnapshot.forEach((doc) => {
          if (!allGamesMap.has(doc.id)) {
            const gameData = doc.data();
            allGamesMap.set(doc.id, gameData);
          }
        });

        const allGamesForTeam = Array.from(allGamesMap.values());

        for (const gameData of allGamesForTeam) {
          const gameDate = gameData.time !== "TBD" ? gameData.time.toDate() : "TBD";
          const localTime = gameDate !== "TBD" ? moment.tz(gameDate, serverTimezone).format('h:mm A') : "TBD";
          allGames.push({
            sportId,
            homeTeamId: gameData.home_team_id,
            awayTeamId: gameData.away_team_id,
            date: gameDate,
            time: localTime,
            channel: gameData.channel,
            timezone: gameData.timezone || 'EST'
          });

          if (!teamIdToFullNameMap[gameData.home_team_id]) teamIdToFullNameMap[gameData.home_team_id] = null;
          if (!teamIdToFullNameMap[gameData.away_team_id]) teamIdToFullNameMap[gameData.away_team_id] = null;

          gamesFound = true;
        }
      }
    }
			// Retrieve the full names for all relevant teams (both followed and their opponents)
			const teamsSnapshot = await db.collection('teams').get();
			teamsSnapshot.forEach((doc) => {
				const sportTeams = doc.data().teams || [];
				sportTeams.forEach((team) => {
					if (teamIdToFullNameMap.hasOwnProperty(team.team_id)) {
						teamIdToFullNameMap[team.team_id] = team.full_name;
					}
				});
			});


    if (gamesFound) {
      allGames.sort((a, b) => {
        if (a.time === "TBD") return 1;
        if (b.time === "TBD") return -1;
        return a.date - b.date;
      });

      allGames.forEach((game) => {
        const homeTeamName = teamIdToFullNameMap[game.homeTeamId] || game.homeTeamId;
        const awayTeamName = teamIdToFullNameMap[game.awayTeamId] || game.awayTeamId;
        const emoji = sportEmojiMap[game.sportId] || "";

        const isHomeTeam = followedTeams.includes(game.homeTeamId);
        const userTeamName = isHomeTeam ? homeTeamName : awayTeamName;
        const opponentTeamName = isHomeTeam ? awayTeamName : homeTeamName;
        const vsOrAt = isHomeTeam ? "vs" : "@";

        const serverTime = game.date !== "TBD" ? moment.tz(game.date, serverTimezone).format('h:mm A') : "TBD";
        gamesMessage += `${emoji}  ${serverTime} ${userTeamName} ${vsOrAt} ${opponentTeamName} ${game.channel ? `- on ${game.channel}` : ""}\n`;
      });

			const serverConfigSnapshot = await db.collection('servers').doc(serverId).get();
			if (serverConfigSnapshot.exists && serverConfigSnapshot.data().channelId) {
				const channelId = serverConfigSnapshot.data().channelId; // Use the stored channel ID
				const channel = client.channels.cache.get(channelId);
			
				if (channel) {
					channel.send(gamesMessage);
				} else {
					console.error(`Channel with ID ${channelId} not found.`);
				}
			} else {
				console.error(`No channel ID found for server ${serverId}.`);
			}
    }else{
			const serverConfigSnapshot = await db.collection('servers').doc(serverId).get();
			if (serverConfigSnapshot.exists && serverConfigSnapshot.data().channelId) {
				const channelId = serverConfigSnapshot.data().channelId; // Use the stored channel ID
				const channel = client.channels.cache.get(channelId);
			
				if (channel) {
					channel.send("There are no games scheduled today. :(");
				} else {
					console.error(`Channel with ID ${channelId} not found.`);
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
	if (message.content.startsWith('!gdd follow')) {
		console.log("UNFOLLOW COMMAND RECIUEVED")
		const serverId = message.guild.id;
		const userId = message.author.id;
		const teamNameQuery = message.content.split(' ')[2]; // Get the team name from the command
	
		if (!teamNameQuery) {
			message.channel.send('Please provide a team name to follow.');
			return;
		}
		try {
			console.log("TRYING TO FOLLOW")
			message.channel.send('Searching... this can take a couple minutes.');
			// Retrieve all documents from the "unified_teams" collection first
			const unifiedTeamsSnapshot = await db.collection('unified_teams').get();
			let matchingTeams = [];
			console.log("message.channel.send('Searching... this can take a couple minutes.');")
			// Check unified teams collection for matches
			unifiedTeamsSnapshot.forEach(doc => {
				const team = doc.data();
				if (team.full_name.toLowerCase().includes(teamNameQuery.toLowerCase())) {
					matchingTeams.push({
						team_id_number: team.team_id_number,
						team_name: team.team_name,
						full_name: team.full_name,
						location: team.location,
						league: team.competitions.map(comp => comp.league).join(', '),
						sport: "Football",
						team_ids: team.team_ids,
					});
				}
			});
			console.log("munifiedTeamsSnapshot.forEach(doc => {")
			// Also search through non-football collections in the "teams" collection
			const teamsDocRefs = await db.collection('teams').listDocuments();
			console.log("const teamsDocRefs = await db.collection('teams').listDocuments();")
			for (const docRef of teamsDocRefs) {
				const collectionName = docRef.id;
	
				// Skip "football_" collections since they are already included in unified_teams
				if (collectionName.startsWith("football_")) continue;
	
				const teamsSnapshot = await docRef.get();
				const teams = teamsSnapshot.data()?.teams || [];
	
				// Filter teams based on the query and add to matching teams
				const collectionMatches = teams.filter(team =>
					team.full_name.toLowerCase().includes(teamNameQuery.toLowerCase())
				).map(team => ({
					team_id_number: team.team_id_number,
					team_name: team.team_name,
					full_name: team.full_name,
					sport: team.sport,
					league: team.league,
					location: team.location,
					competitions: [{ competition_key: collectionName }], // Add competition key from collection name
					team_ids: [team.team_id], // Wrap team_id in an array to match the format of unified teams
				}));
				console.log("const collectionMatches = teams.filter(team =>")
				matchingTeams = matchingTeams.concat(collectionMatches);
			}
	
			if (matchingTeams.length === 0) {
				message.channel.send(`No teams found matching "${teamNameQuery}".`);
				return;
			}
			console.log("	message.channel.send(`No teams found matching")
			// Send a numbered list of matching teams for the user to choose
			let responseMessage = `Found ${matchingTeams.length} team(s) matching "${teamNameQuery}":\n\n`;
			matchingTeams.forEach((team, index) => {
				responseMessage += `**${index + 1}. ${team.full_name}** *${team.sport} - ${team.league}*\n\n`;
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
	
						// Follow all team instances in competitions for this unified team
						for (const teamId of selectedTeam.team_ids) {
							const followData = {
								team_id: teamId,
								team_name: selectedTeam.full_name,
								followed_by: [userId]
							};
	
							// Check if this team is already being followed in the server
							const teamDocRef = db.collection('servers').doc(serverId).collection('follows').doc(teamId);
							const teamDoc = await teamDocRef.get();
	
							if (teamDoc.exists) {
								// Update the list of users following it
								const existingData = teamDoc.data();
								if (!existingData.followed_by.includes(userId)) {
									await teamDocRef.update({
										followed_by: admin.firestore.FieldValue.arrayUnion(userId)
									});
								}
							} else {
								// Add it to the server's follows
								await teamDocRef.set(followData);
							}
						}
	
						message.channel.send(`You have successfully followed ${selectedTeam.full_name}.`);
					})
					.catch(() => {
						message.channel.send('You did not reply in time. Please try again.');
					});
			});
		} catch (error) {
			console.error('Error following team:', error);
			message.channel.send(`There was an error following the team. Please try again later.`);
		}
	}

	// Unfollow a team
	else if (message.content === '!gdd unfollow') {
		console.log("FOLLOW COMMAND RECIUEVED")
		const serverId = message.guild.id;
		const userId = message.author.id;
	
		try {
			// Retrieve all teams followed by the server
			const followsSnapshot = await db.collection('servers').doc(serverId).collection('follows').get();
			const followedTeams = followsSnapshot.docs.map(doc => ({ ...doc.data(), docId: doc.id }));
	
			if (followedTeams.length === 0) {
				message.channel.send(`You are not currently following any teams.`);
				return;
			}
	
			// Map followed teams to their unified team ID and fetch unified teams
			const followedTeamIds = followedTeams.map(team => team.team_id);
			const unifiedTeamsSnapshot = await db.collection('unified_teams').where('team_ids', 'array-contains-any', followedTeamIds).get();
	
			// Create a set of unique unified teams
			const uniqueFollowedTeams = [];
			const trackedUnifiedTeamIds = new Set();
	
			// Include unified teams
			unifiedTeamsSnapshot.forEach(doc => {
				const teamData = doc.data();
				if (!trackedUnifiedTeamIds.has(doc.id)) {
					trackedUnifiedTeamIds.add(doc.id);
					uniqueFollowedTeams.push({
						team_name: teamData.full_name,
						team_ids: teamData.team_ids,
						sport: "Football",
						competitions: teamData.competitions.map(comp => comp.league).join(', '),
					});
				}
			});
	
			// Include teams in the "teams" collection that do not start with "football_"
			const teamsDocRefs = await db.collection('teams').listDocuments();
	
			for (const docRef of teamsDocRefs) {
				const collectionName = docRef.id;
	
				// Skip "football_" collections since they are already included in unified_teams
				if (collectionName.startsWith("football_")) continue;
	
				const teamsSnapshot = await docRef.get();
				const teams = teamsSnapshot.data()?.teams || [];
	
				// Filter followed teams in this non-football collection
				const collectionFollowedTeams = teams.filter(team =>
					followedTeamIds.includes(team.team_id)
				).map(team => ({
					team_name: team.full_name,
					team_ids: [team.team_id],
					sport: team.sport,
					competitions: team.league
				}));
	
				// Add these non-football followed teams to the uniqueFollowedTeams list
				uniqueFollowedTeams.push(...collectionFollowedTeams);
			}
	
			if (uniqueFollowedTeams.length === 0) {
				message.channel.send(`No unique teams found that you are following.`);
				return;
			}
	
			// Display the list of unique followed teams to the user
			let responseMessage = `You are currently following the following teams:\n\n`;
			uniqueFollowedTeams.forEach((team, index) => {
				responseMessage += `**${index + 1}. ${team.team_name}** *${team.sport} - ${team.competitions}*\n\n`;
			});
			responseMessage += `\nReply with the number of the team you want to unfollow.`;
	
			// Send the list to the user and wait for their response
			const filter = (response) => response.author.id === userId;
			message.channel.send(responseMessage).then(() => {
				message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] })
					.then(async (collected) => {
						const selection = parseInt(collected.first().content);
						if (isNaN(selection) || selection < 1 || selection > uniqueFollowedTeams.length) {
							message.channel.send(`Invalid selection. Please try again.`);
							return;
						}
	
						// Get the selected team to unfollow
						const selectedTeamToUnfollow = uniqueFollowedTeams[selection - 1];
	
						// Remove all instances of this unified team from the user's follow list in Firestore
						for (const teamId of selectedTeamToUnfollow.team_ids) {
							await db.collection('servers').doc(serverId).collection('follows').doc(teamId).delete();
						}
	
						message.channel.send(`You have successfully unfollowed ${selectedTeamToUnfollow.team_name}.`);
					})
					.catch(() => {
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
		console.log("timezone COMMAND RECIUEVED")
		const serverId = message.guild.id;
		const userId = message.author.id;

		// Define a list of popular timezones
		const timezones = [
				'America/New_York (EST)', 'America/Chicago (CST)', 'America/Denver (MST)', 'America/Los_Angeles (PST)',
				'Europe/London (GMT)', 'Europe/Berlin (CET)', 'Asia/Tokyo (JST)', 'Asia/Kolkata (IST)',
				'Australia/Sydney (AEST)', 'Pacific/Auckland (NZST)', 'Africa/Johannesburg (SAST)'
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

								// Get the selected timezone
								const selectedTimezone = timezones[selection - 1].split(' ')[0]; // Extract timezone like "America/New_York"

								// Store the timezone in Firestore under the server's document
								await db.collection('servers').doc(serverId).set({ timezone: selectedTimezone }, { merge: true });
								message.channel.send(`Server timezone has been set to: **${selectedTimezone}**`);
						})
						.catch(() => {
								message.channel.send('You did not reply in time. Please try again.');
						});
		});
	}

	else if (message.content === '!gdd current') {
		console.log("current COMMAND RECIUEVED")
		const serverId = message.guild.id;
	
		try {
			// Retrieve the list of teams followed by the server
			const followsSnapshot = await db.collection('servers').doc(serverId).collection('follows').get();
			const followedTeams = followsSnapshot.docs.map(doc => doc.data().team_id);
	
			if (followedTeams.length === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}
	
			// Retrieve team information from Firestore to get the full team names
			const teamsSnapshot = await db.collection('teams').get();
			const allTeams = {};
			teamsSnapshot.forEach(doc => {
				const teamsData = doc.data().teams || [];
				teamsData.forEach(team => {
					allTeams[team.team_id] = team.full_name;
				});
			});
	
			// Create a message listing all followed teams with their full names
			let followedTeamsMessage = `**Currently followed teams in this server**:\n\n`;
			followedTeams.forEach((teamId, index) => {
				const teamName = allTeams[teamId] || teamId; // Use the full name if available
				followedTeamsMessage += `${index + 1}. ${teamName}\n`;
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

  try {
    // Store the channel ID in Firestore under the server's document
    await db.collection('servers').doc(serverId).set({ channelId: channelId }, { merge: true });
    message.channel.send(`This channel has been set as the default channel for automated messages.`);
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
	// Command to get games on a specific date, e.g., !gdd 2024-10-19
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
			// Retrieve the server's timezone from Firestore
			const serverConfigSnapshot = await db.collection('servers').doc(serverId).get();
			let serverTimezone = 'America/New_York'; // Default to EST if not set

			if (serverConfigSnapshot.exists && serverConfigSnapshot.data().timezone) {
				serverTimezone = serverConfigSnapshot.data().timezone;
			} else {
				// Warn the user that the timezone has not been set
				message.channel.send(`⚠️ Timezone has not been set for this server. Defaulting to EST (America/New_York). Use "!gdd timezone" to set the correct timezone.`);
			}

			// Convert the user's input date to the start and end of the day in UTC using the server's timezone
			const startOfDayUTC = moment.tz(`${normalizedDate} 00:00:00`, 'YYYY-MM-DD HH:mm:ss', serverTimezone).utc().toDate();
			const endOfDayUTC = moment.tz(`${normalizedDate} 23:59:59`, 'YYYY-MM-DD HH:mm:ss', serverTimezone).utc().toDate();

			// Retrieve the list of teams followed by anyone in the server
			const followsSnapshot = await db.collection('servers').doc(serverId).collection('follows').get();
			const followedTeams = followsSnapshot.docs.map(doc => doc.data().team_id);

			if (followedTeams.length === 0) {
				message.channel.send(`No teams are currently being followed in this server.`);
				return;
			}

			let gamesMessage = `**Events for (${normalizedDate})**:\n\n`;
			let gamesFound = false;
			const allGames = []; // Array to collect all games for sorting

			// Create a map to store the team IDs and their full names
			const teamIdToFullNameMap = {};

			// Create a map to associate sports with emojis
			const sportEmojiMap = {
				american_football_nfl: "🏈",
				football_copa: "⚽",
				football_deb: "⚽",
				football_eflc: "⚽",
				football_epl: "⚽",
				football_esp: "⚽",
				football_fifaf: "⚽",
				football_lec: "⚽",
				football_mls: "⚽",
				football_uel: "⚽",
				nba: "🏀",
				basketball_mens_ncaa: "🏀",
				mlb: "⚾",
				nhl: "🏒",
			};

		// Retrieve all available sports in the 'schedules' collection
		const sportsCollectionsSnapshot = await db.collection('schedules').listDocuments();
		const sportsCollections = sportsCollectionsSnapshot.map(doc => doc.id);

		for (const sportId of sportsCollections) {
			// Filter followed teams by current sport
			const followedTeamsInSport = followedTeams.filter(teamId => teamId.startsWith(sportId));
			if (followedTeamsInSport.length === 0) continue;


		// Check each followed team's schedule for games on the given date
		for (const teamId of followedTeamsInSport) {
			// Query games with valid time
			const gamesWithTimeSnapshot = await db.collection('schedules')
				.doc(sportId)
				.collection(teamId)
				.where('time', '>=', Timestamp.fromDate(startOfDayUTC))
				.where('time', '<=', Timestamp.fromDate(endOfDayUTC))
				.get();

			// Query games with "TBD" time
			const gamesWithTBDTimeSnapshot = await db.collection('schedules')
				.doc(sportId)
				.collection(teamId)
				.where('day', '==', normalizedDate)
				.get();

			// Combine results into a map to prevent duplicates
			const allGamesMap = new Map();
			gamesWithTimeSnapshot.forEach((doc) => {
				const gameData = doc.data();
				allGamesMap.set(doc.id, gameData);
			});

			gamesWithTBDTimeSnapshot.forEach((doc) => {
				if (!allGamesMap.has(doc.id)) {
					const gameData = doc.data();
					allGamesMap.set(doc.id, gameData);
				}
			});

			// Convert the map back to an array for further processing
			const allGamesForTeam = Array.from(allGamesMap.values());

			// Process each game
			for (const gameData of allGamesForTeam) {
				// Get the time zone stored in the game data
				const timeZone = gameData.timezone || 'EST';

				// Function to get the correct IANA time zone based on abbreviation
				function getIanaTimeZone(abbreviation) {
					const timeZoneMap = {
						'EST': 'America/New_York',
						'EDT': 'America/New_York',
						'CST': 'America/Chicago',
						'CDT': 'America/Chicago',
						'MST': 'America/Denver',
						'MDT': 'America/Denver',
						'PST': 'America/Los_Angeles',
						'PDT': 'America/Los_Angeles',
						'AKST': 'America/Anchorage',
						'AKDT': 'America/Anchorage',
						'HST': 'Pacific/Honolulu',
						'AST': 'America/Halifax',
						'NST': 'America/St_Johns',
						'GMT': 'Europe/London',
						'BST': 'Europe/London',
						'CET': 'Europe/Berlin',
						'CEST': 'Europe/Berlin',
						'EET': 'Europe/Istanbul',
						'EEST': 'Europe/Istanbul',
						'IST': 'Asia/Kolkata',
						'JST': 'Asia/Tokyo',
						'KST': 'Asia/Seoul',
						'ICT': 'Asia/Bangkok',
						'HKT': 'Asia/Hong_Kong',
						'SGT': 'Asia/Singapore',
						'AEST': 'Australia/Sydney',
						'AEDT': 'Australia/Sydney',
						'ACST': 'Australia/Adelaide',
						'ACDT': 'Australia/Adelaide',
						'AWST': 'Australia/Perth',
						'NZST': 'Pacific/Auckland',
						'NZDT': 'Pacific/Auckland',
						'WET': 'Europe/Lisbon',
						'WEST': 'Europe/Lisbon',
						'CAT': 'Africa/Harare',
						'EAT': 'Africa/Nairobi',
						'WAT': 'Africa/Lagos',
						'SAST': 'Africa/Johannesburg'
					};
					return timeZoneMap[abbreviation] || 'America/New_York'; // Default to EST if not found
				}

				// Convert time zone abbreviation to IANA time zone
				const validTimeZone = getIanaTimeZone(timeZone);

				// Get and format the game date
				const gameDate = gameData.time !== "TBD" ? gameData.time.toDate() : "TBD";
				const localTime = gameDate !== "TBD" ? moment.tz(gameDate, validTimeZone).tz(serverTimezone) : "TBD"; // Adjust time to server's timezone
				const formattedTime = localTime !== "TBD" ? localTime.format('h:mm A') : "TBD";

				// Collect all games into the array for sorting
				allGames.push({
					sportId,
					homeTeamId: gameData.home_team_id,
					awayTeamId: gameData.away_team_id,
					date: gameDate,
					time: formattedTime, // Format time as "7:00 PM"
					channel: gameData.channel,
					timezone: timeZone // Include the time zone abbreviation
				});

				// Add both the home and away team IDs to the map if not already present
				if (!teamIdToFullNameMap[gameData.home_team_id]) teamIdToFullNameMap[gameData.home_team_id] = null;
				if (!teamIdToFullNameMap[gameData.away_team_id]) teamIdToFullNameMap[gameData.away_team_id] = null;

				gamesFound = true;
			}
		}
		}

			// Retrieve the full names for all relevant teams (both followed and their opponents)
			const teamsSnapshot = await db.collection('teams').get();
			teamsSnapshot.forEach((doc) => {
				const sportTeams = doc.data().teams || [];
				sportTeams.forEach((team) => {
					if (teamIdToFullNameMap.hasOwnProperty(team.team_id)) {
						teamIdToFullNameMap[team.team_id] = team.full_name;
					}
				});
			});

			// Sort games by time
			allGames.sort((a, b) => {
				if (a.time === "TBD") return 1; // Move "TBD" times to the end
				if (b.time === "TBD") return -1;
				return a.date - b.date; // Sort based on actual date objects
			});

			// Format the games message with emojis, using server's timezone and sorted games
			allGames.forEach((game) => {
				const homeTeamName = teamIdToFullNameMap[game.homeTeamId] || game.homeTeamId;
				const awayTeamName = teamIdToFullNameMap[game.awayTeamId] || game.awayTeamId;
				const emoji = sportEmojiMap[game.sportId] || "";

				// Determine if the user follows the home or away team
				const isHomeTeam = followedTeams.includes(game.homeTeamId);
				const userTeamName = isHomeTeam ? homeTeamName : awayTeamName;
				const opponentTeamName = isHomeTeam ? awayTeamName : homeTeamName;
				const vsOrAt = isHomeTeam ? "vs" : "@";

				// Convert game time to server's set timezone and format it
				const serverTime = game.date!="TBD"?moment.tz(game.date, serverTimezone).format('h:mm A'):"TBD";

				// Format the message with the user's team, opponent, and adjusted time
				gamesMessage += `${emoji}  ${serverTime} ${userTeamName} ${vsOrAt} ${opponentTeamName} ${game.channel ? `- on ${game.channel}` : ""}\n`;
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
				gamesMessage += `\n*Server is using the ${serverTimezone} (${timezoneAbbreviation}) timezone. Type "!gdd timezone" to change.*`;
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
cron.schedule('0 * * * *', () => {
  console.log('Running scheduled task every hour...');
  checkForHourlyUpdates();
});
client.login(process.env.DISCORD_TOKEN);
