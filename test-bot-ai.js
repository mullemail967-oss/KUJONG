const assert = require('assert');
const { SUITS } = require('./engine/couillon-rules');
const {
  chooseTrumpSuit,
  shouldAnnounceMit,
  shouldAnnounceContra,
  chooseCardToPlay
} = require('./engine/couillon-bot-ai');

let passedTests = 0;
let failedTests = 0;

function test(description, fn) {
  try {
    fn();
    console.log(`  ✓ PASS: ${description}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ FAIL: ${description}`);
    console.error(`    ${err.message}`);
    failedTests++;
  }
}

console.log('=== TEST 1: Bot-Trumpfwahl (chooseTrumpSuit) ===');

test('Wählt Herz wenn Herz-Ass und Herz-König auf der Hand liegen', () => {
  const hand = [
    { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 },
    { id: 'hK', suit: SUITS.HEARTS, rank: 'K', points: 3 },
    { id: 'd9', suit: SUITS.DIAMONDS, rank: '9', points: 0 }
  ];
  const trump = chooseTrumpSuit(hand, { alwaysClubQueenTrump: true, allowMit: true });
  assert.strictEqual(trump, SUITS.HEARTS);
});

console.log('\n=== TEST 2: Strategische Mit\'-Ansage (shouldAnnounceMit) ===');

test('Partner ist Ansager: Bot sagt Mit\' an', () => {
  const hand = [
    { id: 'sQ', suit: SUITS.SPADES, rank: 'Q', points: 2 },
    { id: 'hK', suit: SUITS.HEARTS, rank: 'K', points: 3 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 },
    { id: 'c9', suit: SUITS.CLUBS, rank: '9', points: 0 },
    { id: 's9', suit: SUITS.SPADES, rank: '9', points: 0 }
  ];
  // Bot ist Platz 2, Partner (Platz 0) ist Ansager, Trumpf Herz
  const decision = shouldAnnounceMit(hand, 0, 2, SUITS.HEARTS, { allowMit: true });
  assert.strictEqual(decision, true);
});

test('Gegner ist Ansager: Bot sagt Mit\' NICHT an bei schwacher Hand', () => {
  const hand = [
    { id: 'sQ', suit: SUITS.SPADES, rank: 'Q', points: 2 },
    { id: 'd9', suit: SUITS.DIAMONDS, rank: '9', points: 0 },
    { id: 'c9', suit: SUITS.CLUBS, rank: '9', points: 0 },
    { id: 's10', suit: SUITS.SPADES, rank: '10', points: 0 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 }
  ];
  // Bot ist Platz 1 (Team B), Gegner Platz 0 (Team A) ist Ansager
  const decision = shouldAnnounceMit(hand, 0, 1, SUITS.HEARTS, { allowMit: true });
  assert.strictEqual(decision, false);
});

test('Gegner ist Ansager: Bot sagt Mit\' an wenn er 2+ Trümpfe / starke Hand hat', () => {
  const hand = [
    { id: 'sQ', suit: SUITS.SPADES, rank: 'Q', points: 2 }, // Mit' = Trumpf
    { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 }, // Trumpf-Ass
    { id: 'hK', suit: SUITS.HEARTS, rank: 'K', points: 3 }, // Trumpf-König
    { id: 'cA', suit: SUITS.CLUBS, rank: 'A', points: 4 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 }
  ];
  const decision = shouldAnnounceMit(hand, 0, 1, SUITS.HEARTS, { allowMit: true });
  assert.strictEqual(decision, true);
});

console.log('\n=== TEST 3: Strategische Kontra-Ansage (shouldAnnounceContra) ===');

test('Bot gibt Kontra bei starker Hand mit Trumpf-Ass und weiteren Trümpfen', () => {
  const hand = [
    { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 },
    { id: 'hK', suit: SUITS.HEARTS, rank: 'K', points: 3 },
    { id: 'cA', suit: SUITS.CLUBS, rank: 'A', points: 4 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 },
    { id: 's9', suit: SUITS.SPADES, rank: '9', points: 0 }
  ];
  // Gegner Platz 0 hat Mit' angesagt, Bot ist Platz 1 (Team B)
  const decision = shouldAnnounceContra(hand, 0, 1, SUITS.HEARTS, {});
  assert.strictEqual(decision, true);
});

test('Bot gibt KEIN Kontra bei schwacher Hand', () => {
  const hand = [
    { id: 'd9', suit: SUITS.DIAMONDS, rank: '9', points: 0 },
    { id: 'c9', suit: SUITS.CLUBS, rank: '9', points: 0 },
    { id: 's10', suit: SUITS.SPADES, rank: '10', points: 0 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 },
    { id: 'cJ', suit: SUITS.CLUBS, rank: 'J', points: 1 }
  ];
  const decision = shouldAnnounceContra(hand, 0, 1, SUITS.HEARTS, {});
  assert.strictEqual(decision, false);
});

