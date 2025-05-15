export {}

declare global {
  type Player = {
    name: string;
    defaultElo?: number;
  }

  type Team = {
    players: [string, string];
  }

  type TeamSet = {
    team: Team;
    points: number;
  }

  type KOBSet = {
    id: string;
    court: number;
    teams: TeamSet[];
  };

  type Round = {
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
    eloRating?: number;  // Optional Elo rating
  }
}