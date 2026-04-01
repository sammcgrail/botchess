var express = require("express");
var http = require("http");
var WebSocket = require("ws");
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");
var child_process = require("child_process");
var Database = require("better-sqlite3");

var app = express();
var server = http.createServer(app);
var wss = new WebSocket.Server({ noServer: true });

var PORT = 20007;
var BOARD_SIZE = 14;
var MAX_MOVES = 500;
var BOT_TIMEOUT_MS = 5000;
var MAX_HISTORY = 50;
var DB_PATH = process.env.BOTCHESS_DB || path.join(__dirname, "data", "botchess.db");
var BOTS_DIR = path.join(__dirname, "data", "bots");
var BOTS_VERSIONS_DIR = path.join(__dirname, "data", "bots_versions");
var UPLOAD_PASSWORD = process.env.BOT_UPLOAD_PASSWORD;
if (!UPLOAD_PASSWORD) { console.error("FATAL: BOT_UPLOAD_PASSWORD env var is required"); process.exit(1); }

var PLAYER_COLORS = ["red", "blue", "yellow", "green"];
var PLAYER_NAMES = ["Red", "Blue", "Yellow", "Green"];

// Piece values for scoring
var PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };

// Pawn directions (toward center)
// Red (player 0, bottom row 13): moves up (dr=-1)
// Blue (player 1, left col 0): moves right (dc=+1)
// Yellow (player 2, top row 0): moves down (dr=+1)
// Green (player 3, right col 13): moves left (dc=-1)
var PAWN_DIR = [
  { dr: -1, dc: 0 },  // Red: up
  { dr: 0, dc: 1 },   // Blue: right
  { dr: 1, dc: 0 },   // Yellow: down
  { dr: 0, dc: -1 }   // Green: left
];

// Starting rows for pawns (used for 2-square first move)
var PAWN_START = [12, -1, 1, -1]; // row for Red/Yellow, col for Blue/Green
var PAWN_START_COL = [-1, 1, -1, 12]; // col for Blue/Green

// Promotion rank
// Red promotes at row 0 area (row <= 2 for cols 3-10, but really row 0 for the 8th rank idea)
// Actually: 8th rank = after moving 6 squares from start pawn row
// Red starts row 12, promotes at row 5 (12-7=5)... let's simplify:
// "8th rank" in 4-player chess = the row/col 7 squares from start
// Red pawns start row 12, promote when reaching row 5 or beyond toward row 0
// But standard 4-player chess: promote at the far side
// Let's use: promote when reaching the opposite back rank area
// Red (bottom): promotes at row 0 (cols 3-10)
// Blue (left): promotes at col 13 (rows 3-10)
// Yellow (top): promotes at row 13 (cols 3-10)
// Green (right): promotes at col 0 (rows 3-10)

function uuid() { return crypto.randomUUID(); }

// Dead corners: 3x3 squares at each corner of the 14x14 board
function isDead(r, c) {
  if (r < 3 && c < 3) return true;
  if (r < 3 && c > 10) return true;
  if (r > 10 && c < 3) return true;
  if (r > 10 && c > 10) return true;
  return false;
}

function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE && !isDead(r, c);
}

// Create initial board
function createBoard() {
  var board = [];
  for (var r = 0; r < BOARD_SIZE; r++) {
    var row = [];
    for (var c = 0; c < BOARD_SIZE; c++) {
      row.push(null);
    }
    board.push(row);
  }

  // Yellow (player 2, top): back rank row 0 cols 3-10, pawns row 1 cols 3-10
  var yellowBack = ["R","N","B","K","Q","B","N","R"];
  for (var i = 0; i < 8; i++) {
    board[0][3 + i] = { player: 2, piece: yellowBack[i], dead: false };
    board[1][3 + i] = { player: 2, piece: "P", dead: false };
  }

  // Red (player 0, bottom): back rank row 13 cols 3-10, pawns row 12 cols 3-10
  var redBack = ["R","N","B","Q","K","B","N","R"];
  for (var i = 0; i < 8; i++) {
    board[13][3 + i] = { player: 0, piece: redBack[i], dead: false };
    board[12][3 + i] = { player: 0, piece: "P", dead: false };
  }

  // Blue (player 1, left): back rank col 0 rows 3-10, pawns col 1 rows 3-10
  var blueBack = ["R","N","B","K","Q","B","N","R"];
  for (var i = 0; i < 8; i++) {
    board[3 + i][0] = { player: 1, piece: blueBack[i], dead: false };
    board[3 + i][1] = { player: 1, piece: "P", dead: false };
  }

  // Green (player 3, right): back rank col 13 rows 3-10, pawns col 12 rows 3-10
  var greenBack = ["R","N","B","Q","K","Q","B","N","R"];
  // Wait — the spec says Green back rank: R,N,B,Q,K,Q,B,N,R — that's 9 pieces for 8 squares
  // This seems like a typo. The spec says: (R,N,B,Q,K,Q,B,N,R) — let's use 8: R,N,B,Q,K,B,N,R
  var greenBackFixed = ["R","N","B","Q","K","B","N","R"];
  for (var i = 0; i < 8; i++) {
    board[3 + i][13] = { player: 3, piece: greenBackFixed[i], dead: false };
    board[3 + i][12] = { player: 3, piece: "P", dead: false };
  }

  return board;
}

// Deep clone board
function cloneBoard(board) {
  var nb = [];
  for (var r = 0; r < BOARD_SIZE; r++) {
    var row = [];
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = board[r][c];
      row.push(cell ? { player: cell.player, piece: cell.piece, dead: cell.dead } : null);
    }
    nb.push(row);
  }
  return nb;
}

