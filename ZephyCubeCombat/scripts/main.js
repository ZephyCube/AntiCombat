import "./style.js";
import {
    world, system, EquipmentSlot, PlayerPermissionLevel,
    CommandPermissionLevel, CustomCommandStatus
} from "@minecraft/server";
import { ModalFormData, FormCancelationReason } from "@minecraft/server-ui";

// ZephyCube Combat. Stable API only.
//  - Hitting or being hit by another player (damage that went through) puts both in combat for `seconds` seconds.
//  - In combat: elytras are taken off and cannot be put on (and fireworks cannot boost), unless `elytra` is off.
//  - Logging out in combat kills the player at once, unless `killLogout` is off.
//  - In combat the tag zc:combat_noclaim is set so AdminTools can keep the player out of claims (`claimBlock`).
//  - /zc:combat (operators) opens a menu to turn each part on or off. The settings are saved in the world.
// Exempt: staff (admin/moderator/mod tag or operator permission), duels and spectators of CrossBlades.

const SKEY = "wc:settings";
const PKEY = "wc:pending";           // players whose logout kill could not run: { name(lowercase): timestamp }
const TAG = "zc:combat";             // in combat (other packs can read it)
const TAG_CLAIM = "zc:combat_noclaim"; // in combat AND claim entry blocked (AdminTools reads this)
const PENDING_MAX_AGE = 60 * 60 * 1000;

const DEFAULTS = { combat: true, seconds: 20, elytra: true, killLogout: true, claimBlock: true, countdown: true };
let S = { ...DEFAULTS };
function loadSettings() {
    try {
        const raw = world.getDynamicProperty(SKEY);
        if (typeof raw === "string") {
            const o = JSON.parse(raw);
            for (const k of Object.keys(DEFAULTS)) if (typeof o[k] === typeof DEFAULTS[k]) S[k] = o[k];
        }
    } catch { }
    S.seconds = Math.max(5, Math.min(120, Math.floor(S.seconds) || DEFAULTS.seconds));
}
function saveSettings() { try { world.setDynamicProperty(SKEY, JSON.stringify(S)); } catch { } }
system.run(loadSettings);

const combat = new Map(); // player id -> end time (ms)

function isStaff(p) {
    try {
        if (p.hasTag("admin") || p.hasTag("moderator") || p.hasTag("mod")) return true;
        const lvl = p.playerPermissionLevel;
        return lvl !== undefined && lvl !== PlayerPermissionLevel.Member && lvl !== PlayerPermissionLevel.Visitor;
    } catch { return false; }
}
function exempt(p) {
    try { return p.hasTag("crossblades:dueling") || p.hasTag("crossblades:spectating") || isStaff(p); } catch { return true; }
}
function inCombat(p) {
    const e = combat.get(p.id);
    return e !== undefined && Date.now() < e;
}
function say(p, text) { try { p.sendMessage(text); } catch { } }

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
function tagCombat(p) {
    if (!S.combat || exempt(p)) return;
    const was = inCombat(p);
    combat.set(p.id, Date.now() + S.seconds * 1000);
    try { p.addTag(TAG); if (S.claimBlock) p.addTag(TAG_CLAIM); else p.removeTag(TAG_CLAIM); } catch { }
    if (!was) {
        const extra = [];
        if (S.elytra) extra.push("elytras are off");
        if (S.claimBlock) extra.push("you cannot enter claims");
        if (S.killLogout) extra.push("logging out kills you");
        say(p, `§cYou are in combat for ${S.seconds} seconds${extra.length ? ": " + extra.join(", ") : ""}.`);
    }
}

// ---------------------------------------------------------------------------
// hits start combat
// ---------------------------------------------------------------------------
world.afterEvents.entityHurt.subscribe((ev) => {
    try {
        if (!S.combat) return;
        const v = ev.hurtEntity, a = ev.damageSource?.damagingEntity;
        if (v?.typeId !== "minecraft:player" || a?.typeId !== "minecraft:player" || v.id === a.id) return;
        if (v.hasTag("crossblades:dueling") && a.hasTag("crossblades:dueling")) return;
        if (isStaff(a)) return;
        tagCombat(v);
        tagCombat(a);
    } catch { }
});

world.afterEvents.entityDie.subscribe((ev) => {
    try { if (ev.deadEntity?.typeId === "minecraft:player") { combat.delete(ev.deadEntity.id); clearTags(ev.deadEntity); } } catch { }
});

// ---------------------------------------------------------------------------
// elytra lock
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
        if (!S.combat || !S.elytra || p?.typeId !== "minecraft:player" || !inCombat(p)) return;
        const id = ev.itemStack?.typeId;
        if (isElytra(ev.itemStack) || (id === "minecraft:firework_rocket" && p.isGliding)) {
            ev.cancel = true;
            system.run(() => say(p, "§cYou cannot use elytras in combat."));
        }
    } catch { }
});

