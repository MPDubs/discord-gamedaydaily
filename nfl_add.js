// Import Firestore configuration
const db = require('./firebase');
const axios = require('axios');
const { Timestamp } = require('firebase-admin').firestore;
const geoTz = require('geo-tz');
const moment = require('moment-timezone');

// Sample data for NFL teams with division information
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

// Function to store all NFL teams under a single document in the teams collection
async function storeNFLTeamsInSingleDocument() {
  try {
    // Create a document named 'nfl' inside the 'teams' collection and add an array of all teams
    await db.collection('teams').doc('american_football_nfl').set({ teams: nflTeams });
    console.log('All NFL teams stored successfully in the "teams" collection under the "nfl" document!');
  } catch (error) {
    console.error('Error storing NFL teams:', error);
  }
}



// URL to fetch the 2024 NFL schedule
const scheduleUrl = 'https://api.sportsdata.io/v3/nfl/scores/json/Schedules/2024?key=6a1b26b6daa442449972f1aa9f66fd93';

// Function to fetch and store NFL schedule in Firestore under each team's subcollection
async function fetchAndStoreNFLSchedule() {
  try {
    const response = await axios.get(scheduleUrl);
    const schedule = response.data;

    const teamMap = {
      "BUF": "american_football_nfl_bills", "MIA": "american_football_nfl_dolphins", "NE": "american_football_nfl_patriots", "NYJ": "american_football_nfl_jets", "BAL": "american_football_nfl_ravens", 
      "CIN": "american_football_nfl_bengals", "CLE": "american_football_nfl_browns", "PIT": "american_football_nfl_steelers", "HOU": "american_football_nfl_texans", "IND": "american_football_nfl_colts", 
      "JAX": "american_football_nfl_jaguars", "TEN": "american_football_nfl_titans", "DEN": "american_football_nfl_broncos", "KC": "american_football_nfl_chiefs", "LV": "american_football_nfl_raiders", 
      "LAC": "american_football_nfl_chargers", "DAL": "american_football_nfl_cowboys", "NYG": "american_football_nfl_giants", "PHI": "american_football_nfl_eagles", "WAS": "american_football_nfl_commanders", 
      "CHI": "american_football_nfl_bears", "DET": "american_football_nfl_lions", "GB": "american_football_nfl_packers", "MIN": "american_football_nfl_vikings", "ATL": "american_football_nfl_falcons", 
      "CAR": "american_football_nfl_panthers", "NO": "american_football_nfl_saints", "TB": "american_football_nfl_buccaneers", "ARI": "american_football_nfl_cardinals", "LAR": "american_football_nfl_rams", 
      "SF": "american_football_nfl_49ers", "SEA": "american_football_nfl_seahawks"
    };

    for (const game of schedule) {
      const homeTeamId = teamMap[game.HomeTeam];
      const awayTeamId = teamMap[game.AwayTeam];

      if (!homeTeamId || !awayTeamId) {
        console.error(`Game with GameKey ${game.GameKey} has unmatched teams: HomeTeam = ${game.HomeTeam}, AwayTeam = ${game.AwayTeam}. Skipping...`);
        continue;
      }

      // Get the stadium details and determine the timezone based on geo coordinates
      const stadium = game.StadiumDetails;
      let timeZone = 'NA';
      if (stadium && stadium.GeoLat && stadium.GeoLong) {
        const timeZones = geoTz.find(stadium.GeoLat, stadium.GeoLong);
        timeZone = timeZones.length > 0 ? timeZones[0] : 'NA';
      }


      let utcDateTime;
      if (game.DateTime) {
        // Convert DateTime (given in EST) to UTC
        utcDateTime = moment.tz(game.Date, 'America/New_York').tz('UTC').toDate();
      } else {
        utcDateTime = "TBD";
      }

      // Get the time zone abbreviation like "EST" or "CST"
      const timeZoneAbbreviation = moment.tz(game.Date, 'America/New_York').tz(timeZone).format('z'); 

      const epochTime = Math.floor(utcDateTime.getTime() / 1000); // Convert to epoch time (seconds)

      // Create a game object with the relevant fields
      const gameData = {
        game_id: game.GameKey,
        day: game.Day,
        time: utcDateTime!="TBD"?Timestamp.fromDate(utcDateTime):utcDateTime, // Store as UTC Timestamp
        week: game.Week,
        home_team_id: homeTeamId,
        away_team_id: awayTeamId,
        stadium: {
          id: stadium?.StadiumID,
          name: stadium?.Name,
          city: stadium?.City,
          state: stadium?.State,
          country: stadium?.Country,
          capacity: stadium?.Capacity,
          surface: stadium?.PlayingSurface,
          type: stadium?.Type,
          geo_lat: stadium?.GeoLat,
          geo_long: stadium?.GeoLong
        },
        status: game.Status,
        season: game.Season,
        season_type: game.SeasonType,
        home_team_score: game.HomeScore ?? 0,
        away_team_score: game.AwayScore ?? 0,
        channel: game.Channel,
        day: game.Day.split('T')[0], // Extract the date part keep as string
        over_under: game.OverUnder,
        point_spread: game.PointSpread,
        forecast: {
          temp_low: game.ForecastTempLow,
          temp_high: game.ForecastTempHigh,
          description: game.ForecastDescription,
          wind_chill: game.ForecastWindChill,
          wind_speed: game.ForecastWindSpeed
        },
        epoch_time: epochTime,
        timezone: timeZoneAbbreviation
      };

      const documentId = `${game.AwayTeam}@${game.HomeTeam}-${game.Date.split('T')[0]}`;

      await db.collection('schedules').doc('american_football_nfl').collection(homeTeamId).doc(documentId).set(gameData);
      await db.collection('schedules').doc('american_football_nfl').collection(awayTeamId).doc(documentId).set(gameData);
      console.log(`Game ${documentId} stored successfully under both ${homeTeamId} and ${awayTeamId} subcollections!`);
    }

    console.log('All NFL 2024 schedule games stored successfully under each team\'s subcollection in Firestore!');
  } catch (error) {
    console.error('Error fetching and storing NFL schedule:', error);
  }

}
// Execute the functions sequentially to ensure order
async function runAllFunctionsSequentially() {
  //await storeNFLTeamsInSingleDocument(); // Wait for teams to be stored
  await fetchAndStoreNFLSchedule(); // Then store schedules
}

// Run the main function
runAllFunctionsSequentially();

