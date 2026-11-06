/**
 * Couillon / Kujong Bot AI Engine
 * 
 * Taktische Heuristiken für Bots ohne Schummeln (keine verdeckten Karten einsehen).
 * Berücksichtigt Stich-Augen, Partnerführung (Schmieren), sparsames Stechen,
 * 0-Punkte-Abwurf (Schnorren), Mit'- und Kontra-Strategie.
 */

const { SUITS, isTrumpCard, getEffectiveSuit, getTrumpPower, getOffSuitPower, isCardPlayable, evaluateTrick, POINT_VALUES, createDeck } = require('./couillon-rules');

const getCardPoints = (c) => (c && c.points !== undefined) ? c.points : (c ? (POINT_VALUES[c.rank] || 0) : 0);

/**
 * Verfügbare Bot-Persönlichkeiten für Kujong.
 * 'standard' entspricht 100% der ursprünglichen, MCTS-optimierten KI.
 */
const BOT_PERSONALITIES = {
  standard: {
    id: 'standard',
    name: 'Standard',
    icon: '🎯',
    description: 'Ausgewogen & Taktisch stark (MCTS-optimiert)',
    names: ['Bot Max', 'Bot Leo', 'Bot Pit', 'Bot Sam', 'Bot Ben', 'Bot Tom', 'Bot Tim', 'Bot Jan']
  },
  aggressive: {
    id: 'aggressive',
    name: 'Aggressiv',
    icon: '🔥',
    description: 'Zocker, gibt gerne Kontra & zieht aggressiv Trümpfe',
    names: ['🔥 Zorro', '🔥 Karl', '🔥 Hennes', '🔥 Ralf', '🔥 Siggi', '🔥 Alex']
  },
  passive: {
    id: 'passive',
    name: 'Passiv',
    icon: '🛡️',
    description: 'Defensiv & vorsichtig, spart Trümpfe für fette Stiche',
    names: ['🛡️ Sepp', '🛡️ Vroni', '🛡️ Manni', '🛡️ Gerti', '🛡️ Sven', '🛡️ Rudi']
  },
  wildcard: {
    id: 'wildcard',
    name: 'Kneipen-Zocker',
    icon: '🍺',
    description: 'Unberechenbar, dreht oft blind & liebt riskante Züge',
    names: ['🍺 Theo', '🍺 Bruno', '🍺 Berti', '🍺 Kalle', '🍺 Willi', '🍺 Schorsch']
  }
};

/**
 * Sammelt alle bisher in der Runde gespielten Karten aus trickHistory und aktuellem Stich.
 */
function getPlayedCards(trickHistory = [], currentTrick = []) {
  const played = [];
  if (Array.isArray(trickHistory)) {
    for (const trick of trickHistory) {
      if (trick && Array.isArray(trick.cards)) {
        for (const entry of trick.cards) {
          if (entry && entry.card) played.push(entry.card);
          else if (entry && entry.suit && entry.rank) played.push(entry);
        }
      }
    }
  }
  if (Array.isArray(currentTrick)) {
    for (const entry of currentTrick) {
      if (entry && entry.card) played.push(entry.card);
      else if (entry && entry.suit && entry.rank) played.push(entry);
    }
  }
  return played;
}

/**
 * Ermittelt alle Karten, die sich noch im Umlauf befinden (Handkarten anderer Spieler oder Stock).
 * Basiert rein auf Information, die jeder aufmerksame Spieler am Tisch kennt.
 */
function getUnseenCards(hand = [], playedCards = [], playerCount = 4) {
  const fullDeck = createDeck(playerCount);
  const knownCards = [...hand, ...playedCards];

  return fullDeck.filter(deckCard => {
    return !knownCards.some(k => k.suit === deckCard.suit && k.rank === deckCard.rank);
  });
}

/**
 * Analysiert Farbfreiheiten (Voids) aller Spieler anhand der Stich-Historie.
 * Wenn Farbe F angespielt wurde und Spieler P eine andere Farbe oder Nicht-Trumpf spielte,
 * ist Spieler P in Farbe F bzw. TRUMP definitiv blank (frei).
 */
function getKnownVoids(trickHistory = [], playerCount = 4, trumpSuit = null, isMitAnnounced = false, options = {}) {
  const voids = Array.from({ length: playerCount }, () => ({}));
  if (!Array.isArray(trickHistory) || !trumpSuit) return voids;

  for (const trick of trickHistory) {
    if (!trick || !Array.isArray(trick.cards) || trick.cards.length < 2) continue;
    const leadEntry = trick.cards[0];
    const leadCard = leadEntry.card || leadEntry;
    if (!leadCard) continue;

    const leadIsTrump = isTrumpCard(leadCard, trumpSuit, isMitAnnounced, options);
    const leadEffectiveSuit = leadIsTrump ? 'TRUMP' : leadCard.suit;

    for (let i = 1; i < trick.cards.length; i++) {
      const play = trick.cards[i];
      const pIdx = play.playerIndex;
      const pCard = play.card || play;
      if (pIdx === undefined || !pCard) continue;

      const pEffectiveSuit = getEffectiveSuit(pCard, trumpSuit, isMitAnnounced, options);
      if (leadIsTrump) {
        if (pEffectiveSuit !== 'TRUMP') {
          voids[pIdx]['TRUMP'] = true;
        }
      } else {
        if (pEffectiveSuit !== leadEffectiveSuit) {
          voids[pIdx][leadEffectiveSuit] = true;
        }
      }
    }
  }

  return voids;
}

/**
 * Prüft, ob gegnerische Spieler rein rechnerisch noch Trümpfe auf der Hand haben können.
 */
