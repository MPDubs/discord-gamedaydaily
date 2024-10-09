// Import Firestore configuration
const { Timestamp } = require('firebase-admin').firestore;
const db = require('./firebase');
const axios = require('axios');
const { time } = require('discord.js');
const geoTz = require('geo-tz');
const moment = require('moment-timezone');

// API URL to fetch MLS teams
const teamsUrl = 'https://api.sportsdata.io/v3/cbb/scores/json/TeamsBasic?key=1c23cba64dae4b96bee8b63ba57b1d3f';

// Function to fetch MLS teams from the API and store them in Firestore
async function fetchAndStoreMLSTeams() {
  try {
    // Fetch the team data from the API
    const response = await axios.get(teamsUrl);
    const teamsData = response.data;

    const mlsTeams = teamsData.map(team => ({
      team_id_number: team.TeamID,
      team_id: `basketball_mens_ncaa_${team.Key.toLowerCase()}`,  // e.g., "mbb_smu"
      team_name: team.Name,
      full_name: team.School + " " + team.Name,
      team_code: team.Key,
      sport: "Basketball",
      league: "Men's NCAA",
      location: team.Stadium ? `${team.Stadium.City}, ${team.Stadium.State}` : 'Unknown Location',
      logo_url: team.TeamLogoUrl,
      conference: team.Conference // Function to get conference based on team code
    }));

    // Store the transformed teams data in Firestore
    await storeMLSTeamsInSingleDocument(mlsTeams);
  } catch (error) {
    console.error('Error fetching or storing MLS teams:', error);
  }
}


// Function to store all MLS teams under a single document in the teams collection
async function storeMLSTeamsInSingleDocument(mlsTeams) {
  try {
    // Create a document named 'mls' inside the 'teams' collection and add an array of all teams
    await db.collection('teams').doc('basketball_mens_ncaa').set({ teams: mlsTeams });
    console.log('All MLS teams stored successfully in the "teams" collection under the "mls" document!');
  } catch (error) {
    console.error('Error storing MLS teams:', error);
  }
}
// Execute the function to fetch and store MLS teams
fetchAndStoreMLSTeams();

// URL to fetch the 2024 MLS schedule
const scheduleUrl = 'https://api.sportsdata.io/v3/cbb/scores/json/Games/2025?key=1c23cba64dae4b96bee8b63ba57b1d3f';

// Function to get teams from Firestore and create mlsTeams and teamMap
async function getTeamsFromFirestore() {
  try {
    // Retrieve the teams document from the "mls" document in the "teams" collection
    const teamsDoc = await db.collection('teams').doc('basketball_mens_ncaa').get();

    // Check if the document exists
    if (!teamsDoc.exists) {
      console.error('No mbb teams found in Firestore.');
      return { mlsTeams: [], teamMap: {} };
    }

    // Extract the teams array from the document
    const teamsData = teamsDoc.data().teams;

    // Create the mlsTeams array from the teams data
    const mlsTeams = teamsData.map(team => ({
      team_id: team.team_id,
      team_name: team.team_name,
      full_name: team.full_name,
      team_code: team.team_code,
      sport: team.sport,
      league: team.league,
      location: team.location,
      logo_url: team.logo_url,
      conference: team.conference
    }));

    // Create a dynamic teamMap object from the mlsTeams array
    const teamMap = mlsTeams.reduce((map, team) => {
      map[team.team_code] = team.team_id;
      return map;
    }, {});

    return { mlsTeams, teamMap };
  } catch (error) {
    console.error('Error fetching mbb teams from Firestore:', error);
    return { mlsTeams: [], teamMap: {} };
  }
}

// Function to fetch and store MLS schedule in Firestore under each team's subcollection
async function fetchAndStoreMLSSchedule() {
  try {
    const response = await axios.get(scheduleUrl);
    const schedule = response.data;
    const { mlsTeams, teamMap } = await getTeamsFromFirestore();

    function getTimeZoneFromCoordinates(lat, long) {
      if (lat == null || long == null) {
        return 'NA'; // Use 'NA' for unspecified time zones
      }
      const timeZones = geoTz.find(lat, long);
      return timeZones.length > 0 ? timeZones[0] : 'NA'; // Default to 'NA' if no time zone found
    }

    for (const game of schedule) {
      const homeTeamId = teamMap[game.HomeTeam];
      const awayTeamId = teamMap[game.AwayTeam];

      if (!homeTeamId || !awayTeamId) {
        console.error(`Game with GameID ${game.GameID} has unmatched teams. Skipping...`);
        continue;
      }

      const stadium = game.Stadium;
      const timeZone = stadium ? getTimeZoneFromCoordinates(stadium.GeoLat, stadium.GeoLong) : 'NA';

      // Convert EST DateTime to UTC
      let localDateTime;
      if (game.DateTime) {
        localDateTime = moment.tz(game.DateTime, 'America/New_York').utc().toDate(); // Convert EST to UTC
      } else {
        localDateTime = "TBD"
      }

      const epochTime = localDateTime!="TBD"?Math.floor(localDateTime.getTime() / 1000):"TBD";

      const gameData = {
        game_id: game.GameID,
        season: game.Season,
        season_type: game.SeasonType,
        away_team_id: `basketball_mens_ncaa_${game.AwayTeam.toLowerCase()}`,
        away_team_id_number: game.AwayTeamID,
        home_team_id: `basketball_mens_ncaa_${game.HomeTeam.toLowerCase()}`,
        home_team_id_number: game.HomeTeamID,
        time: localDateTime!="TBD"?Timestamp.fromDate(localDateTime):localDateTime, // Store as UTC Timestamp
        day: game.Day?game.Day.split('T')[0]:"TBD", // Keep `day` as string
        status: game.Status,
        away_team_key: game.AwayTeam,
        home_team_key: game.HomeTeam,
        updated: game.Updated,
        global_game_id: game.GlobalGameID,
        global_away_team_id: game.GlobalAwayTeamID,
        global_home_team_id: game.GlobalHomeTeamID,
        is_closed: game.IsClosed,
        date_time_utc: localDateTime!="TBD"?localDateTime.toISOString():localDateTime, // Store the ISO UTC date
        epoch_time: epochTime,
        timezone: timeZone,
      };

      const documentId = `${game.AwayTeam}@${game.HomeTeam}-${game.Day.split('T')[0]}`;
      await db.collection('schedules').doc('basketball_mens_ncaa').collection(`basketball_mens_ncaa_${game.HomeTeam.toLowerCase()}`).doc(documentId).set(gameData);
      await db.collection('schedules').doc('basketball_mens_ncaa').collection(`basketball_mens_ncaa_${game.AwayTeam.toLowerCase()}`).doc(documentId).set(gameData);
      console.log(`Game ${documentId} stored successfully!`);
    }

    console.log("All MLS 2024 schedule games stored successfully under each team's subcollection in Firestore!");
  } catch (error) {
    console.error("Error fetching and storing MLS schedule:", error);
  }
}


// Execute the functions sequentially to ensure order
async function runAllFunctionsSequentially() {
  await fetchAndStoreMLSTeams();
  await fetchAndStoreMLSSchedule(); // Wait for teams to be stored
}

// Run the main function
runAllFunctionsSequentially();