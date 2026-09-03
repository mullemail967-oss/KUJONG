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
    } else if (type === 'emote') {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(550, now);
      osc.frequency.exponentialRampToValueAtTime(1100, now + 0.12);
      gain.gain.setValueAtTime(0.25, now);
      gain.gain.linearRampToValueAtTime(0.01, now + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.12);
    }
  } catch (e) {
    console.warn('Audio play error:', e);
  }
}

// SVG Sprite Loader (WebKit/Safari kompatibel ohne display:none)
async function initSvgSprite() {
  try {
    const res = await fetch('svg-cards.svg');
    const text = await res.text();
    let container = document.getElementById('svgSpriteContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'svgSpriteContainer';
      container.setAttribute('aria-hidden', 'true');
      container.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none;opacity:0;z-index:-9999;';
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

  // Klick außerhalb des Emote-Pickers schließt ihn
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('emotePickerPopup');
    const trigger = document.getElementById('openEmoteBtn');
    if (picker && !picker.classList.contains('hidden')) {
      if (!picker.contains(e.target) && (!trigger || !trigger.contains(e.target))) {
        picker.classList.add('hidden');
      }
    }
  });

  const roomCodeInput = document.getElementById('roomCodeInput');
  if (roomCodeInput) {
    roomCodeInput.addEventListener('input', () => {
      roomCodeInput.value = roomCodeInput.value.toUpperCase();
      updateLobbyButtonsState();
    });
    roomCodeInput.addEventListener('keyup', (e) => {
      if (e.key === 'Enter') handleJoinRoom();
    });
  }
}

function updateLobbyButtonsState() {
  const codeInput = document.getElementById('roomCodeInput');
  const createBtn = document.getElementById('createRoomBtn');
  const joinBtn = document.getElementById('joinRoomBtn');
  if (!codeInput || !createBtn || !joinBtn) return;

  const hasCode = codeInput.value.trim().length > 0;
  if (hasCode) {
    createBtn.disabled = true;
    createBtn.classList.add('btn-create-disabled');
    createBtn.title = 'Raumcode eingegeben: Klicke auf "Beitreten"';
    joinBtn.classList.remove('btn-secondary');
    joinBtn.classList.add('btn-primary', 'btn-glow');
  } else {
    createBtn.disabled = false;
    createBtn.classList.remove('btn-create-disabled');
    createBtn.title = 'Neuen Raum erstellen';
    joinBtn.classList.remove('btn-primary', 'btn-glow');
    joinBtn.classList.add('btn-secondary');
  }
}

function checkUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  const room = urlParams.get('room');
  if (room) {
    const codeInput = document.getElementById('roomCodeInput');
    if (codeInput) {
      codeInput.value = room.toUpperCase();
      updateLobbyButtonsState();
    }
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
  const codeInput = document.getElementById('roomCodeInput');
  if (codeInput && codeInput.value.trim().length > 0) {
    showToast('Du hast einen Raumcode eingegeben! Klicke auf Beitreten.');
    return;
  }
  const playerName = getPlayerName();
  socket.emit('create_room', { playerName, settings: currentSettings });
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
  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  for (let i = 0; i < maxPlayers; i++) {
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

function turnTrump() {
  socket.emit('turn_trump');
  document.getElementById('trumpModal').classList.add('hidden');
  playSound('trump_fanfare');
}

// Helper: Berechnet relative Sitzposition relativ zu Du (Bottom)
function getRelativePosition(targetSeatIndex, mySeatIndex) {
  const t = typeof targetSeatIndex === 'number' ? targetSeatIndex : 0;
  const m = typeof mySeatIndex === 'number' ? mySeatIndex : 0;
  const maxPlayers = gameState && gameState.settings ? (gameState.settings.playerCount || 4) : 4;

  if (maxPlayers === 6) {
    const diff = (t - m + 6) % 6;
    if (diff === 0) return 'Bottom';
    if (diff === 1) return 'BottomLeft';
    if (diff === 2) return 'TopLeft';
    if (diff === 3) return 'Top';
    if (diff === 4) return 'TopRight';
    if (diff === 5) return 'BottomRight';
    return 'Bottom';
  } else {
    const diff = (t - m + 4) % 4;
    if (diff === 0) return 'Bottom';
    if (diff === 1) return 'Left';
    if (diff === 2) return 'Top';
    if (diff === 3) return 'Right';
    return 'Bottom';
  }
}

// Clash Royale Ragebait Emotes mit Spam-Schutz & dynamischem Cooldown
let lastEmoteTime = 0;
let emoteSpamCount = 0;
let emoteCooldownUntil = 0;

function toggleEmotePicker() {
  const popup = document.getElementById('emotePickerPopup');
  popup.classList.toggle('hidden');
}

function sendEmote(emoji) {
  const now = Date.now();
  if (now < emoteCooldownUntil) {
    const remainingSec = Math.ceil((emoteCooldownUntil - now) / 1000);
    showToast(`⏳ Bitte kurz warten (${remainingSec}s)...`);
    return;
  }

  if (now - lastEmoteTime < 2500) {
    emoteSpamCount++;
  } else {
    emoteSpamCount = 0;
  }

  let cooldownMs = 1200; // Normaler Cooldown: 1,2s
  if (emoteSpamCount >= 3) {
    cooldownMs = 4000; // Verlängerter Cooldown bei Spam: 4s
    showToast('🤫 Nicht spammen! 4s Cooldown.');
  }

  lastEmoteTime = now;
  emoteCooldownUntil = now + cooldownMs;

  socket.emit('send_emote', { emote: emoji });
  document.getElementById('emotePickerPopup').classList.add('hidden');
}

function showEmoteBubble(seatIndex, emote) {
  const mySeat = gameState && gameState.you ? gameState.you.seatIndex : 0;
  const relativePos = getRelativePosition(seatIndex, mySeat); // 'Bottom', 'Left', 'Top', 'Right'
  const containerId = 'emoteBubble' + relativePos;
  const container = document.getElementById(containerId);
  if (!container) return;

  const bubble = document.createElement('div');
  bubble.className = 'clash-emote-bubble';
  bubble.textContent = emote;
  container.appendChild(bubble);

  setTimeout(() => {
    bubble.remove();
  }, 2200);
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

function leaveLobby() {
  socket.emit('leave_room');
  sessionStorage.removeItem('kujong_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  showToast('Du hast die Lobby verlassen.');
}

function confirmLeaveGame() {
  const confirmLeave = confirm('Möchtest du das Spiel wirklich verlassen? Dein Platz wird sofort von einem Bot übernommen, damit die Partie weitergehen kann.');
  if (confirmLeave) {
    socket.emit('leave_game');
    sessionStorage.removeItem('kujong_session');
    currentRoomCode = null;
    mySeatIndex = -1;
    gameState = null;
    document.getElementById('lobbyWaitingRoom').classList.add('hidden');
    document.getElementById('lobbyInitialOptions').classList.remove('hidden');
    document.getElementById('gameScreen').classList.remove('active');
    document.getElementById('lobbyScreen').classList.add('active');
    closeHostMenu();
    showToast('Du hast das Spiel verlassen. Ein Bot hat übernommen.');
  }
}

function returnToLobby() {
  if (!gameState || !gameState.you || !gameState.you.isHost) return;
  const confirmReturn = confirm('Möchtest du die laufende Partie wirklich beenden und mit allen Spielern zurück in die Lobby wechseln?');
  if (confirmReturn) {
    socket.emit('return_to_lobby');
    closeHostMenu();
  }
}

// --------------------------------------------------------------------------
// SPIELLEITER-MENÜ & SPIELER-VERWALTUNG (KICKEN)
// --------------------------------------------------------------------------
function openHostMenu() {
  if (!gameState || !gameState.you || !gameState.you.isHost) return;
  renderHostPlayerList();
  document.getElementById('hostControlModal').classList.remove('hidden');
}

function closeHostMenu() {
  document.getElementById('hostControlModal').classList.add('hidden');
}

function renderHostPlayerList() {
  const container = document.getElementById('hostPlayerList');
  if (!container || !gameState) return;
  container.innerHTML = '';

  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  const sectionTitle = document.getElementById('hostPlayerSectionTitle');
  if (sectionTitle) {
    sectionTitle.textContent = `👥 Spieler-Verwaltung (${maxPlayers} Plätze)`;
  }

  for (let i = 0; i < maxPlayers; i++) {
    const player = gameState.players[i];
    const row = document.createElement('div');
    row.className = 'host-player-row';

    const isMe = (i === gameState.you.seatIndex);
    const isBot = player && player.isBot;
    const teamLabel = i % 2 === 0 ? 'Team A' : 'Team B';

    let tagHTML = '';
    let actionHTML = '';

    if (!player) {
      tagHTML = '<span class="host-player-tag tag-bot">Frei</span>';
    } else if (isMe) {
      tagHTML = '<span class="host-player-tag tag-host">Spielleiter (Du)</span>';
    } else if (isBot) {
      tagHTML = '<span class="host-player-tag tag-bot">🤖 Bot</span>';
    } else {
      tagHTML = '<span class="host-player-tag tag-player">👤 Spieler</span>';
      actionHTML = `<button class="btn-kick" onclick="kickPlayer(${i}, '${player.name}')">👢 Kicken (Bot)</button>`;
    }

    const pName = player ? player.name : 'Leerer Platz';

    row.innerHTML = `
      <div class="host-player-info">
        <span class="host-player-seat">P${i + 1} (${teamLabel})</span>
        <span class="host-player-name">${pName}</span>
        ${tagHTML}
      </div>
      <div>
        ${actionHTML}
      </div>
    `;

    container.appendChild(row);
  }
}

function kickPlayer(seatIndex, playerName) {
  const confirmKick = confirm(`Möchtest du ${playerName || 'diesen Spieler'} wirklich aus der Partie entfernen und durch einen Bot ersetzen?`);
  if (confirmKick) {
    socket.emit('kick_player', { targetSeat: seatIndex });
    setTimeout(() => {
      renderHostPlayerList();
    }, 300);
  }
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

socket.on('room_disbanded', ({ message }) => {
  sessionStorage.removeItem('kujong_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  alert(message || 'Die Lobby wurde aufgelöst.');
});

socket.on('left_room', () => {
  sessionStorage.removeItem('kujong_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
});

socket.on('kicked_from_room', ({ message }) => {
  sessionStorage.removeItem('kujong_session');
  currentRoomCode = null;
  mySeatIndex = -1;
  gameState = null;
  document.getElementById('lobbyWaitingRoom').classList.add('hidden');
  document.getElementById('lobbyInitialOptions').classList.remove('hidden');
  document.getElementById('gameScreen').classList.remove('active');
  document.getElementById('lobbyScreen').classList.add('active');
  closeHostMenu();
  alert(message || 'Du wurdest vom Spielleiter aus der Partie entfernt.');
});

// Auffälliges Banner im Spielfeld, wenn jemand die Mit' ansagt
let mitNotificationTimer = null;
socket.on('mit_announced', ({ playerName, seatIndex }) => {
  const banner = document.getElementById('mitFieldNotification');
  const textEl = document.getElementById('mitPopText');
  if (banner && textEl) {
    const isMe = (seatIndex === mySeatIndex);
    const displayName = isMe ? `${playerName} (Du)` : playerName;
    textEl.textContent = `⭐ ${displayName} sagt die MIT' an! (+2 Pkt)`;
    banner.classList.remove('hidden');
    banner.classList.remove('fade-out');

    if (mitNotificationTimer) clearTimeout(mitNotificationTimer);
    mitNotificationTimer = setTimeout(() => {
      banner.classList.add('fade-out');
      setTimeout(() => {
        banner.classList.add('hidden');
        banner.classList.remove('fade-out');
      }, 500);
    }, 2800);
  }
  playSound('trump_fanfare');
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

socket.on('player_emote', ({ seatIndex, emote }) => {
  showEmoteBubble(seatIndex, emote);
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

  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  const is6p = (maxPlayers === 6);

  const slot4 = document.getElementById('seatSlot4');
  const slot5 = document.getElementById('seatSlot5');
  if (slot4) slot4.classList.toggle('hidden', !is6p);
  if (slot5) slot5.classList.toggle('hidden', !is6p);

  const teamASub = document.getElementById('teamASubtitle');
  const teamBSub = document.getElementById('teamBSubtitle');
  if (teamASub) teamASub.textContent = is6p ? '(Sitze 1, 3 & 5)' : '(Sitze 1 & 3)';
  if (teamBSub) teamBSub.textContent = is6p ? '(Sitze 2, 4 & 6)' : '(Sitze 2 & 4)';

  let totalOccupied = 0;
  for (let i = 0; i < maxPlayers; i++) {
    const slotEl = document.getElementById(`seatSlot${i}`);
    if (!slotEl) continue;
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
    if (totalOccupied === maxPlayers) {
      startBtn.disabled = false;
      startBtn.textContent = '🎮 Spiel jetzt starten!';
    } else {
      startBtn.disabled = true;
      startBtn.textContent = `⏳ Warte auf ${maxPlayers} Spieler (${totalOccupied}/${maxPlayers})...`;
    }
  } else {
    startBtn.classList.remove('hidden');
    startBtn.disabled = true;
    startBtn.textContent = 'Warte auf Spielleiter...';
  }

  syncSettingsUI();
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

  const countEyesLive = gameState.settings ? (gameState.settings.countEyesLive !== false) : true;
  document.getElementById('eyesWe').textContent = countEyesLive ? eyesWe : '-';
  document.getElementById('eyesThey').textContent = countEyesLive ? eyesThey : '-';

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

  const hostMenuBtn = document.getElementById('hostMenuBtn');
  const isHost = gameState.you ? gameState.you.isHost : false;
  if (hostMenuBtn) {
    hostMenuBtn.classList.toggle('hidden', !isHost);
  }

  const hostModal = document.getElementById('hostControlModal');
  if (hostModal && !hostModal.classList.contains('hidden')) {
    renderHostPlayerList();
  }

  // Status Ticker
  renderStatusTicker();

  // Spieler am Tisch rendern (relativ zur eigenen Position)
  renderTablePlayers();

  // Stich im Zentrum rendern
  renderTrickCenter();

  // Eigene Handkarten rendern
  renderMyHand();
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
  const myTeam = gameState.you ? gameState.you.team : 0;
  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  const is6p = (maxPlayers === 6);

  const feltTable = document.getElementById('feltTable');
  if (feltTable) {
    feltTable.classList.toggle('mode-6p', is6p);
  }

  // 4P spezifische Spieler
  const playerLeft = document.getElementById('playerLeft');
  const playerRight = document.getElementById('playerRight');
  if (playerLeft) playerLeft.classList.toggle('hidden', is6p);
  if (playerRight) playerRight.classList.toggle('hidden', is6p);

  // 6P spezifische Spieler
  const pTL = document.getElementById('playerTopLeft');
  const pBL = document.getElementById('playerBottomLeft');
  const pTR = document.getElementById('playerTopRight');
  const pBR = document.getElementById('playerBottomRight');
  if (pTL) pTL.classList.toggle('hidden', !is6p);
  if (pBL) pBL.classList.toggle('hidden', !is6p);
  if (pTR) pTR.classList.toggle('hidden', !is6p);
  if (pBR) pBR.classList.toggle('hidden', !is6p);

  const positions = is6p ? [
    { key: 'Bottom', seatIdx: mySeatIndex },
    { key: 'BottomLeft', seatIdx: (mySeatIndex + 1) % 6 },
    { key: 'TopLeft', seatIdx: (mySeatIndex + 2) % 6 },
    { key: 'Top', seatIdx: (mySeatIndex + 3) % 6 },
    { key: 'TopRight', seatIdx: (mySeatIndex + 4) % 6 },
    { key: 'BottomRight', seatIdx: (mySeatIndex + 5) % 6 }
  ] : [
    { key: 'Bottom', seatIdx: mySeatIndex },
    { key: 'Left', seatIdx: (mySeatIndex + 1) % 4 },
    { key: 'Top', seatIdx: (mySeatIndex + 2) % 4 },
    { key: 'Right', seatIdx: (mySeatIndex + 3) % 4 }
  ];

  positions.forEach(({ key, seatIdx }) => {
    const player = gameState.players[seatIdx];
    if (!player) return;

    const isMe = (seatIdx === mySeatIndex);
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

    const mitPill = document.getElementById(`mitPill${key}`);
    if (mitPill) {
      if (player.isMitAnnouncer) {
        mitPill.classList.remove('hidden');
        mitPill.textContent = "⭐ Mit'";
      } else {
        mitPill.classList.add('hidden');
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
  const maxPlayers = gameState.settings ? (gameState.settings.playerCount || 4) : 4;
  const is6p = (maxPlayers === 6);

  const slotLeft = document.getElementById('trickSlotLeft');
  const slotRight = document.getElementById('trickSlotRight');
  if (slotLeft) slotLeft.classList.toggle('hidden', is6p);
  if (slotRight) slotRight.classList.toggle('hidden', is6p);

  const sTL = document.getElementById('trickSlotTopLeft');
  const sBL = document.getElementById('trickSlotBottomLeft');
  const sTR = document.getElementById('trickSlotTopRight');
  const sBR = document.getElementById('trickSlotBottomRight');
  if (sTL) sTL.classList.toggle('hidden', !is6p);
  if (sBL) sBL.classList.toggle('hidden', !is6p);
  if (sTR) sTR.classList.toggle('hidden', !is6p);
  if (sBR) sBR.classList.toggle('hidden', !is6p);

  const allPositions = is6p
    ? ['Bottom', 'BottomLeft', 'TopLeft', 'Top', 'TopRight', 'BottomRight']
    : ['Bottom', 'Left', 'Top', 'Right'];

  allPositions.forEach(pos => {
    const slot = document.getElementById(`trickSlot${pos}`);
    if (slot) slot.innerHTML = '<div class="card-placeholder"></div>';
  });

  gameState.currentTrick.forEach(trickItem => {
    const pos = getRelativePosition(trickItem.playerIndex, mySeatIndex);
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

    const countEyesLive = gameState.settings ? (gameState.settings.countEyesLive !== false) : true;
    const pointsSuffix = countEyesLive ? ` (+${info.points} Augen)` : '';

    document.getElementById('trickWinnerText').textContent = 
      `🏆 Stich an ${info.winnerName} (${teamLabel})!${pointsSuffix}`;
  } else {
    banner.classList.add('hidden');
  }
}

function renderMyHand() {
  const fan = document.getElementById('myHandFan');
  fan.innerHTML = '';

  const hand = gameState.you.hand || [];
  const total = hand.length;
  fan.setAttribute('data-card-count', total);
  const isMyTurn = (gameState.currentTurn === mySeatIndex && gameState.phase === 'PLAY_TRICK');

  // Bei 3 oder weniger Karten flacher Fächer mit extra Abstand
  const useRotation = total > 3;

  hand.forEach((card, index) => {
    const isPlayable = isMyTurn ? !!gameState.you.playableMap[card.id] : true;
    const cardEl = document.createElement('div');

    const rot = useRotation ? ((index - (total - 1) / 2) * 4) : 0;
    const ty = useRotation ? (Math.abs(index - (total - 1) / 2) * 2) : 0;

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
function createCardHTML(card, isDisabled = false) {
  const svgId = getSvgCardId(card);
  const isTrump = gameState ? isCardTrump(card, gameState.trumpSuit, gameState.isMitAnnounced) : false;

  return `
    <div class="playing-card ${isDisabled ? 'disabled' : ''} ${isTrump ? 'is-trump' : ''}" data-id="${card.id}">
      <svg class="card-svg-element" viewBox="0 0 169.075 244.640" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <use href="#${svgId}" xlink:href="#${svgId}"></use>
      </svg>
    </div>
  `;
}

function isCardTrump(card, trumpSuit, isMitAnnounced) {
  if (!card || !trumpSuit) return false;
  const settings = gameState ? (gameState.settings || {}) : {};
  const alwaysClubQueenTrump = settings.alwaysClubQueenTrump !== false;
  const allowMit = settings.allowMit !== false;

  if (alwaysClubQueenTrump && card.suit === 'clubs' && card.rank === 'Q') return true;
  if (allowMit && isMitAnnounced && card.suit === 'spades' && card.rank === 'Q') return true;
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
    '9': '9',
    '8': '8',
    '7': '7'
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
    const isHost = gameState.you ? gameState.you.isHost : true;

    document.getElementById('gameOverTitle').textContent = weWon
      ? '🏆 WIR haben die Partie gewonnen!'
      : '💀 SIE haben die Partie gewonnen!';

    document.getElementById('gameOverTrophy').textContent = weWon ? '🏆' : '👑';

    const scoreWe = myTeam === 0 ? gameState.scores.teamA : gameState.scores.teamB;
    const scoreThey = myTeam === 0 ? gameState.scores.teamB : gameState.scores.teamA;

    document.getElementById('finalScoreWe').textContent = scoreWe;
    document.getElementById('finalScoreThey').textContent = scoreThey;

    const restartBtn = document.getElementById('restartGameBtn');
    const goWaitingNote = document.getElementById('gameOverWaitingNote');
    if (restartBtn && goWaitingNote) {
      if (isHost) {
        restartBtn.classList.remove('hidden');
        restartBtn.disabled = false;
        goWaitingNote.classList.add('hidden');
      } else {
        restartBtn.classList.add('hidden');
        goWaitingNote.classList.remove('hidden');
      }
    }

    if (weWon) playSound('victory');
  } else {
    gameOverModal.classList.add('hidden');
  }
}

function renderRoundSummary(summary) {
  const myTeam = gameState.you ? gameState.you.team : 0;
  const isHost = gameState.you ? gameState.you.isHost : true;

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

  // Trinkspiel-Modus Task anzeigen (wenn aktiviert)
  const drinkingBox = document.getElementById('drinkingTaskBox');
  const drinkingText = document.getElementById('drinkingTaskText');
  if (drinkingBox && drinkingText) {
    if (summary.drinkingTask) {
      let task = summary.drinkingTask;
      if (myTeam === 0) {
        task = task.replace(/Team A/g, 'WIR').replace(/Team B/g, 'SIE');
      } else {
        task = task.replace(/Team B/g, 'WIR').replace(/Team A/g, 'SIE');
      }
      drinkingText.textContent = task;
      const weMustDrink = task.includes('WIR');
      drinkingBox.classList.toggle('we-drink', weMustDrink);
      drinkingBox.classList.remove('hidden');
    } else {
      drinkingBox.classList.add('hidden');
    }
  }

  // Stock-Karten aufdecken
  const stockContainer = document.getElementById('summaryStockCards');
  stockContainer.innerHTML = '';
  (summary.stockCards || []).forEach(card => {
    stockContainer.innerHTML += createCardHTML(card, false, false);
  });

  // Host vs Mitspieler Weiter-Button Steuerung
  const nextBtn = document.getElementById('nextRoundBtn');
  const waitingNote = document.getElementById('waitingForHostNote');
  if (nextBtn && waitingNote) {
    if (isHost) {
      nextBtn.classList.remove('hidden');
      nextBtn.disabled = false;
      waitingNote.classList.add('hidden');
    } else {
      nextBtn.classList.add('hidden');
      waitingNote.classList.remove('hidden');
    }
  }
}

function formatDelta(val) {
  if (val > 0) return `+${val}`;
  if (val < 0) return `${val}`;
  return '0';
}

// --------------------------------------------------------------------------
// SPIELEINSTELLUNGEN & REGEL-MODAL (⚙️)
// --------------------------------------------------------------------------
let currentSettings = {
  playerCount: 4,
  countEyesLive: true,
  alwaysClubQueenTrump: true,
  allowMit: true,
  contraPoints: 4,
  ansagerZeroTricksPenalty: 2,
  startScoreA: 13,
  startScoreB: 13,
  drinkingGameMode: 'none',
  trickDisplaySeconds: 2.5,
  dealAndTurnDelaySeconds: 1.0
};

function openSettingsModal() {
  if (gameState && gameState.settings) {
    currentSettings = { ...gameState.settings };
  }
  syncSettingsUI();
  document.getElementById('settingsModal').classList.remove('hidden');
}

function closeSettingsModal() {
  document.getElementById('settingsModal').classList.add('hidden');
}

function syncSettingsUI() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;

  const segPC4 = document.getElementById('segPlayerCount4');
  const segPC6 = document.getElementById('segPlayerCount6');
  if (segPC4 && segPC6) {
    const pc = currentSettings.playerCount || 4;
    segPC4.classList.toggle('active', pc === 4);
    segPC6.classList.toggle('active', pc === 6);
    segPC4.disabled = !isHost;
    segPC6.disabled = !isHost;
  }

  const countEyesInput = document.getElementById('settingCountEyesLive');
  const alwaysClubInput = document.getElementById('settingAlwaysClubQueenTrump');
  const allowMitInput = document.getElementById('settingAllowMit');
  const scoreAInput = document.getElementById('settingStartScoreA');
  const scoreBInput = document.getElementById('settingStartScoreB');

  if (countEyesInput) {
    countEyesInput.checked = currentSettings.countEyesLive !== false;
    countEyesInput.disabled = !isHost;
  }
  if (alwaysClubInput) {
    alwaysClubInput.checked = currentSettings.alwaysClubQueenTrump !== false;
    alwaysClubInput.disabled = !isHost;
  }
  if (allowMitInput) {
    allowMitInput.checked = currentSettings.allowMit !== false;
    allowMitInput.disabled = !isHost;
  }
  if (scoreAInput) {
    scoreAInput.value = currentSettings.startScoreA || 13;
    scoreAInput.disabled = !isHost;
  }
  if (scoreBInput) {
    scoreBInput.value = currentSettings.startScoreB || 13;
    scoreBInput.disabled = !isHost;
  }

  const seg4 = document.getElementById('segContra4');
  const seg3 = document.getElementById('segContra3');
  if (seg4 && seg3) {
    seg4.classList.toggle('active', currentSettings.contraPoints === 4);
    seg3.classList.toggle('active', currentSettings.contraPoints === 3);
    seg4.disabled = !isHost;
    seg3.disabled = !isHost;
  }

  const segPen2 = document.getElementById('segPenalty2');
  const segPen1 = document.getElementById('segPenalty1');
  if (segPen2 && segPen1) {
    segPen2.classList.toggle('active', currentSettings.ansagerZeroTricksPenalty === 2);
    segPen1.classList.toggle('active', currentSettings.ansagerZeroTricksPenalty === 1);
    segPen2.disabled = !isHost;
    segPen1.disabled = !isHost;
  }

  // Trinkspiel-Modus Segmented Buttons
  const segDrinkOff = document.getElementById('segDrinkOff');
  const segDrinkLight = document.getElementById('segDrinkLight');
  const segDrinkMedium = document.getElementById('segDrinkMedium');
  const segDrinkHeavy = document.getElementById('segDrinkHeavy');
  if (segDrinkOff && segDrinkLight && segDrinkMedium && segDrinkHeavy) {
    const dm = currentSettings.drinkingGameMode || 'none';
    segDrinkOff.classList.toggle('active', dm === 'none' || dm === false);
    segDrinkLight.classList.toggle('active', dm === 'light');
    segDrinkMedium.classList.toggle('active', dm === 'medium' || dm === true);
    segDrinkHeavy.classList.toggle('active', dm === 'heavy');
    segDrinkOff.disabled = !isHost;
    segDrinkLight.disabled = !isHost;
    segDrinkMedium.disabled = !isHost;
    segDrinkHeavy.disabled = !isHost;
  }

  // Speed / Delays Display
  const dispTrick = document.getElementById('displayTrickDelay');
  const dispDeal = document.getElementById('displayDealDelay');
  if (dispTrick) {
    const trickVal = (typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5;
    dispTrick.textContent = `${trickVal.toFixed(1)}s`;
  }
  if (dispDeal) {
    const dealVal = (typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0;
    dispDeal.textContent = `${dealVal.toFixed(1)}s`;
  }
}

function setPlayerCountSetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.playerCount = val;
  syncSettingsUI();
  saveRuleSettings();
}

function setDrinkingGameSetting(mode) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.drinkingGameMode = mode;
  if (mode !== 'none') {
    // Automatisches schnelles Tempo bei Trinkspiel
    currentSettings.trickDisplaySeconds = 1.2;
    currentSettings.dealAndTurnDelaySeconds = 0.5;
    const names = { light: 'Leicht (1–4 Schlucke)', medium: 'Mittel (2–8 Schlucke)', heavy: 'Schwer (4–12 Schlucke)' };
    showToast(`🍻 Trinkspiel-Modus: ${names[mode] || mode} aktiviert! Spieltempo auf schnell (1.2s / 0.5s) geschaltet.`);
  } else {
    currentSettings.trickDisplaySeconds = 2.5;
    currentSettings.dealAndTurnDelaySeconds = 1.0;
    showToast('🍻 Trinkspiel-Modus deaktiviert.');
  }
  syncSettingsUI();
  saveRuleSettings();
}

function adjustSpeedSetting(type, delta) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  if (type === 'trickDelay') {
    let val = ((typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5) + delta;
    val = Math.round(val * 10) / 10;
    if (val < 0.8) val = 0.8;
    if (val > 7.0) val = 7.0;
    currentSettings.trickDisplaySeconds = val;
  } else if (type === 'dealDelay') {
    let val = ((typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0) + delta;
    val = Math.round(val * 10) / 10;
    if (val < 0.3) val = 0.3;
    if (val > 5.0) val = 5.0;
    currentSettings.dealAndTurnDelaySeconds = val;
  }
  syncSettingsUI();
  saveRuleSettings();
}

function setSpeedPreset(trickSec, dealSec) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.trickDisplaySeconds = trickSec;
  currentSettings.dealAndTurnDelaySeconds = dealSec;
  syncSettingsUI();
  saveRuleSettings();
}

function adjustStartScore(team, delta) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  const inputId = team === 'A' ? 'settingStartScoreA' : 'settingStartScoreB';
  const input = document.getElementById(inputId);
  if (!input) return;
  let val = (parseInt(input.value) || 13) + delta;
  if (val < 1) val = 1;
  if (val > 30) val = 30;
  input.value = val;
  if (team === 'A') currentSettings.startScoreA = val;
  else currentSettings.startScoreB = val;
  saveRuleSettings();
}

function setScorePreset(scoreA, scoreB) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  const inputA = document.getElementById('settingStartScoreA');
  const inputB = document.getElementById('settingStartScoreB');
  if (inputA) inputA.value = scoreA;
  if (inputB) inputB.value = scoreB;
  currentSettings.startScoreA = scoreA;
  currentSettings.startScoreB = scoreB;
  saveRuleSettings();
}

function setContraPointsSetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.contraPoints = val;
  syncSettingsUI();
  saveRuleSettings();
}

function setZeroTricksPenaltySetting(val) {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) {
    showToast('Nur der Raum-Ersteller kann Einstellungen ändern.');
    return;
  }
  currentSettings.ansagerZeroTricksPenalty = val;
  syncSettingsUI();
  saveRuleSettings();
}

function saveRuleSettings() {
  const isHost = gameState && gameState.you ? gameState.you.isHost : true;
  if (!isHost) return;

  const countEyesInput = document.getElementById('settingCountEyesLive');
  const alwaysClubInput = document.getElementById('settingAlwaysClubQueenTrump');
  const allowMitInput = document.getElementById('settingAllowMit');
  const scoreAInput = document.getElementById('settingStartScoreA');
  const scoreBInput = document.getElementById('settingStartScoreB');

  const settingsPayload = {
    playerCount: currentSettings.playerCount || 4,
    countEyesLive: countEyesInput ? countEyesInput.checked : true,
    alwaysClubQueenTrump: alwaysClubInput ? alwaysClubInput.checked : true,
    allowMit: allowMitInput ? allowMitInput.checked : true,
    contraPoints: currentSettings.contraPoints || 4,
    ansagerZeroTricksPenalty: currentSettings.ansagerZeroTricksPenalty || 2,
    startScoreA: scoreAInput ? (parseInt(scoreAInput.value) || 13) : (currentSettings.startScoreA || 13),
    startScoreB: scoreBInput ? (parseInt(scoreBInput.value) || 13) : (currentSettings.startScoreB || 13),
    drinkingGameMode: currentSettings.drinkingGameMode || 'none',
    trickDisplaySeconds: (typeof currentSettings.trickDisplaySeconds === 'number') ? currentSettings.trickDisplaySeconds : 2.5,
    dealAndTurnDelaySeconds: (typeof currentSettings.dealAndTurnDelaySeconds === 'number') ? currentSettings.dealAndTurnDelaySeconds : 1.0
  };

  currentSettings = { ...settingsPayload };
  if (currentRoomCode) {
    socket.emit('update_settings', { settings: settingsPayload });
  }
}
