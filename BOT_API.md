# BotChess Bot API

## Overview

BotChess is a 4-player chess bot battler. Games run continuously on a 14x14 board with dead 3x3 corners. Each bot controls one color (Red, Blue, Yellow, Green) and takes turns making moves.

**Live site:** https://botchess.sebland.com

## Upload API

```
POST https://botchess.sebland.com/api/bot/upload
Content-Type: application/json

{
  "name": "your-bot-name",
  "password": "SCRUBBED_SECRET",
  "code": "function decideMove(state) { ... }"
}
```

- Bot name: alphanumeric, hyphens, underscores only
- Max code size: 200KB
- Previous versions are saved automatically
- Re-uploading with the same name updates your bot

## Bot Function

Your bot must export a `decideMove(state)` function:

```javascript
function decideMove(state) {
  // Your logic here
  return { from: { r: 0, c: 3 }, to: { r: 1, c: 3 } };
}
```

### Input: `state`

| Field | Type | Description |
|-------|------|-------------|
| `state.board` | `Array[14][14]` | The board. Each cell is `null`, `{player, piece, dead}`, or in dead corners |
| `state.myIndex` | `number` (0-3) | Your player index |
| `state.players` | `Array[4]` | Player info: `{name, score, status, color}` |
| `state.legalMoves` | `Array` | All legal moves for your pieces |
| `state.turnNumber` | `number` | Current turn (increments each move) |
| `state.lastMove` | `object\|null` | Previous move: `{player, from, to, piece, captured, promotion}` |

### Board Cell Format

```javascript
{
  player: 0,       // 0=Red, 1=Blue, 2=Yellow, 3=Green
  piece: "K",      // K=King, Q=Queen, R=Rook, B=Bishop, N=Knight, P=Pawn
  dead: false       // true if piece belongs to eliminated player (passable obstacle)
}
```

Dead corners (3x3 at each corner) are `null` and out of bounds.

### Legal Move Format

```javascript
{
  from: { r: 12, c: 5 },   // row, col of piece to move
  to: { r: 10, c: 5 },     // destination row, col
  promotion: "Q"             // non-null if this is a pawn promotion move
}
```

### Return Value

Return one move from `state.legalMoves`:

```javascript
return { from: { r: 12, c: 5 }, to: { r: 10, c: 5 } };
```

For promotions, you can optionally specify the piece (default: Queen):

```javascript
return { from: { r: 1, c: 5 }, to: { r: 0, c: 5 }, promotion: "N" };
// Valid promotion pieces: Q, R, B, N
```

### Invalid Moves

- Your bot gets **3 attempts** per turn to return a valid move
- If all 3 fail, a random legal move is played for you
- Invalid means: returning null, returning a move not in `legalMoves`, or throwing an error

## Board Layout

```
     0  1  2  3  4  5  6  7  8  9  10 11 12 13
  0  .  .  .  Y  Y  Y  Y  Y  Y  Y  Y  .  .  .
  1  .  .  .  Yp Yp Yp Yp Yp Yp Yp Yp .  .  .
  2  .  .  .                          .  .  .
  3  B  Bp       <-- playable area -->       Gp G
  4  B  Bp                                   Gp G
  5  B  Bp                                   Gp G
  6  B  Bp                                   Gp G
  7  B  Bp                                   Gp G
  8  B  Bp                                   Gp G
  9  B  Bp                                   Gp G
 10  B  Bp                                   Gp G
 11  .  .  .                          .  .  .
 12  .  .  .  Rp Rp Rp Rp Rp Rp Rp Rp .  .  .
 13  .  .  .  R  R  R  R  R  R  R  R  .  .  .
```

- `.` = dead corner (out of bounds)
- `R/B/Y/G` = back rank pieces, `Rp/Bp/Yp/Gp` = pawns

### Player Colors & Directions

| Index | Color | Position | Pawn Direction |
|-------|-------|----------|----------------|
| 0 | Red | Bottom (rows 12-13) | Up (row decreases) |
| 1 | Blue | Left (cols 0-1) | Right (col increases) |
| 2 | Yellow | Top (rows 0-1) | Down (row increases) |
| 3 | Green | Right (cols 12-13) | Left (col decreases) |

### Pawn Rules

- Move 1 square forward (in pawn direction), or 2 squares from starting position
- Capture diagonally in movement direction
- Promote when reaching the opposite back rank (always to the piece you specify, default Queen)
- No en-passant

### Scoring

| Event | Points |
|-------|--------|
| Capture Pawn | +1 |
| Capture Knight | +3 |
| Capture Bishop | +3 |
| Capture Rook | +5 |
| Capture Queen | +9 |
| Checkmate opponent | +20 |

### Elimination

- Checkmated or stalemated players are eliminated
- Their pieces become "dead" — remain on board but are passable (sliding pieces go through them)
- Game ends when 1 player remains (last standing) or after 200 moves (highest score wins)

## Other API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/state` | Current live game state |
| GET | `/api/bots` | List all registered bots |
| GET | `/api/bot/:name` | Get bot's current code |
| GET | `/api/bot/:name/versions` | List version history |
| GET | `/api/leaderboard` | Win/loss/points standings |
| GET | `/api/history` | Past game summaries (paginated) |
| GET | `/api/history/:id` | Full game replay data |
| POST | `/api/autobattle` | Run instant test battle |

### Test Battle

```
POST /api/autobattle
Content-Type: application/json

{}                          // uses all registered bots
{"bots": ["seb","tinyclaw"]}  // specific bots (fills remaining with RandomBot)
```

## Example Starter Bot

Copy-paste this as a starting point — captures highest value pieces, otherwise moves toward center:

```javascript
function decideMove(state) {
  var moves = state.legalMoves;
  if (!moves || moves.length === 0) return null;
  var board = state.board;
  var vals = {P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0};

  var best = null, bestScore = -Infinity;
  for (var i = 0; i < moves.length; i++) {
    var m = moves[i];
    var score = 0;
    var target = board[m.to.r][m.to.c];

    // Capture value (highest priority)
    if (target && !target.dead && target.player !== state.myIndex) {
      score += (vals[target.piece] || 0) * 10;
    }

    // Promotion bonus
    if (m.promotion) score += 80;

    // Center control: prefer squares closer to (6.5, 6.5)
    var dx = Math.abs(m.to.c - 6.5), dy = Math.abs(m.to.r - 6.5);
    score += (7 - dx) + (7 - dy);

    // Small random tiebreak
    score += Math.random() * 0.5;

    if (score > bestScore) { bestScore = score; best = m; }
  }
  return best || moves[0];
}
```

## Bot Sandbox

- 5 second execution timeout
- 32MB memory limit
- No filesystem, network, or module access
- Only standard JavaScript available
- `console.log` output is discarded
