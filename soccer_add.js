// Import Firestore configuration
const { Timestamp } = require('firebase-admin').firestore;
const db = require('./firebase');
const axios = require('axios');


const competitions = [
  { name: 'Premier League', key: 'EPL', year: 2025 },
  { name: 'Bundesliga', key: 'DEB', year: 2025 },
  { name: 'Primera Division', key: 'ESP', year: 2025 },
  { name: 'MLS', key: 'MLS', year: 2024 },
  { name: 'Copa America', key: 'COPA', year: 2024 },
  { name: 'UEFA Europa League', key: 'UEL', year: 2025 },
  { name: 'Football League Cup', key: 'EFLC', year: 2025 },
  { name: 'CONCACAF Gold Cup', key: 'NCAG', year: 2024 },
  { name: 'FIFA World Cup', key: 'FIFA', year: 2026 }, // Assuming the next World Cup year
  { name: 'FIFA Friendlies', key: 'FIFAF', year: 2024 },
  { name: 'WC Qualification', key: 'SAWQ', year: 2024 },
  { name: "FIFA Women's World Cup", key: 'FIFAW', year: 2027 }, // Assuming the next Women's World Cup year
  { name: 'Leagues Cup', key: 'LEC', year: 2024 },
];

function generateRandomString(length) {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
// Function to fetch and store teams from each competition
async function fetchAndStoreTeamsForAllCompetitions() {
  try {
    for (const competition of competitions) {
      const teamsUrl = `https://api.sportsdata.io/v4/soccer/scores/json/Teams/${competition.key}?key=08d3a1b54f054cb9972f5e27da405b95`;

      // Fetch and store teams for each competition
      const response = await axios.get(teamsUrl);
      const teamsData = response.data;
      console.log(competition.key)
      // Transform the API data into the desired format
      const teams = teamsData.map(team => ({
        team_id_number: team.TeamId,
        team_id: `football_${competition.key.toLowerCase()}_${team.Key?team.Key.toLowerCase():generateRandomString(5)}`,  // e.g., "soccer_epl_arsenal"
        team_name: team.Name,
        full_name: team.FullName,
        team_code: team.Key,
        sport: "Football",
        league: competition.name,
        location: team.City,
        logo_url: team.WikipediaLogoUrl
      }));

      // Store the transformed teams data in Firestore under the competition's document
      await storeTeamsInFirestore(`football_`+competition.key.toLowerCase(), teams);
    }
    console.log('All teams for all competitions stored successfully!');
  } catch (error) {
    console.error('Error fetching or storing teams:', error);
  }
}

// Function to store teams in Firestore under a specific document and update the unified teams collection
async function storeTeamsInFirestore(competitionKey, teams) {
  try {
    // Store teams under the competition's document (e.g., 'teams/soccer_epl')
    await db.collection('teams').doc(competitionKey).set({ teams });
    console.log(`Teams for ${competitionKey} stored successfully in Firestore!`);

    // Update the unified teams collection
    await updateUnifiedTeamsCollection(teams, competitionKey);
  } catch (error) {
    console.error(`Error storing teams for ${competitionKey}:`, error);
  }
}
// Function to update the unified teams collection with the teams from a specific competition
async function updateUnifiedTeamsCollection(teams, competitionKey) {
  try {
    for (const team of teams) {
      const teamRef = db.collection('unified_teams').doc(team.team_id_number.toString());

      console.log(`Updating unified team: ${team.team_id_number}, competition: ${competitionKey}`);

      // Check if the unified team document already exists
      const teamSnapshot = await teamRef.get();

      if (teamSnapshot.exists) {
        // Update the competitions array to include the new competition
        const existingData = teamSnapshot.data();
        const competitions = existingData.competitions || [];
        const teamIds = existingData.team_ids || [];

        // Check if the competition already exists in the array
        const competitionExists = competitions.some(
          (comp) => comp.competition_key === competitionKey
        );

        if (!competitionExists) {
          competitions.push({
            competition_key: competitionKey,
            team_code: team.team_code,
            league: team.league,
            sport: team.sport
          });
        }

        // Check if the team_id already exists in the array
        if (!teamIds.includes(team.team_id)) {
          teamIds.push(team.team_id);
        }

        // Log the update operation
        console.log(`Updating existing document: ${team.team_id_number}`);

        // Update the document with the new competitions and team_ids arrays
        await teamRef.update({
          competitions,
          team_ids: teamIds
        });
      } else {
        // Log the creation operation
        console.log(`Creating new document for team: ${team.team_id_number}`);

        // Create a new unified team document with the initial competition and team_id
        await teamRef.set({
          team_id_number: team.team_id_number,
          team_ids: [team.team_id],
          team_name: team.team_name,
          full_name: team.full_name,
          location: team.location,
          logo_url: team.logo_url,
          competitions: [
            {
              competition_key: competitionKey,
              team_code: team.team_code,
              league: team.league,
              sport: team.sport
            }
          ]
        });
      }
    }
    console.log(`Unified teams updated successfully for competition ${competitionKey}!`);
  } catch (error) {
    console.error(`Error updating unified teams collection for ${competitionKey}:`, error);
  }
}

async function fetchAndStoreSchedulesForAllCompetitions() {
  try {
    for (const competition of competitions) {
      try {
        const scheduleUrl = `https://api.sportsdata.io/v4/soccer/scores/json/SchedulesBasic/${competition.key}/${competition.year}?key=08d3a1b54f054cb9972f5e27da405b95`;

        // Fetch the schedule data for each competition
        const response = await axios.get(scheduleUrl);
        const schedule = response.data;

        if (!schedule || schedule.length === 0) {
          console.log(`No schedule available for ${competition.name}. Skipping...`);
          continue;
        }

        // Fetch teams and create the teamMap
        const { teamMap } = await getTeamsFromFirestore("football_" + competition.key.toLowerCase());

        // Process and store each game's schedule in Firestore
        for (const game of schedule) {
          const homeTeamId = teamMap[game.HomeTeamKey];
          const awayTeamId = teamMap[game.AwayTeamKey];

          // Skip if teams are not found
          if (!homeTeamId || !awayTeamId) {
            console.error(`Game with GameId ${game.GameId} has unmatched teams: HomeTeam = ${game.HomeTeamKey}, AwayTeam = ${game.AwayTeamKey}. Skipping...`);
            continue;
          }

          const day = game.Day ?  game.Day : "TBD";
          const dateTime = game.DateTime ?  game.DateTime : "TBD";

          // Create Date objects from the strings
          const dayDate = day!="TBD"?new Date(day):"TBD";
          const dateTimeDate = dateTime!="TBD"?new Date(dateTime):"TBD";

          // Extract the date parts and format them as "YYYY-MM-DD"
          const formattedDay = dayDate!="TBD"?dayDate.toISOString().split('T')[0]: "TBD";
          const formattedDateTime = dateTimeDate!="TBD"?dateTimeDate.toISOString().split('T')[0]: "TBD";

          console.log(formattedDay);       // "2024-12-03"
          console.log(formattedDateTime);  // "2024-12-03"

          const gameData = {
            game_id: game.GameId,
            season: game.Season,
            season_type: game.SeasonType,
            away_team_id: `football_${competition.key.toLowerCase()}_${game.AwayTeamKey.toLowerCase()}`,
            home_team_id: `football_${competition.key.toLowerCase()}_${game.HomeTeamKey.toLowerCase()}`,
            day: formattedDay,
            time: game.DateTime ? Timestamp.fromDate(new Date(`${game.DateTime}Z`)) : "TBD",
            status: game.Status,
            away_team_id_number: game.AwayTeamId,
            home_team_id_number: game.HomeTeamId,
            away_team_key: game.AwayTeamKey,
            away_team_name: game.AwayTeamName,
            home_team_key: game.HomeTeamKey,
            home_team_name: game.HomeTeamName,
            updated: game.Updated,
            updated_utc: game.UpdatedUtc,
          };

          const documentId = `${game.AwayTeamKey}@${game.HomeTeamKey}-${game.Day?game.Day.split('T')[0]:competition.year+"-TBD"}`;

          // Store the game under both home and away team's subcollections in the competition's schedule
          await db.collection('schedules').doc("football_"+competition.key.toLowerCase()).collection(homeTeamId).doc(documentId).set(gameData);
          await db.collection('schedules').doc("football_"+competition.key.toLowerCase()).collection(awayTeamId).doc(documentId).set(gameData);
          console.log(`Game ${documentId} stored successfully under ${competition.key} in Firestore!`);
        }
      } catch (error) {
        if (error.response && error.response.status === 400) {
          console.log(`No schedule available or not released yet for ${competition.name} (Key: ${competition.key}).`);
        } else {
          console.error(`Error fetching schedule for ${competition.name} (Key: ${competition.key}):`, error.message);
        }
      }
    }
    console.log('All schedules for all competitions stored successfully!');
  } catch (error) {
    console.error('Error in fetching or storing schedules:', error);
  }
}

// Function to get teams from Firestore based on the competition's key
async function getTeamsFromFirestore(competitionKey) {
  try {
    const teamsDoc = await db.collection('teams').doc(competitionKey).get();
    if (!teamsDoc.exists) {
      console.error(`No teams found for ${competitionKey} in Firestore.`);
      return { mlsTeams: [], teamMap: {} };
    }

    const teamsData = teamsDoc.data().teams;
    const teamMap = teamsData.reduce((map, team) => {
      map[team.team_code] = team.team_id;
      return map;
    }, {});

    return { mlsTeams: teamsData, teamMap };
  } catch (error) {
    console.error(`Error fetching teams from Firestore for football_${competitionKey}:`, error);
    return { mlsTeams: [], teamMap: {} };
  }
}

// Execute the functions sequentially to ensure order
async function runAllFunctionsSequentially() {
  //await fetchAndStoreTeamsForAllCompetitions(); // Wait for teams to be stored
  await fetchAndStoreSchedulesForAllCompetitions(); // Then store schedules
}

// Run the main function
runAllFunctionsSequentially();