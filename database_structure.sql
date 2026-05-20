-- Sports Table
CREATE TABLE sports (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL -- e.g., "Football", "Basketball"
);

-- Competitions Table (references Sports table)
CREATE TABLE competitions (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL, -- e.g., "NFL", "EPL", "UEFA"
    full_name VARCHAR(255) NOT NULL, -- e.g., "National Football League", "English Premier League", "Union of European Football Associations"
    sport_id INT REFERENCES sports(id) ON DELETE CASCADE -- Links to the sport this competition belongs to
);

-- Teams Table
CREATE TABLE teams (
    id SERIAL PRIMARY KEY,
    abbreviation VARCHAR(10) UNIQUE NOT NULL, -- e.g., "BUF"
    global_team_id BIGINT, -- Unique ID from the SportsDataIO API
    name VARCHAR(100) NOT NULL, -- Full name of the team, e.g., "Buffalo Bills"
    sport_type VARCHAR(50), -- e.g., "American Football"
    league VARCHAR(50), -- e.g., "National Football League"
    location VARCHAR(100), -- e.g., "Buffalo, NY"
    logo_url VARCHAR(255), -- URL to the logo of the team
    division VARCHAR(50), -- e.g., "AFC East"
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Schedules Table
CREATE TABLE schedules (
    id SERIAL PRIMARY KEY,
    game_key VARCHAR(20) UNIQUE NOT NULL, -- Matches the "GameKey" from the API
    competition_id INT REFERENCES competitions(id) ON DELETE CASCADE, -- Link to competition
    home_team_id INT REFERENCES teams(id) ON DELETE CASCADE, -- Home team ID
    away_team_id INT REFERENCES teams(id) ON DELETE CASCADE, -- Away team ID
    game_date DATE NOT NULL, -- Date of the game
    game_time TIMESTAMP, -- Time of the game without time zone
    sportsdataio_game_id INTEGER
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Servers Table (Discord Servers)
CREATE TABLE servers (
    id SERIAL PRIMARY KEY,
    server_id VARCHAR(100) UNIQUE NOT NULL, -- Discord server ID
    name VARCHAR(100) NOT NULL, -- Discord server name
    owner_id VARCHAR(100), -- Discord ID of the server owner
    channel_id VARCHAR(100), -- Discord channel ID for automatic posts
    server_timezone VARCHAR(50) DEFAULT 'UTC', -- Timezone of the server (e.g., "America/Los_Angeles")
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Server Teams Table (Tracks which teams each server is following)
CREATE TABLE server_teams (
    id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(id) ON DELETE CASCADE, -- Links to the Discord server
    team_id INT REFERENCES teams(id) ON DELETE CASCADE, -- Links to the team
    tracking_since TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (server_id, team_id) -- Ensure a server can track a team only once
);

-- Users Table (Discord Users)
CREATE TABLE users (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(100) UNIQUE NOT NULL, -- Discord user ID
    username VARCHAR(100) NOT NULL, -- Discord username
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Server Users Table (Users within each Discord server)
CREATE TABLE server_users (
    id SERIAL PRIMARY KEY,
    server_id INT REFERENCES servers(id) ON DELETE CASCADE, -- Links to the Discord server
    user_id INT REFERENCES users(id) ON DELETE CASCADE, -- Links to the Discord user
    role VARCHAR(50), -- Role of the user within the server (e.g., "Admin", "Member")
    joined_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (server_id, user_id) -- Ensure a user can join a server only once
);

-- Team Competitions Table (for teams being in multiple competitions)
CREATE TABLE team_competitions (
    team_id INT REFERENCES teams(id) ON DELETE CASCADE,
    competition_id INT REFERENCES competitions(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, competition_id), -- Composite primary key
    UNIQUE (team_id, competition_id)
);