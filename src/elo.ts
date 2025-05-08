import { Low } from 'lowdb';

/**
 * Player rating data structure
 */
export type PlayerRating = {
  name: string;
  elo: number;
  wins: number;
  losses: number;
  pointsWon: number;
  pointsConceded: number;
  matchesPlayed: number;
};

/**
 * Configuration parameters for the Elo rating system
 */
export type EloConfig = {
  initialRating: number;      // Initial rating for new players
  kFactor: number;            // Base K-factor (how much a single match affects ratings)
  kFactorMin: number;         // Minimum K-factor (for experienced players)
  kFactorDecay: number;       // How much K-factor decreases per match played
  pointDiffWeight: number;    // How much point differential affects rating changes
};

/**
 * Default Elo configuration values optimized for beach volleyball
 */
export const DEFAULT_ELO_CONFIG: EloConfig = {
  initialRating: 1000,
  kFactor: 32,
  kFactorMin: 16,
  kFactorDecay: 0.1,
  pointDiffWeight: 0.01
};

/**
 * Calculates the expected score (win probability) for player A against player B
 * 
 * @param ratingA - Rating of player A
 * @param ratingB - Rating of player B
 * @returns The expected score for player A (between 0 and 1)
 */
export function getExpectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Calculates the K-factor for a player based on matches played
 * 
 * @param matchesPlayed - Number of matches the player has played
 * @param config - Elo configuration parameters
 * @returns The adjusted K-factor for the player
 */
export function getKFactor(matchesPlayed: number, config: EloConfig): number {
  // K-factor decreases with more matches played but never below kFactorMin
  return Math.max(
    config.kFactorMin,
    config.kFactor * Math.exp(-config.kFactorDecay * matchesPlayed)
  );
}



/**
 * Updates player ratings based on a match result using the Elo rating system
 * 
 * @param playerA - Rating data for player A
 * @param playerB - Rating data for player B
 * @param scoreA - Points scored by player A
 * @param scoreB - Points scored by player B
 * @param config - Elo configuration parameters
 * @returns The updated player rating objects for A and B
 */
export function updatePlayerRatings(
  playerA: PlayerRating,
  playerB: PlayerRating,
  scoreA: number,
  scoreB: number,
  config: EloConfig = DEFAULT_ELO_CONFIG
): [PlayerRating, PlayerRating] {
  // Calculate expected scores
  const expectedA = getExpectedScore(playerA.elo, playerB.elo);
  const expectedB = getExpectedScore(playerB.elo, playerA.elo);

  // Determine actual outcome (1 for win, 0.5 for draw, 0 for loss)
  const actualA = scoreA > scoreB ? 1 : scoreA === scoreB ? 0.5 : 0;
  const actualB = 1 - actualA;

  // Calculate point differential factor
  const totalPoints = scoreA + scoreB;
  const pointDiffA = totalPoints > 0 ? (scoreA - scoreB) / totalPoints : 0;
  const pointDiffFactor = config.pointDiffWeight * Math.abs(pointDiffA);

  // Calculate K-factors for both players
  const kFactorA = getKFactor(playerA.matchesPlayed, config);
  const kFactorB = getKFactor(playerB.matchesPlayed, config);

  // Calculate final rating changes
  const changeA = Math.round(kFactorA * ((actualA - expectedA) + pointDiffFactor * pointDiffA));
  const changeB = Math.round(kFactorB * ((actualB - expectedB) - pointDiffFactor * pointDiffA));

  // Update player stats
  const updatedA: PlayerRating = {
    ...playerA,
    elo: playerA.elo + changeA,
    wins: playerA.wins + (actualA === 1 ? 1 : 0),
    losses: playerA.losses + (actualA === 0 ? 1 : 0),
    pointsWon: playerA.pointsWon + scoreA,
    pointsConceded: playerA.pointsConceded + scoreB,
    matchesPlayed: playerA.matchesPlayed + 1
  };

  const updatedB: PlayerRating = {
    ...playerB,
    elo: playerB.elo + changeB,
    wins: playerB.wins + (actualB === 1 ? 1 : 0),
    losses: playerB.losses + (actualB === 0 ? 1 : 0),
    pointsWon: playerB.pointsWon + scoreB,
    pointsConceded: playerB.pointsConceded + scoreA,
    matchesPlayed: playerB.matchesPlayed + 1
  };

  return [updatedA, updatedB];
}



/**
 * Calculates the Elo ratings for all players based on all matches
 * 
 * @param db - The database containing players and sessions
 * @param config - Elo configuration parameters
 * @returns Array of player ratings sorted by Elo rating (highest first)
 */
