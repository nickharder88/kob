import { program } from 'commander';
import { JSONFilePreset } from 'lowdb/node';
import { Low } from 'lowdb';
import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';

import { 
  calculateEloRatings, 
  calculateEnhancedRankings, 
  DEFAULT_ELO_CONFIG, 
  PlayerRating, 
  EnhancedRanking 
} from './elo.js';

async function addPlayer(db: Low<Data>, name: string) {
  const player = { name };
  db.data.players.push(player);
  await db.write();
}

/*
  Given the players in the database, rank them.

  1. Order by wins
  2. Order by point ratio
*/
function rankPlayers(db: Low<Data>): RankedPlayer[] {
  if (!db.data) {
    console.error("Database is not initialized");
    return [];
  }

  // Get Elo ratings
  const eloRatings = calculateEloRatings(db);
  const eloMap: Record<string, number> = {};
  eloRatings.forEach((rating: PlayerRating) => {
    eloMap[rating.name] = rating.elo;
  });

  const playerStats: Record<string, { 
    points: number,
    wins: number,
    totalPointsPlayed: number
  }> = {};

  // Initialize stats for all players
  db.data.players.forEach(player => {
    playerStats[player.name] = {
      points: 0,
      wins: 0,
      totalPointsPlayed: 0
    };
  });

  // Calculate statistics for each player
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        // Calculate total points in this set
        const totalPointsInSet = set.teams.reduce((sum, team) => sum + team.points, 0);
        
        // Determine the winning team
        let winningTeam: Team | null = null;
        if (set.teams.length === 2) {
          if (set.teams[0].points > set.teams[1].points) {
            winningTeam = set.teams[0].team;
          } else if (set.teams[1].points > set.teams[0].points) {
            winningTeam = set.teams[1].team;
          }
        }

        // Update player statistics
        set.teams.forEach(teamSet => {
          teamSet.team.players.forEach(playerName => {
            if (!playerStats[playerName]) {
              playerStats[playerName] = { points: 0, wins: 0, totalPointsPlayed: 0 };
            }
            
            // Add points
            playerStats[playerName].points += teamSet.points;
            
            // Add to total points played
            playerStats[playerName].totalPointsPlayed += totalPointsInSet;
            
            // Increment wins if this player was on the winning team
            if (winningTeam && winningTeam.players.includes(playerName)) {
              playerStats[playerName].wins += 1;
            }
          });
        });
      });
    });
  });

  // Create a list of ranked players with calculated statistics
  const rankedPlayers = db.data.players.map(player => {
    const stats = playerStats[player.name] || { points: 0, wins: 0, totalPointsPlayed: 0 };
    return {
      player: player,
      points: stats.points,
      wins: stats.wins,
      totalPointsPlayed: stats.totalPointsPlayed,
      pointRatio: stats.totalPointsPlayed > 0 ? stats.points / stats.totalPointsPlayed : 0,
      eloRating: eloMap[player.name] || DEFAULT_ELO_CONFIG.initialRating,
      matchesPlayed: calculateMatches(db, player.name)
    };
  })
  .filter(player => player.matchesPlayed >= 8); // Only include players with at least 8 matches

  // Sort players by Elo rating (primary), wins (secondary), and point ratio (tertiary)
  rankedPlayers.sort((a, b) => {
    // First sort by Elo rating
    const eloA = a.eloRating || DEFAULT_ELO_CONFIG.initialRating;
    const eloB = b.eloRating || DEFAULT_ELO_CONFIG.initialRating;
    
    if (eloB !== eloA) {
      return eloB - eloA;
    }
    
    // If Elo is tied, sort by wins
    if (b.wins !== a.wins) {
      return b.wins - a.wins;
    }
    
    // If wins are tied, sort by point ratio
    return b.pointRatio - a.pointRatio;
  });

  return rankedPlayers;
}

function displayRankedPlayers(db: Low<Data>) {
  const rankedPlayers = rankPlayers(db);
  console.log("Ranked Players (Elo-Based - Minimum 8 matches required):");
  
  // Find the max length of player names for proper padding
  const maxPlayerNameLength = Math.max(10, ...rankedPlayers.map(p => p.player.name.length));
  
  // Headers
  console.log(
    "Rank".padEnd(6) +
    "Player".padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 4) +
    "Elo".padEnd(8) +
    "Wins".padEnd(6) +
    "Losses".padEnd(8) +
    "Points Won".padEnd(12) +
    "Points Played".padEnd(15) +
    "Win Rate".padEnd(10) +
    "Point Ratio"
  );
  
  console.log(
    "----".padEnd(6) +
    "-".repeat(maxPlayerNameLength + 3).padEnd(maxPlayerNameLength + 4) +
    "---".padEnd(8) +
    "----".padEnd(6) +
    "------".padEnd(8) +
    "----------".padEnd(12) +
    "-------------".padEnd(15) +
    "--------".padEnd(10) +
    "----------"
  );
  
  rankedPlayers.forEach((rankedPlayer, index) => {
    const playerName = rankedPlayer.player.name;
    const losses = calculateLosses(db, playerName);
    const totalSets = rankedPlayer.wins + losses;
    const winRate = totalSets > 0 ? (rankedPlayer.wins / totalSets * 100).toFixed(1) + '%' : '0.0%';
    const pointsPlayed = rankedPlayer.pointRatio > 0 ? Math.round(rankedPlayer.points / rankedPlayer.pointRatio) : 0;
    const pointRatio = (rankedPlayer.pointRatio * 100).toFixed(1) + '%';
    const elo = Math.round(rankedPlayer.eloRating || DEFAULT_ELO_CONFIG.initialRating);
    
    console.log(
      `${(index + 1).toString().padEnd(4)} ` +
      `${playerName.padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 4)}` +
      `${elo.toString().padEnd(8)}` +
      `${rankedPlayer.wins.toString().padEnd(6)}` +
      `${losses.toString().padEnd(8)}` +
      `${rankedPlayer.points.toString().padEnd(12)}` +
      `${pointsPlayed.toString().padEnd(15)}` +
      `${winRate.padEnd(10)}` +
      `${pointRatio}`
    );
  });
}

/**
 * Displays a simplified version of the player rankings that is easy to share in messaging apps
 */
function displaySimpleRankedPlayers(db: Low<Data>) {
  const rankedPlayers = rankPlayers(db);
  console.log("🏆 Rankings (Min. 8 matches required) 🏆");
  
  rankedPlayers.forEach((rankedPlayer, index) => {
    const playerName = rankedPlayer.player.name;
    const losses = calculateLosses(db, playerName);
    const totalSets = rankedPlayer.wins + losses;
    const winRate = totalSets > 0 ? Math.round(rankedPlayer.wins / totalSets * 100) : 0;
    
    // Calculate points lost
    const pointsLost = rankedPlayer.totalPointsPlayed - rankedPlayer.points;
    
    // Emoji for top 3 players
    let rankEmoji = "";
    if (index === 0) rankEmoji = "🥇 ";
    else if (index === 1) rankEmoji = "🥈 ";
    else if (index === 2) rankEmoji = "🥉 ";
    else rankEmoji = `${index + 1}. `;
    
    console.log(
      `${rankEmoji}${playerName}: ${rankedPlayer.wins}W-${losses}L (${winRate}%), ` +
      `${rankedPlayer.points}pts won - ${pointsLost}pts lost`
    );
  });
}

