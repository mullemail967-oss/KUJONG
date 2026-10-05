/**
 * Experiment-Varianten für die Arena. Jede Variante ändert genau EINE Entscheidung
 * gegenüber dem aktuellen Bot, damit der Messunterschied eindeutig zuzuordnen ist.
 *
 * Beispiel: node tools/arena.js --a tools/variants/policy-variants.js:noTurn --b current
 */
const cur = require('../../engine/couillon-bot-ai');
const { isTrumpCard, SUITS } = require('../../engine/couillon-rules');

const countTrumps = (hand, trump, opts) => hand.filter(c => isTrumpCard(c, trump, true, opts)).length;
const countAces = (hand) => hand.filter(c => c.rank === 'A').length;
const hasTrumpAce = (hand, trump) => hand.some(c => c.suit === trump && c.rank === 'A');
const isOpp = (mitHolder, bot) => mitHolder % 2 !== bot % 2;

// Alte Mit'-Regel gegen Gegner (vor der "Qualitätstrumpf"-Änderung)
const oldMit = (hand, d, b, t, o) => {
  if (d % 2 === b % 2) return cur.shouldAnnounceMit(hand, d, b, t, o);
  const tc = countTrumps(hand, t, o);
  return tc >= 2 || (tc >= 1 && countAces(hand) >= 1);
};

// Alte Ausspiel-Regel: höchsten Trumpf ziehen, wenn Boss und (>=2 Trümpfe oder Ansager-Team)
const oldLead = {
  ...cur,
  chooseCardToPlay(hand, trick, trump, isMit, botIndex, options) {
    if (!trick || trick.length === 0) {
      const played = cur.getPlayedCards(options.trickHistory || [], trick);
      const unseen = cur.getUnseenCards(hand, played, options.playerCount || 4);
      const voids = cur.getKnownVoids(options.trickHistory || [], options.playerCount || 4, trump, isMit, options);
      const opps = cur.doOpponentsHaveTrumps(botIndex, unseen, voids, trump, isMit, options, options.playerCount || 4);
      const trumps = hand.filter(c => isTrumpCard(c, trump, isMit, options));
      if (opps && trumps.length > 0) {
        const { getTrumpPower, isCardPlayable } = require('../../engine/couillon-rules');
        const playableTrumps = trumps.filter(c => isCardPlayable(c, hand, trick, trump, isMit, options));
        playableTrumps.sort((a, b) => getTrumpPower(b, trump, isMit, options) - getTrumpPower(a, trump, isMit, options));
        const top = playableTrumps[0];
        if (top && cur.isSuitBoss(top, unseen, trump, isMit, options)) {
          const declTeam = options.declarerIndex !== undefined && options.declarerIndex % 2 === botIndex % 2;
          if (trumps.length >= 2 || declTeam) return top;
        }
      }
    }
    return cur.chooseCardToPlay(hand, trick, trump, isMit, botIndex, options);
  }
};

const contra = (fn) => ({
  ...cur,
  shouldAnnounceContra: (hand, mitHolder, bot, trump, o) => isOpp(mitHolder, bot) && fn(hand, trump, o)
});

