# Slay the Spire API

`sts` is in scope in `sts_exec`. Slay the Spire is turn-based and waits for you: nothing happens between your commands. Every call returns the full game state after the game settled.

## State

`await sts.state()` (alias `sts.observe()`) returns `{ available_commands, ready_for_command, in_game, game_state }`. `game_state` has `screen_type`, one of `EVENT`, `CHEST`, `SHOP_ROOM`, `REST`, `CARD_REWARD`, `COMBAT_REWARD`, `MAP`, `BOSS_REWARD`, `SHOP_SCREEN`, `GRID`, `HAND_SELECT`, `GAME_OVER`, `COMPLETE`, `NONE` (`NONE` during a fight: the combat itself is in `combat_state`), `screen_state` (the choices and details of that screen), `room_phase` (`COMBAT`, `EVENT`, `COMPLETE`, `INCOMPLETE`), `floor`, `act`, `act_boss`, `current_hp`, `max_hp`, `gold`, `deck`, `relics`, `potions`, `map`, `choice_list` and, in combat, `combat_state` with `hand`, `draw_pile`, `discard_pile`, `exhaust_pile`, `player` (`energy`, `block`, `powers`), `monsters` (`current_hp`, `block`, `intent`, `move_adjusted_damage`, `move_hits`, `powers`) and `turn`. `available_commands` lists what you may do right now.

## Commands

- `await sts.play(cardIndex, targetIndex?)`: play the card at `cardIndex` (1-based, as in the hand) on monster `targetIndex` (0-based) when the card needs a target.
- `await sts.end()`: end the turn.
- `await sts.potion("use" | "discard", slot, targetIndex?)`.
- `await sts.choose(indexOrName)`: pick from `choice_list` (0-based index or the choice's name) on map, reward, event, shop, rest and card screens.
- `await sts.proceed()` / `await sts.confirm()`: the right-hand button (continue, confirm).
- `await sts.cancel()` / `await sts.skip()` / `await sts.leave()` / `await sts.back()`: the left-hand button.
- `await sts.key("Confirm" | "Cancel" | "Map" | "Deck" | "Draw_Pile" | "Discard_Pile" | "Exhaust_Pile" | "End_Turn" | "Up" | "Down" | "Left" | "Right" | "Drop_Card" | "Card_1".."Card_10")`: presses that key.
- `await sts.click(x, y, "left" | "right")`: a mouse click at (x, y) in the game's own 1920x1080 space ((0,0) is the top left corner, (1920,1080) the bottom right, whatever the window resolution). It also moves the cursor. Everything on a screen is reachable with `choose`, `proceed` and `cancel`; a click is for what those do not offer.
- `await sts.wait(frames)`: let the game run for that number of frames, or until the game state changes, whichever comes first.
- `await sts.command("PLAY 1 0")`: any raw Communication Mod command.
- `await sts.screenshot()`: the game window as an image (the state is the ground truth; the picture is for orientation).

- `await sts.restart()`: only after a death (`screen_type` `GAME_OVER` without victory): a new run with the same seed (same map, encounters and rewards). Every other command is refused until you restart.

`sts.choose()` refuses to enter the Secret Portal event (act 3): only "leave" is accepted there.

Commands that are not in `available_commands` are rejected with an error; read the state first. The run has already been started for you (character, ascension and seed are fixed); do not start a new one yourself.