async function createSession(db: Low<Data>, id: string) {
  db.data.sessions.push({
    id,
    players: [],
    rounds: [] // Changed from sets to rounds
  });

  await db.write();
}

async function addPlayerToSession(db: Low<Data>, id: string, playerName: string) {
  const session = db.data.sessions.find(session => session.id === id);
  if (!session) {
    console.error(`Session with date ${id} not found`);
    return;
  }

  const player = db.data.players.find(player => player.name === playerName);
  if (!player) {
    console.error(`Player with name ${playerName} not found`);
    return;
  }

  session.players.push(player.name);
  await db.write();
}

async function setPointsToSet(db: Low<Data>, sessionId: string, roundId: string, setId: string, player: string, points: number) {
  const session = db.data.sessions.find(session => session.id === sessionId);
  if (!session) {
    console.error(`Session with date ${sessionId} not found`);
    return;
  }

  const round = session.rounds.find(round => round.id === roundId);
  if (!round) {
    console.error(`Round with id ${roundId} not found`);
    return;
  }

  const set = round.sets.find(set => set.id === setId);
  if (!set) {
    console.error(`Set with id ${setId} not found`);
    return;
  }

  const team = set.teams.find(team => team.team.players.some(name => name === player));
  if (!team) {
    console.error(`Team with player ${player} not found in set ${setId}`);
    return;
  }

  team.points = points;
  await db.write();
}

/**
 * Get Elo ratings for a list of players
 * For players with fewer than 8 matches, use default rating
 */
function getPlayerEloMap(db: Low<Data>): Record<string, number> {
  // Initialize with default rating for all players
  const eloMap: Record<string, number> = {};
  
  // Get player ratings from calculateEloRatings
  const eloRatings = calculateEloRatings(db);
  eloRatings.forEach((rating) => {
    eloMap[rating.name] = rating.elo;
  });
  
  // Ensure all players have a rating (default for new players)
  db.data.players.forEach(player => {
    if (eloMap[player.name] === undefined) {
      eloMap[player.name] = DEFAULT_ELO_CONFIG.initialRating;
    }
  });
  
  return eloMap;
}

