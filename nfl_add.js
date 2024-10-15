const { Client } = require('pg');
require('dotenv').config();
const axios = require('axios');
const moment = require('moment-timezone');
const geoTz = require('geo-tz');

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

const nflTeams = [
  {
    "team_id": "american_football_nfl_bills",
    "team_name": "Buffalo Bills",
    "full_name": "Buffalo Bills",
    "team_code": "BUF",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Buffalo, NY",
    "logo_url": "https://example.com/logos/buffalo_bills.png",
    "division": "AFC East"
  },
  {
    "team_id": "american_football_nfl_dolphins",
    "team_name": "Miami Dolphins",
    "full_name": "Miami Dolphins",
    "team_code": "MIA",
    "sport": "AMERICAN FOOTBALL",
    "league": "National Football League",
    "location": "Miami, FL",
    "logo_url": "https://example.com/logos/miami_dolphins.png",
    "division": "AFC East"
  },
  {
    "team_id": "american_football_nfl_patriots",
    "team_name": "New England Patriots",
    "full_name": "New England Patriots",
    "team_code": "NE",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Foxborough, MA",
    "logo_url": "https://example.com/logos/new_england_patriots.png",
    "division": "AFC East"
  },
  {
    "team_id": "american_football_nfl_jets",
    "team_name": "New York Jets",
    "full_name": "New York Jets",
    "team_code": "NYJ",
    "sport": "American Football",
    "league": "National Football League",
    "location": "East Rutherford, NJ",
    "logo_url": "https://example.com/logos/new_york_jets.png",
    "division": "AFC East"
  },
  {
    "team_id": "american_football_nfl_ravens",
    "team_name": "Baltimore Ravens",
    "full_name": "Baltimore Ravens",
    "team_code": "BAL",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Baltimore, MD",
    "logo_url": "https://example.com/logos/baltimore_ravens.png",
    "division": "AFC North"
  },
  {
    "team_id": "american_football_nfl_bengals",
    "team_name": "Cincinnati Bengals",
    "full_name": "Cincinnati Bengals",
    "team_code": "CIN",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Cincinnati, OH",
    "logo_url": "https://example.com/logos/cincinnati_bengals.png",
    "division": "AFC North"
  },
  {
    "team_id": "american_football_nfl_browns",
    "team_name": "Cleveland Browns",
    "full_name": "Cleveland Browns",
    "team_code": "CLE",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Cleveland, OH",
    "logo_url": "https://example.com/logos/cleveland_browns.png",
    "division": "AFC North"
  },
  {
    "team_id": "american_football_nfl_steelers",
    "team_name": "Pittsburgh Steelers",
    "full_name": "Pittsburgh Steelers",
    "team_code": "PIT",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Pittsburgh, PA",
    "logo_url": "https://example.com/logos/pittsburgh_steelers.png",
    "division": "AFC North"
  },
  {
    "team_id": "american_football_nfl_texans",
    "team_name": "Houston Texans",
    "full_name": "Houston Texans",
    "team_code": "HOU",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Houston, TX",
    "logo_url": "https://example.com/logos/houston_texans.png",
    "division": "AFC South"
  },
  {
    "team_id": "american_football_nfl_colts",
    "team_name": "Indianapolis Colts",
    "full_name": "Indianapolis Colts",
    "team_code": "IND",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Indianapolis, IN",
    "logo_url": "https://example.com/logos/indianapolis_colts.png",
    "division": "AFC South"
  },
  {
    "team_id": "american_football_nfl_jaguars",
    "team_name": "Jacksonville Jaguars",
    "full_name": "Jacksonville Jaguars",
    "team_code": "JAX",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Jacksonville, FL",
    "logo_url": "https://example.com/logos/jacksonville_jaguars.png",
    "division": "AFC South"
  },
  {
    "team_id": "american_football_nfl_titans",
    "team_name": "Tennessee Titans",
    "full_name": "Tennessee Titans",
    "team_code": "TEN",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Nashville, TN",
    "logo_url": "https://example.com/logos/tennessee_titans.png",
    "division": "AFC South"
  },
  {
    "team_id": "american_football_nfl_broncos",
    "team_name": "Denver Broncos",
    "full_name": "Denver Broncos",
    "team_code": "DEN",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Denver, CO",
    "logo_url": "https://example.com/logos/denver_broncos.png",
    "division": "AFC West"
  },
  {
    "team_id": "american_football_nfl_chiefs",
    "team_name": "Kansas City Chiefs",
    "full_name": "Kansas City Chiefs",
    "team_code": "KC",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Kansas City, MO",
    "logo_url": "https://example.com/logos/kansas_city_chiefs.png",
    "division": "AFC West"
  },
  {
    "team_id": "american_football_nfl_raiders",
    "team_name": "Las Vegas Raiders",
    "full_name": "Las Vegas Raiders",
    "team_code": "LV",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Las Vegas, NV",
    "logo_url": "https://example.com/logos/las_vegas_raiders.png",
    "division": "AFC West"
  },
  {
    "team_id": "american_football_nfl_chargers",
    "team_name": "Los Angeles Chargers",
    "full_name": "Los Angeles Chargers",
    "team_code": "LAC",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Los Angeles, CA",
    "logo_url": "https://example.com/logos/los_angeles_chargers.png",
    "division": "AFC West"
  },
  {
    "team_id": "american_football_nfl_cowboys",
    "team_name": "Dallas Cowboys",
    "full_name": "Dallas Cowboys",
    "team_code": "DAL",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Arlington, TX",
    "logo_url": "https://example.com/logos/dallas_cowboys.png",
    "division": "NFC East"
  },
  {
    "team_id": "american_football_nfl_giants",
    "team_name": "New York Giants",
    "full_name": "New York Giants",
    "team_code": "NYG",
    "sport": "American Football",
    "league": "National Football League",
    "location": "East Rutherford, NJ",
    "logo_url": "https://example.com/logos/new_york_giants.png",
    "division": "NFC East"
  },
  {
    "team_id": "american_football_nfl_eagles",
    "team_name": "Philadelphia Eagles",
    "full_name": "Philadelphia Eagles",
    "team_code": "PHI",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Philadelphia, PA",
    "logo_url": "https://example.com/logos/philadelphia_eagles.png",
    "division": "NFC East"
  },
  {
    "team_id": "american_football_nfl_commanders",
    "team_name": "Washington Commanders",
    "full_name": "Washington Commanders",
    "team_code": "WAS",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Landover, MD",
    "logo_url": "https://example.com/logos/washington_commanders.png",
    "division": "NFC East"
  },
  {
    "team_id": "american_football_nfl_bears",
    "team_name": "Chicago Bears",
    "full_name": "Chicago Bears",
    "team_code": "CHI",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Chicago, IL",
    "logo_url": "https://example.com/logos/chicago_bears.png",
    "division": "NFC North"
  },
  {
    "team_id": "american_football_nfl_lions",
    "team_name": "Detroit Lions",
    "full_name": "Detroit Lions",
    "team_code": "DET",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Detroit, MI",
    "logo_url": "https://example.com/logos/detroit_lions.png",
    "division": "NFC North"
  },
  {
    "team_id": "american_football_nfl_packers",
    "team_name": "Green Bay Packers",
    "full_name": "Green Bay Packers",
    "team_code": "GB",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Green Bay, WI",
    "logo_url": "https://example.com/logos/green_bay_packers.png",
    "division": "NFC North"
  },
  {
    "team_id": "american_football_nfl_vikings",
    "team_name": "Minnesota Vikings",
    "full_name": "Minnesota Vikings",
    "team_code": "MIN",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Minneapolis, MN",
    "logo_url": "https://example.com/logos/minnesota_vikings.png",
    "division": "NFC North"
  },
  {
    "team_id": "american_football_nfl_falcons",
    "team_name": "Atlanta Falcons",
    "full_name": "Atlanta Falcons",
    "team_code": "ATL",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Atlanta, GA",
    "logo_url": "https://example.com/logos/atlanta_falcons.png",
    "division": "NFC South"
  },
  {
    "team_id": "american_football_nfl_panthers",
    "team_name": "Carolina Panthers",
    "full_name": "Carolina Panthers",
    "team_code": "CAR",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Charlotte, NC",
    "logo_url": "https://example.com/logos/carolina_panthers.png",
    "division": "NFC South"
  },
  {
    "team_id": "american_football_nfl_saints",
    "team_name": "New Orleans Saints",
    "full_name": "New Orleans Saints",
    "team_code": "NO",
    "sport": "American Football",
    "league": "National Football League",
    "location": "New Orleans, LA",
    "logo_url": "https://example.com/logos/new_orleans_saints.png",
    "division": "NFC South"
  },
  {
    "team_id": "american_football_nfl_buccaneers",
    "team_name": "Tampa Bay Buccaneers",
    "full_name": "Tampa Bay Buccaneers",
    "team_code": "TB",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Tampa, FL",
    "logo_url": "https://example.com/logos/tampa_bay_buccaneers.png",
    "division": "NFC South"
  },
  {
    "team_id": "american_football_nfl_cardinals",
    "team_name": "Arizona Cardinals",
    "full_name": "Arizona Cardinals",
    "team_code": "ARI",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Glendale, AZ",
    "logo_url": "https://example.com/logos/arizona_cardinals.png",
    "division": "NFC West"
  },
  {
    "team_id": "american_football_nfl_rams",
    "team_name": "Los Angeles Rams",
    "full_name": "Los Angeles Rams",
    "team_code": "LAR",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Los Angeles, CA",
    "logo_url": "https://example.com/logos/los_angeles_rams.png",
    "division": "NFC West"
  },
  {
    "team_id": "american_football_nfl_49ers",
    "team_name": "San Francisco 49ers",
    "full_name": "San Francisco 49ers",
    "team_code": "SF",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Santa Clara, CA",
    "logo_url": "https://example.com/logos/san_francisco_49ers.png",
    "division": "NFC West"
  },
  {
    "team_id": "american_football_nfl_seahawks",
    "team_name": "Seattle Seahawks",
    "full_name": "Seattle Seahawks",
    "team_code": "SEA",
    "sport": "American Football",
    "league": "National Football League",
    "location": "Seattle, WA",
    "logo_url": "https://example.com/logos/seattle_seahawks.png",
    "division": "NFC West"
  }

];