// Find king position for a player
function findKing(board, player) {
  for (var r = 0; r < BOARD_SIZE; r++) {
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = board[r][c];
      if (cell && cell.player === player && cell.piece === "K" && !cell.dead) {
        return { r: r, c: c };
      }
    }
  }
  return null;
}

// Check if a square is attacked by any alive opponent of 'player'
function isSquareAttacked(board, r, c, player) {
  for (var p = 0; p < 4; p++) {
    if (p === player) continue;
    if (isPlayerDead(board, p)) continue;
    if (canPlayerAttackSquare(board, p, r, c)) return true;
  }
  return false;
}

function isPlayerDead(board, player) {
  // A player is dead if their king is dead or missing
  var king = findKing(board, player);
  return !king;
}

// Check if player p can attack square (tr, tc)
function canPlayerAttackSquare(board, p, tr, tc) {
  for (var r = 0; r < BOARD_SIZE; r++) {
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = board[r][c];
      if (!cell || cell.player !== p || cell.dead) continue;
      if (canPieceAttack(board, r, c, tr, tc, cell)) return true;
    }
  }
  return false;
}

// Can piece at (fr, fc) attack square (tr, tc)?
// This is attack only — not full move legality (no check filtering)
function canPieceAttack(board, fr, fc, tr, tc, cell) {
  var dr = tr - fr, dc = tc - fc;
  var adr = Math.abs(dr), adc = Math.abs(dc);

  switch (cell.piece) {
    case "P":
      return canPawnAttack(fr, fc, tr, tc, cell.player);
    case "N":
      return (adr === 2 && adc === 1) || (adr === 1 && adc === 2);
    case "B":
      return adr === adc && adr > 0 && isSlideClear(board, fr, fc, tr, tc);
    case "R":
      return (dr === 0 || dc === 0) && (adr + adc > 0) && isSlideClear(board, fr, fc, tr, tc);
    case "Q":
      return ((adr === adc && adr > 0) || ((dr === 0 || dc === 0) && (adr + adc > 0))) && isSlideClear(board, fr, fc, tr, tc);
    case "K":
      return adr <= 1 && adc <= 1 && (adr + adc > 0);
  }
  return false;
}

function canPawnAttack(fr, fc, tr, tc, player) {
  var dir = PAWN_DIR[player];
  // Pawns attack diagonally in their movement direction
  if (dir.dr !== 0) {
    // Vertical mover (Red, Yellow): attacks are (dir.dr, +1) and (dir.dr, -1)
    return (tr - fr === dir.dr) && (Math.abs(tc - fc) === 1);
  } else {
    // Horizontal mover (Blue, Green): attacks are (+1, dir.dc) and (-1, dir.dc)
    return (tc - fc === dir.dc) && (Math.abs(tr - fr) === 1);
  }
}

function isSlideClear(board, fr, fc, tr, tc) {
  var dr = Math.sign(tr - fr);
  var dc = Math.sign(tc - fc);
  var r = fr + dr, c = fc + dc;
  while (r !== tr || c !== tc) {
    if (!inBounds(r, c)) return false;
    var cell = board[r][c];
    if (cell && !cell.dead) return false; // blocked by alive piece only — dead pieces are passable
    r += dr;
    c += dc;
  }
  return true;
}

// Is player in check?
function isInCheck(board, player) {
  var king = findKing(board, player);
  if (!king) return false;
  return isSquareAttacked(board, king.r, king.c, player);
}

// Get promotion check for a pawn move
function getPromotion(player, tr, tc) {
  switch (player) {
    case 0: return tr === 0 ? "Q" : null; // Red promotes at top
    case 1: return tc === 13 ? "Q" : null; // Blue promotes at right
    case 2: return tr === 13 ? "Q" : null; // Yellow promotes at bottom
    case 3: return tc === 0 ? "Q" : null; // Green promotes at left
  }
  return null;
}

// Get pawn starting row/col to determine if 2-square move is allowed
function isPawnOnStartingSquare(player, r, c) {
  switch (player) {
    case 0: return r === 12 && c >= 3 && c <= 10; // Red
    case 1: return c === 1 && r >= 3 && r <= 10;  // Blue
    case 2: return r === 1 && c >= 3 && c <= 10;  // Yellow
    case 3: return c === 12 && r >= 3 && r <= 10; // Green
  }
  return false;
}

// Generate all pseudo-legal moves for a player (before check filtering)
function getPseudoLegalMoves(board, player) {
  var moves = [];
  for (var r = 0; r < BOARD_SIZE; r++) {
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = board[r][c];
      if (!cell || cell.player !== player || cell.dead) continue;
      var pieceMoves = getPieceMoves(board, r, c, cell, player);
      for (var i = 0; i < pieceMoves.length; i++) {
        var m = pieceMoves[i];
        // Kings can never be captured — skip moves targeting a king
        var target = board[m.to.r][m.to.c];
        if (target && target.piece === "K" && !target.dead) continue;
        moves.push(m);
      }
    }
  }
  return moves;
}

function getPieceMoves(board, r, c, cell, player) {
  switch (cell.piece) {
    case "P": return getPawnMoves(board, r, c, player);
    case "N": return getKnightMoves(board, r, c, player);
    case "B": return getSlideMoves(board, r, c, player, [[1,1],[1,-1],[-1,1],[-1,-1]]);
    case "R": return getSlideMoves(board, r, c, player, [[1,0],[-1,0],[0,1],[0,-1]]);
    case "Q": return getSlideMoves(board, r, c, player, [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]);
    case "K": return getKingMoves(board, r, c, player);
  }
  return [];
}