export function generateRoundsCore(players: string[], maxRounds: number, numCourts: number, db?: Low<Data>, debug: boolean = false): Round[] {
  const rounds: Round[] = [];

  if (numCourts === 0) {
    console.error("Not enough players to form even one court.");
    return rounds;
  }

  // Sort players alphabetically to ensure consistent results regardless of input order
  const sortedPlayers = [...players].sort();
  
  // Get Elo ratings if database is provided
  const playerEloMap: Record<string, number> = db ? 
    getPlayerEloMap(db) : 
    // Create a map with default values if no database is provided
    sortedPlayers.reduce((map, player) => {
      map[player] = DEFAULT_ELO_CONFIG.initialRating; // Default Elo rating
      return map;
    }, {} as Record<string, number>);

  // Initialize pairing frequency trackers
  const teammateFrequency: Record<string, Record<string, number>> = {};
  const opponentFrequency: Record<string, Record<string, number>> = {};
  
  // Create a separate tracker for pairings within this session generation
  const sessionTeammateFrequency: Record<string, Record<string, number>> = {};
  const sessionOpponentFrequency: Record<string, Record<string, number>> = {};

  sortedPlayers.forEach(player => {
    teammateFrequency[player] = {};
    opponentFrequency[player] = {};
    sessionTeammateFrequency[player] = {};
    sessionOpponentFrequency[player] = {};
    sortedPlayers.forEach(otherPlayer => {
      if (player !== otherPlayer) {
        teammateFrequency[player][otherPlayer] = 0;
        opponentFrequency[player][otherPlayer] = 0;
        sessionTeammateFrequency[player][otherPlayer] = 0;
        sessionOpponentFrequency[player][otherPlayer] = 0;
      }
    });
  });

  // Dynamically calculate the maximum allowable pairing frequency
  const maxPairingFrequency = Math.ceil((maxRounds * numCourts) / (sortedPlayers.length / 2));

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const sets: KOBSet[] = [];
    let availablePlayers = [...sortedPlayers];      for (let courtIndex = 0; courtIndex < numCourts; courtIndex++) {
      if (availablePlayers.length < 4) {
        console.error("Not enough players to form a complete set on court.");
        continue;
      }
      
      if (debug) {
        console.log(`\n--- Round ${roundIndex + 1}, Court ${courtIndex + 1} ---`);
      }

      // Select players for the court dynamically to minimize pairing frequency
      const courtPlayers: string[] = [];

      // Calculate total teammate frequency for each player to make selection deterministic
      const playerFrequencies: {player: string, totalFrequency: number}[] = availablePlayers.map(player => {
        const totalFrequency = availablePlayers.reduce((sum, p) => {
          if (p === player) return sum;
          return sum + (teammateFrequency[player][p] || 0) + (opponentFrequency[player][p] || 0);
        }, 0);
        return { player, totalFrequency };
      });

      // Sort by frequency (ascending) and alphabetically (for ties) to ensure deterministic selection
      playerFrequencies.sort((a, b) => {
        if (a.totalFrequency !== b.totalFrequency) {
          return a.totalFrequency - b.totalFrequency;
        }
        // If frequencies are equal, sort alphabetically for consistent results
        return a.player.localeCompare(b.player);
      });

      // Select first player with lowest frequency
      courtPlayers.push(playerFrequencies[0].player);
      availablePlayers = availablePlayers.filter(p => p !== playerFrequencies[0].player);

      // Select the next three players, still ensuring deterministic selection
      for (let i = 0; i < 3; i++) {
        const playerScores: {player: string, score: number}[] = availablePlayers.map(player => {
          // Calculate historical pairing score
          const historicalTeammateScore = courtPlayers.reduce(
            (sum, p) => sum + (teammateFrequency[player][p] || 0), 0
          );
          const historicalOpponentScore = courtPlayers.reduce(
            (sum, p) => sum + (opponentFrequency[player][p] || 0), 0
          );
          
          // Calculate session-specific pairing score (weighted much higher)
          const sessionTeammateScore = courtPlayers.reduce(
            (sum, p) => sum + (sessionTeammateFrequency[player][p] || 0) * 100, 0
          );
          const sessionOpponentScore = courtPlayers.reduce(
            (sum, p) => sum + (sessionOpponentFrequency[player][p] || 0) * 50, 0
          );
          
          return { 
            player, 
            // Heavily weight session-specific pairings to avoid duplicates within the same session
            score: historicalTeammateScore + historicalOpponentScore + sessionTeammateScore + sessionOpponentScore
          };
        });

        // Sort by score (ascending) and alphabetically (for ties)
        playerScores.sort((a, b) => {
          if (a.score !== b.score) {
            return a.score - b.score;
          }
          return a.player.localeCompare(b.player);
        });

        // Find a player that meets our conditions:
        // 1. Doesn't exceed max pairing frequency globally
        // 2. Hasn't been paired with existing players in this session
        // 3. Hasn't faced the same opponents in this session (new stricter rule)
        
        // First try to find a player who has never faced any of the existing court players as opponents
        let eligiblePlayerIndex = playerScores.findIndex(item => {
          return courtPlayers.every(existingPlayer => {
            const globalFrequency = (teammateFrequency[item.player][existingPlayer] || 0);
            const sessTeammateFreq = (sessionTeammateFrequency[item.player][existingPlayer] || 0);
            const sessOpponentFreq = (sessionOpponentFrequency[item.player][existingPlayer] || 0);
            
            // Avoid players that have already played together in this session
            // And avoid all players who have already faced each other as opponents in this session
            return globalFrequency < maxPairingFrequency && 
                   sessTeammateFreq === 0 &&
                   sessOpponentFreq === 0; // No previous opponent pairings in this session
          });
        });
        
        // If we can't find anyone with zero opponent pairings, only then fall back to allow a single pairing
        if (eligiblePlayerIndex === -1) {
          eligiblePlayerIndex = playerScores.findIndex(item => {
            return courtPlayers.every(existingPlayer => {
              const globalFrequency = (teammateFrequency[item.player][existingPlayer] || 0);
              const sessTeammateFreq = (sessionTeammateFrequency[item.player][existingPlayer] || 0);
              const sessOpponentFreq = (sessionOpponentFrequency[item.player][existingPlayer] || 0);
              
              return globalFrequency < maxPairingFrequency && 
                     sessTeammateFreq === 0 &&
                     sessOpponentFreq <= 1; // Allow at most one opponent pairing per session
            });
          });
        }

        // Use eligible player or first player if none are eligible
        const selectedIndex = eligiblePlayerIndex !== -1 ? eligiblePlayerIndex : 0;
        const selectedPlayer = playerScores[selectedIndex].player;
        
        courtPlayers.push(selectedPlayer);
        availablePlayers = availablePlayers.filter(p => p !== selectedPlayer);
      }

      // Create balanced teams based on Elo ratings and pairing history
      // Get Elo ratings for the 4 players in this court
      const courtPlayersWithElo = courtPlayers.map(player => ({
        name: player,
        elo: playerEloMap[player] || DEFAULT_ELO_CONFIG.initialRating
      }));
      
      // Sort players by Elo rating (descending) to help with balanced team formation
      courtPlayersWithElo.sort((a, b) => b.elo - a.elo);
      
      // Calculate all possible team combinations and their balance scores
      type TeamOption = {
        team1Players: [string, string],
        team2Players: [string, string],
        eloDifference: number,         // Difference in total Elo between teams (lower is better)
        pairingScore: number,          // Combined historical teammate frequency (lower is better)
        sessionPairingScore?: number,  // Combined session-specific teammate frequency (lower is better)
        overallScore: number           // Combined score for sorting
      };
      
      const teamOptions: TeamOption[] = [];
      
      // We need to check all possible team combinations (3 possibilities with 4 players)
      const combinations = [
        {
          t1: [courtPlayersWithElo[0].name, courtPlayersWithElo[3].name], // Highest + lowest Elo
          t2: [courtPlayersWithElo[1].name, courtPlayersWithElo[2].name]  // 2nd + 3rd Elo
        },
        {
          t1: [courtPlayersWithElo[0].name, courtPlayersWithElo[2].name], 
          t2: [courtPlayersWithElo[1].name, courtPlayersWithElo[3].name]
        },
        {
          t1: [courtPlayersWithElo[0].name, courtPlayersWithElo[1].name], // Two highest Elo
          t2: [courtPlayersWithElo[2].name, courtPlayersWithElo[3].name]  // Two lowest Elo
        }
      ];
      
      combinations.forEach(combo => {
        // Calculate the historical pairing frequency score (lower is better)
        const histTeam1PairingScore = teammateFrequency[combo.t1[0]][combo.t1[1]] || 0;
        const histTeam2PairingScore = teammateFrequency[combo.t2[0]][combo.t2[1]] || 0;
        const histTotalPairingScore = histTeam1PairingScore + histTeam2PairingScore;
        
        // Calculate the session-specific pairing frequency score (lower is better)
        // This is critical for preventing duplicate pairings within the same session
        const sessTeam1PairingScore = sessionTeammateFrequency[combo.t1[0]][combo.t1[1]] || 0;
        const sessTeam2PairingScore = sessionTeammateFrequency[combo.t2[0]][combo.t2[1]] || 0;
        const sessTotalPairingScore = sessTeam1PairingScore + sessTeam2PairingScore;
        
        // Calculate opponent frequency scores for this combination (new)
        // This is critical for preventing players from facing the same opponents repeatedly
        let sessionOpponentScore = 0;
        
        // Check all potential opponent pairings in this arrangement
        combo.t1.forEach(player1 => {
          combo.t2.forEach(player2 => {
            // A higher score means these players have faced each other more often
            const pairingCount = sessionOpponentFrequency[player1][player2] || 0;
            
            // Severely penalize repeat opponent pairings (exponential penalty)
            sessionOpponentScore += Math.pow(10, pairingCount + 1);
          });
        });
        
        // Calculate the Elo balance score (lower is better)
        const team1Elo = (playerEloMap[combo.t1[0]] || DEFAULT_ELO_CONFIG.initialRating) +
                         (playerEloMap[combo.t1[1]] || DEFAULT_ELO_CONFIG.initialRating);
        
        const team2Elo = (playerEloMap[combo.t2[0]] || DEFAULT_ELO_CONFIG.initialRating) +
                         (playerEloMap[combo.t2[1]] || DEFAULT_ELO_CONFIG.initialRating);
        
        const eloDifference = Math.abs(team1Elo - team2Elo);
        
        // Calculate overall score (weighted sum of all factors)
        // Weight session pairings very heavily to prioritize avoiding duplicate pairings in the same session
        // Weight Elo difference moderately to prioritize balanced teams
        // Weight historical pairings less as they are less important for the current session
        const overallScore = 
              eloDifference * 200 +                // Stronger Elo balance weight
              histTotalPairingScore * 1 +          // Historical pairing weight
              sessTotalPairingScore * 50 +         // Session teammate pairing weight (reduced)
              sessionOpponentScore * 100;          // Session opponent pairing weight (reduced)
        
        teamOptions.push({
          team1Players: combo.t1 as [string, string],
          team2Players: combo.t2 as [string, string],
          eloDifference,
          pairingScore: histTotalPairingScore,
          sessionPairingScore: sessTotalPairingScore,
          overallScore
        });
      });
      
      // Sort by overall score (ascending) to get the most balanced team with fewest previous pairings
      teamOptions.sort((a, b) => a.overallScore - b.overallScore);
      
      // Use the best team arrangement
      const team1: Team = { 
        players: teamOptions[0].team1Players
      };
      const team2: Team = { 
        players: teamOptions[0].team2Players
      };

      // Update both historical and session-specific pairing frequencies
      team1.players.forEach(player => {
        team1.players.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate]++;
            sessionTeammateFrequency[player][teammate]++;  // Track within current session
            if (debug && roundIndex === 0) console.log(`${player} and ${teammate} are now teammates (T)`);
          }
        });
        team2.players.forEach(opponent => {
          opponentFrequency[player][opponent]++;
          sessionOpponentFrequency[player][opponent]++;    // Track within current session
          
          if (debug) {
            const newCount = sessionOpponentFrequency[player][opponent];
            if (newCount > 1) {
              console.log(`⚠️  ${player} and ${opponent} have now faced each other ${newCount} times`);
            } else {
              console.log(`${player} vs ${opponent} as opponents (O)`);
            }
          }
        });
      });

      team2.players.forEach(player => {
        team2.players.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate]++;
            sessionTeammateFrequency[player][teammate]++;  // Track within current session
            if (debug && roundIndex === 0) console.log(`${player} and ${teammate} are now teammates (T)`);
          }
        });
        team1.players.forEach(opponent => {
          // Note: We don't need to update frequencies here, as we already did in the previous loop
          // This avoids double-counting the opponent relationships
          // opponentFrequency[player][opponent]++;
          // sessionOpponentFrequency[player][opponent]++;
        });
      });

      const set: KOBSet = {
        id: `${roundIndex + 1}-${courtIndex + 1}`,
        court: courtIndex + 1,
        teams: [
          { team: team1, points: 0 },
          { team: team2, points: 0 }
        ]
      };

      sets.push(set);
    }

    const round: Round = {
      id: `round-${roundIndex + 1}`,
      sets
    };

    rounds.push(round);
  }

  return rounds;
}

