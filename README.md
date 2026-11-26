<p align="center"><img src="logo.png" alt="ZephyCube" width="160"></p>

# ZephyCubeCombat v1.1.0

Combat timer, anti combat log and PvP / PvE days. Stable Script API only (`@minecraft/server` 2.8.0, `@minecraft/server-ui` 2.0.0). No other pack needed. The anti combat log features follow "Anti Combat Log" by GamerDos (rewritten for this pack, no code copied).

> [!NOTE]
> This add-on is built for, and tuned specifically for, [WhitemaneSMP](https://whitemane.fun/). Every feature is a separate module: run `/zc:combatmodules` to open a menu where you can turn off anything you do not need (or use `/zc:combatmodules <module> off`).

## Install

Download `ZephyCubeCombat-v1.1.0-BP.mcaddon` (behavior pack; this add-on has no resource pack) or `ZephyCubeCombat-v1.1.0.mcpack` from the Releases page and open it. Or install by hand: copy the `ZephyCubeCombat` folder into your world's `behavior_packs` folder and add its `uuid` and `version` (from `manifest.json`) to the world's `world_behavior_packs.json`. Needs `@minecraft/server` 2.8.0 and `@minecraft/server-ui` 2.0.0.

## How it works
* Hitting or being hit by another player (damage that went through) puts both players in combat for N seconds (default 20). Every new hit restarts the timer. With `mobs` on, hostile mobs start combat too.
* Exempt from the combat tag: staff (tag `admin`, `moderator` or `mod`, or operator permission), players with the tag `zc:combat_bypass`, CrossBlades duelists and spectators. A staff attacker tags nobody.

## Features (modules)
`/zc:combatmodules` opens the settings menu (pages: Combat timer, Rules in combat, Combat logging, PvP / PvE days, Safezones, Item blacklist). From the console it prints the settings. `/zc:combatmodules <module> on|off` also works. Saved in the world.

| Module | Default | What it does |
| --- | --- | --- |
| `combat` | on | Master switch. Off: nobody is tagged and no combat rule applies |
| `countdown` | on | Seconds left on the action bar (combat and spawn protection) |
| `reminder` | off | Chat reminder while in combat, every 10 to 300 seconds (default 60) |
| `mobs` | off | A hostile mob hitting a player, or a player hitting a hostile mob, also starts combat |
| `claim_block` | on | Sets the tag `zc:combat_noclaim` while in combat. AdminTools keeps players with that tag out of claims. Without AdminTools nothing is blocked |
| `elytra` | on | No elytra in combat: every 2 ticks it is moved to the inventory (or the off hand when the inventory is full). Using an elytra item, or a firework while gliding, is cancelled. Also covers the ArmoredElytras items (`rme:*`) |
| `no_teleport` | off | No ender pearls or chorus fruit in combat, and any jump of more than 20 blocks (or into another dimension) is sent back |
| `crystal_pvp` | on | End crystals and respawn anchors are allowed in combat. Off: no end crystals on obsidian or bedrock, no respawn anchors outside the Nether |
| `potions` | on | Potions are allowed in combat. Off: drinking or throwing potions is cancelled |
| `kill_logout` | on | A player who logs out while in combat is killed at once. If the player is already gone by then, they are killed when they next join (within 60 minutes) |
| `drop_on_logout` | off | If a combat logger is already gone, their items and XP drop at the logout spot at once, and are taken from them when they join again (so nothing is doubled) |
| `safezones` | on | Safezones: boxes where players cannot be hurt by players (unless already in combat, so nobody can run into one to escape a fight) and/or where non-staff cannot break or place blocks |
| `item_blacklist` | on | Blacklisted items are removed from every player's inventory and armor once a second (not from staff). The list starts empty |
| `pvp_days` | off | PvP / PvE days, see below |

Other settings (in the menu): combat length 5 to 300 seconds; ban after combat logging, 0 (off) to 10,080 minutes (a banned player who joins is kicked until it ends; staff are never kicked); spawn protection after being killed by a player, 0 (off) to 600 seconds, default 30.

## Spawn protection
After being killed by a player, the player respawns protected for the set time: other players cannot hurt them. It ends early when they attack a player or use `/zc:relievesp`.

## PvP / PvE days
A separate module for servers with PvP days and PvE days, off by default. In the menu, pick the PvP days of the week, the time zone (UTC offset, default +8) and the switch delay (0 to 120 seconds, default 30).

* On a PvP day everyone can fight.
* On a PvE day a player can only hurt another player when both have PvP on.
* Each player turns their own PvP on or off with `/zc:combat` (a menu) or `/zc:combat on|off`. The change happens after the delay. PvP cannot be turned off while in combat, and a pending switch to off waits until the fight is over.
* The tag `zc:pvpday_bypass` lets a player hit and be hit on PvE days without turning PvP on.

## Commands
| Command | Who | Use |
| --- | --- | --- |
| `/zc:combatmodules [module] [on\|off]` | operators | Settings menu, or turn one module on or off |
| `/zc:combat [on\|off]` | everyone | Your PvP switch for PvE days (menu, or on/off) |
| `/zc:combatcheck` | everyone | Shows whether you are in combat or spawn protected, and your PvP state |
| `/zc:relievesp` | everyone | Ends your spawn protection |
| `/zc:safezone add <x y z> <x y z> <pvp\|build\|both>` | operators | Adds a safezone in your dimension |
| `/zc:safezone remove [x y z]` | operators | Removes the safezone at that spot (default: where you stand) |
| `/zc:safezone list` | operators | Lists the safezones |
| `/zc:safezone show` | operators | Shows or hides safezone outlines for you (green: no PvP, blue: no building only) |
| `/zc:itemblacklist add\|remove <item>` | operators | Adds or removes an item on the blacklist |
| `/zc:itemblacklist list` | operators | Lists the blacklist |

## Tags
| Tag | Meaning |
| --- | --- |
| `zc:combat` | The player is in combat (set and removed automatically) |
| `zc:combat_noclaim` | In combat and claim entry is blocked (set automatically; AdminTools reads it) |
| `zc:combat_bypass` | Never combat tagged |
| `zc:pvpday_bypass` | Can hit and be hit on PvE days |
| `zc:pvp_on` | The player turned PvP on for PvE days (set automatically) |
| `zc:safezone_view` | Sees safezone outlines (set by `/zc:safezone show`) |

## Saved data
World properties `wc:settings` (the settings), `wc:pending` (combat loggers waiting for their next join), `wc:zones` (safezones), `wc:blacklist` (item blacklist), `wc:bans` (combat log bans). Player property `zc:pvp` (PvP switch).

## License

MIT, see `LICENSE`.