function getPawnMoves(board, r, c, player) {
  var moves = [];
  var dir = PAWN_DIR[player];

  // Forward 1
  var nr = r + dir.dr, nc = c + dir.dc;
  if (inBounds(nr, nc) && !board[nr][nc]) {
    var promo = getPromotion(player, nr, nc);
    moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: promo });

    // Forward 2 from starting position
    if (isPawnOnStartingSquare(player, r, c)) {
      var nr2 = nr + dir.dr, nc2 = nc + dir.dc;
      if (inBounds(nr2, nc2) && !board[nr2][nc2]) {
        moves.push({ from: { r: r, c: c }, to: { r: nr2, c: nc2 }, promotion: null });
      }
    }
  }

  // Diagonal captures
  var captureDirs;
  if (dir.dr !== 0) {
    // Vertical mover: capture diagonals are (dr, +1) and (dr, -1)
    captureDirs = [{ dr: dir.dr, dc: 1 }, { dr: dir.dr, dc: -1 }];
  } else {
    // Horizontal mover: capture diagonals are (+1, dc) and (-1, dc)
    captureDirs = [{ dr: 1, dc: dir.dc }, { dr: -1, dc: dir.dc }];
  }

  for (var i = 0; i < captureDirs.length; i++) {
    var cr = r + captureDirs[i].dr, cc = c + captureDirs[i].dc;
    if (inBounds(cr, cc)) {
      var target = board[cr][cc];
      if (target && target.player !== player && !target.dead) {
        var promo = getPromotion(player, cr, cc);
        moves.push({ from: { r: r, c: c }, to: { r: cr, c: cc }, promotion: promo });
      }
    }
  }

  return moves;
}

function getKnightMoves(board, r, c, player) {
  var moves = [];
  var offsets = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
  for (var i = 0; i < offsets.length; i++) {
    var nr = r + offsets[i][0], nc = c + offsets[i][1];
    if (!inBounds(nr, nc)) continue;
    var target = board[nr][nc];
    if (!target) {
      moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
    } else if (target.player !== player && !target.dead) {
      moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
    }
  }
  return moves;
}

function getSlideMoves(board, r, c, player, directions) {
  var moves = [];
  for (var d = 0; d < directions.length; d++) {
    var dr = directions[d][0], dc = directions[d][1];
    var nr = r + dr, nc = c + dc;
    while (inBounds(nr, nc)) {
      var target = board[nr][nc];
      if (target && target.dead) {
        // Dead piece — slide through but can't stop here (pieces remain on board)
        nr += dr;
        nc += dc;
        continue;
      }
      if (!target) {
        // Empty square — can move here
        moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
      } else if (target.player !== player) {
        moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
        break; // Can capture but can't go further
      } else {
        break; // Own alive piece blocks
      }
      nr += dr;
      nc += dc;
    }
  }
  return moves;
}

function getKingMoves(board, r, c, player) {
  var moves = [];
  for (var dr = -1; dr <= 1; dr++) {
    for (var dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      var nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc)) continue;
      var target = board[nr][nc];
      if (!target) {
        moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
      } else if (target.player !== player && !target.dead) {
        moves.push({ from: { r: r, c: c }, to: { r: nr, c: nc }, promotion: null });
      }
    }
  }
  return moves;
}

// Get legal moves (filtered for check)
function getLegalMoves(board, player) {
  var pseudo = getPseudoLegalMoves(board, player);
  var legal = [];
  for (var i = 0; i < pseudo.length; i++) {
    var move = pseudo[i];
    // Simulate the move
    var testBoard = cloneBoard(board);
    executeMoveSilent(testBoard, move, player);
    if (!isInCheck(testBoard, player)) {
      legal.push(move);
    }
  }
  return legal;
}

// Execute a move on a board (no side effects, just board mutation)
function executeMoveSilent(board, move, player) {
  var piece = board[move.from.r][move.from.c];
  board[move.from.r][move.from.c] = null;
  if (move.promotion) {
    board[move.to.r][move.to.c] = { player: player, piece: move.promotion, dead: false };
  } else {
    board[move.to.r][move.to.c] = { player: piece.player, piece: piece.piece, dead: false };
  }
}

// --- Game State ---

var game = null;
var botMemory = {};  // per-bot-name persistent memory within a game

function createGame(playerNames) {
  return {
    board: createBoard(),
    players: playerNames.map(function(name, i) {
      return {
        name: name,
        color: PLAYER_COLORS[i],
        score: 0,
        status: "alive" // alive, checkmated, stalemated
      };
    }),
    currentPlayer: Math.floor(Math.random() * 4),
    turnNumber: 0,
    moveHistory: [],
    lastMove: null,
    status: "in_progress",
    winner: null,
    winReason: null,
    positionCounts: [{}, {}, {}, {}] // per-player move repetition tracking
  };
}

function getNextAlivePlayer(g, current) {
  for (var i = 1; i <= 4; i++) {
    var next = (current + i) % 4;
    if (g.players[next].status === "alive") return next;
  }
  return -1;
}

function countAlivePlayers(g) {
  var count = 0;
  for (var i = 0; i < 4; i++) {
    if (g.players[i].status === "alive") count++;
  }
  return count;
}

// Eliminate a player — mark all their pieces as dead
function eliminatePlayer(g, player, reason) {
  g.players[player].status = reason; // "checkmated" or "stalemated"
  for (var r = 0; r < BOARD_SIZE; r++) {
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = g.board[r][c];
      if (cell && cell.player === player) {
        cell.dead = true;
      }
    }
  }
}