async function generateRounds(db: Low<Data>, id: string, debug: boolean = false) {
  const session = db.data.sessions.find(session => session.id === id);
  if (!session) {
    console.error(`Session with date ${id} not found`);
    return;
  }

  const players = [...session.players];
  const numPlayers = players.length;
  const numCourts = Math.floor(numPlayers / 4);
  const maxRounds = 4; // 2 hours / 30 minutes per round

  console.log(`Generating rounds for session ${id}`);
  console.log(`Players: ${players.join(", ")}`);
  console.log(`Number of courts: ${numCourts}`);
  console.log(`Number of rounds: ${maxRounds}`);

  // Pass the database to use Elo ratings for balanced teams
  const rounds = generateRoundsCore(players, maxRounds, numCourts, db, debug);
  session.rounds = rounds;
  await db.write();
  
  // Analyze the generated rounds for duplicate pairings
  if (debug) {
    analyzeGeneratedRounds(rounds, players);
  }
}

function analyzeGeneratedRounds(rounds: Round[], players: string[]) {
  console.log("\n=== Analyzing Generated Rounds ===\n");
  
  // Initialize tracking
  const teammateFrequency: Record<string, Record<string, number>> = {};
  const opponentFrequency: Record<string, Record<string, number>> = {};
  
  players.forEach(player => {
    teammateFrequency[player] = {};
    opponentFrequency[player] = {};
    players.forEach(otherPlayer => {
      if (player !== otherPlayer) {
        teammateFrequency[player][otherPlayer] = 0;
        opponentFrequency[player][otherPlayer] = 0;
      }
    });
  });
  
  // Analyze rounds
  rounds.forEach((round, roundIndex) => {
    console.log(`\n--- Round ${roundIndex + 1} ---`);
    
    round.sets.forEach((set, courtIndex) => {
      const team1 = set.teams[0].team.players;
      const team2 = set.teams[1].team.players;
      
      console.log(`Court ${courtIndex + 1}: [${team1.join(", ")}] vs [${team2.join(", ")}]`);
      
      // Update statistics
      team1.forEach(player => {
        team1.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate] = (teammateFrequency[player][teammate] || 0) + 1;
          }
        });
        
        team2.forEach(opponent => {
          opponentFrequency[player][opponent] = (opponentFrequency[player][opponent] || 0) + 1;
        });
      });
      
      team2.forEach(player => {
        team2.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate] = (teammateFrequency[player][teammate] || 0) + 1;
          }
        });
      });
    });
  });
  
  // Check for problematic pairings
  console.log("\n--- Final Pairing Analysis ---");
  
  let hasProblematicTeammates = false;
  let hasProblematicOpponents = false;
  
  // Check for repeated teammates
  const processedTeammates = new Set<string>();
  players.forEach(player => {
    Object.entries(teammateFrequency[player])
      .filter(([teammate, count]) => count > 1)
      .forEach(([teammate, count]) => {
        const pairKey = [player, teammate].sort().join("-");
        if (!processedTeammates.has(pairKey)) {
          console.log(`⚠️  ${player} and ${teammate} are teammates ${count} times`);
          processedTeammates.add(pairKey);
          hasProblematicTeammates = true;
        }
      });
  });
  
  if (!hasProblematicTeammates) {
    console.log("✅ No players are teammates more than once");
  }
  
  // Check for repeated opponents
  const processedOpponents = new Set<string>();
  players.forEach(player => {
    Object.entries(opponentFrequency[player])
      .filter(([opponent, count]) => count > 2)
      .forEach(([opponent, count]) => {
        const pairKey = [player, opponent].sort().join("-");
        if (!processedOpponents.has(pairKey)) {
          console.log(`❌ ${player} and ${opponent} face each other ${count} times as opponents`);
          processedOpponents.add(pairKey);
          hasProblematicOpponents = true;
        }
      });
  });
  
  if (!hasProblematicOpponents) {
    console.log("✅ No players face each other more than twice as opponents");
  }
  
  console.log("\n=== End of Analysis ===\n");
}

function displayPairingStats(db: Low<Data>) {
  if (!db.data) {
    console.error("Database is not initialized");
    return;
  }

  const pairingStats: Record<string, { teammates: Record<string, number>, opponents: Record<string, number> }> = {};

  db.data.players.forEach(player => {
    pairingStats[player.name] = { teammates: {}, opponents: {} };
  });

  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        const team1 = set.teams[0].team.players;
        const team2 = set.teams[1].team.players;

        team1.forEach(player => {
          team1.forEach(teammate => {
            if (player !== teammate) {
              pairingStats[player].teammates[teammate] = (pairingStats[player].teammates[teammate] || 0) + 1;
            }
          });
          team2.forEach(opponent => {
            pairingStats[player].opponents[opponent] = (pairingStats[player].opponents[opponent] || 0) + 1;
          });
        });

        team2.forEach(player => {
          team2.forEach(teammate => {
            if (player !== teammate) {
              pairingStats[player].teammates[teammate] = (pairingStats[player].teammates[teammate] || 0) + 1;
            }
          });
          team1.forEach(opponent => {
            pairingStats[player].opponents[opponent] = (pairingStats[player].opponents[opponent] || 0) + 1;
          });
        });
      });
    });
  });

  console.log("Pairing Statistics:");
  Object.entries(pairingStats).forEach(([player, stats]) => {
    console.log(`Player: ${player}`);
    console.log("  Teammates:");
    Object.entries(stats.teammates).forEach(([teammate, count]) => {
      console.log(`    ${teammate}: ${count} times`);
    });
    console.log("  Opponents:");
    Object.entries(stats.opponents).forEach(([opponent, count]) => {
      console.log(`    ${opponent}: ${count} times`);
    });
  });
}

