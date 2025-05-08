
### Generation

This is for a league, where there is a number of players in the league. The league is some number of sessions.

Each session, this tool generates sets based on the available players.

In a session, a subset of the players in the league will play, based on their availability.

Based on this number of players, there will be some number of courts. Players / 4

Each court can have one set played on it at a time.

A round consists of the available courts and the sets being played on it.

Each set is played by 4 people, 2 per team.

Assume each round takes 30 minutes. We play for 2 hours. So we assume we can get in 4 rounds per session. If there are 12 players, then there can be 3 courts, and 3 * 4 = 12 sets played in the session.

What are the characteristics of a good session?
- Minimize the time the players play on the same team as other players
- Minimize the time the players play against the same players

What is the result that we need?
- Each court has two teams

### TODO
- In elo, account for how good your partner is too
- Add recency to elo score

### Database
A JSON file containing relevant information

### Export to CSV
After generation, will want to export to CSV for visibility

### Import from CSV
The previously generated CSV will need to be imported and update the database