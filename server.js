const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ─── CONSTANTS ───────────────────────────────────────────────────
const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const START_BALANCE = 5000;
const REBUY_AMOUNT = 1000;
const DEALER_STAND = 17;

// ─── STATE ───────────────────────────────────────────────────────
const lobbies = {}; // code -> lobby

// ─── DECK UTILS ──────────────────────────────────────────────────
function buildDeck(numDecks = 6) {
  const d = [];
  for (let n = 0; n < numDecks; n++)
    for (const s of SUITS)
      for (const r of RANKS)
        d.push({ r, s });
  return shuffle(d);
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cardValue(r) {
  if (['J', 'Q', 'K'].includes(r)) return 10;
  if (r === 'A') return 11;
  return parseInt(r);
}

function handValue(hand) {
  let total = 0, aces = 0;
  for (const c of hand) { total += cardValue(c.r); if (c.r === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function drawCard(lobby) {
  if (lobby.deck.length < 30) lobby.deck = buildDeck(6);
  return lobby.deck.pop();
}

// ─── LOBBY HELPERS ────────────────────────────────────────────────
function makeLobby(hostId) {
  return {
    code: null,
    hostId,
    players: {},   // socketId -> playerState
    order: [],     // socketId[]
    deck: buildDeck(6),
    dealerHand: [],
    phase: 'waiting', // waiting | betting | playing | dealer | done
    currentTurn: null,
    turnTimer: null,
  };
}

function makePlayer(name) {
  return {
    name,
    balance: START_BALANCE,
    hand: [],
    bet: 0,
    ready: false,
    status: 'waiting', // waiting | ready | playing | stood | bust | done
    doubledDown: false,
  };
}

function lobbyPublicState(lobby) {
  const players = {};
  for (const [id, p] of Object.entries(lobby.players)) {
    players[id] = {
      name: p.name,
      balance: p.balance,
      hand: p.hand,
      bet: p.bet,
      ready: p.ready,
      status: p.status,
    };
  }
  return {
    code: lobby.code,
    phase: lobby.phase,
    order: lobby.order,
    currentTurn: lobby.currentTurn,
    dealerHand: lobby.dealerHand,
    dealerHandHidden: lobby.phase === 'playing'
      ? [lobby.dealerHand[0], { r: '?', s: '?' }]
      : lobby.dealerHand,
    players,
    deckSize: lobby.deck.length,
  };
}

function broadcast(lobby) {
  const state = lobbyPublicState(lobby);
  for (const id of lobby.order) {
    io.to(id).emit('state', { ...state, myId: id });
  }
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

// ─── GAME FLOW ────────────────────────────────────────────────────
function startRound(lobby) {
  lobby.phase = 'playing';
  lobby.dealerHand = [drawCard(lobby), drawCard(lobby)];

  for (const id of lobby.order) {
    const p = lobby.players[id];
    p.hand = [drawCard(lobby), drawCard(lobby)];
    p.status = 'playing';
    p.doubledDown = false;
  }

  // check instant blackjacks
  for (const id of lobby.order) {
    const p = lobby.players[id];
    if (handValue(p.hand) === 21) p.status = 'stood';
  }

  broadcast(lobby);
  advanceTurn(lobby);
}

function advanceTurn(lobby) {
  clearTimeout(lobby.turnTimer);
  const remaining = lobby.order.filter(id => lobby.players[id].status === 'playing');
  if (remaining.length === 0) {
    runDealer(lobby);
    return;
  }
  lobby.currentTurn = remaining[0];
  broadcast(lobby);

  // auto-stand after 30s
  lobby.turnTimer = setTimeout(() => {
    const p = lobby.players[lobby.currentTurn];
    if (p && p.status === 'playing') {
      p.status = 'stood';
      advanceTurn(lobby);
    }
  }, 30000);
}

function runDealer(lobby) {
  lobby.phase = 'dealer';
  lobby.currentTurn = null;
  broadcast(lobby);

  const tick = () => {
    const dv = handValue(lobby.dealerHand);
    if (dv < DEALER_STAND) {
      lobby.dealerHand.push(drawCard(lobby));
      broadcast(lobby);
      setTimeout(tick, 800);
    } else {
      resolveRound(lobby);
    }
  };
  setTimeout(tick, 900);
}

function resolveRound(lobby) {
  lobby.phase = 'done';
  const dv = handValue(lobby.dealerHand);
  const dBJ = dv === 21 && lobby.dealerHand.length === 2;

  const results = {};
  for (const [id, p] of Object.entries(lobby.players)) {
    const pv = handValue(p.hand);
    const pBJ = pv === 21 && p.hand.length === 2;
    let outcome, payout = 0;

    if (pv > 21) {
      outcome = 'bust';
    } else if (pBJ && !dBJ) {
      outcome = 'blackjack';
      payout = Math.floor(p.bet * 2.5);
    } else if (dBJ && !pBJ) {
      outcome = 'lose';
    } else if (dv > 21 || pv > dv) {
      outcome = 'win';
      payout = p.bet * 2;
    } else if (pv === dv) {
      outcome = 'push';
      payout = p.bet;
    } else {
      outcome = 'lose';
    }

    p.balance += payout;
    if (p.balance <= 0) p.balance = REBUY_AMOUNT;
    p.status = 'done';
    results[id] = { outcome, payout, net: payout - p.bet, pv, dv };
  }

  broadcast(lobby);
  io.to(lobby.order[0]).emit('round_results', results);
  for (const id of lobby.order) io.to(id).emit('round_results', results);

  // reset for next round after 6s
  setTimeout(() => {
    lobby.phase = 'betting';
    lobby.dealerHand = [];
    for (const p of Object.values(lobby.players)) {
      p.hand = [];
      p.bet = 0;
      p.ready = false;
      p.status = 'waiting';
    }
    broadcast(lobby);
  }, 6000);
}

function checkAllReady(lobby) {
  const players = Object.values(lobby.players);
  if (players.length === 0) return;
  if (players.every(p => p.ready)) {
    startRound(lobby);
  }
}

// ─── SOCKET HANDLERS ─────────────────────────────────────────────
io.on('connection', socket => {
  let myLobbyCode = null;

  socket.on('create_lobby', ({ name }) => {
    let code;
    do { code = generateCode(); } while (lobbies[code]);
    const lobby = makeLobby(socket.id);
    lobby.code = code;
    lobbies[code] = lobby;
    myLobbyCode = code;

    lobby.players[socket.id] = makePlayer(name || 'Player');
    lobby.order.push(socket.id);
    lobby.phase = 'betting';

    socket.join(code);
    socket.emit('lobby_created', { code });
    broadcast(lobby);
  });

  socket.on('join_lobby', ({ code, name }) => {
    const lobby = lobbies[code];
    if (!lobby) { socket.emit('error', 'Lobby not found'); return; }
    if (lobby.phase !== 'betting' && lobby.phase !== 'waiting') { socket.emit('error', 'Game already started'); return; }
    if (lobby.order.length >= 5) { socket.emit('error', 'Lobby full'); return; }

    myLobbyCode = code;
    lobby.players[socket.id] = makePlayer(name || 'Player');
    lobby.order.push(socket.id);

    socket.join(code);
    socket.emit('lobby_joined', { code });
    broadcast(lobby);
  });

  socket.on('place_bet', ({ amount }) => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby || lobby.phase !== 'betting') return;
    const p = lobby.players[socket.id];
    if (!p || p.ready) return;
    const amt = Math.max(0, Math.min(amount, p.balance));
    p.bet = amt;
    broadcast(lobby);
  });

  socket.on('set_ready', ({ bet }) => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby || lobby.phase !== 'betting') return;
    const p = lobby.players[socket.id];
    if (!p || p.ready) return;
    if (bet <= 0 || bet > p.balance) return;
    p.bet = bet;
    p.balance -= bet;
    p.ready = true;
    p.status = 'ready';
    broadcast(lobby);
    checkAllReady(lobby);
  });

  socket.on('hit', () => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby || lobby.phase !== 'playing') return;
    if (lobby.currentTurn !== socket.id) return;
    const p = lobby.players[socket.id];
    if (!p || p.status !== 'playing') return;

    p.hand.push(drawCard(lobby));
    const v = handValue(p.hand);
    if (v >= 21) {
      p.status = v > 21 ? 'bust' : 'stood';
      advanceTurn(lobby);
    } else {
      broadcast(lobby);
    }
  });

  socket.on('stand', () => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby || lobby.phase !== 'playing') return;
    if (lobby.currentTurn !== socket.id) return;
    const p = lobby.players[socket.id];
    if (!p || p.status !== 'playing') return;
    p.status = 'stood';
    advanceTurn(lobby);
  });

  socket.on('double_down', () => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby || lobby.phase !== 'playing') return;
    if (lobby.currentTurn !== socket.id) return;
    const p = lobby.players[socket.id];
    if (!p || p.status !== 'playing') return;
    if (p.balance < p.bet) return;

    p.balance -= p.bet;
    p.bet *= 2;
    p.hand.push(drawCard(lobby));
    p.doubledDown = true;
    p.status = handValue(p.hand) > 21 ? 'bust' : 'stood';
    advanceTurn(lobby);
  });

  socket.on('disconnect', () => {
    const lobby = lobbies[myLobbyCode];
    if (!lobby) return;
    delete lobby.players[socket.id];
    lobby.order = lobby.order.filter(id => id !== socket.id);

    if (lobby.order.length === 0) {
      delete lobbies[myLobbyCode];
      return;
    }

    if (lobby.currentTurn === socket.id) advanceTurn(lobby);
    else broadcast(lobby);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Royal Felt running on port ${PORT}`));