async function exportSessionToCSV(db: Low<Data>, sessionId: string, outputPath: string) {
  const session = db.data.sessions.find(session => session.id === sessionId);
  if (!session) {
    console.error(`Session with ID ${sessionId} not found`);
    return;
  }

  const rows = [['Round', 'Court', 'Team 1 Player 1', 'Team 1 Player 2', 'Team 2 Player 1', 'Team 2 Player 2', 'Points Team 1', 'Points Team 2']];

  session.rounds.forEach(round => {
    round.sets.forEach(set => {
      const team1 = set.teams[0];
      const team2 = set.teams[1];
      rows.push([
        round.id,
        set.court.toString(),
        team1.team.players[0],
        team1.team.players[1],
        team2.team.players[0],
        team2.team.players[1],
        '0',
        '0' 
      ]);
    });
  });

  const csvContent = stringify(rows);
  const fullPath = path.resolve(outputPath, `${sessionId}.csv`);
  fs.writeFileSync(fullPath, csvContent);
  console.log(`Session exported to ${fullPath}`);
}

async function importSessionFromCSV(db: Low<Data>, sessionId: string, inputPath: string) {
  const session = db.data.sessions.find(session => session.id === sessionId);
  if (!session) {
    console.error(`Session with ID ${sessionId} not found`);
    return;
  }

  const csvContent = fs.readFileSync(inputPath, 'utf-8');
  const rows = parse(csvContent, { columns: true });

  rows.forEach((row: any) => {
    const round = session.rounds.find(r => r.id === row.Round);
    if (!round) {
      console.error(`Round with ID ${row.Round} not found in session ${sessionId}`);
      return;
    }

    const set = round.sets.find(s => s.court === parseInt(row.Court));
    if (!set) {
      console.error(`Set on court ${row.Court} not found in round ${row.Round}`);
      return;
    }

    set.teams[0].points = parseInt(row['Points Team 1']);
    set.teams[1].points = parseInt(row['Points Team 2']);
  });

  await db.write();
  console.log(`Session ${sessionId} updated from ${inputPath}`);
}

/*
  Calculate the number of matches played by a player
*/
function calculateMatches(db: Low<Data>, playerName: string): number {
  let matches = 0;
  
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        // Check if the player is in this set
        const playerTeamIndex = set.teams.findIndex(teamSet => 
          teamSet.team.players.includes(playerName)
        );
        
        // If player is in this set and points have been recorded
        if (playerTeamIndex !== -1 && (set.teams[0].points > 0 || set.teams[1].points > 0)) {
          matches += 1;
        }
      });
    });
  });
  
  return matches;
}

/*
  Calculate the number of losses for a player by going through all sessions and sets
*/
function calculateLosses(db: Low<Data>, playerName: string): number {
  let losses = 0;
  
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        // Check if the player is in this set
        const playerTeamIndex = set.teams.findIndex(teamSet => 
          teamSet.team.players.includes(playerName)
        );
        
        // If player is in this set
        if (playerTeamIndex !== -1) {
          const otherTeamIndex = playerTeamIndex === 0 ? 1 : 0;
          
          // Ensure there are at least two teams and points are tracked
          if (set.teams.length > 1 && set.teams[otherTeamIndex] && 
              set.teams[playerTeamIndex].points < set.teams[otherTeamIndex].points) {
            losses += 1;
          }
        }
      });
    });
  });
  
  return losses;
}

function displayEloRankings(db: Low<Data>) {
  const eloRatings = calculateEloRatings(db);
  const enhancedRankings = calculateEnhancedRankings(eloRatings);
  
  console.log("🏆 Elo Player Rankings (Minimum 8 matches required) 🏆");
  
  // Find the max length of player names for proper padding
  const maxPlayerNameLength = Math.max(10, ...enhancedRankings.map((p: EnhancedRanking) => p.name.length));
  
  // Headers
  console.log(
    "Rank".padEnd(6) +
    "Player".padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 4) +
    "ELO".padEnd(8) +
    "W-L".padEnd(10) +
    "Win%".padEnd(8) +
    "Pts+".padEnd(8) +
    "Pts-".padEnd(8) +
    "Pt. Diff".padEnd(10) +
    "Matches"
  );
  
  console.log(
    "----".padEnd(6) +
    "-".repeat(maxPlayerNameLength + 3).padEnd(maxPlayerNameLength + 4) +
    "-----".padEnd(8) +
    "-----".padEnd(10) +
    "-----".padEnd(8) +
    "----".padEnd(8) +
    "----".padEnd(8) +
    "--------".padEnd(10) +
    "-------"
  );
  
  enhancedRankings.forEach((ranking: EnhancedRanking, index: number) => {
    const playerName = ranking.name;
    const winRate = (ranking.winRate * 100).toFixed(1) + '%';
    
    // Emoji for top 3 players
    let rankStr = "";
    if (index === 0) rankStr = "🥇 ";
    else if (index === 1) rankStr = "🥈 ";
    else if (index === 2) rankStr = "🥉 ";
    else rankStr = `${index + 1}.  `;
    
    console.log(
      `${rankStr.padEnd(4)} ` +
      `${playerName.padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 6)}` +
      `${Math.round(ranking.elo).toString().padEnd(8)}` +
      `${ranking.wins}-${ranking.losses}`.padEnd(10) +
      `${winRate.padEnd(8)}` +
      `${ranking.pointsWon.toString().padEnd(8)}` +
      `${ranking.pointsConceded.toString().padEnd(8)}` +
      `${ranking.pointDifferential > 0 ? '+' : ''}${ranking.pointDifferential.toString().padEnd(8)}` +
      `${ranking.matchesPlayed.toString()}`
    );
  });
}

/**
 * Displays a simplified version of the Elo player rankings that is easy to share in messaging apps
 */
function displaySimpleEloRankings(db: Low<Data>) {
  const eloRatings = calculateEloRatings(db);
  const enhancedRankings = calculateEnhancedRankings(eloRatings).filter(p => p.matchesPlayed >= 8);
  
  console.log("🏆 Current Player Rankings (Min. 8 matches) 🏆");
  
  enhancedRankings.forEach((ranking: EnhancedRanking, index: number) => {
    const winRate = Math.round(ranking.winRate * 100);
    
    // Emoji for top 3 players
    let rankEmoji = "";
    if (index === 0) rankEmoji = "🥇 ";
    else if (index === 1) rankEmoji = "🥈 ";
    else if (index === 2) rankEmoji = "🥉 ";
    else rankEmoji = `${index + 1}. `;
    
    console.log(
      `${rankEmoji}${ranking.name}: ${Math.round(ranking.elo)} ELO, ${ranking.wins}W-${ranking.losses}L (${winRate}%), ` +
      `${ranking.pointDifferential > 0 ? '+' : ''}${ranking.pointDifferential} pts`
    );
  });
}

