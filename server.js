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

const {
  chooseTrumpSuit,
  shouldBotTurnTrump,
  shouldAnnounceMit,
  shouldAnnounceContra,
  chooseCardToPlay
} = require('./engine/couillon-bot-ai');

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

// Kurze, abwechslungsreiche Bot-Namen (kurz, prägnant, mobil-optimiert)
const SHORT_BOT_NAMES = [
  'Max', 'Leo', 'Pit', 'Sam', 'Kai', 'Luc', 'Ben', 'Tom', 'Tim', 'Jan',
  'Pol', 'Guy', 'Dan', 'Rob', 'Marc', 'Nico', 'Finn', 'Paul', 'Noah', 'Alex',
  'Mia', 'Lea', 'Eva', 'Zoe', 'Lina', 'Emma', 'Lara', 'Sara', 'Jule', 'Nele'
];

/**
 * Wählt einen zufälligen, kurzen Bot-Namen, der noch nicht im Raum sitzt.
 */
function getRandomBotName(room) {
  const currentNames = (room && room.seats)
    ? room.seats.filter(s => s && s.name).map(s => s.name.toLowerCase().trim())
    : [];

  const available = SHORT_BOT_NAMES.filter(n => {
    const lower = n.toLowerCase();
    return !currentNames.includes(`bot ${lower}`) && !currentNames.includes(lower);
  });

  const pool = available.length > 0 ? available : SHORT_BOT_NAMES;
  const picked = pool[Math.floor(Math.random() * pool.length)];
  return `Bot ${picked}`;
}

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
    settings: {
      playerCount: 4,                 // 4 oder 6 Spieler (Standard: 4)
      countEyesLive: true,            // Live-Augenzähler im Header (Standard: true)
      alwaysClubQueenTrump: true,     // Kreuz-Dame immer 2. bzw. 3. Trumpf (Standard: true)
      allowMit: true,                 // Pik-Dame Mit'-Ansage erlaubt (Standard: true)
      contraPoints: 4,                // Rundenwert bei Kontra: 4 Pkt (Standard: 4, alternativ: 3)
      ansagerZeroTricksPenalty: 2,    // Strafpunkte bei 0 Stichen für Ansager: 2 Pkt (Standard: 2, alternativ: 1)
      startScoreA: 13,                // Startwert Team A (Standard: 13)
      startScoreB: 13,                // Startwert Team B (Standard: 13)
      drinkingGameMode: 'none',       // Trinkspiel-Modus: 'none', 'light', 'medium', 'heavy' (Standard: 'none')
      trickDisplaySeconds: 2.5,       // Anzeigedauer des fertigen Stichs (Standard: 2.5s)
      dealAndTurnDelaySeconds: 1.0    // Pause bei Austeilen & Bot-Zügen (Standard: 1.0s)
    },
    scores: { teamA: 13, teamB: 13 },
    dealerIndex: 0,
    declarerIndex: 1, // Spieler links vom Geber ist Ansager
    phase: 'LOBBY', // LOBBY, CHOOSE_TRUMP, PLAY_TRICK, ROUND_END, GAME_OVER
    roundNumber: 0,
    deck: [],
    hands: [[], [], [], []],
    stock: [],
    trumpSuit: null,
    turnedCard: null, // Aufgedeckte Karte bei 'Trumpf drehen'
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
  const maxPlayers = room.settings.playerCount || 4;
  for (let i = 0; i < maxPlayers; i++) {
    const seat = room.seats[i];
    if (seat && !seat.isBot && seat.socketId) {
      const clientPayload = sanitizeStateForPlayer(room, i);
      io.to(seat.socketId).emit('game_state', clientPayload);
    }
  }
}

/**
 * Ermittelt, ob ein Socket bzw. Spieler der aktuelle Spielleiter (Host) des Raums ist.
 * Reagiert dynamisch und stellt sicher, dass immer ein echter menschlicher Spieler Host ist.
 */
function isPlayerHost(room, socket) {
  if (!room || !socket) return false;
  if (room.hostSocketId && socket.id === room.hostSocketId) {
    return true;
  }
  // Falls die gespeicherte hostSocketId nicht mehr aktiv ist, nächsten menschlichen Spieler ernennen
  const currentHost = room.seats.find(s => s && !s.isBot && s.socketId && s.socketId === room.hostSocketId && s.connected !== false);
  if (!currentHost) {
    const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false);
    if (nextHuman) {
      room.hostSocketId = nextHuman.socketId;
      return nextHuman.socketId === socket.id;
    }
  }
  return false;
}

/**
 * Filtert sensible Kartendaten (Hände anderer Spieler & verdeckter Stock) heraus.
 */
function sanitizeStateForPlayer(room, seatIndex) {
  // Sicherstellen, dass hostSocketId auf einen existierenden aktiven Menschen verweist
  let activeHost = room.seats.find(s => s && !s.isBot && s.socketId && s.socketId === room.hostSocketId && s.connected !== false);
  if (!activeHost) {
    const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false);
    if (nextHuman) {
      room.hostSocketId = nextHuman.socketId;
    }
  }

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
      isTurn: room.currentTurn === idx,
      isMitAnnouncer: room.isMitAnnounced && (room.mitAnnouncerIndex === idx),
      isHost: (seat.socketId === room.hostSocketId)
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
        room.isMitAnnounced,
        room.settings
      );
    }
  }

  // canAnnounceMit: Mit' ist in Einstellungen erlaubt, Stich 1 läuft, Spieler besitzt ♠Q und Mit' wurde noch nicht angesagt
  const canAnnounceMit = (
    room.settings.allowMit !== false &&
    room.phase === 'PLAY_TRICK' &&
    room.trickCount === 0 &&
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

  const isMeHost = (room.seats[seatIndex] && room.seats[seatIndex].socketId === room.hostSocketId);

  return {
    roomCode: room.code,
    phase: room.phase,
    settings: room.settings,
    roundNumber: room.roundNumber,
    scores: room.scores,
    dealerIndex: room.dealerIndex,
    declarerIndex: room.declarerIndex,
    declarerTeam: room.declarerTeam,
    trumpSuit: room.trumpSuit,
    turnedCard: room.turnedCard,
    isMitAnnounced: room.isMitAnnounced,
    mitAnnouncerIndex: room.isMitAnnounced ? room.mitAnnouncerIndex : -1,
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
      isHost: isMeHost,
      hand: myHand,
      playableMap: playableMap
    }
  };
}

