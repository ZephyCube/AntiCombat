import "./style.js";
import {
    world, system, EquipmentSlot, PlayerPermissionLevel, ItemStack,
    CommandPermissionLevel, CustomCommandStatus, CustomCommandParamType
} from "@minecraft/server";
import { ActionFormData, ModalFormData, FormCancelationReason } from "@minecraft/server-ui";

// ZephyCube AntiCombat (formerly ZephyCube Combat). Stable API only.
//  Combat tag: hitting or being hit by another player (damage that went through) puts both in combat for
//  `seconds` seconds. While in combat the rules below apply. Logging out in combat is punished.
//  Anti combat log features follow "Anti Combat Log" by GamerDos (rewritten, no code copied).
//  PvP / PvE days (separate, off by default): on PvE days players only fight others who also turned PvP on.
//  /zc:combatmodules (operators) opens the settings; /zc:combat [on|off] is every player's PvP switch for PvE days.
// Exempt from the combat tag: staff (admin/moderator/mod tag or operator permission), the tag zc:combat_bypass,
// CrossBlades duelists and spectators.

const SKEY = "wc:settings";
const PKEY = "wc:pending";           // players whose logout punishment waits for their next join: { name(lowercase): { t, clear } }
const ZKEY = "wc:zones";             // safezones: [{ d, a: [x,y,z], b: [x,y,z], pvp, build }]
const BKEY = "wc:blacklist";         // blacklisted item ids
const BANKEY = "wc:bans";            // { player id: ban end (ms) }
const TAG = "zc:combat";             // in combat (other packs can read it)
const TAG_CLAIM = "zc:combat_noclaim"; // in combat AND claim entry blocked (AdminTools reads this)
const TAG_BYPASS = "zc:combat_bypass"; // never combat tagged
const TAG_PVPDAY_BYPASS = "zc:pvpday_bypass"; // can hit and be hit on PvE days
const TAG_PVP = "zc:pvp_on";         // this player turned PvP on for PvE days (mirror of the player property)
const TAG_ZONE_VIEW = "zc:safezone_view"; // sees safezone outlines
const PVP_PROP = "zc:pvp";
const PENDING_MAX_AGE = 60 * 60 * 1000;
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

const DEFAULTS = {
    // combat tag
    combat: true, seconds: 20, countdown: true, reminder: false, reminderEvery: 60, mobs: false, claimBlock: true,
    // rules while in combat
    elytra: true, noTeleport: false, crystals: true, potions: true,
    // combat logging
    killLogout: true, dropOnLogout: false, banMinutes: 0, spawnProt: 30,
    // areas and items
    safezones: true, blacklist: true,
    // PvP / PvE days
    pvpDays: false, pvpWeekdays: [false, false, false, false, false, false, false], tz: 8, toggleDelay: 30,
};
const LIMITS = { seconds: [5, 300], reminderEvery: [10, 300], banMinutes: [0, 10080], spawnProt: [0, 600], tz: [-12, 14], toggleDelay: [0, 120] };
// on/off switches, by the names used in /zc:combatmodules <module> on|off
const MODULES = [
    { key: "combat", field: "combat", label: "combat timer (master switch: off = nobody is tagged and no combat rule applies)" },
    { key: "countdown", field: "countdown", label: "seconds left on the action bar" },
    { key: "reminder", field: "reminder", label: "chat reminder while in combat" },
    { key: "mobs", field: "mobs", label: "hostile mobs also start combat" },
    { key: "claim_block", field: "claimBlock", label: "no entering claims in combat (AdminTools reads zc:combat_noclaim)" },
    { key: "elytra", field: "elytra", label: "no elytra in combat" },
    { key: "no_teleport", field: "noTeleport", label: "no ender pearls, chorus fruit or teleporting in combat" },
    { key: "crystal_pvp", field: "crystals", label: "end crystals and respawn anchors allowed in combat" },
    { key: "potions", field: "potions", label: "potions allowed in combat" },
    { key: "kill_logout", field: "killLogout", label: "logging out in combat kills the player" },
    { key: "drop_on_logout", field: "dropOnLogout", label: "a combat logger's items drop where they logged out, at once" },
    { key: "safezones", field: "safezones", label: "safezones (no PvP and/or no building inside)" },
    { key: "item_blacklist", field: "blacklist", label: "blacklisted items are removed from inventories" },
    { key: "pvp_days", field: "pvpDays", label: "PvP / PvE days with a per-player PvP switch (/zc:combat)" },
];