/**
 * Displays detailed Elo statistics for a specific player
 */
function displayPlayerEloStats(db: Low<Data>, playerName: string) {
  // First check if the player exists and get their match count
  let matchCount = 0;
  let playerExists = false;
  
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        set.teams.forEach(teamSet => {
          if (teamSet.team.players.some(name => name.toLowerCase() === playerName.toLowerCase())) {
            playerExists = true;
            if (set.teams[0].points > 0 || set.teams[1].points > 0) {
              matchCount++;
            }
          }
        });
      });
    });
  });
  
  if (!playerExists) {
    console.error(`Player '${playerName}' not found in the database.`);
    return;
  }
  
  if (matchCount < 8) {
    console.log(`\n🏐 Player Stats: ${playerName} 🏐\n`);
    console.log(`Matches Played: ${matchCount}`);
    console.log(`Player needs at least 8 matches to receive an Elo ranking (currently has ${matchCount}).`);
    return;
  }
  
  const eloRatings = calculateEloRatings(db);
  const enhancedRankings = calculateEnhancedRankings(eloRatings);
  
  const playerRanking = enhancedRankings.find((p: EnhancedRanking) => p.name.toLowerCase() === playerName.toLowerCase());
  
  if (!playerRanking) {
    console.error(`Player '${playerName}' not found in the rankings.`);
    return;
  }
  
  const rank = enhancedRankings.findIndex((p: EnhancedRanking) => p.name === playerRanking.name) + 1;
  
  console.log(`\n🏐 Player Stats: ${playerRanking.name} 🏐\n`);
  console.log(`Current Rank: ${rank} of ${enhancedRankings.length}`);
  console.log(`Elo Rating: ${Math.round(playerRanking.elo)}`);
  console.log(`\nPerformance:`);
  console.log(`Matches Played: ${playerRanking.matchesPlayed}`);
  console.log(`Record: ${playerRanking.wins}W - ${playerRanking.losses}L (${(playerRanking.winRate * 100).toFixed(1)}%)`);
  console.log(`Points Scored: ${playerRanking.pointsWon} (${playerRanking.avgPointsPerGame.toFixed(1)} per match)`);
  console.log(`Points Conceded: ${playerRanking.pointsConceded}`);
  console.log(`Point Differential: ${playerRanking.pointDifferential > 0 ? '+' : ''}${playerRanking.pointDifferential} (${playerRanking.avgPointDiffPerGame.toFixed(1)} per match)`);
  console.log(`Consistency Rating: ${(playerRanking.consistency * 100).toFixed(1)}%`);
  
  // Add head-to-head stats
  console.log(`\nHead-to-Head Records:`);
  
  const headToHead = calculateHeadToHeadRecords(db, playerName);
  
  if (headToHead.length === 0) {
    console.log("No head-to-head records found.");
  } else {
    headToHead.sort((a, b) => b.matchesPlayed - a.matchesPlayed);
    
    headToHead.forEach(record => {
      const winRate = record.matchesPlayed > 0 ? (record.wins / record.matchesPlayed * 100).toFixed(1) : "0.0";
      console.log(
        `vs. ${record.opponent.padEnd(20)} ${record.wins}W - ${record.losses}L` +
        ` (${winRate}%) in ${record.matchesPlayed} matches, Pt Diff: ${record.pointDifferential > 0 ? '+' : ''}${record.pointDifferential}`
      );
    });
  }
}

/**
 * Head-to-head record between two players
 */
type HeadToHeadRecord = {
  opponent: string;
  wins: number;
  losses: number;
  matchesPlayed: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDifferential: number;
};

/**
 * Calculates head-to-head records for a player against all opponents
 */
function calculateHeadToHeadRecords(db: Low<Data>, playerName: string): HeadToHeadRecord[] {
  const records: Record<string, HeadToHeadRecord> = {};
  
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        if (set.teams.length !== 2) return;
        
        const team1 = set.teams[0];
        const team2 = set.teams[1];
        
        // Skip matches with no scores
        if (team1.points === 0 && team2.points === 0) return;
        
        // Find which team the player is on
        const isInTeam1 = team1.team.players.includes(playerName);
        const isInTeam2 = team2.team.players.includes(playerName);
        
        if (!isInTeam1 && !isInTeam2) return;
        
        const playerTeam = isInTeam1 ? team1 : team2;
        const opponentTeam = isInTeam1 ? team2 : team1;
        
        // Update record against each opponent
        opponentTeam.team.players.forEach(opponent => {
          if (!records[opponent]) {
            records[opponent] = {
              opponent,
              wins: 0,
              losses: 0,
              matchesPlayed: 0,
              pointsFor: 0,
              pointsAgainst: 0,
              pointDifferential: 0
            };
          }
          
          records[opponent].matchesPlayed++;
          records[opponent].pointsFor += playerTeam.points;
          records[opponent].pointsAgainst += opponentTeam.points;
          records[opponent].pointDifferential += playerTeam.points - opponentTeam.points;
          
          if (playerTeam.points > opponentTeam.points) {
            records[opponent].wins++;
          } else if (playerTeam.points < opponentTeam.points) {
            records[opponent].losses++;
          }
        });
      });
    });
  });
  
  return Object.values(records);
}

async function main() {
  const defaultData: Data = {
    players: [],
    sessions: []
  }

  const db = await JSONFilePreset<Data>('db.json', defaultData);

  const player = program.command('player');
  player.command('add')
    .argument('<name>')
    .action(async (name: string) => addPlayer(db, name));

  player.command('ranks')
    .action(async () => displayRankedPlayers(db));
    
  player.command('ranks-simple')
    .action(async () => displaySimpleRankedPlayers(db));

  player.command('elo')
    .action(async () => displayEloRankings(db));
    
  player.command('elo-simple')
    .action(async () => displaySimpleEloRankings(db));

  player.command('stats')
    .argument('<name>')
    .action(async (name: string) => displayPlayerEloStats(db, name));

  player.command('pairing-stats')
    .action(async () => displayPairingStats(db));

  const session = program.command('session');

  session.command('create')
    .argument('<date>')
    .action(async (date) => createSession(db, date));
  
  session.command('add-player')
    .argument('<date>')
    .argument('<name>')
    .action(async (date, name) => addPlayerToSession(db, date, name));

  session.command('set-points')
    .argument('<date>')
    .argument('<roundId>')
    .argument('<setId>')
    .argument('<player>')
    .argument('<points>', 'integer argument', parseInt)
    .action(async (date, roundId, setId, player, points) => setPointsToSet(db, date, roundId, setId, player, points))

  session.command('generate-rounds')
    .argument('<date>')
    .option('--debug', 'Enable debug output', false)
    .action(async (date, options) => generateRounds(db, date, options.debug));

  session.command('export-csv')
    .argument('<sessionId>')
    .argument('<outputPath>')
    .action(async (sessionId, outputPath) => exportSessionToCSV(db, sessionId, outputPath));

  session.command('import-csv')
    .argument('<sessionId>')
    .argument('<inputPath>')
    .action(async (sessionId, inputPath) => importSessionFromCSV(db, sessionId, inputPath));

  session.command('analyze')
    .argument('<sessionId>')
    .action(async (sessionId) => analyzeSession(db, sessionId));

  await program.parseAsync(process.argv);
}