/**
 * Startet eine neue Spielrunde (Austeilen 3+2, Trumpfwahl).
 */
function startNewRound(room) {
  const maxPlayers = room.settings.playerCount || 4;
  room.roundNumber++;
  room.currentTrick = [];
  room.trickCount = 0;
  room.tricksWon = Array(maxPlayers).fill(0);
  room.eyesWon = Array(maxPlayers).fill(0);
  room.tricksTeamA = 0;
  room.tricksTeamB = 0;
  room.eyesTeamA = 0;
  room.eyesTeamB = 0;
  room.trumpSuit = null;
  room.turnedCard = null;
  room.isMitAnnounced = false;
  room.isContraAnnounced = false;
  room.mitHolderIndex = -1;
  room.mitAnnouncerIndex = -1;
  room.lastTrick = null;
  room.trickWinnerInfo = null;
  room.roundSummary = null;

  // Deck mischen (24 Karten bei 4p, 32 Karten bei 6p)
  const freshDeck = shuffleDeck(createDeck(maxPlayers));
  room.deck = freshDeck;

  // Phase 2: Erstes Austeilen (exakt 3 Karten pro Spieler = 12 bzw. 18 Karten)
  room.hands = Array(maxPlayers).fill(null).map(() => []);
  let deckPtr = 0;
  for (let s = 0; s < maxPlayers; s++) {
    for (let c = 0; c < 3; c++) {
      room.hands[s].push(freshDeck[deckPtr++]);
    }
  }

  // Ansager ist Spieler links vom Geber
  room.declarerIndex = (room.dealerIndex + 1) % maxPlayers;
  room.declarerTeam = room.declarerIndex % 2 === 0 ? 0 : 1;
  room.currentTurn = room.declarerIndex;
  room.phase = 'CHOOSE_TRUMP';

  const declarerName = room.seats[room.declarerIndex] ? room.seats[room.declarerIndex].name : `Spieler ${room.declarerIndex + 1}`;
  const dealerName = room.seats[room.dealerIndex] ? room.seats[room.dealerIndex].name : `Spieler ${room.dealerIndex + 1}`;
  logAction(room, `--- Runde ${room.roundNumber} beginnt --- Geber: ${dealerName}, Ansager: ${declarerName}`);
  logAction(room, `3 Karten ausgeteilt. ${declarerName} wählt die Trumpffarbe...`);

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Führt das blinde 'Trumpf drehen' aus:
 * Eine der 2 verdeckten Restkarten des Ansagers wird zufällig aufgedeckt,
 * bestimmt die Trumpffarbe UND wird sofort als 1. Karte in Stich 1 ausgespielt!
 */
function handleTurnTrump(room) {
  if (room.phase !== 'CHOOSE_TRUMP') return;
  const maxPlayers = room.settings.playerCount || 4;
  const d = room.declarerIndex;
  const basePtr = 3 * maxPlayers;
  const card1 = room.deck[basePtr + d * 2];
  const card2 = room.deck[basePtr + d * 2 + 1];
  if (!card1 || !card2) return;

  // Zufällig eine der beiden Karten wählen
  const pickFirst = Math.random() < 0.5;
  const turnedCard = pickFirst ? card1 : card2;
  const keptCard = pickFirst ? card2 : card1;

  const chosenSuit = turnedCard.suit;
  const suitSymbols = { clubs: '♣ Kreuz', spades: '♠ Pik', hearts: '♥ Herz', diamonds: '♦ Karo' };
  const declarerName = room.seats[d] ? room.seats[d].name : `Spieler ${d + 1}`;

  room.trumpSuit = chosenSuit;
  room.turnedCard = turnedCard;
  logAction(room, `🎲 ${declarerName} hat Trumpf gedreht! Aufgedeckt & direkt angespielt: ${suitSymbols[chosenSuit]} ${turnedCard.rank} ➔ Trumpf ist ${suitSymbols[chosenSuit]}!`);

  // Zweites Austeilen:
  // Ansager behält die andere Karte (hat 4 Handkarten, da 1 ausgespielt)
  // Alle anderen Spieler erhalten ihre 2 Karten (haben 5 Handkarten)
  for (let s = 0; s < maxPlayers; s++) {
    if (s === d) {
      room.hands[s].push(keptCard);
    } else {
      room.hands[s].push(room.deck[basePtr + s * 2], room.deck[basePtr + s * 2 + 1]);
    }
    sortHand(room.hands[s], room.trumpSuit, false);
  }

  // Stock (4 Karten bei 4p, 2 Karten bei 6p)
  const totalCards = maxPlayers === 6 ? 32 : 24;
  room.stock = room.deck.slice(basePtr + maxPlayers * 2, totalCards);
  logAction(room, `Restliche Karten ausgeteilt (${room.stock.length} Karte(n) verbleiben im Stock).`);

  // Prüfe, wer die Pik-Dame (♠Q) besitzt (in Händen oder als aufgedeckte Karte)
  room.mitHolderIndex = -1;
  for (let s = 0; s < maxPlayers; s++) {
    if (room.hands[s].some(c => c.suit === SUITS.SPADES && c.rank === 'Q')) {
      room.mitHolderIndex = s;
      break;
    }
  }
  if (turnedCard && turnedCard.suit === SUITS.SPADES && turnedCard.rank === 'Q') {
    room.mitHolderIndex = d;
  }

  // DIE AUFGEDECKTE KARTE WIRD DIREKT IN STICH 1 AUSGESPIELT!
  room.currentTrick = [{
    playerIndex: d,
    card: turnedCard,
    playerName: declarerName
  }];

  // Nächster Spieler im Uhrzeigersinn ist am Zug
  room.currentTurn = (d + 1) % maxPlayers;
  room.phase = 'PLAY_TRICK';

  // Falls der Ansager ein Bot ist und ♠Q hält/gedreht hat: Mit'-Ansage direkt prüfen
  if (room.seats[d] && room.seats[d].isBot && room.mitHolderIndex === d && room.settings.allowMit !== false) {
    if (shouldAnnounceMit(room.hands[d], d, d, room.trumpSuit, room.settings)) {
      handleMitAnnouncement(room, d, true);
    }
  }

  broadcastGameState(room);
  checkBotAction(room);
}

/**
 * Schließt die manuelle Trumpfwahl ab und führt das 2. Austeilen (2 Karten) aus.
 */
function handleTrumpSelection(room, chosenSuit) {
  if (room.phase !== 'CHOOSE_TRUMP') return;
  if (!Object.values(SUITS).includes(chosenSuit)) return;

  const maxPlayers = room.settings.playerCount || 4;
  room.trumpSuit = chosenSuit;
  room.turnedCard = null;
  const suitSymbols = { clubs: '♣ Kreuz', spades: '♠ Pik', hearts: '♥ Herz', diamonds: '♦ Karo' };
  const declarerName = room.seats[room.declarerIndex] ? room.seats[room.declarerIndex].name : `Spieler ${room.declarerIndex + 1}`;
  logAction(room, `${declarerName} hat ${suitSymbols[chosenSuit]} als Trumpf gewählt!`);

  // Phase 3: Zweites Austeilen (exakt 2 Karten pro Spieler)
  let deckPtr = 3 * maxPlayers;
  for (let s = 0; s < maxPlayers; s++) {
    for (let c = 0; c < 2; c++) {
      room.hands[s].push(room.deck[deckPtr++]);
    }
    // Handkarten sortieren
    sortHand(room.hands[s], room.trumpSuit, false);
  }

  // Restliche Karten bilden den verdeckten Stock (4 Karten bei 4p, 2 Karten bei 6p)
  const totalCards = maxPlayers === 6 ? 32 : 24;
  room.stock = room.deck.slice(deckPtr, totalCards);
  logAction(room, `Restliche 2 Karten ausgeteilt (${room.stock.length} Karte(n) verbleiben im Stock).`);

  // Prüfe, wer die Pik-Dame (♠Q) besitzt
  room.mitHolderIndex = -1;
  for (let s = 0; s < maxPlayers; s++) {
    if (room.hands[s].some(c => c.suit === SUITS.SPADES && c.rank === 'Q')) {
      room.mitHolderIndex = s;
      break;
    }
  }

  // Spiel geht direkt in den Stichmodus über – Ansager spielt die 1. Karte an
  room.currentTrick = [];
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
  const rankOrder = { 'A': 0, 'K': 1, 'Q': 2, 'J': 3, '10': 4, '9': 5, '8': 6, '7': 7 };

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
 * Verarbeitet die Mit'-Ansage des ♠Q-Besitzers im 1. Stich.
 */
function handleMitAnnouncement(room, playerIndex, announce) {
  if (room.phase !== 'PLAY_TRICK') return;
  if (room.trickCount !== 0) return; // Nur im 1. Stich
  if (room.mitHolderIndex !== playerIndex) return;

  if (announce && !room.isMitAnnounced) {
    room.isMitAnnounced = true;
    room.mitAnnouncerIndex = playerIndex;
    const announcerName = room.seats[playerIndex].name;
    logAction(room, `⭐ ${announcerName} hat die MIT' ANGESAGT! Rundenwert: 2 Punkte. Pik-Dame ist 2. höchster Trumpf.`);

    // Handkarten aller Spieler mit aktualisierter Mit'-Rangfolge neu sortieren
    const maxPlayers = room.settings.playerCount || 4;
    for (let s = 0; s < maxPlayers; s++) {
      sortHand(room.hands[s], room.trumpSuit, true);
    }

    // Event für auffällige Spielfeld-Benachrichtigung an alle Clients
    io.to(room.code).emit('mit_announced', {
      seatIndex: playerIndex,
      playerName: announcerName
    });
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
  const valid = isCardPlayable(card, playerHand, room.currentTrick, room.trumpSuit, room.isMitAnnounced, room.settings);
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

  const maxPlayers = room.settings.playerCount || 4;

  // Prüfen, ob der Stich vollständig ist (4 bzw. 6 Karten)
  if (room.currentTrick.length === maxPlayers) {
    room.phase = 'EVALUATING_TRICK';

    // Stich SOFORT auswerten, damit die Anzeige exakt den Sieger DIESES Stichs zeigt!
    const result = evaluateTrick(room.currentTrick, room.trumpSuit, room.isMitAnnounced, room.settings);
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

    // Pause, damit alle den Stich & Sieger in Ruhe sehen.
    let trickDelay = (room.settings && typeof room.settings.trickDisplaySeconds === 'number')
      ? room.settings.trickDisplaySeconds * 1000
      : 2500;
    
    // Falls Live-Augen AUS sind und Standard (2.5s) aktiv ist: etwas mehr Zeit zum Mitdenken
    if (room.settings && room.settings.countEyesLive === false && room.settings.trickDisplaySeconds === 2.5) {
      trickDelay = (room.trickCount === 4) ? 5000 : 4000;
    }

    setTimeout(() => {
      resolveTrick(room, result);
    }, trickDelay);
  } else {
    // Nächster Spieler im Uhrzeigersinn ist am Zug
    room.currentTurn = (room.currentTurn + 1) % maxPlayers;
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
 * Berechnet Trinkspiel-Aufgaben basierend auf Spielmodus und Ereignis.
 * Modi: 'light' (Leicht: 1–4 Schlucke), 'medium' (Mittel: 2–8 Schlucke), 'heavy' (Schwer: 4–12 Schlucke)
 * Verlierer trinken immer reine Schlucke.
 */
function calculateDrinkingTask(room, evaluation) {
  const mode = room.settings ? room.settings.drinkingGameMode : null;
  if (!mode || mode === 'none' || mode === false) {
    return null;
  }

  // Modus normalisieren (Kompatibilität mit boolean true)
  const intensity = (mode === 'light' || mode === 'medium' || mode === 'heavy')
    ? mode
    : (mode === true ? 'medium' : 'none');

  if (intensity === 'none') return null;

  const DRINKING_SIPS = {
    light: {
      roundLost: 1,           // Normale Runde verloren
      declarerLost: 2,        // Ansager-Team verliert (+1 Strafpunkt kassiert)
      mitLost: 2,             // Mit' verloren
      contraLost: 3,          // Kontra verloren
      sweepLost: 3,           // Durchmarsch / 0 Stiche kassiert
      matchLost: 4            // Gesamte Partie verloren
    },
    medium: {
      roundLost: 2,           // Normale Runde verloren
      declarerLost: 3,        // Ansager-Team verliert (+1 Strafpunkt kassiert)
      mitLost: 4,             // Mit' verloren
      contraLost: 5,          // Kontra verloren
      sweepLost: 6,           // Durchmarsch / 0 Stiche kassiert
      matchLost: 8            // Gesamte Partie verloren
    },
    heavy: {
      roundLost: 4,           // Normale Runde verloren
      declarerLost: 6,        // Ansager-Team verliert (+1 Strafpunkt kassiert)
      mitLost: 7,             // Mit' verloren
      contraLost: 8,          // Kontra verloren
      sweepLost: 10,          // Durchmarsch / 0 Stiche kassiert
      matchLost: 12           // Gesamte Partie verloren
    }
  };

  const sipsTable = DRINKING_SIPS[intensity] || DRINKING_SIPS.medium;
  const isGameOver = (room.scores.teamA <= 0 || room.scores.teamB <= 0);

  // 1. GESAMTSPIEL VORBEI (Match-Ende: Team mit <= 0 gewinnt)
  if (isGameOver) {
    let winningTeam = 0;
    if (room.scores.teamA <= 0 && room.scores.teamB <= 0) {
      winningTeam = room.scores.teamA < room.scores.teamB ? 0 : 1;
    } else if (room.scores.teamB <= 0) {
      winningTeam = 1;
    } else {
      winningTeam = 0;
    }
    const loserTeamIndex = 1 - winningTeam;
    const loserTeamName = loserTeamIndex === 0 ? 'Team A' : 'Team B';
    const sips = sipsTable.matchLost;
    return `🍾 MATCH VERLOREN! ${loserTeamName} verliert die Partie und trinkt ${sips} Schlucke!`;
  }

  // 2. DURCHMARSCH (5 Stiche gewonnen)
  if (room.tricksTeamA === 5 || room.tricksTeamB === 5) {
    const sweepWinner = room.tricksTeamA === 5 ? 0 : 1;
    const loserTeamIndex = 1 - sweepWinner;
    const loserTeamName = loserTeamIndex === 0 ? 'Team A' : 'Team B';
    const sips = sipsTable.sweepLost;
    if (loserTeamIndex === room.declarerTeam) {
      return `💀 0 STICHE FÜR ANSAGER! ${loserTeamName} kassiert einen Durchmarsch und trinkt ${sips} Schlucke!`;
    }
    return `🍻 DURCHMARSCH! ${loserTeamName} hat 0 Stiche geholt und trinkt ${sips} Schlucke!`;
  }

  // 3. KONTRA VERLOREN
  if (room.isContraAnnounced) {
    const winningTeam = evaluation.winningTeam;
    const loserTeamIndex = 1 - winningTeam;
    const loserTeamName = loserTeamIndex === 0 ? 'Team A' : 'Team B';
    const sips = sipsTable.contraLost;
    return `⚡ KONTRA VERLOREN! ${loserTeamName} zahlt die Zeche und trinkt ${sips} Schlucke!`;
  }

  // 4. MIT' VERLOREN
  if (room.isMitAnnounced && evaluation.winningTeam !== room.declarerTeam) {
    const declarerTeamName = room.declarerTeam === 0 ? 'Team A' : 'Team B';
    const sips = sipsTable.mitLost;
    return `👑 MIT' VERLOREN! ${declarerTeamName} verliert trotz Pik-Dame und trinkt ${sips} Schlucke!`;
  }

  // 5. ANSAGER-TEAM VERLIERT (obwohl Trumpf gewählt + Strafpunkt kassiert)
  if (evaluation.winningTeam !== room.declarerTeam) {
    const declarerTeamName = room.declarerTeam === 0 ? 'Team A' : 'Team B';
    const sips = sipsTable.declarerLost;
    return `🍺 ANSAGE VERPATZT! ${declarerTeamName} verliert trotz Trumpf (+1 Strafpunkt) und trinkt ${sips} Schlucke!`;
  }

  // 6. NORMALE RUNDE VERLOREN (Gegner-Team verliert)
  const winningTeam = evaluation.winningTeam;
  const loserTeamIndex = 1 - winningTeam;
  const loserTeamName = loserTeamIndex === 0 ? 'Team A' : 'Team B';
  const sips = sipsTable.roundLost;
  const sipsWord = sips === 1 ? 'Schluck' : 'Schlucke';
  return `🍺 RUNDE VERLOREN! ${loserTeamName} trinkt ${sips} ${sipsWord}!`;
}

/**
 * Wertet die Runde nach 5 Stichen aus.
 */
function resolveRound(room) {
  const maxPlayers = room.settings.playerCount || 4;
  const evaluation = evaluateRound({
    declarerTeam: room.declarerTeam,
    eyesTeamA: room.eyesTeamA,
    eyesTeamB: room.eyesTeamB,
    tricksTeamA: room.tricksTeamA,
    tricksTeamB: room.tricksTeamB,
    isMitAnnounced: room.isMitAnnounced,
    isContraAnnounced: room.isContraAnnounced,
    options: room.settings
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

  // Trinkspiel-Modus Aufgaben berechnen (wenn aktiviert)
  const drinkingTask = calculateDrinkingTask(room, evaluation);

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
    drinkingTask: drinkingTask,
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
    room.dealerIndex = (room.dealerIndex + 1) % maxPlayers;
  }

  broadcastGameState(room);
}

/**
 * Führt automatische Züge für Bots aus (mit taktischer KI).
 */
function checkBotAction(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }

  const maxPlayers = room.settings.playerCount || 4;
  const turnDelay = (room.settings && typeof room.settings.dealAndTurnDelaySeconds === 'number')
    ? room.settings.dealAndTurnDelaySeconds * 1000
    : 1000;

  if (room.phase === 'CHOOSE_TRUMP') {
    const declarer = room.seats[room.declarerIndex];
    if (declarer && declarer.isBot) {
      room.botTimer = setTimeout(() => {
        const hand = room.hands[room.declarerIndex];
        if (shouldBotTurnTrump(hand, { ...room.settings, playerCount: maxPlayers })) {
          handleTurnTrump(room);
        } else {
          const bestSuit = chooseTrumpSuit(hand, { ...room.settings, playerCount: maxPlayers });
          handleTrumpSelection(room, bestSuit);
        }
      }, turnDelay);
    }
  } else if (room.phase === 'PLAY_TRICK') {
    // 1. Taktische Kontra-Prüfung für gegnerische Bots
    if (room.trickCount === 0 && room.isMitAnnounced && !room.isContraAnnounced) {
      const mitTeam = room.mitHolderIndex !== -1 ? (room.mitHolderIndex % 2 === 0 ? 0 : 1) : -1;
      for (let s = 0; s < maxPlayers; s++) {
        const seat = room.seats[s];
        const sTeam = s % 2 === 0 ? 0 : 1;
        if (seat && seat.isBot && sTeam !== mitTeam) {
          const hand = room.hands[s];
          if (shouldAnnounceContra(hand, room.mitHolderIndex, s, room.trumpSuit, { ...room.settings, playerCount: maxPlayers })) {
            handleContraAnnouncement(room, s);
            break;
          }
        }
      }
    }

    const currentSeat = room.seats[room.currentTurn];
    if (currentSeat && currentSeat.isBot) {
      room.botTimer = setTimeout(() => {
        // 2. Taktische Mit'-Prüfung (in Stich 1, wenn Bot ♠Q hält)
        if (room.settings.allowMit !== false && room.trickCount === 0 && room.mitHolderIndex === room.currentTurn && !room.isMitAnnounced) {
          const botHand = room.hands[room.currentTurn];
          if (shouldAnnounceMit(botHand, room.declarerIndex, room.currentTurn, room.trumpSuit, { ...room.settings, playerCount: maxPlayers })) {
            handleMitAnnouncement(room, room.currentTurn, true);
          }
        }

        // 3. Taktische Kartenauswahl (Schmieren, gezielt Stechen, 0-Punkte Abwurf)
        const hand = room.hands[room.currentTurn];
        if (!hand || hand.length === 0) return;

        const chosenCard = chooseCardToPlay(
          hand,
          room.currentTrick,
          room.trumpSuit,
          room.isMitAnnounced,
          room.currentTurn,
          { ...room.settings, playerCount: maxPlayers }
        );

        if (chosenCard) {
          handleCardPlay(room, room.currentTurn, chosenCard.id);
        }
      }, turnDelay);
    }
  }
}

// Socket.io Verbindungs- und Event-Handling
io.on('connection', (socket) => {
  let currentRoomCode = null;
  let currentSeatIndex = -1;

  // Raum erstellen
  socket.on('create_room', ({ playerName, settings }) => {
    const code = generateRoomCode();
    const room = createRoom(code, playerName || 'Spieler 1', socket.id);
    if (settings) {
      if (settings.playerCount === 6) {
        room.settings.playerCount = 6;
        while (room.seats.length < 6) room.seats.push(null);
      }
      if (typeof settings.countEyesLive === 'boolean') room.settings.countEyesLive = settings.countEyesLive;
      if (typeof settings.alwaysClubQueenTrump === 'boolean') room.settings.alwaysClubQueenTrump = settings.alwaysClubQueenTrump;
      if (typeof settings.allowMit === 'boolean') room.settings.allowMit = settings.allowMit;
      if (settings.contraPoints === 3 || settings.contraPoints === 4) room.settings.contraPoints = settings.contraPoints;
      if (settings.ansagerZeroTricksPenalty === 1 || settings.ansagerZeroTricksPenalty === 2) room.settings.ansagerZeroTricksPenalty = settings.ansagerZeroTricksPenalty;
      if (typeof settings.startScoreA === 'number' && settings.startScoreA >= 1 && settings.startScoreA <= 30) {
        room.settings.startScoreA = Math.round(settings.startScoreA);
        room.scores.teamA = room.settings.startScoreA;
      }
      if (typeof settings.startScoreB === 'number' && settings.startScoreB >= 1 && settings.startScoreB <= 30) {
        room.settings.startScoreB = Math.round(settings.startScoreB);
        room.scores.teamB = room.settings.startScoreB;
      }
      if (typeof settings.drinkingGameMode === 'string' && ['none', 'light', 'medium', 'heavy'].includes(settings.drinkingGameMode)) {
        room.settings.drinkingGameMode = settings.drinkingGameMode;
      } else if (typeof settings.drinkingGameMode === 'boolean') {
        room.settings.drinkingGameMode = settings.drinkingGameMode ? 'medium' : 'none';
      }
      if (typeof settings.trickDisplaySeconds === 'number' && settings.trickDisplaySeconds >= 0.8 && settings.trickDisplaySeconds <= 8) {
        room.settings.trickDisplaySeconds = Math.round(settings.trickDisplaySeconds * 10) / 10;
      }
      if (typeof settings.dealAndTurnDelaySeconds === 'number' && settings.dealAndTurnDelaySeconds >= 0.3 && settings.dealAndTurnDelaySeconds <= 6) {
        room.settings.dealAndTurnDelaySeconds = Math.round(settings.dealAndTurnDelaySeconds * 10) / 10;
      }
    }
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

    // Freien Platz oder Bot-Platz suchen (auch im laufenden Spiel Hot-Swap!)
    const maxPlayers = room.settings.playerCount || 4;
    let targetSeat = -1;
    if (typeof preferredSeat === 'number' && preferredSeat >= 0 && preferredSeat < maxPlayers && (!room.seats[preferredSeat] || room.seats[preferredSeat].isBot)) {
      targetSeat = preferredSeat;
    } else {
      // 1. Zuerst komplett leere Plätze suchen
      targetSeat = room.seats.findIndex((s, idx) => idx < maxPlayers && s === null);
      // 2. Falls keine leeren Plätze: Bot-Plätze übernehmen (Hot-Swap)
      if (targetSeat === -1) {
        targetSeat = room.seats.findIndex((s, idx) => idx < maxPlayers && s && s.isBot);
      }
    }

    if (targetSeat === -1) {
      return socket.emit('error_message', `Dieser Raum ist bereits voll (${maxPlayers} echte Spieler).`);
    }

    const previousSeat = room.seats[targetSeat];
    const isReplacingBot = previousSeat && previousSeat.isBot;
    const oldBotName = isReplacingBot ? previousSeat.name : '';

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

    if (isReplacingBot && room.phase !== 'LOBBY') {
      logAction(room, `🎉 ${newSeat.name} ist dem laufenden Spiel beigetreten und hat ${oldBotName} ersetzt!`);
      if (room.currentTurn === targetSeat && room.botTimer) {
        clearTimeout(room.botTimer);
        room.botTimer = null;
      }
    } else {
      logAction(room, `${newSeat.name} ist Platz ${targetSeat + 1} beigetreten.`);
    }

    broadcastGameState(room);
    checkBotAction(room);
  });

  // Reconnect nach kurzem Browser-Refresh / Verbindungsabbruch
  socket.on('reconnect_player', ({ roomCode, playerName, seatIndex }) => {
    if (!roomCode) return;
    const code = roomCode.toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return;

    const maxPlayers = room.settings.playerCount || 4;
    if (typeof seatIndex === 'number' && seatIndex >= 0 && seatIndex < maxPlayers) {
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
    const maxPlayers = room.settings.playerCount || 4;
    if (targetSeat < 0 || targetSeat >= maxPlayers) return;
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
    const maxPlayers = room.settings.playerCount || 4;
    if (seatIndex < 0 || seatIndex >= maxPlayers) return;
    if (room.seats[seatIndex]) return;

    const botName = getRandomBotName(room);

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
    const maxPlayers = room.settings.playerCount || 4;
    if (seatIndex < 0 || seatIndex >= maxPlayers) return;
    if (room.seats[seatIndex] && room.seats[seatIndex].isBot) {
      logAction(room, `${room.seats[seatIndex].name} entfernt.`);
      room.seats[seatIndex] = null;
      broadcastGameState(room);
    }
  });

  // Spieleinstellungen aktualisieren (Host in der Lobby)
  socket.on('update_settings', ({ settings }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') {
      return socket.emit('error_message', 'Regeln können nur in der Lobby vor Spielstart angepasst werden.');
    }

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann die Spieleinstellungen ändern.');
    }

    if (settings) {
      if (settings.playerCount === 4 || settings.playerCount === 6) {
        const oldPlayerCount = room.settings.playerCount || 4;
        const newPlayerCount = settings.playerCount;
        room.settings.playerCount = newPlayerCount;
        if (newPlayerCount > oldPlayerCount) {
          while (room.seats.length < newPlayerCount) {
            room.seats.push(null);
          }
        } else if (newPlayerCount < oldPlayerCount) {
          while (room.seats.length > newPlayerCount) {
            const removedSeat = room.seats.pop();
            if (removedSeat && !removedSeat.isBot && removedSeat.socketId) {
              io.to(removedSeat.socketId).emit('left_room');
            }
          }
        }
      }
      if (typeof settings.countEyesLive === 'boolean') room.settings.countEyesLive = settings.countEyesLive;
      if (typeof settings.alwaysClubQueenTrump === 'boolean') room.settings.alwaysClubQueenTrump = settings.alwaysClubQueenTrump;
      if (typeof settings.allowMit === 'boolean') room.settings.allowMit = settings.allowMit;
      if (settings.contraPoints === 3 || settings.contraPoints === 4) room.settings.contraPoints = settings.contraPoints;
      if (settings.ansagerZeroTricksPenalty === 1 || settings.ansagerZeroTricksPenalty === 2) room.settings.ansagerZeroTricksPenalty = settings.ansagerZeroTricksPenalty;
      if (typeof settings.startScoreA === 'number' && settings.startScoreA >= 1 && settings.startScoreA <= 30) {
        room.settings.startScoreA = Math.round(settings.startScoreA);
        room.scores.teamA = room.settings.startScoreA;
      }
      if (typeof settings.startScoreB === 'number' && settings.startScoreB >= 1 && settings.startScoreB <= 30) {
        room.settings.startScoreB = Math.round(settings.startScoreB);
        room.scores.teamB = room.settings.startScoreB;
      }
      if (typeof settings.drinkingGameMode === 'string' && ['none', 'light', 'medium', 'heavy'].includes(settings.drinkingGameMode)) {
        room.settings.drinkingGameMode = settings.drinkingGameMode;
      } else if (typeof settings.drinkingGameMode === 'boolean') {
        room.settings.drinkingGameMode = settings.drinkingGameMode ? 'medium' : 'none';
      }
      if (typeof settings.trickDisplaySeconds === 'number' && settings.trickDisplaySeconds >= 0.8 && settings.trickDisplaySeconds <= 8) {
        room.settings.trickDisplaySeconds = Math.round(settings.trickDisplaySeconds * 10) / 10;
      }
      if (typeof settings.dealAndTurnDelaySeconds === 'number' && settings.dealAndTurnDelaySeconds >= 0.3 && settings.dealAndTurnDelaySeconds <= 6) {
        room.settings.dealAndTurnDelaySeconds = Math.round(settings.dealAndTurnDelaySeconds * 10) / 10;
      }
    }

    logAction(room, `⚙️ Spieleinstellungen aktualisiert durch ${room.seats[currentSeatIndex] ? room.seats[currentSeatIndex].name : 'Host'}.`);
    broadcastGameState(room);
  });

  // Spiel starten
  socket.on('start_game', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'LOBBY') return;

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann das Spiel starten.');
    }

    const maxPlayers = room.settings.playerCount || 4;
    const occupiedSeats = room.seats.slice(0, maxPlayers).filter(s => s !== null).length;
    if (occupiedSeats < maxPlayers) {
      return socket.emit('error_message', `Es werden genau ${maxPlayers} Spieler oder Bots benötigt.`);
    }

    room.scores = {
      teamA: room.settings.startScoreA || 13,
      teamB: room.settings.startScoreB || 13
    };
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

  // Trumpf drehen (Blindes Umdrehen einer der restlichen 2 Karten)
  socket.on('turn_trump', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'CHOOSE_TRUMP') return;
    if (room.declarerIndex !== currentSeatIndex) return;

    handleTurnTrump(room);
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

  // Nächste Runde starten (Nur Host / Spielleiter)
  socket.on('next_round', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'ROUND_END') return;

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann die nächste Runde starten.');
    }

    startNewRound(room);
  });

  // Spiel neu starten (Nur Host / Spielleiter)
  socket.on('restart_game', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room || room.phase !== 'GAME_OVER') return;

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann ein neues Spiel starten.');
    }

    room.scores = {
      teamA: room.settings.startScoreA || 13,
      teamB: room.settings.startScoreB || 13
    };
    room.roundNumber = 0;
    room.dealerIndex = 0;
    startNewRound(room);
  });

  // Lobby oder aktives Spiel verlassen (im Spiel nahtlos durch Bot ersetzt)
  const handlePlayerLeave = () => {
    if (!currentRoomCode || currentSeatIndex === -1) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    const player = room.seats[currentSeatIndex];
    const playerName = player ? player.name : 'Ein Spieler';
    const leavingSeat = currentSeatIndex;
    const isHost = isPlayerHost(room, socket);

    if (room.phase === 'LOBBY') {
      if (isHost) {
        // Prüfen, ob noch andere menschliche Spieler in der Lobby sind
        const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.index !== leavingSeat);
        if (nextHuman) {
          room.seats[leavingSeat] = null;
          room.hostSocketId = nextHuman.socketId;
          logAction(room, `🚪 ${playerName} hat die Lobby verlassen. Neuer Spielleiter: ${nextHuman.name}`);
          socket.leave(currentRoomCode);
          socket.emit('left_room');
          broadcastGameState(room);
        } else {
          logAction(room, `🚪 Spielleiter hat den Raum verlassen. Die Lobby wurde aufgelöst.`);
          io.to(currentRoomCode).emit('room_disbanded', { message: 'Der Spielleiter hat die Lobby verlassen.' });
          rooms.delete(currentRoomCode);
          socket.leave(currentRoomCode);
          socket.emit('left_room');
        }
      } else {
        room.seats[leavingSeat] = null;
        logAction(room, `🚪 ${playerName} hat die Lobby verlassen.`);
        socket.leave(currentRoomCode);
        socket.emit('left_room');
        broadcastGameState(room);
      }
    } else {
      // Im aktiven Spiel: Spieler nahtlos durch Bot ersetzen!
      const newBotName = getRandomBotName(room);
      room.seats[leavingSeat] = {
        index: leavingSeat,
        name: newBotName,
        socketId: null,
        isBot: true,
        connected: true,
        team: leavingSeat % 2 === 0 ? 0 : 1
      };

      logAction(room, `🚪 ${playerName} hat das Spiel verlassen und wurde durch ${newBotName} ersetzt.`);

      // Falls der Spieler Host war, Host-Rolle weitergeben an nächsten Menschen
      if (isHost) {
        const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.index !== leavingSeat);
        if (nextHuman) {
          room.hostSocketId = nextHuman.socketId;
          logAction(room, `👑 ${nextHuman.name} ist nun der neue Spielleiter.`);
        }
      }

      socket.leave(currentRoomCode);
      socket.emit('left_room');
      broadcastGameState(room);

      // Falls der gehende Spieler am Zug war: Bot zieht sofort
      checkBotAction(room);
    }

    currentRoomCode = null;
    currentSeatIndex = -1;
  };

  socket.on('leave_room', handlePlayerLeave);
  socket.on('leave_game', handlePlayerLeave);

  // Zurück zur Lobby (während des Spiels, nur für den Spielleiter)
  socket.on('return_to_lobby', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann die Partie beenden und zur Lobby zurückkehren.');
    }

    if (room.botTimer) {
      clearTimeout(room.botTimer);
      room.botTimer = null;
    }

    const maxPlayers = room.settings.playerCount || 4;
    room.phase = 'LOBBY';
    room.currentTrick = [];
    room.trickCount = 0;
    room.hands = Array(maxPlayers).fill(null).map(() => []);
    room.stock = [];
    room.turnedCard = null;
    room.trumpSuit = null;
    room.isMitAnnounced = false;
    room.isContraAnnounced = false;
    room.mitHolderIndex = -1;
    room.lastTrick = null;
    room.trickWinnerInfo = null;
    room.roundSummary = null;
    room.roundNumber = 0;
    room.dealerIndex = 0;
    room.scores = {
      teamA: room.settings.startScoreA || 13,
      teamB: room.settings.startScoreB || 13
    };

    logAction(room, `🏠 ${room.seats[currentSeatIndex] ? room.seats[currentSeatIndex].name : 'Spielleiter'} hat die Partie beendet. Alle Spieler sind zurück in der Lobby.`);
    broadcastGameState(room);
  });

  // Spieler durch den Spielleiter kicken (wird sofort durch Bot ersetzt)
  socket.on('kick_player', ({ targetSeat }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    if (!isPlayerHost(room, socket)) {
      return socket.emit('error_message', 'Nur der Spielleiter kann Spieler kicken.');
    }

    const maxPlayers = room.settings.playerCount || 4;
    if (typeof targetSeat !== 'number' || targetSeat < 0 || targetSeat >= maxPlayers) return;
    if (targetSeat === currentSeatIndex) {
      return socket.emit('error_message', 'Der Spielleiter kann sich nicht selbst kicken.');
    }

    const targetPlayer = room.seats[targetSeat];
    if (!targetPlayer) return;

    const kickedName = targetPlayer.name;
    const kickedSocketId = targetPlayer.socketId;
    const newBotName = getRandomBotName(room);

    room.seats[targetSeat] = {
      index: targetSeat,
      name: newBotName,
      socketId: null,
      isBot: true,
      connected: true,
      team: targetSeat % 2 === 0 ? 0 : 1
    };

    logAction(room, `👢 ${kickedName} wurde vom Spielleiter entfernt und durch ${newBotName} ersetzt.`);

    if (kickedSocketId) {
      io.to(kickedSocketId).emit('kicked_from_room', { message: 'Du wurdest vom Spielleiter aus der Partie entfernt.' });
    }

    broadcastGameState(room);
    checkBotAction(room);
  });

  // Clash Royale Ragebait Emotes senden
  socket.on('send_emote', ({ emote }) => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    if (typeof emote !== 'string') return;

    const now = Date.now();
    if (socket.lastEmoteTime && now - socket.lastEmoteTime < 700) {
      return;
    }
    socket.lastEmoteTime = now;

    const cleanEmote = emote.slice(0, 8);
    io.to(currentRoomCode).emit('player_emote', {
      seatIndex: currentSeatIndex,
      emote: cleanEmote
    });
  });

  // Trennung behandeln
  socket.on('disconnect', () => {
    if (currentRoomCode && currentSeatIndex !== -1) {
      const room = rooms.get(currentRoomCode);
      if (room && room.seats[currentSeatIndex]) {
        room.seats[currentSeatIndex].connected = false;
        const playerName = room.seats[currentSeatIndex].name;
        logAction(room, `${playerName} hat die Verbindung getrennt.`);

        // Wenn der Spielleiter die Verbindung trennt, Host sofort an den nächsten aktiven Menschen übertragen!
        if (room.hostSocketId === socket.id) {
          const nextHuman = room.seats.find(s => s && !s.isBot && s.socketId && s.connected !== false && s.index !== currentSeatIndex);
          if (nextHuman) {
            room.hostSocketId = nextHuman.socketId;
            logAction(room, `👑 ${nextHuman.name} übernimmt die Spielleitung.`);
          }
        }

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