let S = structuredCloneSafe(DEFAULTS);
function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }
const clamp = (k, v) => Math.max(LIMITS[k][0], Math.min(LIMITS[k][1], Math.round(Number(v))));
function loadSettings() {
    try {
        const raw = world.getDynamicProperty(SKEY);
        if (typeof raw === "string") {
            const o = JSON.parse(raw);
            for (const k of Object.keys(DEFAULTS)) {
                if (k === "pvpWeekdays") { if (Array.isArray(o[k]) && o[k].length === 7) S[k] = o[k].map((x) => x === true); }
                else if (typeof o[k] === typeof DEFAULTS[k]) S[k] = o[k];
            }
        }
    } catch { }
    for (const k of Object.keys(LIMITS)) S[k] = Number.isFinite(Number(S[k])) ? clamp(k, S[k]) : DEFAULTS[k];
}
function saveSettings() { try { world.setDynamicProperty(SKEY, JSON.stringify(S)); } catch { } }
function readJson(key, fallback) {
    try { const v = world.getDynamicProperty(key); return typeof v === "string" ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJson(key, v, empty) { try { world.setDynamicProperty(key, empty ? undefined : JSON.stringify(v)); } catch { } }

let zones = [];
let blacklist = [];
system.run(() => {
    loadSettings();
    zones = readJson(ZKEY, []).filter((z) => z && Array.isArray(z.a) && Array.isArray(z.b));
    blacklist = readJson(BKEY, []).filter((x) => typeof x === "string");
});
const saveZones = () => writeJson(ZKEY, zones, zones.length === 0);
const saveBlacklist = () => writeJson(BKEY, blacklist, blacklist.length === 0);

const combat = new Map();   // player id -> end time (ms)
const prot = new Map();     // player id -> spawn protection end time (ms)
const killedByPlayer = new Set(); // player ids that died to a player and have not respawned yet

function isStaff(p) {
    try {
        if (p.hasTag("admin") || p.hasTag("moderator") || p.hasTag("mod")) return true;
        const lvl = p.playerPermissionLevel;
        return lvl !== undefined && lvl !== PlayerPermissionLevel.Member && lvl !== PlayerPermissionLevel.Visitor;
    } catch { return false; }
}
function exempt(p) {
    try { return p.hasTag("crossblades:dueling") || p.hasTag("crossblades:spectating") || p.hasTag(TAG_BYPASS) || isStaff(p); } catch { return true; }
}
function inCombat(p) {
    const e = combat.get(p.id);
    return e !== undefined && Date.now() < e;
}
function isProtected(p) {
    const e = prot.get(p.id);
    return e !== undefined && Date.now() < e;
}
function say(p, text) { try { p.sendMessage(text); } catch { } }
const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));
const fmt = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`);
const throttle = new Map();
function sayOnce(p, key, text, ticks = 40) {
    const k = `${p.id}|${key}`, t = system.currentTick;
    if ((throttle.get(k) ?? -9999) > t - ticks) return;
    throttle.set(k, t);
    say(p, text);
}

function clearTags(p) {
    try { p.removeTag(TAG); } catch { }
    try { p.removeTag(TAG_CLAIM); } catch { }
}
function endCombat(p, announce) {
    combat.delete(p.id);
    clearTags(p);
    if (announce) say(p, "§aYou are no longer in combat.");
    try { if (p.isValid && S.countdown) p.onScreenDisplay.setActionBar(" "); } catch { }
}
function endProtection(p, announce) {
    if (!prot.delete(p.id)) return;
    if (announce) say(p, "§eYour spawn protection has ended.");
}
function tagCombat(p) {
    if (!S.combat || exempt(p)) return;
    if (isProtected(p)) endProtection(p, true); // fighting ends spawn protection
    const was = inCombat(p);
    combat.set(p.id, Date.now() + S.seconds * 1000);
    try { p.addTag(TAG); if (S.claimBlock) p.addTag(TAG_CLAIM); else p.removeTag(TAG_CLAIM); } catch { }
    if (!was) {
        const extra = [];
        if (S.elytra) extra.push("elytras are off");
        if (S.noTeleport) extra.push("no teleporting");
        if (!S.potions) extra.push("no potions");
        if (!S.crystals) extra.push("no crystal PvP");
        if (S.claimBlock) extra.push("you cannot enter claims");
        if (S.killLogout) extra.push("logging out kills you");
        say(p, `§cYou are in combat for ${S.seconds} seconds${extra.length ? ": " + extra.join(", ") : ""}.`);
    }
}

// ---------------------------------------------------------------------------
// safezones
// ---------------------------------------------------------------------------
function zoneAt(dimId, l, kind) {
    if (!S.safezones) return undefined;
    for (const z of zones) {
        if (z.d !== dimId || (kind && !z[kind])) continue;
        if (l.x >= Math.min(z.a[0], z.b[0]) && l.x < Math.max(z.a[0], z.b[0]) + 1 &&
            l.y >= Math.min(z.a[1], z.b[1]) && l.y < Math.max(z.a[1], z.b[1]) + 1 &&
            l.z >= Math.min(z.a[2], z.b[2]) && l.z < Math.max(z.a[2], z.b[2]) + 1) return z;
    }
    return undefined;
}
const zoneText = (z, i) => `#${i + 1} ${z.d.replace("minecraft:", "")} ${z.a.join(" ")} to ${z.b.join(" ")} (${z.pvp && z.build ? "no PvP, no building" : z.pvp ? "no PvP" : "no building"})`;

// ---------------------------------------------------------------------------
// PvP / PvE days
// ---------------------------------------------------------------------------
function todayIndex() { // 0 = Monday ... 6 = Sunday, in the server's time zone setting
    const d = new Date(Date.now() + S.tz * 3600000).getUTCDay();
    return (d + 6) % 7;
}
const isPveDay = () => S.pvpDays && !S.pvpWeekdays[todayIndex()];
function pvpOn(p) { try { return p.getDynamicProperty(PVP_PROP) === true; } catch { return false; } }
function mayFightOnPveDay(p) { try { return pvpOn(p) || p.hasTag(TAG_PVPDAY_BYPASS); } catch { return false; } }
const pvpPending = new Map(); // player id -> { on, at }
function requestPvp(p, on) {
    if (!S.pvpDays) return "PvP / PvE days are not turned on on this server.";
    if (pvpOn(p) === on && !pvpPending.has(p.id)) return `Your PvP is already ${on ? "on" : "off"}.`;
    if (!on && inCombat(p)) return "You cannot turn PvP off while in combat.";
    if (S.toggleDelay === 0) { applyPvp(p, on); return undefined; }
    pvpPending.set(p.id, { on, at: Date.now() + S.toggleDelay * 1000 });
    return `§eYour PvP turns ${on ? "§con" : "§aoff"}§e in ${S.toggleDelay} seconds.`;
}
function applyPvp(p, on) {
    pvpPending.delete(p.id);
    try {
        p.setDynamicProperty(PVP_PROP, on ? true : undefined);
        if (on) p.addTag(TAG_PVP); else p.removeTag(TAG_PVP);
    } catch { }
    say(p, on ? "§cYour PvP is now on: on PvE days, other players with PvP on can attack you." : "§aYour PvP is now off: on PvE days, players cannot attack you.");
}

