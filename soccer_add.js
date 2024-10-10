const { Client } = require('pg');
const axios = require('axios');
const moment = require('moment-timezone');


// Configure PostgreSQL client
const client = new Client({
  user: 'postgres',
  host: '74.215.78.207',
  database: 'discord-gamedaydaily',
  password: 'mpw011691',
  port: 5432, // Default port for PostgreSQL
});

// Connect to PostgreSQL
client.connect().then(() => console.log("Connected to PostgreSQL")).catch(err => console.error("Connection error", err.stack));

const competitions = [
  { full_name: 'Premier League', name: 'EPL', year: 2025  },
  { full_name: 'Bundesliga', name: 'DEB', year: 2025 },
  { full_name: 'Primera Division', name: 'ESP', year: 2025 },
  { full_name: 'Major League Soccer', name: 'MLS', year: 2024 },
  { full_name: 'Copa America', name: 'COPA', year: 2024 },
  { full_name: 'UEFA Europa League', name: 'UEL', year: 2025 },
  { full_name: 'Football League Cup', name: 'EFLC', year: 2025 },
  { full_name: 'CONCACAF Gold Cup', name: 'NCAG', year: 2024 },
  { full_name: 'FIFA World Cup', name: 'FIFA', year: 2026 }, // Assuming the next World Cup year
  { full_name: 'FIFA Friendlies', name: 'FIFAF', year: 2024 },
  { full_name: 'World Cup Qualification', name: 'SAWQ', year: 2024 },
  { full_name: "FIFA Women's World Cup", name: 'FIFAW', year: 2027 }, // Assuming the next Women's World Cup year
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
        ON CONFLICT (name) DO NOTHING;
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
    for (const competition of competitions) {
      const teamsUrl = `https://api.sportsdata.io/v4/soccer/scores/json/Teams/${competition.name}?key=08d3a1b54f054cb9972f5e27da405b95`;
      const response = await axios.get(teamsUrl);
      const teams = response.data;

      for (const team of teams) {
        const query = `
          INSERT INTO teams (abbreviation, name, sport_type, league, location, logo_url, division)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (abbreviation) DO NOTHING;
        `;
        const values = [
          team.Key, // abbreviation
          team.Name, // name
          'Football',     // sport_type
          competition.name,    // league
          competition.City,  // location
          team.WikipediaLogoUrl,  // logo_url
          null   // division
        ];

        await client.query(query, values);
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
async function fetchAndStoreSoccerSchedules() {
  try {
    // Retrieve all competitions and their IDs from the database
    const result = await client.query(`SELECT id, name FROM competitions`);
    const competitionMap = {};
    result.rows.forEach((row) => {
      competitionMap[row.name] = row.id;
    });

    for (const competition of competitions) {
      const competitionId = competitionMap[competition.name];

      const scheduleUrl = `https://api.sportsdata.io/v4/soccer/scores/json/SchedulesBasic/${competition.key}/${competition.year}?key=08d3a1b54f054cb9972f5e27da405b95`;
      const response = await axios.get(scheduleUrl);
      const schedule = response.data;

      for (const game of schedule) {
        // Convert game date and time to UTC
        const gameDate = game.Date.split('T')[0]; // Extract date in YYYY-MM-DD format
        const gameTime = moment.tz(`${game.Date} EST`, 'America/New_York').utc().format('YYYY-MM-DD HH:mm:ss'); // Convert to UTC

        const query = `
          INSERT INTO schedules (game_key, competition_id, home_team_id, away_team_id, game_date, game_time, sportsdataio_game_id)
          VALUES ($1, $2, (SELECT id FROM teams WHERE abbreviation = $3), (SELECT id FROM teams WHERE abbreviation = $4), $5, $6, $7)
          ON CONFLICT (game_key) DO NOTHING;
        `;

        const values = [
          game.GameId,                // Game ID from the API
          competitionId,              // Competition ID (retrieved dynamically)
          game.HomeTeamKey,           // Home team abbreviation
          game.AwayTeamKey,           // Away team abbreviation
          gameDate,                   // Game date (YYYY-MM-DD)
          gameTime,                   // Game time in UTC
          game.GlobalGameId           // SportsDataIO GlobalGameId
        ];

        await client.query(query, values);
      }

      console.log(`All future schedules for ${competition.name} (${competition.year}) stored successfully in PostgreSQL!`);
    }
  } catch (error) {
    console.error('Error fetching and storing soccer schedules:', error.stack);
  }
}
// Execute the functions sequentially
async function runAllFunctionsSequentially() {
  await storeSportsInPostgres(); // Store sport details
  await storeCompetitionsInPostgres(); // Store competition details
  await storeSoccerTeamsInPostgres(); // Store soccer teams
  await storeTeamsInCompetitions(); // Map teams to competitions
  await fetchAndStoreSoccerSchedules(); // Store schedules
}

// Run the main function
runAllFunctionsSequentially().then(() => {
  console.log('All operations completed successfully!');
  client.end();
})