function doOpponentsHaveTrumps(botIndex, unseenCards = [], knownVoids = [], trumpSuit, isMitAnnounced, options = {}, playerCount = 4) {
  if (!trumpSuit) return false;
  const unseenTrumps = unseenCards.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options));
  if (unseenTrumps.length === 0) return false;

  // Prüfen, ob alle Gegner in TRUMP bereits void sind
  let allOpponentsVoid = true;
  let opponentCount = 0;
  for (let i = 0; i < playerCount; i++) {
    if (i % 2 !== botIndex % 2) {
      opponentCount++;
      if (!knownVoids[i] || !knownVoids[i]['TRUMP']) {
        allOpponentsVoid = false;
        break;
      }
    }
  }

  if (opponentCount > 0 && allOpponentsVoid) {
    return false;
  }

  // Stock-Wahrscheinlichkeit berücksichtigen!
  // Bei 4 Spielern (24 Karten) liegen 4 Karten im Stock, bei 6 Spielern (32 Karten) 2 Karten.
  const stockSize = playerCount === 6 ? 2 : 4;
  
  // Wenn es nur noch so wenige oder weniger ungesehene Karten gibt, wie im Stock liegen, 
  // dann haben die Gegner DEFINITIV keine Trümpfe mehr (denn die Karten MÜSSEN im Stock liegen).
  if (unseenCards.length <= stockSize) {
    return false;
  }

  // Wenn nur noch 1 Trumpf ungesehen ist und wir tief im Spiel sind, ist die Wahrscheinlichkeit hoch, 
  // dass er im Stock liegt. Für den Bot nehmen wir aber "Sicherheit First" an, solange wir es nicht 100% wissen,
  // es sei denn, die Gegner sind als void bekannt.
  return true;
}

/**
 * Prüft, ob eine Karte die höchste verbleibende Karte in ihrer Farbe ist.
 */
function isSuitBoss(card, unseenCards = [], trumpSuit, isMitAnnounced, options = {}) {
  if (!card) return false;
  const isTrump = isTrumpCard(card, trumpSuit, isMitAnnounced, options);
  if (isTrump) {
    const myPower = getTrumpPower(card, trumpSuit, isMitAnnounced, options);
    return !unseenCards.some(u => isTrumpCard(u, trumpSuit, isMitAnnounced, options) && getTrumpPower(u, trumpSuit, isMitAnnounced, options) > myPower);
  } else {
    const myPower = getOffSuitPower(card);
    return !unseenCards.some(u => !isTrumpCard(u, trumpSuit, isMitAnnounced, options) && u.suit === card.suit && getOffSuitPower(u) > myPower);
  }
}

/**
 * Prüft, ob eine Karte eine unschlagbare "Boss-Karte" ist (kann von niemandem mehr übertroffen werden).
 */
function isBossCard(card, unseenCards = [], knownVoids = [], botIndex, trumpSuit, isMitAnnounced, options = {}, playerCount = 4) {
  if (!card || !trumpSuit) return false;
  const isTrump = isTrumpCard(card, trumpSuit, isMitAnnounced, options);

  if (isTrump) {
    // Höchster verbleibender Trumpf ist immer absolut unschlagbar
    return isSuitBoss(card, unseenCards, trumpSuit, isMitAnnounced, options);
  } else {
    // Fehlfarbe ist nur Boss, wenn sie höchst in ihrer Farbe ist UND kein Gegner mehr stechen kann
    const suitBoss = isSuitBoss(card, unseenCards, trumpSuit, isMitAnnounced, options);
    if (!suitBoss) return false;
    return !doOpponentsHaveTrumps(botIndex, unseenCards, knownVoids, trumpSuit, isMitAnnounced, options, playerCount);
  }
}


/**
 * Wählt die beste Trumpffarbe für den Ansager-Bot aus seinen ersten 3 Handkarten.
 */
function chooseTrumpSuit(hand3, options = {}) {
  const suitScores = {
    [SUITS.CLUBS]: 0,
    [SUITS.SPADES]: 0,
    [SUITS.HEARTS]: 0,
    [SUITS.DIAMONDS]: 0
  };

  const alwaysClubQueenTrump = options.alwaysClubQueenTrump !== false;
  const allowMit = options.allowMit !== false;

  for (const suit of Object.values(SUITS)) {
    let score = 0;
    let suitCount = 0;

    for (const card of hand3) {
      if (card.suit === suit) {
        suitCount++;
        if (card.rank === 'A') score += 10;
        else if (card.rank === 'K') score += 6;
        else if (card.rank === 'Q') score += 4;
        else if (card.rank === 'J') score += 3;
        else score += 2; // 10 oder 9
      }

      // Kreuz-Dame Bonus
      if (alwaysClubQueenTrump && card.suit === SUITS.CLUBS && card.rank === 'Q') {
        score += 7;
      }
      // Pik-Dame (Mit') Bonus
      if (allowMit && card.suit === SUITS.SPADES && card.rank === 'Q') {
        score += 8;
      }
    }

    // Längenbonus für mehr Karten derselben Farbe
    score += suitCount * 4;
    suitScores[suit] = score;
  }

  let bestSuit = SUITS.HEARTS;
  let maxScore = -1;
  for (const suit of Object.values(SUITS)) {
    if (suitScores[suit] > maxScore) {
      maxScore = suitScores[suit];
      bestSuit = suit;
    }
  }

  return bestSuit;
}

/**
 * Entscheidet deterministisch, ob der Ansager-Bot lieber blind den Trumpf drehen möchte (bei extrem schwachen 3 Karten).
 */
function shouldBotTurnTrump(hand3, options = {}) {
  const personality = options.botPersonality || 'standard';
  const hasAce = hand3.some(c => c.rank === 'A');
  const counts = {};
  for (const c of hand3) counts[c.suit] = (counts[c.suit] || 0) + 1;
  const maxInSuit = Math.max(...Object.values(counts));
  const hasClubQueen = hand3.some(c => c.suit === SUITS.CLUBS && c.rank === 'Q');
  const hasSpadeQueen = hand3.some(c => c.suit === SUITS.SPADES && c.rank === 'Q');

  if (personality === 'wildcard') {
    // Kneipen-Zocker: Liebt Risiko – dreht immer blind, sobald er kein Ass auf den ersten 3 Karten hat!
    if (!hasAce) return true;
    return false;
  }

  if (personality === 'aggressive') {
    // Aggressiv: Dreht schon blind, wenn er kein Ass hat und max 2 Karten einer Farbe ohne ♣Q/♠Q hält
    if (!hasAce && !hasClubQueen && !hasSpadeQueen && maxInSuit <= 2) {
      return true;
    }
    return false;
  }

  if (personality === 'passive') {
    // Passiv: Dreht fast nie blind, nur bei absoluter Nullhand (alles 9er/10er verschiedener Fehlfarben)
    const allZeroRanks = hand3.every(c => c.rank === '9' || c.rank === '10' || c.rank === '7' || c.rank === '8');
    if (allZeroRanks && maxInSuit < 2 && !hasClubQueen && !hasSpadeQueen) {
      return true;
    }
    return false;
  }

  // Standard-Bot (100% wie bisher):
  // Wenn der Bot kein Ass, keine ♣Q, keine ♠Q hat und max 1 Karte pro Farbe:
  // Vollkommen wertlose Hand -> Blind drehen ist taktisch klar überlegen.
  if (!hasAce && !hasClubQueen && !hasSpadeQueen && maxInSuit < 2) {
    return true;
  }
  return false;
}