module.exports = {
  noTurn:      { ...cur, shouldBotTurnTrump: () => false },
  alwaysTurn:  { ...cur, shouldBotTurnTrump: () => true },
  noContra:    { ...cur, shouldAnnounceContra: () => false },
  noMitVsOpp:  { ...cur, shouldAnnounceMit: (hand, d, b, t, o) => (d % 2 === b % 2) && cur.shouldAnnounceMit(hand, d, b, t, o) },
  alwaysMitVsOpp: { ...cur, shouldAnnounceMit: (hand, d, b, t, o) => (d % 2 === b % 2) ? cur.shouldAnnounceMit(hand, d, b, t, o) : true },
  noMit:       { ...cur, shouldAnnounceMit: () => false },
  oldMit:      { ...cur, shouldAnnounceMit: oldMit },
  oldLead,
  alwaysMitPartner: { ...cur, shouldAnnounceMit: (hand, d, b, t, o) => (d % 2 === b % 2) ? true : cur.shouldAnnounceMit(hand, d, b, t, o) },

  contraAce3:  contra((h, t, o) => hasTrumpAce(h, t) && countTrumps(h, t, o) >= 3),
  contraAce2A2: contra((h, t, o) => hasTrumpAce(h, t) && countTrumps(h, t, o) >= 2 && countAces(h) >= 2),
  contraT4:    contra((h, t, o) => countTrumps(h, t, o) >= 4),
  contraAce3A: contra((h, t, o) => hasTrumpAce(h, t) && countTrumps(h, t, o) >= 3 && countAces(h) >= 2),

  betterMitAndContra: {
    ...cur,
    shouldAnnounceMit: oldMit,
    shouldAnnounceContra: (hand, mitHolder, bot, trump, o) => isOpp(mitHolder, bot) && hasTrumpAce(hand, trump) && countTrumps(hand, trump, o) >= 3
  },

  trumpNoClubBonus: {
    ...cur,
    chooseTrumpSuit(hand3, options = {}) {
      const suitScores = { [SUITS.CLUBS]: 0, [SUITS.SPADES]: 0, [SUITS.HEARTS]: 0, [SUITS.DIAMONDS]: 0 };
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
            else score += 2;
          }
        }
        score += suitCount * 4;
        suitScores[suit] = score;
      }
      let best = SUITS.HEARTS, max = -1;
      for (const s of Object.values(SUITS)) { if (suitScores[s] > max) { max = suitScores[s]; best = s; } }
      return best;
    }
  },

  // -------------------------------------------------------------------------
  // SCORE-AWARE VARIANTEN
  // -------------------------------------------------------------------------
  // 1. Wenn wir kurz vor dem Sieg stehen (myScore <= 2): niemals blind drehen
  scoreTurnNoEndgame: {
    ...cur,
    shouldBotTurnTrump(hand3, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const d = options.declarerIndex !== undefined ? options.declarerIndex : 0;
      const myTeam = d % 2 === 0 ? 0 : 1;
      const myScore = myTeam === 0 ? sc.teamA : sc.teamB;
      if (myScore <= 2) return false; // Matchball: keine blinde Karte riskieren
      return cur.shouldBotTurnTrump(hand3, options);
    }
  },

  // 2. Kontra-Vorsicht bei Punktestand:
  // - Wenn wir bei <= 2 stehen: kein Kontra nötig (1-2 Pkt genügen für den Matchsieg, 4 Pkt für Gegner zu riskant)
  // - Wenn Gegner bei <= 4 steht: Kontra schenkt dem Gegner bei Verlust den Matchgewinn -> strenger (mind. 4 Trümpfe)
  scoreContraSafe: {
    ...cur,
    shouldAnnounceContra(hand, mitHolder, botIndex, trumpSuit, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const botTeam = botIndex % 2 === 0 ? 0 : 1;
      const myScore = botTeam === 0 ? sc.teamA : sc.teamB;
      const oppScore = botTeam === 0 ? sc.teamB : sc.teamA;

      if (myScore <= 2) return false; // Wir brauchen keine 4 Punkte
      if (oppScore <= 4 && countTrumps(hand, trumpSuit, options) < 4) return false; // Gegner darf kein 4-Pkt Geschenk bekommen

      return cur.shouldAnnounceContra(hand, mitHolder, botIndex, trumpSuit, options);
    }
  },

  // 3. Mit'-Vorsicht bei eigenem Matchball (myScore === 1):
  // Wenn Partner Ansager ist, reicht 1 Punkt zum Matchgewinn! Keine Mit' nötig (verhindert Kontra durch Gegner).
  scoreMitSafe: {
    ...cur,
    shouldAnnounceMit(hand, declarerIndex, botIndex, trumpSuit, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const botTeam = botIndex % 2 === 0 ? 0 : 1;
      const myScore = botTeam === 0 ? sc.teamA : sc.teamB;
      const isPartner = (declarerIndex % 2 === botIndex % 2);

      if (myScore === 1 && isPartner) {
        return false; // 1 Punkt reicht völlig, kein Kontra provozieren
      }

      return cur.shouldAnnounceMit(hand, declarerIndex, botIndex, trumpSuit, options);
    }
  },

  // 4. Kombination aller Score-Aware Politiken
  scoreAwareAll: {
    ...cur,
    shouldBotTurnTrump(hand3, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const d = options.declarerIndex !== undefined ? options.declarerIndex : 0;
      const myTeam = d % 2 === 0 ? 0 : 1;
      const myScore = myTeam === 0 ? sc.teamA : sc.teamB;
      if (myScore <= 2) return false;
      return cur.shouldBotTurnTrump(hand3, options);
    },
    shouldAnnounceContra(hand, mitHolder, botIndex, trumpSuit, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const botTeam = botIndex % 2 === 0 ? 0 : 1;
      const myScore = botTeam === 0 ? sc.teamA : sc.teamB;
      const oppScore = botTeam === 0 ? sc.teamB : sc.teamA;
      if (myScore <= 2) return false;
      if (oppScore <= 4 && countTrumps(hand, trumpSuit, options) < 4) return false;
      return cur.shouldAnnounceContra(hand, mitHolder, botIndex, trumpSuit, options);
    },
    shouldAnnounceMit(hand, declarerIndex, botIndex, trumpSuit, options = {}) {
      const sc = options.scores || { teamA: 13, teamB: 13 };
      const botTeam = botIndex % 2 === 0 ? 0 : 1;
      const myScore = botTeam === 0 ? sc.teamA : sc.teamB;
      const isPartner = (declarerIndex % 2 === botIndex % 2);
      if (myScore === 1 && isPartner) return false;
      return cur.shouldAnnounceMit(hand, declarerIndex, botIndex, trumpSuit, options);
    }
  },

  mcts30: {
    ...cur,
    chooseCardToPlay(hand, trick, trump, isMit, botIndex, options) {
      const mc = require('C:/Users/pheck/.gemini/antigravity/brain/aeba6fbb-f0ac-4565-a7d4-1aced8ee2120/scratch/prototype-mc');
      return mc.chooseCardMCTS(hand, trick, trump, isMit, botIndex, options, 30);
    }
  },

  mctsHybrid: {
    ...cur,
    chooseCardToPlay(hand, trick, trump, isMit, botIndex, options) {
      // 1. Wenn Ausspiel und sicheres Fehlfarben-Ass vorhanden: sofort ausspielen
      if (!trick || trick.length === 0) {
        const offSuitAces = hand.filter(c => !isTrumpCard(c, trump, isMit, options) && c.rank === 'A');
        if (offSuitAces.length > 0) return offSuitAces[0];
      }

      // 2. Wenn Gegner ein Ass führt und wir mit kleinem Trumpf stechen können: sofort stechen
      if (trick && trick.length > 0) {
        const rules = require('../../engine/couillon-rules');
        const evalLead = rules.evaluateTrick(trick, trump, isMit, options);
        const oppWinning = (evalLead.winnerIndex % 2 !== botIndex % 2);
        if (oppWinning && evalLead.points >= 4) {
          const playable = hand.filter(c => rules.isCardPlayable(c, hand, trick, trump, isMit, options));
          const lowTrumps = playable.filter(c => isTrumpCard(c, trump, isMit, options) && (c.rank === '9' || c.rank === '10' || c.rank === '7' || c.rank === '8' || c.rank === 'J'));
          if (lowTrumps.length > 0) {
            lowTrumps.sort((a, b) => (rules.POINT_VALUES[a.rank] || 0) - (rules.POINT_VALUES[b.rank] || 0));
            return lowTrumps[0];
          }
        }
      }

      // 3. Für alle anderen Situationen: MCTS Rollout!
      const mc = require('C:/Users/pheck/.gemini/antigravity/brain/aeba6fbb-f0ac-4565-a7d4-1aced8ee2120/scratch/prototype-mc');
      return mc.chooseCardMCTS(hand, trick, trump, isMit, botIndex, options, 30);
    }
  }
};