// ---------------------------------------------------------------------------
// damage: spawn protection, PvP safezones, PvE days (before), combat tag (after)
// ---------------------------------------------------------------------------
world.beforeEvents.entityHurt.subscribe((ev) => {
    try {
        const v = ev.hurtEntity, a = ev.damageSource?.damagingEntity;
        if (v?.typeId !== "minecraft:player" || a?.typeId !== "minecraft:player" || v.id === a.id) return;
        if (v.hasTag("crossblades:dueling") && a.hasTag("crossblades:dueling")) return;
        let why;
        if (S.spawnProt > 0 && isProtected(v)) why = `${v.name} has spawn protection.`;
        else if (!inCombat(v) && zoneAt(v.dimension.id, v.location, "pvp")) why = `${v.name} is in a safezone.`;
        else if (isPveDay() && !(mayFightOnPveDay(a) && mayFightOnPveDay(v))) {
            why = mayFightOnPveDay(a) ? `It is a PvE day and ${v.name} has PvP off.` : "It is a PvE day: turn PvP on with /zc:combat on to fight players who also have it on.";
        }
        if (!why) {
            if (isProtected(a)) system.run(() => endProtection(a, true));
            return;
        }
        ev.cancel = true;
        system.run(() => sayOnce(a, "hurt", `§c${why}`));
    } catch { }
}, { entityFilter: { type: "minecraft:player" } });

function isMonster(e) {
    try { return e.getComponent("minecraft:type_family")?.hasTypeFamily("monster") === true; } catch { return false; }
}
world.afterEvents.entityHurt.subscribe((ev) => {
    try {
        if (!S.combat) return;
        const v = ev.hurtEntity, a = ev.damageSource?.damagingEntity;
        if (!v || !a || v.id === a.id) return;
        const vp = v.typeId === "minecraft:player", ap = a.typeId === "minecraft:player";
        if (vp && ap) {
            if (v.hasTag("crossblades:dueling") && a.hasTag("crossblades:dueling")) return;
            if (isStaff(a)) return;
            tagCombat(v);
            tagCombat(a);
            return;
        }
        if (!S.mobs) return;
        if (vp && isMonster(a)) tagCombat(v);
        else if (ap && isMonster(v)) tagCombat(a);
    } catch { }
});

world.afterEvents.entityDie.subscribe((ev) => {
    try {
        const p = ev.deadEntity;
        if (p?.typeId !== "minecraft:player") return;
        combat.delete(p.id);
        clearTags(p);
        prot.delete(p.id);
        const k = ev.damageSource?.damagingEntity;
        if (k?.typeId === "minecraft:player" && k.id !== p.id) killedByPlayer.add(p.id);
    } catch { }
});

// ---------------------------------------------------------------------------
// rules in combat: elytra, teleporting, potions, crystal PvP
// ---------------------------------------------------------------------------
// minecraft:elytra, and the armored elytras of the ArmoredElytras pack (rme:*_chestplate)
function isElytra(item) {
    const id = item?.typeId;
    return typeof id === "string" && (id.includes("elytra") || id.startsWith("rme:"));
}
const warned = new Map(); // player id -> tick of the last "no free slot" warning
function takeOffElytra(p) {
    try {
        const eq = p.getComponent("minecraft:equippable");
        const chest = eq?.getEquipment(EquipmentSlot.Chest);
        if (!chest || !isElytra(chest)) return;
        const inv = p.getComponent("minecraft:inventory")?.container;
        // put it in the inventory first, only then clear the slot (never lose or copy the item)
        if (inv && inv.emptySlotsCount > 0) {
            const left = inv.addItem(chest);
            if (!left) { eq.setEquipment(EquipmentSlot.Chest, undefined); say(p, "§cElytras cannot be worn in combat. It was moved to your inventory."); return; }
        }
        const off = eq.getEquipment(EquipmentSlot.Offhand);
        if (!off) { eq.setEquipment(EquipmentSlot.Offhand, chest); eq.setEquipment(EquipmentSlot.Chest, undefined); say(p, "§cElytras cannot be worn in combat. It was moved to your off hand."); return; }
        const t = system.currentTick;
        if (!(warned.get(p.id) > t - 100)) { warned.set(p.id, t); say(p, "§cElytras are off in combat, but you have no free slot: free one so it can be taken off."); }
    } catch { }
}
world.beforeEvents.itemUse.subscribe((ev) => {
    try {
        const p = ev.source;
        if (!S.combat || p?.typeId !== "minecraft:player" || !inCombat(p)) return;
        const id = ev.itemStack?.typeId ?? "";
        let why;
        if (S.elytra && (isElytra(ev.itemStack) || (id === "minecraft:firework_rocket" && p.isGliding))) why = "You cannot use elytras in combat.";
        else if (S.noTeleport && (id === "minecraft:ender_pearl" || id === "minecraft:chorus_fruit")) why = "You cannot teleport in combat.";
        else if (!S.potions && id.includes("potion")) why = "You cannot use potions in combat.";
        if (!why) return;
        ev.cancel = true;
        system.run(() => sayOnce(p, "use", `§c${why}`, 20));
    } catch { }
});
world.beforeEvents.playerInteractWithBlock.subscribe((ev) => {
    try {
        const p = ev.player;
        if (!S.combat || S.crystals || !inCombat(p)) return;
        const b = ev.block?.typeId, item = ev.itemStack?.typeId;
        const crystal = item === "minecraft:end_crystal" && (b === "minecraft:obsidian" || b === "minecraft:bedrock");
        const anchor = b === "minecraft:respawn_anchor" && p.dimension.id !== "minecraft:nether";
        if (!crystal && !anchor) return;
        ev.cancel = true;
        system.run(() => sayOnce(p, "crystal", "§cCrystal PvP is off in combat.", 20));
    } catch { }
});