/**
 * Entscheidet, ob der Bot (im Besitz der Pik-Dame) in Stich 1 die 'Mit' ansagen soll.
 */
function shouldAnnounceMit(hand, declarerIndex, botIndex, trumpSuit, options = {}) {
  if (options.allowMit === false) return false;
  const personality = options.botPersonality || 'standard';

  const isPartnerDeclarer = (declarerIndex % 2 === botIndex % 2);
  const trumpCount = hand.filter(c => isTrumpCard(c, trumpSuit, true, options)).length;
  const acesCount = hand.filter(c => c.rank === 'A').length;

  if (personality === 'aggressive') {
    // Aggressiv: Sagt Mit' fast immer an (schon ab 1 Trumpf oder 1 Ass, auch wenn Gegner Ansager ist)
    return (trumpCount >= 1 || acesCount >= 1);
  }

  if (personality === 'wildcard') {
    // Kneipen-Zocker: Sagt Mit' immer an, sobald er mindestens 1 Trumpf hat
    return trumpCount >= 1;
  }

  if (personality === 'passive') {
    // Passiv: Sehr vorsichtig
    if (isPartnerDeclarer) {
      return (trumpCount >= 1 || acesCount >= 1);
    }
    return (trumpCount >= 3 || (trumpCount >= 2 && acesCount >= 1));
  }

  // Standard-Bot (100% wie bisher):
  // Fall A: Partner ist Ansager
  if (isPartnerDeclarer) {
    // Ansagen, außer bei völlig chancenloser Hand (0 Trümpfe, 0 Asse)
    return (trumpCount >= 1 || acesCount >= 1);
  }

  // Fall B: Gegner ist Ansager
  // Bewährte Regel (oldMit): Trümpfe >= 2 ODER (Trümpfe >= 1 und Asse >= 1)
  return (trumpCount >= 2 || (trumpCount >= 1 && acesCount >= 1));
}

/**
 * Entscheidet, ob der Bot auf eine gegnerische Mit'-Ansage KONTRA geben soll.
 * Arena-optimierte Regel (contraAce3): Nur bei eigenem Trumpf-Ass und mindestens 3 Trümpfen insgesamt.
 */
function shouldAnnounceContra(hand, mitHolderIndex, botIndex, trumpSuit, options = {}) {
  const mitTeam = mitHolderIndex % 2 === 0 ? 0 : 1;
  const botTeam = botIndex % 2 === 0 ? 0 : 1;
  if (mitTeam === botTeam) return false; // Nicht gegen eigenes Team

  const personality = options.botPersonality || 'standard';
  const hasTrumpAce = hand.some(c => c.suit === trumpSuit && c.rank === 'A');
  const trumps = hand.filter(c => isTrumpCard(c, trumpSuit, true, options)).length;
  const hasClubQueen = hand.some(c => c.suit === SUITS.CLUBS && c.rank === 'Q');
  const acesCount = hand.filter(c => c.rank === 'A').length;

  if (personality === 'aggressive') {
    // Aggressiv: Gibt schon Kontra ab 2 Trümpfen (inkl. Ass oder ♣Q) oder 3 beliebigen Trümpfen
    return (trumps >= 2 && (hasTrumpAce || hasClubQueen)) || (trumps >= 3);
  }

  if (personality === 'passive') {
    // Passiv: Nur bei absoluter Monster-Hand (Trumpf-Ass + Kreuz-Dame + mind. 3 Trümpfe)
    return hasTrumpAce && hasClubQueen && trumps >= 3;
  }

  if (personality === 'wildcard') {
    // Kneipen-Zocker: Gibt Kontra bei >= 3 Trümpfen (auch ohne Trumpf-Ass) oder bei Trumpf-Ass + mind. 1 weiteres Ass
    return (trumps >= 3) || (hasTrumpAce && acesCount >= 2);
  }

  // Standard-Bot (100% wie bisher):
  return hasTrumpAce && trumps >= 3;
}

/**
 * Wählt taktisch die beste spielbare Karte aus der Hand des Bots.
 */
function chooseCardToPlay(hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options = {}) {
  if (!hand || hand.length === 0) return null;

  // 1. Alle regelkonformen spielbaren Karten ermitteln
  const playable = hand.filter(card =>
    isCardPlayable(card, hand, currentTrick, trumpSuit, isMitAnnounced, options)
  );

  if (playable.length === 0) return hand[0];
  if (playable.length === 1) return playable[0];

  const playerCount = options.playerCount || 4;
  const trickHistory = options.trickHistory || [];

  // Kartengedächtnis & Situationsanalyse aufbauen
  const playedCards = getPlayedCards(trickHistory, currentTrick);
  const unseenCards = getUnseenCards(hand, playedCards, playerCount);
  const knownVoids = getKnownVoids(trickHistory, playerCount, trumpSuit, isMitAnnounced, options);
  const oppsHaveTrumps = doOpponentsHaveTrumps(botIndex, unseenCards, knownVoids, trumpSuit, isMitAnnounced, options, playerCount);

  const memory = {
    playedCards,
    unseenCards,
    knownVoids,
    oppsHaveTrumps,
    playerCount
  };

  // 2. MCTS Rollout-Simulation (standardmäßig für Standard-Bots, falls nicht explizit deaktiviert)
  const botPersonality = options.botPersonality || 'standard';
  if (options.useMCTS !== false && botPersonality === 'standard') {
    const rollouts = typeof options.rollouts === 'number' ? options.rollouts : 30;
    return chooseCardMCTS(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory, rollouts);
  }

  // Fallback / Persönlichkeits-Heuristiken
  if (!currentTrick || currentTrick.length === 0) {
    return chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options, memory);
  }

  return chooseFollowCard(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory);
}