// Competition and sport details
const competitions = [
  { name: 'NFL', sport_id: 1, full_name: 'National Football League' }
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
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'American Football'`);
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

// Function to store NFL teams dynamically fetched from the API
async function storeNFLTeamsInPostgres() {
  try {
    // Retrieve the sport_id for "American Football"
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'American Football'`);
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'American Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    // Fetch NFL teams from the API
    const teamsUrl = 'https://api.sportsdata.io/v3/nfl/scores/json/Teams/2024?key=6a1b26b6daa442449972f1aa9f66fd93';
    const response = await axios.get(teamsUrl);
    const teams = response.data;

    for (const team of teams) {
      const query = `
        INSERT INTO teams (global_team_id, abbreviation, name, sport_id, league, location, logo_url, division)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (global_team_id) DO NOTHING;
      `;

      const values = [
        team.GlobalTeamID,    // global_team_id (from API)
        team.Key,                  // abbreviation
        `${team.City} ${team.Name}`,    // Full team name
        sportId,                     // sport_id (from database lookup)
        competitions[0].name,       // League name (NFL)
        `${team.StadiumDetails.City}, ${team.StadiumDetails.State}`, // Location
        team.WikipediaLogoUrl,     // Logo URL
        `${team.Conference} ${team.Division}`,  // Division
      ];

      await client.query(query, values);
    }

    console.log('All NFL teams stored successfully in the PostgreSQL database using global_team_id and sport_id!');
  } catch (error) {
    console.error('Error storing NFL teams:', error.stack);
  }
}
// Function to store teams into team_competitions table
async function storeTeamsInCompetitions() {
  try {
    // Get competition ID for NFL
    const competitionResult = await client.query(`SELECT id FROM competitions WHERE name = 'NFL'`);
    if (competitionResult.rows.length === 0) {
      throw new Error("Competition 'NFL' not found in the database. Please ensure it is stored correctly.");
    }

    const competitionId = competitionResult.rows[0].id; // Retrieve the competition ID

    // Get all teams to add them to the competition, including global_team_id
    const teamsResult = await client.query(`SELECT id, global_team_id FROM teams`);
    const teamCompetitions = [];

    for (const team of teamsResult.rows) {
      const query = `
        INSERT INTO team_competitions (team_id, competition_id, global_team_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (team_id, competition_id) DO NOTHING;
      `;
      const values = [team.id, competitionId, team.global_team_id]; // Pass all three values: team_id, competition_id, and global_team_id
      teamCompetitions.push(client.query(query, values));
    }
    
    // Wait for all insertions to complete
    await Promise.all(teamCompetitions);

    console.log('All teams added to NFL competition successfully in the team_competitions table!');
  } catch (error) {
    console.error('Error storing teams in competitions:', error.stack);
  }
}