// Execute a move in the game, return result info
function executeGameMove(g, move) {
  var player = g.currentPlayer;
  var captured = null;
  var target = g.board[move.to.r][move.to.c];

  if (target && target.player !== player && !target.dead) {
    captured = { player: target.player, piece: target.piece };
    g.players[player].score += PIECE_VALUES[target.piece] || 0;
    // Safety: if a king was captured (should not happen with legal move filtering),
    // eliminate that player immediately
    if (target.piece === "K") {
      eliminatePlayer(g, target.player, "checkmated");
    }
  }

  var piece = g.board[move.from.r][move.from.c];
  g.board[move.from.r][move.from.c] = null;

  if (move.promotion) {
    g.board[move.to.r][move.to.c] = { player: player, piece: move.promotion, dead: false };
  } else {
    g.board[move.to.r][move.to.c] = { player: piece.player, piece: piece.piece, dead: false };
  }

  g.turnNumber++;
  g.lastMove = {
    player: player,
    from: { r: move.from.r, c: move.from.c },
    to: { r: move.to.r, c: move.to.c },
    piece: piece.piece,
    captured: captured,
    promotion: move.promotion || null
  };
  g.moveHistory.push(g.lastMove);

  // Check for checkmate/stalemate of all alive opponents
  for (var p = 0; p < 4; p++) {
    if (p === player || g.players[p].status !== "alive") continue;
    var opponentMoves = getLegalMoves(g.board, p);
    if (opponentMoves.length === 0) {
      if (isInCheck(g.board, p)) {
        // Checkmate
        eliminatePlayer(g, p, "checkmated");
        g.players[player].score += 20;
      } else {
        // Stalemate — player is eliminated
        eliminatePlayer(g, p, "stalemated");
      }
    }
  }

  // Check game end conditions
  var alive = countAlivePlayers(g);
  if (alive <= 1) {
    g.status = "finished";
    // Find the last alive player
    for (var i = 0; i < 4; i++) {
      if (g.players[i].status === "alive") {
        g.winner = i;
        break;
      }
    }
    g.winReason = "last_standing";
  } else if (g.turnNumber >= MAX_MOVES) {
    g.status = "finished";
    // Winner by score
    var maxScore = -1, maxPlayer = 0;
    for (var i = 0; i < 4; i++) {
      if (g.players[i].status === "alive" && g.players[i].score > maxScore) {
        maxScore = g.players[i].score;
        maxPlayer = i;
      }
    }
    g.winner = maxPlayer;
    g.winReason = "move_limit";
  }

  if (g.status === "in_progress") {
    g.currentPlayer = getNextAlivePlayer(g, player);
  }

  return {
    move: g.lastMove,
    captured: captured,
    eliminated: null // filled in by caller if needed
  };
}

// --- SQLite Database ---

var db;
function initDB() {
  var dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS games (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS leaderboard (name TEXT PRIMARY KEY, wins INTEGER DEFAULT 0, points INTEGER DEFAULT 0, games INTEGER DEFAULT 0, last_win TEXT)");
}
initDB();

function loadLeaderboard() {
  try {
    return db.prepare("SELECT name, wins, points, games, last_win FROM leaderboard ORDER BY wins DESC, points DESC").all();
  } catch (e) { return []; }
}

function updateLeaderboard(players, winnerIdx) {
  var now = new Date().toISOString();
  var upsert = db.prepare(
    "INSERT INTO leaderboard (name, wins, points, games, last_win) VALUES (?, ?, ?, 1, ?) " +
    "ON CONFLICT(name) DO UPDATE SET wins = wins + ?, points = points + ?, games = games + 1, last_win = CASE WHEN ? > 0 THEN ? ELSE last_win END"
  );
  for (var i = 0; i < players.length; i++) {
    // Skip RandomBots from leaderboard
    if (/^RandomBot/i.test(players[i].name)) continue;
    var isWinner = (i === winnerIdx) ? 1 : 0;
    upsert.run(
      players[i].name, isWinner, players[i].score, isWinner ? now : null,
      isWinner, players[i].score, isWinner, now
    );
  }
}

// --- Bot File Management ---

if (!fs.existsSync(BOTS_DIR)) fs.mkdirSync(BOTS_DIR, { recursive: true });
if (!fs.existsSync(BOTS_VERSIONS_DIR)) fs.mkdirSync(BOTS_VERSIONS_DIR, { recursive: true });

function listBots() {
  try {
    var files = fs.readdirSync(BOTS_DIR).filter(function(f) { return f.endsWith(".js"); });
    return files.map(function(f) {
      var name = f.replace(/\.js$/, "");
      var code = fs.readFileSync(path.join(BOTS_DIR, f), "utf8");
      var stat = fs.statSync(path.join(BOTS_DIR, f));
      var versions = listBotVersions(name);
      return { name: name, code: code, updated: stat.mtime.toISOString(), size: code.length, versions: versions.length };
    });
  } catch (e) { return []; }
}

function getBot(name) {
  var filePath = path.join(BOTS_DIR, name + ".js");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) { return null; }
}

function listBotVersions(name) {
  var botDir = path.join(BOTS_VERSIONS_DIR, name);
  if (!fs.existsSync(botDir)) return [];
  try {
    var files = fs.readdirSync(botDir).filter(function(f) { return f.endsWith(".js"); });
    return files.map(function(f) {
      var ver = f.replace(/\.js$/, "");
      var stat = fs.statSync(path.join(botDir, f));
      var code = fs.readFileSync(path.join(botDir, f), "utf8");
      return { version: ver, date: stat.mtime.toISOString(), size: code.length };
    }).sort(function(a, b) { return b.version.localeCompare(a.version); });
  } catch (e) { return []; }
}

function getBotVersion(name, version) {
  var filePath = path.join(BOTS_VERSIONS_DIR, name, version + ".js");
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) { return null; }
}

function saveBot(name, code) {
  var currentCode = getBot(name);
  if (currentCode) {
    var botDir = path.join(BOTS_VERSIONS_DIR, name);
    if (!fs.existsSync(botDir)) fs.mkdirSync(botDir, { recursive: true });
    var ts = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    fs.writeFileSync(path.join(botDir, ts + ".js"), currentCode);
  }
  var filePath = path.join(BOTS_DIR, name + ".js");
  fs.writeFileSync(filePath, code);
}

