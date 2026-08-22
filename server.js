const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const {
  SUITS,
  RANKS,
  POINT_VALUES,
  createDeck,
  shuffleDeck,
  isTrumpCard,
  getEffectiveSuit,
  getTrumpPower,
  getOffSuitPower,
  isCardPlayable,
  evaluateTrick,
  evaluateRound
} = require('./engine/couillon-rules');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Statische Dateien aus dem public-Ordner bereitstellen (ohne Caching für sofortige Updates)
app.use(express.static(path.join(__dirname, 'public'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  }
}));

// Fallback-Route für direkte Glitch-/Browser-Zugriffe
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-Memory Raum-Verwaltung
const rooms = new Map();

/**
 * Generiert einen zufälligen 4-stelligen Raumcode.
 */
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

/**
 * Erstellt ein neues Raum-Objekt.
 */
function createRoom(roomCode, hostName, hostSocketId) {
  const room = {
    code: roomCode,
    hostSocketId: hostSocketId,
    createdAt: Date.now(),
    seats: [
      { index: 0, name: hostName || 'Spieler 1', socketId: hostSocketId, isBot: false, connected: true, team: 0 },
      null,
      null,
      null
    ],
    scores: { teamA: 13, teamB: 13 },
    dealerIndex: 0,
    declarerIndex: 1, // Spieler links vom Geber ist Ansager
    phase: 'LOBBY', // LOBBY, CHOOSE_TRUMP, PLAY_TRICK, ROUND_END, GAME_OVER
    roundNumber: 0,
    deck: [],
    hands: [[], [], [], []],
    stock: [],
    trumpSuit: null,
    isMitAnnounced: false,
    isContraAnnounced: false,
    mitHolderIndex: -1,
    declarerTeam: null,
    currentTrick: [], // [{ playerIndex, card, playerName }]
    currentTurn: 1,
    trickCount: 0,
    tricksWon: [0, 0, 0, 0],
    eyesWon: [0, 0, 0, 0],
    tricksTeamA: 0,
    tricksTeamB: 0,
    eyesTeamA: 0,
    eyesTeamB: 0,
    lastTrick: null,
    trickWinnerInfo: null,
    roundSummary: null,
    actionLog: [`Raum ${roomCode} erstellt durch ${hostName}.`],
    chatMessages: [],
    botTimer: null
  };
  return room;
}

/**
 * Loggt ein Spiel-Ereignis in den Raumverlauf.
 */
function logAction(room, message) {
  room.actionLog.push(message);
  if (room.actionLog.length > 50) {
    room.actionLog.shift();
  }
}

/**
 * Sendet den Zustand an alle Teilnehmer (mit Cheating-Schutz: nur eigene Handkarten sichtbar).
 */
function broadcastGameState(room) {
  for (let i = 0; i < 4; i++) {
    const seat = room.seats[i];
    if (seat && !seat.isBot && seat.socketId) {
      const clientPayload = sanitizeStateForPlayer(room, i);
      io.to(seat.socketId).emit('game_state', clientPayload);
    }
  }
}

/**
 * Filtert sensible Kartendaten (Hände anderer Spieler & verdeckter Stock) heraus.
 */