// ---------------------------------------------------------------------------
// safezone building rules
// ---------------------------------------------------------------------------
world.beforeEvents.playerBreakBlock.subscribe((ev) => {
    try {
        if (isStaff(ev.player) || !zoneAt(ev.block.dimension.id, ev.block.location, "build")) return;
        ev.cancel = true;
        const p = ev.player;
        system.run(() => sayOnce(p, "build", "§cYou cannot break blocks in this safezone.", 20));
    } catch { }
});
world.afterEvents.playerPlaceBlock.subscribe((ev) => {
    try {
        const p = ev.player, b = ev.block;
        if (isStaff(p) || !zoneAt(b.dimension.id, b.location, "build")) return;
        const typeId = b.typeId;
        b.setType("minecraft:air");
        try { p.getComponent("minecraft:inventory")?.container?.addItem(new ItemStack(typeId, 1)); } catch { }
        sayOnce(p, "build", "§cYou cannot place blocks in this safezone.", 20);
    } catch { }
});

// ---------------------------------------------------------------------------
// tick: countdown, reminders, expiry, elytra, teleport lock, spawn protection, PvP switch delay
// ---------------------------------------------------------------------------
const lastPos = new Map(); // player id -> { d, x, y, z }
system.runInterval(() => {
    const now = Date.now();
    const tick = system.currentTick;
    for (const p of world.getAllPlayers()) {
        try {
            // PvP switch delay
            const pend = pvpPending.get(p.id);
            if (pend && now >= pend.at) {
                if (!S.pvpDays) pvpPending.delete(p.id);
                else if (!pend.on && inCombat(p)) { /* wait until the fight is over */ }
                else applyPvp(p, pend.on);
            }
            // spawn protection
            const pe = prot.get(p.id);
            if (pe !== undefined) {
                if (now >= pe || S.spawnProt === 0) endProtection(p, true);
                else if (S.countdown && tick % 10 === 0) p.onScreenDisplay.setActionBar(`§aSpawn protection: ${fmt(secs(pe - now))}`);
            }
            // combat
            const e = combat.get(p.id);
            if (e === undefined) { lastPos.delete(p.id); continue; }
            if (!S.combat || exempt(p)) { endCombat(p, false); continue; }
            if (now >= e) { endCombat(p, true); continue; }
            if (S.elytra) takeOffElytra(p);
            if (!S.claimBlock && p.hasTag(TAG_CLAIM)) p.removeTag(TAG_CLAIM);
            if (S.claimBlock && !p.hasTag(TAG_CLAIM)) p.addTag(TAG_CLAIM);
            if (S.countdown && tick % 10 === 0) p.onScreenDisplay.setActionBar(`§cCombat: ${fmt(secs(e - now))}`);
            if (S.reminder && tick % (S.reminderEvery * 20) < 2) say(p, `§cYou are still in combat (${fmt(secs(e - now))} left).`);
            // teleport lock: a jump of more than 20 blocks (or another dimension) in 4 ticks is sent back
            if (tick % 4 === 0) {
                const l = p.location, d = p.dimension.id, last = lastPos.get(p.id);
                if (S.noTeleport && last && (last.d !== d || Math.hypot(l.x - last.x, l.y - last.y, l.z - last.z) > 20)) {
                    p.teleport({ x: last.x, y: last.y, z: last.z }, { dimension: world.getDimension(last.d) });
                    sayOnce(p, "tp", "§cYou cannot teleport in combat: you were sent back.");
                } else lastPos.set(p.id, { d, x: l.x, y: l.y, z: l.z });
            }
        } catch { }
    }
}, 2);

// spawn protection starts at the respawn after a death caused by a player
world.afterEvents.playerSpawn.subscribe((ev) => {
    if (ev.initialSpawn) return;
    const p = ev.player;
    if (!killedByPlayer.delete(p.id) || S.spawnProt <= 0) return;
    prot.set(p.id, Date.now() + S.spawnProt * 1000);
    say(p, `§aYou have spawn protection for ${fmt(S.spawnProt)}: players cannot hurt you. Attacking a player ends it, or use /zc:relievesp.`);
});

// blacklisted items are removed (not from staff)
system.runInterval(() => {
    if (!S.blacklist || blacklist.length === 0) return;
    const ids = new Set(blacklist);
    for (const p of world.getAllPlayers()) {
        try {
            if (isStaff(p)) continue;
            const inv = p.getComponent("minecraft:inventory")?.container;
            if (!inv) continue;
            for (let i = 0; i < inv.size; i++) {
                const it = inv.getItem(i);
                if (it && ids.has(it.typeId)) { inv.setItem(i, undefined); sayOnce(p, "blacklist", `§c${it.typeId.replace("minecraft:", "")} is not allowed on this server and was removed.`); }
            }
            const eq = p.getComponent("minecraft:equippable");
            for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
                const it = eq?.getEquipment(slot);
                if (it && ids.has(it.typeId)) { eq.setEquipment(slot, undefined); sayOnce(p, "blacklist", `§c${it.typeId.replace("minecraft:", "")} is not allowed on this server and was removed.`); }
            }
        } catch { }
    }
}, 20);