// Default bot: random legal move
var DEFAULT_BOT_CODE = 'function decideMove(state) {\n  if (!state.legalMoves || state.legalMoves.length === 0) return null;\n  var idx = Math.floor(Math.random() * state.legalMoves.length);\n  return state.legalMoves[idx];\n}';

// Run a bot in subprocess — returns move, updates botMemory
function runBot(name, gameState, overrideCode) {
  var code = overrideCode || getBot(name) || DEFAULT_BOT_CODE;
  try {
    var input = JSON.stringify({ code: code, state: gameState });
    var result = child_process.execFileSync(
      process.execPath,
      [
        "--max-old-space-size=32", "--no-warnings",
        path.join(__dirname, "bot-runner.js")
      ],
      {
        input: input,
        timeout: BOT_TIMEOUT_MS,
        maxBuffer: 1024 * 128,
        stdio: ["pipe", "pipe", "pipe"],
        env: {}
      }
    );
    try {
      var parsed = JSON.parse(result.toString());
      if (parsed && typeof parsed === "object" && parsed.move && parsed.move.from && parsed.move.to) {
        // New format: { move, memory }
        if (parsed.memory && typeof parsed.memory === "object") {
          botMemory[name] = parsed.memory;
        }
        return parsed.move;
      }
      // Legacy format or null
      if (parsed && typeof parsed === "object" && parsed.from && parsed.to) return parsed;
      return null;
    } catch (e) { return null; }
  } catch (e) {
    console.error("Bot " + name + " error:", e.message);
    return null;
  }
}

// Build bot state for a given game and player
function buildBotState(g, playerIndex) {
  var legalMoves = getLegalMoves(g.board, playerIndex);
  // Build this player's move history from the full game history
  var myMoves = [];
  for (var i = 0; i < g.moveHistory.length; i++) {
    if (g.moveHistory[i].player === playerIndex) {
      var mh = g.moveHistory[i];
      myMoves.push({ from: mh.from, to: mh.to, piece: mh.piece, captured: mh.captured, promotion: mh.promotion });
    }
  }
  return {
    board: g.board,
    myIndex: playerIndex,
    players: g.players.map(function(p, i) {
      return { name: p.name, score: p.score, status: p.status, color: p.color };
    }),
    legalMoves: legalMoves,
    turnNumber: g.turnNumber,
    lastMove: g.lastMove,
    myMoveHistory: myMoves,
    memory: botMemory[g.players[playerIndex].name] || {}
  };
}

// Validate a bot's returned move against legal moves
function validateBotMove(move, legalMoves) {
  if (!move || !move.from || !move.to) return null;
  for (var i = 0; i < legalMoves.length; i++) {
    var lm = legalMoves[i];
    if (lm.from.r === move.from.r && lm.from.c === move.from.c &&
        lm.to.r === move.to.r && lm.to.c === move.to.c) {
      // If this is a promotion move and bot specified a piece, use it
      if (lm.promotion && move.promotion && /^[QRBN]$/.test(move.promotion)) {
        lm = JSON.parse(JSON.stringify(lm));
        lm.promotion = move.promotion;
      }
      return lm;
    }
  }
  return null;
}

// --- WebSocket ---

function broadcast(message) {
  var msg = JSON.stringify(message);
  wss.clients.forEach(function(client) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

server.on("upgrade", function(request, socket, head) {
  wss.handleUpgrade(request, socket, head, function(ws) {
    wss.emit("connection", ws, request);
  });
});

wss.on("connection", function(ws) {
  if (game) {
    ws.send(JSON.stringify({
      type: "state",
      board: game.board,
      players: getPlayersWithMeta ? getPlayersWithMeta(game) : game.players,
      currentPlayer: game.currentPlayer,
      turnNumber: game.turnNumber,
      lastMove: game.lastMove,
      status: game.status,
      winner: game.winner,
      winReason: game.winReason
    }));
  }
});

function getPublicState(g) {
  if (!g) return null;
  return {
    board: g.board,
    players: g.players,
    currentPlayer: g.currentPlayer,
    turnNumber: g.turnNumber,
    lastMove: g.lastMove,
    status: g.status,
    winner: g.winner,
    winReason: g.winReason
  };
}

// --- REST API ---

app.use(express.json({ limit: "500kb" }));
app.use(express.static(__dirname));

app.get("/api/state", function(req, res) {
  res.json(getPublicState(game));
});

app.get("/api/bots", function(req, res) {
  res.set("Cache-Control", "no-cache, no-store");
  var bots = listBots();
  res.json(bots.map(function(b) {
    return { name: b.name, updated: b.updated, size: b.size, versions: b.versions };
  }));
});

app.post("/api/bot/upload", function(req, res) {
  var name = req.body.name;
  var code = req.body.code;
  var password = req.body.password;

  if (password !== UPLOAD_PASSWORD) return res.status(403).json({ error: "Invalid password" });
  if (!name || !code) return res.status(400).json({ error: "name and code are required" });
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: "Invalid bot name (alphanumeric, hyphens, underscores only)" });
  if (code.length > 200000) return res.status(400).json({ error: "Bot code too large (max 200KB)" });

  // Syntax check
  try {
    child_process.execFileSync(
      process.execPath,
      ["-e", "new Function(" + JSON.stringify(code) + ")"],
      { timeout: 2000, stdio: ["pipe", "pipe", "pipe"], env: {} }
    );
  } catch (e) {
    var stderr = e.stderr ? e.stderr.toString().split("\n")[0] : e.message;
    return res.status(400).json({ error: "Syntax error in bot code: " + stderr });
  }

  saveBot(name, code);
  var versions = listBotVersions(name);
  broadcast({ type: "bot_updated", name: name, versions: versions.length });
  res.json({ ok: true, name: name, size: code.length });
});