// ---------------------------------------------------------------------------
// tick: countdown, expiry, elytra lock
// ---------------------------------------------------------------------------
system.runInterval(() => {
    if (combat.size === 0) return;
    const now = Date.now();
    for (const p of world.getAllPlayers()) {
        try {
            const e = combat.get(p.id);
            if (e === undefined) continue;
            if (!S.combat || exempt(p)) { endCombat(p, false); continue; }
            if (now >= e) { endCombat(p, true); continue; }
            if (S.elytra) takeOffElytra(p);
            if (!S.claimBlock && p.hasTag(TAG_CLAIM)) p.removeTag(TAG_CLAIM);
            if (S.claimBlock && !p.hasTag(TAG_CLAIM)) p.addTag(TAG_CLAIM);
            if (S.countdown && system.currentTick % 10 === 0) p.onScreenDisplay.setActionBar(`§cCombat: ${Math.ceil((e - now) / 1000)}s`);
        } catch { }
    }
}, 2);

// ---------------------------------------------------------------------------
// logout in combat
// ---------------------------------------------------------------------------
function readPending() {
    try { const o = JSON.parse(world.getDynamicProperty(PKEY) ?? "{}"); return o && typeof o === "object" ? o : {}; } catch { return {}; }
}
function writePending(o) { try { world.setDynamicProperty(PKEY, Object.keys(o).length ? JSON.stringify(o) : undefined); } catch { } }

world.beforeEvents.playerLeave.subscribe(({ player }) => {
    try {
        if (!S.combat || !S.killLogout || !inCombat(player) || exempt(player)) { combat.delete(player.id); return; }
        const name = player.name;
        combat.delete(player.id);
        system.run(() => {
            let killed = false;
            try { if (player.isValid) { player.kill(); killed = true; } } catch { }
            if (!killed) { // the player is already gone: do it the moment they join again
                const o = readPending();
                o[name.toLowerCase()] = Date.now();
                writePending(o);
            }
            try { world.sendMessage(`§c${name} logged out in combat and was killed.`); } catch { }
        });
    } catch { }
});
world.afterEvents.playerLeave.subscribe((ev) => { combat.delete(ev.playerId); warned.delete(ev.playerId); });

world.afterEvents.playerSpawn.subscribe((ev) => {
    if (!ev.initialSpawn) return;
    const p = ev.player;
    system.runTimeout(() => {
        try {
            if (!p.isValid) return;
            combat.delete(p.id);
            clearTags(p); // a tag left from before the logout
            const o = readPending();
            const k = p.name.toLowerCase();
            const t = o[k];
            if (t === undefined) return;
            delete o[k];
            writePending(o);
            if (S.killLogout && Date.now() - t < PENDING_MAX_AGE) {
                say(p, "§cYou logged out in combat.");
                p.kill();
            }
        } catch { }
    }, 20);
});

// ---------------------------------------------------------------------------
// /zc:combat menu
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
async function openMenu(player) {
    const f = new ModalFormData()
        .title("Combat")
        .toggle("Combat timer", { defaultValue: S.combat, tooltip: "Master switch. Off = nobody gets combat tagged and nothing below applies" })
        .slider("Combat length (seconds)", 5, 120, { valueStep: 5, defaultValue: S.seconds, tooltip: "Every hit restarts it" })
        .toggle("Disable elytra in combat", { defaultValue: S.elytra, tooltip: "Takes elytras off and blocks putting them on or boosting with fireworks" })
        .toggle("Kill on disconnect in combat", { defaultValue: S.killLogout, tooltip: "A player who logs out while in combat dies" })
        .toggle("Block entering claims in combat", { defaultValue: S.claimBlock, tooltip: "Needs AdminTools, which reads the tag zc:combat_noclaim" })
        .toggle("Show countdown on the action bar", { defaultValue: S.countdown });
    const r = await showForm(player, f);
    if (!r || r.canceled) return;
    const v = r.formValues;
    S.combat = v[0] === true;
    S.seconds = Math.max(5, Math.min(120, Math.floor(Number(v[1])) || DEFAULTS.seconds));
    S.elytra = v[2] === true;
    S.killLogout = v[3] === true;
    S.claimBlock = v[4] === true;
    S.countdown = v[5] === true;
    saveSettings();
    if (!S.combat) for (const p of world.getAllPlayers()) if (combat.has(p.id)) endCombat(p, false);
    say(player, `Combat settings saved: timer ${S.combat ? "§aon" : "§coff"}§f (${S.seconds}s), elytra lock ${S.elytra ? "§aon" : "§coff"}§f, logout kill ${S.killLogout ? "§aon" : "§coff"}§f, claim block ${S.claimBlock ? "§aon" : "§coff"}§f.`);
}

system.beforeEvents.startup.subscribe((init) => {
    init.customCommandRegistry.registerCommand({
        name: "zc:combat",
        description: "Combat settings menu: combat timer, elytra lock, kill on disconnect",
        permissionLevel: CommandPermissionLevel.GameDirectors,
        cheatsRequired: false,
    }, (origin) => {
        const src = origin.sourceEntity;
        if (src?.typeId === "minecraft:player") {
            system.run(() => { openMenu(src).catch(() => { }); });
            return { status: CustomCommandStatus.Success, message: "Close the chat to open the combat menu." };
        }
        return {
            status: CustomCommandStatus.Success,
            message: `Combat: timer ${S.combat ? "on" : "off"} (${S.seconds}s), elytra lock ${S.elytra ? "on" : "off"}, logout kill ${S.killLogout ? "on" : "off"}, claim block ${S.claimBlock ? "on" : "off"}, countdown ${S.countdown ? "on" : "off"}`,
        };
    });
});
