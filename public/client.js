/* ==========================================================================
   COUILLON - CLIENT APPLICATION (WIR vs SIE, BELGIAN SVG & TRICK INSPECTOR)
   ========================================================================== */

const socket = io({
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 1000
});

// Lokaler Client-Status
let currentRoomCode = null;
let mySeatIndex = -1;
let gameState = null;
let soundEnabled = true;
let svgSpriteLoaded = false;

// Audio-Synthesizer via Web Audio API (Lazy Init on Mobile)
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      try {
        audioCtx = new AudioContextClass();
      } catch (e) {
        console.warn('AudioContext init failed:', e);
      }
    }
  }
  return audioCtx;
}

function playSound(type) {
  if (!soundEnabled) return;
  const ctx = getAudioContext();
  if (!ctx) return;
  try {
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const now = ctx.currentTime;

    if (type === 'card_play') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.exponentialRampToValueAtTime(110, now + 0.08);
      gain.gain.setValueAtTime(0.3, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.08);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'trick_won') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523.25, now);
      osc.frequency.setValueAtTime(659.25, now + 0.08);
      osc.frequency.setValueAtTime(783.99, now + 0.16);
      gain.gain.setValueAtTime(0.2, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.28);
    } else if (type === 'trump_fanfare') {
      [587.33, 739.99, 880].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.1);
        gain.gain.setValueAtTime(0.25, now + i * 0.1);
        gain.gain.linearRampToValueAtTime(0.01, now + i * 0.1 + 0.2);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.1);
        osc.stop(now + i * 0.1 + 0.2);
      });
    } else if (type === 'turn') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.1);
      gain.gain.setValueAtTime(0.15, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'victory') {
      [523.25, 659.25, 783.99, 1046.50].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, now + i * 0.15);
        gain.gain.setValueAtTime(0.3, now + i * 0.15);
        gain.gain.linearRampToValueAtTime(0.01, now + i * 0.15 + 0.4);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + i * 0.15);
        osc.stop(now + i * 0.15 + 0.4);
      });
    }
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

// SVG Sprite Loader
async function initSvgSprite() {
  try {
    const res = await fetch('svg-cards.svg');
    const text = await res.text();
    let container = document.getElementById('svgSpriteContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'svgSpriteContainer';
      container.style.display = 'none';
      document.body.appendChild(container);
    }
    container.innerHTML = text;
    svgSpriteLoaded = true;
    if (gameState) renderUI();
  } catch (err) {
    console.error('Failed to load Belgian SVG sprite:', err);
  }
}

// --------------------------------------------------------------------------
// DOM & EVENT INITIALISIERUNG
// --------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initSvgSprite();
  setupEventListeners();
  checkUrlParams();
});

function setupEventListeners() {
  document.getElementById('createRoomBtn').addEventListener('click', handleCreateRoom);
  document.getElementById('joinRoomBtn').addEventListener('click', handleJoinRoom);
  document.getElementById('startGameBtn').addEventListener('click', handleStartGame);
  document.getElementById('fillBotsBtn').addEventListener('click', handleFillBots);
  document.getElementById('copyInviteBtn').addEventListener('click', copyInviteLink);

  document.getElementById('soundToggleBtn').addEventListener('click', () => {
    soundEnabled = !soundEnabled;
    document.getElementById('soundToggleBtn').textContent = soundEnabled ? '🔊' : '🔇';
    showToast(soundEnabled ? 'Ton aktiviert' : 'Ton stummgeschaltet');
  });

  document.getElementById('logToggleBtn').addEventListener('click', () => {
    document.getElementById('sideDrawer').classList.toggle('open');
    document.getElementById('chatBadge').classList.add('hidden');
    document.getElementById('chatBadge').textContent = '0';
  });

  document.getElementById('closeDrawerBtn').addEventListener('click', () => {
    document.getElementById('sideDrawer').classList.remove('open');
  });

  document.getElementById('roomCodeInput').addEventListener('keyup', (e) => {
    if (e.key === 'Enter') handleJoinRoom();
  });
}

function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room');
  if (room) {
    document.getElementById('roomCodeInput').value = room.toUpperCase();
  }
}

