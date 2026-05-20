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

const competitions = [
  // { full_name: 'Premier League', name: 'EPL', year: 2025  },
  // { full_name: 'Bundesliga', name: 'DEB', year: 2025 },
  { full_name: 'Primera Division', name: 'ESP', year: 2025 },
  { full_name: 'Major League Soccer', name: 'MLS', year: 2024 },
  { full_name: 'Copa America', name: 'COPA', year: 2024 },
  { full_name: 'UEFA Europa League', name: 'UEL', year: 2025 },
  { full_name: 'Football League Cup', name: 'EFLC', year: 2025 },
  //{ full_name: 'CONCACAF Gold Cup', name: 'NCAG', year: 2024 },
  //{ full_name: 'FIFA World Cup', name: 'FIFA', year: 2026 }, // Assuming the next World Cup year
  { full_name: 'FIFA Friendlies', name: 'FIFAF', year: 2024 },
  //{ full_name: 'World Cup Qualification', name: 'SAWQ', year: 2024 },
  //{ full_name: "FIFA Women's World Cup", name: 'FIFAW', year: 2027 }, // Assuming the next Women's World Cup year
  { full_name: 'Leagues Cup', name: 'LEC', year: 2024 },
];

// Function to insert sports into PostgreSQL database
async function storeSportsInPostgres() {
  try {
    const sportName = 'Football';
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
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'Football'`);
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID for Football

    for (const competition of competitions) {
      const query = `
        INSERT INTO competitions (name, sport_id, full_name)
        VALUES ($1, $2, $3)
        ON CONFLICT (name, sport_id) DO NOTHING;
      `;

      // Use the dynamically fetched sportId instead of hardcoding it
      const values = [competition.name, sportId, competition.full_name];

      await client.query(query, values);
    }

    console.log('Competitions stored successfully in the PostgreSQL database!');
  } catch (error) {
    console.error('Error storing competitions:', error.stack);
  }
}
// Function to store soccer teams for each competition into PostgreSQL database
async function storeSoccerTeamsInPostgres() {
  try {
    // Retrieve the sport_id for "Football"
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'Football'`);
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    for (const competition of competitions) {
      const teamsUrl = `https://api.sportsdata.io/v4/soccer/scores/json/Teams/${competition.name}?key=08d3a1b54f054cb9972f5e27da405b95`;
      const response = await axios.get(teamsUrl);
      const teams = response.data;

      for (const team of teams) {
        // First, check if the team already exists in the 'teams' table using global_team_id
        const teamCheckQuery = `
          SELECT id, league FROM teams WHERE global_team_id = $1;
        `;
        const teamCheckResult = await client.query(teamCheckQuery, [team.GlobalTeamId]);

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
          const insertTeamValues = [
            team.GlobalTeamId,   // global_team_id from the API
            team.Key,            // abbreviation
            team.Name,           // name
            sportId,             // sport_id (from database lookup)
            newLeague,           // Initial league name (first competition)
            team.City,           // location
            team.WikipediaLogoUrl, // logo_url
            null, // Division
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
    console.error('Error storing soccer teams:', error.stack);
  }
}
// Function to store teams into team_competitions table
async function storeTeamsInCompetitions() {
  try {
    // Get all competitions
    const competitionResult = await client.query(`SELECT id, name FROM competitions`);
    const competitionMap = {};
    competitionResult.rows.forEach((row) => {
      competitionMap[row.name] = row.id;
    });

    // Get all teams
    const teamsResult = await client.query(`SELECT id, abbreviation FROM teams`);
    const teamCompetitions = [];

    for (const competition of competitions) {
      const competitionId = competitionMap[competition.name];

      for (const team of teamsResult.rows) {
        const query = `
          INSERT INTO team_competitions (team_id, competition_id)
          VALUES ($1, $2)
          ON CONFLICT (team_id, competition_id) DO NOTHING;
        `;
        const values = [team.id, competitionId];
        teamCompetitions.push(client.query(query, values));
      }
    }

    // Wait for all insertions to complete
    await Promise.all(teamCompetitions);

    console.log('All teams mapped to their competitions successfully in the team_competitions table!');
  } catch (error) {
    console.error('Error storing teams in competitions:', error.stack);
  }
}
// Function to fetch and store schedules for each soccer competition in PostgreSQL
async function fetchAndStoreSoccerSchedule() {
  try {
    // Retrieve the sport_id for "Football"
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'Football'`);
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    for (const competition of competitions) {
      
      // Retrieve the competition_id for each soccer competition dynamically
      const competitionResult = await client.query(
        `SELECT id FROM competitions WHERE name = $1`,
        [competition.name]
      );
      if (competitionResult.rows.length === 0) {
        throw new Error(`Competition '${competition.full_name}' not found in the database for year ${competition.year}. Please ensure it is stored correctly.`);
      }

      const competitionId = competitionResult.rows[0].id; // Retrieve the competition ID
      console.log(`Fetching schedule for ${competition.name} ${competition.year}...`);
      // Fetch the soccer schedule for the specific competition and year
      const scheduleUrl = `https://api.sportsdata.io/v4/soccer/scores/json/Schedule/${competition.name}/${competition.year}?key=08d3a1b54f054cb9972f5e27da405b95`;
      const response = await axios.get(scheduleUrl);
      // Aggregate all games from all rounds
      const schedule = response.data.reduce((accumulator, round) => {
        return accumulator.concat(round.Games);
      }, []);
      console.log(`Fetched ${schedule.length} games for ${competition.full_name} ${competition.year}`);
      // Retrieve team IDs mapped by global_team_id
      const teamResult = await client.query(`SELECT global_team_id, id FROM teams WHERE global_team_id IS NOT NULL`);
      const teamMap = {};
      teamResult.rows.forEach(row => {
        teamMap[row.global_team_id] = row.id;
      });

      // Current date in UTC to compare against
      const currentDateTime = moment.utc().startOf('day');

      for (const game of schedule) {
        const homeTeamId = teamMap[game.GlobalHomeTeamId];
        const awayTeamId = teamMap[game.GlobalAwayTeamId];

        // Check if the game has valid teams in our teamMap
        if (!homeTeamId || !awayTeamId) {
          console.error(`Game with GlobalGameId ${game.GlobalGameId} has unmatched teams: GlobalHomeTeamID = ${game.GlobalHomeTeamId}, GlobalAwayTeamID = ${game.GlobalAwayTeamId}. Skipping...`);
          continue;
        }

        if (game.GlobalGameId == null) {
          console.error(`Game with GlobalGameId ${game.GlobalGameId} has no GlobalGameId. Skipping...`);
          continue;
        }

        // Directly use the UTC time from the API
        let gameTime = null;

        if (game.DateTime) {
          // Use the API-provided UTC time directly
          gameTime = moment.utc(game.DateTime).format('YYYY-MM-DD HH:mm:ss');
        }

        // Check if the game is today or in the future
        if (!gameTime || moment.utc(game.DateTime).startOf('day').isBefore(currentDateTime)) {
          console.log(`Skipping past game: ${game.GameId} scheduled on ${gameTime ? gameTime : 'unknown'}`);
          continue; // Skip past games
        }

        // Check if the game already exists in the database
        const gameCheckQuery = `
          SELECT * FROM schedules WHERE game_key = $1
        `;
        const existingGame = await client.query(gameCheckQuery, [game.GameKey]);

        // If the game exists, compare the data and update if any field has changed
        if (existingGame.rows.length > 0) {
          console.log("FOUND EXISSTS GAME KEY")
          const existingRow = existingGame.rows[0];

          // Check if any of the fields differ from the API data
          if (
            existingRow.home_team_id !== homeTeamId ||
            existingRow.away_team_id !== awayTeamId ||
            existingRow.game_time !== gameTime ||
            existingRow.game_date !== game.Date.split('T')[0] ||
            existingRow.sportsdataio_game_id !== game.GlobalGameID
          ) {
            // Update the existing row with the new data
            const updateQuery = `
              UPDATE schedules
              SET home_team_id = $1, away_team_id = $2, game_date = $3, game_time = $4::timestamptz, sportsdataio_game_id = $5, sport_id = $6
              WHERE game_key = $7;
            `;
            const updateValues = [
              homeTeamId,                  // Home team internal ID
              awayTeamId,                  // Away team internal ID
              game.Day.split('T')[0],     // Game date (YYYY-MM-DD)
              gameTime,                    // Game time in UTC
              game.GlobalGameId,           // SportsDataIO GlobalGameId
              sportId,                     // Sport ID for "Football"
              game.GameId                 // Game key from the API
            ];

            await client.query(updateQuery, updateValues);
            console.log(`Game ${game.GameId} updated successfully in PostgreSQL!`);
          }
        } else {
          // Insert the new game schedule if it doesn't exist
          const insertQuery = `
            INSERT INTO schedules (game_key, competition_id, home_team_id, away_team_id, game_date, game_time, sportsdataio_game_id, sport_id)
            VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
            ON CONFLICT (sportsdataio_game_id) DO NOTHING;
          `;
          const insertValues = [
            game.GameId,                // Game key from the API
            competitionId,               // Competition ID (retrieved dynamically)
            homeTeamId,                  // Home team internal ID
            awayTeamId,                  // Away team internal ID
            game.Day.split('T')[0],     // Game date (YYYY-MM-DD)
            gameTime,                    // Game time in UTC
            game.GlobalGameId,           // SportsDataIO GlobalGameId
            sportId                      // Sport ID for "Football"
          ];

          await client.query(insertQuery, insertValues);
          console.log(`Game ${game.GameId} stored successfully in PostgreSQL!`);
        }
      }

      console.log(`All future ${competition.full_name} ${competition.year} schedule games stored/updated successfully in PostgreSQL!`);
    }
  } catch (error) {
    console.error('Error fetching and storing soccer schedule:', error.stack);
  }
}
// Execute the functions sequentially
async function runAllFunctionsSequentiallySoccer() {
  //await storeSportsInPostgres(); // Store sport details
  try{
    await storeCompetitionsInPostgres(); // Store competition details
    await storeSoccerTeamsInPostgres(); // Store soccer teams
    //await storeTeamsInCompetitions(); // Map teams to competitions
    await fetchAndStoreSoccerSchedule(); // Store schedules
  }catch(error){
    console.error('Error fetching and storing soccer schedule:', error.stack);
  }
}

// Run the main function
// runAllFunctionsSequentiallySoccer().then(() => {
//   console.log('All operations completed successfully!');
//   client.end();
// })

module.exports = {
  runAllFunctionsSequentiallySoccer
  // Add any other functions you need to export
};