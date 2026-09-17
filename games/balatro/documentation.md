# Balatro API

`bal` is in scope in `balatro_exec`. Balatro is turn-based and waits for you: nothing happens between your actions. Every action returns the game state after the game settled.

## State

`await bal.state()` (alias `bal.observe()`) returns the game state as balatrobot reports it:

- `state`: where the game is. `BLIND_SELECT` (choose to play or skip the next blind), `SELECTING_HAND` (play or discard cards), `ROUND_EVAL` (the round is won; cash out), `SHOP`, `SMODS_BOOSTER_OPENED` (a booster pack is open; pick from it or skip), `GAME_OVER`.
- `ante_num`, `round_num`, `money`, `deck`, `stake`, `seed`, `won` (true once the boss blind of ante 8 is beaten).
- `round`: `hands_left`, `hands_played`, `discards_left`, `discards_used`, `reroll_cost`, `chips` (scored this round).
- `blinds`: `small`, `big`, `boss`, each with `type`, `status` (`SELECT`, `CURRENT`, `UPCOMING`, `DEFEATED`, `SKIPPED`), `name`, `effect`, `score` (chips needed), `tag_name`, `tag_effect` (the tag for skipping it).
- `hands`: per poker hand its `level`, `chips`, `mult`, `played`, `played_this_round`.
- Card areas, each `{ count, limit, highlighted_limit, cards }`: `hand`, `jokers`, `consumables`, `cards` (the deck), and in the shop `shop`, `vouchers`, `packs`; `pack` when a booster pack is open. Areas that are empty and not always present are left out.
- A card: `id`, `key` (for example `H_A` for the Ace of Hearts, `j_joker`, `c_fool`), `set`, `label`, `value` (`suit`, `rank`, `effect`: what it does, in the game's words), `modifier` (`seal`, `edition`, `enhancement`, `eternal`, `perishable`, `rental`), `state` (`debuff`, `hidden`, `highlight`), `cost` (`buy`, `sell`).
- `used_vouchers`.

Suits are `H`, `D`, `C`, `S`; ranks `2`-`9`, `T`, `J`, `Q`, `K`, `A`.

## Actions

Indices are 0-based positions in the area as the state lists it.

- `await bal.select()`: play the blind that is up (`BLIND_SELECT`).
- `await bal.skip()`: skip the small or big blind for its tag (`BLIND_SELECT`). The boss blind cannot be skipped.
- `await bal.play([i, ...])`: play 1 to 5 cards from `hand` (`SELECTING_HAND`).
- `await bal.discard([i, ...])`: discard cards from `hand` (`SELECTING_HAND`).
- `await bal.cashOut()`: collect the round's reward and go to the shop (`ROUND_EVAL`).
- `await bal.buy({ card: i })`, `bal.buy({ voucher: i })`, `bal.buy({ pack: i })`: buy from `shop`, `vouchers` or `packs` (`SHOP`). A bought pack opens at once.
- `await bal.pack({ card: i })`: take card `i` from the open pack; `bal.pack({ card: i, targets: [j, ...] })` when that card needs cards from `hand` as targets; `bal.pack({ skip: true })` to take nothing (`SMODS_BOOSTER_OPENED`). Tarot, Planet and Spectral cards from a pack are used at once; Jokers go to `jokers`, playing cards to the deck.
- `await bal.sell({ joker: i })`, `bal.sell({ consumable: i })`.
- `await bal.use(i, [j, ...]?)`: use consumable `i`, with cards from `hand` as targets when it needs them.
- `await bal.rearrange({ hand: [...] })`, `bal.rearrange({ jokers: [...] })`, `bal.rearrange({ consumables: [...] })`: the new order, as a permutation of the current indices. Joker order matters for some Jokers.
- `await bal.reroll()`: reroll the shop for `round.reroll_cost` (`SHOP`).
- `await bal.nextRound()`: leave the shop (`SHOP`).
- `await bal.screenshot()`: the game window as an image (the state is the ground truth; the picture is for orientation).
- `await bal.restart()`: only after a game over (`state` `GAME_OVER`): a new run with the same deck and stake. Every other action is refused until you restart.

An action that does not fit the game's state or rules is refused with an error that says why; read the state first. The run has already been started for you (deck, stake and seed are fixed); starting runs, returning to the menu, saving, loading and changing the game's values are not available.