function getPlayerName() {
  const input = document.getElementById('playerNameInput');
  return (input.value || '').trim() || 'Spieler ' + Math.floor(Math.random() * 100);
}

function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

// --------------------------------------------------------------------------
// LOBBY & RAUM-AKTIONEN
// --------------------------------------------------------------------------
function handleCreateRoom() {
  const playerName = getPlayerName();
  socket.emit('create_room', { playerName });
}

function handleJoinRoom() {
  const codeInput = document.getElementById('roomCodeInput');
  const code = codeInput.value.trim().toUpperCase();
  if (!code) {
    return showToast('Bitte gib einen Raumcode ein.');
  }
  const playerName = getPlayerName();
  socket.emit('join_room', { roomCode: code, playerName });
}

function copyInviteLink() {
  if (!currentRoomCode) return;
  const inviteUrl = `${window.location.origin}${window.location.pathname}?room=${currentRoomCode}`;
  navigator.clipboard.writeText(inviteUrl).then(() => {
    const msg = document.getElementById('copySuccessMsg');
    msg.classList.remove('hidden');
    setTimeout(() => msg.classList.add('hidden'), 2500);
  }).catch(() => {
    showToast(`Einladungslink: ${inviteUrl}`);
  });
}

function switchSeat(seatIndex) {
  socket.emit('switch_seat', { targetSeat: seatIndex });
}

function toggleBot(seatIndex) {
  if (!gameState) return;
  const seat = gameState.players[seatIndex];
  if (seat && seat.isBot) {
    socket.emit('remove_bot', { seatIndex });
  } else if (!seat) {
    socket.emit('add_bot', { seatIndex });
  }
}

function handleFillBots() {
  if (!gameState) return;
  for (let i = 0; i < 4; i++) {
    if (!gameState.players[i]) {
      socket.emit('add_bot', { seatIndex: i });
    }
  }
}

function handleStartGame() {
  socket.emit('start_game');
}

// --------------------------------------------------------------------------
// SPIEL-AKTIONEN
// --------------------------------------------------------------------------
function chooseTrump(suit) {
  socket.emit('select_trump', { suit });
  document.getElementById('trumpModal').classList.add('hidden');
  playSound('trump_fanfare');
}

function announceMit(announce) {
  socket.emit('announce_mit', { announce });
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
  if (announce) playSound('trump_fanfare');
}

function dismissMitBanner() {
  const banner = document.getElementById('mitActionBanner');
  if (banner) banner.classList.add('hidden');
}

function announceContra() {
  socket.emit('announce_contra');
  const btn = document.getElementById('announceContraBtn');
  if (btn) btn.classList.add('hidden');
  playSound('trump_fanfare');
}

function playCard(cardId) {
  if (!gameState) return;
  if (gameState.phase !== 'PLAY_TRICK') return;
  if (gameState.currentTurn !== mySeatIndex) return;

  const isPlayable = gameState.you.playableMap[cardId];
  if (!isPlayable) {
    showToast('Diese Karte darf gemäß Stichregeln nicht gespielt werden!');
    return;
  }

  socket.emit('play_card', { cardId });
  playSound('card_play');
}

function nextRound() {
  socket.emit('next_round');
  document.getElementById('roundSummaryModal').classList.add('hidden');
}

function restartGame() {
  socket.emit('restart_game');
  document.getElementById('gameOverModal').classList.add('hidden');
}

function openLastTrickModal() {
  if (!gameState || !gameState.lastTrick) {
    return showToast('In dieser Runde wurde noch kein Stich gespielt.');
  }

  const lt = gameState.lastTrick;
  const myTeam = gameState.you ? gameState.you.team : 0;
  const winnerTeam = lt.winnerIndex % 2 === 0 ? 0 : 1;
  const isWe = (winnerTeam === myTeam);

  document.getElementById('lastTrickHeaderTag').textContent = `Stich #${lt.trickNumber}`;
  document.getElementById('lastTrickHeaderTitle').textContent = `Stich #${lt.trickNumber} Übersicht`;
  document.getElementById('lastTrickWinnerNote').textContent = 
    `Gewonnen von ${lt.winnerName} (${isWe ? 'WIR' : 'SIE'}) • ${lt.points} Augen im Stich`;

  const grid = document.getElementById('lastTrickCardsGrid');
  grid.innerHTML = '';

  lt.cards.forEach(entry => {
    const isWinnerCard = (entry.playerIndex === lt.winnerIndex);
    const cardHTML = createCardHTML(entry.card, false, true);
    
    grid.innerHTML += `
      <div class="last-trick-card-entry ${isWinnerCard ? 'winner' : ''}">
        <span class="last-trick-player-label">${entry.playerName}${isWinnerCard ? ' 🏆' : ''}</span>
        ${cardHTML}
      </div>
    `;
  });

  document.getElementById('lastTrickModal').classList.remove('hidden');
}

