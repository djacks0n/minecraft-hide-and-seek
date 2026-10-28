// Hide and Seek add-on: Jet Lag style hide and seek for Minecraft Bedrock.
// Everything runs through the Hide and Seek Book item.
import { world, system, ItemStack } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { CH_NORMAL, CH_HARD, TIMES, POWERS, CURSES, Q, CATS } from "./data.js";

const BOOK_ID = "hs:game_book";
const KEY = "hs:state";

// ---------- Wheels ----------
const CHAL = [
  ...CH_NORMAL.map((t) => ({ k: "normal", t })),
  ...CH_HARD.map((t) => ({ k: "hard", t })),
];
const CURSE = [
  ...TIMES.flatMap(([s, n]) => Array.from({ length: n }, () => ({ k: "time", s }))),
  ...POWERS.map(([t, d, dur]) => ({ k: "power", t, d, dur })),
  ...CURSES.map(([t, d, dur]) => ({ k: "curse", t, d, dur })),
];

// ---------- Helpers ----------
const rand = (n) => Math.floor(Math.random() * n);
const pick = (a) => a[rand(a.length)];
const uid = () => Math.random().toString(36).slice(2, 9);
const sleep = (ticks) => new Promise((r) => system.runTimeout(r, ticks));

function mmss(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
// "[C&F] Cook a thing" -> gray tag + text
function fmt(t) {
  const m = /^\[(.+?)\]\s*/.exec(t || "");
  return m ? `§8[${m[1]}]§r ` + t.slice(m[0].length) : String(t || "");
}
function plain(t) {
  return String(t || "").replace(/^\[(.+?)\]\s*/, "");
}

// ---------- State ----------
function fresh(keep) {
  return Object.assign(
    {
      v: 1,
      round: 1,
      phase: "setup", // setup | hiding | seeking | found
      hider: null,
      coin: null,
      roll: null,
      hideMin: null,
      startAt: null,
      foundAt: null,
      bonus: 0,
      credits: { n: 0, h: 0 },
      chal: null,
      pending: null,
      hand: [],
      active: [],
      asked: {},
      history: [],
      settings: { blind: true, hideCoords: true },
    },
    keep || {}
  );
}

let state = null;
function S() {
  if (!state) {
    try {
      const raw = world.getDynamicProperty(KEY);
      state = typeof raw === "string" ? JSON.parse(raw) : fresh();
    } catch (e) {
      state = fresh();
    }
    if (!state.settings) state.settings = { blind: true, hideCoords: true };
  }
  return state;
}
function save() {
  try {
    world.setDynamicProperty(KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("[Hide and Seek] Could not save: " + e);
  }
}
function commit(fn) {
  fn(S());
  save();
}

const seekAt = (s) => s.startAt + (s.hideMin || 0) * 60000;
const players = () => world.getAllPlayers();
const isHider = (s, p) => s.hider === p.name;
const seekers = (s) => players().filter((p) => p.name !== s.hider);
const hiderPlayer = (s) => players().find((p) => p.name === s.hider);

// ---------- Messages ----------
function say(msg) {
  world.sendMessage("§6[Hide and Seek]§r " + msg);
}
function title(targets, big, small, stay = 60) {
  for (const p of targets) {
    try {
      p.onScreenDisplay.setTitle(big, { fadeInDuration: 0, stayDuration: stay, fadeOutDuration: 10, subtitle: small || "" });
    } catch (e) {}
  }
}
function sound(targets, id, pitch = 1) {
  for (const p of targets) {
    try {
      p.playSound(id, { volume: 1, pitch });
    } catch (e) {}
  }
}

// ---------- Forms ----------
async function show(form, player) {
  for (let i = 0; i < 40; i++) {
    let r;
    try {
      r = await form.show(player);
    } catch (e) {
      return { canceled: true };
    }
    if (r.canceled && r.cancelationReason === "UserBusy") {
      await sleep(5);
      continue;
    }
    return r;
  }
  return { canceled: true };
}

// Builds an ActionForm from [label, fn] pairs and runs the chosen one.
async function menu(player, heading, body, items) {
  const f = new ActionFormData().title(heading).body(body);
  const live = items.filter(Boolean);
  for (const [label] of live) f.button(label);
  const r = await show(f, player);
  if (r.canceled || r.selection === undefined) return;
  const chosen = live[r.selection];
  if (chosen && chosen[1]) await chosen[1]();
}

async function confirm(player, heading, body, yes = "Yes", no = "Back") {
  const f = new ActionFormData().title(heading).body(body).button(yes).button(no);
  const r = await show(f, player);
  return !r.canceled && r.selection === 0;
}

function statusText(s) {
  const now = Date.now();
  const lines = [`§lRound ${s.round}§r   Phase: §e${s.phase}§r`];
  if (s.hider) lines.push(`Hider: §d${s.hider}§r   Seeker: §a${seekers(s).map((p) => p.name).join(", ") || "-"}§r`);
  if (s.phase === "hiding") lines.push(`Hiding time left: §6${mmss((seekAt(s) - now) / 1000)}§r`);
  if (s.phase === "seeking") {
    const seek = (now - seekAt(s)) / 1000;
    lines.push(`Seeking: §a${mmss(seek)}§r   Bonus: §6+${mmss(s.bonus)}§r   Score: §e${mmss(seek + s.bonus)}§r`);
  }
  if (s.phase === "seeking" || s.phase === "hiding")
    lines.push(`Question credits: §a${s.credits.n} normal§r, §c${s.credits.h} hard§r`);
  return lines.join("\n");
}

// ---------- Spin animation ----------
let spinning = false;
async function spinAnim(pool, frameText, final, heading) {
  spinning = true;
  const all = players();
  const frames = 16;
  for (let i = 0; i < frames; i++) {
    const it = pick(pool);
    title(all, heading, frameText(it), 8);
    sound(all, "random.click", 0.8 + i * 0.05);
    await sleep(i < 10 ? 2 : i < 14 ? 3 : 5);
  }
  title(all, heading, frameText(final), 80);
  sound(all, "random.levelup", 1.2);
  spinning = false;
}

// ---------- Main menu ----------
async function openMenu(player) {
  const s = S();
  const ph = s.phase;
  const body = statusText(s);

  if (ph === "setup") {
    const n = players().length;
    return menu(player, "Hide and Seek", body + "\n\n§7Set up the round, then start it.", [
      s.coin === "swap"
        ? null
        : [n === 2 ? "Flip a coin for hider" : "Pick a random hider", () => flipCoin()],
      ["Choose the hider", () => chooseHider(player)],
      [s.hideMin ? `Reroll hiding time (now ${s.hideMin} min)` : "Roll hiding time (d10 + 5)", () => rollTime()],
      s.hider && s.hideMin ? [`§2Start round ${s.round}`, () => startRound()] : null,
      ["Scores", () => scores(player)],
      ["How to play", () => howTo(player)],
      ["Settings", () => settings(player)],
    ]);
  }

  if (ph === "found") {
    return menu(player, "Hide and Seek", body + "\n\n§7Round over.", [
      ["§2Next round (swap roles)", () => nextRound()],
      ["Scores", () => scores(player)],
      ["Settings", () => settings(player)],
    ]);
  }

  // hiding or seeking
  if (isHider(s, player)) return hiderMenu(player);
  return seekerMenu(player);
}

// ---------- Setup ----------
function flipCoin() {
  const list = players().map((p) => p.name).sort();
  if (!list.length) return;
  commit((s) => {
    if (list.length === 2) {
      const heads = Math.random() < 0.5;
      s.coin = heads ? "heads" : "tails";
      s.hider = heads ? list[0] : list[1];
      say(`Coin flip: §e${s.coin}§r. §d${s.hider}§r hides. (Heads = ${list[0]}, tails = ${list[1]})`);
    } else {
      s.coin = "random";
      s.hider = pick(list);
      say(`Random pick: §d${s.hider}§r hides.`);
    }
  });
  title(players(), "§dHIDER", S().hider, 60);
  sound(players(), "random.orb");
}

async function chooseHider(player) {
  const list = players().map((p) => p.name).sort();
  const s = S();
  const f = new ModalFormData()
    .title("Choose the hider")
    .dropdown("Who hides this round?", list, { defaultValueIndex: Math.max(0, list.indexOf(s.hider)) });
  const r = await show(f, player);
  if (r.canceled || !r.formValues) return;
  const name = list[r.formValues[0]];
  commit((st) => {
    st.hider = name;
    st.coin = st.coin || "picked";
  });
  say(`§d${name}§r is the hider.`);
}

function rollTime() {
  const d = 1 + rand(10);
  commit((s) => {
    s.roll = d;
    s.hideMin = d + 5;
  });
  title(players(), `§6${d} + 5`, `${d + 5} minutes to hide`, 60);
  sound(players(), "random.orb");
  say(`Rolled a §e${d}§r on the d10. Hiding time is §e${d + 5} minutes§r.`);
}

function startRound() {
  const s = S();
  if (!s.hider || !s.hideMin) return;
  commit((st) => {
    st.phase = "hiding";
    st.startAt = Date.now();
    st.foundAt = null;
  });
  if (s.settings.hideCoords) {
    try {
      const before = world.gameRules.showCoordinates;
      world.gameRules.showCoordinates = false;
      commit((st) => (st.coordsBefore = before));
    } catch (e) {}
  }
  const h = hiderPlayer(s);
  if (h) title([h], "§dGO HIDE!", `You have ${s.hideMin} minutes`, 80);
  title(seekers(s), "§cWAIT", `${s.hider} is hiding for ${s.hideMin} minutes`, 80);
  sound(players(), "mob.wither.spawn", 1.4);
  say(`Round ${s.round} started. §d${s.hider}§r has §e${s.hideMin} minutes§r to hide.`);
}

function nextRound() {
  const s = S();
  const list = players().map((p) => p.name).sort();
  let next = s.hider;
  if (list.length === 2) next = list.find((n) => n !== s.hider) || s.hider;
  else if (list.length > 2) {
    const i = list.indexOf(s.hider);
    next = list[(i + 1) % list.length];
  }
  commit((st) => {
    const keep = { round: st.round + 1, history: st.history, settings: st.settings, hider: next, coin: "swap" };
    state = fresh(keep);
  });
  say(`Round ${S().round}: roles swapped. §d${next}§r hides. Roll the hiding time and start.`);
}

// ---------- Seeker ----------
async function seekerMenu(player) {
  const s = S();
  const live = s.phase === "seeking";
  const ch = s.chal;
  const timed = s.active.filter((a) => a.mode === "timed").length;
  const items = [];
  if (!live) {
    items.push(["§7Wait for hiding time to end", () => {}]);
  } else {
    if (ch && ch.status === "pending") items.push([`Current challenge: ${ch.k === "hard" ? "§cHARD§r" : "§anormal§r"}`, () => challengeCard(player)]);
    else items.push(["§2Spin the challenge wheel", () => spinChallenge(player)]);
    items.push([`Ask a question (${s.credits.n}N / ${s.credits.h}H)`, () => askMenu(player)]);
  }
  items.push([`Curses on you (${s.active.length})`, () => activeMenu(player)]);
  if (live) items.push(["§bI found the hider!", () => found(player)]);
  items.push(["Scores", () => scores(player)]);
  items.push(["Settings", () => settings(player)]);
  const extra = s.pending ? `\n\n§eWaiting on the hider to answer #${Q.find((q) => q.id === s.pending.qid)?.n} and spin.` : "";
  return menu(player, "Seeker", statusText(s) + (timed ? `\n§d${timed} timed curse(s) running§r` : "") + extra, items);
}

async function spinChallenge(player) {
  const s = S();
  if (spinning) return player.sendMessage("§cA wheel is already spinning.");
  if (s.phase !== "seeking") return;
  if (s.chal && s.chal.status === "pending") return challengeCard(player);
  const it = pick(CHAL);
  await spinAnim(CHAL, (c) => fmt(c.t), it, it.k === "hard" ? "§cHARD CHALLENGE" : "§aCHALLENGE");
  commit((st) => {
    st.chal = { k: it.k, t: it.t, status: "pending" };
  });
  say(`${player.name}'s ${it.k === "hard" ? "§chard challenge§r" : "§achallenge§r"}: ${fmt(it.t)}`);
  return challengeCard(player);
}

async function challengeCard(player) {
  const s = S();
  const ch = s.chal;
  if (!ch || ch.status !== "pending") return;
  return menu(
    player,
    ch.k === "hard" ? "Hard challenge" : "Challenge",
    `${fmt(ch.t)}\n\n§7Finish it for a ${ch.k} question credit, or skip it and the hider gets +5:00.`,
    [
      [`§2Done (+1 ${ch.k} credit)`, () => challengeDone()],
      ["§cSkip (+5:00 for the hider)", () => challengeSkip(player)],
      ["Not yet", null],
    ]
  );
}

function challengeDone() {
  const s = S();
  if (!s.chal || s.chal.status !== "pending") return;
  const k = s.chal.k;
  commit((st) => {
    st.chal.status = "done";
    if (k === "hard") st.credits.h++;
    else st.credits.n++;
  });
  say(`Challenge done. Seeker gets +1 ${k === "hard" ? "§chard§r" : "§anormal§r"} question credit.`);
  sound(players(), "random.orb");
}

async function challengeSkip(player) {
  if (!(await confirm(player, "Skip challenge?", "The hider gets +5 minutes.", "Skip it"))) return;
  const s = S();
  if (!s.chal || s.chal.status !== "pending") return;
  commit((st) => {
    st.chal.status = "skipped";
    st.bonus += 300;
  });
  say("Challenge skipped. Hider gets §6+5:00§r.");
}

async function askMenu(player) {
  const s = S();
  if (s.pending) return player.sendMessage("§eWait for the hider to answer and spin the curse wheel first.");
  if (s.credits.n + s.credits.h <= 0) return player.sendMessage("§cYou need a question credit. Finish a challenge first.");
  const cats = CATS.filter(([k]) => k !== "all");
  const f = new ActionFormData()
    .title("Ask a question")
    .body(`Credits: §a${s.credits.n} normal§r, §c${s.credits.h} hard§r\n§7Normal questions use a normal credit first. Hard questions need a hard credit.`);
  for (const [k, label] of cats) {
    const n = Q.filter((q) => q.cat === k).length;
    f.button(`${k === "hard" ? "§c" : ""}${label}§r (${n})`);
  }
  const r = await show(f, player);
  if (r.canceled || r.selection === undefined) return;
  const [cat, label] = cats[r.selection];
  const list = Q.filter((q) => q.cat === cat);
  const f2 = new ActionFormData().title(label).body(cat === "hard" ? "§cUses a hard credit." : "Uses a normal credit (or a hard one if you're out).");
  for (const q of list) f2.button(`#${q.n} ${fmt(q.t)}${s.asked[q.id] ? " §7(asked)" : ""}`);
  const r2 = await show(f2, player);
  if (r2.canceled || r2.selection === undefined) return;
  const q = list[r2.selection];
  const hard = q.cat === "hard";
  if (hard && s.credits.h <= 0) return player.sendMessage("§cThat's a hard question. You need a hard credit.");
  if (!(await confirm(player, "Ask this?", `#${q.n} ${fmt(q.t)}`, "Ask it"))) return;
  const st = S();
  if (st.pending) return;
  commit((x) => {
    if (hard) x.credits.h--;
    else if (x.credits.n > 0) x.credits.n--;
    else x.credits.h--;
    x.asked[q.id] = (x.asked[q.id] || 0) + 1;
    x.pending = { qid: q.id, by: player.name };
  });
  say(`§a${player.name}§r asks §e#${q.n}§r: ${fmt(q.t)}`);
  const h = hiderPlayer(st);
  if (h) {
    title([h], "§eQUESTION", plain(q.t), 100);
    sound([h], "note.pling", 1.2);
    h.sendMessage("§eAnswer it, then open your book and spin the curse wheel.");
  }
}

// ---------- Hider ----------
async function hiderMenu(player) {
  const s = S();
  const pq = s.pending && Q.find((q) => q.id === s.pending.qid);
  const items = [];
  if (pq) items.push([`§6Answered #${pq.n}: spin the curse wheel`, () => spinCurse(player, false)]);
  items.push([`Powerups (${s.hand.length})`, () => handMenu(player)]);
  items.push([`Curses on the seeker (${s.active.length})`, () => activeMenu(player)]);
  items.push(["Extra spin (only for Reroll)", () => spinCurse(player, true)]);
  if (s.phase === "seeking") items.push(["§bI got found", () => found(player)]);
  items.push(["Scores", () => scores(player)]);
  items.push(["Settings", () => settings(player)]);
  const body = statusText(s) + (pq ? `\n\n§eThe seeker asked:§r\n#${pq.n} ${fmt(pq.t)}` : "\n\n§7No question waiting.");
  return menu(player, "Hider", body, items);
}

function curseLabel(c) {
  if (c.k === "time") return `§6+${mmss(c.s)} for the hider`;
  if (c.k === "power") return `§bPowerup: ${c.t}`;
  return `§d${fmt(c.t)}`;
}

async function spinCurse(player, extra) {
  const s = S();
  if (spinning) return player.sendMessage("§cA wheel is already spinning.");
  if (s.phase === "found" || s.phase === "setup") return;
  if (extra && !(await confirm(player, "Extra spin?", "Only use this when you play the Reroll powerup.", "Spin"))) return;
  const it = pick(CURSE);
  await spinAnim(CURSE, curseLabel, it, "§5CURSE WHEEL");
  const now = Date.now();
  commit((st) => {
    st.pending = null;
    if (it.k === "time") st.bonus += it.s;
    else if (it.k === "power") st.hand.push({ id: uid(), t: it.t, d: it.d, dur: it.dur });
    else {
      const timed = typeof it.dur === "number";
      st.active.push({ id: uid(), kind: "curse", t: it.t, d: it.d, mode: timed ? "timed" : it.dur, secs: timed ? it.dur : null, endsAt: timed ? now + it.dur * 1000 : null });
    }
  });
  const st = S();
  if (it.k === "time") {
    say(`Curse wheel: §6+${mmss(it.s)}§r for the hider.`);
  } else if (it.k === "power") {
    say(`Curse wheel: the hider got a §bpowerup§r.`);
    player.sendMessage(`§bNew powerup: ${it.t}§r. ${it.d}`);
  } else {
    const how = typeof it.dur === "number" ? `Lasts ${mmss(it.dur)}.` : it.dur === "round" ? "Lasts the rest of the round." : "Do it before the next question.";
    say(`§d${fmt(it.t)}§r on the seeker: ${it.d} ${how}`);
    for (const p of seekers(st)) {
      p.sendMessage(`§dYou're cursed: ${fmt(it.t)}§r\n${it.d} ${how}`);
    }
    sound(seekers(st), "mob.evocation_illager.prepare_attack", 1);
  }
  // Show the hider the full result
  const body =
    it.k === "time"
      ? `+${mmss(it.s)} added to your score.`
      : it.k === "power"
      ? `§b${it.t}§r\n${it.d}\n\n§7It's in your hand. Play it any time from Powerups.`
      : `§d${fmt(it.t)}§r\n${it.d}`;
  await menu(player, "Curse wheel result", body, [["OK", null]]);
}

async function handMenu(player) {
  const s = S();
  if (!s.hand.length) return menu(player, "Powerups", "No powerups yet. You get them from the curse wheel.", [["OK", null]]);
  const f = new ActionFormData().title("Powerups").body("Pick one to play it.");
  for (const p of s.hand) f.button(`§b${p.t}§r\n§8${p.d.slice(0, 60)}${p.d.length > 60 ? "..." : ""}`);
  const r = await show(f, player);
  if (r.canceled || r.selection === undefined) return;
  const p = s.hand[r.selection];
  if (!p) return;
  if (!(await confirm(player, p.t, `${p.d}\n\nPlay it now?`, "Play it"))) return;
  commit((st) => {
    st.hand = st.hand.filter((x) => x.id !== p.id);
    if (p.dur) st.active.push({ id: uid(), kind: "power", t: p.t, d: p.d, mode: "timed", secs: p.dur, endsAt: Date.now() + p.dur * 1000 });
  });
  say(`Hider played §b${p.t}§r: ${p.d}`);
  title(seekers(S()), `§b${p.t}`, p.d.length < 60 ? p.d : "Check chat", 80);
  sound(players(), "random.totem", 1.5);
}

// ---------- Active curses and effects ----------
async function activeMenu(player) {
  const s = S();
  const now = Date.now();
  if (!s.active.length) return menu(player, "Curses", "Nothing is running on the seeker.", [["OK", null]]);
  const f = new ActionFormData().title("Curses on the seeker").body("Pick one to clear it when it's done.");
  for (const a of s.active) {
    const tm = a.mode === "timed" ? mmss((a.endsAt - now) / 1000) + " left" : a.mode === "round" ? "whole round" : "task";
    f.button(`${a.kind === "power" ? "§b" : "§d"}${fmt(a.t)}§r §7(${tm})§r\n§8${a.d.slice(0, 60)}${a.d.length > 60 ? "..." : ""}`);
  }
  const r = await show(f, player);
  if (r.canceled || r.selection === undefined) return;
  const a = s.active[r.selection];
  if (!a) return;
  const ok = await confirm(player, plain(a.t), `${a.d}\n\nMark it ${a.mode === "task" ? "done" : "cleared"}?`, a.mode === "task" ? "Done" : "Clear it");
  if (!ok) return;
  commit((st) => {
    st.active = st.active.filter((x) => x.id !== a.id);
  });
  say(`${fmt(a.t)} ${a.mode === "task" ? "done" : "cleared"}.`);
}

// ---------- Found and scores ----------
async function found(player) {
  const s = S();
  if (s.phase !== "seeking") return;
  if (!(await confirm(player, "Found?", `End round ${s.round}? This stops the clock.`, "Yes, found"))) return;
  const now = Date.now();
  const seek = Math.max(0, (now - seekAt(S())) / 1000);
  commit((st) => {
    st.foundAt = now;
    st.phase = "found";
    const score = Math.round(seek + st.bonus);
    st.history.push({ round: st.round, hider: st.hider, seek: Math.round(seek), bonus: st.bonus, score });
  });
  const st = S();
  const h = st.history[st.history.length - 1];
  title(players(), "§bFOUND!", `${h.hider}'s score: ${mmss(h.score)}`, 100);
  sound(players(), "random.levelup", 0.8);
  say(`§d${h.hider}§r was found! Score §e${mmss(h.score)}§r (${mmss(h.seek)} seeking + ${mmss(h.bonus)} bonus).`);
  restoreCoords();
}

function restoreCoords() {
  const s = S();
  if (typeof s.coordsBefore !== "boolean") return;
  try {
    world.gameRules.showCoordinates = s.coordsBefore;
  } catch (e) {}
  commit((st) => delete st.coordsBefore);
}

async function scores(player) {
  const s = S();
  if (!s.history.length) return menu(player, "Scores", "No rounds finished yet.\n\nLongest hide (seeking time plus bonuses) wins.", [["OK", null]]);
  const best = {};
  for (const h of s.history) best[h.hider] = Math.max(best[h.hider] || 0, h.score);
  const rows = s.history.map((h) => `Round ${h.round}: §d${h.hider}§r  ${mmss(h.score)} §7(${mmss(h.seek)} + ${mmss(h.bonus)} bonus)§r`);
  const leader = Object.entries(best).sort((a, b) => b[1] - a[1]);
  const body = "§lBest hides§r\n" + leader.map(([n, sc]) => `${n}: §e${mmss(sc)}§r`).join("\n") + "\n\n§lRounds§r\n" + rows.join("\n");
  return menu(player, "Scores", body, [["OK", null]]);
}

// ---------- Settings ----------
async function settings(player) {
  const s = S();
  return menu(player, "Settings", statusText(s), [
    ["Game options", () => options(player)],
    s.phase === "hiding" || s.phase === "seeking" ? ["House fixes (credits and bonus)", () => fixes(player)] : null,
    ["Give everyone a book", () => giveAll()],
    s.phase === "hiding" || s.phase === "seeking" ? ["§cCancel this round", () => cancelRound(player)] : null,
    ["§cReset the whole game", () => resetAll(player)],
  ]);
}

async function options(player) {
  const s = S();
  const f = new ModalFormData()
    .title("Game options")
    .toggle("Blind and slow the seeker during hiding time", { defaultValue: !!s.settings.blind })
    .toggle("Hide coordinates during rounds", { defaultValue: !!s.settings.hideCoords });
  const r = await show(f, player);
  if (r.canceled || !r.formValues) return;
  commit((st) => {
    st.settings.blind = !!r.formValues[0];
    st.settings.hideCoords = !!r.formValues[1];
  });
  player.sendMessage("§aSaved.");
}

async function fixes(player) {
  const fix = (label, fn) => [label, () => { commit(fn); say(`House fix: ${label}.`); return fixes(player); }];
  return menu(player, "House fixes", statusText(S()) + "\n\n§7Use these for powerups and curses that change credits.", [
    fix("+1 normal credit", (s) => s.credits.n++),
    fix("-1 normal credit", (s) => (s.credits.n = Math.max(0, s.credits.n - 1))),
    fix("+1 hard credit", (s) => s.credits.h++),
    fix("-1 hard credit", (s) => (s.credits.h = Math.max(0, s.credits.h - 1))),
    fix("+0:30 hider bonus", (s) => (s.bonus += 30)),
    fix("-0:30 hider bonus", (s) => (s.bonus = Math.max(0, s.bonus - 30))),
    ["Back", null],
  ]);
}

async function cancelRound(player) {
  if (!(await confirm(player, "Cancel round?", "This round won't be scored. Roles stay the same.", "Cancel round"))) return;
  restoreCoords();
  commit((st) => {
    const keep = { round: st.round, history: st.history, settings: st.settings, hider: st.hider, coin: st.coin };
    state = fresh(keep);
  });
  say("Round canceled. Back to setup.");
}

async function resetAll(player) {
  if (!(await confirm(player, "Reset everything?", "This erases all scores and the current round.", "Reset"))) return;
  restoreCoords();
  const settingsKeep = S().settings;
  state = fresh({ settings: settingsKeep });
  save();
  say("Game reset.");
}

async function howTo(player) {
  const body = [
    "§l1. Setup§r  Flip a coin (or pick) for the hider, roll a d10 + 5 for hiding minutes, then start.",
    "§l2. Hide§r  The hider runs. The seeker waits (blind and slowed if that option is on).",
    "§l3. Seek§r  The seeker spins the challenge wheel. Finishing a challenge earns a question credit. Skipping gives the hider +5:00.",
    "§l4. Ask§r  Spend a credit on a question. Hard questions need a hard credit.",
    "§l5. Curse§r  The hider answers out loud or in chat, then spins the curse wheel: time bonus, a powerup for the hider, or a curse on the seeker.",
    "§l6. Found§r  Score = seeking time + bonuses. Swap roles. Longest hide wins.",
    "",
    "§7Lost your book? Open Settings and give everyone a book, or run /scriptevent hs:book (cheats on).",
  ].join("\n");
  return menu(player, "How to play", body, [["OK", null]]);
}

// ---------- Book ----------
function makeBook() {
  const b = new ItemStack(BOOK_ID, 1);
  try {
    b.keepOnDeath = true;
    b.setLore(["§7Use it to open the game menu"]);
  } catch (e) {}
  return b;
}
function hasBook(player) {
  try {
    const inv = player.getComponent("minecraft:inventory")?.container;
    if (!inv) return true;
    for (let i = 0; i < inv.size; i++) if (inv.getItem(i)?.typeId === BOOK_ID) return true;
    return false;
  } catch (e) {
    return true;
  }
}
function giveBook(player) {
  try {
    if (hasBook(player)) return false;
    const inv = player.getComponent("minecraft:inventory")?.container;
    const left = inv?.addItem(makeBook());
    if (left) player.dimension.spawnItem(left, player.location);
    return true;
  } catch (e) {
    return false;
  }
}
function giveAll() {
  let n = 0;
  for (const p of players()) if (giveBook(p)) n++;
  say(n ? `Gave ${n} player(s) a Hide and Seek Book.` : "Everyone already has a book.");
}

// ---------- Events ----------
const lastOpen = new Map();
function tryOpen(player) {
  const now = Date.now();
  if (now - (lastOpen.get(player.name) || 0) < 600) return;
  lastOpen.set(player.name, now);
  openMenu(player).catch((e) => console.warn("[Hide and Seek] Menu error: " + e));
}

world.afterEvents.itemUse.subscribe((ev) => {
  if (ev.itemStack?.typeId === BOOK_ID && ev.source?.typeId === "minecraft:player") tryOpen(ev.source);
});

world.afterEvents.playerSpawn.subscribe((ev) => {
  const p = ev.player;
  system.runTimeout(() => {
    if (!p.isValid) return;
    if (giveBook(p) && ev.initialSpawn) p.sendMessage("§6[Hide and Seek]§r Use the §eHide and Seek Book§r to play.");
  }, 40);
});

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const p = ev.sourceEntity;
  if (!p || p.typeId !== "minecraft:player") return;
  if (ev.id === "hs:menu") tryOpen(p);
  if (ev.id === "hs:book") {
    if (!giveBook(p)) p.sendMessage("You already have a Hide and Seek Book.");
  }
});