function sanitizeStateForPlayer(room, seatIndex) {
  const playersInfo = room.seats.map((seat, idx) => {
    if (!seat) return null;
    return {
      index: idx,
      name: seat.name,
      team: idx % 2 === 0 ? 0 : 1, // 0 = Team A, 1 = Team B
      isBot: seat.isBot,
      connected: seat.connected,
      cardCount: room.hands[idx] ? room.hands[idx].length : 0,
      isDealer: room.dealerIndex === idx,
      isDeclarer: room.declarerIndex === idx,
      isTurn: room.currentTurn === idx
    };
  });

  const myHand = room.hands[seatIndex] ? [...room.hands[seatIndex]] : [];

  // Berechne für jede Karte in der eigenen Hand, ob sie im aktuellen Stich spielbar ist
  const playableMap = {};
  if (room.phase === 'PLAY_TRICK' && room.currentTurn === seatIndex) {
    for (const card of myHand) {
      playableMap[card.id] = isCardPlayable(
        card,
        myHand,
        room.currentTrick,
        room.trumpSuit,
        room.isMitAnnounced
      );
    }
  }

  // canAnnounceMit: Spieler ist am Zug im 1. Stich, besitzt ♠Q und Mit' wurde noch nicht angesagt
  const canAnnounceMit = (
    room.phase === 'PLAY_TRICK' &&
    room.trickCount === 0 &&
    room.currentTurn === seatIndex &&
    room.mitHolderIndex === seatIndex &&
    !room.isMitAnnounced
  );

  // canAnnounceContra: Mit' ist aktiv, Kontra noch nicht gegeben, Stich 1 läuft, Spieler ist im GEGNER-Team der Mit'
  const mitTeam = room.mitHolderIndex !== -1 ? (room.mitHolderIndex % 2 === 0 ? 0 : 1) : -1;
  const myTeam = seatIndex % 2 === 0 ? 0 : 1;
  const canAnnounceContra = (
    room.phase === 'PLAY_TRICK' &&
    room.trickCount === 0 &&
    room.isMitAnnounced &&
    !room.isContraAnnounced &&
    myTeam !== mitTeam
  );

  return {
    roomCode: room.code,
    phase: room.phase,
    roundNumber: room.roundNumber,
    scores: room.scores,
    dealerIndex: room.dealerIndex,
    declarerIndex: room.declarerIndex,
    declarerTeam: room.declarerTeam,
    trumpSuit: room.trumpSuit,
    isMitAnnounced: room.isMitAnnounced,
    isContraAnnounced: room.isContraAnnounced,
    canAnnounceMit: canAnnounceMit,
    canAnnounceContra: canAnnounceContra,
    currentTrick: room.currentTrick,
    currentTurn: room.currentTurn,
    trickCount: room.trickCount,
    tricksTeamA: room.tricksTeamA,
    tricksTeamB: room.tricksTeamB,
    eyesTeamA: room.eyesTeamA,
    eyesTeamB: room.eyesTeamB,
    lastTrick: room.lastTrick,
    trickWinnerInfo: room.trickWinnerInfo,
    roundSummary: room.roundSummary,
    actionLog: room.actionLog,
    chatMessages: room.chatMessages,
    players: playersInfo,
    you: {
      seatIndex: seatIndex,
      team: myTeam,
      isHost: room.seats[seatIndex] && room.seats[seatIndex].socketId === room.hostSocketId,
      hand: myHand,
      playableMap: playableMap
    }
  };
}

/**
 * Startet eine neue Spielrunde (Austeilen 3+2, Trumpfwahl).
 */
function startNewRound(room) {
  room.roundNumber++;
  room.currentTrick = [];
  room.trickCount = 0;
  room.tricksWon = [0, 0, 0, 0];
  room.eyesWon = [0, 0, 0, 0];
  room.tricksTeamA = 0;
  room.tricksTeamB = 0;
  room.eyesTeamA = 0;
  room.eyesTeamB = 0;
  room.trumpSuit = null;
  room.isMitAnnounced = false;
  room.isContraAnnounced = false;
  room.mitHolderIndex = -1;
  room.lastTrick = null;
  room.trickWinnerInfo = null;
  room.roundSummary = null;

  // Deck mischen
  const freshDeck = shuffleDeck(createDeck());
  room.deck = freshDeck;

  // Phase 2: Erstes Austeilen (exakt 3 Karten pro Spieler = 12 Karten)
  room.hands = [[], [], [], []];
  let deckPtr = 0;
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < 3; c++) {
      room.hands[s].push(freshDeck[deckPtr++]);
    }
  }

  // Ansager ist Spieler links vom Geber
  room.declarerIndex = (room.dealerIndex + 1) % 4;
  room.declarerTeam = room.declarerIndex % 2 === 0 ? 0 : 1;
  room.currentTurn = room.declarerIndex;
  room.phase = 'CHOOSE_TRUMP';

  const declarerName = room.seats[room.declarerIndex].name;
  logAction(room, `--- Runde ${room.roundNumber} beginnt --- Geber: ${room.seats[room.dealerIndex].name}, Ansager: ${declarerName}`);
  logAction(room, `3 Karten ausgeteilt. ${declarerName} wählt die Trumpffarbe...`);

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Schließt die Trumpfwahl ab und führt das 2. Austeilen (2 Karten) aus.
 */