function closeLastTrickModal() {
  document.getElementById('lastTrickModal').classList.add('hidden');
}

function switchDrawerTab(tab) {
  document.getElementById('tabLog').classList.toggle('active', tab === 'log');
  document.getElementById('tabChat').classList.toggle('active', tab === 'chat');
  document.getElementById('logPanel').classList.toggle('active', tab === 'log');
  document.getElementById('chatPanel').classList.toggle('active', tab === 'chat');
}

function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (msg) {
    socket.emit('send_chat', { message: msg });
    input.value = '';
  }
}

// --------------------------------------------------------------------------
// SOCKET.IO EVENT-HANDLER & AUTO-RECONNECT
// --------------------------------------------------------------------------
socket.on('connect', () => {
  console.log('Connected to Kujong Server.');
  const savedSession = sessionStorage.getItem('kujong_session');
  if (savedSession) {
    try {
      const { roomCode, playerName, seatIndex } = JSON.parse(savedSession);
      if (roomCode) {
        socket.emit('reconnect_player', { roomCode, playerName, seatIndex });
      }
    } catch (e) {}
  }
});

socket.on('room_created', ({ roomCode, seatIndex }) => {
  currentRoomCode = roomCode;
  mySeatIndex = seatIndex;
  document.getElementById('lobbyInitialOptions').classList.add('hidden');
  document.getElementById('lobbyWaitingRoom').classList.remove('hidden');
  document.getElementById('displayRoomCode').textContent = roomCode;

  const pName = getPlayerName();
  sessionStorage.setItem('kujong_session', JSON.stringify({
    roomCode: roomCode,
    playerName: pName,
    seatIndex: seatIndex
  }));
});

socket.on('game_state', (state) => {
  const previousPhase = gameState ? gameState.phase : null;
  const previousTurn = gameState ? gameState.currentTurn : null;
  const previousTrickCount = gameState ? gameState.trickCount : 0;

  gameState = state;
  mySeatIndex = state.you.seatIndex;
  currentRoomCode = state.roomCode;

  // Sitzung für Reconnection bei Verbindungsabbrüchen speichern
  const myPlayer = state.players[state.you.seatIndex];
  if (myPlayer) {
    sessionStorage.setItem('kujong_session', JSON.stringify({
      roomCode: state.roomCode,
      playerName: myPlayer.name,
      seatIndex: state.you.seatIndex
    }));
  }

  // Sound-Effekte bei Phasen-/Zugwechsel
  if (state.phase === 'PLAY_TRICK' && state.currentTurn === mySeatIndex && previousTurn !== mySeatIndex) {
    playSound('turn');
  }
  if (state.trickCount > previousTrickCount) {
    playSound('trick_won');
  }

  renderUI();
});

socket.on('error_message', (msg) => {
  showToast(msg);
});

// --------------------------------------------------------------------------
// UI-RENDERING (WIR vs SIE & BELGISCHE SVG KARTEN)
// --------------------------------------------------------------------------
function renderUI() {
  if (!gameState) return;

  if (gameState.phase === 'LOBBY') {
    document.getElementById('lobbyScreen').classList.add('active');
    document.getElementById('gameScreen').classList.remove('active');
    renderLobby();
  } else {
    document.getElementById('lobbyScreen').classList.remove('active');
    document.getElementById('gameScreen').classList.add('active');
    renderGameScreen();
  }

  handleModals();
}

