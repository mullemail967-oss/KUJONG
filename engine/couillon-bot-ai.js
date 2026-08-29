/**
 * Couillon / Kujong Bot AI Engine
 * 
 * Taktische Heuristiken für Bots ohne Schummeln (keine verdeckten Karten einsehen).
 * Berücksichtigt Stich-Augen, Partnerführung (Schmieren), sparsames Stechen,
 * 0-Punkte-Abwurf (Schnorren), Mit'- und Kontra-Strategie.
 */

const { SUITS, isTrumpCard, getTrumpPower, getOffSuitPower, isCardPlayable, evaluateTrick, POINT_VALUES } = require('./couillon-rules');

const getCardPoints = (c) => (c && c.points !== undefined) ? c.points : (c ? (POINT_VALUES[c.rank] || 0) : 0);

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
 * Entscheidet, ob der Ansager-Bot lieber blind den Trumpf drehen möchte (bei schwachen 3 Karten).
 */
function shouldBotTurnTrump(hand3, options = {}) {
  // Wenn der Bot kein Ass hat und keine 2 Karten einer Farbe besitzt
  const hasAce = hand3.some(c => c.rank === 'A');
  const counts = {};
  for (const c of hand3) counts[c.suit] = (counts[c.suit] || 0) + 1;
  const maxInSuit = Math.max(...Object.values(counts));

  if (!hasAce && maxInSuit < 2) {
    return Math.random() < 0.65;
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

  // Fall A: Partner ist Ansager
  // Partner hat Trumpf gewählt -> Ansager-Team ist im Vorteil.
  // Mit' gibt unserem Team den 2. Trumpf (90 Power) und verdoppelt den Rundenwert auf 2 Punkte.
  if (isPartnerDeclarer) {
    // Fast immer ansagen, außer bei völlig chancenloser Hand (0 Trümpfe, 0 Asse)
    if (trumpCount >= 1 || acesCount >= 1) {
      return true;
    }
    return Math.random() < 0.85;
  }

  // Fall B: Gegner ist Ansager
  // Gegner hat Trumpf gewählt -> wir müssen vorsichtig sein, da wir dem Gegner sonst 2 oder 4 Punkte schenken!
  // Nur ansagen bei starker eigener Hand (mindestens 2 Trümpfe inkl. ♠Q, oder ♠Q + Ass).
  if (trumpCount >= 2 || (trumpCount >= 1 && acesCount >= 1)) {
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

  // 2. SITUATION A: Bot eröffnet den Stich (Ausspiel)
  if (!currentTrick || currentTrick.length === 0) {
    return chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options);
  }

  // 3. SITUATION B: Bot bedient oder sticht (2., 3. oder 4. Spieler im Stich)
  return chooseFollowCard(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options);
}

/**
 * Taktik beim Ausspielen einer neuen Karte (1. Karte im Stich).
 */
function chooseLeadCard(playable, hand, trumpSuit, isMitAnnounced, botIndex, options) {
  const hasTrumpAce = playable.some(c => c.suit === trumpSuit && c.rank === 'A');
  const hasMit = playable.some(c => isMitAnnounced && c.suit === SUITS.SPADES && c.rank === 'Q');
  const trumpsCount = hand.filter(c => isTrumpCard(c, trumpSuit, isMitAnnounced, options)).length;

  // 1. Wenn Bot das Trumpf-Ass hat und noch mind. einen weiteren Trumpf:
  // Trumpf-Ass ausspielen, um Trümpfe der Gegner zu ziehen und sicher 4 Augen einzufahren!
  if (hasTrumpAce && trumpsCount >= 2) {
    const trumpAce = playable.find(c => c.suit === trumpSuit && c.rank === 'A');
    if (trumpAce) return trumpAce;
  }

  // 2. Wenn Mit' aktiv ist und Bot die Mit' hat (und Trumpf-Ass vielleicht weg ist):
  if (hasMit && trumpsCount >= 2) {
    const mitCard = playable.find(c => c.suit === SUITS.SPADES && c.rank === 'Q');
    if (mitCard) return mitCard;
  }

  // 3. Sichere Fehlfarben-Asse ausspielen (bringen 4 Augen und gewinnen oft den Stich)
  const offSuitAces = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && c.rank === 'A');
  if (offSuitAces.length > 0) {
    return offSuitAces[0];
  }

  // 4. Fehlfarben-Könige oder Damen spielen
  const offSuitHigh = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && (c.rank === 'K' || c.rank === 'Q'));
  if (offSuitHigh.length > 0 && Math.random() < 0.6) {
    return offSuitHigh[0];
  }

  // 5. Kleine Fehlfarbe (7, 8, 9 oder 10) anspielen, um keine hohen Karten zu riskieren
  const offSuitLow = playable.filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options) && (c.rank === '7' || c.rank === '8' || c.rank === '9' || c.rank === '10'));
  if (offSuitLow.length > 0) {
    return offSuitLow[0];
  }

  // 6. Niedrigste spielbare Karte
  return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
}

