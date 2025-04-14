import { program } from 'commander';
import { JSONFilePreset } from 'lowdb/node';
import { Low } from 'lowdb';

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
}

async function addPlayer(db: Low<Data>, name: string) {
  const player = { name };
  db.data.players.push(player);
  await db.write();
}

/*
  Given the players in the database, ranks them by their points
*/
function rankPlayers(db: Low<Data>): RankedPlayer[] {
  if (!db.data) {
    console.error("Database is not initialized");
    return [];
  }

  const playerPoints: Record<string, number> = {};

  // Calculate total points for each player
  db.data.sessions.forEach(session => {
    session.rounds.forEach(round => {
      round.sets.forEach(set => {
        set.teams.forEach(teamSet => {
          teamSet.team.players.forEach(player => {
            if (!playerPoints[player]) {
              playerPoints[player] = 0;
            }
            playerPoints[player] += teamSet.points;
          });
        });
      });
    });
  });

  // Create a list of players with their total points
  const rankedPlayers = db.data.players.map(player => ({
    player: player,
    points: playerPoints[player.name] || 0
  }));

  // Sort players by points in descending order
  rankedPlayers.sort((a, b) => b.points - a.points);

  return rankedPlayers;
}

function displayRankedPlayers(db: Low<Data>) {
  const rankedPlayers = rankPlayers(db);
  console.log("Ranked Players:");
  rankedPlayers.forEach((rankedPlayer, index) => {
    console.log(`${index + 1}. ${rankedPlayer.player.name} - ${rankedPlayer.points} points`);
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

  await program.parseAsync(process.argv);
}

main().catch((error) => console.trace(error));