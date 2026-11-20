<p align="center"><img src="logo.png" alt="ZephyCube" width="160"></p>

# ZephyCubeCombat v1.0.0

Combat timer, elytra lock and combat-log kill. Stable Script API only (`@minecraft/server` 2.8.0, `@minecraft/server-ui` 2.0.0). No other pack needed.

> [!NOTE]
> This add-on is built for, and tuned specifically for, [WhitemaneSMP](https://whitemane.fun/). Every feature can be turned on or off in the `/zc:combat` settings menu, so you can disable anything you do not need.

## Install

Download `ZephyCubeCombat-v1.0.0-BP.mcaddon` (behavior pack; this add-on has no resource pack) or `ZephyCubeCombat-v1.0.0.mcpack` from the Releases page and open it. Or install by hand: copy the `ZephyCubeCombat` folder into your world's `behavior_packs` folder and add its `uuid` and `version` (from `manifest.json`) to the world's `world_behavior_packs.json`. Needs `@minecraft/server` 2.8.0 and `@minecraft/server-ui` 2.0.0.

## How it works
* Hitting or being hit by another player (damage that went through) puts both players in combat for N seconds (default 20). Every new hit restarts the timer.
* Staff (tag `admin`, `moderator` or `mod`, or operator permission), CrossBlades duelists and spectators are exempt. A staff attacker tags nobody.

## Features (turn each on or off in `/zc:combat`)
| Setting | What it does |
| --- | --- |
| Combat timer | Master switch. Off: nobody is tagged and nothing else applies |
| Combat length | 5 to 120 seconds, default 20 |
| Disable elytra | Every 2 ticks the elytra of an in-combat player is moved to the inventory (or the off hand when the inventory is full). Using an elytra item, or a firework while gliding, is cancelled. Also covers the ArmoredElytras items (`rme:*`). With no free slot and a full off hand the elytra stays on and the player is told to free a slot |
| Kill on disconnect | A player who logs out while in combat is killed at once. If the player is already gone by then, they are killed when they next join (within 60 minutes) |
| Block claim entry | Sets the tag `zc:combat_noclaim` while in combat. AdminTools keeps players with that tag out of claims. Without AdminTools nothing is blocked |
| Countdown | Seconds left on the action bar |

## Commands
| Command | Who | Use |
| --- | --- | --- |
| `/zc:combat` | operators | Opens the settings menu (from the console it prints the settings) |

## Tags (set and removed automatically)
| Tag | Meaning |
| --- | --- |
| `zc:combat` | The player is in combat |
| `zc:combat_noclaim` | In combat and claim entry is blocked (AdminTools reads it) |

## Saved data
World properties `wc:settings` (the switches) and `wc:pending` (players whose logout kill is waiting for their next join).

## License

MIT, see `LICENSE`.
