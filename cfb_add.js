const { Client } = require('pg');
require('dotenv').config();
const axios = require('axios');
const moment = require('moment-timezone');

// Configure PostgreSQL client
const client = new Client({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: process.env.PORT,
});

// Connect to PostgreSQL
client.connect().then(() => console.log("Connected to PostgreSQL")).catch(err => console.error("Connection error", err.stack));

// Competition and sport details for College Football
const competitions = [
  { name: 'NCAA CFB', full_name: 'NCAA College Football' }
];

// Function to insert sports into PostgreSQL database
async function storeSportsInPostgres() {
  try {
    const sportName = 'American Football';
    const query = `
      INSERT INTO sports (name)
      VALUES ($1)
      ON CONFLICT (name) DO NOTHING;
    `;

    await client.query(query, [sportName]);

    console.log('Sport stored successfully in the PostgreSQL database!');
  } catch (error) {
    console.error('Error storing sport:', error.stack);
  }
}

// Function to insert competitions into PostgreSQL database
async function storeCompetitionsInPostgres() {
  try {
    // Fetch the sport_id for "Football"
    const sportName = 'American Football';
    const sportResult = await client.query(
      `SELECT id FROM sports WHERE name = $1`, 
      [sportName]
    );
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'American Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID for Football

    for (const competition of competitions) {
      const query = `
        INSERT INTO competitions (name, sport_id, full_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO NOTHING;
      `;

      const values = [competition.name, sportId, competition.full_name];
      await client.query(query, values);
    }

    console.log('Competitions stored successfully in the PostgreSQL database!');
  } catch (error) {
    console.error('Error storing competitions:', error.stack);
  }
}

// Function to store NCAA Football teams dynamically fetched from the API
async function storeCFBTeamsInPostgres() {
  try {
    // Retrieve the sport_id for "Football"
    const sportName = 'American Football';
    const sportResult = await client.query(
      `SELECT id FROM sports WHERE name = $1`, 
      [sportName]
    );
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'American Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    for (const competition of competitions) {
      const teamsUrl = `https://api.sportsdata.io/v3/cfb/scores/json/TeamsBasic?key=f7d0905b4d9f4ac191616c67de248cf4`;
      const response = await axios.get(teamsUrl);
      const teams = response.data;

      for (const team of teams) {
        // First, check if the team already exists in the 'teams' table using global_team_id
        const teamCheckQuery = `
          SELECT id, league FROM teams WHERE global_team_id = $1;
        `;
        const teamCheckResult = await client.query(teamCheckQuery, [team.GlobalTeamID]);

        let teamId;
        let newLeague;

        if (teamCheckResult.rows.length === 0) {
          // If the team does not exist, insert it and retrieve the new team_id
          newLeague = competition.full_name; // Start with the first league for this team

          const insertTeamQuery = `
            INSERT INTO teams (global_team_id, abbreviation, name, sport_id, league, location, logo_url, division, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
            RETURNING id;
          `;
          let city = team?.Stadium?.City;
          let state = team?.Stadium?.State;
          let location = "Unknown";
          
          if (city && state) {
            location = `${city.trim()}, ${state.trim()}`;
          }
          const insertTeamValues = [
            team.GlobalTeamID,   // global_team_id from the API
            team.Key,            // abbreviation
            `${team.School} ${team.Name}`,  // name (School + Name)
            sportId,             // sport_id (from database lookup)
            newLeague,           // Initial league name (first competition)
            location, // location
            team.TeamLogoUrl,     // logo_url
            team.Conference,      // division (Conference for CFB)
          ];

          const insertTeamResult = await client.query(insertTeamQuery, insertTeamValues);
          teamId = insertTeamResult.rows[0].id;
        } else {
          // If the team already exists, retrieve the team_id and its current league
          teamId = teamCheckResult.rows[0].id;
          const existingLeague = teamCheckResult.rows[0].league;

          // Split the league string into an array and check if the new league is already included
          const leagueArray = existingLeague ? existingLeague.split(',').map(league => league.trim()) : [];

          if (!leagueArray.includes(competition.full_name)) {
            leagueArray.push(competition.full_name); // Add the new league if it's not in the array
          }

          // Join the array back into a comma-separated string
          newLeague = leagueArray.join(', ');

          // Update the team's league field with the new comma-separated value
          const updateTeamLeagueQuery = `
            UPDATE teams
            SET league = $1, updated_at = now()
            WHERE id = $2;
          `;
          await client.query(updateTeamLeagueQuery, [newLeague, teamId]);
        }

        // Now, insert the team-competition relationship into the 'team_competitions' table
        const insertTeamCompetitionQuery = `
          INSERT INTO team_competitions (team_id, competition_id)
          VALUES ($1, $2)
          ON CONFLICT (team_id, competition_id) DO NOTHING;
        `;
        const competitionResult = await client.query(`SELECT id FROM competitions WHERE name = $1`, [competition.name]);
        const competitionId = competitionResult.rows[0].id;

        await client.query(insertTeamCompetitionQuery, [teamId, competitionId]);
        console.log(`Team ${team.Name} stored successfully for competition ${competition.full_name} in the PostgreSQL database!`);
      }
      console.log(`All teams for competition ${competition.name} stored successfully in the PostgreSQL database!`);
    }
  } catch (error) {
    console.error('Error storing NCAA Football teams:', error.stack);
    throw error; // Rethrow the error to stop further execution
  }
}