app.get("/api/bot/:name", function(req, res) {
  var code = getBot(req.params.name);
  if (!code) return res.status(404).json({ error: "Bot not found" });
  res.json({ name: req.params.name, code: code });
});

app.get("/api/bot/:name/versions", function(req, res) {
  var versions = listBotVersions(req.params.name);
  res.json({ name: req.params.name, versions: versions });
});

app.delete("/api/bot/:name", function(req, res) {
  var name = req.params.name;
  var password = req.body && req.body.password;
  if (password !== UPLOAD_PASSWORD) return res.status(403).json({ error: "Invalid password" });
  var botPath = path.join(BOTS_DIR, name + ".js");
  var versionsPath = path.join(BOTS_VERSIONS_DIR, name);
  if (!fs.existsSync(botPath)) return res.status(404).json({ error: "Bot not found" });
  try {
    fs.unlinkSync(botPath);
    if (fs.existsSync(versionsPath)) fs.rmSync(versionsPath, { recursive: true });
    // Remove from leaderboard
    try { db.prepare("DELETE FROM leaderboard WHERE name = ?").run(name); } catch(e) {}
    broadcast({ type: "bot_updated", name: name, versions: 0 });
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.status(500).json({ error: "Failed to delete: " + e.message });
  }
});

app.get("/api/bot/:name/version/:ver", function(req, res) {
  var code = getBotVersion(req.params.name, req.params.ver);
  if (!code) return res.status(404).json({ error: "Version not found" });
  res.json({ name: req.params.name, version: req.params.ver, code: code });
});

app.get("/api/history", function(req, res) {
  var limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 50);
  var offset = Math.max(parseInt(req.query.offset) || 0, 0);
  var totalRow = db.prepare("SELECT COUNT(*) as total FROM games").get();
  var total = totalRow ? totalRow.total : 0;
  var rows;
  try {
    rows = db.prepare("SELECT data FROM games ORDER BY date DESC LIMIT ? OFFSET ?").all(limit, offset);
  } catch (e) { rows = []; }
  var summary = rows.map(function(r) {
    var g = JSON.parse(r.data);
    var winnerPlayer = g.players && g.players[g.winner];
    return {
      id: g.id,
      date: g.date ? new Date(g.date).toLocaleString() : "",
      players: g.players,
      winner: g.winner_name || (winnerPlayer ? winnerPlayer.name : "Unknown"),
      winnerColor: winnerPlayer ? winnerPlayer.color : "red",
      reason: g.reason,
      moves: g.totalMoves || 0
    };
  });
  res.json(summary);
});