/**
 * Taktik beim Ausspielen einer neuen Karte (1. Karte im Stich).
 */
function chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options, memory = {}) {
  const { unseenCards = [], knownVoids = [], oppsHaveTrumps = true, playerCount = 4 } = memory;
  const personality = options.botPersonality || 'standard';
  const trumpsInHand = hand.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options));
  const trumpsPlayable = playable.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options));

  // Persönlichkeits-Spezifische Ausspiel-Präferenzen
  if (personality === 'aggressive') {
    // Aggressiv: Zieht konsequent Trümpfe, wenn er mindestens 2 Trümpfe hat und Gegner noch Trümpfe haben könnten
    if (oppsHaveTrumps && trumpsInHand.length >= 2 && trumpsPlayable.length > 0) {
      const sortedTrumpsDesc = [...trumpsPlayable].sort((a, b) =>
        getTrumpPower(b, trumpSuit, isMitAnnounced, options) - getTrumpPower(a, trumpSuit, isMitAnnounced, options)
      );
      return sortedTrumpsDesc[0];
    }
  } else if (personality === 'passive') {
    // Passiv: Schont Trümpfe und spielt lieber sichere 0-Augen-Luschen in Fehlfarben an
    const zeroPlayable = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && getCardPoints(c) === 0);
    if (zeroPlayable.length > 0) {
      return sortCardsByPowerAsc(zeroPlayable, trumpSuit, isMitAnnounced, options)[0];
    }
  } else if (personality === 'wildcard') {
    // Kneipen-Zocker: Liebt überraschende Ausspiele (z. B. ungesicherte Könige oder Asse)
    const wildCandidates = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && (c.rank === 'K' || c.rank === 'A'));
    if (wildCandidates.length > 0) {
      return wildCandidates[0];
    }
  }

  const hasTrumpAce = trumpsInHand.some(c => c.suit === trumpSuit && c.rank === 'A');
  const highTrumps = trumpsInHand.filter(c => {
    if (c.rank === 'A' || c.rank === 'K') return true;
    if (c.suit === SUITS.CLUBS && c.rank === 'Q') return true; // ♣Q
    if (isMitAnnounced && c.suit === SUITS.SPADES && c.rank === 'Q') return true; // ♠Q
    if (c.rank === 'Q') return true;
    return false;
  });
  const smallTrumpsPlayable = trumpsPlayable.filter(c =>
    c.rank === '9' || c.rank === '10' || c.rank === '7' || c.rank === '8' || c.rank === 'J'
  );

  // 1. SICHERE FEHLFARBEN-BOSSKARTEN AUSMÜNZEN (Cash safe boss cards)
  // Wenn Gegner keine Trümpfe mehr haben:
  // Jede Karte, die in ihrer Farbe die Höchste ist (z.B. Ass, oder König wenn Ass weg ist), gewinnt 100% sicher!
  if (!oppsHaveTrumps) {
    const safeBossCards = playable.filter(c =>
      !isTrumpCard(c, trumpSuit, isMitAnnounced, options) &&
      isSuitBoss(c, unseenCards, trumpSuit, isMitAnnounced, options)
    );
    if (safeBossCards.length > 0) {
      // Höchste Punkte zuerst einfahren (Ass = 4, König = 3, Dame = 2)
      safeBossCards.sort((a, b) => getCardPoints(b) - getCardPoints(a));
      return safeBossCards[0];
    }
  }

  // 2. TRÜMPFE ZIEHEN NUR BEI SEHR VIELEN HOHEN TRÜMPFEN (Draw Trumps with massive hand)
  // Wenn der Bot Trumpf-Ass/Boss hat UND mindestens 3 Trümpfe mit mindestens 2 hohen Trümpfen hält:
  // Nur dann dominiert er die Trumpffarbe so stark, dass Trümpfeziehen von vorne Sinn macht.
  const hasManyHighTrumps = trumpsInHand.length >= 3 && highTrumps.length >= 2;
  if (oppsHaveTrumps && hasManyHighTrumps && trumpsPlayable.length > 0) {
    const sortedTrumpsDesc = [...trumpsPlayable].sort((a, b) =>
      getTrumpPower(b, trumpSuit, isMitAnnounced, options) - getTrumpPower(a, trumpSuit, isMitAnnounced, options)
    );
    const topTrump = sortedTrumpsDesc[0];

    if (isSuitBoss(topTrump, unseenCards, trumpSuit, isMitAnnounced, options)) {
      return topTrump;
    }
  }

  // 3. SICHERE FEHLFARBEN-ASSE AUSSPIELEN
  // Bringen 4 Augen und gewinnen fast immer in den ersten Runden.
  const offSuitAces = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && c.rank === 'A');
  if (offSuitAces.length > 0) {
    // Bevorzuge Farben, in denen noch kein Gegner bekannt void ist (um nicht abgestochen zu werden)
    const safeAces = offSuitAces.filter(ace => {
      for (let i = 0; i < playerCount; i++) {
        if (i % 2 !== botIndex % 2 && knownVoids[i] && knownVoids[i][ace.suit] && (!knownVoids[i]['TRUMP'] || oppsHaveTrumps)) {
          return false; // Gegner ist void in dieser Farbe UND könnte noch Trümpfe haben -> Unsicher!
        }
      }
      return true;
    });
    if (safeAces.length > 0) return safeAces[0];
  }

  // 4. GEGNERISCHES TRUMPF-ASS MIT KLEINEM TRUMPF HERAUSLOCKEN
  // Wenn der Bot das Trumpf-Ass NICHT hat (Ass ist noch ungesehen draußen),
  // aber mindestens 2 Trümpfe besitzt und eine kleine Lusche (9, 10, J) opfern kann:
  // Spiele den kleinen Trumpf, um das gegnerische Ass herauszuholen!
  // WICHTIG: Wenn man nur ungeschützte hohe Trümpfe hat (z.B. nur König oder König+Dame),
  // spielt man KEINEN Trumpf auf, um den König nicht ins gegnerische Ass zu werfen!
  const isTrumpAceUnseen = unseenCards.some(u => u.suit === trumpSuit && u.rank === 'A');
  if (oppsHaveTrumps && !hasTrumpAce && isTrumpAceUnseen && trumpsInHand.length >= 2 && smallTrumpsPlayable.length > 0) {
    return sortCardsByPowerAsc(smallTrumpsPlayable, trumpSuit, isMitAnnounced, options)[0];
  }

  // 5. PARTNER FÜTTERN (Partner Feed)
  // Wenn wir wissen, dass unser Partner in einer Fehlfarbe frei ist (void), 
  // und ein Gegner vermutlich NICHT frei ist, spielen wir diese Farbe an, damit der Partner stechen kann!
  const offSuitZeroes = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && getCardPoints(c) === 0);
  if (offSuitZeroes.length > 0) {
    for (const zero of offSuitZeroes) {
      for (let i = 0; i < playerCount; i++) {
        if (i % 2 === botIndex % 2 && i !== botIndex) {
          if (knownVoids[i] && knownVoids[i][zero.suit] && !knownVoids[i]['TRUMP']) {
            return zero;
          }
        }
      }
    }
  }

  // 6. SICHERE 0-AUGEN-LUSCHE ANSSPIELEN (Kleines Ausspiel in Fehlfarbe)
  // Taktischer Standard: Wenn man das Trumpf-Ass hat (aber nicht übermäßig viele Trümpfe),
  // behält man das Ass und spielt eine kleine andere Farbe an.
  if (offSuitZeroes.length > 0) {
    return offSuitZeroes[0];
  }

  // 7. VERMEIDE UNGESCHÜTZTES KÖNIG-/DAMEN-AUSSPIEL (Fehlfarbe)
  // Spiele niemals einen Fehlfarben-König oder eine Dame aus, wenn das Ass dieser Farbe noch draußen (ungesehen) ist!
  const offSuitSafeBossNonAce = playable.filter(c => {
    if (isTrumpCard(c, trumpSuit, isMitAnnounced, options)) return false;
    if (c.rank !== 'K' && c.rank !== 'Q') return false;
    const aceUnseen = unseenCards.some(u => u.suit === c.suit && u.rank === 'A');
    return !aceUnseen; // Nur spielen, wenn Ass bereits gespielt wurde!
  });
  if (offSuitSafeBossNonAce.length > 0) {
    return offSuitSafeBossNonAce[0];
  }

  // 8. NOTFALL: Unsafe Asse spielen, wenn nichts anderes übrig bleibt
  if (offSuitAces.length > 0) {
    return offSuitAces[0];
  }

  // 9. FALLBACK: Niedrigste spielbare Karte
  return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
}