// safezone outlines for players with the view tag
system.runInterval(() => {
    if (!S.safezones || zones.length === 0) return;
    for (const p of world.getAllPlayers()) {
        try {
            if (!p.hasTag(TAG_ZONE_VIEW)) continue;
            const dim = p.dimension, l = p.location;
            let budget = 400;
            for (const z of zones) {
                if (z.d !== dim.id) continue;
                const x0 = Math.min(z.a[0], z.b[0]), x1 = Math.max(z.a[0], z.b[0]) + 1;
                const y0 = Math.min(z.a[1], z.b[1]), y1 = Math.max(z.a[1], z.b[1]) + 1;
                const z0 = Math.min(z.a[2], z.b[2]), z1 = Math.max(z.a[2], z.b[2]) + 1;
                const edges = [];
                for (const y of [y0, y1]) for (const zz of [z0, z1]) edges.push([[x0, y, zz], [x1, y, zz]]);
                for (const x of [x0, x1]) for (const zz of [z0, z1]) edges.push([[x, y0, zz], [x, y1, zz]]);
                for (const x of [x0, x1]) for (const y of [y0, y1]) edges.push([[x, y, z0], [x, y, z1]]);
                for (const [s, t] of edges) {
                    const len = Math.max(Math.abs(t[0] - s[0]), Math.abs(t[1] - s[1]), Math.abs(t[2] - s[2]));
                    for (let i = 0; i <= len && budget > 0; i++) {
                        const q = { x: s[0] + (t[0] - s[0]) * i / len, y: s[1] + (t[1] - s[1]) * i / len, z: s[2] + (t[2] - s[2]) * i / len };
                        if (Math.abs(q.x - l.x) > 32 || Math.abs(q.y - l.y) > 32 || Math.abs(q.z - l.z) > 32) continue;
                        try { p.spawnParticle(z.pvp ? "minecraft:villager_happy" : "minecraft:blue_flame_particle", q); } catch { }
                        budget--;
                    }
                }
            }
        } catch { }
    }
}, 20);

// ---------------------------------------------------------------------------
// logout in combat: kill, drop items, ban
// ---------------------------------------------------------------------------
function readPending() {
    const o = readJson(PKEY, {});
    return o && typeof o === "object" ? o : {};
}
function writePending(o) { writeJson(PKEY, o, Object.keys(o).length === 0); }
function readBans() { const o = readJson(BANKEY, {}); return o && typeof o === "object" ? o : {}; }
function writeBans(o) {
    const now = Date.now();
    for (const k of Object.keys(o)) if (!(o[k] > now)) delete o[k];
    writeJson(BANKEY, o, Object.keys(o).length === 0);
}

world.beforeEvents.playerLeave.subscribe(({ player }) => {
    try {
        if (!S.combat || !S.killLogout || !inCombat(player) || exempt(player)) { combat.delete(player.id); return; }
        const name = player.name, id = player.id;
        const dimId = player.dimension.id, loc = { ...player.location };
        // copy what the player carries now, in case it has to be dropped here
        const items = [];
        let level = 0;
        if (S.dropOnLogout) {
            try {
                const inv = player.getComponent("minecraft:inventory")?.container;
                if (inv) for (let i = 0; i < inv.size; i++) { const it = inv.getItem(i); if (it) items.push(it); }
                const eq = player.getComponent("minecraft:equippable");
                for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) {
                    const it = eq?.getEquipment(slot); if (it) items.push(it);
                }
                level = player.level;
            } catch { }
        }
        combat.delete(id);
        system.run(() => {
            let killed = false;
            try { if (player.isValid) { player.kill(); killed = true; } } catch { }
            if (!killed) { // the player is already gone: drop now (optional) and punish the moment they join again
                let dropped = false;
                if (S.dropOnLogout && items.length) {
                    try {
                        const dim = world.getDimension(dimId);
                        // tagged so anti-dupe packs (ZephyCube Log anti_crash_drop) keep them
                        for (const it of items) { const e = dim.spawnItem(it, loc); try { e?.addTag("zc:keep_drop"); } catch { } }
                        for (let i = 0; i < Math.min(100, level * 7); i++) dim.spawnEntity("minecraft:xp_orb", loc);
                        dropped = true;
                    } catch { }
                }
                const o = readPending();
                o[name.toLowerCase()] = { t: Date.now(), clear: dropped };
                writePending(o);
            }
            if (S.banMinutes > 0) { const b = readBans(); b[id] = Date.now() + S.banMinutes * 60000; writeBans(b); }
            try { world.sendMessage(`§c${name} logged out in combat and was ${S.banMinutes > 0 ? `killed and banned for ${fmt(S.banMinutes * 60)}` : "killed"}.`); } catch { }
        });
    } catch { }
});
world.afterEvents.playerLeave.subscribe((ev) => {
    combat.delete(ev.playerId); warned.delete(ev.playerId); lastPos.delete(ev.playerId); pvpPending.delete(ev.playerId);
});

function kick(p, reason) {
    try { world.getDimension("minecraft:overworld").runCommand(`kick "${p.name.replace(/"/g, '\\"')}" ${reason}`); } catch { }
}
world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const p = ev.player;
    system.runTimeout(() => {
        try {
            if (!p.isValid) return;
            combat.delete(p.id);
            prot.delete(p.id);
            clearTags(p); // a tag left from before the logout
            try { if (pvpOn(p)) p.addTag(TAG_PVP); else p.removeTag(TAG_PVP); } catch { }
            const bans = readBans();
            if (bans[p.id] > Date.now() && !isStaff(p)) {
                kick(p, `You logged out in combat. You can join again in ${fmt(secs(bans[p.id] - Date.now()))}.`);
                return;
            }
            const o = readPending();
            const k = p.name.toLowerCase();
            const entry = o[k];
            if (entry === undefined) return;
            delete o[k];
            writePending(o);
            const t = typeof entry === "number" ? entry : entry.t;
            if (!S.killLogout || Date.now() - t >= PENDING_MAX_AGE) return;
            if (entry?.clear) { // the items were dropped when they left: take them away before the kill so nothing doubles
                try { p.getComponent("minecraft:inventory")?.container?.clearAll(); } catch { }
                try {
                    const eq = p.getComponent("minecraft:equippable");
                    for (const slot of [EquipmentSlot.Head, EquipmentSlot.Chest, EquipmentSlot.Legs, EquipmentSlot.Feet, EquipmentSlot.Offhand]) eq?.setEquipment(slot, undefined);
                } catch { }
                try { p.resetLevel(); } catch { }
            }
            say(p, "§cYou logged out in combat.");
            p.kill();
        } catch { }
    }, 20);
});

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
async function showForm(player, form) {
    for (let i = 0; i < 30; i++) {
        if (!player.isValid) return null;
        const r = await form.show(player);
        if (!r.canceled) return r;
        if (r.cancelationReason !== FormCancelationReason.UserBusy) return r;
        await new Promise((res) => system.runTimeout(res, 10));
    }
    return null;
}
// form values without the label/header/divider entries
const values = (r) => (r?.formValues ?? []).filter((v) => v !== undefined);
const onOff = (b) => (b ? "§aon§r" : "§coff§r");

