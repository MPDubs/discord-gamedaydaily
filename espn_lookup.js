const axios = require('axios');
const moment = require('moment-timezone');

const LEAGUES = [
  { sport: 'basketball', league: 'nba', label: 'NBA' },
  { sport: 'basketball', league: 'wnba', label: 'WNBA' },
  { sport: 'football', league: 'nfl', label: 'NFL' },
  { sport: 'football', league: 'college-football', label: 'NCAAF' },
  { sport: 'basketball', league: 'mens-college-basketball', label: 'NCAAM' },
  { sport: 'baseball', league: 'mlb', label: 'MLB' },
  { sport: 'hockey', league: 'nhl', label: 'NHL' },
  { sport: 'soccer', league: 'usa.1', label: 'MLS' },
  { sport: 'soccer', league: 'eng.1', label: 'EPL' }
];

const teamsCache = new Map();

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenScore(query, candidate) {
  const q = normalizeText(query);
  const c = normalizeText(candidate);
  if (!q || !c) {
    return 0;
  }
  if (q === c) {
    return 1;
  }
  if (c.includes(q) || q.includes(c)) {
    return 0.92;
  }

  const qTokens = new Set(q.split(' ').filter(Boolean));
  const cTokens = new Set(c.split(' ').filter(Boolean));
  let common = 0;
  qTokens.forEach((token) => {
    if (cTokens.has(token)) {
      common += 1;
    }
  });

  const denom = Math.max(qTokens.size, cTokens.size, 1);
  return common / denom;
}

function confidenceFromScore(score) {
  if (score >= 0.92) {
    return 'high';
  }
  if (score >= 0.62) {
    return 'medium';
  }
  return 'low';
}

async function fetchLeagueTeams(sport, league) {
  const key = `${sport}/${league}`;
  const now = Date.now();
  const cached = teamsCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.teams;
  }

  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams`;
  const response = await axios.get(url, { timeout: 12000 });
  const entries = response.data?.sports?.[0]?.leagues?.[0]?.teams || [];

  const teams = entries
    .map((entry) => entry.team)
    .filter(Boolean)
    .map((team) => ({
      teamId: String(team.id || ''),
      displayName: team.displayName || team.name || '',
      shortDisplayName: team.shortDisplayName || '',
      abbreviation: team.abbreviation || '',
      sport,
      league,
      sourceUrl: team.links?.[0]?.href || ''
    }))
    .filter((team) => team.teamId && team.displayName);

  teamsCache.set(key, {
    teams,
    expiresAt: now + 6 * 60 * 60 * 1000
  });

  return teams;
}

async function resolveTeamWithEspn(rawTeamName) {
  const query = String(rawTeamName || '').trim();
  if (!query) {
    return { bestMatch: null, candidates: [] };
  }

  const candidates = [];

  for (const leagueConfig of LEAGUES) {
    try {
      const leagueTeams = await fetchLeagueTeams(leagueConfig.sport, leagueConfig.league);
      for (const team of leagueTeams) {
        const score = Math.max(
          tokenScore(query, team.displayName),
          tokenScore(query, team.shortDisplayName),
          tokenScore(query, team.abbreviation)
        );

        if (score < 0.4) {
          continue;
        }

        candidates.push({
          ...team,
          confidence: confidenceFromScore(score),
          score,
          leagueLabel: leagueConfig.label
        });
      }
    } catch (error) {
      console.error(`Failed fetching ESPN teams for ${leagueConfig.sport}/${leagueConfig.league}:`, error.message);
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const best = candidates[0] || null;
  if (!best) {
    return { bestMatch: null, candidates: [] };
  }

  return {
    bestMatch: {
      teamId: best.teamId,
      displayName: best.displayName,
      sport: best.sport,
      league: best.league,
      leagueLabel: best.leagueLabel,
      confidence: best.confidence,
      sourceUrl: best.sourceUrl
    },
    candidates: candidates.slice(0, 5).map((candidate) => ({
      teamId: candidate.teamId,
      displayName: candidate.displayName,
      sport: candidate.sport,
      league: candidate.league,
      leagueLabel: candidate.leagueLabel,
      confidence: candidate.confidence
    }))
  };
}

async function fetchScoreboard(sport, league, date) {
  const compactDate = String(date || '').replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard?dates=${compactDate}`;
  const response = await axios.get(url, { timeout: 12000 });
  return response.data;
}

function getRankForCompetitor(competitor) {
  const rankA = Number(competitor?.curatedRank?.current || 0);
  const rankB = Number(competitor?.rank || 0);
  const rank = rankA || rankB;
  return Number.isFinite(rank) && rank > 0 ? rank : null;
}