// Function to store NCAA Football schedule dynamically fetched from the API
async function fetchAndStoreCFBSchedule() {
  try {
    // Retrieve the competition_id for "NCAA CFB" dynamically
    const competitionName = 'NCAA CFB';
    const competitionResult = await client.query(
      `SELECT id FROM competitions WHERE name = $1`, 
      [competitionName]
    );
    if (competitionResult.rows.length === 0) {
      throw new Error("Competition 'NCAA CFB' not found in the database. Please ensure it is stored correctly.");
    }

    const competitionId = competitionResult.rows[0].id; // Retrieve the competition ID

    // Retrieve the sport_id for "Football"
    const sportName = 'American Football';
    const sportResult = await client.query(
      `SELECT id FROM sports WHERE name = $1`, 
      [sportName]
    );
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'American Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    // Fetch the NCAA Football schedule
    const scheduleUrl = 'https://api.sportsdata.io/v3/cfb/scores/json/Games/2024?key=f7d0905b4d9f4ac191616c67de248cf4';
    const response = await axios.get(scheduleUrl);
    const schedule = response.data;

    // Retrieve team IDs mapped by global_team_id
    const teamResult = await client.query(`SELECT global_team_id, id FROM teams WHERE global_team_id IS NOT NULL`);
    const teamMap = {};
    teamResult.rows.forEach(row => {
      teamMap[row.global_team_id] = row.id;
    });

    // Current date in UTC to compare against
    const currentDateTime = moment.utc().startOf('day');

    for (const game of schedule) {
      const homeTeamId = teamMap[game.GlobalHomeTeamID];
      const awayTeamId = teamMap[game.GlobalAwayTeamID];
    
      // Check if the game has valid teams in our teamMap
      if (!homeTeamId || !awayTeamId) {
        console.error(`Game with GameID ${game.GameID} has unmatched teams: GlobalHomeTeamID = ${game.GlobalHomeTeamID}, GlobalAwayTeamID = ${game.GlobalAwayTeamID}. Skipping...`);
        continue;
      }
    
      if (game.GlobalGameID == null) {
        console.error(`Game with GameID ${game.GameID} has no GlobalGameID. Skipping...`);
        continue;
      }
    
      // Convert DateTime from EST/EDT to UTC, assuming all times from the API are in EST or EDT (depending on the time of year)
      let gameTime = null;
      let gameDateTimeUtc = null;
    
      if (game.DateTime) {
        gameTime = moment.tz(game.DateTime, 'America/New_York').utc().format('YYYY-MM-DD HH:mm:ss');
        gameDateTimeUtc = moment.tz(game.DateTime, 'America/New_York').utc(); // Convert to UTC moment object for further comparisons
      }
    
      const gameDate = game.Day.split('T')[0]; // Game date (YYYY-MM-DD)
      console.log(`Processing game ${game.GameID} scheduled on ${gameDate} at ${gameDateTimeUtc}`);
      // Check if the game is in the past, but only skip if we have a valid gameDateTimeUtc
      if (gameDateTimeUtc && gameDateTimeUtc.startOf('day').isBefore(currentDateTime)) {
        console.log(`Skipping past game: ${game.GameID} scheduled on ${gameDateTimeUtc.format('YYYY-MM-DD HH:mm:ss')}`);
        continue; // Skip past games that have a valid time and are in the past
      }
    
      // Check if the game already exists in the database
      const gameCheckQuery = `
        SELECT * FROM schedules WHERE game_key = $1
      `;
      const existingGame = await client.query(gameCheckQuery, [game.GlobalGameID]);
    
      // If the game exists, compare the data
      if (existingGame.rows.length > 0) {
        const existingRow = existingGame.rows[0];
    
        // Check if any of the fields differ from the API data
        if (
          existingRow.home_team_id !== homeTeamId ||
          existingRow.away_team_id !== awayTeamId ||
          existingRow.game_time !== gameTime ||
          existingRow.game_date !== gameDate
        ) {
          // Update the existing row with the new data
          const updateQuery = `
            UPDATE schedules
            SET home_team_id = $1, away_team_id = $2, game_date = $3, game_time = $4::timestamptz, sport_id = $6
            WHERE sportsdataio_game_id = $5;
          `;
          const updateValues = [
            homeTeamId,             // Home team internal ID
            awayTeamId,             // Away team internal ID
            gameDate,               // Game date (YYYY-MM-DD)
            gameTime,               // Game time in UTC or null
            game.GlobalGameID,      // SportsDataIO GlobalGameId
            sportId,                // Sport ID for Football
          ];
    
          await client.query(updateQuery, updateValues);
          console.log(`Game ${game.GameID} updated successfully in PostgreSQL!`);
        }
      } else {
        // Insert the new game schedule if it doesn't exist
        const insertQuery = `
          INSERT INTO schedules (game_key, competition_id, home_team_id, away_team_id, game_date, game_time, sportsdataio_game_id, sport_id)
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
          ON CONFLICT (sportsdataio_game_id) DO NOTHING;
        `;
        const insertValues = [
          game.GlobalGameID,        // Game key from the API
          competitionId,            // Competition ID
          homeTeamId,               // Home team internal ID
          awayTeamId,               // Away team internal ID
          gameDate,                 // Game date (YYYY-MM-DD)
          gameTime,                 // Game time in UTC or null
          game.GlobalGameID,        // SportsDataIO GlobalGameId
          sportId                   // Sport ID for Football
        ];
    
        await client.query(insertQuery, insertValues);
        console.log(`Game ${game.GameID} stored successfully in PostgreSQL!`);
      }
    }

    console.log('All future NCAA Football 2024 schedule games stored/updated successfully in PostgreSQL!');
  } catch (error) {
    console.error('Error fetching and storing NCAA Football schedule:', error.stack);
    throw error; // Rethrow the error to stop further execution
  }
}

// Execute the functions sequentially for NCAA Football
async function runAllFunctionsForCFB() {
  try {
    await storeSportsInPostgres();           // Store sport details
    await storeCompetitionsInPostgres();     // Store competition details
    await storeCFBTeamsInPostgres();         // Store teams
    await fetchAndStoreCFBSchedule();        // Store schedules
    console.log('All operations for NCAA Football completed successfully!');
  } catch (error) {
    console.error('Error occurred during execution:', error.stack);
    // Stop further execution if any function throws an error
  } finally {
    client.end(); // Close the PostgreSQL connection after execution, even if an error occurs
  }
}

// Run the main function
// runAllFunctionsForCFB().then(() => {
//   console.log('All operations for NCAA Football completed successfully!');
//   client.end(); // Close the PostgreSQL connection
// }).catch((err) => {
//   console.error('Error executing NCAA Football functions:', err.stack);
//   client.end(); // Close the PostgreSQL connection on error
// });


module.exports = {
  runAllFunctionsForCFB
  // Add any other functions you need to export
};