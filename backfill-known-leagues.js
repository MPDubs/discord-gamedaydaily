#!/usr/bin/env node
require('dotenv').config();
const { Pool } = require('pg');
const { discoverLeaguesForTeam } = require('./espn_lookup');

const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: Number(process.env.DATABASE_PORT || 5432)
});

(async () => {
  try {
    console.log('Fetching teams needing backfill...');
    const result = await pool.query(
      `SELECT id, espn_sport, espn_team_id, team_name FROM tracked_teams 
       WHERE espn_team_id IS NOT NULL 
         AND espn_sport IS NOT NULL 
         AND (espn_known_leagues IS NULL OR espn_known_leagues = '')`
    );

    console.log(`Found ${result.rows.length} teams to process.\n`);

    if (result.rows.length === 0) {
      console.log('No teams need backfill. All done!');
      await pool.end();
      return;
    }

    let updated = 0;
    for (const row of result.rows) {
      try {
        console.log(`Discovering leagues for ${row.team_name}...`);
        const leagues = await discoverLeaguesForTeam(row.espn_sport, row.espn_team_id);
        const leaguesStr = leagues.join(',');
        await pool.query('UPDATE tracked_teams SET espn_known_leagues = $1 WHERE id = $2', [leaguesStr, row.id]);
        console.log(`  ✓ ${row.team_name}: ${leaguesStr || '(no leagues found)'}\n`);
        updated++;
      } catch (err) {
        console.log(`  ✗ ${row.team_name}: ${err.message}\n`);
      }
    }

    console.log(`\n=== Backfill Complete ===`);
    console.log(`Updated: ${updated}/${result.rows.length} teams`);
    await pool.end();
  } catch (err) {
    console.error('Backfill failed:', err);
    await pool.end();
    process.exit(1);
  }
})();
