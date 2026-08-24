import type { GameHelpContent } from '../components/GameHelpModal';

// Player-facing rules copy for every game's Help modal — written fresh for this purpose (nothing
// player-facing existed anywhere in the app before this), kept deliberately short per section so
// it reads well in a small mobile modal rather than as a full rulebook.

export const SCRAMBLE_HELP: GameHelpContent = {
  title: 'Scramble — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ['Unscramble the shuffled letter tiles into a real word before the timer runs out. Solve as many as you can — each one loads a fresh scramble.'],
    },
    {
      heading: 'Answers',
      body: [
        "You don't have to guess the exact word the tiles came from — any dictionary word you can spell using only the shown tiles counts, as long as you haven't already used it this match.",
        'A word can only score once per match, even if it fits a later scramble too.',
      ],
    },
    {
      heading: 'Hints',
      body: ['Stuck? Hints reveal the next letter of the source word, one at a time — each one costs a few points and is limited per match.'],
    },
    {
      heading: 'Scoring',
      body: ['Every correct word is worth points, hints cost a small penalty. Beat your personal best to see a celebration, and check the leaderboard to see how you stack up against everyone else.'],
    },
    {
      heading: 'Multiplayer',
      body: [
        "Up to 4 players race through the exact same sequence of scrambles, each at their own pace — solving your current word moves you to the next one, even if others are still stuck.",
        'First to solve each word earns a speed bonus on top of the base points, down through 2nd-4th place. A hinted solve skips the speed bonus for that word.',
        "You can't see anyone else's letters or guesses — only how many words and wrong guesses everyone has so far. The match ends when everyone finishes or the match timer runs out, whichever comes first.",
      ],
    },
  ],
};

export const SUDOKU_HELP: GameHelpContent = {
  title: 'Sudoku — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ['Fill the 9×9 grid so every row, every column, and every 3×3 box contains the digits 1-9 exactly once.'],
    },
    {
      heading: 'Playing a cell',
      body: [
        'Tap an empty cell to select it, then tap a number on the keypad to fill it in. Given (uneditable) cells are shaded grey.',
        'Tap the selected cell again, or a filled cell, to see its row/column/box highlighted in light blue — helpful for spotting conflicts.',
      ],
    },
    {
      heading: 'Notes',
      body: ['Toggle Notes mode to pencil in candidate numbers instead of committing to one — useful while narrowing down possibilities.'],
    },
    {
      heading: 'Mistakes & difficulty',
      body: ['A wrong entry is flagged immediately and counted. Choose a difficulty before starting — harder puzzles have fewer given numbers.'],
    },
  ],
};

export const LUDO_HELP: GameHelpContent = {
  title: 'Ludo — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ['Race all 4 of your tokens out of your yard, around the board, and all the way into your home column before anyone else.'],
    },
    {
      heading: 'Rolling & moving',
      body: [
        'Tap the dice on your turn. A 6 lets a token leave the yard, and also grants you another roll — as does capturing an opponent or getting a token all the way home.',
        'A token near home that would overshoot with the current roll still moves — just by less than the full number, right up to the finish.',
      ],
    },
    {
      heading: 'Capturing',
      body: ["Landing exactly on a square occupied by an opponent's token sends it back to their yard — unless that square is a safe square (marked with a star)."],
    },
    {
      heading: 'Winning',
      body: ['First player to get all 4 tokens home wins.'],
    },
  ],
};

export const RUMMY_HELP: GameHelpContent = {
  title: '27-Hand Rummy — How to Play',
  sections: [
    {
      heading: 'Setup',
      body: ['A custom variant: three 52-card decks combined (156 cards), up to 4 players, each dealt a 27-card hand.'],
    },
    {
      heading: 'Your turn',
      body: ['Draw one card (from the stock, or the top of the discard pile if it isn\'t locked), then discard one card from your hand.'],
    },
    {
      heading: 'Jokers',
      body: [
        'One joker rank is revealed to everyone from the start. A second joker rank is also revealed, but you can only use it after you\'ve declared your own 5+4+3 pure-sequence meld (12 of your 27 cards, same suit, no jokers) at some point during play.',
      ],
    },
    {
      heading: 'Declaring a win',
      body: [
        'Organize your hand into groups using "Group Cards." You can declare the instant exactly one card is left ungrouped and your groups include a genuine 5-run, 4-run, and 3-run pure sequence, with everything else forming valid sets or sequences.',
        'An incorrect declaration drops you from the game — organize carefully before declaring.',
      ],
    },
  ],
};