main().catch((error) => console.trace(error));

/**
 * Provides a comprehensive analysis of a volleyball session
 * Analyzes team balance, pairing patterns, and statistical anomalies
 */
async function analyzeSession(db: Low<Data>, sessionId: string) {
  const session = db.data.sessions.find(session => session.id === sessionId);
  if (!session) {
    console.error(`Session with ID ${sessionId} not found`);
    return;
  }

  // Get player Elo ratings for additional information
  const playerEloMap = getPlayerEloMap(db);
  const allPlayers = session.players.sort();
  
  console.log(`\n🏐 VOLLEYBALL SESSION ANALYSIS: ${sessionId} 🏐\n`);
  console.log(`${'-'.repeat(50)}\n`);
  
  // 1. BASIC SESSION INFORMATION
  console.log(`📊 SESSION OVERVIEW:`);
  console.log(`   Total Players: ${session.players.length}`);
  console.log(`   Active Players: ${session.players.join(', ')}`);
  console.log(`   Total Rounds: ${session.rounds.length}`);
  console.log(`   Total Sets: ${session.rounds.reduce((acc, round) => acc + round.sets.length, 0)}`);
  console.log(`\n${'-'.repeat(50)}\n`);
  
  // 2. PLAYER STATISTICS
  console.log(`🏅 PLAYER ELO RATINGS:`);
  const playersByElo = [...session.players].sort((a, b) => 
    (playerEloMap[b] || DEFAULT_ELO_CONFIG.initialRating) - (playerEloMap[a] || DEFAULT_ELO_CONFIG.initialRating)
  );
  
  const maxNameLength = Math.max(...session.players.map(name => name.length));
  playersByElo.forEach(player => {
    const elo = Math.round(playerEloMap[player] || DEFAULT_ELO_CONFIG.initialRating);
    const eloTier = elo >= 1100 ? '🔥' : elo >= 950 ? '✅' : '⚠️';
    console.log(`   ${player.padEnd(maxNameLength + 2)}: ${elo} ${eloTier}`);
  });
  
  // Calculate average Elo
  const avgElo = Math.round(
    playersByElo.reduce((sum, player) => sum + (playerEloMap[player] || DEFAULT_ELO_CONFIG.initialRating), 0) / 
    playersByElo.length
  );
  console.log(`   Average Elo: ${avgElo}`);
  console.log(`\n${'-'.repeat(50)}\n`);
  
  // 3. TEAM BALANCE ANALYSIS
  console.log(`⚖️  TEAM BALANCE ANALYSIS:`);
  
  const eloDifferences: number[] = [];
  const biggestMismatch = { round: '', court: 0, diff: 0, team1: [] as string[], team2: [] as string[], elo1: 0, elo2: 0 };
  const mostBalanced = { round: '', court: 0, diff: Infinity, team1: [] as string[], team2: [] as string[], elo1: 0, elo2: 0 };
  
  session.rounds.forEach(round => {
    round.sets.forEach(set => {
      const team1 = set.teams[0];
      const team2 = set.teams[1];
      
      const team1Elo = Math.round((
        (playerEloMap[team1.team.players[0]] || DEFAULT_ELO_CONFIG.initialRating) + 
        (playerEloMap[team1.team.players[1]] || DEFAULT_ELO_CONFIG.initialRating)
      ) / 2);
      
      const team2Elo = Math.round((
        (playerEloMap[team2.team.players[0]] || DEFAULT_ELO_CONFIG.initialRating) + 
        (playerEloMap[team2.team.players[1]] || DEFAULT_ELO_CONFIG.initialRating)
      ) / 2);
      
      const eloDiff = Math.abs(team1Elo - team2Elo);
      eloDifferences.push(eloDiff);
      
      // Track biggest mismatch
      if (eloDiff > biggestMismatch.diff) {
        biggestMismatch.round = round.id;
        biggestMismatch.court = set.court;
        biggestMismatch.diff = eloDiff;
        biggestMismatch.team1 = [...team1.team.players];
        biggestMismatch.team2 = [...team2.team.players];
        biggestMismatch.elo1 = team1Elo;
        biggestMismatch.elo2 = team2Elo;
      }
      
      // Track most balanced
      if (eloDiff < mostBalanced.diff) {
        mostBalanced.round = round.id;
        mostBalanced.court = set.court;
        mostBalanced.diff = eloDiff;
        mostBalanced.team1 = [...team1.team.players];
        mostBalanced.team2 = [...team2.team.players];
        mostBalanced.elo1 = team1Elo;
        mostBalanced.elo2 = team2Elo;
      }
    });
  });
  
  const avgEloDiff = Math.round(
    eloDifferences.reduce((sum, diff) => sum + diff, 0) / 
    eloDifferences.length
  );
  
  console.log(`   Average Elo Difference: ${avgEloDiff}`);
  console.log(`   Team Balance Rating: ${avgEloDiff < 30 ? 'Excellent ⭐⭐⭐' : avgEloDiff < 50 ? 'Good ⭐⭐' : avgEloDiff < 75 ? 'Fair ⭐' : 'Poor'}`);
  
  console.log("\n   Most Balanced Match:");
  console.log(`     ${mostBalanced.round}, Court ${mostBalanced.court}: [${mostBalanced.team1.join(', ')}] (${mostBalanced.elo1} Elo) vs. [${mostBalanced.team2.join(', ')}] (${mostBalanced.elo2} Elo)`);
  console.log(`     Elo Difference: ${mostBalanced.diff}`);
  
  console.log("\n   Biggest Mismatch:");
  console.log(`     ${biggestMismatch.round}, Court ${biggestMismatch.court}: [${biggestMismatch.team1.join(', ')}] (${biggestMismatch.elo1} Elo) vs. [${biggestMismatch.team2.join(', ')}] (${biggestMismatch.elo2} Elo)`);
  console.log(`     Elo Difference: ${biggestMismatch.diff}`);
  console.log(`\n${'-'.repeat(50)}\n`);
  
  // 4. PAIRING ANALYSIS 
  console.log(`👯 PAIRING ANALYSIS:`);
  
  // Track teammate pairings and opponent frequency
  const teammateFrequency: Record<string, Record<string, number>> = {};
  const opponentFrequency: Record<string, Record<string, number>> = {};
  
  allPlayers.forEach(player => {
    teammateFrequency[player] = {};
    opponentFrequency[player] = {};
    allPlayers.forEach(otherPlayer => {
      if (player !== otherPlayer) {
        teammateFrequency[player][otherPlayer] = 0;
        opponentFrequency[player][otherPlayer] = 0;
      }
    });
  });
  
  session.rounds.forEach(round => {
    round.sets.forEach(set => {
      const team1 = set.teams[0].team.players;
      const team2 = set.teams[1].team.players;
      
      team1.forEach(player => {
        team1.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate] = (teammateFrequency[player][teammate] || 0) + 1;
          }
        });
        team2.forEach(opponent => {
          opponentFrequency[player][opponent] = (opponentFrequency[player][opponent] || 0) + 1;
          opponentFrequency[opponent][player] = (opponentFrequency[opponent][player] || 0) + 1;
        });
      });
      
      team2.forEach(player => {
        team2.forEach(teammate => {
          if (player !== teammate) {
            teammateFrequency[player][teammate] = (teammateFrequency[player][teammate] || 0) + 1;
          }
        });
      });
    });
  });
  
  // Find frequent teammates and opponents
  const repeatedTeammates: {player1: string, player2: string, count: number}[] = [];
  const processedTeammatePairs = new Set<string>();
  
  allPlayers.forEach(player => {
    Object.entries(teammateFrequency[player])
      .filter(([teammate, count]) => count > 1)
      .forEach(([teammate, count]) => {
        const pairKey = [player, teammate].sort().join('-');
        if (!processedTeammatePairs.has(pairKey)) {
          repeatedTeammates.push({player1: player, player2: teammate, count});
          processedTeammatePairs.add(pairKey);
        }
      });
  });
  
  const frequentOpponents: {player1: string, player2: string, count: number}[] = [];
  const processedOpponentPairs = new Set<string>();
  
  allPlayers.forEach(player => {
    Object.entries(opponentFrequency[player])
      .filter(([opponent, count]) => count > 2)
      .forEach(([opponent, count]) => {
        const pairKey = [player, opponent].sort().join('-');
        if (!processedOpponentPairs.has(pairKey)) {
          frequentOpponents.push({player1: player, player2: opponent, count});
          processedOpponentPairs.add(pairKey);
        }
      });
  });
  
  // Calculate pairing diversity scores
  console.log("   Teammate Variety Score:");
  const maxPossibleTeammates = allPlayers.length - 1;
  const maxPossibleScore = session.rounds.length;
  
  allPlayers.forEach(player => {
    const uniqueTeammates = Object.entries(teammateFrequency[player])
      .filter(([_, count]) => count > 0)
      .length;
    
    const teammateDiversity = Math.min(uniqueTeammates / maxPossibleTeammates, 1);
    const emoji = teammateDiversity > 0.7 ? '✅' : teammateDiversity > 0.4 ? '⚠️' : '❌';
    console.log(`     ${player.padEnd(maxNameLength + 2)}: ${Math.round(teammateDiversity * 100)}% variety ${emoji}`);
  });
  
  // Report problematic pairings
  if (repeatedTeammates.length > 0) {
    console.log("\n   Repeated Teammate Pairings:");
    repeatedTeammates
      .sort((a, b) => b.count - a.count)
      .forEach(pair => {
        console.log(`     ⚠️  ${pair.player1} and ${pair.player2} are teammates ${pair.count} times`);
      });
  } else {
    console.log("\n   ✅ No repeated teammate pairings (optimal)");
  }
  
  if (frequentOpponents.length > 0) {
    console.log("\n   Frequent Opponent Pairings:");
    frequentOpponents
      .sort((a, b) => b.count - a.count)
      .forEach(pair => {
        console.log(`     ❌ ${pair.player1} and ${pair.player2} face each other ${pair.count} times as opponents`);
      });
  } else {
    console.log("\n   ✅ No players face each other more than twice as opponents (optimal)");
  }
  
  // 5. DISPLAY SESSION ROUNDS
  console.log(`\n${'-'.repeat(50)}\n`);
  console.log(`📋 SESSION ROUNDS:`);
  
  session.rounds.forEach((round, roundIndex) => {
    console.log(`\n   --- ${round.id} ---`);
    
    round.sets.forEach(set => {
      const team1 = set.teams[0];
      const team2 = set.teams[1];
      
      const team1Elo = Math.round((
        (playerEloMap[team1.team.players[0]] || DEFAULT_ELO_CONFIG.initialRating) + 
        (playerEloMap[team1.team.players[1]] || DEFAULT_ELO_CONFIG.initialRating)
      ) / 2);
      
      const team2Elo = Math.round((
        (playerEloMap[team2.team.players[0]] || DEFAULT_ELO_CONFIG.initialRating) + 
        (playerEloMap[team2.team.players[1]] || DEFAULT_ELO_CONFIG.initialRating)
      ) / 2);
      
      const scoreDisplay = team1.points > 0 || team2.points > 0 
        ? ` | Score: ${team1.points}-${team2.points}` 
        : '';
      
      const eloDiff = Math.abs(team1Elo - team2Elo);
      const eloBalanceSymbol = eloDiff < 30 ? '✅' : eloDiff < 75 ? '⚠️' : '❌';
      
      console.log(
        `     Court ${set.court}: [${team1.team.players.join(", ")}] (${team1Elo} Elo) vs ` +
        `[${team2.team.players.join(", ")}] (${team2Elo} Elo) | Diff: ${eloDiff} ${eloBalanceSymbol}${scoreDisplay}`
      );
    });
  });
  
  // 6. OVERALL ASSESSMENT
  console.log(`\n${'-'.repeat(50)}\n`);
  console.log(`📊 OVERALL SESSION ASSESSMENT:`);
  
  // Calculate overall quality score
  const issues = [];
  if (repeatedTeammates.length > 0) issues.push("duplicate teammate pairings");
  if (frequentOpponents.length > 0) issues.push("excessive opponent pairings");
  if (avgEloDiff > 75) issues.push("large team Elo imbalances");
  
  // Overall score based on balance and pairing diversity
  const balanceScore = Math.max(0, 100 - avgEloDiff);
  const pairingScore = 100 - (repeatedTeammates.length * 15 + frequentOpponents.length * 20);
  const overallScore = Math.round((balanceScore * 0.6 + Math.max(0, pairingScore) * 0.4));
  
  // Rating based on score
  let rating = '';
  if (overallScore >= 90) rating = 'Excellent ⭐⭐⭐⭐⭐';
  else if (overallScore >= 80) rating = 'Very Good ⭐⭐⭐⭐';
  else if (overallScore >= 70) rating = 'Good ⭐⭐⭐';
  else if (overallScore >= 60) rating = 'Fair ⭐⭐';
  else if (overallScore >= 50) rating = 'Needs Improvement ⭐';
  else rating = 'Poor';
  
  console.log(`   Session Quality Score: ${overallScore}/100 - ${rating}`);
  console.log(`   Team Balance Score: ${balanceScore}/100`);
  console.log(`   Pairing Diversity Score: ${Math.max(0, pairingScore)}/100`);
  
  if (issues.length === 0) {
    console.log("\n   ✅ This session is well-balanced with optimal player pairings");
  } else {
    console.log(`\n   ⚠️  Areas for improvement: ${issues.join(", ")}`);
  }
  
  console.log(`\n${'-'.repeat(50)}\n`);
}