function renderLobby() {
  document.getElementById('lobbyInitialOptions').classList.add('hidden');
  document.getElementById('lobbyWaitingRoom').classList.remove('hidden');
  document.getElementById('displayRoomCode').textContent = gameState.roomCode;

  let totalOccupied = 0;
  for (let i = 0; i < 4; i++) {
    const slotEl = document.getElementById(`seatSlot${i}`);
    const seat = gameState.players[i];
    const nameEl = slotEl.querySelector('.player-name');
    const joinBtn = slotEl.querySelector('.btn-seat-join');
    const botBtn = slotEl.querySelector('.btn-seat-bot');

    if (seat) {
      totalOccupied++;
      const isMe = (i === mySeatIndex);
      nameEl.textContent = `${seat.name}${isMe ? ' (Du)' : ''}`;
      nameEl.style.color = isMe ? 'var(--team-we-gold)' : '#fff';
      joinBtn.classList.add('hidden');
      botBtn.textContent = seat.isBot ? '✕ Bot' : '';
      botBtn.classList.toggle('hidden', !seat.isBot);
    } else {
      nameEl.textContent = 'Frei';
      nameEl.style.color = 'var(--text-muted)';
      joinBtn.classList.remove('hidden');
      botBtn.textContent = '+ Bot';
      botBtn.classList.remove('hidden');
    }
  }

  const startBtn = document.getElementById('startGameBtn');
  if (gameState.you.isHost) {
    startBtn.classList.remove('hidden');
    if (totalOccupied === 4) {
      startBtn.disabled = false;
      startBtn.textContent = '🎮 Spiel jetzt starten!';
    } else {
      startBtn.disabled = true;
      startBtn.textContent = `⏳ Warte auf 4 Spieler (${totalOccupied}/4)...`;
    }
  } else {
    startBtn.classList.remove('hidden');
    startBtn.disabled = true;
    startBtn.textContent = 'Warte auf Spielleiter...';
  }
}

function renderGameScreen() {
  const myTeam = gameState.you ? gameState.you.team : 0;
  // Team 0 = Team A, Team 1 = Team B

  // Punktestände und Stats für WIR und SIE
  const scoreWe = myTeam === 0 ? gameState.scores.teamA : gameState.scores.teamB;
  const scoreThey = myTeam === 0 ? gameState.scores.teamB : gameState.scores.teamA;

  const tricksWe = myTeam === 0 ? gameState.tricksTeamA : gameState.tricksTeamB;
  const tricksThey = myTeam === 0 ? gameState.tricksTeamB : gameState.tricksTeamA;

  const eyesWe = myTeam === 0 ? gameState.eyesTeamA : gameState.eyesTeamB;
  const eyesThey = myTeam === 0 ? gameState.eyesTeamB : gameState.eyesTeamA;

  // Header Scoreboard
  document.getElementById('scoreWe').textContent = scoreWe;
  document.getElementById('scoreThey').textContent = scoreThey;
  document.getElementById('tricksWe').textContent = tricksWe;
  document.getElementById('tricksThey').textContent = tricksThey;
  document.getElementById('eyesWe').textContent = eyesWe;
  document.getElementById('eyesThey').textContent = eyesThey;

  // Won Tricks Piles (Ecken)
  renderWonTricksPile('We', tricksWe);
  renderWonTricksPile('They', tricksThey);

  // Letzter Stich Button Sichtbarkeit
  const viewLastTrickBtn = document.getElementById('viewLastTrickBtn');
  if (gameState.lastTrick) {
    viewLastTrickBtn.classList.remove('hidden');
  } else {
    viewLastTrickBtn.classList.add('hidden');
  }

  // Runde & Trumpf-Badge
  document.getElementById('roundNumberDisplay').textContent = gameState.roundNumber;
  const trumpBadge = document.getElementById('trumpBadge');
  const mitBadge = document.getElementById('mitBadge');

  if (gameState.trumpSuit) {
    const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
    const suitNames = { clubs: 'KREUZ', spades: 'PIK', hearts: 'HERZ', diamonds: 'KARO' };
    trumpBadge.className = `trump-badge suit-${gameState.trumpSuit}`;
    trumpBadge.querySelector('.trump-icon').textContent = suitIcons[gameState.trumpSuit];
    trumpBadge.querySelector('.trump-text').textContent = suitNames[gameState.trumpSuit];
  } else {
    trumpBadge.className = 'trump-badge suit-none';
    trumpBadge.querySelector('.trump-icon').textContent = '?';
    trumpBadge.querySelector('.trump-text').textContent = 'Wahl...';
  }

  mitBadge.classList.toggle('hidden', !gameState.isMitAnnounced);
  
  const contraBadge = document.getElementById('contraBadge');
  if (contraBadge) contraBadge.classList.toggle('hidden', !gameState.isContraAnnounced);

  const announceContraBtn = document.getElementById('announceContraBtn');
  if (announceContraBtn) announceContraBtn.classList.toggle('hidden', !gameState.canAnnounceContra);

  // Status Ticker
  renderStatusTicker();

  // Spieler am Tisch rendern (relativ zur eigenen Position)
  renderTablePlayers();

  // Stich im Zentrum rendern
  renderTrickCenter();

  // Eigene Handkarten rendern
  renderMyHand();

  // Chat & Protokoll
  renderDrawerContent();
}