app.get("/api/history/:id", function(req, res) {
  var row = db.prepare("SELECT data FROM games WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "Game not found" });
  res.json(JSON.parse(row.data));
});

app.get("/api/leaderboard", function(req, res) {
  res.json(loadLeaderboard());
});

// --- Continuous Game Loop ---

var MOVE_DELAY_MS = 200;    // 0.2s between moves — if slower, the bot is thinking
var GAME_DELAY_MS = 8000;   // 8 seconds between games
var gameLoopRunning = false;
var gameLoopBotCodes = {};   // snapshot of bot codes for current game

function getMoveNotation(move) {
  if (!move) return "";
  var cols = "abcdefghijklmn";
  var piece = move.piece || "";
  var from = cols[move.from.c] + (14 - move.from.r);
  var to = cols[move.to.c] + (14 - move.to.r);
  var cap = move.captured ? "x" : "-";
  var promo = move.promotion ? "=" + move.promotion : "";
  return (piece === "P" ? "" : piece) + from + cap + to + promo;
}

function countPlayerPieces(board, player) {
  var count = 0;
  for (var r = 0; r < BOARD_SIZE; r++) {
    for (var c = 0; c < BOARD_SIZE; c++) {
      var cell = board[r][c];
      if (cell && cell.player === player && !cell.dead) count++;
    }
  }
  return count;
}

function getPlayersWithMeta(g) {
  return g.players.map(function(p, i) {
    return {
      name: p.name,
      color: p.color,
      score: p.score,
      status: p.status,
      piecesLeft: countPlayerPieces(g.board, i),
      isCurrentTurn: g.status === "in_progress" && g.currentPlayer === i
    };
  });
}

function startGameLoop() {
  if (gameLoopRunning) return;
  gameLoopRunning = true;
  console.log("Game loop started");
  startNewGame();
}

function startNewGame() {
  // Gather bots
  var bots = listBots();
  var botNames = bots.map(function(b) { return b.name; });

  // Shuffle
  for (var si = botNames.length - 1; si > 0; si--) {
    var sj = Math.floor(Math.random() * (si + 1));
    var tmp = botNames[si]; botNames[si] = botNames[sj]; botNames[sj] = tmp;
  }

  var allBotNames = [];
  gameLoopBotCodes = {};
  botMemory = {};  // reset memory for new game

  for (var i = 0; i < 4; i++) {
    if (i < botNames.length) {
      allBotNames.push(botNames[i]);
      gameLoopBotCodes[botNames[i]] = getBot(botNames[i]) || DEFAULT_BOT_CODE;
    } else {
      var rname = "RandomBot_" + (i + 1);
      allBotNames.push(rname);
      gameLoopBotCodes[rname] = DEFAULT_BOT_CODE;
    }
  }

  game = createGame(allBotNames);
  // Store initial board snapshot for replay
  game.boardSnapshots = [cloneBoard(game.board)];
  game.playerSnapshots = [getPlayersWithMeta(game)];

  console.log("[" + new Date().toISOString() + "] New game started: " + allBotNames.join(" vs "));

  broadcast({
    type: "new_game",
    board: game.board,
    players: getPlayersWithMeta(game),
    status: "in_progress"
  });

  // Schedule first move
  setTimeout(playNextMove, MOVE_DELAY_MS);
}

function playNextMove() {
  if (!game || game.status !== "in_progress") return;

  var cp = game.currentPlayer;

  // Skip dead players
  if (game.players[cp].status !== "alive") {
    game.currentPlayer = getNextAlivePlayer(game, cp);
    if (game.currentPlayer === -1) {
      finishCurrentGame();
      return;
    }
    setTimeout(playNextMove, 100);
    return;
  }

  var botState = buildBotState(game, cp);

  if (botState.legalMoves.length === 0) {
    // Player has no legal moves — eliminate them
    if (isInCheck(game.board, cp)) {
      eliminatePlayer(game, cp, "checkmated");
      // Award checkmate points to the player(s) giving check
    } else {
      eliminatePlayer(game, cp, "stalemated");
    }

    var alive = countAlivePlayers(game);
    if (alive <= 1) {
      finishCurrentGame();
      return;
    }

    game.currentPlayer = getNextAlivePlayer(game, cp);
    if (game.currentPlayer === -1) {
      finishCurrentGame();
      return;
    }
    setTimeout(playNextMove, 100);
    return;
  }

  // Run bot with 3-attempt invalid move policy
  var botName = game.players[cp].name;
  var validMove = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    var botMove = runBot(botName, botState, gameLoopBotCodes[botName]);
    validMove = validateBotMove(botMove, botState.legalMoves);
    if (validMove) break;
    console.log(botName + " invalid move (attempt " + (attempt + 1) + "/3):", JSON.stringify(botMove));
  }

  if (!validMove) {
    console.log(botName + " failed 3 times — random fallback");
    var idx = Math.floor(Math.random() * botState.legalMoves.length);
    validMove = botState.legalMoves[idx];
  }

  executeGameMove(game, validMove);

  // Repetition detection: track per-player move keys (from-to pairs)
  // 5 repetitions of the same move = elimination (bots get myMoveHistory to avoid this)
  var moveKey = validMove.from.r + "," + validMove.from.c + "-" + validMove.to.r + "," + validMove.to.c;
  var counts = game.positionCounts[cp];
  counts[moveKey] = (counts[moveKey] || 0) + 1;
  if (counts[moveKey] >= 5 && game.status === "in_progress") {
    console.log("[" + new Date().toISOString() + "] " + botName + " eliminated for repetition (move " + moveKey + " played " + counts[moveKey] + " times)");
    eliminatePlayer(game, cp, "repetition");
    var alive = countAlivePlayers(game);
    if (alive <= 1) {
      for (var fi = 0; fi < 4; fi++) {
        if (game.players[fi].status === "alive") { game.winner = fi; break; }
      }
      game.status = "finished";
      game.winReason = "last_standing";
    }
  }

  // Store board snapshot for replay
  game.boardSnapshots.push(cloneBoard(game.board));
  game.playerSnapshots.push(getPlayersWithMeta(game));

  var notation = getMoveNotation(game.lastMove);
  var playersWithMeta = getPlayersWithMeta(game);

  // Broadcast the move
  broadcast({
    type: "move",
    board: game.board,
    players: playersWithMeta,
    from: game.lastMove.from,
    to: game.lastMove.to,
    notation: notation,
    turnNumber: game.turnNumber,
    status: game.status
  });

  // Check if game is over
  if (game.status === "finished") {
    finishCurrentGame();
    return;
  }

  // Schedule next move
  setTimeout(playNextMove, MOVE_DELAY_MS);
}

function finishCurrentGame() {
  // Guard against double calls
  if (game.gameFinished) {
    console.log("[" + new Date().toISOString() + "] WARNING: finishCurrentGame called twice, ignoring");
    return;
  }
  game.gameFinished = true;

  // Handle move limit
  if (game.status === "in_progress") {
    game.status = "finished";
    var maxScore = -1, maxPlayer = 0;
    for (var i = 0; i < 4; i++) {
      if (game.players[i].status === "alive" && game.players[i].score > maxScore) {
        maxScore = game.players[i].score;
        maxPlayer = i;
      }
    }
    game.winner = maxPlayer;
    game.winReason = "move_limit";
  }

  var winnerName = game.players[game.winner] ? game.players[game.winner].name : "Unknown";
  var playerSummary = game.players.map(function(p, i) { return p.name + "(" + p.color + "):" + p.score + "pts/" + p.status; }).join(", ");
  console.log("[" + new Date().toISOString() + "] Game finished: " + winnerName + " wins (" + game.winReason + ", " + game.turnNumber + " moves) | " + playerSummary);

  // Build replay-ready move history with board snapshots
  var replayMoves = [];
  for (var i = 0; i < game.moveHistory.length; i++) {
    var m = game.moveHistory[i];
    replayMoves.push({
      player: m.player,
      piece: m.piece,
      from: m.from,
      to: m.to,
      captured: m.captured,
      promotion: m.promotion,
      notation: getMoveNotation(m),
      board: game.boardSnapshots[i + 1],
      players: game.playerSnapshots[i + 1]
    });
  }

  // Save to DB
  var entry = {
    id: uuid(),
    date: new Date().toISOString(),
    players: game.players.map(function(p, i) {
      return { name: p.name, color: p.color, score: p.score, status: p.status };
    }),
    winner: game.winner,
    winner_name: winnerName,
    reason: game.winReason,
    totalMoves: game.turnNumber,
    initialBoard: game.boardSnapshots[0],
    moves: replayMoves
  };

  try {
    db.prepare("INSERT INTO games (id, date, data) VALUES (?, ?, ?)").run(entry.id, entry.date, JSON.stringify(entry));
    db.prepare("DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY date DESC LIMIT ?)").run(MAX_HISTORY);
  } catch (e) { console.error("Failed to save game:", e.message); }

  updateLeaderboard(game.players, game.winner);

  broadcast({
    type: "game_over",
    winner: winnerName,
    winner_index: game.winner,
    reason: game.winReason,
    players: getPlayersWithMeta(game),
    game_id: entry.id
  });

  // Start next game after delay
  setTimeout(startNewGame, GAME_DELAY_MS);
}