/**
 * Taktik beim Zugeben zu einem bestehenden Stich.
 */
function chooseFollowCard(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory = {}) {
  const { unseenCards = [], knownVoids = [], oppsHaveTrumps = true, playerCount = 4 } = memory;
  const evalResult = evaluateTrick(currentTrick, trumpSuit, isMitAnnounced, options);
  const currentWinner = evalResult.winnerIndex;
  const isPartnerWinning = (currentWinner % 2 === botIndex % 2);
  const trickPoints = currentTrick.reduce((sum, e) => sum + getCardPoints(e.card), 0);
  const maxPlayers = playerCount;
  const isLastPlayer = (currentTrick.length === maxPlayers - 1);

  // Welche unserer Karten können den Stich übernehmen?
  const winningCards = [];
  const losingCards = [];

  for (const card of playable) {
    const simTrick = [...currentTrick, { playerIndex: botIndex, card }];
    const res = evaluateTrick(simTrick, trumpSuit, isMitAnnounced, options);
    if (res.winnerIndex === botIndex) {
      winningCards.push(card);
    } else {
      losingCards.push(card);
    }
  }

  // --------------------------------------------------------------------------
  // FALL 1: PARTNER FÜHRT AKTUELL DEN STICH!
  // --------------------------------------------------------------------------
  if (isPartnerWinning) {
    const leadEntry = currentTrick[0];
    const leadCard = leadEntry ? (leadEntry.card || leadEntry) : null;
    const partnerCard = evalResult.winningCard;
    const partnerCardIsTrump = isTrumpCard(partnerCard, trumpSuit, isMitAnnounced, options);
    const partnerIsSuitBoss = isSuitBoss(partnerCard, unseenCards, trumpSuit, isMitAnnounced, options);

    // Wenn eine Fehlfarbe angespielt wurde und Bot diese Farbe bedienen kann (ohne zu stechen):
    const nonTrumpFollowCards = playable.filter(c =>
      !isTrumpCard(c, trumpSuit, isMitAnnounced, options) &&
      leadCard && c.suit === leadCard.suit
    );

    // Ist der Stichgewinn für das eigene Team 100% garantiert?
    let isGuaranteedWin = false;

    if (isLastPlayer) {
      // Letzter Spieler: Niemand kommt mehr nach uns -> Stich ist 100% sicher!
      isGuaranteedWin = true;
    } else if (partnerCard) {
      if (partnerCardIsTrump && partnerIsSuitBoss) {
        // Partner führt mit dem höchsten verbleibenden Trumpf -> Unschlagbar!
        isGuaranteedWin = true;
      } else if (!partnerCardIsTrump && partnerIsSuitBoss && !oppsHaveTrumps) {
        // Partner führt mit Farb-Boss und kein Gegner hat mehr Trümpfe -> Unschlagbar!
        isGuaranteedWin = true;
      }
    }

    // 1.1: PARTNER-SIEG IST 100% GARANTIERT
    if (isGuaranteedWin) {
      // --> SCHMIEREN! (Dem Partner möglichst viele Augen füttern)
      // Aber NIEMALS unnötig einen Trumpf verheizen, wenn wir Fehlfarben haben!

      // A) Wenn wir die angespielte Farbe haben:
      if (nonTrumpFollowCards.length > 0) {
        // Schmiere die höchste Karte dieser Farbe (Ass=4, König=3, Dame=2, Bube=1)
        const sortedFollow = [...nonTrumpFollowCards].sort((a, b) => getCardPoints(b) - getCardPoints(a));
        return sortedFollow[0];
      }

      // B) Wenn wir die angespielte Farbe NICHT haben (wir dürfen frei wählen):
      // Wähle die höchste Nicht-Trumpf-Augen-Karte aller Fehlfarben (Schmieren)
      const offSuitPoints = playable
        .filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options))
        .sort((a, b) => getCardPoints(b) - getCardPoints(a));

      if (offSuitPoints.length > 0 && getCardPoints(offSuitPoints[0]) > 0) {
        return offSuitPoints[0]; // Schmieren mit Ass, König, Dame oder Bube!
      }

      // C) Wenn nur 0-Punkte Fehlfarben da sind: 0-Punkte Fehlfarbe abwerfen
      const offSuitZeroes = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && getCardPoints(c) === 0);
      if (offSuitZeroes.length > 0) {
        return offSuitZeroes[0];
      }

      // D) Wenn Bot NUR Trümpfe auf der Hand hat: Kleinstmöglichen Trumpf beilegen
      return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
    }

    // 1.2: PARTNER-SIEG IST NOCH NICHT 100% GARANTIERT (Gegner kommen noch nach uns)
    // Grundsatz: NIEMALS dem eigenen Partner leichtfertig den Stich wegnehmen / überstechen!

    // Regel A: Wenn der Bot die angespielte Farbe regulär bedienen kann:
    // Der Bot darf HIER KEINEN TRUMPF reinwerfen!
    if (nonTrumpFollowCards.length > 0) {
      // Wenn Partner mit einem Ass oder Boss führt: Behalte hohe Karten, wirf eine kleine Lusche (0 Pkt) bei!
      const zeroes = nonTrumpFollowCards.filter(c => getCardPoints(c) === 0);
      if (zeroes.length > 0) return zeroes[0];
      // Falls keine 0er in der Farbe vorhanden: Kleinste Karte nach Punkten beilegen (Bube vor Dame vor König vor Ass)
      const sorted = [...nonTrumpFollowCards].sort((a, b) => getCardPoints(a) - getCardPoints(b));
      return sorted[0];
    }

    // Regel B: Bot kann die Farbe NICHT bedienen (kann abwerfen oder stechen):
    // Nur in dem extremen Ausnahmefall absichern:
    // 1) Stich hat massiv viele Augen (>= 6 Punkte, z.B. Ass + König etc.)
    // 2) Bot hat einen absoluten Boss-Trumpf (den kein Gegner mehr übertrumpfen kann)
    // 3) Partner-Karte ist selbst noch kein Boss-Trumpf
    if (trickPoints >= 6 && winningCards.length > 0) {
      const bossTrumps = winningCards.filter(c =>
        isTrumpCard(c, trumpSuit, isMitAnnounced, options) &&
        isBossCard(c, unseenCards, knownVoids, botIndex, trumpSuit, isMitAnnounced, options, maxPlayers)
      );
      if (bossTrumps.length > 0) {
        // Den fetten Stich mit dem Boss-Trumpf bombensicher absichern!
        return sortCardsByPowerAsc(bossTrumps, trumpSuit, isMitAnnounced, options)[0];
      }
    }

    // Regel C: In allen normalen Fällen: DEM PARTNER DEN STICH ÜBERLASSEN & 0 PUNKTE ABWERFEN!
    // Auf keinen Fall einen Trumpf verschwenden oder den Stich des Partners kapern!
    // 1. Bevorzuge 0-Augen Fehlfarben (9, 10, 7, 8 einer anderen Farbe)
    const offSuitZeroes = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && getCardPoints(c) === 0);
    if (offSuitZeroes.length > 0) {
      return offSuitZeroes[0];
    }

    // 2. Andere Fehlfarben mit geringen Punkten abwerfen (Bube=1 vor Dame=2 vor König=3 vor Ass=4)
    const offSuitAny = playable
      .filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options))
      .sort((a, b) => getCardPoints(a) - getCardPoints(b));
    if (offSuitAny.length > 0) {
      return offSuitAny[0];
    }

    // 3. Nur wenn der Bot AUSSCHLIESSLICH Trümpfe hält: Den kleinsten Trumpf sparsam beilegen
    return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
  }

  // --------------------------------------------------------------------------
  // FALL 2: GEGNER FÜHRT DEN STICH!
  // --------------------------------------------------------------------------
  const personality = options.botPersonality || 'standard';
  if (personality === 'aggressive' && winningCards.length > 0) {
    // Aggressiv: Übernimmt gegnerische Stiche konsequent schon ab geringen Punkten
    return sortCardsByPowerAsc(winningCards, trumpSuit, isMitAnnounced, options)[0];
  }
  if (personality === 'passive' && winningCards.length > 0 && trickPoints < 3 && !isLastPlayer) {
    // Passiv: Verzichtet vorzeitig auf teures Stechen mit hohem Trumpf, wirft lieber billig ab
    const zeroes = losingCards.filter(c => getCardPoints(c) === 0);
    if (zeroes.length > 0) return zeroes[0];
  }

  if (winningCards.length > 0) {
    const minWinningCard = sortCardsByPowerAsc(winningCards, trumpSuit, isMitAnnounced, options)[0];
    const totalPointsIfWon = trickPoints + getCardPoints(minWinningCard);

    // Kriterium zum Stechen / Übernehmen:
    // A) Letzter Spieler (isLastPlayer) -> Jeder Stichgewinn ist sicher zu 100%!
    // B) Lohnender Stich (>= 2 Punkte im Stich oder total >= 3)
    // C) Nicht-Trumpf-Gewinn (Fehlfarbe regulär überstochen mit Ass/König) -> Immer mitnehmen!
    const isNonTrumpWin = !isTrumpCard(minWinningCard, trumpSuit, isMitAnnounced, options);

    if (isLastPlayer || totalPointsIfWon >= 3 || trickPoints >= 2 || isNonTrumpWin) {
      // Wenn der Gegner den Stich bereits mit einem Trumpf übernommen hat (z.B. Partner-Ass abgestochen)
      // ODER der Stich massiv viele Augen hat (>= 6 Punkte) und noch ein Gegner nach uns kommt:
      // Falls wir einen Boss-Trumpf haben, sichern wir den Stich damit bombensicher vor dem hinteren Gegner ab!
      const opponentWinningWithTrump = isTrumpCard(evalResult.winningCard, trumpSuit, isMitAnnounced, options);
      if (!isLastPlayer && ((trickPoints >= 4 && opponentWinningWithTrump) || trickPoints >= 6)) {
        const bossWinningCards = winningCards.filter(c =>
          isTrumpCard(c, trumpSuit, isMitAnnounced, options) &&
          isBossCard(c, unseenCards, knownVoids, botIndex, trumpSuit, isMitAnnounced, options, maxPlayers)
        );
        if (bossWinningCards.length > 0) {
          return sortCardsByPowerAsc(bossWinningCards, trumpSuit, isMitAnnounced, options)[0];
        }
      }

      // Ansonsten mit dem sparsamsten (niedrigsten) Trumpf / Karte stechen, die reicht!
      return minWinningCard;
    }

    // Wenn noch Gegner nach uns kommen und der Stich 0-1 Augen hat:
    // Sparsam sein: Nur stechen, wenn minWinningCard ein kleiner Trumpf (Lusche oder Bube) ist
    const isLowTrump = isTrumpCard(minWinningCard, trumpSuit, isMitAnnounced, options) &&
      (minWinningCard.rank === '7' || minWinningCard.rank === '8' || minWinningCard.rank === '9' || minWinningCard.rank === '10' || minWinningCard.rank === 'J');
    if (isLowTrump) {
      return minWinningCard;
    }
  }

  // --------------------------------------------------------------------------
  // FALL 3: WIR KÖNNEN/WOLLEN DEN STICH NICHT GEWINNEN
  // --> SCHNORREN / 0-PUNKTE-ABWURF: Dem Gegner bloß keine Augen schenken!
  // --------------------------------------------------------------------------
  // 1. Zuerst 0-Punkte-Karten (7, 8, 9, 10) abwerfen
  const zeroPointCards = playable.filter(c => getCardPoints(c) === 0);
  if (zeroPointCards.length > 0) {
    // Bevorzuge Fehlfarben-0er vor Trumpf-0ern
    const offSuitZeroes = zeroPointCards.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options));
    if (offSuitZeroes.length > 0) {
      return offSuitZeroes[0];
    }
    return zeroPointCards[0];
  }

  // 2. Wenn keine 0-Punkte-Karte da ist: Niedrigste Punktzahl abwerfen (Bube=1 vor Dame=2 vor König=3 vor Ass=4)
  const sortedByPointsAsc = [...playable].sort((a, b) => getCardPoints(a) - getCardPoints(b));
  return sortedByPointsAsc[0];
}