function renderWonTricksPile(teamKey, trickCount) {
  const stack = document.getElementById(`pileStack${teamKey}`);
  const count = document.getElementById(`pileCount${teamKey}`);

  count.textContent = `${trickCount} ${trickCount === 1 ? 'Stich' : 'Stiche'}`;
  stack.innerHTML = '';

  for (let i = 0; i < trickCount; i++) {
    const offset = i * 3;
    const mini = document.createElement('div');
    mini.className = 'pile-mini-card';
    mini.style.left = `${offset}px`;
    mini.style.top = `${offset}px`;
    stack.appendChild(mini);
  }
}

function renderStatusTicker() {
  const ticker = document.getElementById('statusMessage');
  const myTeam = gameState.you ? gameState.you.team : 0;

  if (gameState.phase === 'CHOOSE_TRUMP') {
    const declarer = gameState.players[gameState.declarerIndex];
    const isMe = (gameState.declarerIndex === mySeatIndex);
    ticker.textContent = isMe ? 'Du wählst die Trumpffarbe...' : `${declarer ? declarer.name : 'Ansager'} wählt Trumpf...`;
  } else if (gameState.phase === 'PLAY_TRICK') {
    const currentTurnPlayer = gameState.players[gameState.currentTurn];
    if (gameState.currentTurn === mySeatIndex) {
      ticker.textContent = '⚡ Du bist am Zug!';
    } else {
      ticker.textContent = `${currentTurnPlayer ? currentTurnPlayer.name : 'Spieler'} ist am Zug...`;
    }
  } else if (gameState.phase === 'EVALUATING_TRICK') {
    ticker.textContent = 'Stich wird ausgewertet...';
  } else if (gameState.phase === 'ROUND_END') {
    ticker.textContent = 'Runde beendet!';
  } else if (gameState.phase === 'GAME_OVER') {
    ticker.textContent = 'Partie entschieden!';
  }
}

