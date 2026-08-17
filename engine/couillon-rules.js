/**
 * Couillon (Eifel / Ostbelgien) Rule Engine
 * 4 Spieler in zwei 2er-Teams (Team A: Sitze 0 & 2, Team B: Sitze 1 & 3)
 */

const SUITS = {
  CLUBS: 'clubs',       // Kreuz ♣
  SPADES: 'spades',     // Pik ♠
  HEARTS: 'hearts',     // Herz ♥
  DIAMONDS: 'diamonds'  // Karo ♦
};

const RANKS = ['9', '10', 'J', 'Q', 'K', 'A'];

const POINT_VALUES = {
  'A': 4,
  'K': 3,
  'Q': 2,
  'J': 1,
  '10': 0,
  '9': 0
};

/**
 * Erstellt ein neues 24-Karten-Deck.
 */
function createDeck() {
  const deck = [];
  for (const suit of Object.values(SUITS)) {
    for (const rank of RANKS) {
      deck.push({
        id: `${suit}_${rank}`,
        suit: suit,
        rank: rank,
        points: POINT_VALUES[rank]
      });
    }
  }
  return deck;
}

/**
 * Mischt das Deck (Fisher-Yates Shuffle).
 */
function shuffleDeck(deck) {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

/**
 * Prüft, ob eine Karte unter gegebenem Trumpf und Mit'-Status als Trumpf zählt.
 * - Kreuz-Dame ist IMMER Trumpf.
 * - Pik-Dame ist Trumpf, wenn Pik Trumpffarbe ist ODER wenn Mit' angesagt wurde.
 * - Alle Karten der gewählten Trumpffarbe sind Trumpf.
 */
function isTrumpCard(card, trumpSuit, isMitAnnounced) {
  if (!card || !trumpSuit) return false;
  
  // Kreuz-Dame ist IMMER Trumpf
  if (card.suit === SUITS.CLUBS && card.rank === 'Q') {
    return true;
  }
  
  // Pik-Dame ist Trumpf, wenn Mit' angesagt ODER Pik die Trumpffarbe ist
  if (card.suit === SUITS.SPADES && card.rank === 'Q') {
    return isMitAnnounced || trumpSuit === SUITS.SPADES;
  }
  
  // Reguläre Trumpffarbe
  return card.suit === trumpSuit;
}

/**
 * Bestimmt die effektive Farbe einer Karte für die Symbol-Bekennpflicht.
 * - Jede Trumpfkarte hat die effektive Farbe 'TRUMP'.
 * - Alle anderen Karten behalten ihr aufgedrucktes Symbol als effektive Farbe.
 */
function getEffectiveSuit(card, trumpSuit, isMitAnnounced) {
  if (isTrumpCard(card, trumpSuit, isMitAnnounced)) {
    return 'TRUMP';
  }
  return card.suit;
}

/**
 * Berechnet die relative Stärke einer Trumpfkarte für den Stichvergleich.
 * Höherer Wert = stärkere Karte.
 *
 * Trumpf-Hierarchie (vom höchsten zum niedrigsten):
 * 1. Trumpf-Ass (Wert 100)
 * 2. Pik-Dame ("Die Mit'") [nur wenn Mit' angesagt wurde!] (Wert 90)
 * 3. Kreuz-Dame (permanent) (Wert 80)
 * 4. Trumpf-König (Wert 70)
 * 5. Reguläre Trumpf-Dame [Herz/Karo, bzw. Pik falls nicht Mit'] (Wert 60)
 * 6. Trumpf-Bube (Wert 50)
 * 7. Trumpf-10 (Wert 40)
 * 8. Trumpf-9 (Wert 30)
 */
function getTrumpPower(card, trumpSuit, isMitAnnounced) {
  if (!isTrumpCard(card, trumpSuit, isMitAnnounced)) {
    return -1;
  }

  // 1. Trumpf-Ass
  if (card.suit === trumpSuit && card.rank === 'A') {
    return 100;
  }

  // 2. Pik-Dame ("Die Mit'") - wenn aktiv angesagt
  if (isMitAnnounced && card.suit === SUITS.SPADES && card.rank === 'Q') {
    return 90;
  }

  // 3. Kreuz-Dame (immer Trumpf, über König)
  if (card.suit === SUITS.CLUBS && card.rank === 'Q') {
    return 80;
  }

  // 4. Trumpf-König
  if (card.suit === trumpSuit && card.rank === 'K') {
    return 70;
  }

  // 5. Reguläre Trumpf-Dame (falls Herz/Karo Trumpf, oder Pik-Dame wenn NICHT als Mit' angesagt)
  if (card.suit === trumpSuit && card.rank === 'Q' && !(isMitAnnounced && card.suit === SUITS.SPADES)) {
    return 60;
  }

  // 6. Trumpf-Bube
  if (card.suit === trumpSuit && card.rank === 'J') {
    return 50;
  }

  // 7. Trumpf-10
  if (card.suit === trumpSuit && card.rank === '10') {
    return 40;
  }

  // 8. Trumpf-9
  if (card.suit === trumpSuit && card.rank === '9') {
    return 30;
  }

  return 0;
}

/**
 * Berechnet die relative Stärke einer Fehlfarbenkarte (Nicht-Trumpf).
 * Rangfolge: A > K > Q > J > 10 > 9
 */
function getOffSuitPower(card) {
  const OFF_SUIT_RANKS = {
    'A': 6,
    'K': 5,
    'Q': 4,
    'J': 3,
    '10': 2,
    '9': 1
  };
  return OFF_SUIT_RANKS[card.rank] || 0;
}

/**
 * Prüft, ob ein Spieler eine bestimmte Karte regelkonform spielen darf.
 * 
 * Stichregeln:
 * 1. Wird eine Karte angespielt, bestimmt ihre effektive Farbe ('TRUMP' oder Fehlfarbe) die Bekennpflicht.
 * 2. Hat der Spieler mindestens eine Karte der angespielten effektiven Farbe, MUSS er diese bedienen.
 * 3. Kann der Spieler nicht bedienen, darf er JEDE Karte spielen (freiwillig stechen oder abwerfen).
 * 4. Kein Überstichzwang / Untertrumpfen erlaubt.
 */
function isCardPlayable(cardToPlay, playerHand, currentTrick, trumpSuit, isMitAnnounced) {
  // Wenn noch keine Karte im Stich liegt (Ausspiel), ist jede Karte der Hand erlaubt
  if (!currentTrick || currentTrick.length === 0) {
    return true;
  }

  const leadCard = currentTrick[0].card;
  const leadEffectiveSuit = getEffectiveSuit(leadCard, trumpSuit, isMitAnnounced);
  const cardEffectiveSuit = getEffectiveSuit(cardToPlay, trumpSuit, isMitAnnounced);
  const cardIsTrump = isTrumpCard(cardToPlay, trumpSuit, isMitAnnounced);

  // Fall 1: Trumpf wurde angespielt (Lead ist TRUMP)
  if (leadEffectiveSuit === 'TRUMP') {
    const hasTrump = playerHand.some(c => isTrumpCard(c, trumpSuit, isMitAnnounced));
    if (hasTrump) {
      // Muss Trumpf bedienen
      return cardIsTrump;
    }
    // Hat keinen Trumpf: darf jede Karte spielen
    return true;
  }

  // Fall 2: Eine Fehlfarbe (Nicht-Trumpf) wurde angespielt
  const hasLeadSuit = playerHand.some(c => getEffectiveSuit(c, trumpSuit, isMitAnnounced) === leadEffectiveSuit);

  if (hasLeadSuit) {
    // Der Spieler darf entweder die angespielte Farbe bedienen ODER mit Trumpf stechen/übertrumpfen!
    // Er darf nur keine andere Fehlfarbe abwerfen, solange er die angespielte Farbe besitzt.
    return cardEffectiveSuit === leadEffectiveSuit || cardIsTrump;
  }

  // Hat die angespielte Farbe nicht: darf jede beliebige Karte spielen (Trumpf oder beliebige Fehlfarbe)
  return true;
}

/**
 * Ermittelt den Gewinner eines abgeschlossenen Stichs (genau 4 gelegte Karten).
 * 
 * @param {Array<{playerIndex: number, card: object}>} trick - Die 4 gespielten Karten mit Spielerindex.
 * @param {string} trumpSuit - Das Trumpfsymbol
 * @param {boolean} isMitAnnounced - Ob Mit' aktiv ist
 * @returns {{winnerIndex: number, winningCard: object, points: number}}
 */
function evaluateTrick(trick, trumpSuit, isMitAnnounced) {
  if (!trick || trick.length === 0) {
    throw new Error('Stich ist leer.');
  }

  const leadCard = trick[0].card;
  const leadEffectiveSuit = getEffectiveSuit(leadCard, trumpSuit, isMitAnnounced);

  let bestEntry = trick[0];
  let bestIsTrump = isTrumpCard(leadCard, trumpSuit, isMitAnnounced);
  let bestPower = bestIsTrump 
    ? getTrumpPower(leadCard, trumpSuit, isMitAnnounced)
    : getOffSuitPower(leadCard);

  let totalTrickPoints = 0;

  for (let i = 0; i < trick.length; i++) {
    const entry = trick[i];
    const card = entry.card;
    totalTrickPoints += (card.points || 0);

    const isTrump = isTrumpCard(card, trumpSuit, isMitAnnounced);

    if (bestIsTrump) {
      // Bisher bester ist Trumpf: Nur ein höherer Trumpf kann gewinnen
      if (isTrump) {
        const power = getTrumpPower(card, trumpSuit, isMitAnnounced);
        if (power > bestPower) {
          bestPower = power;
          bestEntry = entry;
        }
      }
    } else {
      // Bisher bester ist kein Trumpf
      if (isTrump) {
        // Ein beliebiger Trumpf sticht die Fehlfarbe
        bestIsTrump = true;
        bestPower = getTrumpPower(card, trumpSuit, isMitAnnounced);
        bestEntry = entry;
      } else {
        // Fehlfarbe: Nur dieselbe angespielte Farbe kann die Führung übernehmen
        if (card.suit === leadCard.suit) {
          const power = getOffSuitPower(card);
          if (power > bestPower) {
            bestPower = power;
            bestEntry = entry;
          }
        }
      }
    }
  }

  return {
    winnerIndex: bestEntry.playerIndex,
    winningCard: bestEntry.card,
    points: totalTrickPoints
  };
}

/**
 * Wertet eine komplette Runde nach 5 Stichen aus (relative Abrechnung).
 * 
 * @param {number} declarerTeam - 0 (Team A: Sitze 0 & 2) oder 1 (Team B: Sitze 1 & 3)
 * @param {number} eyesTeamA - Gesamtpunkte der von Team A gewonnenen Stiche
 * @param {number} eyesTeamB - Gesamtpunkte der von Team B gewonnenen Stiche
 * @param {number} tricksTeamA - Anzahl gewonnener Stiche von Team A (0..5)
 * @param {number} tricksTeamB - Anzahl gewonnener Stiche von Team B (0..5)
 * @param {boolean} isMitAnnounced - Ob Mit' angesagt wurde
 * @returns {object} Details der Rundenabrechnung (Punkteabzüge/Strafen, Textbegründung)
 */
function evaluateRound({ declarerTeam, eyesTeamA, eyesTeamB, tricksTeamA, tricksTeamB, isMitAnnounced, isContraAnnounced }) {
  // P-Wert: Normal 1, Mit' 2, Kontra 4
  let P = 1;
  if (isContraAnnounced) {
    P = 4;
  } else if (isMitAnnounced) {
    P = 2;
  }

  const eyesDeclarer = declarerTeam === 0 ? eyesTeamA : eyesTeamB;
  const eyesOpponent = declarerTeam === 0 ? eyesTeamB : eyesTeamA;
  const tricksDeclarer = declarerTeam === 0 ? tricksTeamA : tricksTeamB;
  const tricksOpponent = declarerTeam === 0 ? tricksTeamB : tricksTeamA;

  let declarerDelta = 0;
  let opponentDelta = 0;
  let declarerPenalty = 0;
  let reason = '';
  let winningTeam = null;

  // Fall 4: Match / Durchmarsch (Ein Team hat alle 5 Stiche gewonnen: Basis P + 1 Zusatzpunkt -> 2, 3 oder 5)
  const sweepPoints = P + 1; // 2 (1+1), 3 (2+1) oder 5 (4+1 mit Kontra)
  if (tricksDeclarer === 5) {
    winningTeam = declarerTeam;
    declarerDelta = -sweepPoints;
    reason = `Durchmarsch! Ansager-Team gewinnt alle 5 Stiche und zieht ${sweepPoints} Punkte ab (${P} regulär + 1 Bonus-Punkt).`;
  } else if (tricksOpponent === 5) {
    winningTeam = 1 - declarerTeam;
    opponentDelta = -sweepPoints;
    declarerPenalty = 1;
    declarerDelta = +1;
    reason = `Durchmarsch! Gegner-Team gewinnt alle 5 Stiche und zieht ${sweepPoints} Punkte ab (${P} regulär + 1 Bonus-Punkt). Ansager-Team erhält +1 Strafpunkt.`;
  }
  // Fall 1: Ansager hat mehr Augen als Gegner
  else if (eyesDeclarer > eyesOpponent) {
    winningTeam = declarerTeam;
    declarerDelta = -P;
    reason = `Ansager-Team gewinnt mit ${eyesDeclarer}:${eyesOpponent} Augen und zieht ${P} Punkt(e) ab.`;
  }
  // Fall 2: Gegner hat mehr Augen als Ansager
  else if (eyesOpponent > eyesDeclarer) {
    winningTeam = 1 - declarerTeam;
    opponentDelta = -P;
    declarerPenalty = 1;
    declarerDelta = +1;
    reason = `Ansager-Team verliert mit ${eyesDeclarer}:${eyesOpponent} Augen. Gegner-Team zieht ${P} Punkt(e) ab, Ansager-Team erhält +1 Strafpunkt.`;
  }
  // Fall 3: Unentschieden (Ansager verliert das Unentschieden!)
  else {
    winningTeam = 1 - declarerTeam;
    opponentDelta = -P;
    declarerPenalty = 1;
    declarerDelta = +1;
    reason = `Gleichstand (${eyesDeclarer}:${eyesOpponent} Augen). Ansager verliert das Unentschieden: Gegner zieht ${P} Punkt(e) ab, Ansager erhält +1 Strafpunkt.`;
  }

  const deltaTeamA = declarerTeam === 0 ? declarerDelta : opponentDelta;
  const deltaTeamB = declarerTeam === 1 ? declarerDelta : opponentDelta;

  return {
    P,
    isMitAnnounced,
    isContraAnnounced: !!isContraAnnounced,
    declarerTeam,
    winningTeam,
    eyesDeclarer,
    eyesOpponent,
    tricksDeclarer,
    tricksOpponent,
    declarerDelta,
    opponentDelta,
    declarerPenalty,
    deltaTeamA,
    deltaTeamB,
    reason
  };
}

module.exports = {
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
};
