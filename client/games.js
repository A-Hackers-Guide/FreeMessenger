// Games played inside a chat, like iMessage games: tic-tac-toe and Connect
// Four. The game starts as a message; each move is a small control message
// that every phone applies in order, so everyone sees the same board.

export const GAMES = [["ttt", "❌⭕ Tic-tac-toe"], ["c4", "🔴🟡 Connect Four"]];

const SIZE = { ttt: [3, 3], c4: [7, 6] };

export function newGame(type, starter) {
  const [w, h] = SIZE[type];
  return { type, board: Array(w * h).fill(""), players: [starter], moves: 0, winner: "" };
}

export function clean(g) {
  if (!g || !SIZE[g.type]) return null;
  return newGame(g.type, String((g.players || [])[0] || ""));
}

// Applies a move if it's legal. Returns the new state, or null.
export function move(g, player, cell) {
  if (g.winner) return null;
  const [w, h] = SIZE[g.type];
  const players = g.players.slice();
  if (players.length < 2) {
    if (player === players[0] && g.moves % 2 === 1) return null;
    if (player !== players[0]) players.push(player);
  }
  const turn = players[g.moves % 2];
  if (player !== turn) return null;
  const board = g.board.slice();
  let i = Number(cell);
  if (!(i >= 0 && i < w * h)) return null;
  if (g.type === "c4") {
    // Drop to the lowest empty spot in that column.
    const col = i % w;
    i = -1;
    for (let r = h - 1; r >= 0; r--) if (!board[r * w + col]) { i = r * w + col; break; }
    if (i === -1) return null;
  } else if (board[i]) {
    return null;
  }
  board[i] = g.moves % 2 === 0 ? "1" : "2";
  const next = { type: g.type, board, players, moves: g.moves + 1, winner: "" };
  const win = winner(next);
  if (win) next.winner = win === "draw" ? "draw" : players[win === "1" ? 0 : 1] || "";
  return next;
}

function winner(g) {
  const [w, h] = SIZE[g.type];
  const need = g.type === "ttt" ? 3 : 4;
  const at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? g.board[y * w + x] : "");
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = at(x, y);
      if (!v) continue;
      for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let n = 1;
        while (n < need && at(x + dx * n, y + dy * n) === v) n++;
        if (n === need) return v;
      }
    }
  }
  return g.board.every(Boolean) ? "draw" : "";
}

// Draws the board into a message bubble.
export function render(g, me, name, onMove) {
  const [w] = SIZE[g.type];
  const box = document.createElement("div");
  box.className = "game game-" + g.type;
  const title = document.createElement("strong");
  title.textContent = g.type === "ttt" ? "❌⭕ Tic-tac-toe" : "🔴🟡 Connect Four";
  const grid = document.createElement("div");
  grid.className = "game-grid";
  grid.style.gridTemplateColumns = `repeat(${w}, 1fr)`;
  const mark = { ttt: { 1: "❌", 2: "⭕" }, c4: { 1: "🔴", 2: "🟡" } }[g.type];
  const turn = g.players.length < 2 ? (g.moves % 2 === 0 ? g.players[0] : null) : g.players[g.moves % 2];
  const myTurn = !g.winner && (turn === me || (turn === null && me !== g.players[0]));
  g.board.forEach((v, i) => {
    const b = document.createElement("button");
    b.className = "cell";
    b.textContent = v ? mark[v] : "";
    b.disabled = !myTurn || (g.type === "ttt" && !!v);
    b.onclick = (e) => { e.stopPropagation(); onMove(i); };
    grid.appendChild(b);
  });
  const status = document.createElement("small");
  if (g.winner === "draw") status.textContent = "It's a draw!";
  else if (g.winner) status.textContent = g.winner === me ? "🏆 You won!" : `🏆 ${name(g.winner)} won`;
  else if (myTurn) status.textContent = "Your turn";
  else status.textContent = turn ? `${name(turn)}'s turn` : "Waiting for someone to play";
  box.append(title, grid, status);
  return box;
}