function renderTablePlayers() {
  // Relative Sitze:
  // Bottom: mySeatIndex (Du)
  // Left: (mySeatIndex + 1) % 4
  // Top: (mySeatIndex + 2) % 4 (Partner)
  // Right: (mySeatIndex + 3) % 4
  const myTeam = gameState.you ? gameState.you.team : 0;
  const suitIcons = { clubs: '♣', spades: '♠', hearts: '♥', diamonds: '♦' };
  const trumpText = gameState.trumpSuit ? ` ${suitIcons[gameState.trumpSuit]}` : '';

  const positions = [
    { key: 'Bottom', seatIdx: mySeatIndex },
    { key: 'Left', seatIdx: (mySeatIndex + 1) % 4 },
    { key: 'Top', seatIdx: (mySeatIndex + 2) % 4 },
    { key: 'Right', seatIdx: (mySeatIndex + 3) % 4 }
  ];

  positions.forEach(({ key, seatIdx }) => {
    const player = gameState.players[seatIdx];
    if (!player) return;

    const isMe = (seatIdx === mySeatIndex);
    const isPartner = (key === 'Top');
    const isWe = (player.team === myTeam);

    // Name & Ansager-Pill
    const nameEl = document.getElementById(`name${key}`);
    const declarerPill = document.getElementById(`declarerPill${key}`);

    if (nameEl) {
      nameEl.textContent = isMe ? `${player.name} (Du)` : player.name;
    }

    if (declarerPill) {
      if (player.isDeclarer) {
        declarerPill.classList.remove('hidden');
        declarerPill.textContent = '👑 Ansager';
      } else {
        declarerPill.classList.add('hidden');
      }
    }

    // Team Tag (nur 'WIR' oder 'SIE')
    const tagEl = document.getElementById(`tag${key}`);
    if (tagEl) {
      tagEl.textContent = isWe ? 'WIR' : 'SIE';
      tagEl.className = `team-tag ${isWe ? 'tag-we' : 'tag-they'}`;
    }

    // Geber Badge
    const dealerBadge = document.getElementById(`dealer${key}`);
    if (dealerBadge) dealerBadge.classList.toggle('hidden', !player.isDealer);

    // Turn Glow am Avatar
    const playerBox = document.getElementById(`player${key}`);
    const avatarBox = playerBox ? playerBox.querySelector('.player-avatar-box') : null;
    if (avatarBox) {
      avatarBox.classList.toggle('player-turn-glow', player.isTurn);
    }

    // Mini Card Backs für Gegner & Partner
    if (key !== 'Bottom') {
      const cardsContainer = document.getElementById(`cards${key}`);
      if (cardsContainer) {
        cardsContainer.innerHTML = '';
        for (let c = 0; c < player.cardCount; c++) {
          const mini = document.createElement('div');
          mini.className = 'mini-card-back';
          cardsContainer.appendChild(mini);
        }
      }
    }
  });

  // Turn Indicator für Spieler unten
  const isMyTurn = (gameState.currentTurn === mySeatIndex && gameState.phase === 'PLAY_TRICK');
  document.getElementById('turnIndicator').classList.toggle('hidden', !isMyTurn);
}

function renderTrickCenter() {
  const slotMap = {
    [mySeatIndex]: 'Bottom',
    [(mySeatIndex + 1) % 4]: 'Left',
    [(mySeatIndex + 2) % 4]: 'Top',
    [(mySeatIndex + 3) % 4]: 'Right'
  };

  ['Top', 'Bottom', 'Left', 'Right'].forEach(pos => {
    document.getElementById(`trickSlot${pos}`).innerHTML = '<div class="card-placeholder"></div>';
  });

  gameState.currentTrick.forEach(trickItem => {
    const pos = slotMap[trickItem.playerIndex];
    const slot = document.getElementById(`trickSlot${pos}`);
    if (slot) {
      slot.innerHTML = createCardHTML(trickItem.card, false, true);
    }
  });

  const banner = document.getElementById('trickBanner');
  const info = gameState.trickWinnerInfo || gameState.lastTrick;
  if (gameState.phase === 'EVALUATING_TRICK' && info) {
    banner.classList.remove('hidden');
    const myTeam = gameState.you ? gameState.you.team : 0;
    const winnerTeam = (typeof info.winnerTeam === 'number') ? info.winnerTeam : (info.winnerIndex % 2 === 0 ? 0 : 1);
    const isWe = (winnerTeam === myTeam);
    const teamLabel = isWe ? 'WIR' : 'SIE';
    document.getElementById('trickWinnerText').textContent = 
      `🏆 Stich an ${info.winnerName} (${teamLabel})! (+${info.points} Augen)`;
  } else {
    banner.classList.add('hidden');
  }
}

function renderMyHand() {
  const fan = document.getElementById('myHandFan');
  fan.innerHTML = '';

  const hand = gameState.you.hand || [];
  const total = hand.length;
  const isMyTurn = (gameState.currentTurn === mySeatIndex && gameState.phase === 'PLAY_TRICK');

  hand.forEach((card, index) => {
    const isPlayable = isMyTurn ? !!gameState.you.playableMap[card.id] : true;
    const cardEl = document.createElement('div');

    const rot = (total > 1) ? ((index - (total - 1) / 2) * 5) : 0;
    const ty = Math.abs(index - (total - 1) / 2) * 3;

    cardEl.innerHTML = createCardHTML(card, !isPlayable && isMyTurn, true);
    const cardChild = cardEl.firstElementChild;
    cardChild.style.transform = `rotate(${rot}deg) translateY(${ty}px)`;

    if (isPlayable && isMyTurn) {
      cardChild.addEventListener('click', () => playCard(card.id));
    }

    fan.appendChild(cardChild);
  });
}