console.log('\n=== TEST 4: Taktisches Schmieren für den Partner ===');

test('Bot ist 4. Spieler, Partner führt sicher mit Trumpf-Ass: Bot schmiert König (+3 Punkte)', () => {
  const currentTrick = [
    { playerIndex: 2, card: { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 } }, // Partner (Team A)
    { playerIndex: 3, card: { id: 'd9', suit: SUITS.DIAMONDS, rank: '9', points: 0 } }, // Gegner (Team B)
    { playerIndex: 1, card: { id: 'c10', suit: SUITS.CLUBS, rank: '10', points: 0 } }   // Gegner (Team B)
  ];
  // Bot ist Platz 0 (Team A), hat keinen Trumpf Herz, aber Karo-König (3 Pkt) und Karo-10 (0 Pkt)
  const hand = [
    { id: 'dK', suit: SUITS.DIAMONDS, rank: 'K', points: 3 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 }
  ];

  const chosen = chooseCardToPlay(hand, currentTrick, SUITS.HEARTS, false, 0, {});
  assert.strictEqual(chosen.id, 'dK', 'Bot soll den König schmieren um dem Partner 3 Augen zu geben!');
});

console.log('\n=== TEST 5: Taktischer 0-Punkte Abwurf (Schnorren) an Gegner ===');

test('Gegner gewinnt mit Trumpf-Ass: Bot wirft 0-Punkte 9er/10er ab und behält/schont den König', () => {
  const currentTrick = [
    { playerIndex: 1, card: { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 } }, // Gegner (Team B)
    { playerIndex: 2, card: { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 } }, // Partner (Team A)
    { playerIndex: 3, card: { id: 'c10', suit: SUITS.CLUBS, rank: '10', points: 0 } }   // Gegner (Team B)
  ];
  // Bot ist Platz 0 (Team A). Hat keinen Trumpf Herz. Hat Karo-König (3 Pkt) und Karo-9 (0 Pkt).
  const hand = [
    { id: 'dK', suit: SUITS.DIAMONDS, rank: 'K', points: 3 },
    { id: 'd9', suit: SUITS.DIAMONDS, rank: '9', points: 0 }
  ];

  const chosen = chooseCardToPlay(hand, currentTrick, SUITS.HEARTS, false, 0, {});
  assert.strictEqual(chosen.id, 'd9', 'Bot soll 0 Punkte abwerfen und dem Gegner keine 3 Punkte schenken!');
});

console.log('\n=== TEST 6: Sparsames und gezieltes Stechen ===');

test('Gegner führt mit Karo-Ass (4 Punkte): Bot sticht mit kleinem Trumpf (Herz 9) ab', () => {
  const currentTrick = [
    { playerIndex: 1, card: { id: 'dA', suit: SUITS.DIAMONDS, rank: 'A', points: 4 } } // Gegner
  ];
  // Bot ist Platz 0 (Team A). Hat kein Karo. Hat Herz-9 (kleiner Trumpf) und Herz-Ass (höchster Trumpf) und Pik-10.
  const hand = [
    { id: 'hA', suit: SUITS.HEARTS, rank: 'A', points: 4 },
    { id: 'h9', suit: SUITS.HEARTS, rank: '9', points: 0 },
    { id: 's10', suit: SUITS.SPADES, rank: '10', points: 0 }
  ];

  const chosen = chooseCardToPlay(hand, currentTrick, SUITS.HEARTS, false, 0, {});
  assert.strictEqual(chosen.id, 'h9', 'Bot soll sparsam mit der Trumpf-9 stechen und nicht das Trumpf-Ass verpulvern!');
});

console.log('\n=== TEST 7: Kluges Ausspiel (Lead) ===');

test('Bot eröffnet Stich und hat Fehlfarben-Ass: Spielt das Ass aus', () => {
  const hand = [
    { id: 'cA', suit: SUITS.CLUBS, rank: 'A', points: 4 },
    { id: 'd10', suit: SUITS.DIAMONDS, rank: '10', points: 0 },
    { id: 's9', suit: SUITS.SPADES, rank: '9', points: 0 }
  ];
  const chosen = chooseCardToPlay(hand, [], SUITS.HEARTS, false, 0, {});
  assert.strictEqual(chosen.id, 'cA', 'Bot soll das sichere Ass ausspielen!');
});

console.log('\n========================================');
console.log(`BOT-AI TEST ERGEBNIS: ${passedTests} Bestanden, ${failedTests} Fehlgeschlagen`);
console.log('========================================\n');

if (failedTests > 0) {
  process.exit(1);
}