async function pageCombat(p) {
    const f = new ModalFormData().title("Combat timer")
        .toggle("Combat timer", { defaultValue: S.combat, tooltip: "Master switch. Off = nobody gets combat tagged and no combat rule applies" })
        .slider("Combat length (seconds)", 5, 300, { valueStep: 5, defaultValue: S.seconds, tooltip: "Every hit restarts it" })
        .toggle("Show countdown on the action bar", { defaultValue: S.countdown })
        .toggle("Chat reminder while in combat", { defaultValue: S.reminder })
        .slider("Reminder every (seconds)", 10, 300, { valueStep: 10, defaultValue: S.reminderEvery })
        .toggle("Hostile mobs also start combat", { defaultValue: S.mobs, tooltip: "A monster hitting a player, or a player hitting a monster" })
        .toggle("Block entering claims in combat", { defaultValue: S.claimBlock, tooltip: "Needs AdminTools, which reads the tag zc:combat_noclaim" })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 7) return false;
    [S.combat, S.seconds, S.countdown, S.reminder, S.reminderEvery, S.mobs, S.claimBlock] =
        [v[0] === true, clamp("seconds", v[1]), v[2] === true, v[3] === true, clamp("reminderEvery", v[4]), v[5] === true, v[6] === true];
    return true;
}
async function pageRules(p) {
    const f = new ModalFormData().title("Rules in combat")
        .toggle("Disable elytra in combat", { defaultValue: S.elytra, tooltip: "Takes elytras off and blocks putting them on or boosting with fireworks" })
        .toggle("Disable teleporting in combat", { defaultValue: S.noTeleport, tooltip: "No ender pearls or chorus fruit; any jump of more than 20 blocks is sent back" })
        .toggle("Allow crystal PvP in combat", { defaultValue: S.crystals, tooltip: "Off = no end crystals on obsidian/bedrock and no respawn anchors outside the Nether" })
        .toggle("Allow potions in combat", { defaultValue: S.potions })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 4) return false;
    [S.elytra, S.noTeleport, S.crystals, S.potions] = v.map((x) => x === true);
    return true;
}
async function pageLogout(p) {
    const f = new ModalFormData().title("Combat logging")
        .toggle("Kill on disconnect in combat", { defaultValue: S.killLogout, tooltip: "A player who logs out while in combat dies (at once, or when they join again)" })
        .toggle("Drop items where they logged out", { defaultValue: S.dropOnLogout, tooltip: "If the player is already gone, their items and XP drop at the logout spot at once and are taken from them when they join again" })
        .slider("Ban after combat logging (minutes, 0 = off)", 0, 1440, { valueStep: 5, defaultValue: Math.min(1440, S.banMinutes) })
        .textField("Or type the ban length in minutes", "e.g. 4320 for 3 days", { defaultValue: S.banMinutes > 1440 ? String(S.banMinutes) : "" })
        .slider("Spawn protection after a PvP death (seconds, 0 = off)", 0, 600, { valueStep: 10, defaultValue: S.spawnProt, tooltip: "Players cannot hurt you until it ends, you attack a player, or you use /zc:relievesp" })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 5) return false;
    S.killLogout = v[0] === true;
    S.dropOnLogout = v[1] === true;
    const typed = String(v[3] ?? "").trim();
    S.banMinutes = clamp("banMinutes", typed !== "" && Number.isFinite(Number(typed)) ? Number(typed) : v[2]);
    S.spawnProt = clamp("spawnProt", v[4]);
    return true;
}
async function pageDays(p) {
    const f = new ModalFormData().title("PvP / PvE days")
        .toggle("PvP / PvE days", { defaultValue: S.pvpDays, tooltip: "On PvE days players only fight others who also turned PvP on with /zc:combat on" });
    DAYS.forEach((d, i) => f.toggle(`PvP day: ${d}`, { defaultValue: S.pvpWeekdays[i], tooltip: "On = everyone can fight that day. Off = PvE day" }));
    f.slider("Time zone (UTC offset, hours)", -12, 14, { valueStep: 1, defaultValue: S.tz, tooltip: "Decides when a day starts" })
        .slider("Delay when a player turns PvP on or off (seconds)", 0, 120, { valueStep: 5, defaultValue: S.toggleDelay })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 10) return false;
    S.pvpDays = v[0] === true;
    S.pvpWeekdays = v.slice(1, 8).map((x) => x === true);
    S.tz = clamp("tz", v[8]);
    S.toggleDelay = clamp("toggleDelay", v[9]);
    return true;
}
async function pageZones(p) {
    const f = new ModalFormData().title("Safezones")
        .toggle("Safezones", { defaultValue: S.safezones, tooltip: "Add one with /zc:safezone add <from> <to> <pvp|build|both>" })
        .toggle("Show safezone outlines to me", { defaultValue: p.hasTag(TAG_ZONE_VIEW), tooltip: "Green = no PvP, blue = no building only" })
        .dropdown("Remove a safezone", ["Keep all", ...zones.map(zoneText)], { defaultValueIndex: 0 })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 3) return false;
    S.safezones = v[0] === true;
    try { if (v[1] === true) p.addTag(TAG_ZONE_VIEW); else p.removeTag(TAG_ZONE_VIEW); } catch { }
    const i = Number(v[2]) - 1;
    if (i >= 0 && i < zones.length) { const [z] = zones.splice(i, 1); saveZones(); say(p, `Safezone removed: ${zoneText(z, i)}.`); }
    return true;
}
async function pageBlacklist(p) {
    const f = new ModalFormData().title("Item blacklist")
        .toggle("Remove blacklisted items", { defaultValue: S.blacklist, tooltip: "Checked every second for every player except staff" })
        .textField("Add an item", "e.g. minecraft:tnt", { defaultValue: "" })
        .dropdown("Remove an item from the list", ["Keep all", ...blacklist], { defaultValueIndex: 0 })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 3) return false;
    S.blacklist = v[0] === true;
    const add = String(v[1] ?? "").trim().toLowerCase();
    if (add) { const id = add.includes(":") ? add : `minecraft:${add}`; if (!blacklist.includes(id)) { blacklist.push(id); saveBlacklist(); say(p, `${id} added to the item blacklist.`); } }
    const i = Number(v[2]) - 1;
    if (i >= 0 && i < blacklist.length && !add) { const [id] = blacklist.splice(i, 1); saveBlacklist(); say(p, `${id} removed from the item blacklist.`); }
    return true;
}
const PAGES = [
    { name: "Combat timer", open: pageCombat },
    { name: "Rules in combat", open: pageRules },
    { name: "Combat logging", open: pageLogout },
    { name: "PvP / PvE days", open: pageDays },
    { name: "Safezones", open: pageZones },
    { name: "Item blacklist", open: pageBlacklist },
];
async function openSettings(p) {
    const f = new ActionFormData().title("Combat").body(`Combat timer ${onOff(S.combat)} (${S.seconds}s). PvP / PvE days ${onOff(S.pvpDays)}${S.pvpDays ? `, today is a ${isPveDay() ? "PvE" : "PvP"} day` : ""}.`);
    for (const pg of PAGES) f.button(pg.name);
    const r = await showForm(p, f);
    if (!r || r.canceled || r.selection === undefined) return;
    if (await PAGES[r.selection].open(p)) {
        saveSettings();
        if (!S.combat) for (const q of world.getAllPlayers()) if (combat.has(q.id)) endCombat(q, false);
        say(p, `Combat settings saved (${PAGES[r.selection].name}).`);
    }
}
async function openPvpMenu(p) {
    if (!S.pvpDays) { say(p, "PvP / PvE days are not turned on on this server."); return; }
    const pend = pvpPending.get(p.id);
    const pvpDays = DAYS.filter((_, i) => S.pvpWeekdays[i]);
    const f = new ModalFormData().title("PvP")
        .toggle(`My PvP on PvE days (today is a ${isPveDay() ? "PvE" : "PvP"} day)`, {
            defaultValue: pend ? pend.on : pvpOn(p),
            tooltip: `PvP days: ${pvpDays.length ? pvpDays.join(", ") : "none"}. On PvE days you can only fight players who also have PvP on. Changes take ${S.toggleDelay} seconds.`,
        })
        .submitButton("Save");
    const v = values(await showForm(p, f));
    if (v.length !== 1) return;
    const msg = requestPvp(p, v[0] === true);
    if (msg) say(p, msg);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------
const ok = (message) => ({ status: CustomCommandStatus.Success, message });
const fail = (message) => ({ status: CustomCommandStatus.Failure, message });
const isPlayer = (e) => e?.typeId === "minecraft:player";
function statusText() {
    return MODULES.map((m) => `${m.key} ${S[m.field] ? "on" : "off"}`).join(", ") +
        `; length ${S.seconds}s, ban ${S.banMinutes} min, spawn protection ${S.spawnProt}s, PvP days ${DAYS.filter((_, i) => S.pvpWeekdays[i]).join(", ") || "none"}`;
}

system.beforeEvents.startup.subscribe((init) => {
    const reg = init.customCommandRegistry;
    reg.registerCommand({
        name: "zc:combatmodules",
        description: "Combat settings menu, or <module> on|off",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        cheatsRequired: false,
        optionalParameters: [{ name: "module", type: CustomCommandParamType.String }, { name: "state", type: CustomCommandParamType.String }],
    }, (origin, mod, state) => {
        const src = origin.sourceEntity;
        if (mod === undefined || mod === null || mod === "") {
            if (isPlayer(src)) { system.run(() => { openSettings(src).catch(() => { }); }); return ok("Close the chat to open the combat settings."); }
            return ok(`Combat: ${statusText()}`);
        }
        const m = MODULES.find((x) => x.key === String(mod).toLowerCase());
        if (!m) return fail(`Unknown module "${mod}". Modules: ${MODULES.map((x) => x.key).join(", ")}`);
        const s = String(state ?? "").toLowerCase();
        if (s !== "on" && s !== "off") return ok(`${m.key} is ${onOff(S[m.field])}. Use /zc:combatmodules ${m.key} on|off`);
        system.run(() => {
            S[m.field] = s === "on";
            saveSettings();
            if (!S.combat) for (const q of world.getAllPlayers()) if (combat.has(q.id)) endCombat(q, false);
        });
        return ok(`Combat: ${m.key} is now ${onOff(s === "on")}.`);
    });

    reg.registerCommand({
        name: "zc:combat",
        description: "Your PvP switch for PvE days: menu, or on|off",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
        optionalParameters: [{ name: "state", type: CustomCommandParamType.String }],
    }, (origin, state) => {
        const p = origin.sourceEntity;
        if (!isPlayer(p)) return fail("Only players have a PvP switch.");
        const s = String(state ?? "").toLowerCase();
        if (s === "") { system.run(() => { openPvpMenu(p).catch(() => { }); }); return ok(S.pvpDays ? "Close the chat to open the PvP menu." : "PvP / PvE days are not turned on on this server."); }
        if (s !== "on" && s !== "off") return fail("Use /zc:combat, /zc:combat on or /zc:combat off.");
        system.run(() => { const msg = requestPvp(p, s === "on"); if (msg) say(p, msg); });
        return ok();
    });

    reg.registerCommand({
        name: "zc:combatcheck",
        description: "Shows whether you are in combat or spawn protected",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    }, (origin) => {
        const p = origin.sourceEntity;
        if (!isPlayer(p)) return fail("Players only.");
        const now = Date.now(), parts = [];
        parts.push(inCombat(p) ? `§cin combat for ${fmt(secs(combat.get(p.id) - now))}§r` : "§anot in combat§r");
        if (isProtected(p)) parts.push(`spawn protected for ${fmt(secs(prot.get(p.id) - now))}`);
        if (S.pvpDays) parts.push(`PvP ${onOff(pvpOn(p))} (today is a ${isPveDay() ? "PvE" : "PvP"} day)`);
        return ok(`You are ${parts.join(", ")}.`);
    });

    reg.registerCommand({
        name: "zc:relievesp",
        description: "Ends your spawn protection",
        permissionLevel: CommandPermissionLevel.Any,
        cheatsRequired: false,
    }, (origin) => {
        const p = origin.sourceEntity;
        if (!isPlayer(p)) return fail("Players only.");
        if (!isProtected(p)) return ok("You have no spawn protection.");
        system.run(() => endProtection(p, true));
        return ok();
    });

    reg.registerCommand({
        name: "zc:safezone",
        description: "Safezones: add <from> <to> <pvp|build|both>, remove [at], list, show",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "action", type: CustomCommandParamType.String }],
        optionalParameters: [
            { name: "from", type: CustomCommandParamType.Location },
            { name: "to", type: CustomCommandParamType.Location },
            { name: "kind", type: CustomCommandParamType.String },
        ],
    }, (origin, action, from, to, kind) => {
        const src = origin.sourceEntity;
        const dimId = src?.dimension?.id ?? "minecraft:overworld";
        const a = String(action ?? "").toLowerCase();
        const fl = (l) => [Math.floor(l.x), Math.floor(l.y), Math.floor(l.z)];
        if (a === "list") return ok(zones.length ? zones.map(zoneText).join("\n") : "No safezones.");
        if (a === "add") {
            if (!from || !to) return fail("Usage: /zc:safezone add <x y z> <x y z> <pvp|build|both>");
            const k = String(kind ?? "both").toLowerCase();
            if (!["pvp", "build", "both"].includes(k)) return fail("The kind is pvp, build or both.");
            const z = { d: dimId, a: fl(from), b: fl(to), pvp: k !== "build", build: k !== "pvp" };
            system.run(() => { zones.push(z); saveZones(); });
            return ok(`Safezone added: ${zoneText(z, zones.length)}.`);
        }
        if (a === "remove") {
            const at = from ?? src?.location;
            if (!at) return fail("Usage: /zc:safezone remove <x y z>");
            const j = zones.findIndex((z) => z.d === dimId &&
                at.x >= Math.min(z.a[0], z.b[0]) && at.x < Math.max(z.a[0], z.b[0]) + 1 &&
                at.y >= Math.min(z.a[1], z.b[1]) && at.y < Math.max(z.a[1], z.b[1]) + 1 &&
                at.z >= Math.min(z.a[2], z.b[2]) && at.z < Math.max(z.a[2], z.b[2]) + 1);
            if (j < 0) return fail("No safezone there.");
            const text = zoneText(zones[j], j);
            system.run(() => { zones.splice(j, 1); saveZones(); });
            return ok(`Safezone removed: ${text}.`);
        }
        if (a === "show") {
            if (!isPlayer(src)) return fail("Players only.");
            const on = !src.hasTag(TAG_ZONE_VIEW);
            system.run(() => { try { if (on) src.addTag(TAG_ZONE_VIEW); else src.removeTag(TAG_ZONE_VIEW); } catch { } });
            return ok(`Safezone outlines ${on ? "shown" : "hidden"}.`);
        }
        return fail("Use add, remove, list or show.");
    });

    reg.registerCommand({
        name: "zc:itemblacklist",
        description: "Item blacklist: add|remove <item>, or list",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        cheatsRequired: false,
        mandatoryParameters: [{ name: "action", type: CustomCommandParamType.String }],
        optionalParameters: [{ name: "item", type: CustomCommandParamType.ItemType }],
    }, (origin, action, item) => {
        const a = String(action ?? "").toLowerCase();
        if (a === "list") return ok(blacklist.length ? `Blacklisted items: ${blacklist.join(", ")}` : "The item blacklist is empty.");
        const id = item?.id;
        if (!id || (a !== "add" && a !== "remove")) return fail("Usage: /zc:itemblacklist add|remove <item>, or /zc:itemblacklist list");
        system.run(() => {
            if (a === "add" && !blacklist.includes(id)) blacklist.push(id);
            if (a === "remove") blacklist = blacklist.filter((x) => x !== id);
            saveBlacklist();
        });
        return ok(`${id} ${a === "add" ? "added to" : "removed from"} the item blacklist.`);
    });
});