/**
 * Erzeugt das SVG-HTML für eine Spielkarte im belgischen Carta Mundi Vektor-Design.
 */
function createCardHTML(card, isDisabled = false, showTrumpTag = false) {
  const svgId = getSvgCardId(card);
  const isTrump = gameState ? isCardTrump(card, gameState.trumpSuit, gameState.isMitAnnounced) : false;

  return `
    <div class="playing-card ${isDisabled ? 'disabled' : ''} ${isTrump ? 'is-trump' : ''}" data-id="${card.id}">
      <svg class="card-svg-element" viewBox="0 0 169.075 244.640">
        <use href="#${svgId}"></use>
      </svg>
      ${(showTrumpTag && isTrump) ? '<span class="card-trump-tag">TRUMPF</span>' : ''}
    </div>
  `;
}

function isCardTrump(card, trumpSuit, isMitAnnounced) {
  if (!trumpSuit) return false;
  if (card.suit === 'clubs' && card.rank === 'Q') return true;
  if (isMitAnnounced && card.suit === 'spades' && card.rank === 'Q') return true;
  return card.suit === trumpSuit;
}

function getSvgCardId(card) {
  const suitMap = {
    clubs: 'club',
    spades: 'spade',
    hearts: 'heart',
    diamonds: 'diamond'
  };

  const rankMap = {
    'A': '1',
    'K': 'king',
    'Q': 'queen',
    'J': 'jack',
    '10': '10',
    '9': '9'
  };

  const s = suitMap[card.suit] || 'club';
  const r = rankMap[card.rank] || '1';
  return `${s}_${r}`;
}

function handleModals() {
  const trumpModal = document.getElementById('trumpModal');
  const mitBanner = document.getElementById('mitActionBanner');
  const roundModal = document.getElementById('roundSummaryModal');
  const gameOverModal = document.getElementById('gameOverModal');

  // Trumpfwahl-Modal
  if (gameState.phase === 'CHOOSE_TRUMP' && gameState.declarerIndex === mySeatIndex) {
    trumpModal.classList.remove('hidden');

    const trumpCardsContainer = document.getElementById('trumpDealtCards');
    trumpCardsContainer.innerHTML = '';
    const hand = gameState.you.hand || [];
    hand.forEach(card => {
      trumpCardsContainer.innerHTML += createCardHTML(card, false, false);
    });
  } else {
    trumpModal.classList.add('hidden');
  }

  // Mit'-Ansage Banner
  if (gameState.canAnnounceMit) {
    if (mitBanner) mitBanner.classList.remove('hidden');
  } else {
    if (mitBanner) mitBanner.classList.add('hidden');
  }

  // Rundenabrechnungs-Modal
  if (gameState.phase === 'ROUND_END' && gameState.roundSummary) {
    roundModal.classList.remove('hidden');
    renderRoundSummary(gameState.roundSummary);
  } else {
    roundModal.classList.add('hidden');
  }

  // Game Over Modal
  if (gameState.phase === 'GAME_OVER' && gameState.roundSummary) {
    gameOverModal.classList.remove('hidden');
    const myTeam = gameState.you ? gameState.you.team : 0;
    const weWon = (gameState.scores.teamA <= 0 && myTeam === 0) || (gameState.scores.teamB <= 0 && myTeam === 1);

    document.getElementById('gameOverTitle').textContent = weWon
      ? '🏆 WIR haben die Partie gewonnen!'
      : '💀 SIE haben die Partie gewonnen!';

    document.getElementById('gameOverTrophy').textContent = weWon ? '🏆' : '👑';

    const scoreWe = myTeam === 0 ? gameState.scores.teamA : gameState.scores.teamB;
    const scoreThey = myTeam === 0 ? gameState.scores.teamB : gameState.scores.teamA;

    document.getElementById('finalScoreWe').textContent = scoreWe;
    document.getElementById('finalScoreThey').textContent = scoreThey;

    if (weWon) playSound('victory');
  } else {
    gameOverModal.classList.add('hidden');
  }
}

