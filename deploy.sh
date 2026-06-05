#!/bin/bash
set -e

echo "=== GameDayDaily Deployment ==="
echo ""

cd ~/discord-gamedaydaily

echo "[1/4] Pulling latest code..."
git pull origin main 2>/dev/null || echo "Warning: git pull failed or repo is not a git repo. Ensure code is updated manually."

echo "[2/4] Adding database column..."
sudo -u postgres psql -d discord_gamedaydaily << EOF
ALTER TABLE tracked_teams ADD COLUMN IF NOT EXISTS espn_known_leagues TEXT DEFAULT '';
\q
EOF
echo "✓ Database column added."

echo "[3/4] Backfilling known leagues for existing teams..."
node << 'NODEOF'
const { Pool } = require('pg');
const { discoverLeaguesForTeam } = require('./espn_lookup');
require('dotenv').config();

const pool = new Pool({
  user: process.env.DATABASE_USER,
  host: process.env.DATABASE_HOST,
  database: process.env.DATABASE_NAME,
  password: process.env.DATABASE_PASSWORD,
  port: Number(process.env.DATABASE_PORT || 5432)
});

(async () => {
  try {
    const result = await pool.query(
      `SELECT id, espn_sport, espn_team_id, team_name FROM tracked_teams 
       WHERE espn_team_id IS NOT NULL 
         AND espn_sport IS NOT NULL 
         AND (espn_known_leagues IS NULL OR espn_known_leagues = '')`
    );

    console.log(`Found ${result.rows.length} teams to backfill.`);

    for (const row of result.rows) {
      try {
        const leagues = await discoverLeaguesForTeam(row.espn_sport, row.espn_team_id);
        const leaguesStr = leagues.join(',');
        await pool.query('UPDATE tracked_teams SET espn_known_leagues = $1 WHERE id = $2', [leaguesStr, row.id]);
        console.log(`✓ ${row.team_name}: ${leaguesStr || '(no leagues found)'}`);
      } catch (err) {
        console.error(`✗ ${row.team_name}: ${err.message}`);
      }
    }

    console.log('\n✓ Backfill complete.');
    await pool.end();
  } catch (err) {
    console.error('Backfill failed:', err);
    await pool.end();
    process.exit(1);
  }
})();
NODEOF

echo "[4/4] Restarting bot..."
if command -v pm2 &> /dev/null; then
  pm2 restart bot
  echo "✓ Bot restarted via PM2."
elif systemctl is-active --quiet discord-gamedaydaily; then
  sudo systemctl restart discord-gamedaydaily
  echo "✓ Bot restarted via systemd."
else
  echo "Warning: Could not determine how to restart bot. Please restart manually."
fi

echo ""
echo "=== Deployment Complete ==="