function handleTrumpSelection(room, chosenSuit) {
  if (room.phase !== 'CHOOSE_TRUMP') return;
  if (!Object.values(SUITS).includes(chosenSuit)) return;

  room.trumpSuit = chosenSuit;
  const suitSymbols = { clubs: '♣ Kreuz', spades: '♠ Pik', hearts: '♥ Herz', diamonds: '♦ Karo' };
  const declarerName = room.seats[room.declarerIndex].name;
  logAction(room, `${declarerName} hat ${suitSymbols[chosenSuit]} als Trumpf gewählt!`);

  // Phase 3: Zweites Austeilen (exakt 2 Karten pro Spieler = 8 Karten)
  let deckPtr = 12;
  for (let s = 0; s < 4; s++) {
    for (let c = 0; c < 2; c++) {
      room.hands[s].push(room.deck[deckPtr++]);
    }
    // Handkarten sortieren
    sortHand(room.hands[s], room.trumpSuit, false);
  }

  // Die restlichen 4 Karten bilden den verdeckten Stock (Index 20..23)
  room.stock = room.deck.slice(20, 24);
  logAction(room, `Restliche 2 Karten ausgeteilt (4 Karten verbleiben im Stock).`);

  // Prüfe, wer die Pik-Dame (♠Q) besitzt
  room.mitHolderIndex = -1;
  for (let s = 0; s < 4; s++) {
    if (room.hands[s].some(c => c.suit === SUITS.SPADES && c.rank === 'Q')) {
      room.mitHolderIndex = s;
      break;
    }
  }

  // Spiel geht direkt in den Stichmodus über – Ansager spielt die 1. Karte an
  room.currentTurn = room.declarerIndex;
  room.phase = 'PLAY_TRICK';

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Sortiert Handkarten für übersichtliche Anzeige: Trümpfe zuerst, dann nach Farben geordnet.
 */
function sortHand(hand, trumpSuit, isMitAnnounced = false) {
  const suitOrder = { [trumpSuit]: 0, [SUITS.HEARTS]: 1, [SUITS.SPADES]: 2, [SUITS.DIAMONDS]: 3, [SUITS.CLUBS]: 4 };
  const rankOrder = { 'A': 0, 'K': 1, 'Q': 2, 'J': 3, '10': 4, '9': 5 };

  hand.sort((a, b) => {
    const aIsTrump = isTrumpCard(a, trumpSuit, isMitAnnounced);
    const bIsTrump = isTrumpCard(b, trumpSuit, isMitAnnounced);
    if (aIsTrump && !bIsTrump) return -1;
    if (!aIsTrump && bIsTrump) return 1;

    if (aIsTrump && bIsTrump) {
      return getTrumpPower(b, trumpSuit, isMitAnnounced) - getTrumpPower(a, trumpSuit, isMitAnnounced);
    }

    if (a.suit !== b.suit) {
      return (suitOrder[a.suit] || 99) - (suitOrder[b.suit] || 99);
    }
    return (rankOrder[a.rank] || 99) - (rankOrder[b.rank] || 99);
  });
}

/**
 * Verarbeitet die Mit'-Ansage, wenn der Besitzer am Zug ist (vor dem Ausspielen der Karte in Stich 1).
 */
function handleMitAnnouncement(room, playerIndex, announce) {
  if (room.phase !== 'PLAY_TRICK') return;
  if (room.trickCount !== 0) return; // Nur im 1. Stich
  if (room.currentTurn !== playerIndex) return;
  if (room.mitHolderIndex !== playerIndex) return;

  if (announce && !room.isMitAnnounced) {
    room.isMitAnnounced = true;
    const announcerName = room.seats[playerIndex].name;
    logAction(room, `⭐ ${announcerName} hat die MIT' ANGESAGT! Rundenwert: 2 Punkte. Pik-Dame ist 2. höchster Trumpf.`);

    // Handkarten aller Spieler mit aktualisierter Mit'-Rangfolge neu sortieren
    for (let s = 0; s < 4; s++) {
      sortHand(room.hands[s], room.trumpSuit, true);
    }
  }

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Verarbeitet die Kontra-Ansage des gegnerischen Teams in Stich 1 nach Mit'.
 */
function handleContraAnnouncement(room, playerIndex) {
  if (room.phase !== 'PLAY_TRICK') return;
  if (room.trickCount !== 0) return;
  if (!room.isMitAnnounced) return;
  if (room.isContraAnnounced) return;

  const mitTeam = room.mitHolderIndex !== -1 ? (room.mitHolderIndex % 2 === 0 ? 0 : 1) : -1;
  const playerTeam = playerIndex % 2 === 0 ? 0 : 1;
  if (playerTeam === mitTeam) return;

  room.isContraAnnounced = true;
  const announcerName = room.seats[playerIndex].name;
  logAction(room, `⚡⚡ ${announcerName} hat KONTRA gegeben! Rundenwert verdoppelt auf 4 PUNKTE (5 bei Durchmarsch)!`);

  broadcastGameState(room);
}

/**
 * Führt das Ausspielen einer Karte aus.
 */
function handleCardPlay(room, playerIndex, cardId) {
  if (room.phase !== 'PLAY_TRICK') return;
  if (room.currentTurn !== playerIndex) return;

  const playerHand = room.hands[playerIndex];
  const cardIndex = playerHand.findIndex(c => c.id === cardId);
  if (cardIndex === -1) return;

  const card = playerHand[cardIndex];

  // Stichregel-Validierung
  const valid = isCardPlayable(card, playerHand, room.currentTrick, room.trumpSuit, room.isMitAnnounced);
  if (!valid) return;

  // Karte aus Hand entfernen und in den Stich legen
  playerHand.splice(cardIndex, 1);
  const playerName = room.seats[playerIndex].name;
  room.currentTrick.push({
    playerIndex,
    card,
    playerName
  });

  const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
  const cardDisplay = `${suitIcons[card.suit]}${card.rank}`;
  logAction(room, `${playerName} spielt ${cardDisplay}`);

  // Prüfen, ob der Stich vollständig ist (4 Karten)
  if (room.currentTrick.length === 4) {
    room.phase = 'EVALUATING_TRICK';

    // Stich SOFORT auswerten, damit die Anzeige exakt den Sieger DIESES Stichs zeigt!
    const result = evaluateTrick(room.currentTrick, room.trumpSuit, room.isMitAnnounced);
    const winnerIndex = result.winnerIndex;
    const winnerName = room.seats[winnerIndex].name;
    const winnerTeam = winnerIndex % 2 === 0 ? 0 : 1;

    room.trickWinnerInfo = {
      winnerIndex,
      winnerName,
      winnerTeam,
      winningCard: result.winningCard,
      points: result.points
    };

    // lastTrick sofort mit aktuellem Stich befüllen
    room.lastTrick = {
      trickNumber: room.trickCount + 1,
      cards: [...room.currentTrick],
      winnerIndex,
      winnerName,
      points: result.points
    };

    broadcastGameState(room);

    // 2.5 Sekunden Pause, damit alle den Stich & Sieger in Ruhe sehen
    setTimeout(() => {
      resolveTrick(room, result);
    }, 2500);
  } else {
    // Nächster Spieler im Uhrzeigersinn ist am Zug
    room.currentTurn = (room.currentTurn + 1) % 4;
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Wertet einen abgeschlossenen Stich nach der Betrachtungspause aus.
 */
function resolveTrick(room, result) {
  const winnerIndex = result.winnerIndex;
  const winnerName = room.seats[winnerIndex].name;
  const winnerTeam = winnerIndex % 2 === 0 ? 0 : 1;

  room.trickCount++;
  room.tricksWon[winnerIndex]++;
  room.eyesWon[winnerIndex] += result.points;

  if (winnerTeam === 0) {
    room.tricksTeamA++;
    room.eyesTeamA += result.points;
  } else {
    room.tricksTeamB++;
    room.eyesTeamB += result.points;
  }

  const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
  const winningCardDisplay = `${suitIcons[result.winningCard.suit]}${result.winningCard.rank}`;
  logAction(room, `🏆 ${winnerName} gewinnt Stich ${room.trickCount} mit ${winningCardDisplay} (${result.points} Augen).`);

  room.currentTrick = [];
  room.trickWinnerInfo = null;

  // Wurden alle 5 Stiche gespielt?
  if (room.trickCount === 5) {
    resolveRound(room);
  } else {
    // Stichgewinner spielt zum nächsten Stich aus
    room.currentTurn = winnerIndex;
    room.phase = 'PLAY_TRICK';
    broadcastGameState(room);
    checkBotAction(room);
  }
}

/**
 * Wertet die Runde nach 5 Stichen aus.
 */
function resolveRound(room) {
  const evaluation = evaluateRound({
    declarerTeam: room.declarerTeam,
    eyesTeamA: room.eyesTeamA,
    eyesTeamB: room.eyesTeamB,
    tricksTeamA: room.tricksTeamA,
    tricksTeamB: room.tricksTeamB,
    isMitAnnounced: room.isMitAnnounced,
    isContraAnnounced: room.isContraAnnounced
  });

  // Punktestand aktualisieren (13 -> 0 Countdown)
  const oldScoreA = room.scores.teamA;
  const oldScoreB = room.scores.teamB;

  room.scores.teamA += evaluation.deltaTeamA;
  room.scores.teamB += evaluation.deltaTeamB;

  logAction(room, `=== RUNDEN-ABRECHNUNG ===`);
  logAction(room, `Augen: Team A: ${room.eyesTeamA} | Team B: ${room.eyesTeamB}`);
  logAction(room, evaluation.reason);
  logAction(room, `Neuer Punktestand: Team A: ${room.scores.teamA} (vorher ${oldScoreA}) | Team B: ${room.scores.teamB} (vorher ${oldScoreB})`);

  room.roundSummary = {
    roundNumber: room.roundNumber,
    eyesTeamA: room.eyesTeamA,
    eyesTeamB: room.eyesTeamB,
    tricksTeamA: room.tricksTeamA,
    tricksTeamB: room.tricksTeamB,
    deltaTeamA: evaluation.deltaTeamA,
    deltaTeamB: evaluation.deltaTeamB,
    oldScoreA,
    oldScoreB,
    newScoreA: room.scores.teamA,
    newScoreB: room.scores.teamB,
    reason: evaluation.reason,
    stockCards: room.stock,
    isGameOver: room.scores.teamA <= 0 || room.scores.teamB <= 0
  };

  // Spielende prüfen
  if (room.scores.teamA <= 0 || room.scores.teamB <= 0) {
    room.phase = 'GAME_OVER';
    const winningTeamName = (room.scores.teamA <= 0 && (room.scores.teamB > 0 || room.scores.teamA <= room.scores.teamB))
      ? 'Team A'
      : 'Team B';
    logAction(room, `🎉 PARTIE BEENDET! ${winningTeamName} hat das Spiel gewonnen!`);
  } else {
    room.phase = 'ROUND_END';
    // Geber rotiert im Uhrzeigersinn um 1
    room.dealerIndex = (room.dealerIndex + 1) % 4;
  }

  broadcastGameState(room);
}

/**
 * Führt automatische Züge für Bots aus.
 */
function checkBotAction(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }

  if (room.phase === 'CHOOSE_TRUMP') {
    const declarer = room.seats[room.declarerIndex];
    if (declarer && declarer.isBot) {
      room.botTimer = setTimeout(() => {
        const hand = room.hands[room.declarerIndex];
        const counts = { clubs: 0, spades: 0, hearts: 0, diamonds: 0 };
        for (const card of hand) {
          counts[card.suit] = (counts[card.suit] || 0) + (card.rank === 'A' ? 3 : 1);
        }
        let bestSuit = SUITS.HEARTS;
        let maxCount = -1;
        for (const suit of Object.values(SUITS)) {
          if (counts[suit] > maxCount) {
            maxCount = counts[suit];
            bestSuit = suit;
          }
        }
        handleTrumpSelection(room, bestSuit);
      }, 1000);
    }
  } else if (room.phase === 'PLAY_TRICK') {
    // Prüfe, ob gegnerischer Bot Kontra geben möchte
    if (room.trickCount === 0 && room.isMitAnnounced && !room.isContraAnnounced) {
      const mitTeam = room.mitHolderIndex !== -1 ? (room.mitHolderIndex % 2 === 0 ? 0 : 1) : -1;
      for (let s = 0; s < 4; s++) {
        const seat = room.seats[s];
        const sTeam = s % 2 === 0 ? 0 : 1;
        if (seat && seat.isBot && sTeam !== mitTeam) {
          const hand = room.hands[s];
          const aces = hand.filter(c => c.rank === 'A').length;
          const trumps = hand.filter(c => isTrumpCard(c, room.trumpSuit, true)).length;
          if (aces >= 1 && trumps >= 2 && Math.random() < 0.5) {
            handleContraAnnouncement(room, s);
            break;
          }
        }
      }
    }

    const currentSeat = room.seats[room.currentTurn];
    if (currentSeat && currentSeat.isBot) {
      room.botTimer = setTimeout(() => {
        // Prüfe, ob der Bot die Mit' ansagen möchte (in Stich 1, wenn er ♠Q hat)
        if (room.trickCount === 0 && room.mitHolderIndex === room.currentTurn && !room.isMitAnnounced) {
          const botHand = room.hands[room.currentTurn];
          const trumpCount = botHand.filter(c => isTrumpCard(c, room.trumpSuit, false)).length;
          if (trumpCount >= 2 || Math.random() < 0.65) {
            handleMitAnnouncement(room, room.currentTurn, true);
          }
        }

        const hand = room.hands[room.currentTurn];
        if (!hand || hand.length === 0) return;

        // Finde alle gültigen spielbaren Karten
        const playable = hand.filter(card => 
          isCardPlayable(card, hand, room.currentTrick, room.trumpSuit, room.isMitAnnounced)
        );

        if (playable.length === 0) return;

        let chosenCard = playable[0];

        if (room.currentTrick.length === 0) {
          // Bevorzuge Asse
          const aces = playable.filter(c => c.rank === 'A');
          if (aces.length > 0) {
            chosenCard = aces[0];
          } else {
            chosenCard = playable[Math.floor(Math.random() * playable.length)];
          }
        } else {
          // Prüfe, ob eine Karte den Stich gewinnen kann
          let winningCards = [];
          for (const card of playable) {
            const simTrick = [...room.currentTrick, { playerIndex: room.currentTurn, card }];
            const evalRes = evaluateTrick(simTrick, room.trumpSuit, room.isMitAnnounced);
            if (evalRes.winnerIndex === room.currentTurn) {
              winningCards.push(card);
            }
          }

          if (winningCards.length > 0) {
            chosenCard = winningCards[0];
          } else {
            const zeroes = playable.filter(c => c.points === 0);
            if (zeroes.length > 0) {
              chosenCard = zeroes[0];
            } else {
              chosenCard = playable.sort((a, b) => a.points - b.points)[0];
            }
          }
        }

        handleCardPlay(room, room.currentTurn, chosenCard.id);
      }, 1000);
    }
  }
}

// Socket.io Verbindungs- und Event-Handling
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentSeatIndex = -1;

  // Raum erstellen
  socket.on('create_room', ({ playerName }) => {
    const code = generateRoomCode();
    const room = createRoom(code, playerName || 'Spieler 1', socket.id);
    rooms.set(code, room);
    currentRoomCode = code;
    currentSeatIndex = 0;
    socket.join(code);
    socket.emit('room_created', { roomCode: code, seatIndex: 0 });
    broadcastGameState(room);
  });

  // Raum beitreten
  socket.on('join_room', ({ roomCode, playerName, preferredSeat }) => {
    const code = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      return socket.emit('error_message', 'Raum nicht gefunden. Bitte Code prüfen.');
    }

    // 1. Prüfen, ob dieser Socket bereits im Raum ist
    let existingIndex = room.seats.findIndex(s => s && s.socketId === socket.id);
    if (existingIndex !== -1) {
      currentRoomCode = code;
      currentSeatIndex = existingIndex;
      room.seats[existingIndex].connected = true;
      socket.join(code);
      return broadcastGameState(room);
    }

    // 2. Reconnect: Prüfen, ob ein getrennter Spieler mit gleichem Namen existiert
    if (playerName) {
      const cleanName = playerName.trim().toLowerCase();
      const discIndex = room.seats.findIndex(s => s && !s.isBot && !s.connected && s.name.trim().toLowerCase() === cleanName);
      if (discIndex !== -1) {
        const restored = room.seats[discIndex];
        restored.socketId = socket.id;
        restored.connected = true;
        currentRoomCode = code;
        currentSeatIndex = discIndex;
        socket.join(code);
        logAction(room, `🔄 ${restored.name} hat die Verbindung wiederhergestellt.`);
        return broadcastGameState(room);
      }
    }

    // Freien Platz suchen
    let targetSeat = (typeof preferredSeat === 'number' && preferredSeat >= 0 && preferredSeat < 4 && !room.seats[preferredSeat])
      ? preferredSeat
      : room.seats.findIndex(s => s === null || (s.isBot && room.phase === 'LOBBY'));

    if (targetSeat === -1) {
      return socket.emit('error_message', 'Dieser Raum ist bereits voll (4 Spieler).');
    }

    const newSeat = {
      index: targetSeat,
      name: playerName || `Spieler ${targetSeat + 1}`,
      socketId: socket.id,
      isBot: false,
      connected: true,
      team: targetSeat % 2 === 0 ? 0 : 1
    };

    room.seats[targetSeat] = newSeat;
    currentRoomCode = code;
    currentSeatIndex = targetSeat;
    socket.join(code);

    logAction(room, `${newSeat.name} ist Platz ${targetSeat + 1} beigetreten.`);
    broadcastGameState(room);
  });

  // Reconnect nach kurzem Browser-Refresh / Verbindungsabbruch
  socket.on('reconnect_player', ({ roomCode, playerName, seatIndex }) => {
    if (!roomCode) return;
    const code = roomCode.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return;

    if (typeof seatIndex === 'number' && seatIndex >= 0 && seatIndex < 4) {
      const seat = room.seats[seatIndex];
      if (seat && !seat.isBot) {
        seat.socketId = socket.id;
        seat.connected = true;
        if (playerName) seat.name = playerName;
        currentRoomCode = code;
        currentSeatIndex = seatIndex;
        socket.join(code);
        logAction(room, `🔄 ${seat.name} wieder im Spiel.`);
        return broadcastGameState(room);
      }
    }
  });

  // Sitzplatz wechseln in der Lobby
  socket.on('switch_seat', ({ targetSeat }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') return;
    if (targetSeat < 0 || targetSeat >= 4) return;
    if (room.seats[targetSeat] && !room.seats[targetSeat].isBot) return;

    const mySeat = room.seats[currentSeatIndex];
    if (!mySeat) return;

    room.seats[currentSeatIndex] = null;
    mySeat.index = targetSeat;
    mySeat.team = targetSeat % 2 === 0 ? 0 : 1;
    room.seats[targetSeat] = mySeat;
    currentSeatIndex = targetSeat;

    logAction(room, `${mySeat.name} wechselt auf Platz ${targetSeat + 1}.`);
    broadcastGameState(room);
  });

  // Bot hinzufügen
  socket.on('add_bot', ({ seatIndex }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') return;
    if (seatIndex < 0 || seatIndex >= 4) return;
    if (room.seats[seatIndex]) return;

    const botNames = ['Bot Eifel', 'Bot Ardennen', 'Bot Venn', 'Bot Malmedy'];
    const botName = botNames[seatIndex] || `Bot ${seatIndex + 1}`;

    room.seats[seatIndex] = {
      index: seatIndex,
      name: botName,
      socketId: null,
      isBot: true,
      connected: true,
      team: seatIndex % 2 === 0 ? 0 : 1
    };

    logAction(room, `${botName} zu Platz ${seatIndex + 1} hinzugefügt.`);
    broadcastGameState(room);
  });

  // Bot entfernen
  socket.on('remove_bot', ({ seatIndex }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') return;
    if (seatIndex < 0 || seatIndex >= 4) return;
    if (room.seats[seatIndex] && room.seats[seatIndex].isBot) {
      logAction(room, `${room.seats[seatIndex].name} entfernt.`);
      room.seats[seatIndex] = null;
      broadcastGameState(room);
    }
  });

  // Spiel starten
  socket.on('start_game', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') return;

    const occupiedSeats = room.seats.filter(s => s !== null).length;
    if (occupiedSeats < 4) {
      return socket.emit('error_message', 'Es werden genau 4 Spieler oder Bots benötigt.');
    }

    room.scores = { teamA: 13, teamB: 13 };
    room.dealerIndex = 0;
    startNewRound(room);
  });

  // Trumpf auswählen
  socket.on('select_trump', ({ suit }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'CHOOSE_TRUMP') return;
    if (room.declarerIndex !== currentSeatIndex) return;

    handleTrumpSelection(room, suit);
  });

  // Mit' ansagen
  socket.on('announce_mit', ({ announce }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    handleMitAnnouncement(room, currentSeatIndex, !!announce);
  });

  // Kontra ansagen
  socket.on('announce_contra', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    handleContraAnnouncement(room, currentSeatIndex);
  });

  // Karte spielen
  socket.on('play_card', ({ cardId }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (room.currentTurn !== currentSeatIndex) return;

    handleCardPlay(room, currentSeatIndex, cardId);
  });

  // Nächste Runde starten
  socket.on('next_round', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'ROUND_END') return;

    startNewRound(room);
  });

  // Spiel neu starten
  socket.on('restart_game', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'GAME_OVER') return;

    room.scores = { teamA: 13, teamB: 13 };
    room.roundNumber = 0;
    room.dealerIndex = 0;
    startNewRound(room);
  });

  // Chat-Nachricht
  socket.on('send_chat', ({ message }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const seat = room.seats[currentSeatIndex];
    const senderName = seat ? seat.name : 'Zuschauer';
    const cleanMsg = (message || '').trim().slice(0, 150);
    if (!cleanMsg) return;

    const chatItem = {
      sender: senderName,
      text: cleanMsg,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    room.chatMessages.push(chatItem);
    if (room.chatMessages.length > 50) room.chatMessages.shift();

    broadcastGameState(room);
  });

  // Trennung behandeln
  socket.on('disconnect', () => {
    if (currentRoomCode && currentSeatIndex !== -1) {
      const room = rooms.get(currentRoomCode);
      if (room && room.seats[currentSeatIndex]) {
        room.seats[currentSeatIndex].connected = false;
        logAction(room, `${room.seats[currentSeatIndex].name} hat die Verbindung getrennt.`);
        broadcastGameState(room);
      }
    }
  });
});

// Server starten
server.listen(PORT, () => {
  console.log(`=========================================`);
  console.log(` Kujong Server läuft auf Port ${PORT}`);
  console.log(` Glitch & Local: http://localhost:${PORT}`);
  console.log(`=========================================`);
});