// Manual autobattle — runs async in chunks to avoid blocking the event loop
var autobattleRunning = false;
app.post("/api/autobattle", function(req, res) {
  if (autobattleRunning) {
    return res.status(429).json({ error: "Autobattle already running, please wait" });
  }

  var botNames = req.body.bots;
  var overrides = req.body.overrides || {};

  if (!botNames) {
    botNames = listBots().map(function(b) { return b.name; });
  }

  var allBotNames = [];
  var allBotCodes = [];

  if (botNames.length === 0) {
    for (var i = 0; i < 4; i++) {
      allBotNames.push("RandomBot_" + (i + 1));
      allBotCodes.push(DEFAULT_BOT_CODE);
    }
  } else {
    for (var i = 0; i < botNames.length; i++) {
      if (!overrides[botNames[i]] && !getBot(botNames[i])) {
        return res.status(400).json({ error: "Bot not found: " + botNames[i] });
      }
    }
    var shuffled = botNames.slice();
    for (var si = shuffled.length - 1; si > 0; si--) {
      var sj = Math.floor(Math.random() * (si + 1));
      var tmp = shuffled[si]; shuffled[si] = shuffled[sj]; shuffled[sj] = tmp;
    }
    for (var i = 0; i < 4; i++) {
      if (i < shuffled.length) {
        allBotNames.push(shuffled[i]);
        allBotCodes.push(overrides[shuffled[i]] || getBot(shuffled[i]) || DEFAULT_BOT_CODE);
      } else {
        allBotNames.push("RandomBot_" + (i + 1));
        allBotCodes.push(DEFAULT_BOT_CODE);
      }
    }
  }

  autobattleRunning = true;
  var g = createGame(allBotNames);
  var gameId = uuid();
  var savedMemory = botMemory;
  botMemory = {};  // fresh memory for autobattle

  // Run async — yield event loop between moves
  function runNextMove() {
    if (g.status !== "in_progress" || g.turnNumber >= MAX_MOVES) {
      finishAutobattle();
      return;
    }
    var cp = g.currentPlayer;
    if (g.players[cp].status !== "alive") {
      g.currentPlayer = getNextAlivePlayer(g, cp);
      if (g.currentPlayer === -1) { finishAutobattle(); return; }
      setImmediate(runNextMove);
      return;
    }
    var botState = buildBotState(g, cp);
    if (botState.legalMoves.length === 0) {
      // Player has no legal moves — eliminate them
      if (isInCheck(g.board, cp)) {
        eliminatePlayer(g, cp, "checkmated");
      } else {
        eliminatePlayer(g, cp, "stalemated");
      }
      var alive = countAlivePlayers(g);
      if (alive <= 1) {
        g.status = "finished";
        for (var wi = 0; wi < 4; wi++) {
          if (g.players[wi].status === "alive") { g.winner = wi; break; }
        }
        g.winReason = "last_standing";
        finishAutobattle();
        return;
      }
      g.currentPlayer = getNextAlivePlayer(g, cp);
      setImmediate(runNextMove);
      return;
    }
    var validMove = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      var botMove = runBot(allBotNames[cp], botState, allBotCodes[cp]);
      validMove = validateBotMove(botMove, botState.legalMoves);
      if (validMove) break;
    }
    if (!validMove) {
      var idx = Math.floor(Math.random() * botState.legalMoves.length);
      validMove = botState.legalMoves[idx];
    }
    executeGameMove(g, validMove);
    setImmediate(runNextMove);
  }

  function finishAutobattle() {
    if (g.status === "in_progress") {
      g.status = "finished";
      var maxScore = -1, maxPlayer = 0;
      for (var i = 0; i < 4; i++) {
        if (g.players[i].status === "alive" && g.players[i].score > maxScore) {
          maxScore = g.players[i].score;
          maxPlayer = i;
        }
      }
      g.winner = maxPlayer;
      g.winReason = "move_limit";
    }
    var entry = {
      id: gameId,
      date: new Date().toISOString(),
      players: g.players.map(function(p) {
        return { name: p.name, color: p.color, score: p.score, status: p.status };
      }),
      winner: g.winner,
      winner_name: g.players[g.winner].name,
      reason: g.winReason,
      totalMoves: g.turnNumber,
      moves: g.moveHistory
    };
    try {
      db.prepare("INSERT INTO games (id, date, data) VALUES (?, ?, ?)").run(entry.id, entry.date, JSON.stringify(entry));
      db.prepare("DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY date DESC LIMIT ?)").run(MAX_HISTORY);
    } catch (e) { console.error("Failed to save autobattle:", e.message); }
    updateLeaderboard(g.players, g.winner);
    autobattleRunning = false;
    botMemory = savedMemory;  // restore live game memory

    // Broadcast result
    broadcast({ type: "game_over", winner: entry.winner_name, reason: entry.reason, players: getPlayersWithMeta(g), game_id: entry.id });
  }

  // Respond immediately, run in background
  res.json({ message: "Autobattle started", game_id: gameId, bots: allBotNames });
  setImmediate(runNextMove);
});

// --- Start ---

server.listen(PORT, function() {
  console.log("BotChess 4-player server running on port " + PORT);
  // Start the continuous game loop
  setTimeout(startGameLoop, 2000);
});
