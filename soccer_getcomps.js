const axios = require('axios');

async function getCompetitions() {
  try {
    const response = await axios.get('https://api.sportsdata.io/v4/soccer/scores/json/Competitions?key=08d3a1b54f054cb9972f5e27da405b95');
    const competitions = response.data.map(competition => ({
      name: competition.Name,
      key: competition.Key,
    }));
    console.log(competitions);
  } catch (error) {
    console.error('Error fetching competitions:', error);
  }
}

getCompetitions();