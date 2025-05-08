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

export function generateRoundsCore(players: string[], maxRounds: number, numCourts: number): Round[] {
  const rounds: Round[] = [];

  if (numCourts === 0) {
    console.error("Not enough players to form even one court.");
    return rounds;
  }

  // Initialize pairing frequency trackers
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

  // Dynamically calculate the maximum allowable pairing frequency
  const maxPairingFrequency = Math.ceil((maxRounds * numCourts) / (players.length / 2));

  for (let roundIndex = 0; roundIndex < maxRounds; roundIndex++) {
    const sets: KOBSet[] = [];
    let availablePlayers = [...players];

    for (let courtIndex = 0; courtIndex < numCourts; courtIndex++) {
      if (availablePlayers.length < 4) {
        console.error("Not enough players to form a complete set on court.");
        continue;
      }

      // Select players for the court dynamically to minimize pairing frequency
      const courtPlayers: string[] = [];

      // Select the first player based on lowest frequency with available players
      availablePlayers.sort((a, b) => {
        const aFrequency = availablePlayers.reduce((sum, p) => sum + (teammateFrequency[a][p] || 0), 0);
        const bFrequency = availablePlayers.reduce((sum, p) => sum + (teammateFrequency[b][p] || 0), 0);
        return aFrequency - bFrequency;
      });
      courtPlayers.push(availablePlayers.shift()!);

      // Select the next three players to minimize both teammate and opponent frequency
      for (let i = 0; i < 3; i++) {
        availablePlayers.sort((a, b) => {
          const aTeammateFrequency = courtPlayers.reduce((sum, p) => sum + (teammateFrequency[a][p] || 0), 0);
          const bTeammateFrequency = courtPlayers.reduce((sum, p) => sum + (teammateFrequency[b][p] || 0), 0);
          const aOpponentFrequency = courtPlayers.reduce((sum, p) => sum + (opponentFrequency[a][p] || 0), 0);
          const bOpponentFrequency = courtPlayers.reduce((sum, p) => sum + (opponentFrequency[b][p] || 0), 0);
          return (aTeammateFrequency + aOpponentFrequency) - (bTeammateFrequency + bOpponentFrequency);
        });

        // Ensure players are not paired more than the calculated maximum frequency
        const selectedPlayer = availablePlayers.find(player => {
          return courtPlayers.every(existingPlayer => (teammateFrequency[player][existingPlayer] || 0) < maxPairingFrequency);
        }) || availablePlayers[0];

        courtPlayers.push(selectedPlayer);
        availablePlayers = availablePlayers.filter(p => p !== selectedPlayer);
      }

      const team1: Team = { players: [courtPlayers[0], courtPlayers[1]] };
      const team2: Team = { players: [courtPlayers[2], courtPlayers[3]] };

      // Update pairing frequencies
      team1.players.forEach(player => {
        team1.players.forEach(teammate => {
          if (player !== teammate) teammateFrequency[player][teammate]++;
        });
        team2.players.forEach(opponent => {
          opponentFrequency[player][opponent]++;
        });
      });

      team2.players.forEach(player => {
        team2.players.forEach(teammate => {
          if (player !== teammate) teammateFrequency[player][teammate]++;
        });
        team1.players.forEach(opponent => {
          opponentFrequency[player][opponent]++;
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

async function generateRounds(db: Low<Data>, id: string) {
  const session = db.data.sessions.find(session => session.id === id);
  if (!session) {
    console.error(`Session with date ${id} not found`);
    return;
  }

  const players = [...session.players];
  const numPlayers = players.length;
  const numCourts = Math.floor(numPlayers / 4);
  const maxRounds = 4; // 2 hours / 30 minutes per round

  const rounds = generateRoundsCore(players, maxRounds, numCourts);
  session.rounds = rounds;
  await db.write();
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
  const enhancedRankings = calculateEnhancedRankings(eloRatings);
  
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
    .action(async (date) => generateRounds(db, date));

  session.command('export-csv')
    .argument('<sessionId>')
    .argument('<outputPath>')
    .action(async (sessionId, outputPath) => exportSessionToCSV(db, sessionId, outputPath));

  session.command('import-csv')
    .argument('<sessionId>')
    .argument('<inputPath>')
    .action(async (sessionId, inputPath) => importSessionFromCSV(db, sessionId, inputPath));

  await program.parseAsync(process.argv);
}

main().catch((error) => console.trace(error));