/**
 * Taktik beim Zugeben zu einem bestehenden Stich.
 */
function chooseFollowCard(playable, hand, currentTrick, trumpSuit, isMitAnnounced, botIndex, options) {
  // Aktuellen Stich-Gewinner und Punkte im Stich ermitteln
  const evalResult = evaluateTrick(currentTrick, trumpSuit, isMitAnnounced, options);
  const currentWinner = evalResult.winnerIndex;
  const isPartnerWinning = (currentWinner % 2 === botIndex % 2);
  const trickPoints = currentTrick.reduce((sum, e) => sum + getCardPoints(e.card), 0);
  const maxPlayers = options.playerCount || 4;
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
    // Wenn Bot der letzte Spieler ist: Partner HAT den Stich 100% sicher!
    // ODER Partner führt mit dem Trumpf-Ass / extrem starker Karte
    const isSafePartnerWin = isLastPlayer || (evalResult.winningCard && evalResult.winningCard.suit === trumpSuit && evalResult.winningCard.rank === 'A');

    if (isSafePartnerWin) {
      // --> SCHMIEREN! (Dem Partner möglichst viele Augen füttern)
      // Wähle die höchste Nicht-Trumpf-Augen-Karte: Ass (4), König (3), Dame (2), Bube (1)
      const offSuitPoints = playable
        .filter(c => !isTrumpCard(c, trumpSuit, isMitAnnounced, options))
        .sort((a, b) => getCardPoints(b) - getCardPoints(a));

      if (offSuitPoints.length > 0 && getCardPoints(offSuitPoints[0]) > 0) {
        return offSuitPoints[0]; // Schmieren mit Ass, König oder Dame!
      }

      // Wenn nur Trümpfe oder 0-Punkte da sind: Niedrigste Karte abwerfen, keinen hohen Trumpf verschwenden
      return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
    } else {
      // Partner führt zwar, aber es kommt noch ein gegnerischer Spieler
      // Wenn wir noch höher stechen können und viele Punkte drin sind: absichern
      if (winningCards.length > 0 && trickPoints >= 4) {
        // Mit kleinster gewinnender Karte absichern
        return sortCardsByPowerAsc(winningCards, trumpSuit, isMitAnnounced, options)[0];
      }
      // Ansonsten Punkte schmieren oder kleine Karte beilegen
      const highPointPlayable = playable.sort((a, b) => getCardPoints(b) - getCardPoints(a));
      if (getCardPoints(highPointPlayable[0]) > 0 && Math.random() < 0.7) {
        return highPointPlayable[0];
      }
      return sortCardsByPowerAsc(playable, trumpSuit, isMitAnnounced, options)[0];
    }
  }

  // --------------------------------------------------------------------------
  // FALL 2: GEGNER FÜHRT DEN STICH!
  // --------------------------------------------------------------------------
  if (winningCards.length > 0) {
    const minWinningCard = sortCardsByPowerAsc(winningCards, trumpSuit, isMitAnnounced, options)[0];
    const totalPointsIfWon = trickPoints + getCardPoints(minWinningCard);

    // Kriterium zum Stechen:
    // A) Letzter Spieler (isLastPlayer) -> Jeder Stichgewinn ist sicher!
    // B) Fetter Stich (>= 3 Punkte) -> Lohnt sich definitiv zu stechen!
    // C) Nicht-Trumpf-Gewinn (Fehlfarbe bedienen und höher sein) -> Immer gerne mitnehmen!
    const isNonTrumpWin = !isTrumpCard(minWinningCard, trumpSuit, isMitAnnounced, options);

    if (isLastPlayer || totalPointsIfWon >= 3 || isNonTrumpWin) {
      // Mit dem sparsamsten (niedrigsten) Trumpf/Karte stechen, die reicht!
      return minWinningCard;
    }

    // Bei wenig Punkten (0-1 Augen) und noch Spielern nach uns:
    // Sparsam sein, aber zu 60% mitnehmen wenn wir einen kleinen Trumpf (7/8/9/10/Bube) haben
    const isLowTrump = isTrumpCard(minWinningCard, trumpSuit, isMitAnnounced, options) && (minWinningCard.rank === '7' || minWinningCard.rank === '8' || minWinningCard.rank === '9' || minWinningCard.rank === '10' || minWinningCard.rank === 'J');
    if (isLowTrump && Math.random() < 0.65) {
      return minWinningCard;
    }
  }

  // --------------------------------------------------------------------------
  // FALL 3: WIR KÖNNEN/WOLLEN DEN STICH NICHT GEWINNEN
  // --> SCHNORREN / 0-PUNKTE-ABWURF: Dem Gegner bloß keine Augen schenken!
  // --------------------------------------------------------------------------
  // 1. Zuerst 0-Punkte-Karten (7er, 8er, 9er, 10er) abwerfen
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
  const sortedByPointsAsc = playable.sort((a, b) => getCardPoints(a) - getCardPoints(b));
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
  chooseCardToPlay
};