function renderRoundSummary(summary) {
  const myTeam = gameState.you ? gameState.you.team : 0;

  const eyesWe = myTeam === 0 ? summary.eyesTeamA : summary.eyesTeamB;
  const eyesThey = myTeam === 0 ? summary.eyesTeamB : summary.eyesTeamA;

  const tricksWe = myTeam === 0 ? summary.tricksTeamA : summary.tricksTeamB;
  const tricksThey = myTeam === 0 ? summary.tricksTeamB : summary.tricksTeamA;

  const deltaWe = myTeam === 0 ? summary.deltaTeamA : summary.deltaTeamB;
  const deltaThey = myTeam === 0 ? summary.deltaTeamB : summary.deltaTeamA;

  document.getElementById('summaryRoundTag').textContent = `Runde ${summary.roundNumber} beendet`;
  document.getElementById('summaryEyesWe').textContent = eyesWe;
  document.getElementById('summaryEyesThey').textContent = eyesThey;
  document.getElementById('summaryTricksWe').textContent = tricksWe;
  document.getElementById('summaryTricksThey').textContent = tricksThey;

  // Winner Banner
  const winnerBanner = document.getElementById('summaryWinnerBanner');
  if (deltaWe < 0) {
    winnerBanner.textContent = `🎉 WIR GEWINNEN DIE RUNDE! (${Math.abs(deltaWe)} Punkte abgezogen)`;
    winnerBanner.className = 'summary-winner-banner we-won';
  } else if (deltaThey < 0) {
    winnerBanner.textContent = `⚠️ SIE GEWINNEN DIE RUNDE! (${Math.abs(deltaThey)} Punkte für SIE abgezogen)`;
    winnerBanner.className = 'summary-winner-banner they-won';
  } else {
    winnerBanner.textContent = `⚖️ UNENTSCHIEDEN`;
    winnerBanner.className = 'summary-winner-banner';
  }

  const changeWe = document.getElementById('summaryChangeWe');
  const changeThey = document.getElementById('summaryChangeThey');

  changeWe.textContent = formatDelta(deltaWe);
  changeWe.className = `score-change ${deltaWe < 0 ? 'negative' : (deltaWe > 0 ? 'positive' : 'neutral')}`;

  changeThey.textContent = formatDelta(deltaThey);
  changeThey.className = `score-change ${deltaThey < 0 ? 'negative' : (deltaThey > 0 ? 'positive' : 'neutral')}`;

  // Abrechnungsgrundtext personalisieren (Team A / B durch WIR / SIE ersetzen)
  let cleanReason = summary.reason;
  if (myTeam === 0) {
    cleanReason = cleanReason.replace(/Team A/g, 'WIR').replace(/Team B/g, 'SIE');
  } else {
    cleanReason = cleanReason.replace(/Team B/g, 'WIR').replace(/Team A/g, 'SIE');
  }
  document.getElementById('summaryReason').textContent = cleanReason;

  // Stock-Karten aufdecken
  const stockContainer = document.getElementById('summaryStockCards');
  stockContainer.innerHTML = '';
  (summary.stockCards || []).forEach(card => {
    stockContainer.innerHTML += createCardHTML(card, false, false);
  });
}

function formatDelta(val) {
  if (val > 0) return `+${val}`;
  if (val < 0) return `${val}`;
  return '0';
}

function renderDrawerContent() {
  const logList = document.getElementById('actionLogList');
  logList.innerHTML = '';
  const myTeam = gameState.you ? gameState.you.team : 0;

  (gameState.actionLog || []).slice(-30).forEach(entry => {
    const li = document.createElement('li');
    let text = entry;
    if (myTeam === 0) {
      text = text.replace(/Team A/g, 'WIR').replace(/Team B/g, 'SIE');
    } else {
      text = text.replace(/Team B/g, 'WIR').replace(/Team A/g, 'SIE');
    }
    li.textContent = text;
    logList.appendChild(li);
  });

  const chatList = document.getElementById('chatMessagesList');
  chatList.innerHTML = '';
  (gameState.chatMessages || []).forEach(chat => {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = `
      <div class="chat-sender">
        <span>${chat.sender}</span>
        <span class="time">${chat.time}</span>
      </div>
      <div class="chat-text">${chat.text}</div>
    `;
    chatList.appendChild(div);
  });
}