function computeSignificance(event, competition) {
  let score = 0;
  const reasons = [];

  const textBlob = [
    event?.name,
    event?.shortName,
    competition?.notes?.map((n) => n?.headline).join(' '),
    competition?.headline
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const seasonType = Number(event?.season?.type || 0);
  if (seasonType >= 3) {
    score += 55;
    reasons.push('Postseason game');
  }

  if (/playoff|semi.?final|quarter.?final|final|championship|wild card|divisional|bowl/i.test(textBlob)) {
    score += 45;
    reasons.push('Playoff or championship context');
  }

  const competitors = competition?.competitors || [];
  const ranks = competitors
    .map((competitor) => getRankForCompetitor(competitor))
    .filter((rank) => rank && rank <= 25);

  if (ranks.length >= 2) {
    score += 30;
    reasons.push('Ranked matchup');
  } else if (ranks.length === 1) {
    score += 15;
    reasons.push('Ranked team in matchup');
  }

  const weekNumber = Number(event?.week?.number || 0);
  if (weekNumber >= 15) {
    score += 12;
    reasons.push('Late-season game');
  }

  const broadcastNames = (competition?.broadcasts || [])
    .map((broadcast) => broadcast?.names || [])
    .flat()
    .filter(Boolean)
    .map((name) => String(name).toUpperCase());

  if (broadcastNames.some((name) => /ABC|ESPN|NBC|CBS|FOX|TNT/.test(name))) {
    score += 8;
    reasons.push('National broadcast');
  }

  const level = score >= 55 ? 'high' : score >= 25 ? 'medium' : 'low';
  return {
    level,
    score,
    reasons
  };
}

function parseCompetitionOdds(competition) {
  const odds = Array.isArray(competition?.odds) ? competition.odds[0] : null;
  if (!odds) {
    return '';
  }

  const homeTeam = competition?.competitors?.find((competitor) => competitor?.homeAway === 'home')?.team;
  const awayTeam = competition?.competitors?.find((competitor) => competitor?.homeAway === 'away')?.team;
  const provider = odds?.provider?.displayName || odds?.provider?.name || '';

  const homeIsFavorite = Boolean(odds?.homeTeamOdds?.favorite);
  const awayIsFavorite = Boolean(odds?.awayTeamOdds?.favorite);
  const spreadValue = Number(odds?.spread);
  const overUnder = Number(odds?.overUnder);

  const parts = [];

  if (Number.isFinite(spreadValue) && spreadValue !== 0 && (homeIsFavorite || awayIsFavorite)) {
    const favoriteTeam = homeIsFavorite ? homeTeam : awayTeam;
    const favoriteName = favoriteTeam?.displayName || favoriteTeam?.name || 'Favorite';
    parts.push(`${favoriteName} favored by ${Math.abs(spreadValue)}`);
  } else if (odds?.details) {
    parts.push(String(odds.details));
  }

  if (Number.isFinite(overUnder) && overUnder > 0) {
    parts.push(`O/U ${overUnder}`);
  }

  if (parts.length === 0) {
    const awayMoneyline = odds?.moneyline?.away?.close?.odds;
    const homeMoneyline = odds?.moneyline?.home?.close?.odds;
    if (awayMoneyline || homeMoneyline) {
      const awayLabel = awayTeam?.abbreviation || awayTeam?.displayName || 'Away';
      const homeLabel = homeTeam?.abbreviation || homeTeam?.displayName || 'Home';
      parts.push(`${awayLabel} ML ${awayMoneyline || 'N/A'} / ${homeLabel} ML ${homeMoneyline || 'N/A'}`);
    }
  }

  if (parts.length === 0) {
    return '';
  }

  return provider ? `${parts.join('; ')} (${provider})` : parts.join('; ');
}

function eventToGame(event, matchedTeamName, timezone, confidence, context = {}) {
  const competition = event?.competitions?.[0];
  const competitors = competition?.competitors || [];
  const home = competitors.find((c) => c.homeAway === 'home');
  const away = competitors.find((c) => c.homeAway === 'away');

  if (!home?.team || !away?.team) {
    return null;
  }

  const matchedNameNorm = normalizeText(matchedTeamName);
  const homeNorm = normalizeText(home.team.displayName || home.team.name || '');
  const awayNorm = normalizeText(away.team.displayName || away.team.name || '');

  const isHomeMatch = homeNorm.includes(matchedNameNorm);
  const isAwayMatch = awayNorm.includes(matchedNameNorm);

  const teamSide = isHomeMatch ? home : isAwayMatch ? away : home;
  const opponentSide = teamSide === home ? away : home;

  const teamName = teamSide?.team?.displayName || matchedTeamName;
  const opponent = opponentSide?.team?.displayName || 'TBD';

  const teamLogoUrl = teamSide?.team?.logos?.[0]?.href || '';
  const opponentLogoUrl = opponentSide?.team?.logos?.[0]?.href || '';

  const dt = event.date ? moment.tz(event.date, timezone) : null;
  const startTimeLocal = dt && dt.isValid() ? dt.format('h:mm A') : 'TBD';

  const venue = competition?.venue?.fullName || 'TBD';
  const city = competition?.venue?.address?.city || '';
  const state = competition?.venue?.address?.state || competition?.venue?.address?.country || '';
  const location = [city, state].filter(Boolean).join(', ') || 'TBD';

  const broadcasts = competition?.broadcasts || [];
  const watch = broadcasts.length > 0
    ? broadcasts
        .map((b) => b.names || [])
        .flat()
        .filter(Boolean)
        .join(', ') || 'TBD'
    : 'TBD';

  const sourceUrl = event?.links?.[0]?.href || '';
  const competitionName = event?.league?.name || event?.shortName?.split(' - ')[0] || 'TBD';
  const significance = computeSignificance(event, competition);
  const oddsSummary = parseCompetitionOdds(competition);

  return {
    team: teamName,
    opponent,
    sport: context.sport || '',
    league: context.league || '',
    teamEspnId: String(context.teamEspnId || ''),
    teamLogoUrl,
    opponentLogoUrl,
    startTimeLocal,
    venue,
    location,
    watch,
    competition: competitionName,
    confidence,
    oddsSummary,
    sourceUrl,
    notes: sourceUrl ? `Verified from ESPN event data.` : 'Verified from ESPN event data.',
    significanceLevel: significance.level,
    significanceScore: significance.score,
    significanceReasons: significance.reasons
  };
}

async function getEspnGamesForTeams({ followedTeams, targetDate, timezone }) {
  if (!Array.isArray(followedTeams) || followedTeams.length === 0) {
    return { games: [], noGames: [] };
  }

  const games = [];
  const noGames = [];

  const byLeague = new Map();
  followedTeams.forEach((team) => {
    if (team.espn_sport && team.espn_league) {
      const key = `${team.espn_sport}/${team.espn_league}`;
      if (!byLeague.has(key)) {
        byLeague.set(key, []);
      }
      byLeague.get(key).push(team);
    }
  });

  const unresolvedTeams = followedTeams.filter((team) => !team.espn_team_id || !team.espn_sport || !team.espn_league);

  try {
    for (const [key, teamsInLeague] of byLeague.entries()) {
      const [sport, league] = key.split('/');
      const board = await fetchScoreboard(sport, league, targetDate);
      const events = board?.events || [];

      const eventsByTeamId = new Map();
      for (const event of events) {
        const competitors = event?.competitions?.[0]?.competitors || [];
        competitors.forEach((comp) => {
          const id = String(comp?.team?.id || '');
          if (id) {
            eventsByTeamId.set(id, event);
          }
        });
      }

      for (const team of teamsInLeague) {
        const event = eventsByTeamId.get(String(team.espn_team_id || ''));
        if (!event) {
          noGames.push(team.name);
          continue;
        }

        const game = eventToGame(
          event,
          team.espn_display_name || team.name,
          timezone,
          team.espn_confidence || 'high',
          {
            sport,
            league,
            teamEspnId: team.espn_team_id
          }
        );

        if (game) {
          games.push(game);
        } else {
          noGames.push(team.name);
        }
      }
    }

    if (unresolvedTeams.length > 0) {
      for (const team of unresolvedTeams) {
        const resolved = await resolveTeamWithEspn(team.name);
        if (!resolved.bestMatch) {
          noGames.push(team.name);
          continue;
        }

        try {
          const board = await fetchScoreboard(resolved.bestMatch.sport, resolved.bestMatch.league, targetDate);
          const event = (board?.events || []).find((evt) => {
            const competitors = evt?.competitions?.[0]?.competitors || [];
            return competitors.some((comp) => String(comp?.team?.id || '') === resolved.bestMatch.teamId);
          });

          if (!event) {
            noGames.push(team.name);
            continue;
          }

          const game = eventToGame(event, resolved.bestMatch.displayName, timezone, resolved.bestMatch.confidence, {
            sport: resolved.bestMatch.sport,
            league: resolved.bestMatch.league,
            teamEspnId: resolved.bestMatch.teamId
          });
          if (game) {
            games.push(game);
          } else {
            noGames.push(team.name);
          }
        } catch (error) {
          console.error(`Failed unresolved scoreboard lookup for ${team.name}:`, error.message);
          noGames.push(team.name);
        }
      }
    }

    return {
      games,
      noGames: Array.from(new Set(noGames))
    };
  } catch (error) {
    return {
      games: [],
      noGames: followedTeams.map((team) => team.name),
      error: {
        code: 'ESPN_LOOKUP_FAILED',
        message: error.message
      }
    };
  }
}

module.exports = {
  resolveTeamWithEspn,
  getEspnGamesForTeams
};
