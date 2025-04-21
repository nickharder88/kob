import { program } from 'commander';
import { JSONFilePreset } from 'lowdb/node';
import { Low } from 'lowdb';
import fs from 'fs';
import path from 'path';
import { stringify } from 'csv-stringify/sync';
import { parse } from 'csv-parse/sync';

type Player = {
  name: string;
}

type Team = {
  players: [string, string];
}

export type TeamSet = {
  team: Team;
  points: number;
}

export type KOBSet = {
  id: string;
  court: number;
  teams: TeamSet[];
};

export type Round = {
  id: string;
  sets: KOBSet[];
}

type Session = {
  id: string;
  players: string[];
  rounds: Round[]; // Changed from sets to rounds
}

type Data = {
  players: Player[];
  sessions: Session[];
}

type RankedPlayer = {
  player: Player;
  points: number;
  wins: number;
  pointRatio: number;
  totalPointsPlayed: number;
}

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
      pointRatio: stats.totalPointsPlayed > 0 ? stats.points / stats.totalPointsPlayed : 0
    };
  });

  // Sort players: first by wins, then by point ratio for ties
  rankedPlayers.sort((a, b) => {
    // First sort by wins
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
  console.log("Ranked Players:");
  
  // Find the max length of player names for proper padding
  const maxPlayerNameLength = Math.max(10, ...rankedPlayers.map(p => p.player.name.length));
  
  // Headers
  console.log(
    "Rank".padEnd(6) +
    "Player".padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 4) +
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
    
    console.log(
      `${(index + 1).toString().padEnd(4)} ` +
      `${playerName.padStart(maxPlayerNameLength + 2).padEnd(maxPlayerNameLength + 4)}` +
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
  console.log("🏆 Rankings 🏆");
  
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