export function calculateEloRatings<T extends { 
  players: { name: string }[],
  sessions: { id: string, rounds: Round[] }[]
}>(
  db: Low<T>,
  config: EloConfig = DEFAULT_ELO_CONFIG
): PlayerRating[] {
  if (!db.data) return [];

  // Initialize player ratings
  const playerRatings: Record<string, PlayerRating> = {};
  db.data.players.forEach(player => {
    playerRatings[player.name] = {
      name: player.name,
      elo: config.initialRating,
      wins: 0,
      losses: 0,
      pointsWon: 0,
      pointsConceded: 0,
      matchesPlayed: 0
    };
  });

  // Sort sessions chronologically
  const sortedSessions = [...db.data.sessions].sort((a, b) => {
    return new Date(a.id).getTime() - new Date(b.id).getTime();
  });

  // Process all matches chronologically to update Elo ratings
  sortedSessions.forEach(session => {
    
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        if (set.teams.length !== 2) return;
        
        const team1 = set.teams[0];
        const team2 = set.teams[1];
        
        // Skip matches with no scores
        if (team1.points === 0 && team2.points === 0) return;
        
        // Update ratings for each pair of players
        for (const player1 of team1.team.players) {
          for (const player2 of team2.team.players) {
            if (!playerRatings[player1] || !playerRatings[player2]) continue;
            
            const [updated1, updated2] = updatePlayerRatings(
              playerRatings[player1],
              playerRatings[player2],
              team1.points,
              team2.points,
              config
            );
            
            // We need to carefully update only the Elo components here to avoid double counting other stats
            playerRatings[player1] = {
              ...playerRatings[player1],
              elo: updated1.elo
            };
            
            playerRatings[player2] = {
              ...playerRatings[player2],
              elo: updated2.elo
            };
          }
        }
        
        // Update general stats after all Elo calculations
        for (const player of [...team1.team.players, ...team2.team.players]) {
          if (!playerRatings[player]) continue;
          
          const isTeam1 = team1.team.players.includes(player);
          const ownTeam = isTeam1 ? team1 : team2;
          const opposingTeam = isTeam1 ? team2 : team1;
          
          playerRatings[player] = {
            ...playerRatings[player],
            wins: playerRatings[player].wins + (ownTeam.points > opposingTeam.points ? 1 : 0),
            losses: playerRatings[player].losses + (ownTeam.points < opposingTeam.points ? 1 : 0),
            pointsWon: playerRatings[player].pointsWon + ownTeam.points,
            pointsConceded: playerRatings[player].pointsConceded + opposingTeam.points,
            matchesPlayed: playerRatings[player].matchesPlayed + 1
          };
        }
      });
    });
  });

  // Convert to array and sort by Elo rating
  return Object.values(playerRatings)
    .filter(player => player.matchesPlayed >= 8) // Only include players who have played at least 8 matches
    .sort((a, b) => b.elo - a.elo);
}

/**
 * Enhanced player ranking that includes additional metrics
 */
export type EnhancedRanking = PlayerRating & {
  pointDifferential: number;  // Total points won minus points conceded
  winRate: number;            // Win percentage
  avgPointsPerGame: number;   // Average points scored per game
  avgPointDiffPerGame: number; // Average point differential per game
  consistency: number;        // A measure of player performance consistency (0-1)
};

/**
 * Calculates enhanced rankings with additional metrics beyond just Elo
 * 
 * @param ratings - Array of basic player ratings
 * @returns Array of enhanced player rankings
 */
export function calculateEnhancedRankings(ratings: PlayerRating[]): EnhancedRanking[] {
  return ratings.map(player => {
    // Calculate additional metrics
    const matchesPlayed = player.matchesPlayed;
    const pointDifferential = player.pointsWon - player.pointsConceded;
    const winRate = matchesPlayed > 0 ? player.wins / matchesPlayed : 0;
    const avgPointsPerGame = matchesPlayed > 0 ? player.pointsWon / matchesPlayed : 0;
    const avgPointDiffPerGame = matchesPlayed > 0 ? pointDifferential / matchesPlayed : 0;
    
    // Calculate a consistency metric (1 is perfectly consistent)
    const consistency = winRate > 0 ? 
      Math.min(1, Math.max(0, 1 - Math.abs(0.5 - avgPointDiffPerGame / 21) * 2)) : 
      0;

    return {
      ...player,
      pointDifferential,
      winRate,
      avgPointsPerGame,
      avgPointDiffPerGame,
      consistency
    };
  });
}
