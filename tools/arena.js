/**
 * Kujong Bot-Arena
 *
 * Lässt zwei Bot-Versionen gegeneinander antreten und misst, welche mehr Punkte holt.
 * Jede Kartenverteilung wird zweimal gespielt (Seiten getauscht), damit Kartenglück
 * herausfällt. Alles ist deterministisch (fester Startwert per --seed).
 *
 * Aufruf:
 *   node tools/arena.js --a current --b baseline --deals 5000 --players 4 --seed 1
 *
 * Bot-Versionen (--a / --b):
 *   current   engine/couillon-bot-ai.js   (der Bot, den der Server benutzt)
 *   baseline  engine/bots/baseline-bot.js (eingefrorene Kopie vom Start der Messreihe)
 *   random    zufällige legale Karte (Kontrolle: muss deutlich verlieren)
 *   <pfad>    beliebige .js-Datei mit denselben Exporten
 *
 * Messgröße: Punktvorsprung von A pro Runde. Das ist (Abzug von B) - (Abzug von A)
 * aus evaluateRound, also genau die Punkte, die im 13-auf-0-Countdown zählen.
 *
 * Vereinfachungen gegenüber dem echten Server:
 *  - Kontra wird direkt bei der Mit'-Ansage entschieden (Server: laufend während Stich 1).
 *  - "Karten wegwerfen" (Dead Hand) ist Server-Logik und wird nicht nachgebildet.
 *  - Kontra-Re wird nicht gespielt (Bots geben es auch im Server nie).
 */

const path = require('path');
const rules = require('../engine/couillon-rules');
const { createDeck, isCardPlayable, evaluateTrick, evaluateRound, SUITS } = rules;

// ---------------------------------------------------------------------------
// Deterministischer Zufall
// ---------------------------------------------------------------------------
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

function seededShuffle(deck, rng) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---------------------------------------------------------------------------
// Bot-Versionen laden
// ---------------------------------------------------------------------------
function loadBot(name, baselineForRandom) {
  if (name === 'current') return require('../engine/couillon-bot-ai');
  if (name === 'baseline') return require('../engine/bots/baseline-bot');
  if (name === 'random') {
    const base = baselineForRandom;
    let state = 12345;
    const rnd = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 4294967296; };
    return {
      ...base,
      chooseCardToPlay(hand, currentTrick, trumpSuit, isMit, botIndex, options) {
        const playable = hand.filter(c => isCardPlayable(c, hand, currentTrick, trumpSuit, isMit, options));
        const list = playable.length ? playable : hand;
        return list[Math.floor(rnd() * list.length)];
      }
    };
  }
  // "datei.js:variante" lädt den benannten Export aus der Datei (für Experimente)
  const colon = name.lastIndexOf(':');
  if (colon > 1) {
    const mod = require(path.resolve(name.slice(0, colon)));
    const variant = mod[name.slice(colon + 1)];
    if (!variant) throw new Error(`Variante nicht gefunden: ${name}`);
    return variant;
  }
  return require(path.resolve(name));
}

// ---------------------------------------------------------------------------
// Eine Runde spielen
// ---------------------------------------------------------------------------
const SETTINGS = {
  alwaysClubQueenTrump: true,
  allowMit: true,
  contraPoints: 4,
  allowContraRe: false,
  ansagerZeroTricksPenalty: 2
};

/**
 * @param {object} deal  { deck, declarerIndex, turnPickFirst }
 * @param {Array}  bots  bots[seat] = Bot-Modul für diesen Sitz
 */