export const BUSINESS_HELP: GameHelpContent = {
  title: 'Business — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ["Be the last player standing — everyone else goes bankrupt paying rent, taxes, and fines."],
    },
    {
      heading: 'Landing on a property',
      body: ["Buy it outright, or send it to auction (any player can then bid) if you'd rather not. Landing on an owned property means paying its owner rent."],
    },
    {
      heading: 'Building & trading',
      body: [
        'Owning every property in a color group lets you build houses and eventually a hotel there, raising the rent — houses must be built evenly across the group.',
        'You can mortgage properties to the bank for quick cash, or trade properties and cash directly with other players at any time, not just on your turn.',
      ],
    },
    {
      heading: 'Chance, Community Chest, and Jail',
      body: [
        'Landing on Chance or Chest draws a card with an instruction to follow. Go To Jail sends you straight there; get out by paying, using a card, or rolling doubles.',
      ],
    },
    {
      heading: 'House rules',
      body: ['The host can toggle optional house rules at creation — Free Parking Jackpot, Double Rent on a full color set, Double Salary on landing exactly on GO, and a bonus/extra-turn for rolling doubles.'],
    },
  ],
};

export const SWEEP_HELP: GameHelpContent = {
  title: 'Sweep — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ['Capture valuable cards. The winning margin each deal adds to a running team score — first team to a net score of 100 wins the match.'],
    },
    {
      heading: 'Capture values & scoring',
      body: [
        'A=1, 2-10 face value, J=11, Q=12, K=13. Spades score their own capture value as points; Aces of other suits are worth 1 point; the 10 of Diamonds is worth 6. Every other card is worth 0 points toward score, even though it still has a capture value.',
      ],
    },
    {
      heading: 'The bid',
      body: [
        'Each deal starts with a bid: the bidder picks a value (9-13) blind, from their own hand alone — the floor is hidden until the value is committed, then revealed to everyone at once.',
        'The bidder then owns the bid by capturing matching floor cards, building a house, or (only if neither is possible) throwing the card loose.',
      ],
    },
    {
      heading: 'Houses & sets',
      body: [
        'A set of floor cards whose values sum to 9-13 can become a "house" of that number, claimed by playing a matching card. A weak house (one set) can still change value; a strong house (2+ sets) is locked in and can only grow.',
        'If your card matches a loose card or a house directly, you must either capture it or build/contribute to a house — you can\'t just throw it away.',
      ],
    },
    {
      heading: 'Sweeps',
      body: ['Capturing everything on the floor at once is a sweep, worth a flat bonus (25 or 50 points, chosen at game creation) — except on the very last card of a deal, which never scores a sweep.'],
    },
  ],
};

export const SEQUENCE_HELP: GameHelpContent = {
  title: 'Sequence — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: [
        'Be first to form a "sequence" — 5 of your chips in a row, horizontally, vertically, or diagonally. Two players/2 teams need 2 sequences to win; a 3-player free-for-all only needs 1.',
      ],
    },
    {
      heading: 'Playing a card',
      body: [
        'Each of your cards matches two spaces on the board (every card appears twice). Tap a card, then tap one of its two open matching spaces to place a chip there.',
        'The four corners are free spaces — they count as part of anyone\'s sequence automatically, no chip needed.',
      ],
    },
    {
      heading: 'Jacks are special',
      body: [
        'Two-eyed jacks (clubs, diamonds) are wild — place a chip on ANY open space.',
        'One-eyed jacks (hearts, spades) remove one opponent chip from the board instead of placing your own — but never a chip that\'s already part of a completed sequence.',
      ],
    },
    {
      heading: 'Dead cards',
      body: [
        'If both of a card\'s spaces are already covered (or, for a one-eyed jack, there\'s nothing left to remove), it\'s "dead" — exchange it for a fresh card instead of playing it.',
      ],
    },
  ],
};

export const CHESS_HELP: GameHelpContent = {
  title: 'Chess — How to Play',
  sections: [
    {
      heading: 'Objective',
      body: ['Checkmate your opponent\'s king — put it under attack with no legal move that escapes.'],
    },
    {
      heading: 'Making a move',
      body: [
        'Tap a piece to see its legal moves highlighted, then tap a highlighted square to move there. The board always shows your own pieces at the bottom.',
        'Only legal moves are ever offered — check, pins, and castling-through-check are all enforced automatically.',
      ],
    },
    {
      heading: 'Special moves',
      body: [
        'Castling: tap your king and move it two squares toward a rook (only offered when legal).',
        'En passant and pawn promotion (choose queen, rook, bishop, or knight) are both handled for you when they apply.',
      ],
    },
    {
      heading: 'Draws & resigning',
      body: [
        'Offer or accept a draw at any time, or resign to end the game immediately — both count as a finished game.',
        'The game also ends automatically on stalemate, threefold repetition, the fifty-move rule, or insufficient material to checkmate.',
      ],
    },
  ],
};