// ---------- Game loop ----------
let tick = 0;
const announced = new Set();
system.runInterval(() => {
  tick++;
  const s = S();
  const now = Date.now();

  // Hiding time ends
  if (s.phase === "hiding" && now >= seekAt(s)) {
    commit((st) => (st.phase = "seeking"));
    title(seekers(s), "§aSEEK!", "Spin the challenge wheel in your book", 80);
    const h = hiderPlayer(s);
    if (h) title([h], "§cTIME'S UP", "The seeker is coming", 80);
    sound(players(), "raid.horn", 1);
    say("Hiding time is over. §aThe seeker can go!§r");
    for (const p of seekers(s)) {
      try {
        p.removeEffect("minecraft:blindness");
        p.removeEffect("minecraft:slowness");
      } catch (e) {}
    }
  }

  // Keep the seeker blind and slow while the hider hides
  if (s.phase === "hiding" && s.settings.blind && tick % 4 === 0) {
    for (const p of seekers(s)) {
      try {
        p.addEffect("minecraft:blindness", 60, { amplifier: 0, showParticles: false });
        p.addEffect("minecraft:slowness", 60, { amplifier: 6, showParticles: false });
      } catch (e) {}
    }
  }

  // Timed curses and powerups running out
  const done = s.active.filter((a) => a.mode === "timed" && a.endsAt && now >= a.endsAt);
  if (done.length) {
    commit((st) => (st.active = st.active.filter((a) => !(a.mode === "timed" && a.endsAt && now >= a.endsAt))));
    for (const a of done) {
      if (announced.has(a.id)) continue;
      announced.add(a.id);
      say(`${fmt(a.t)} is over.`);
      sound(seekers(s), "random.orb", 1.4);
    }
  }

  // Action bar
  if (s.phase === "hiding" || s.phase === "seeking") {
    const left = (seekAt(s) - now) / 1000;
    const seek = (now - seekAt(s)) / 1000;
    const next = s.active.filter((a) => a.mode === "timed").sort((a, b) => a.endsAt - b.endsAt)[0];
    const curseBit = next ? `  §d${plain(next.t).replace(/^Curse of (the )?/, "")} ${mmss((next.endsAt - now) / 1000)}` : "";
    for (const p of players()) {
      let line;
      if (s.phase === "hiding") {
        line = isHider(s, p) ? `§dHide! §f${mmss(left)} left` : `§cWait §f${mmss(left)}  §7${s.hider} is hiding`;
      } else {
        const base = `§aSeeking §f${mmss(seek)}  §6+${mmss(s.bonus)}  §eScore ${mmss(seek + s.bonus)}`;
        line = isHider(s, p)
          ? base + (s.pending ? "  §e! Question waiting" : "") + curseBit
          : base + `  §a${s.credits.n}N §c${s.credits.h}H` + (s.chal && s.chal.status === "pending" ? "  §7Challenge open" : "") + curseBit;
      }
      try {
        p.onScreenDisplay.setActionBar(line);
      } catch (e) {}
    }
  }
}, 10);