// URL to fetch the 2024 NFL schedule
const scheduleUrl = 'https://api.sportsdata.io/v3/nfl/scores/json/Schedules/2024?key=6a1b26b6daa442449972f1aa9f66fd93';

// Function to fetch and store NFL schedule in PostgreSQL

async function fetchAndStoreNFLSchedule() {
  try {
    // Retrieve the competition_id for "NFL" dynamically
    const competitionResult = await client.query(`SELECT id FROM competitions WHERE name = 'NFL'`);
    if (competitionResult.rows.length === 0) {
      throw new Error("Competition 'NFL' not found in the database. Please ensure it is stored correctly.");
    }

    const competitionId = competitionResult.rows[0].id; // Retrieve the competition ID

    // Retrieve the sport_id for "American Football"
    const sportResult = await client.query(`SELECT id FROM sports WHERE name = 'American Football'`);
    if (sportResult.rows.length === 0) {
      throw new Error("Sport 'American Football' not found in the database. Please ensure it is stored correctly.");
    }

    const sportId = sportResult.rows[0].id; // Retrieve the sport ID

    // Fetch the NFL schedule
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
        console.error(`Game with GameKey ${game.GameKey} has unmatched teams: GlobalHomeTeamID = ${game.GlobalHomeTeamID}, GlobalAwayTeamID = ${game.GlobalAwayTeamID}. Skipping...`);
        continue;
      }

      if (game.GlobalGameID == null) {
        console.error(`Game with GameKey ${game.GameKey} has no GlobalGameId. Skipping...`);
        continue;
      }

      // Convert DateTime from EST/EDT to UTC, assuming all times from the API are in EST or EDT (depending on the time of year)
      let gameTime = null;
      let gameDateTimeUtc = null;

      if (game.DateTime) {
        // Parse the game time from the API and assume the timezone is EST/EDT (America/New_York)
        gameTime = moment.tz(game.DateTime, 'America/New_York').utc().format('YYYY-MM-DD HH:mm:ss'); 
        gameDateTimeUtc = moment.tz(game.DateTime, 'America/New_York').utc(); // Convert to UTC moment object for further comparisons
      }

      // Check if the game is today or in the future
      if (!gameDateTimeUtc || gameDateTimeUtc.startOf('day').isBefore(currentDateTime)) {
        console.log(`Skipping past game: ${game.GameKey} scheduled on ${gameDateTimeUtc ? gameDateTimeUtc.format('YYYY-MM-DD HH:mm:ss') : 'unknown'}`);
        continue; // Skip past games
      }

      // Check if the game already exists in the database
      const gameCheckQuery = `
        SELECT * FROM schedules WHERE game_key = $1
      `;
      const existingGame = await client.query(gameCheckQuery, [game.GameKey]);

      // If the game exists, compare the data
      if (existingGame.rows.length > 0) {
        const existingRow = existingGame.rows[0];

        // Check if any of the fields differ from the API data
        if (
          existingRow.home_team_id !== homeTeamId ||
          existingRow.away_team_id !== awayTeamId ||
          existingRow.game_time !== gameTime ||
          existingRow.game_date !== game.Date.split('T')[0]
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
            game.Date.split('T')[0],     // Game date (YYYY-MM-DD)
            gameTime,                    // Game time in UTC
            game.GlobalGameID,           // SportsDataIO GlobalGameId
            sportId,                     // Sport ID for "American Football"
            game.GameKey                 // Game key from the API
          ];

          await client.query(updateQuery, updateValues);
          console.log(`Game ${game.GameKey} updated successfully in PostgreSQL!`);
        }
      } else {
        // Insert the new game schedule if it doesn't exist
        const insertQuery = `
          INSERT INTO schedules (game_key, competition_id, home_team_id, away_team_id, game_date, game_time, sportsdataio_game_id, sport_id)
          VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7, $8)
          ON CONFLICT (game_key) DO NOTHING;
        `;
        const insertValues = [
          game.GameKey,                // Game key from the API
          competitionId,               // Competition ID (retrieved dynamically)
          homeTeamId,                  // Home team internal ID
          awayTeamId,                  // Away team internal ID
          game.Date.split('T')[0],     // Game date (YYYY-MM-DD)
          gameTime,                    // Game time in UTC
          game.GlobalGameID,           // SportsDataIO GlobalGameId
          sportId                      // Sport ID for "American Football"
        ];

        await client.query(insertQuery, insertValues);
        console.log(`Game ${game.GameKey} stored successfully in PostgreSQL!`);
      }
    }

    console.log('All future NFL 2024 schedule games stored/updated successfully in PostgreSQL!');
  } catch (error) {
    console.error('Error fetching and storing NFL schedule:', error.stack);
  }
}

// Execute the functions sequentially
async function runAllFunctionsSequentially() {
  await storeSportsInPostgres() // Store sport details
  await storeCompetitionsInPostgres(); // Store competition details
  await storeNFLTeamsInPostgres(); // First, store teams
 await storeTeamsInCompetitions(); // Then, store teams in competitions
  await fetchAndStoreNFLSchedule(); // Then, store schedules
}

// Run the main function
runAllFunctionsSequentially().then(() => {
  console.log('All operations completed successfully!');
  client.end(); // Close the PostgreSQL connection
}).catch((err) => {
  console.error('Error executing functions:', err.stack);
  client.end(); // Close the PostgreSQL connection on error
});