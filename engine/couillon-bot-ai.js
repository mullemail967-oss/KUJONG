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
  const hasAce = hand3.some(c => c.rank === 'A');
  const counts = {};
  for (const c of hand3) counts[c.suit] = (counts[c.suit] || 0) + 1;
  const maxInSuit = Math.max(...Object.values(counts));
  const hasClubQueen = hand3.some(c => c.suit === SUITS.CLUBS && c.rank === 'Q');
  const hasSpadeQueen = hand3.some(c => c.suit === SUITS.SPADES && c.rank === 'Q');

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

  const isPartnerDeclarer = (declarerIndex % 2 === botIndex % 2);
  const trumpCount = hand.filter(c => isTrumpCard(c, trumpSuit, true, options)).length;
  const acesCount = hand.filter(c => c.rank === 'A').length;

  // Qualitätstrümpfe für starke Ansagen
  const hasTrumpAce = hand.some(c => isTrumpCard(c, trumpSuit, true, options) && c.rank === 'A');
  const hasTrumpKing = hand.some(c => isTrumpCard(c, trumpSuit, true, options) && c.rank === 'K');
  const hasClubQueen = hand.some(c => c.suit === SUITS.CLUBS && c.rank === 'Q');
  const hasQualityTrump = hasTrumpAce || hasTrumpKing || hasClubQueen;

  // Fall A: Partner ist Ansager
  if (isPartnerDeclarer) {
    // Ansagen, außer bei völlig chancenloser Hand (0 Trümpfe, 0 Asse)
    return (trumpCount >= 1 || acesCount >= 1);
  }

  // Fall B: Gegner ist Ansager
  // Gegner hat Trumpf gewählt -> wir müssen vorsichtig sein!
  // Nur ansagen bei starker eigener Hand (mindestens 2 Trümpfe inkl. Qualitätstrumpf, oder Qualitätstrumpf + Ass).
  if (trumpCount >= 2 && hasQualityTrump) {
    return true;
  }
  if (trumpCount >= 1 && hasQualityTrump && acesCount >= 1) {
    return true;
  }

  return false;
}

/**
 * Entscheidet, ob der Bot auf eine gegnerische Mit'-Ansage KONTRA geben soll.
 */
function shouldAnnounceContra(hand, mitHolderIndex, botIndex, trumpSuit, options = {}) {
  const mitTeam = mitHolderIndex % 2 === 0 ? 0 : 1;
  const botTeam = botIndex % 2 === 0 ? 0 : 1;
  if (mitTeam === botTeam) return false; // Nicht im selben Team

  const hasTrumpAce = hand.some(c => c.suit === trumpSuit && c.rank === 'A');
  const hasClubQueen = hand.some(c => c.suit === SUITS.CLUBS && c.rank === 'Q');
  const hasTrumpKing = hand.some(c => c.suit === trumpSuit && c.rank === 'K');
  const trumps = hand.filter(c => isTrumpCard(c, trumpSuit, true, options)).length;
  const aces = hand.filter(c => c.rank === 'A').length;

  // Kontra-Bedingungen:
  // 1. Bot hat das unschlagbare Trumpf-Ass + weitere Trümpfe oder Asse
  if (hasTrumpAce && (trumps >= 2 || aces >= 1)) {
    return true;
  }
  // 2. Bot hat Kreuz-Dame + Trumpf-König + Ass
  if (hasClubQueen && hasTrumpKing && aces >= 1) {
    return true;
  }
  // 3. Bot hat mind. 3 Trümpfe und 2 Asse
  if (trumps >= 3 && aces >= 2) {
    return true;
  }

  return false;
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

  // 2. SITUATION A: Bot eröffnet den Stich (Ausspiel)
  if (!currentTrick || currentTrick.length === 0) {
    return chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options, memory);
  }

  // 3. SITUATION B: Bot bedient oder sticht (2., 3. oder 4. Spieler im Stich)
  return chooseFollowCard(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options, memory);
}

/**
 * Taktik beim Ausspielen einer neuen Karte (1. Karte im Stich).
 */
function chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options, memory = {}) {
  const { unseenCards = [], knownVoids = [], oppsHaveTrumps = true, playerCount = 4 } = memory;
  const trumpsInHand = hand.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options));
  const trumpsPlayable = playable.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options));

  // 1. TRÜMPFE ZIEHEN (Draw Trumps)
  // Wenn der Bot eine Boss-Trumpfkarte besitzt (z.B. Trumpf-Ass oder höchste verbleibende Trumpfkarte)
  // und die Gegner noch Trümpfe halten können:
  if (oppsHaveTrumps && trumpsPlayable.length > 0) {
    const sortedTrumpsDesc = [...trumpsPlayable].sort((a, b) =>
      getTrumpPower(b, trumpSuit, isMitAnnounced, options) - getTrumpPower(a, trumpSuit, isMitAnnounced, options)
    );
    const topTrump = sortedTrumpsDesc[0];

    if (isSuitBoss(topTrump, unseenCards, trumpSuit, isMitAnnounced, options)) {
      // Wenn wir mind. 2 Trümpfe haben ODER unser Team der Ansager ist:
      const isDeclarerTeam = options.declarerIndex !== undefined && (options.declarerIndex % 2 === botIndex % 2);
      if (trumpsInHand.length >= 2 || isDeclarerTeam) {
        return topTrump;
      }
    }
  }

  // 2. SICHERE FEHLFARBEN-BOSSKARTEN AUSMÜNZEN (Cash safe boss cards)
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

  // 3. FEHLFARBEN-ASSE AUSSPIELEN
  // Bringen 4 Augen und gewinnen oft den Stich.
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
    
    // Wenn es KEINE sicheren Asse gibt, heben wir sie auf und spielen sie HIER NICHT aus, 
    // um sie nicht sinnlos an einen abtrumpfenden Gegner zu verlieren.
  }

  // 4. PARTNER FÜTTERN (Partner Feed)
  // Wenn wir wissen, dass unser Partner in einer Farbe frei ist (void), 
  // und ein Gegner vermutlich NICHT frei ist, spielen wir diese Farbe an, damit der Partner stechen kann!
  const offSuitZeroes = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && getCardPoints(c) === 0);
  if (offSuitZeroes.length > 0) {
    for (const zero of offSuitZeroes) {
      for (let i = 0; i < playerCount; i++) {
        // Suche nach Partnern
        if (i % 2 === botIndex % 2 && i !== botIndex) {
          if (knownVoids[i] && knownVoids[i][zero.suit] && !knownVoids[i]['TRUMP']) {
            // Partner ist void in dieser Fehlfarbe und hat evtl. noch Trümpfe -> Füttern!
            return zero;
          }
        }
      }
    }
  }

  // 5. VERMEIDE UNGESCHÜTZTES KÖNIG-/DAMEN-AUSSPIEL
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

  // 6. SICHERE 0-AUGEN-LUSCHE ANSSPIELEN (Passives, risikoarmes Ausspiel)
  if (offSuitZeroes.length > 0) {
    return offSuitZeroes[0];
  }

  // 7. NOTFALL: Unsafe Asse spielen, wenn nichts anderes übrig bleibt
  if (offSuitAces.length > 0) {
    return offSuitAces[0];
  }

  // 6. FALLBACK: Niedrigste spielbare Karte
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

module.exports = {
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
  isSuitBoss
};