function playRound(deal, bots, playerCount, scores = { teamA: 13, teamB: 13 }) {
  const P = playerCount;
  const d = deal.declarerIndex;
  const declarerTeam = d % 2;
  const baseOpts = { ...SETTINGS, playerCount: P, scores, declarerIndex: d, declarerTeam };
  const deck = deal.deck;

  const hands = Array.from({ length: P }, () => []);
  let ptr = 0;
  for (let s = 0; s < P; s++) for (let c = 0; c < 3; c++) hands[s].push(deck[ptr++]);

  const stats = { turned: false, mit: false, contra: false };
  const basePtr = 3 * P;
  let trumpSuit;
  let currentTrick = [];
  let firstTurn = d;

  if (bots[d].shouldBotTurnTrump(hands[d], baseOpts)) {
    // Blind drehen: eine der beiden Reservekarten des Ansagers wird aufgedeckt und gespielt
    const c1 = deck[basePtr + d * 2];
    const c2 = deck[basePtr + d * 2 + 1];
    const turned = deal.turnPickFirst ? c1 : c2;
    const kept = deal.turnPickFirst ? c2 : c1;
    trumpSuit = turned.suit;
    for (let s = 0; s < P; s++) {
      if (s === d) hands[s].push(kept);
      else hands[s].push(deck[basePtr + s * 2], deck[basePtr + s * 2 + 1]);
    }
    currentTrick = [{ playerIndex: d, card: turned }];
    firstTurn = (d + 1) % P;
    stats.turned = true;
  } else {
    trumpSuit = bots[d].chooseTrumpSuit(hands[d], baseOpts);
    for (let s = 0; s < P; s++) {
      hands[s].push(deck[basePtr + s * 2], deck[basePtr + s * 2 + 1]);
    }
  }

  let mitHolder = -1;
  for (let s = 0; s < P; s++) {
    if (hands[s].some(c => c.suit === SUITS.SPADES && c.rank === 'Q')) { mitHolder = s; break; }
  }
  if (stats.turned && currentTrick[0].card.suit === SUITS.SPADES && currentTrick[0].card.rank === 'Q') {
    mitHolder = d;
  }

  let isMit = false;
  let isContra = false;

  const tryMit = (seat) => {
    if (isMit || mitHolder !== seat) return;
    if (bots[seat].shouldAnnounceMit(hands[seat], d, seat, trumpSuit, baseOpts)) {
      isMit = true;
      stats.mit = true;
      // Gegnerische Bots entscheiden über Kontra (erster Aufrufer zählt)
      for (let k = 1; k < P; k++) {
        const s = (seat + k) % P;
        if (s % 2 === seat % 2) continue;
        if (bots[s].shouldAnnounceContra(hands[s], seat, s, trumpSuit, baseOpts)) {
          isContra = true;
          stats.contra = true;
          break;
        }
      }
    }
  };

  // Der Ansager, der Pik-Dame hat und gedreht hat, sagt Mit' sofort an (wie im Server)
  if (stats.turned && mitHolder === d) tryMit(d);

  const trickHistory = [];
  const tricksWon = Array(P).fill(0);
  const eyesWon = Array(P).fill(0);
  let leader = d;

  for (let trickNum = 0; trickNum < 5; trickNum++) {
    let trick = trickNum === 0 ? currentTrick : [];
    const startStep = trick.length;
    for (let step = startStep; step < P; step++) {
      const seat = (leader + step) % P;
      if (trickNum === 0) tryMit(seat);

      const card = bots[seat].chooseCardToPlay(
        hands[seat], trick, trumpSuit, isMit, seat,
        {
          ...baseOpts,
          trickHistory,
          declarerIndex: d,
          declarerTeam,
          trickCount: trickNum,
          scores: baseOpts.scores
        }
      );
      if (!card) throw new Error(`Bot ${seat} lieferte keine Karte (Stich ${trickNum + 1}).`);
      const idx = hands[seat].findIndex(c => c.id === card.id);
      if (idx === -1) throw new Error(`Bot ${seat} spielte eine Karte, die er nicht hat: ${card.id}`);
      const playable = isCardPlayable(card, hands[seat], trick, trumpSuit, isMit, baseOpts);
      if (!playable) throw new Error(`Bot ${seat} spielte illegale Karte ${card.id} (Stich ${trickNum + 1}).`);
      hands[seat].splice(idx, 1);
      trick.push({ playerIndex: seat, card });
    }
    const res = evaluateTrick(trick, trumpSuit, isMit, baseOpts);
    tricksWon[res.winnerIndex]++;
    eyesWon[res.winnerIndex] += res.points;
    trickHistory.push({
      trickNumber: trickNum + 1,
      cards: [...trick],
      winnerIndex: res.winnerIndex,
      winnerTeam: res.winnerIndex % 2,
      winningCard: res.winningCard,
      points: res.points
    });
    leader = res.winnerIndex;
  }

  const sum = (arr, par) => arr.reduce((a, v, i) => a + (i % 2 === par ? v : 0), 0);
  const result = evaluateRound({
    declarerTeam,
    eyesTeamA: sum(eyesWon, 0),
    eyesTeamB: sum(eyesWon, 1),
    tricksTeamA: sum(tricksWon, 0),
    tricksTeamB: sum(tricksWon, 1),
    isMitAnnounced: isMit,
    isContraAnnounced: isContra,
    isContraReAnnounced: false,
    options: SETTINGS
  });
  return { result, stats, declarerTeam };
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
function runMatch({ botA, botB, deals, playerCount, seed, scoreA = 13, scoreB = 13 }) {
  const rng = mulberry32(seed);
  const perDeal = [];
  const agg = {
    games: 0,
    declWinsA: 0, declGamesA: 0,
    declWinsB: 0, declGamesB: 0,
    mit: 0, contra: 0, turned: 0,
    declA_turned: 0, declA_turnedPts: 0,
    contraPts: 0
  };

  for (let i = 0; i < deals; i++) {
    const deck = seededShuffle(createDeck(playerCount), rng);
    const dealInfo = {
      deck,
      declarerIndex: i % playerCount,
      turnPickFirst: rng() < 0.5
    };

    let dealNet = 0;
    for (const aParity of [0, 1]) {
      // aParity = 0: A sitzt auf geraden Plätzen (Team A), 1: A auf ungeraden (Team B)
      const bots = Array.from({ length: playerCount }, (_, s) => (s % 2 === aParity ? botA : botB));
      const roundScores = aParity === 0
        ? { teamA: scoreA, teamB: scoreB }
        : { teamA: scoreB, teamB: scoreA };
      const { result, stats, declarerTeam } = playRound(dealInfo, bots, playerCount, roundScores);
      const deltaA = aParity === 0 ? result.deltaTeamA : result.deltaTeamB;
      const deltaB = aParity === 0 ? result.deltaTeamB : result.deltaTeamA;
      const netA = deltaB - deltaA; // positiv = gut für A
      dealNet += netA;

      agg.games++;
      if (stats.mit) agg.mit++;
      if (stats.contra) { agg.contra++; agg.contraPts += netA; }
      if (stats.turned) agg.turned++;
      const aIsDecl = declarerTeam === aParity;
      if (aIsDecl) { agg.declGamesA++; if (result.winningTeam === declarerTeam) agg.declWinsA++; }
      else { agg.declGamesB++; if (result.winningTeam === declarerTeam) agg.declWinsB++; }
    }
    perDeal.push(dealNet / 2); // Durchschnitt aus beiden Seiten
  }

  const n = perDeal.length;
  const mean = perDeal.reduce((a, v) => a + v, 0) / n;
  const variance = perDeal.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  return { n, mean, se, ci: [mean - 1.96 * se, mean + 1.96 * se], agg };
}

function simulateOneGame(botTeam0, botTeam1, playerCount, matchSeed, startScoreA, startScoreB) {
  const rng = mulberry32(matchSeed);
  const bots = Array.from({ length: playerCount }, (_, s) => (s % 2 === 0 ? botTeam0 : botTeam1));
  let scores = { teamA: startScoreA, teamB: startScoreB };
  let declarerIndex = 0;
  let rounds = 0;

  while (scores.teamA > 0 && scores.teamB > 0 && rounds < 50) {
    const deck = seededShuffle(createDeck(playerCount), rng);
    const dealInfo = {
      deck,
      declarerIndex,
      turnPickFirst: rng() < 0.5
    };
    const { result } = playRound(dealInfo, bots, playerCount, scores);
    scores = {
      teamA: scores.teamA + result.deltaTeamA,
      teamB: scores.teamB + result.deltaTeamB
    };
    declarerIndex = (declarerIndex + 1) % playerCount;
    rounds++;
  }

  let winnerTeam;
  if (scores.teamA <= 0 && scores.teamB <= 0) {
    winnerTeam = scores.teamA < scores.teamB ? 0 : 1;
  } else if (scores.teamA <= 0) {
    winnerTeam = 0;
  } else {
    winnerTeam = 1;
  }
  return { winnerTeam, rounds, finalScores: scores };
}

function runMatchTournament({ botA, botB, matches, playerCount, seed, startScore = 13 }) {
  const rng = mulberry32(seed);
  let aMatchWins = 0;
  let bMatchWins = 0;
  let ties = 0;
  let totalRounds = 0;
  const perMatchNet = [];

  for (let m = 0; m < matches; m++) {
    const matchSeed = (rng() * 4294967296) >>> 0;
    const g1 = simulateOneGame(botA, botB, playerCount, matchSeed, startScore, startScore);
    const g2 = simulateOneGame(botB, botA, playerCount, matchSeed, startScore, startScore);

    const aWonLeg1 = g1.winnerTeam === 0 ? 1 : 0;
    const aWonLeg2 = g2.winnerTeam === 1 ? 1 : 0;
    const net = aWonLeg1 + aWonLeg2 - 1; // +1: A 2-0, 0: split, -1: B 2-0
    perMatchNet.push(net);

    if (net === 1) aMatchWins++;
    else if (net === -1) bMatchWins++;
    else ties++;

    totalRounds += g1.rounds + g2.rounds;
  }

  const n = perMatchNet.length;
  const mean = perMatchNet.reduce((a, v) => a + v, 0) / n;
  const variance = perMatchNet.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1);
  const se = Math.sqrt(variance / n);
  return {
    n,
    mean,
    se,
    ci: [mean - 1.96 * se, mean + 1.96 * se],
    winRateA: (((mean + 1) / 2) * 100).toFixed(1) + '%',
    aMatchWins,
    bMatchWins,
    ties,
    totalRounds
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const out = { a: 'current', b: 'baseline', deals: 5000, players: 4, seed: 1, mode: 'deal', matches: 2000, scoreA: 13, scoreB: 13 };
  for (let i = 2; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    const v = argv[i + 1];
    if (k in out) out[k] = typeof out[k] === 'number' ? Number(v) : v;
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const baseline = require('../engine/bots/baseline-bot');
  const botA = loadBot(args.a, baseline);
  const botB = loadBot(args.b, baseline);

  const t0 = Date.now();

  if (args.mode === 'match') {
    const r = runMatchTournament({ botA, botB, matches: args.matches, playerCount: args.players, seed: args.seed });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n=== ARENA MATCH-MODUS (13 -> 0 Countdown): A=${args.a} gegen B=${args.b} ===`);
    console.log(`Spieler: ${args.players}   Matches: ${r.n} (gespiegelt = ${r.n * 2} Partien, ${r.totalRounds} Runden)   Seed: ${args.seed}   Dauer: ${secs}s`);
    console.log(`Siegquote A: ${r.winRateA}   (Netto-Vorsprung: ${r.mean.toFixed(4)}, 95%-CI: ${r.ci[0].toFixed(4)} .. ${r.ci[1].toFixed(4)})`);
    console.log(`Matches A gewonnen (Sweep): ${r.aMatchWins}   B gewonnen (Sweep): ${r.bMatchWins}   Geteilt (1-1): ${r.ties}`);
    const verdict = r.ci[0] > 0 ? 'A ist messbar BESSER' : r.ci[1] < 0 ? 'A ist messbar SCHLECHTER' : 'kein messbarer Unterschied';
    console.log(`Ergebnis: ${verdict}\n`);
    return;
  }

  const r = runMatch({ botA, botB, deals: args.deals, playerCount: args.players, seed: args.seed, scoreA: args.scoreA, scoreB: args.scoreB });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const pct = (x, y) => (y ? ((100 * x) / y).toFixed(1) + '%' : 'n/a');
  console.log(`\n=== ARENA: A=${args.a}  gegen  B=${args.b} ===`);
  console.log(`Spieler: ${args.players}   Verteilungen: ${r.n} (je 2 Partien = ${r.agg.games})   Scores: A=${args.scoreA}, B=${args.scoreB}   Seed: ${args.seed}   Dauer: ${secs}s`);
  console.log(`Punktvorsprung von A pro Runde: ${r.mean.toFixed(4)}  (95%-Intervall ${r.ci[0].toFixed(4)} .. ${r.ci[1].toFixed(4)})`);
  const verdict = r.ci[0] > 0 ? 'A ist messbar BESSER' : r.ci[1] < 0 ? 'A ist messbar SCHLECHTER' : 'kein messbarer Unterschied';
  console.log(`Ergebnis: ${verdict}`);
  console.log(`Ansager-Siegquote  A: ${pct(r.agg.declWinsA, r.agg.declGamesA)}   B: ${pct(r.agg.declWinsB, r.agg.declGamesB)}`);
  console.log(`Mit' angesagt: ${pct(r.agg.mit, r.agg.games)}   Kontra: ${pct(r.agg.contra, r.agg.games)} (Ergebnis für A bei Kontra: ${r.agg.contra ? (r.agg.contraPts / r.agg.contra).toFixed(2) : 'n/a'} Pkt/Runde)   Trumpf gedreht: ${pct(r.agg.turned, r.agg.games)}\n`);
}

if (require.main === module) main();

module.exports = { runMatch, runMatchTournament, playRound, mulberry32, seededShuffle, loadBot };