/**
 * Sortiert Karten aufsteigend nach relativer Spielstärke.
 */
function sortCardsByPowerAsc(cards, trumpSuit, isMitAnnounced, options) {
  return [...cards].sort((a, b) => {
    const aIsTrump = isTrumpCard(a, trumpSuit, isMitAnnounced, options);
    const bIsTrump = isTrumpCard(b, trumpSuit, isMitAnnounced, options);

    if (aIsTrump && !bIsTrump) return 1;
    if (!aIsTrump && bIsTrump) return -1;

    if (aIsTrump && bIsTrump) {
      return getTrumpPower(a, trumpSuit, isMitAnnounced, options) - getTrumpPower(b, trumpSuit, isMitAnnounced, options);
    }

    return getOffSuitPower(a) - getOffSuitPower(b);
  });
}

// ---------------------------------------------------------------------------
// MONTE-CARLO ROLLOUT SEARCH (PIMC)
// ---------------------------------------------------------------------------

function hashState(botIndex, hand, currentTrick, trickHistory) {
  let str = `${botIndex}_`;
  for (const c of hand) str += `${c.suit}${c.rank}`;
  str += '_';
  for (const t of currentTrick) str += `${t.playerIndex}${t.card.suit}${t.card.rank}`;
  str += `_${trickHistory ? trickHistory.length : 0}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateDeterminization(botIndex, hand, unseenCards, knownVoids, playerCount, currentTrick, trumpSuit, isMit, options, rng) {
  const needed = {};
  const playedInTrick = new Set(currentTrick.map(t => t.playerIndex));
  for (let p = 0; p < playerCount; p++) {
    if (p === botIndex) continue;
    needed[p] = playedInTrick.has(p) ? hand.length - 1 : hand.length;
  }

  const stockSize = playerCount === 6 ? 2 : 4;

  for (let attempt = 0; attempt < 15; attempt++) {
    const shuffled = shuffle(unseenCards, rng);
    const assigned = {};
    for (let p = 0; p < playerCount; p++) assigned[p] = [];
    const stock = [];

    let valid = true;
    for (const card of shuffled) {
      const effSuit = getEffectiveSuit(card, trumpSuit, isMit, options);
      const candidates = [];
      for (let p = 0; p < playerCount; p++) {
        if (p === botIndex) continue;
        if (assigned[p].length < needed[p]) {
          const isVoid = knownVoids[p] && knownVoids[p][effSuit];
          if (!isVoid) candidates.push(p);
        }
      }

      if (candidates.length > 0) {
        const pick = candidates[Math.floor(rng() * candidates.length)];
        assigned[pick].push(card);
      } else if (stock.length < stockSize) {
        stock.push(card);
      } else {
        const needy = [];
        for (let p = 0; p < playerCount; p++) {
          if (p !== botIndex && assigned[p].length < needed[p]) needy.push(p);
        }
        if (needy.length > 0) {
          const pick = needy[Math.floor(rng() * needy.length)];
          assigned[pick].push(card);
        } else {
          valid = false;
          break;
        }
      }
    }

    if (valid) {
      let countsMatch = true;
      for (let p = 0; p < playerCount; p++) {
        if (p !== botIndex && assigned[p].length !== needed[p]) {
          countsMatch = false;
          break;
        }
      }
      if (countsMatch) {
        return assigned;
      }
    }
  }

  const shuffled = shuffle(unseenCards, rng);
  const assigned = {};
  for (let p = 0; p < playerCount; p++) assigned[p] = [];
  let ptr = 0;
  for (let p = 0; p < playerCount; p++) {
    if (p === botIndex) continue;
    for (let c = 0; c < needed[p]; c++) {
      if (ptr < shuffled.length) assigned[p].push(shuffled[ptr++]);
    }
  }
  return assigned;
}

function pickRolloutCard(playerIndex, playerHand, trick, trumpSuit, isMit, options) {
  const playable = playerHand.filter(c => isCardPlayable(c, playerHand, trick, trumpSuit, isMit, options));
  if (playable.length === 0) return playerHand[0];
  if (playable.length === 1) return playable[0];

  if (!trick || trick.length === 0) {
    const trumps = playable.filter(c => isTrumpCard(c, trumpSuit, isMit, options));
    if (trumps.length >= 2) {
      trumps.sort((a, b) => getTrumpPower(b, trumpSuit, isMit, options) - getTrumpPower(a, trumpSuit, isMit, options));
      return trumps[0];
    }
    const aces = playable.filter(c => c.rank === 'A');
    if (aces.length > 0) return aces[0];
    playable.sort((a, b) => getCardPoints(a) - getCardPoints(b));
    return playable[0];
  }

  const currentLeader = evaluateTrick(trick, trumpSuit, isMit, options);
  const isPartnerWinning = (currentLeader.winnerIndex % 2 === playerIndex % 2);

  if (isPartnerWinning) {
    playable.sort((a, b) => getCardPoints(b) - getCardPoints(a));
    return playable[0];
  }

  const winningCards = playable.filter(card => {
    const testTrick = [...trick, { playerIndex, card }];
    const res = evaluateTrick(testTrick, trumpSuit, isMit, options);
    return res.winnerIndex === playerIndex;
  });

  if (winningCards.length > 0) {
    winningCards.sort((a, b) => {
      const aTr = isTrumpCard(a, trumpSuit, isMit, options);
      const bTr = isTrumpCard(b, trumpSuit, isMit, options);
      if (aTr && !bTr) return 1;
      if (!aTr && bTr) return -1;
      if (aTr && bTr) return getTrumpPower(a, trumpSuit, isMit, options) - getTrumpPower(b, trumpSuit, isMit, options);
      return getOffSuitPower(a) - getOffSuitPower(b);
    });
    return winningCards[0];
  }

  playable.sort((a, b) => getCardPoints(a) - getCardPoints(b));
  return playable[0];
}

function simulateRollout(candidateCard, botIndex, initialHands, currentTrick, trumpSuit, isMit, options, playerCount) {
  const hands = {};
  for (let p = 0; p < playerCount; p++) hands[p] = [...initialHands[p]];

  const cIdx = hands[botIndex].findIndex(c => c.id === candidateCard.id);
  if (cIdx !== -1) hands[botIndex].splice(cIdx, 1);

  let trick = [...currentTrick, { playerIndex: botIndex, card: candidateCard }];
  let leader = trick[0].playerIndex;
  let myTeamEyes = 0;
  const botTeam = botIndex % 2;

  const playedPlayers = new Set(trick.map(t => t.playerIndex));
  for (let step = 0; step < playerCount; step++) {
    const p = (leader + step) % playerCount;
    if (!playedPlayers.has(p)) {
      const card = pickRolloutCard(p, hands[p], trick, trumpSuit, isMit, options);
      const idx = hands[p].findIndex(c => c.id === card.id);
      if (idx !== -1) hands[p].splice(idx, 1);
      trick.push({ playerIndex: p, card });
      playedPlayers.add(p);
    }
  }

  let evalRes = evaluateTrick(trick, trumpSuit, isMit, options);
  if (evalRes.winnerIndex % 2 === botTeam) {
    myTeamEyes += evalRes.points;
  }
  leader = evalRes.winnerIndex;

  const remainingTricks = hands[botIndex].length;
  for (let t = 0; t < remainingTricks; t++) {
    trick = [];
    for (let step = 0; step < playerCount; step++) {
      const player = (leader + step) % playerCount;
      const card = pickRolloutCard(player, hands[player], trick, trumpSuit, isMit, options);
      const idx = hands[player].findIndex(c => c.id === card.id);
      if (idx !== -1) hands[player].splice(idx, 1);
      trick.push({ playerIndex: player, card });
    }
    evalRes = evaluateTrick(trick, trumpSuit, isMit, options);
    if (evalRes.winnerIndex % 2 === botTeam) {
      myTeamEyes += evalRes.points;
    }
    leader = evalRes.winnerIndex;
  }

  return myTeamEyes;
}

function chooseCardMCTS(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory, numRollouts = 30) {
  const { unseenCards = [], knownVoids = [], playerCount = 4 } = memory;
  const trickHistory = options.trickHistory || [];
  const seed = hashState(botIndex, hand, currentTrick, trickHistory);
  const rng = mulberry32(seed);

  const scores = {};
  for (const c of playable) scores[c.id] = 0;

  for (let r = 0; r < numRollouts; r++) {
    const world = generateDeterminization(botIndex, hand, unseenCards, knownVoids, playerCount, currentTrick, trumpSuit, isMitAnnounced, options, rng);
    world[botIndex] = [...hand];

    for (const c of playable) {
      const eyes = simulateRollout(c, botIndex, world, currentTrick, trumpSuit, isMitAnnounced, options, playerCount);
      scores[c.id] += eyes;
    }
  }

  let maxScore = -1;
  for (const c of playable) {
    if (scores[c.id] > maxScore) maxScore = scores[c.id];
  }

  const bestCards = playable.filter(c => scores[c.id] === maxScore);
  if (bestCards.length === 1) return bestCards[0];

  // Tie-breaker: heursitische Bewertung der Gleichstand-Kandidaten
  if (!currentTrick || currentTrick.length === 0) {
    return chooseLeadCard(bestCards, hand, trumpSuit, isMitAnnounced, botIndex, options, memory);
  }
  return chooseFollowCard(bestCards, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory);
}

module.exports = {
  BOT_PERSONALITIES,
  chooseTrumpSuit,
  shouldBotTurnTrump,
  shouldAnnounceMit,
  shouldAnnounceContra,
  chooseCardToPlay,
  getPlayedCards,
  getUnseenCards,
  getKnownVoids,
  doOpponentsHaveTrumps,
  isBossCard,
  isSuitBoss,
  chooseCardMCTS
};
