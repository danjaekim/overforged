# Overforged — Architecture Plan

This is the source of truth for how the game is built. Any agent or person adding code should read this first and keep it in sync: if an implementation deviates from it, update this file in the same commit.

---

## 1. Goals and constraints

| | |
|---|---|
| **Genre** | Survivors-style roguelike: move only, weapons auto-fire, enemy hordes, XP → level-up choices. **10-minute runs** (short sessions suit mobile; length is one constant, §5.8). |
| **Hook** | The **forge**: ore drops feed enhance / reforge / combine decisions that turn a run absurdly strong. |
| **Platform** | Web app. **Mobile-first, portrait-only** (iPhone Safari, Add to Home Screen). Desktop is playable with keyboard in the same portrait-shaped view, so balance is identical on both (§8). |
| **Tech** | Plain ES modules, Canvas 2D, **no build step, no runtime dependencies.** Served as static files (GitHub Pages). |
| **Performance floor** | 60 fps on iPhone 12-class hardware with the budgets in §7. |
| **Iteration** | Content (weapons, passives, enemies, waves) is **data**, not code. Adding a weapon that uses an existing behavior must not touch engine code. |
| **IP** | Inspired by the genre and by VR-MMO/blacksmith fantasy; all names, characters and art are original. |

Non-goals for the prototype: art pipeline, audio beyond simple procedural blips, online features, native packaging.

---

## 2. Directory layout

```
index.html
manifest.webmanifest           (M8) PWA metadata
docs/
  architecture.md              this file
src/
  main.js                      boot: create canvas, input, game; start loop
  core/
    loop.js                    fixed-timestep loop (60 Hz update, rAF render)
    rng.js                     seeded PRNG (mulberry32) + helpers (pick, weighted)
    pool.js                    generic object pool
    spatial-hash.js            uniform grid for broadphase queries
    events.js                  tiny synchronous event bus
    math.js                    vec helpers that write into out-params (no allocs)
  input/
    input.js                   joystick + keyboard → normalized move vector; ignores the HUD top zone
  stats/
    stats.js                   StatBlock: modifiers in, cached final values out
    stat-defs.js               every stat id, its base value, clamps, display info
    conditions.js              named predicates for conditional modifiers (§4.5)
  game/
    game.js                    top-level state machine (§6.1)
    run.js                     one run: owns world, player, director, timers
    world.js                   entity stores (pools), spatial hash, damage queue, scratch buffers
    player.js                  player entity, StatBlock, weapon and passive lists, xp/level
    weapons.js                 weapon instances: add, level up (as modifiers), per-tick update
    weapon-params.js          how a weapon's base params combine with stats: param(), weaponStat()
    projectiles.js             spawnProjectile + hit-set helpers
    director.js                spawn director: reads waves data, spawns enemies and forge shrines
    upgrades.js                level-up offer generation (§5.6); pure, no run access
    apply-offer.js             applies a chosen offer to the run; offerState(run) snapshot for upgrades.js
    xp.js                      xpToNext(level), gainXp(run, amount)
    passives.js                owned passives: add, level up (as modifiers, source passive:<id>:<lvl>)
    forge.js                   forge actions; pure functions over inventory (§6)
    evolutions.js              recipe checks
    triggers.js                trigger dispatch for on-hit/on-kill/etc. effects (§4.6)
  behaviors/                   weapon behaviors, one file each (§5.2)
    index.js                   registry: id → behavior
    projectile.js  orbit.js  aura.js  arc.js  chain.js  nova.js  summon.js
  effects/                     effect handlers used by triggers (§4.6)
    index.js
  systems/                     per-tick systems over entity stores
    movement.js  enemy-ai.js  collision.js  damage.js  damage-queue.js  pickups.js (xp gems)  status.js
  render/
    view.js                    portrait view: 480-unit width, desktop column, safe-area inset
    renderer.js                camera (with shake), layers, draw order
    entities.js                batched enemy and projectile drawing, culled to the camera
    fx.js                      pooled damage numbers and death puffs (hit flash is in entities.js)
    hud.js                     canvas HUD: hp, xp bar, timer, level, ore, off-screen shrine arrow
  ui/                          DOM overlays (menus are DOM, gameplay is canvas)
    overlay.js                 mount/unmount helper, safe-area aware
    rotate-prompt.js           "rotate to portrait" cover shown (and run paused) in landscape on touch devices
    levelup.js  pause.js  results.js  title.js   (built)   forge-ui.js  class-select.js   (planned)
  data/                        ALL tunable content lives here
    classes.js  weapons.js  passives.js  enemies.js  waves.js  rarities.js  progression.js   (built)
    titles.js  evolutions.js  forge.js  ores.js   (planned)
    validate.js                boot-time schema checks for everything above (§5)
  meta/
    save.js                    versioned localStorage persistence
    unlocks.js                 meta-progression rules
  debug/
    debug.js                   ?debug=1: fps/entity overlay, god mode, spawn/give
tests/
  run.mjs                      zero-dep test runner (node tests/run.mjs)
  stats.test.mjs  upgrades.test.mjs  forge.test.mjs  spatial-hash.test.mjs
```

Rules:
- `data/*` files export plain objects/arrays only. No imports from engine code, no functions except where §5 explicitly allows (none in the prototype).
- `stats/`, `game/upgrades.js`, `game/forge.js`, `game/evolutions.js`, and `core/*` are **pure** (no DOM, no canvas) so they run in Node tests.
- Modules talk via direct calls; the event bus is for loose coupling only (UI ← game, FX ← damage), never for core simulation order.

---

## 3. Runtime core

### 3.1 Loop
Fixed 60 Hz simulation (`STEP = 1/60`), accumulator with a 0.1 s clamp, render once per rAF. Simulation never reads wall-clock time; `run.time` advances only in `update`. This makes runs reproducible from a seed and lets pause/level-up/forge simply stop calling `update`.

On `visibilitychange → hidden`, auto-pause.

### 3.2 Entity storage
No general ECS. A few typed **stores**, each a fixed-capacity pool of plain objects with stable shape (all fields initialised in the factory so V8/JSC keep one hidden class):

| Store | Capacity (prototype) | Notes |
|---|---|---|
| `enemies` | 600 | hp, speed, radius, defId, status timers, hitFlash |
| `projectiles` | 800 | owner weapon instance, pierce left, ttl, hit-set |
| `pickups` | 600 | xp gems, ore, chests, heals; merge when over cap (§7) |
| `shrines` | 4 | forge shrines (§6.3); at most 1 active by default |
| `summons` | 50 | minions; share enemy-like AI pointed at enemies |
| `fx` | 400 | damage numbers, particles; pure visual, droppable |

Each store keeps an `active` dense array plus a free list. Removal is swap-remove (O(1)); never splice. Systems iterate the dense array backwards so removal during iteration is safe.

### 3.3 Update order (one tick)
1. `director.update` — spawn enemies and shrines per wave schedule
2. `player.update` — movement from input, regen, timers
3. `weapons.update` — each weapon instance ticks its behavior (fires/spawns projectiles, applies auras)
4. `enemyAI.update` — seek player, separation via spatial hash
5. `movement.update` — integrate projectiles, summons
6. `spatialHash.rebuild(enemies)`
7. `collision.update` — projectile↔enemy, enemy↔player, player↔pickup (magnet radius), player↔shrine (channel progress; opens the forge when full)
7d. `status.update` — status timers, slow, burn ticks (queued as DOT damage; runs before the flush so burn kills resolve this tick)
8. `damage.flush` — apply queued damage (target multipliers, lifesteal, status rolls, chains, triggers, deaths → drops)
10. `run.checkEvents` — level-up pending? forge pending? boss? win/lose?

Damage is **queued** during collision and applied in one place (`damage.flush`), so on-hit / on-kill triggers, damage numbers and kill counts are handled consistently and can't recurse unboundedly (triggered damage enqueues for the next flush, with a depth cap of 3).

---

## 4. Stat and modifier system

Everything that makes the player stronger — level-up passives, weapon levels, titles, forge enhancement, affixes, set bonuses, meta-unlocks — is expressed as **modifiers** applied to a **StatBlock**. Engine code only ever *reads* final stats. This is the single most important rule for iteration speed.

### 4.1 Stats
`stats/stat-defs.js` declares every stat once:

```js
export const STATS = {
  maxHp:        { base: 100, min: 1,               fmt: 'int' },
  moveSpeed:    { base: 150, min: 40,  max: 600,   fmt: 'int' },   // 200 made the horde trivial to outrun at M3
  pickupRadius: { base: 60,  min: 20,              fmt: 'int' },
  armor:        { base: 0,                         fmt: 'int' },   // flat damage reduction
  regen:        { base: 0,                         fmt: 'dec' },   // hp per second
  xpGain:       { base: 1,   min: 0,               fmt: 'pct' },
  oreGain:      { base: 1,   min: 0,               fmt: 'pct' },
  luck:         { base: 0,                         fmt: 'int' },   // offer rarity / forge success
  // offensive — usually read per weapon (§4.4)
  damage:       { base: 1,   min: 0,               fmt: 'pct' },   // multiplier on weapon base damage
  cooldown:     { base: 1,   min: 0.1,             fmt: 'pct' },   // multiplier; lower is faster
  area:         { base: 1,   min: 0.1,             fmt: 'pct' },
  projectiles:  { base: 0,   min: 0,               fmt: 'int' },   // additional projectiles
  pierce:       { base: 0,   min: 0,               fmt: 'int' },
  duration:     { base: 1,   min: 0.1,             fmt: 'pct' },
  projSpeed:    { base: 1,   min: 0.1,             fmt: 'pct' },
  critChance:   { base: 0.05, min: 0, max: 1,      fmt: 'pct' },
  critMult:     { base: 1.5, min: 1,               fmt: 'mult' },
  knockback:    { base: 1,   min: 0,               fmt: 'pct' },
  lifesteal:    { base: 0,   min: 0,               fmt: 'pct' },
  // add stats freely; unknown stat ids in data fail validation at boot
};
```

### 4.2 Modifier shape

```js
{
  stat: 'damage',          // a key of STATS
  op: 'inc',               // 'flat' | 'inc' | 'more' | 'set'
  value: 0.15,
  tags: ['fire'],          // optional: only applies to weapons with ALL these tags (§4.4)
  when: 'hpBelow50',       // optional: condition id (§4.5)
  source: 'passive:ember_core:3', // who added it; used for removal and tooltips
}
```

### 4.3 Calculation

```
final = clamp( ( base + Σflat ) × ( 1 + Σinc ) × Π(1 + more) )
```

- **flat** — additive to base (`+2 projectiles`, `+10 maxHp`).
- **inc** — "increased": all `inc` on a stat sum together (`+15%` and `+20%` → ×1.35). This is the common, diminishing-feeling bucket.
- **more** — each multiplies separately (`+50% more` and `+50% more` → ×2.25). Reserved for rare, exciting sources: evolutions, legendary affixes, high titles. This bucket is what produces "very powerful" late runs, so keep it scarce.
- **set** — overrides the final value (rare; e.g. a curse that sets `regen` to 0). Last `set` by insertion order wins; applied after clamp-free calc, then clamped.
- `cooldown` uses the same formula; negative `inc` values speed it up (`-10%` cooldown → `inc: -0.10`).

StatBlock API:

```js
const sb = new StatBlock(STATS);
sb.add(mod);                    // or addMany(mods)
sb.removeBySource(prefix);      // e.g. 'passive:ember_core' on level change
sb.get('maxHp');                // global final value, cached
sb.getFor('damage', tags);      // value including tag-scoped modifiers, cached per (stat, tags.key)
// `tags` comes from makeTags(['projectile', 'fire', 'weapon:3']) -> { set, key }, built once per
// weapon instance so hot paths never allocate. get(stat) = getFor(stat, NO_TAGS).
// Cache invalidation is per stat; a stat with any `when` modifier bypasses the cache entirely.
```

Caching: each `add/remove` marks the touched stat dirty; `get` recomputes only dirty stats. Tag-scoped reads cache by `stat + '|' + sortedTags`. Condition-gated modifiers are excluded from the cache and evaluated on read (they're few).

### 4.4 Scopes: global vs weapon
There is **one** player StatBlock. Weapons don't own separate blocks; instead a weapon instance reads `player.stats.getFor(stat, weapon.tags)` and multiplies by its own per-level base values. So:

- A passive with `{ stat:'damage', op:'inc', value:0.1 }` buffs everything.
- A passive with `tags:['projectile']` buffs only projectile weapons.
- Weapon-local upgrades (a weapon's own level-ups, forge enhancement, affixes) are added with `tags:['weapon:<instanceId>']`, and every weapon includes its own `weapon:<instanceId>` in its tag set when reading. This keeps a single code path for all stat math.

Effective weapon damage per hit:
```
hit = weapon.base.damage(level) × stats.getFor('damage', tags) × (crit ? stats.getFor('critMult', tags) : 1)
```

### 4.5 Conditions
`when` references a small registry of named predicates evaluated against run state:
`hpBelow50`, `hpFull`, `moving`, `standingStill`, `recentKill3s`, `bossAlive`. Add new ones in `stats/conditions.js`. Data never contains code.

### 4.6 Triggers and effects (non-stat upgrades)
Some upgrades aren't numbers (explode on kill, chain lightning on crit, shield every 10 s). These are **triggers** that call **effects**:

```js
triggers: [
  { on: 'kill', chance: 0.15, effect: 'explode', params: { radius: 60, damageFrac: 0.5 }, tags: ['fire'] },
  { on: 'interval', every: 10, effect: 'shield', params: { amount: 20 } },
]
```

- `on`: `hit | crit | kill | hurt | levelUp | interval | pickupOre | forge`.
- `effect`: id in `effects/index.js` registry; `params` are data.
- Optional `tags` restrict which weapon's hits fire it.
- Triggered damage is enqueued (§3.3) and carries `depth+1`; depth > 3 is dropped.

---

## 5. Data schemas

All content IDs are `snake_case`, unique per file. At boot, `data/validate.js` checks every schema (unknown stat ids, unknown behaviors/effects, missing levels, recipe references) and throws in debug mode / logs in production.

### 5.1 Weapon

```js
// data/weapons.js
export const WEAPONS = {
  ember_bow: {
    name: 'Ember Bow',
    class: 'archer',               // starting weapon for class; null = general pool
    rarity: 'common',              // affects offer weight (data/rarities.js)
    tags: ['projectile', 'ranged', 'fire'],
    behavior: 'projectile',        // behaviors/index.js key
    base: {                        // behavior-specific base params at level 1
      damage: 14, cooldown: 0.9, speed: 520, count: 1, pierce: 1,
      spread: 0.02, gap: 7, ttl: 1.2, radius: 5, range: 380,   // tight volley: small spread + sideways gap
    },
    maxLevel: 8,
    levels: [                      // index 0 = level 2, etc. Each is a list of modifiers
      [{ stat: 'damage', op: 'inc', value: 0.2 }],
      [{ stat: 'projectiles', op: 'flat', value: 1 }],
      [{ stat: 'pierce', op: 'flat', value: 1 }],
      [{ stat: 'cooldown', op: 'inc', value: -0.15 }],
      [{ stat: 'projectiles', op: 'flat', value: 1 }],
      [{ stat: 'damage', op: 'inc', value: 0.3 }],
      [{ stat: 'damage', op: 'more', value: 0.25 }],
    ],
    levelText: ['+20% damage', '+1 arrow', '+1 pierce', '-15% cooldown', '+1 arrow', '+30% damage', '25% more damage'],
    triggers: [],                  // optional, §4.6
    evolvesInto: 'storm_volley',   // optional; recipe lives in evolutions.js
  },
};
```

Level modifiers are auto-tagged `weapon:<instanceId>` when applied, so data authors never write instance tags.

### 5.2 Behaviors
A behavior is a small object of functions; all per-shot numbers come from `base` × stats:

```js
// behaviors/projectile.js
export default {
  init(inst, ctx) {},                     // allocate per-instance state (timers)
  update(inst, dt, ctx) {},               // tick cooldown; when ready, fire via ctx.spawnProjectile
  onProjectileHit(inst, proj, enemy, ctx) {}, // optional
};
```

**As built (M3):** there is no separate `ctx` object. Behaviors receive the `run` (which holds `world`, `player`, `rng`) and import helpers directly: `param(run, inst, key)` and `weaponStat(run, inst, id)` from `game/weapon-params.js`, `spawnProjectile` from `game/projectiles.js`, `queueDamage` from `systems/damage-queue.js`, and `run.world.hash.queryRadius / queryNearest` for targeting. Keep behaviors reading stats only through these helpers.

How `base` params combine with stats (one place: `ctx.param(inst, key)`, so behaviors never re-derive this):

| `base` key | Combined as | Stat |
|---|---|---|
| `damage` | `base × stat` | `damage` (multiplier) |
| `cooldown` | `base × stat` | `cooldown` (multiplier, lower = faster) |
| `count` | `base + stat` | `projectiles` (flat) |
| `pierce` | `base + stat` | `pierce` (flat) |
| `speed` | `base × stat` | `projSpeed` |
| `ttl` | `base × stat` | `duration` |
| `radius`, `range`, `arcWidth` | `base × stat` | `area` |

Keys not in this table (e.g. `spread`, `targeting`) are used as-is. Stats that don't apply to a behavior (e.g. `projectiles` on an `aura`) are simply ignored; offer generation should skip upgrades whose only stats are irrelevant to every owned weapon (`behaviors/<x>.uses = ['damage','cooldown','area', ...]`).

Prototype behaviors and the archetypes they serve:

| Behavior | Shape | Archetype examples |
|---|---|---|
| `projectile` | fires `count` shots at targets | Archer bow, Mage bolt |
| `arc` | melee sweep in facing/nearest direction | Berserker greatsword, Smith hammer |
| `orbit` | N bodies circling the player | Smith's orbiting anvils, Saint's wards |
| `aura` | damage/slow field around the player | Saint's halo, Mage frost field |
| `chain` | hit nearest, jump N times | Mage lightning |
| `nova` | periodic radial burst | Smith "forge blast", evolutions |
| `bolt` *(built, M14)* | instant strike on the `count` nearest enemies in range, with an arc fx | Static Rod |
| `boomerang` *(built, M14)* | discs fly out `range`, return, and cut each enemy at most once per `tickEvery` | Chakram |
| `mortar` *(built, M14)* | shells land on random enemies in range after a `fuse`, then burst | Cinder Mortar |
| `summon` | spawns minions with simple AI | Summoner skeletons |

Adding a new weapon = a data entry using an existing behavior. Adding a new *behavior* = one file + registry line; it must not require edits elsewhere.

### 5.3 Passive

```js
// data/passives.js
export const PASSIVES = {
  tempered_core: {
    name: 'Tempered Core',
    rarity: 'common',
    tags: ['defense'],              // for offer filtering and evolution recipes
    maxLevel: 5,
    levels: [                       // index 0 = level 1
      [{ stat: 'maxHp', op: 'inc', value: 0.1 }, { stat: 'armor', op: 'flat', value: 1 }],
      // ...
    ],
    levelText: ['+10% max HP, +1 armor', /* ... */],
    triggers: [],
  },
};
```

On level change (as built): add only the new level's modifiers with `source: 'passive:<id>:<lvl>'`; they stack on the earlier levels. `removeBySource('passive:<id>')` removes the whole passive. A passive's own `tags` are for offer filtering and recipes; a *modifier's* `tags` scope it to weapons (Wind Sigil's effects only reach projectile weapons).

Indexing differs on purpose, and `validate.js` enforces it: a **weapon** is already useful at level 1 from `base`, so `levels.length === maxLevel - 1`; a **passive** does nothing until taken, so `levels.length === maxLevel`. `levelText.length` must equal `levels.length` in both.

### 5.4 Title
Titles are run-long, non-leveling modifiers granted by milestones (kill 1000, survive 10 min, hit +10 enhance, beat a boss) and shown as a toast. Some are offered rarely in level-ups. They are the main source of **conditional** and **more** modifiers.

```js
// data/titles.js
export const TITLES = {
  unyielding: {
    name: 'Unyielding',
    desc: '40% more damage while below 50% HP',
    grant: { type: 'offer', rarity: 'epic' },    // or { type:'milestone', event:'kills', count:1000 }
    mods: [{ stat: 'damage', op: 'more', value: 0.4, when: 'hpBelow50' }],
    triggers: [],
  },
};
```

### 5.5 Evolution recipe

```js
// data/evolutions.js
export const EVOLUTIONS = [
  {
    id: 'storm_volley',
    from: 'ember_bow',               // weapon id
    requires: [                      // ALL must be satisfied
      { weaponLevel: 8 },
      { passive: 'wind_sigil', minLevel: 1 },
      // optional: { enhance: 5 }, { ore: { starsteel: 3 } }, { title: 'sharpshooter' }
    ],
    into: 'storm_volley',            // a WEAPONS entry (rarity 'evolved', class null, not in normal pool)
    at: 'forge',                     // 'forge' (combine action) | 'chest' (VS-style auto)
  },
];
```

Evolved weapons are normal weapon entries flagged `pool: false`. Evolving replaces the instance: keeps enhance level and affixes, resets level to 1 of the evolved weapon (which starts much stronger).

### 5.6 Level-up offers

`game/upgrades.js#generateOffers(state, rng, count = 3)`:
1. Build candidates: new weapons (if a weapon slot is free, max 6), level-ups of owned weapons/passives below max, new passives (if passive slot free, max 6), offer-type titles not owned.
2. Weight = `rarities[r].weight × (1 + luck × rarities[r].luckScale)` × modifiers (owned items ×1.5 to encourage depth; items that progress a recipe ×1.3).
3. Weighted sample without replacement.
4. If fewer than `count`, add the **Rest** fallback (heal 30%); +ore and +gold fallbacks join with the forge (M6). When nothing is left to improve, Rest is the only offer.
5. Player has limited **rerolls** and **banishes** (meta-unlocked). *Not built yet; planned for M8.*

Offer generation is pure: same seed + state → same offers. Tested in `tests/upgrades.test.mjs`.

### 5.7 Class

```js
// data/classes.js (shipped; see the file for the exact numbers)
export const CLASSES = {
  archer:    { startWeapon: 'ember_bow',   mods: crit +5%, move +10%,                         unlocked: true },
  smith:     { startWeapon: 'forge_hammer', mods: hp +30, armor +1, knockback +15%, forge costs -20%, unlocked: true },
  berserker: { startWeapon: 'rending_axe', mods: lifesteal 1.5%, 25% more damage below half hp, move +10%, unlock: { event: 'boss' } },
  mage:      { startWeapon: 'arc_bolt',    mods: area +15%, +8% burn/chill/shock chance,       unlock: { event: 'win' } },
  summoner:  { startWeapon: 'bone_call',   mods: hp -10, summon weapons +15% damage and +1 hound, unlock: { event: 'kills', count: 2000 } },
  saint:     { startWeapon: 'halo',        mods: regen 0.4/s, hp +30,                          unlock: { event: 'level', count: 18 } },
};
// unlock events (game/unlocks.js, checked on the results summary): boss, win, kills, level
```

### 5.8 Enemy and waves

```js
// data/enemies.js
export const ENEMIES = {
  goblin:  { hp: 10, speed: 70,  damage: 5,  radius: 10, xp: 1, ore: { chance: 0.02, type: 'iron' }, ai: 'chase', color: '#6aa84f' },
  brute:   { hp: 80, speed: 50,  damage: 12, radius: 18, xp: 5, ore: { chance: 0.15, type: 'iron' }, ai: 'chase', color: '#a64d79' },
  warlord: { hp: 3000, speed: 60, damage: 25, radius: 34, xp: 100, ore: { chance: 1, type: 'starsteel', count: 3 }, ai: 'boss_charge', boss: true, color: '#cc0000' },
};

// data/waves.js — a timeline; director interpolates rates within each segment
export const RUN = {
  length: 600,            // seconds. THE run-length knob (10 min). Win = survive until `length`.
  designLength: 600,      // the length the timeline below was authored for
};
export const WAVES = [
  { from: 0,   to: 60,  spawns: [{ enemy: 'goblin', perSec: 1.5 }], hpScale: 1.0 },
  { from: 60,  to: 180, spawns: [{ enemy: 'goblin', perSec: 4 }, { enemy: 'brute', perSec: 0.2 }], hpScale: 1.2 },
  // ...
];
// As built (M6) one-off events are a separate sorted list, not mixed into WAVES:
export const EVENTS = [
  { at: 120, event: 'shrine' },    // forge shrines, see §6.3
  { at: 240, event: 'shrine' },
  { at: 390, event: 'shrine' },
  { at: 510, event: 'shrine' },
  // { at: 300, event: 'boss', enemy: 'warlord' } arrives with M7; boss death also drops a shrine
];
```

**Changing run length.** Every time value in `WAVES` (`from`, `to`, `at`) is authored against `RUN.designLength`. The director multiplies them by `RUN.length / RUN.designLength`, so setting `RUN.length = 480` compresses the whole arc (boss at 4:00, shrines earlier) without editing the timeline. Spawn *rates* (`perSec`) are not scaled, so a shorter run also has fewer total enemies; retune rates if that matters. HUD timer and the win check read `RUN.length`.

Enemies spawn on the **perimeter of a rectangle** just outside the visible view (view rect expanded by 40 units), with the side chosen weighted by side length. The view is portrait and tall (§8), so a ring would waste most spawns far to the left and right. Director enforces the enemy cap (§7): at cap, it stops spawning and instead buffs `hpScale` so pressure still rises.

---

## 6. The forge in the run loop

### 6.1 Game state machine

```
Title → ClassSelect → Run ─┬─ Playing ⇄ Paused
                           ├─ Playing → LevelUp → Playing
                           ├─ Playing → Forge   → Playing
                           └─ Playing → Results → (Meta screen) → Title
```

`LevelUp`, `Forge`, `Paused` all freeze simulation (no `update` calls) and mount a DOM overlay. If multiple level-ups are pending, they are shown back to back; forge waits until level-ups are cleared.

### 6.2 Resources
- **Ore** drops from enemies (`ENEMIES[*].ore`), bosses and chests. Types (`data/ores.js`): `iron` (common), `mithril` (uncommon), `starsteel` (boss), `void_ember` (late/rare). Ore is a pickup like XP gems, pulled by the magnet.
- **Gold**: secondary, from chests and fallbacks; used for reroll/banish costs and meta shop.

### 6.3 When the forge opens: shrines
Forge is **an event, not a menu you can open any time**, to keep pacing tight. On a 10-minute mobile run it opens through **anvil shrines**, so reaching the forge is itself a small risk/reward decision made mid-horde.

Sources of shrines:
- `shrine` events in `WAVES` (default 2:00, 4:00, 6:30, 8:30 of a 10:00 run).
- A boss kill drops a shrine at the boss's death position, along with `starsteel`.
- The `forge` event type (opens the forge immediately, no shrine) still exists for debug, tests and scripted moments, but is **not used in the default timeline**. Auto-opening on top of shrines would mean 6+ interruptions in 10 minutes.

Shrine behavior (all numbers in `data/forge.js#SHRINE`):
- **Placement (as built):** just past the left or right edge of the view (the view is tall and narrow, so a 220–360 unit ring would land on screen), choosing the least crowded of 6 random candidate spots via the spatial hash.
- **Finding it:** a glowing anvil, plus a **HUD edge arrow** pointing at it with a ring showing remaining time, and a sound cue on spawn.
- **Activating:** stand within `radius` for `channel` seconds (progress ring fills; leaving the radius drains it at 2× speed). Standing still in danger is the cost. When full, state → `Forge`.
- **Expiry:** `ttl` seconds after spawning it fades (the boss-drop shrine lasts longer). A missed shrine is simply a missed forge; nothing carries over.
- **One use.** Unspent ore carries to the next shrine.
- **Concurrency:** at most `maxActive` (default 1) shrines exist; a spawn event while one is active is skipped.

During the forge the run is paused. The player can perform any number of actions while ore lasts, then press **Return to battle**.

### 6.4 Items forge actions operate on
Each weapon instance carries:

```js
{ instanceId, weaponId, level, enhance: 0, affixes: [ { affixId, mods } ], locked: false }
```

### 6.5 Actions (all defined in `data/forge.js`, logic in `game/forge.js`)

| Action | Cost | Effect | Risk |
|---|---|---|---|
| **Enhance** | ore scaled by current `enhance` | `enhance += 1`; adds `{damage, op:'inc', value: 0.08}` per level, plus a **breakpoint** bonus at +5, +10, +15 (e.g. +1 projectile, `more` damage) | Success chance from table (100% to +3, falls after). On fail: lose the ore spent; above +7 it may also drop 1 enhance level (Smith class and `luck` reduce this; a "protection" ore prevents it). **A failed enhance never destroys or removes the weapon**; the worst case is losing one enhance level. Only the player's own **Salvage** removes a weapon. |
| **Reforge** | iron + gold | Reroll a weapon's affixes (1 affix at common, up to 3 at epic). Affixes come from `data/forge.js#AFFIXES` with weights and tag filters. | Can lock one affix for extra cost. |
| **Combine** | recipe-defined | Execute an evolution whose requirements are met (§5.5). | None; it's the payoff. |
| **Salvage** | — | Remove a weapon you don't want for ore back; frees a slot. | — |

```js
// data/forge.js
export const ENHANCE = {
  maxLevel: 15,
  cost:    [3, 4, 5, 6, 8, 10, 12, 15, 18, 22, 26, 30, 35, 40, 50], // iron-equivalent
  success: [1, 1, 1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.25, 0.2, 0.15],
  perLevel: [{ stat: 'damage', op: 'inc', value: 0.08 }],
  breakpoints: {
    5:  [{ stat: 'projectiles', op: 'flat', value: 1 }],
    10: [{ stat: 'damage', op: 'more', value: 0.3 }],
    15: [{ stat: 'damage', op: 'more', value: 0.5 }, { stat: 'area', op: 'inc', value: 0.25 }],
  },
  downgradeAbove: 7,
  downgradeChance: 0.5,    // lose 1 enhance level on failure above the threshold; 0 disables downgrades entirely
  // invariant (tested): no failure outcome removes the weapon instance
};
export const SHRINE = {
  maxActive: 1,
  ttl: 45,                 // seconds before a shrine fades
  bossShrineTtl: 90,
  radius: 32,              // activation radius, world units
  channel: 0.6,            // seconds standing in radius to open the forge
  placement: { min: 220, max: 360, candidates: 6 },
};
// A weapon may override breakpoints with `forge: { breakpoints: { 5: [...] } }` on its WEAPONS entry
// (e.g. a melee arc gets +area at +5 instead of +1 projectile). Overrides replace that level only.
export const AFFIXES = {
  keen:     { rarity: 'common', mods: [{ stat: 'critChance', op: 'flat', value: 0.08 }, { stat: 'critMult', op: 'flat', value: 0.4 }] },
  swift:    { rarity: 'common', mods: [{ stat: 'cooldown',   op: 'inc',  value: -0.08 }] },
  volatile: { rarity: 'rare',   triggers: [{ on: 'kill', chance: 0.1, effect: 'explode', params: { radius: 50, damageFrac: 0.4 } }] },
  // ...
};
```

All forge modifiers go into the player StatBlock with `tags:['weapon:<instanceId>']` and `source:'forge:<instanceId>:...'`, so they flow through the same calculation as everything else.

`game/forge.js` exports pure functions (`enhance(inv, instanceId, rng, stats) → {ok, inv, result}` etc.) so success tables and edge cases are unit-tested without UI.

### 6.6 Why this design
Level-ups give **breadth** (which weapons/passives); the forge gives **depth** (how hard to push one weapon) and **risk** (enhance gambling). Evolutions tie them together. Ore is a second economy, so killing efficiently matters beyond XP.

---

## 7. Performance

### 7.1 Budgets (prototype, must hold at 60 fps on iPhone 12)

| Thing | Budget |
|---|---|
| Live enemies | 500 (hard cap 600) |
| Live projectiles | 600 (cap 800) |
| Pickups | 400 (gems merge beyond cap) |
| FX particles / numbers | 300 (oldest dropped) |
| Simulation per tick | ≤ 4 ms |
| Render per frame | ≤ 6 ms |
| Allocations in hot loop | zero steady-state (no GC sawtooth) |

### 7.2 Techniques
- **Object pools** (`core/pool.js`) for every store in §3.2. `acquire()` returns a reset object; `release()` returns it. Projectile hit-sets use a small fixed array + generation counter, not a `Set`.
- **Spatial hash** (`core/spatial-hash.js`): uniform grid, cell size 64 px (≈ 2–3× typical enemy diameter). Rebuilt once per tick from enemies (cheap: clear heads, insert into preallocated `Int32Array` buckets with a linked-list `next` array). Cells are hashed into a fixed 4096-slot table, so the world is unbounded; every candidate is distance-checked and de-duplicated. Items are stored **by reference**, so objects released after the rebuild are still safe to read (callers skip `alive === false`). Queries: `queryRadius(x, y, r, outArray) → count` and `queryNearest(x, y, r, pred) → object | null`. Used for projectile hits, aura/nova AoE, chain targeting, enemy separation, nearest-enemy targeting.
- **Enemy separation**: each enemy pushes away from at most 4 neighbours found via the hash, every other tick (alternate halves by index parity).
- **Nearest target**: query expanding rings in the hash; fall back to a cached nearest that refreshes every 6 ticks per weapon.
- **No per-frame allocation**: math helpers write into out-params; no closures, spreads or array literals inside systems. Damage queue is a preallocated ring buffer.
- **Rendering**: cull by camera rect; batch by fill style (draw all goblins in one path), avoid `save/restore` per entity, avoid `shadowBlur`, text only for damage numbers with a cap. Pre-render repeated shapes to small offscreen canvases if profiling shows `arc` cost. DPR capped at 2.
- **Gem merging**: when pickups exceed cap, combine far-away gems into a single larger gem.
- **Off-screen enemies**: when farther than 1.5 view-heights from the player, teleport them to the opposite side of the spawn perimeter instead of simulating a long walk back.
- **Mobile power**: pause on hidden; drop to 30 fps render (sim still 60 Hz) if frame time > 20 ms for 2 s, show in debug overlay.

### 7.3 Measurement
`?debug=1` overlay: fps, sim ms, render ms, counts per store, hash bucket max occupancy. A `stress` debug button spawns 500 enemies + 600 projectiles; this must stay green before merging milestone M5 onward.

---

## 8. Platform and UX details

- **Orientation: portrait only.** Played one-handed with the thumb. The manifest declares `orientation: portrait` (M8), and on a touch device in landscape `ui/rotate-prompt.js` covers the screen and pauses the run.
- **Logical view**: the camera shows a fixed **480 world units of width**; height is whatever the screen aspect gives, capped at **1040** units (about 19.5:9). Taller than that is letterboxed with dark bars. Scale = canvas pixel width / 480, so every phone sees the same horizontal field and fairness doesn't depend on the device. All spawn, shrine and teleport distances are expressed against this view rect.
- **Desktop**: the same portrait view is drawn as a centered column (max about 9:16, as tall as the window allows) on a dark background, not a stretched wide view. Balance is therefore identical to the phone.
- **Input**: floating joystick appearing wherever the thumb lands, ignoring touches that begin in the top ~12% (HUD and pause button). Keyboard WASD/arrows on desktop; Esc / pause button = pause. The joystick must also work when the first touch lands during a shrine channel.
- **Thumb layout**: HUD (hp, xp bar, timer, ore, pause) sits at the top, away from the playing thumb. Level-up cards stack **vertically**, each ≥ 72 px tall. The forge is a bottom-sheet: weapon list at the top, actions and cost in the lower half within thumb reach. Minimum tap target 48 px. Overlays use `env(safe-area-inset-*)`.
- **Audio**: WebAudio, unlocked on first touch; procedural blips for sound effects (`audio/audio.js`) and three synthesized techno tracks for music (`audio/music.js`, M18).
- **PWA (M8)**: `manifest.webmanifest` (`orientation: portrait`, `display: fullscreen`), icons; a service worker for offline play is optional later.
- **Persistence**: `meta/save.js` stores `{ version, unlocks, currency, bestTimes, settings }` in `localStorage` under `overforged:save`, wrapped in try/catch; on version mismatch, run a migration function or reset safely.
- **Determinism**: every run has a seed (shown on results screen). All gameplay randomness goes through `run.rng`; visual-only randomness may use a separate FX rng.

---

## 9. Testing

- `node tests/run.mjs` — tiny zero-dependency runner (`test(name, fn)`, `assert` helpers).
- Required tests: stat formula and caching (flat/inc/more/set, tags, conditions), offer generation determinism and slot rules, forge enhance tables and downgrade rules (including the invariant that no failure removes the weapon), shrine placement/expiry/channel rules, `RUN.length` timeline scaling, evolution requirement checks, spatial hash queries vs brute force, data validation passes for all shipped data.
- Manual checklist per milestone: play 3 minutes on phone, play 3 minutes on desktop, run debug stress.

---

## 10. Milestones (prototype)

Each milestone ends playable, is one or a few commits, and has a clear done-check. Order is chosen so the riskiest systems (stats, performance) land early and content comes last.

| # | Milestone | Done when |
|---|---|---|
| **M0** | Scaffold *(done)* | Canvas, loop, joystick, player moves. |
| **M1** *(done)* | Core runtime refactor | `core/` loop, rng, pool, events split out; `game.js` state machine with Title → Run → Results stubs; debug overlay with fps; **portrait view** (480-unit width, desktop column, rotate prompt, joystick top-zone ignore, §8). |
| **M2** *(done)* | Enemies + spatial hash | `goblin` and `brute` spawn from `waves.js`, chase, separate; player takes contact damage and can die; `?debug=1` stress button shows 500 enemies at 60 fps. Measured in headless Chromium only (about 0.7 ms sim, worst case 1.9 ms with everything stacked on the player); **still to verify on a real iPhone.** |
| **M3** *(done)* | Stats + first weapon | `StatBlock` with tests; `projectile` behavior; Archer's `ember_bow` kills enemies; damage numbers, hit flash, death puffs, knockback, screen shake on hit. |
| **M4** *(done)* | XP + level-up | Gems drop and magnet in; xp curve; level-up overlay with 3 offers from `upgrades.js`; weapon levels and passives working through modifiers. **As built:** 6 passives, 3-card vertical level-up screen with a 0.35 s input lock and 1 s of i-frames on resume, gems that merge at the pool cap, XP bar / level / item chips in the HUD. Rerolls and banish are deferred to M8 with meta-progression. |
| **M5** *(done)* | Weapon variety | `arc`, `orbit`, `aura` behaviors; Smith class with `forge_hammer`; class select screen; 5 weapons total; triggers + 2 effects (`explode`, `shield`). Perf budget re-verified. **As built:** weapons `ember_bow` (archer), `forge_hammer` (smith, arc), `spirit_blades` (orbit), `cinder_ward` (aura), `storm_javelin` (projectile); the last three are class-neutral and offered to every class. Direct hits go through `game/hit.js#strike`, which queues damage exactly like projectile hits; the damage queue now carries `src` (the weapon instance) so `game/triggers.js` can fire `hit`/`crit`/`kill` triggers from `flushDamage`, and `interval` triggers tick per weapon. Triggers are per weapon with an optional `minLevel` (Ember Bow lv5: 15% of kills explode; Forge Hammer lv3: shield every 12 s); the `chance` roll uses the sim rng. Trigger damage carries `depth + 1`, capped at 3. `player.shield` soaks damage before hp (capped at max hp). Behaviors may define `draw(inst, ctx, run)`. Orbit and aura deal damage on a tick (`tickEvery` x cooldown stat, or the cooldown itself) rather than per frame. Class select remembers the last class in localStorage; `?class=smith` skips it; `?debug=1` runs get `run.debugLoadout()` (smoke test `--loadout`). |
| **M6** *(done)* | Forge + shrines | Ore drops; `shrine` events spawn shrines with edge arrow, channel and expiry (§6.3); enhance (with tables + breakpoints; failures never remove the weapon), reforge (affixes), salvage; forge overlay; unit tests for `forge.js` and shrine rules. **As built:** ore is one currency in iron-equivalents (`data/ores.js`, iron only until M7) dropped as pickups (`kind` 1 in the pickup pool; never merged, banked directly if the pool is full; `oreGain` scales the drop chance). Timeline one-offs live in `EVENTS` in `data/waves.js` (separate from `WAVES` segments) and run through `game/run-events.js`; shrines at 2:00, 4:00, 6:30 and 8:30. Shrines (`systems/shrines.js`) spawn just past the left or right view edge, because the view is tall and narrow (radius 40, channel 0.8 s, ttl 45 s, maxActive 1); `run.forgeReady` makes `game.js` open the forge after any pending level-ups. Forge modifiers use sources `forge:<id>:enh:<n>:*` and `forge:<id>:affix:<affix>` so a downgrade or reforge is a prefix removal. Smith pays 20% less ore (`CLASSES.smith.forge.costMult`); luck cuts the downgrade chance. Affix triggers live on `inst.extraTriggers`. Salvage is refused for the last weapon. **Deferred:** Combine (M7 evolutions), gold, reforge locks, mithril/starsteel. Debug keys: `F` spawns a shrine, `O` gives 20 ore; smoke test `--forge`. |
| **M7** *(done)* | Evolutions + boss + titles | 2 evolution recipes executed at the forge; a boss at 5:00 that drops starsteel and a shrine; 4 titles (milestone + offer). A full 10-minute run (`RUN.length = 600`) is winnable by surviving to the end and feels escalating. **As built:** *Evolutions* (`data/evolutions.js`, `game/evolution.js`): `storm_volley` (Ember Bow lv8 + Wind Sigil + 1 starsteel) and `colossus_maul` (Forge Hammer lv8 + Tempered Core lv2 + enhance +3 + 1 starsteel). Combine mutates the instance in place (same `instanceId`, so enhance levels and affixes carry over), removes the old weapon's level modifiers, resets to level 1 of the evolved weapon and re-inits its behavior. Evolved weapons are `pool: false`, rarity `evolved`, and level up (6 levels) once owned. The forge card lists each requirement with a check or cross. Not built: the 1.3x offer weight for recipe progress. *Boss*: `warlord` (hp 1800, not wave-scaled, `ai: 'boss_charge'`: chase 5 s, stand and flash 0.9 s, dash 0.7 s at 340 along the aimed line), spawned by the `boss` timeline event at 5:00 (`run.boss`, `run.bossAlive`, HUD bar, toast). On death it drops 2 starsteel (separate `run.starsteel` counter; ore types carry a `bank`), places a 90 s shrine on the spot even if another shrine is active, and grants Warbreaker. Killing it is not required to win. *Titles* (`data/titles.js`, `game/titles.js`): Slayer (1000 kills), Forgemaster (+5 enhance), Warbreaker (boss kill) are milestones; Unyielding (40% more damage under half HP) is an epic level-up offer (`title_new`). Titles appear as chips in the HUD and in the results. Title `triggers` are not implemented yet. Debug keys: `B` spawns the boss, `X` gives 2 starsteel; smoke test `--boss`. Boss hp and damage are first guesses to tune by playtest. |
| **M8** *(done)* | Polish for phone | PWA manifest + icons, pause menu, results screen with seed and stats, simple meta unlock (Berserker after first boss kill), save/load, audio blips, GitHub Pages deploy. **As built:** `manifest.webmanifest` (standalone, portrait, relative `start_url`/`scope` so the Pages subpath works), icons generated by `tools/make-icons.py` into `icons/` (192, 512, maskable, apple-touch), and `sw.js` (offline play): on install it walks the import graph from `main.js` with fetch and caches every module plus the shell, so one online visit is enough and there is no file list to maintain; fetches are network-first with `cache: 'no-cache'` revalidation (a deploy shows at once, and the HTTP cache cannot serve a mix of old and new modules) and fall back to the cache offline; registered with `updateViaCache: 'none'`; bump `CACHE` to flush. `tests/offline.mjs` loads online, goes offline and reloads. (A Safari black screen on 2026-10-13 was first blamed on this worker and it was briefly removed; the real cause was the file name `boomerang.js` being blocked by content blockers.) View sizing (`render/view.js`): in an iOS home-screen app `innerHeight` can be short of the screen, leaving a black strip at the bottom, so standalone mode also takes the visual viewport, a fixed full-screen probe and `screen.height` (capped at the max aspect), and re-lays out on `pageshow`, visual-viewport resize and at 300 ms / 1.2 s; a Safari tab keeps `innerHeight`. Under a notch `insetTop` includes 10 extra units so the HUD clears the status-bar blur. **File naming:** never name a module after a known tracker script (`boomerang.js` was blocked by Safari content blockers and broke the tab; it is now `returning-disc.js`; the behavior id is still `boomerang`). Startup watchdog (inline in `index.html`): if `window.__overforged` is not set 3 s after load, or `main.js` fails to load, the boot-error panel says so and lists every file in the import graph that fails to fetch (so a content blocker or flaky network is named by file) and offers "Clear cache and reload" (unregisters service workers, deletes caches). Save (`save/save.js`, injectable storage so it is tested): one versioned JSON key with last class, unlocked classes, bests, run/win/boss counts and the sound setting; corrupt or missing storage falls back to defaults and never throws. **No mid-run save** (runs are 10 minutes and auto-pause when hidden). God-mode (`?god=1`) runs never write to the save. Meta unlock: classes carry `unlock: { event: 'boss', hint }`; the Berserker (`rending_axe`, lifesteal 3%, 30% more damage under half HP, +10% speed) unlocks on the first Warlord kill; class select shows locked classes with the hint; `?unlock=all` opens them for testing without saving. Lifesteal is now a real stat (heals a share of damage dealt, scoped per weapon). Audio (`audio/audio.js`): synthesized WebAudio blips with per-sound rate limits, created on the first gesture (iOS); the sim only calls `run.sfx(name)` (a no-op default) so tests stay silent and deterministic. Rerolls and banishes (2 and 1 per run, `LEVELUP`): reroll redraws the offers; banish (toggle, then tap a card) removes that item id from the pool for the run, and an all-banished pool falls back to Rest. Title screen shows bests and a sound toggle; pause has the sound toggle; results show level, new-best markers, titles and unlocks. Smoke test `--ui`. |
| **M9** *(done)* | Measure and fix the basics | `tools/bench.mjs`; tight projectile volleys (`spread` + `gap`); Ember Bow, Spirit Blades, Rending Axe and Berserker tuning. See `docs/roadmap.md` "M9 as built". |
| **M10** *(done)* | Status effects | Design in `docs/design-m10-m13.md` §3. **As built:** three statuses on fixed enemy fields (`status` bit flags, `burnDps/burnT/burnAcc/burnSrc`, `chill/chillT/freezeT/freezeImm`, `shockT`, `slowMul`; `data/statuses.js`). **Burn**: each application adds `burnPower x hit` to a pool dealt evenly over 3 s in 0.25 s ticks (queued as `KIND_DOT`); re-applying pays out accrued damage at the old rate first, so the total always equals the pool. **Chill**: stacks slow 10% each; 4 stacks freeze (1 s), then 1.5 s freeze-immunity (stacks cap at 3); bosses cap at 2 stacks and never freeze. **Shock**: marks and, on a weapon hit (`KIND_HIT`), chains `chains` hops at `chainDamage` x the hit to the nearest un-hit enemies within 120 (hops are `KIND_PROC`, never chain again, and chain even if the hit killed its target). Damage queue entries carry a `kind` (HIT / PROC / DOT): DOT gets no lifesteal, statuses or hit/crit triggers but its kills still fire kill triggers. `game/hit.js#resolveHit` is the single weapon-hit entry (projectiles and direct hits). `flushDamage` order: target multiplier (`vsBurning/vsChilled/vsShocked`, read through the source weapon's tags) -> hp, knockback, number -> lifesteal -> status rolls -> crit/hit triggers -> death. 15 new stats (`burnChance` ... `executeBelow`; ricochet/split/executeBelow are defined but used from M11); `validate.js` forbids `when` on them. Weapons gain `baseMods` (their elemental identity, source `weapon:<id>:base:`, re-applied on evolve): Ember Bow burns (35%), Cinder Ward burns (25%, base damage 7 -> 6), Storm Javelin shocks (50%), Storm Volley both (30%/30%). Tag `lightning` renamed `storm`; melee, orbit and aura weapons gained `close`. New `nova` behavior and **Rime Shards** (frost: 6 shards in a ring, 100% chill, 2 stacks per hit). Status rings are drawn on every enemy (one path per colour; frozen enemies get a pale fill); chain bolts are a new fx kind. Deviations from the spec: no damage numbers for burn ticks (text is the expensive part); the `run.hitCtx` trigger context is deferred to M11b where payoffs need it. |
| **M11a** *(done)* | Perk engine + first 14 perks | Design in `docs/design-m10-m13.md` §4. **As built:** `data/perks.js` (same shape as passives: `levels`, `levelText`, plus `requires`, `affinity`, optional `rule`), `game/perks.js` (`addPerk`, `levelUpPerk`, `findPerk`, `meetsRequires`; sources `perk:<id>:<level>:`), `player.perks`, `run.rules`. `requires` is an AND of ORs over `tag:<t>` (owned weapon INSTANCE tags, so infusions count), `perk:<id>[:<minLevel>]` and `class:<id>`; unmet requirements keep a perk out of the pool. Offers: new kinds `perk_new` / `perk_up`; perks have no slot cap; matching `affinity` makes a perk 1.5x as likely; **first card rule**: when any weapon or passive can be upgraded, card 1 is one of those. `offerState` gained `perks` and `ownedTags`. Perks shipped: Kindling, Frostbite, Static Charge (enablers); Fan the Flames, Deep Freeze, Arc Conductor (amplifiers); Ricochet, Splitting Tips, Heavy Fletching, Volley (projectile); Long Reach, Echo Strike, Bloodletting (close); Keen Eye (crit). Projectiles read `ricochet`/`split`/`splitDamage` at spawn: a spent projectile with bounces left turns toward the nearest un-hit enemy within 180 (ttl topped up to 0.5 s); the first hit of a splitting projectile spawns children at 0.44 rad steps with the split damage, pierce 0, no split or bounce, skipping the enemy that spawned them. Lifesteal's fast path now checks for any lifesteal modifier (tag-scoped ones count). HUD shows a perk chip row. Bench bot scores perks. Deviation: 14 perks instead of 12 (the payoffs, alloys and Headsman are M11b). |
| **M11b** *(done)* | Payoffs, alloys, resonance | Design in `docs/design-m10-m13.md` §4. **As built:** rule perks (`run.rules[id]` = the current level's values; engine in `systems/status.js`): **Wildfire** (a burning enemy that dies adds `mult` x its remaining burn, split among the `n` nearest enemies within 90; 2/1.5, 3/1.75, 4/2.0), **Shatter** (a frozen enemy that dies deals `frac` of its max hp, 25/35/50%, to enemies within 70 as PROC damage), **Thunderclap** (a shocked enemy that dies chains 2/3/4 hops at 60% of the killing blow), and the alloys **Quench** (burning + chilled, in either order: both consumed, remaining burn x2/x3 dealt within 60), **Overload** (a chain hop landing on a burning enemy explodes within 60 for 50/80% of the hop and ignites what it hits), **Superconduct** (`resolveHit` forces a crit on chilled + shocked targets; level 2 adds +0.5 crit multiplier). Alloys need a source of BOTH elements (`requires` lists one per element). **Headsman** (needs Keen Eye or the Berserker): a crit that would leave a non-boss under `executeBelow` (12%, then 20%) of max hp kills it, computed in `flushDamage`. The flush takes a snapshot (`status`, `maxHp`, remaining burn) before `killEnemy` and calls `onStatusDeath`, so the planned `run.hitCtx` was not needed. **Resonance** (`data/resonance.js`, `game/resonance.js`): 2 weapons sharing a tag (instance tags) give tier I, 3 give tier II (cumulative), modifiers scoped to that tag; recomputed on add and evolve (M13 will also call it on infusion); the HUD shows labels like "Fire II". `tools/bench.mjs --builds` runs the design table's builds at a mid-run power level. First numbers (200 enemies at 3x hp, stationary player; Warlord duel): crowd clear 3.7-11.7 s across builds, boss 7.8-30.8 s; **Wildfire (3.7 s / 7.8 s) is the outlier** and the weak ends are Glacier and Reaper against a single target. Left for the M15 balance pass. |
| **M12** *(done)* | Elites and chests | Design in `docs/design-m10-m13.md` §6. **As built:** *Elites* (`data/elites.js`, `spawnElite`): a normal def with hp x8, radius x1.35, damage x1.5, xp x8, one affix: **Swift** (speed x1.45), **Warded** (half damage while above 50% hp; applied in `flushDamage`), **Regenerating** (3% max hp/s after 2 s unhit; in `enemy-ai.js`); gold pulsing ring and the affix name drawn above them; elites freeze for half as long. `EVENTS` gained 7 `elite` events (brutes at 1:30, 2:45, 4:00, 5:45, 7:00, 8:00, 9:00). *Chests*: pickup kind 2 (`value` = tier, 0 elite / 1 boss; `spawnChest`), never magnetised, collected by touch into `run.pendingChests` (a full pool queues it directly so it can never be lost); gold box in the world and an off-screen arrow in the HUD. The boss now banks its starsteel at once (no pickup) and drops a boss chest next to its shrine. `game/chests.js`: `chestCount` (elite 65/28/7% for 1/3/5 rolls, luck x(1+0.1 luck) on the big two, boss always 5, the first elite chest at least 3), `evolutionBlockers` (items that advance a recipe's unmet weapon level or passive level), pure `pickChestItem(state, rng, blockers, wantNew)` (weights weapon_up 1.5 / passive_up 1 / perk_up 1, x3 for a blocker; respects banishes), `openChest(run, tier)` which applies every roll through `applyOffer` and returns descriptors. A ready evolution (starsteel included) is performed as roll 1 (the jackpot). On 5-roll chests each roll after the first has a 12% chance to be a new weapon (at most one, only with a free slot, x1.5 for a shared element tag). With nothing left to improve a roll is +6 ore. `game.js` order: level-ups, then chests (`ui/treasure.js`: the count, then cards revealed 0.32 s apart, Collect), then the forge. Debug keys `C` (chest at your feet) and `E` (an elite); smoke test `--chest`. Bench bots detour to chests and open them (4-6 per run). |
| **M13** *(done)* | Reforge choice, infusion, tempers | Design in `docs/design-m10-m13.md` §7. **As built:** reforge replaces the old reroll-all. It works one affix slot at a time (`rollReforge(run, inst, slot)` charges ore and stores 3 options on `inst.pendingReforge`, at least one uncommon+; `applyReforge` picks one, `keepCurrent` declines; slots fill in order; while a pick is pending, reforge and enhance are blocked). The pool is 19 affixes (`data/forge.js`), including status and chain effects (searing, conductive, ricocheting, splitting, vampiric, executioner, colossal) and three **infusions** (ember/rime/storm_touched) that add an element tag via `inst.addTags`; only one infusion per weapon. `instanceTagSet` / `syncTags` rebuild `inst.tags` from base tags, infusions and tempers and refresh resonance; evolution keeps infusion tags. **Tempers** at +5 and +10 (`ENHANCE.tempers`, per-weapon overrides in `forge.tempers`): a choice of two, shown on enhance success (`pendingTemper` blocks further enhancing until `chooseTemper`); a downgrade removes that level's temper and its tag. Sources: `forge:<id>:affix:<affixId>:` and `forge:<id>:temper:<lvl>:`. Forge UI shows slots, a three-option pick panel with Keep current, and temper cards. Tests: `tests/m13.test.mjs`. |
| **M13b** *(done)* | Build view and run stats | **As built:** `ui/build.js` renders the build panel (`buildHtml(run)`: key stats, weapons with tempers/affixes and their damage, passives, techniques, resonance, titles) and is shared by the pause menu ("Build & stats" button), the level-up screen (a Build button, plus a one-line `ownedLine`), and a tap on the HUD (`input` calls `onBuild`, which opens pause on the build view). `game/run-stats.js` keeps `run.stats`: total, a per-second damage array (for DPS now / average / peak), per-cause totals and a record per weapon instance (damage, kills, crits, by cause; evolution keeps the record under the new name, salvage marks it gone). `flushDamage` records the damage actually dealt (overkill excluded) using a new `cause` array on the damage queue (`CAUSE`: direct, burn, chain, blast, quench, overload, shatter, thunderclap; defaults by kind, passed explicitly by the status code). The end screen shows average/peak/total DPS, damage by weapon and damage by source (`resultsDamageHtml`, from `summary().stats`). Tests: `tests/run-stats.test.mjs`; smoke `--ui` covers all three entry points and `--results` the end screen. |
| **M14** *(done)* | More weapons, recipes, combo | **As built:** four new weapons, all class-free: **Static Rod** (`bolt`, storm, shock 100%, never misses, +1 target at L3, +1 chain at L6), **Chakram** (`boomerang`, physical), **Rime Orbs** (`orbit`, frost, data only), **Cinder Mortar** (`mortar`, fire, area). **Eight evolved weapons** (`pool: false`): Reaper Axe, Seraph Blades, Pyre Crown, Thunder Lance, Glacial Bloom, and the combos Vapor Wheel, Stormshell Mortar, Stormfrost Lance. `data/evolutions.js` now has **10 recipes**: every class starting weapon evolves (Ember Bow and Forge Hammer as before; Rending Axe is new), and the new ones are **status-build gated** by a new requirement `{ perk, minLevel }` (Reaper Axe needs Keen Eye 2, Seraph Blades Long Reach 2, Pyre Crown Fan the Flames 2, Thunder Lance Arc Conductor 2, Glacial Bloom Deep Freeze 2; each also needs weapon level 8 and 1 starsteel). A recipe with `with: <weaponId>` is a **combo**: it needs one instance of each weapon at the recipe's `weaponLevel` (6) plus starsteel; the `from` instance becomes the result and keeps its enhance level, affixes and infusion tags, the `with` instance is consumed (stat modifiers removed, run-stats record marked gone, resonance refreshed). Both weapons' forge cards show the recipe (`pair(run, recipe)` finds the instances); a chest's jackpot never performs a combo (it would consume a weapon unasked); `evolutionBlockers` also reports `perk_up:<id>` and only counts a combo when both parts are owned. Combos: Cinder Ward + Rime Orbs = Vapor Wheel (fire + frost), Cinder Mortar + Static Rod = Stormshell Mortar (fire + storm), Storm Javelin + Rime Shards = Stormfrost Lance (frost + storm). Chakram has no recipe yet. Bench (`--weapons`, single target, L1/L4/L8 DPS): Static Rod 14/18/35, Chakram 13/31/90, Rime Orbs 7/15/38, Cinder Mortar 11/27/77 against Ember Bow 19/43/112; evolved weapons start above their parent at L8 (Reaper Axe 74 vs 70, Thunder Lance 69 vs 65). Chakram and Mortar are still the hot ones at L8; left for M15. Tests: `tests/m14.test.mjs`. |
| **M15** *(done)* | Balance pass and the last three classes | **Classes:** **Mage** (Arc Bolt, `bolt`, no element of its own; every hit has an 8% chance each to burn, chill and shock, so any element build works; unlock: win a run), **Summoner** (Bone Call, new `summon` behavior: up to `count` spirit hounds, one arriving per `cooldown`, hunting the nearest enemy within a leash and cutting on contact once per `tickEvery` per enemy; **minions are invulnerable spirits**, so no minion hp system is needed; unlock: 2000 kills in a run), **Saint** (Halo, an aura with lifesteal and a shield trigger; unlock: reach level 18). Unlock rules moved to `game/unlocks.js` (events `boss`, `win`, `kills`, `level`). Every start weapon has an evolution: Prismatic Bolt (Scholar's Lens 2), Grave Legion (Fleet Greaves 2), Radiant Halo (Tempered Core 2). The class screen scrolls and locked cards are compact. **Difficulty:** the bot had been winning almost every run by kiting (enemies were slower than the player at all times), so waves gained `speedScale` (1.0, 1.12, 1.35, 1.6 per segment) and `damageScale` (1.0, 1.05, 1.2, 1.45) next to `hpScale` (1.0, 1.3, 2.0, 2.9); the director exposes them and `spawnEnemy` applies them to every spawn, elites and the boss included. **Balance changes:** Wildfire spreads 60/60/75% of the remaining burn to 2/3/3 enemies (was 150-200% to 2-4, which cascaded: crowd clear 3.7 s -> 9.4 s, now in line with the other builds at 5-12 s); Shatter 30/45/60% (was 25/35/50); Headsman 15% then 25% (was 12/20); Ember Bow damage 14 -> 16; Forge Hammer damage 24 -> 25, range 82 -> 88, arc 1.9 -> 2.1, Colossus Maul 60 -> 76; Smith knockback +25% -> +15% and hp +40 -> +30; Berserker lifesteal 2% -> 1.5% and wounded bonus 30% -> 25%; Archer gained +10% move speed. Bench tooling: `--class`, `--seeds N`, and `--hp / --rate / --speed` multipliers for difficulty experiments; the bot now chooses tempers. **Result** (bot, 10 seeds, wins): Archer 7, Smith 10, Berserker 8, Mage 9, Summoner 7, Saint 8 (average level 16-22); the bot kites better than a person, so treat ~80% as 'a little easy' and tune by feel once people play it. Known leftovers: Smith and the Mage still lead, the Chakram and Mortar are hot at level 8, and enemy variety (ranged units, splitters) is the real fix for kiting and is in the 'Later' row. Tests: `tests/m15.test.mjs`. |
| **M16** *(done)* | Compendium | **As built:** an in-game guide opened from the title screen and the pause menu (it returns to where you came from; the tab, filters and open entries are remembered for the session). `game/compendium.js` generates every entry from the data files (`buildEntries`: weapons, evolved weapons with how to make them, techniques, passives, affixes, tempers, resonance sets, builds), so nothing is hand-copied and it cannot drift; `filterEntries` and `facetsFor` are pure and tested. Six tabs (Weapons, Evolve, Techniques, Passives, Forge, Builds), a search box, and one row of chips per facet (element, type, class, rarity; only values that exist on the tab are offered). Techniques are categorised (Enabler, Amplifier, Projectile, Close range, Payoff, Alloy, Execute, General) and read their `requires` as sentences ("a Fire weapon or Kindling, and a Storm weapon"); each weapon lists its level text, evolutions, combos and tempers, plus which builds use it. **Builds** come from `data/builds.js`, which the bench now shares (`--builds` has 11 guide builds plus a baseline per class; all within range, crowd clear 7-11 s and boss 9-27 s); each build has an idea and a tips line saying what to take, reroll for and forge toward, and a test checks every technique in a build is actually offered given the weapons and techniques before it. `ui/compendium.js` is the DOM; `smoke --guide` drives it. Deviation: the planned `???` for unseen entries was dropped, since the point is knowing what to look for. |
| **M17** *(done)* | Run history and export/import | **As built:** the save is **v2** (same `overforged.save.v1` key; `normalize` fills `history: []` for older saves, so no migration step). `save/save.js` appends an entry per finished run via `entryFromSummary(summary, now)` (time, class, won, kills, level, seed, boss, total damage, average DPS, and the build as `[id, level]` pairs for weapons, passives and techniques, plus title ids), capped at `HISTORY_CAP` (100) newest runs while the `runs`/`wins` counters keep counting; `normalize` drops malformed entries. `run.summary()` gained `build` and `titleIds`. God-mode runs are still not recorded. `game/history.js` is the pure model (filter by class / wins, `summarize`, display names that fall back to the raw id if data is later renamed). `ui/history.js` is the History screen (title menu): totals, class and Wins-only chips, expandable rows with the build, and **Same seed** to start a run on an old seed and class. **Export / import** (`save/transfer.js`, `ui/backup.js`, reached from History): the whole save becomes one text code, `OFZ1.<fnv1a checksum>.<base64url(deflate-raw JSON)>` (plain `OF1` without CompressionStream), roughly 6 KB for a full history; decoding strips pasted whitespace, rejects damaged or truncated codes by checksum, and re-validates through `normalize`. Import shows the code's totals beside the current ones and **replaces** the save only after confirmation. Storage is still per browser: the Safari tab, the home-screen app and other devices are separate, which is what the code is for. Tests `m17.test.mjs`; smoke `--history`. |
| **M18** *(done)* | Music | **As built:** `audio/music.js` is a look-ahead step sequencer (25 ms timer, 0.2 s window, 16 steps per bar, 8-bar loops) on the shared WebAudio context; no audio files. Three tracks: **Forge Gate** (title, 118 bpm, A minor, organ pad and bell melody), **Furnace Floor** (in a run, 132 bpm, A minor: four-on-the-floor kick that sidechain-ducks the bass and stabs, a 303-style acid bass from bar 3, offbeat supersaw stabs and a short lead from bar 5, noise riser before the loop) and **Warlord Overdrive** (boss, 150 bpm, E phrygian: double kick, acid bass, organ-and-saw lead, organ stabs, tom fills). Each song is data (`lead`, `chords`, `roots`, optional `lanes`, plus `custom` and `drums` per-step functions); melody lines hold one token per `res` steps (note, `-` hold, `.` rest). Every song builds its own effects graph (dotted-eighth echo, convolver reverb, a duck bus the kick pumps) that is faded out and dropped when the song changes. `game.js` only picks the scene: `title` on the title screen, `run` in a run, `boss` while `run.bossAlive`, silence on the results screen (the win/lose blip plays), and `duck(true)` (35% volume) while paused. The sim never touches music. Settings: the save has `music` (bool) and `musicVolume` (0..1, default 0.6), shown as a Music toggle and a volume slider on the title and pause screens (`ui/music-controls.js`); the existing Sound toggle mutes everything. Output level is `0.5 * volume^1.6`. Tests `m18.test.mjs` (token counts, a full loop of every song on a fake context, scene switching, save) and smoke `--music`. Chosen from the sound-test page (`Furnace Floor` family). **Sound effects** were rebuilt in the same change (`audio/sfx.js`, replacing the single-oscillator blip table): each of the 15 sounds (`hit kill gem ore hurt levelup forge fail shrine boss chest evolve win lose tap`) is a few layered voices (pitch glides, filtered noise, an inharmonic anvil/bell `clink`, an arpeggio for level-up, a kick under evolve and win, a two-blast low horn for the boss), played with a small random pitch factor and a per-sound minimum gap; consecutive gem pickups within 0.45 s climb a major scale so a vacuumed pile rings upward. SFX go to the master bus (0.7); music has its own bus, set well below. |
| **M19** *(done)* | Character art in the game | The six player classes are drawn as sprites in the woodcut ink style (cute, big-headed, bone-white faces) instead of discs. Locked in from the art canvas: **Smith** Furnace Hand (topknot, ember bandana, bare arms), **Archer** Woodland (long red hair, leaf crown), **Mage** Moon Witch (frost twin tails, crescent on a tall hat), **Berserker** Shield-maiden (horned helm, blonde braids), **Summoner** Lantern (long ash hair, bone crown, spirit lantern; the game draws her hounds), **Saint** Radiant (pale-gold hair, halo). The art is SVG: `tools/make-sprites.py <art project dir>` extracts the symbols from the art boards into `render/sprite-art.js` (generated, do not edit); `render/sprites.js` rasterizes each once into a 192 px canvas (plus a white silhouette for the hurt flash) and the renderer draws it with one `drawImage`, mirrored by facing, 68 world units wide; the 14-unit hitbox is unchanged. Until an image has loaded (or without a DOM, as in tests) the renderer falls back to the old disc. Class select cards show the portrait, dimmed to a silhouette for locked classes. Enemies, bosses and pickups are still shapes. Test `m18.test.mjs` checks every class has well-formed art. |
| **M20** *(done)* | Enemy art in the game | Goblin (**Clubber**, with a proper club), Brute (**Boulder**, hunched with stone shoulder pads and horn stubs) and the Warlord boss (**Ogre King**) are drawn as sprites instead of plum, green and red discs. `tools/make-sprites.py` now also extracts `goblin`, `brute` and `warlord` into `sprite-art.js`; `drawEnemies` (`render/entities.js`) draws each as one `drawImage` at 3.5x its radius, mirrored to face the player, with the white silhouette for the hit flash. Hit circles are unchanged. The old batched discs remain as the fallback when art has not loaded (and in tests). Status rings, frozen tint and elite marks are drawn as before. 500 enemies on screen: 60 fps, about 1 ms render. |
| **M21** *(done)* | Loot and prop art | XP gems (four tiers: small orb, ringed orb, orb with crescent sparks, flame-crowned gold orb), iron ore (ingot stack), starsteel (cyan crystal), the chest and boss chest (iron strongbox with an ember or cyan glow) and the shrine anvil (forge altar with a flame) are sprites, from set C of the art canvas. `make-sprites.py` extracts `gem0..3`, `ore_iron`, `ore_starsteel`, `chest`, `bosschest`, `shrine` from `Pickups.dc.html`. Gems and ore draw at radius x 4.2, chests at 46 (boss x1.4), shrine at 74 world units. Each keeps its old shape as the fallback until the art loads. |
| **M22** *(prototype)* | Evolved-weapon glow on the hero | Each evolved weapon (`rarity: 'evolved'`) adds a mote orbiting the hero in its element colour (fire ember, storm yellow, frost blue, light pale gold, arcane violet, otherwise iron orange); the first one also gives a soft halo under the sprite. No new art, drawn in `renderer.js` (`drawEvolvedGlow`). A test of whether weapon state is readable on a 68-unit hero in a swarm; if it reads well, hand-drawn evolved states per class can follow. |
| **M23** *(done)* | Title and results art | The title screen shows the flaming forge anvil with the six heroes lined up beneath it; the results screen shows a ribbon (**You survived** / **You fell**) over a scene: win has the blazing anvil, the class you played beside it and gems and starsteel around, loss has the anvil and hero in grey. `ui/scenes.js` builds each scene as an in-flow HTML block from the sprites (`spriteUrl`), with CSS in `index.html` (`.scene`, `.tscene`, `.rscene`): a glow, drifting embers and bobbing gems, all CSS animation, turned off under `prefers-reduced-motion`. Scenes scale with the screen (width capped by viewport height), and the title overlay scrolls if a very short screen needs it. |
| **M24** *(done)* | Playtest fixes: forge picks, pacing, evolution hints | (1) Reforge options and tempers now open as a panel over the whole forge (`.fmodal`), so they are on screen however far the weapon list is scrolled; "Keep current" and the choices are in it. (2) Goblins walk at 60 (was 70) and the wave speed scales are gentler (1.08 / 1.22 / 1.4 instead of 1.12 / 1.35 / 1.6), while the goblin spawn rate climbs higher late (to 5.4/s by minute 6, 7.8/s at the end, from 4.8 and 6.5): more of them, not faster ones. (3) `evoNeeds` in `game/upgrades.js` finds, for each recipe whose weapon is owned and within 3 levels of the level it asks for, the weapon level, passive or technique a level-up can still supply. Those offers get a x1.8 weight (`EVO_BOOST`, a slight preference, never forced) and a gold-edged card with "★ Needed to evolve into X". Enhance level, starsteel and titles cannot come from a level-up, so they are not marked. (4) The results screen and build panel show each weapon's DPS next to its kills: its damage divided by the time from its first hit until the run ends (or it was salvaged), so a weapon found late is not diluted by the minutes before it existed. |
| **M25** *(done)* | More starsteel, earlier evolutions, armoured and ranged enemies | **Starsteel:** the first elite of a run always drops 1 and later elites 50% (`ELITE.starsteelChance`), on top of the boss's 2, so evolutions no longer wait for minute 5. **Evolution window:** every recipe asks for weapon level 6 (was 8), so the level-up hint (within 3 levels) starts at level 3. **Shieldbearer** (armoured goblin, hp 30, `armor` 5): every non-DoT hit loses 5 damage, never more than 75% of the hit (`ARMOR_FLOOR`), armour grows with the square root of the wave's hp scale; many small hits barely scratch it and heavy hits, burns and shocks do. **Slinger** (`ai: 'ranged'`, hp 14): walks to 230 units, stops, flashes for 0.4 s, throws a slow shot (150/s, 7 damage, scaled by the wave's damage scale) at where you stand; shots live in `run.enemyShots` (`systems/enemy-shots.js`), pass through you during post-hit invulnerability, and freezing a slinger stops its timer. Both appear from minute 1-2 and ramp up (waves.js). Art for both is the Clubber goblin plus a helmet and shield, or a bow and purple band, composed by `make-sprites.py` (`EXTRA`): placeholders until they get an art round. |
| **M26** *(done)* | Shared effect vocabulary and six branch evolutions ([design-m26-m28.md](design-m26-m28.md)) | **Vocabulary:** trigger `on: 'attack'` (`game/triggers.js#attackTriggers`: once per swing, volley, bolt, pulse or minion bite, with `every: n` and `chance`; arc, bolt, summon and judge call it); effects `fire_patch`, `vortex`, `shockwave`, `pillar`, `sunder`, `bless`, `heal`, `frenzy` (`effects/index.js`; effects now also get `ang` and, for hit/crit triggers, the `target`); `explode` takes `kb` and `color`. **Hazards** (`systems/hazards.js`, `run.hazards`, cap 90, patches dropped first): fire patch ticks PROC damage plus burn, vortex pulls (bosses at 15%) then bursts, pillar telegraphs 0.35 s then hits once, shockwave hits each enemy once; ticked after statuses, drawn under the enemies. Enemies gain `sunderT` (armour ignored) and `blessT` (takes x1.1). Stat `lowHpDamage` (up to its value at 25% hp, applied in `resolveHit`). Projectile weapons with `base.trail` leave patches. **Branches** (each starter weapon now has two evolutions; combining removes the other; weapon level 6 + 1 starsteel): Sunpiercer (Keen Eye 2), Quakebreaker (Long Reach 2), Whirlwind Cleaver (Bloodletting 2), Singularity (Quickening Gear 2), Bone Colossus (Tempered Core 2), Judgement (Keen Whetstone 2, new `judge` behavior). Existing evolutions: Radiant Halo marks (bless), Grave Legion kill frenzy, Pyre Crown embers on kill. A chest only auto-evolves when exactly one branch is ready; the forge shows "Branch: X" cards with a lock note; level-up hints name both ("Storm Volley or Sunpiercer"). Glyphs for the new weapons are lowercase letters (A-Z ran out). |
| **M27** *(done)* | Fusions and masterworks #1-#6 ([design-m26-m28.md](design-m26-m28.md) §4) | **Rules** (`game/fusion.js`, data in `data/fusions.js`): at the forge one evolved weapon (donor) is consumed into another (host) for `FUSION.cost` = 1 starsteel; the host keeps level, enhance and affixes, gains the donor's element tags and a fusion (`inst.fusion = { id, name, desc, donorId, tags, triggers, hooks }`), one per weapon, fused weapons cannot be donors. `masterworkFor` finds a named pair in either order and fixes the host; every other pair gets the generic echo (`on: 'attack', every: 3` -> `cast`, 50% of the donor's damage, named "{Host} of {Element}" or "of the {Donor}"). Fusion triggers live in `extraTriggers` and survive reforges (`forge.js#rebuildAffixes`); `weaponName(inst)` is the display name. **Effects:** `shells` (Thunderscythe: telegraphed `addBlast` hazards that burn and shock), `shatter` (Glacier Maul: a direct hit on an already frozen enemy, `run.hitFrozen`, bursts into ice), `cast` (echo: projectile-like donors throw projectiles, bolt/judge/mortar drop a pillar, the rest burst); `explode` takes an absolute `dmg`. **Hooks** read by behaviours: `minionAura` (summon: Hellhounds, Sanctum Titan), `launch` (orbit: Spear Wheel blades fly out and back, swept every frame, one hit per leg), `bend` (movement.js: Eventide Volley arrows curve toward vortices). Projectile, nova, mortar, aura, orbit and disc behaviours now report attacks too. **Masterworks:** Thunderscythe, Glacier Maul (also +50% status duration so a freeze lasts into the next slam), Eventide Volley, Hellhounds, Spear Wheel, Sanctum Titan. **Orbit fix:** orbit blades now test collisions every frame (each blade hits each enemy at most once per tick period) instead of sampling positions once per tick, which let fast blades skip enemies. **UI and save:** forge Fusion panel (masterworks first, two-tap confirm), gold HUD rim, results line, Compendium Fusions tab ("found x / 6", unfound ones are "Host + ???"), banner and `evolve` sfx on the first discovery, save v3 `discovered.fusions` (older saves migrate to an empty list). |
| **M28a** *(done)* | Masterworks #7-#12 | **Black Sun** (Singularity + Pyre Crown: vortices burn what they pull, collapse into fire plus a patch; hook `burnVortex`), **Bladestorm** (Whirlwind Cleaver + Seraph Blades: `fling` effect throws turning blades every 2nd spin), **Comet** (Sunpiercer + Glacial Bloom: chill, `shatter`, and a ring of shards when the arrow's ttl ends; hook `endBurst`, secondary projectiles carry `pr.sub` so they have no trail or burst), **Fault Line** (Quakebreaker + Stormshell Mortar: shockwaves lay shocking patches; hook `crack`; patches take a `shock` flag), **Wrath** (Judgement + Thunder Lance: pillars stay 1.5 s and `netStep` in hazards.js shocks everything on a link between live pillars every 0.35 s; hook `wrath`), **Familiars** (Prismatic Bolt + Grave Legion: three hounds cast a small bolt each every 2 s; hook `familiars`, bolt behaviour). The Compendium now counts x / 12. |
| **M28b** *(done)* | Late-game difficulty ([design-m26-m28.md](design-m26-m28.md) §6) | Last wave segment `hpScale` 2.9 -> 3.6. New elite affixes **Armoured** (+12 armour) and **Volatile** (explodes on death for `damage x 1.3` within 95 units of the player); elites spawned after `ELITE.secondAffixAfter` (420 s) carry a second, different affix (`e.affix2`; `affixDefs(e)` in data/elites.js is the way to read both). **War Party** event at minute 8 (`RUN_EVENTS.warparty`: 2 Shieldbearer elites and 6 Slingers; the brute elite moved to 495 s). New enemies from minute 3: **Splitter** (hp 40, `splits: 3` goblins on death) and **Shaman** (hp 36, `ward: { radius: 130 }`: enemies near it take half damage via `wardT`, refreshed every 0.25 s; a teal circle shows the ward). Their art is the Clubber with extras (`make-sprites.py` `EXTRA`), placeholders until an art round. Bench tuning was not part of this commit (`tools/bench.mjs` still runs and lists the new weapons). |
| **M28c** *(done)* | Difficulty and mage pass | After a mage playthrough: wave `hpScale` 1.3/2.0/3.6 -> 1.2/1.65/2.6 (segments 2-4); elite `hpMult` 8 -> 6; `ARMOR_FLOOR` 0.25 -> 0.4 (armour never takes more than 60% off a hit); Armoured elite armour 12 -> 7; Warded takes 35% less damage (was 50%) while healthy. Prismatic Bolt base 26 dmg x3 -> 40 dmg x4, cooldown 0.75 (bench L1 dps 38 -> 62); Arc Bolt base 17 -> 24 and its last level 30% -> 50% more damage (L8 dps 54 -> 88). Bot bench: mage average time 307 s -> 448 s, boss kills 0/6 -> 5/6. Numbers are first guesses from one playtest. |
| **M29** *(done)* | Build-agnostic crowd control | Three new perks that need no element (`data/perks.js`, engine in `systems/status.js`, hooks in `flushDamage`): **Chain Reaction** (rare, rule `chainReaction`: every kill by a weapon bursts for 20/32/45% of the dead enemy's max HP in radius 55/65/75, capped at 400, never from a boss; burst kills burst again down to `MAX_TRIGGER_DEPTH`), **Forked Strikes** (uncommon, rule `fork`: a depth-0 direct hit forks through `chainArc` to the nearest other enemy for 50-60% damage, 20/30/40% of hits, plain damage with no shock, cause `Forked Strikes`) and **Broad Strokes** (common, +12% area per level on every weapon). The existing **Shatter** perk no longer needs a frost weapon: it adds +8% chill chance per level so frozen kills can happen in any build. (Wildfire, Shatter and Thunderclap already existed as status payoffs; they stay gated to their element.) New damage causes `Chain Reaction` and `Forked Strikes` appear in the results breakdown. Tests `m29.test.mjs`. A 480-goblin packed crowd with Chain Reaction 3 clears in under 10 s at 0.1 ms average per tick. |
| **M29b** *(done)* | Fusions in history and results, forge tabs | **Forge:** the overlay has two tabs, Weapons and Fusion, so fusing is never below the fold. The Fusion tab pulses gold with a count badge when a fusion can be made right now, a message says so when the forge opens, and the Weapons tab shows an orange dot when an evolution is ready. With no fusion possible the tab explains why (fewer than two evolved weapons, no starsteel, or all used). **Results:** one line per fusion, `Name` plus `Host + Donor`, from `summary.fusionList` (each `run.fusions` entry now carries `host` and `donor` weapon ids). **History:** entries store `fusions: [[hostId, donorId, fusionId, name]]` (`save.js` `cleanFusions`; old entries load as empty); an expanded row lists the fused weapon under its fusion name ("Black Sun 7"), the consumed donor is no longer listed, and a Fusions line shows `Name: Host + Donor`; the collapsed row shows "✦ n fuse(s)". Test in `m29.test.mjs`. |
| **M29c** *(done)* | Version number | `src/version.js` exports `VERSION` (scheme `0.<milestone>.<n>`), shown as `v0.29.3` at the bottom of the title screen. Bump it in every commit that changes the game, start the commit message with `vX.Y.Z:`, and tell the player the version in the reply, so the build being played can be matched to a commit. |
| **M29d** *(done)* | Results screen scrolls | v0.29.4. The results overlay (class `results`) is now scrollable and its Play again / Title buttons sit in a sticky bottom bar (`.rbar`), so a long result (fusions, titles, the damage breakdown) can no longer push the buttons off a phone screen. |
| **M30** *(done)* | Fusion payloads (v0.30.0, [design-m30-m33.md](design-m30-m33.md) §3) | The generic fusion no longer echoes the donor every 3rd attack. `FUSION.echoEvery/echoFrac` and the `cast` effect are gone; instead `data/fusions.js` has `PAYLOADS` (15 entries: id, name, `frac` of the HOST's damage, sentence) and `SHAPE_PAYLOAD` (donor behavior -> payload; `payloadFor(def)` treats a spinning aura as an arc), and `validate.js` fails if any behavior has none. **Firing:** `attackTriggers` arms `inst.payloadArmed` for a fused host; the first depth-0 `hit` after it (`fireTriggers`, `game/triggers.js`) calls `firePayload` (`effects/payloads.js`), which disarms, honours `FUSION.payloadMinGap` (0.15 s, or the payload's own `gap`: smite 0.6 s) and queues everything as PROC damage at depth+1 with cause **Fusion** (`CAUSE.FUSION`, shown in the results breakdown). Payload projectiles are `sub` with `pr.depth = 1` (new field; `collision.js` passes it to `resolveHit`) so they never fire payloads. **Payloads:** shrapnel (3 shots at the nearest other enemies, else a fan), cleave (half-circle beyond the target), spin (new SPIN hazard: 3 blades circle the enemy 1.2 s), imprint (patch whose status follows the donor's element: burn, chill, shock, bless with a small heal, else plain), arc / arc2 (`chainArc`, cause Fusion, shocks only for storm donors), burst (6 shards), blast (`addBlast`, status by element), pounce (hound streak plus a small blast), smite (`addPillar`), saw, frost_step, ripple (new RING hazard, reused by M31's pulse), quake (stagger once `stunT` exists, M32), spark. Hazards gained `status` and `cause` options (`addPatch(..., shock, status, cause)`), `addSpin`, `addRing`; `addPillar` and `addBlast` take a `cause`. A generic fusion's name is `{Host} of {Element}` or, with no element, `{Host} of {Payload name}`; its text is built from the payload; the Compendium Fusions tab lists what each donor shape adds. `node tools/bench.mjs --fusions` prints the crowd-dps gain of every host/donor-shape pair (first pass: most pairs +15% to +100%, hosts that already hit everything in range gain least; the +35% to +60% target is a tuning goal). Tests `m30.test.mjs`; the old echo tests were removed from `m27.test.mjs`. |
| **M31** *(done)* | Frost Wake and Halo Pulse (v0.31.0, [design-m30-m33.md](design-m30-m33.md) §4) | Two new behaviors. **`trail`** (`behaviors/trail.js`): every `spacing` units moved, or every `cooldown` s standing still, drops a patch under the player (`addPatch(..., direct=true, look)`) and calls `attackTriggers`, so a fused trail weapon fires its payload each drop. **`pulse`** (`behaviors/pulse.js`): every `cooldown` s a follow-the-player RING (`direct=true`) grows to `range` at `speed`; `count` (+ the projectiles stat) rings leave 0.2 s apart. **Direct hazards**: a `direct` patch or ring hits with `resolveHit` at depth 0 (real weapon hits that roll statuses and fire hit triggers) instead of PROC damage at depth+1; patch hits never knock back and are limited to one per enemy per tick across overlapping patches (`src.patchSeen`). Patch statuses gained `steam` (burn + chill) and a patch `look`. Weapon ids are unchanged: `rime_orbs` is **Frost Wake** (trail, chill), `vapor_wheel` **Steam Wake** (trail, burn + chill, so Quench fires by itself), `halo` **Halo Pulse**, `radiant_halo` **Radiant Pulse** (rings bless, so the existing `hit` bless trigger marks everything they pass). Trail tick scales with the cooldown stat. Bench: single-target dps near the old weapons (Frost Wake 12/15/39 vs 8/15/67; Halo Pulse 7/11/30 vs 8/12/22), crowd clears equal or better, Saint bots 3/3 as before. `tests/m31.test.mjs`; `m14` tests place the crowd on the player for trails. |
| **M32** *(done)* | Slam, Chain Lightning, Lightning Rod (v0.32.0, [design-m30-m33.md](design-m30-m33.md) §5) | Three more behaviors; every starter now has its own shape. **`slam`** (`behaviors/slam.js`): picks the densest of the 3 nearest enemies within `range`, shows a 0.22 s shadow, then hits everything in `radius` with real weapon hits (`strike`, knockback x2.6) and `stagger`s it. Extra slams (the projectiles stat) land on evenly spaced points round you, at least 1.25 radii away. **Stagger**: enemy field `stunT`, set by `stagger(e, t)` in `systems/status.js` (bosses take half); a staggered enemy does not move, shoot, charge or deal contact damage (`enemy-ai.js`, `collision.js`); the `quake` payload uses it too. Quakebreaker's `shockwave` trigger takes `cross: true` and sends 4 waves from the crater. **`chain`** (`behaviors/chain.js`): strikes the nearest enemy as a normal hit, then jumps up to `chains` (+ the chains stat, + 2 per extra projectile) times to the nearest unstruck enemy within `jump` (area-scaled), -12% per jump, shocking each (PROC, cause Shock chains). `base.ownChain` stops the generic shock chain from doubling it (`damage.js`). **`rod`** (`behaviors/rod.js`, a projectile): when a rod weapon's projectile ends (`movement.js`, `collision.js` call `plantRod`) it plants a ROD hazard where the last enemy it struck stood (`pr.hx/hy`), lasting `rod.ttl`, zapping the nearest `zaps` enemies in `rod.radius` every `rod.every` for `frac` of the javelin's damage and shocking them; at most `rod.max + javelins - 1` per weapon (oldest goes). `rod.link` (Thunder Lance): rods 40 to `link` apart are joined by lightning that hurts and shocks once per enemy per 0.4 s (`rodLinks`, drawn from `run.rodLinks`); `rod.chill` (Stormfrost): rods chill everything inside once a second. Weapon changes: Forge Hammer 32 dmg / 1.2 s r62, Colossus Maul 80 / 1.2 s r92 stun 0.6, Quakebreaker 64 / 1.1 s r66 + cross waves; Static Rod `chains: 4, jump: 140`; javelin 18 dmg rods 25%, Thunder Lance 40 dmg rods 14% linked, Stormfrost 38 dmg rods 12% chilling. Masterworks: Glacier Maul (freeze + shatter) and Fault Line (cracks on waves) work on the new shapes. Bench: single-target dps within about +-25% of before (hammer 29/42/68 vs 26/40/64, Thunder Lance 84/169 vs 69/154, javelin 18/28/83 vs 14/21/65), crowd clears equal or better, Smith bots 3/3. Tests `m32.test.mjs`; sim/m14/m27/m30 tests moved off the hammer-as-arc and static-rod assumptions. |
| **M32b** *(done)* | Live weapon preview (v0.32.1) | `ui/weapon-preview.js`: `startPreview(canvas, weaponId, level)` builds a god-mode run (Smith, a no-op director, the weapon levelled to `level`), 26 goblins and brutes with 1e9 hp that walk at the player and are recycled to a ring when they reach it or stray, and a player who strolls in a circle (so trails, orbits and slams all work). It steps the sim at 60 Hz from `requestAnimationFrame` and draws with the run's own `drawWorld`, `drawWeapons` and `drawFx` (480 x 300 world units, the same scale as play). It stops itself when its canvas leaves the DOM or the tab is hidden, and only one preview runs at a time. `ui/compendium.js` opens one under the entry opened last (Weapons and Evolve tabs), with Lv 1 / middle / Max chips (`previewLevels`); the chips and the canvas carry their own `data-act` so they do not toggle the entry. No assets, so the offline cache only grew by one module. `.cprev` resets the global `canvas` rule in `index.html`. Tests `m32b.test.mjs`. |
| **M33a** *(done)* | Chakram branches (v0.33.0, [design-m30-m33.md](design-m30-m33.md) §6.1) | The Chakram's two evolutions, both `boomerang` weapons driven by new base params in `behaviors/returning-disc.js`. **Ricochet Saw** (`bounce: { n: 6, gain: 0.08, range: 170 }`): the disc homes on the nearest enemy it has not cut (first within 1.1x reach of you, then within `range` of the last), each bounce counted when it has cut its target, +8% damage per bounce so far, returns when nothing is left to hop to or it has flown 2x its reach. **Gyre** (`park: { time: 1.5, pull: 70 }`): at the end of its throw the disc parks, spins faster, cuts twice as often (`tickEvery / 2`) and drags every enemy within 3 radii toward it (`pullIn`, bosses at 30%), then returns; a faint ring shows the drag zone. `base.color` tints the disc; discs now draw at the weapon's current radius. Recipes: Ricochet Saw needs level 6 + the Ricochet technique at 2, Gyre level 6 + Wind Sigil at 2 (a perk `requires` may now be `tag:thrown` as well as `tag:projectile`, so a chakram build is offered Ricochet; the perk's own +bounces still apply only to projectile-tagged weapons). `chakram.evolvesInto = 'ricochet_saw'`. Single-target dps 33/96 and 44/64 (L1/L4) against the Chakram's 13/31, crowd clears 20/20 at 10 s. As a fusion donor either gives the `saw` payload. Tests `m33a.test.mjs`; `m12` now uses Static Rod as its no-evolution control (the Chakram has recipes, so it is a blocker too). |
| **M33b** *(done)* | Masterwork review (v0.33.1, [design-m30-m33.md](design-m30-m33.md) §6.2a) | `tools/masterwork-review.mjs` measures every masterwork against its host alone, both weapons kept, and the generic payload fusion (pinned ring dps and walking-horde kills). Retuned: Hellhounds (`minionAura` 46 / 0.4 s / 60%), Sanctum Titan (new hook `minionPulse { every, range, speed, damageFrac, heal, color }` in `behaviors/summon.js`: each minion sends out a non-direct RING with `status: 'bless'`; replaces its static aura), Bladestorm (`fling` every attack, 4 blades at 100%), Comet (the `endBurst` ring spawns at `pr.hx/hy`, the last enemy pierced, and its shards have `depth = 1` so they do not fire the arrow's `hit` triggers; chill 100%, +2 stacks; shatter 40%, shards 10 at 50%), Familiars (`familiars.targets`: each hound bolt strikes that many enemies, every 1.2 s at 100%), Glacier Maul (shatter 100%). Unchanged and confirmed on the new shapes: Thunderscythe, Eventide Volley, Spear Wheel, Black Sun, Fault Line (cross waves crack), Wrath (rod donor). Text: Echo Strike and Twin mention slams; Fusions tab shape labels 'Arrow' and 'Planted rod'; `design-m26-m28.md` §4.3 points to the payload design. Tests `m33b.test.mjs` (every masterwork beats its host alone in a crowd; the retuned ones do what their text says). |
| **M33c** *(done)* | Tempest (v0.33.2) | `chain` behavior gains `base.fork { gens, falloff }`: after the first (real) hit, `forkFrom` walks breadth-first, each struck enemy sending two bolts to its nearest unstruck enemies within `jump`, `gens` generations (+ extra projectiles, capped at 4, so at most 31 strikes; `inst.seen` is now 32 long), each generation x`falloff`, PROC damage cause Shock chains, shocking each. Weapon `tempest` (evolved, damage 44, cooldown 1.1, range 260, jump 150, fork 3 / 0.85); recipe `static_rod` level 6 + `static_charge` 2 + 1 starsteel; `static_rod.evolvesInto = 'tempest'`. Bench: 42 / 61 single-target (L1/L4), crowd 20/20 at 10 s. `m12`'s no-blocker control is now Seraph Blades (every starter has a recipe). Tests `m33c.test.mjs`. |
| **M34** *(done)* | Four masterworks for the new shapes (v0.34.0, [design-m30-m33.md](design-m30-m33.md) §6.2b) | Appended to `MASTERWORKS` (16 now). **Aurora Wake** (`vapor_wheel` + `radiant_halo`, hook `aurora { every, rings, gap, range, speed, damageFrac, heal }`): `behaviors/trail.js` marks each patch `bless` (a direct patch hit sets `blessT`) and every `every`th drop becomes a beacon that sends `rings` non-direct blessing RINGs from that spot. **Millstone** (`gyre` + `colossus_maul`, hook `millstone { radius, damageFrac, stun }`): when a parked disc stops (`returning-disc.js`), a 0.22 s shadow then a crater on that spot (`millStep`: `strike` + `stagger`). **Storm Saw** (`ricochet_saw` + `thunder_lance`, hook `bounceRod { radius, ttl, every, zaps, frac, max, link }`): each counted bounce `addRod`s a short linked rod at the struck enemy. **Stormspire** (`thunder_lance` + `tempest`, hook `rodFork { gens, falloff, jump, boost }`): every rod zap (`zapRod`) continues as `forkChain`. The Tempest branching moved to `systems/status.js` `forkChain` (shared by `chain.js`). Review (`tools/masterwork-review.mjs`, horde kills vs generic payload): Aurora Wake 246 vs 210, Millstone 298 vs 254, Storm Saw about level to +10% over seeds (noisy), Stormspire 305 vs 210. Tests `m34.test.mjs`; m27 counts 16; m33b's crowd reaches 245 so a parked Gyre has something to crater. |
| **M35** *(done)* | Run resume: pause, close the app, reopen on the pause screen (v0.35.0) | `game/run-snapshot.js` freezes the whole run into JSON and thaws it (`snapshotRun` / `restoreRun`): the run is a graph of plain objects, arrays, Maps, Sets and typed arrays, written once each into a node table with ids for shared references; static data (weapon, enemy, perk defs, masterwork hooks) is stored as a path into the data modules and resolved again on load; pooled entities (enemies, projectiles, pickups) are re-acquired from the new run's pools in `active` order; the fx pool, damage queue and spatial hash are dropped (the hash is rebuilt). Closure state has explicit hooks (`rng.getState/setState`, `director.getState/setState`, the `StatBlock` rebuilt from its modifier lists, the weapon instance counter); any other function in the graph makes `snapshotRun` throw, so new closure state cannot be lost silently. `save/run-save.js` keeps one snapshot under `overforged.run.v1` (separate from the meta save). `game.js`: `persistRun()` on pause, on `visibilitychange`/`pagehide`, and while a level-up, chest or forge screen is open (a forge snapshot reopens the forge); cleared on quit, finish and new run; `resumeSaved()` at boot restores to the pause screen (skipped with `?seed=`, `?class=` or god mode; an unreadable snapshot is dropped). `SNAPSHOT_FORMAT` is bumped when the encoding changes. Tests `m35.test.mjs`: after a restore the run plays on tick-for-tick identically to the one that never stopped (3 classes with every weapon for 5 minutes, masterwork and generic fusions with a boss and elites). |
| **M35b** *(done)* | Fusion payload audit and the Saws fix (v0.35.1) | A Quakebreaker of Saws showed almost no saws: the Saws payload was two plain projectiles living 0.27 s (about 90 units), drawn as the generic yellow streak, worth ~4% of the slam's damage. Now `effects/payloads.js` `saw` throws two discs at the nearest other enemies that hop `SAW_HOPS` (3) more times through the existing projectile ricochet (never the same enemy twice), `frac` 0.8 -> 0.3. Projectiles gained `look` (0 streak, 1 spinning saw disc, 2 shard), set by `shot()` and reset on spawn; `render/entities.js` draws them. Shards (`burst`): piercing, longer-lived, drawn as diamonds, `frac` 0.7 -> 0.9; Cleaving `frac` 1.0 -> 1.3. `tools/payload-audit.mjs` fusions each payload onto one evolved host per behavior in a pinned crowd and prints the share of damage it adds (all 15 now 15-35%; before: Saws 9%, Shards 10%, the rest 20-30%). Tests `m35b.test.mjs`. |
| **M35c** *(done)* | Debug lab fixes (v0.35.2) | `debug/debug.js` `give()` reuses only an unfused copy of a weapon (a fused instance keeps its fusion's hooks and payload, so reusing it showed a masterwork instead of the weapon); the evolutions row lists every `rarity: 'evolved'` weapon (it filtered out recipes with `with`, dropping the alloys); `run.debugLines()` prints `Fusion name (host+donor) LN` for fused weapons. |
| **M36** *(done)* | Class identity pass (v0.36.0) | Every class gets a `trait` in `data/classes.js` (shown on the class card and in a new Class section of the build panel) plus tag-scoped modifiers, so the same build plays differently per class. Runtime in `game/class-traits.js`, state in `run.cls` (plain data, kept by run snapshots), static def in `run.trait`. **Archer, Deadeye:** Long Shot (`classHit` in `game/hit.js`: up to +50% damage from 60 to 220 units away), Fleet (cooldown 15% more while moving, a `when: 'moving'` mod), Evasion (25% of hits miss, `systems/damage.js`), +1 pierce on projectile weapons. **Smith, Forgemaster:** Tempered Steel (`game/forge.js`: each enhance level adds +6% damage on top of 8%), Heavy Blows (10% stagger chance; staggered enemies take +40%), +30% ore, +15% area on close weapons. **Berserker, Bloodlust:** Frenzy (each kill a stack for 3 s, max 15, -2% cooldown each, read in `weapon-params.js` `param`; shown on the HUD), +15% damage on close weapons. **Mage, Attunement:** burnPower +80%, +1 chill stack, +1 chain, statuses last 25% longer, +10% damage vs each status, Arcane Ward (a 15 shield that refills after 5 s unhit). **Summoner, Soul Harvest:** every kill releases a soul (`look` 3) at one of the 4 enemies nearest the player (12 + 3/level damage, at most 24 alive). **Saint, Sanctuary:** Holy Nova every 6 s (a following blessing RING, 6 + 1.5/level damage, heals per enemy). Soul and nova damage is credited to a stand-in instance (`instanceId` -1/-2), so it shows in the breakdown as Holy Nova / Soul Harvest. `tools/bench.mjs --classes` plays four shared builds (L5, +4) on every class vs no class: each class +0..+26%, with its own build on top (Archer ranged +19%, Smith close +15%, Mage elemental +24%). Bots, 20 seeds, wins before -> after: Archer 4 -> 10, Smith 19 -> 20, Berserker 16 -> 16, Mage 3 -> 14, Summoner 17 -> 14, Saint 19 -> 19. Tests `m36.test.mjs`. |
| **M36b** *(done)* | Element-true projectiles (v0.36.1) | `render/entities.js` `drawProjectiles` draws shots by the weapon's element tags (`inst.tags`, so infusions count): frost = pale ice crystals, fire = embers with a tail, storm = jagged sparks, none = amber streak; a second element adds a coloured centre dot. Size comes from the real hit radius (`p.r`), so Wide / Colossal / area show on screen and match the hitbox. |
| **M36c** *(done)* | Element visuals on every weapon (v0.36.2) | New `render/elements.js` (`elementOf`, `accentOf`, `arcColor`): a weapon's element from `inst.tags` (frost, fire, storm, arcane; infusions count). Used by arc swings (coloured band with a bright inner edge), slam telegraphs and craters, orbit blades (unelemented light blades are now gold), aura rings and Whirlwind blades, mortar rings, shells and bursts (a second element adds an inner ring), thrown discs, summoned minions (element glow and outline) and chain bolts (`addArc` takes a colour: storm yellow, frost icy, fire orange, arcane violet). |
| **M36d** *(done)* | Visuals match stats (v0.36.3) | Rule: a stat that changes something on the field must change what you see. Audited every stat: projectile size (area, Heavy Fletching), swing / crater / blade / aura / mortar / patch / rod sizes and projectile motion (projSpeed, duration, count) already follow the real values. Fixed: summoned minions were drawn at their base radius while their hit radius grows with area (`behaviors/summon.js` now draws `param(radius)`); magnet range (`pickupRadius`) had no visual, so `render/renderer.js` draws a faint dashed ring once it is over 5% above the base 70. Not shown on purpose: pierce count, damage and crit multipliers (damage numbers carry those). |
| **M37** *(done)* | Supply crates (v0.37.0) | Sparse breakable props that drop a little help. `PROPS.crate` (`data/enemies.js`) lives in the enemy pool with `prop = 1`, so every weapon, swing and blast hits it with no special cases; `core/spatial-hash.js` `queryNearest` (the aiming query) skips props so nothing targets them, and the few queryRadius target pickers (mortar, slam, judge, payload hops, souls, ricochet) skip them too. `systems/enemy-ai.js` only fades them (`aiCd` = life, 70 s); `systems/damage.js` `flushDamage` wears one down with no statuses, numbers, kills, xp, triggers or lifesteal and calls `systems/crates.js` `breakCrate`. `data/crates.js` holds the tuning: at most 2 alive, placed just past the left/right view edge, green edge arrow ringed by time left (`render/shrines.js`). Seven `crate` events on the timeline (55, 130, 205, 280, 365, 445, 525 s) = about one per 75 s. Loot is one weighted roll: heal 3, xp 4, ore 3; the heal weight x2.5 at or below 60% hp and x4 at or below 35%, and 0 at full hp. A heart (`KIND_HEAL`, pickup kind 3) is worth 15% of max hp, never expires, and waits on the ground (not pulled in, not taken) while you are at full hp. xp = 4 gems at 4% of the next level each; ore = 3 iron. New sfx `heal`, `crate`. Snapshots keep crates and hearts (plain pool data). Bots, 20 seeds, wins: 94 total vs 93 before (per class moves are seed noise, since crates change rng use). Tests `m37.test.mjs`. |
| **M38** *(done)* | Magnet drop, longer shrines, late spawn ramp, combo-aware offers (v0.38.0) | **Magnet:** pickup kind 4 (`KIND_MAGNET`); `systems/pickups.js` `pullAll` flags every gem, ore and heart as magnetised (chests are left alone). It is a crate loot entry (`data/crates.js`, weight 2) that only rolls when 8+ gems/ore lie on the ground (`systems/crates.js` `lootWeights`). Icon: red horseshoe in a blue glow (`render/entities.js` `drawMagnets`). **Shrines:** `SHRINE.ttl` 45 to 80 s, boss shrine 90 to 150 s (`data/forge.js`). **Late ramp:** `RATE_RAMP` (`data/waves.js`, from 180 s to 600 s, x1.8 at the end) multiplies the director's spawn rate (`game/director.js`). `tools/bench.mjs` now records `late` metrics (avg enemies, share of samples with 25 or fewer alive, hp). Bots, 20 seeds x 6 classes: end 1.0 gives 94 wins and a screen-clear share of 23%; 1.8 gives 92 wins and 4%; 2.0 gives 83 and 3%; 2.5 gives 88 and 1.5% (Archer and Mage suffer). 1.8 shipped. **Combos:** `game/upgrades.js` `comboPartners(state)` maps the missing half of an owned combo recipe to its combo name. Level-up offers multiply those new-weapon candidates by `LEVELUP.comboPartnerBoost` 1.5 (partner appearance 5.3% to 8.0%) and tag them with the combo. Chests (`game/chests.js`): partner weight x`CHEST.comboPartnerBoost` 6 (about 45% of new-weapon rolls pick the partner), and with a partner available a chest of 3+ rolls can unlock a new weapon at `fusionNewChance` 0.3. Tests `m38.test.mjs`. |
| **M38b** *(done)* | Berserker sustain (v0.38.1) | Bot data showed the Berserker killing about 40% fewer enemies (3,200 against 5,300) because it spent 66% of the run below 45% hp and cannot fight from a retreat, which also meant about 250 iron per run. `data/classes.js`: lifesteal 1.5% to 2%, +2 armor (flat per-hit reduction), trait text updated. Bots, 20 seeds: 20/20 wins, kills 5,280, hurt 18% of the run, late enemies alive about 63 (was 270). Sweep in `docs/design-m39-m42.md` §3. `tools/bench.mjs` records `forges`, `hurt`, iron per run. |
| **M39** *(done)* | Star Quench (v0.39.0) | Starsteel buys guaranteed enhance attempts. `QUENCH` in `data/forge.js`: cost 1 starsteel, bands `[[13,1],[10,2],[4,3]]` (charges by the weapon's enhance level when bought; nothing below +4 or at +15), at most 9 held. `game/forge.js`: `quenchCharges`, `canQuench`, `quench`, `enhanceOdds`; `enhance` spends a charge for a certain success with no rng draw and no downgrade (ore still paid) and returns `quenched`. `inst.quench` is plain data (snapshots keep it). A fusion adds the donor's charges to the host, a combo adds the partner's to the survivor, evolving keeps them, salvage loses them (the forge warns). Forge UI: a Star Quench button under Enhance, cyan pips on the weapon card, odds read 100% while charged; new sfx `quench`; compendium entry in the Forge tab. The bench bot buys a Quench when its first weapon is at +7 or more. Priced on the M38 numbers (about 3 spare starsteel and 450 iron per run): +10 to +15 costs 3 starsteel and about 180 iron instead of about 6,800 iron of gambling. Bots, 20 seeds x 6 classes: 89 wins out of 120 (92 before; within noise), best weapon reaches +15 in 23 of 89 winning runs (26%; Archer, Mage and Summoner bots average +14.4, Smith +11.7), late screen-clear share unchanged. Tests `m39.test.mjs`. |
| **M40** *(done)* | Starforge core and four mutations (v0.40.0) | 2 starsteel, once per weapon, at max weapon level (8 base, 6 evolved), gives one mutation set by the weapon's BEHAVIOR (`data/starforge.js` `MUTATIONS`, looked up from `inst.def.behavior`, so evolutions need no migration and fused hosts keep theirs). `game/starforge.js`: `mutationOf`, `starforgeBlocker`, `canStarforge`, `starforge`, `activeMutation`. `inst.star` is plain data. **Rules:** evolving keeps the star; a combo partner's star passes to the survivor; a fusion donor's star passes to the host (two stars become one; the fusion card says so); salvage loses it (the forge warns). **Mutations** (cyan `STARFORGE.color`): projectile Comet Volley (every 5th volley is one comet at the whole volley's damage, 2.5x radius, pierce 999, `look` 4, bursting 70 radius at the last enemy it pierced via `systems/movement.js` `cometBurst`); slam Aftershock (`behaviors/slam.js`: a cyan echo lands on the same spot 0.4 s later at 60%, with no triggers and no echo of its own); orbit Counter Ring (`behaviors/orbit.js`: half as many blades at 1.6x radius spinning the other way); boomerang Double Return (`behaviors/returning-disc.js`: each disc flies out once more after it returns, to the nearest enemy, at 80%, drawn cyan). Weapons whose behavior has no mutation yet cannot be starforged (the forge hides the row). Forge UI: a Starforge button and the mutation text per card, a cyan star on the name; HUD chips get a cyan star; Compendium Forge entry; the bench bot starforges its first weapon at max level (`BOT_SPEND=none|quench|all`). Bots (Archer and Smith are the classes whose first weapon has a mutation), 30 seeds Archer: 11 wins with no spending, 11 with Quench, 9 with Quench and Starforge (within noise); Smith 20/20. Debug lab (`?debug=1`, the lab button): a Starforge row with star all held (maxes the weapon's level too), unstar all, a toggle that stars every weapon added from the lab, and +10 starsteel. **v0.40.3 measured and retuned** (`node tools/bench.mjs --starforge`: max-level weapon, star against none, mean of 5 seeds; `SF_OVERRIDE` and `STAR_ONLY` env vars run tuning sweeps): the first measurement found a bug, the comet re-hit enemies in a dense pile because a projectile only remembers its last 16 hits (about +880% in a pile), so a comet now carries a full hit set (`pr.big`). Aftershock gained only 0 to 14% against a walking crowd (the slam throws enemies out before the echo lands), so it now collapses inward: 1.3x wider, pulling enemies back, 35% damage. The comet falls off 10% per enemy pierced, keeps the weapon's trail (Sunpiercer), fires every 6th volley, size 2x, burst 40%. Result (single target / pinned crowd of 24 / live crowd of 40 walking 2,500 hp goblins): Ember Bow +5 / +31 / +80%, Storm Volley +4 / +38 / +39%, Sunpiercer +5 / +35 / +1% (its burning trail already saturates the pile), Forge Hammer +36 / +39 / +39%, Colossus Maul +36 / +44 / +32%, Quakebreaker +17 / +25 / +55%, Spirit Blades +0 / n/a / +156% (from a tiny base), Seraph Blades +0 / +92 / +15%, Chakram +75 / +48 / +19%, Ricochet Saw +81 / +75 / +53%, Gyre +66 / +64 / +29%. Known weak spot: Counter Ring's outer ring (1.7x radius) cannot reach a target standing at melee range, so it adds nothing against a lone boss and little to an evolved ring. **v0.40.4 redesign** (Dan: the comet looked like Sunpiercer; Counter Ring was weak): projectile is now **Starfall** (every 5th volley's arrows carry a cyan spark; each enemy they hit calls a star down on that spot 0.35 s later, a 40-radius blast at 45% of the arrow, drawn as a target ring and a falling streak; `behaviors/projectile.js` `callStar`, `inst.falls`, projectile field `fall`); the comet, its `look` 4, burst and falloff and the `big` hit set are gone. Orbit is now **Binary Stars** (each blade is a pair of 0.85-size halves at 85% damage spinning around their shared centre 1.1 blade radii apart, so the ring sweeps a wider band, near and far). Aftershock 30%, pull 1x. The bench's live crowd now has you walking a slow circle (a stationary player let orbit numbers swing wildly). Result (single / pinned crowd / live crowd): Ember Bow +9 / +15 / +132%, Storm Volley +9 / +18 / +47%, Sunpiercer +7 / +20 / +38%, Spirit Blades +10 / n/a / +50%, Seraph Blades +21 / +30 / +30%; slam about +31 / +33 / +26 to +77%; boomerang +66 to +81 / +48 to +75 / +42 to +68%. Ember Bow's big percentage is from a weak base (about +700 DPS). Tests `m40.test.mjs`. |
| **M41** *(done)* | Starforge, six more mutations (v0.41.0) | Aura **Shockwave** (a ring to 2x radius every 1.5 s at the aura's damage), rod **Star Mark** (every javelin leaves a ground mark that detonates after 1 s for 30%, one mark per spot), nova **Return Orbit** (spent or expired shards turn and fly back to you at 40%), arc **Afterimage** (each swing leaves a crescent that cuts again 0.5 s later at 40%), chain **Forked Chain** (a second chain from the first target with half the jumps at 70%; a branching Tempest sends three bolts per strike and keeps 95% per generation), trail **Pulse Wake** (each patch sends one ring to 2.2x its radius as it fades, at 160% of the patch). All cyan, all behavior-keyed. Measured star vs none, DPS (single / pinned crowd / live crowd): Cinder Ward +25/+64/+22, Pyre Crown +22/+28/+14, Whirlwind +23/+60/+19, Storm Javelin +10/+42/+77, Thunder Lance +8/+40/+40, Rime Shards +27/+40/+51, Glacial Bloom +53/+37/+44, Rending Axe +42/+38/+54, Reaper Axe +39/+41/+35, Static Rod 0/+45/+45, Tempest 0/+46/+53, Rime Orbs +80/n.a./+48, Vapor Wheel +62/n.a./+16 (earlier trail/aura numbers retuned from the first pass). Balance pass is M42. |
| **M42** *(done)* | Starforge, the last five mutations (v0.42.0) | Every weapon behavior now has a mutation, so every weapon can be starforged. Mortar **Cluster Shells** (each burst throws 3 bomblets, 0.35 s later, 50% damage, 0.6x blast), bolt **Seeking Bolt** (each bolt homes on one more enemy within 160 at 50%; the first also sets off the weapon's attack effect where it lands, so Singularity opens a second vortex), summon **Star-touched** (one extra, larger, glowing minion), pulse **Echoing Rings** (two cyan echoes 0.25 s apart at 50%), judge **Double Strike** (a second cyan pillar on the same spot 0.3 s later at 60%). Balance pass on the bench, DPS star vs none (single / pinned crowd / live crowd): Cinder Mortar 0/+55/+29, Stormshell 0/+47/+18, Arc Bolt 0/+55/+51, Prismatic Bolt about the same, Singularity 0/+79/+70, Bone Call +19/+17/+13, Grave Legion +17/+16/+23, Bone Colossus +86/+102/+54, Halo +46/+39/+39, Radiant Halo +46/+41/+18, Judgement +60/+60/+12. Across all 15 behaviors the typical crowd gain is about +45%; the outliers (Ember Bow live crowd +132% on a weak base, Bone Colossus single/pinned about +90–100%) sit at about 2x the median. Trimmed from the first pass: rod 70%->30%, nova 70%->40%, arc 60%->40%, bolt 80%->50%, summon damage 1.5x->1x. Not re-measured: bot win rates and a Starforged masterwork fusion at +15. |
| **M42b** *(done)* | Starforge measurement, and an Aftershock fix (v0.42.1) | Bots, 12 seeds per class, win rates with starsteel spending none / Quench only / Quench + Starforge: Archer 4/3/2, Smith 11/12/12, Berserker 12/12/12, Mage 10/8/9, Summoner 10/9/10, Saint 11/11/12. All differences are within seed noise (the bot Starforges only its first weapon once at max level): the star does not change who wins, and Archer remains the weak class (2-4/12 whatever it buys). All 36 weapons were measured star vs none (tools/bench.mjs `--starforge` with every id): crowd gain median about +45%, single-target gain 0 for the fork/mortar/bolt mutations by design. Masterwork fusions at max level and +15 (`--masterworks`; plain host / host+star / masterwork / masterwork+star, live crowd): the star multiplies a masterwork by 0.98-1.56x (Hellhounds 0.98x, Sanctum Titan 1.28x, Eventide 1.42x, Spear Wheel 1.54x, Black Sun 1.56x); a starred masterwork is +30 to +193% over the plain host in a live crowd (median about +95%). One real outlier: Glacier Maul starred was 2.7x its unstarred self because each Aftershock hit counted as a direct hit and re-fired the shatter; Aftershock hits now resolve at depth 1 (live-crowd gain +312% -> +193%, plain slam numbers unchanged). Pre-existing, not from the star: pinned-crowd masterwork gains are very large for Comet (+889%), Eventide (+376%), Black Sun (+220%) and Aurora Wake (from nothing), because a pinned crowd is the best case for area payloads; in a live crowd they are +13% to +110%. |
| **M43** *(done)* | Archer rework (v0.43.0) | Problem: the Archer won 47% of 100 bot runs (smart bot 55%) against Mage 62/83, Summoner 75/98 and the melee classes 91-98%. Diagnosis (tools/diag-class.mjs): the Archer's damage early is the same as a Mage holding the same bow; it loses mid-run because nothing in its kit worked on crowds. Its arrows struck 1.3-1.4 enemies each (the +1 pierce was nearly worthless); Long Shot and Fleet did work (hits land ~200 units out, the player is always moving). Swapping start weapons confirmed weapon plus kit, not the bot: Archer with the Forge Hammer won 30/30, Mage with the Ember Bow 26/30. Changes: **Quiver** replaces +1 pierce: every ranged weapon (projectile, thrown, bolt, mortar...) fires one more shot. **Rain of Arrows** (class trait, game/class-traits.js): every 3.5 s, with a ranged weapon held, 5 arrows (+2 per extra shot that weapon fires, max 16) fall on the thickest crowd within 240 (nearer crowds preferred, so it stays on screen and its gems land in reach), each hitting a 26 radius for 55% of that weapon's damage; drawn as falling arrows with shadows, credited as "Rain of Arrows". **Ember Bow Embers**: from level 4 (replacing +1 pierce) every arrow bursts on impact (30 radius, 35%, +15% area). Measured, 100-200 seeds each (plain / smart bot): Rain alone 46/59, Quiver alone 56/59, Rain + Quiver 65/75, + Embers 69/81, shipped (240 reach) 69/75. Tested and rejected: faster bow (49/63), wider arrow fan (13/30 in the first pass), a flat +20% damage (63% at 30 seeds; treats the symptom). |
| **M43b** *(done)* | Archer recheck, an Embers cascade fix, bench tooling (v0.43.1) | Bug: a weapon's `hit` triggers also fired on its own explosions' hits, so Embers set off embers up to the trigger depth limit (n^3 blasts in a dense crowd: the bow's live-crowd DPS read about 37x without Embers). Triggers now take `direct: true` (only depth-0 hits); Embers uses it and was retuned 35% -> 20% (bow live-crowd DPS 249 -> 766, under Storm Volley's 1,207, so evolving still pays). Rain of Arrows retuned every 3.5 s / 5 arrows -> 3 s / 6 arrows (max 18). Archer now (200 seeds, plain / smart bot): 67% / 77%, against Mage 60/85 and Summoner 74/99 (it was 47/55 before M43; the 69/75 reported for v0.43.0 was inflated by the cascade). Weapon measurements in tools/bench.mjs (`--weapons`, `--starforge`, `--masterworks`, the new `--dps`) now use no class at all (they used the Archer's kit, which since M43 adds Quiver and the rain); BENCH_CLASS=<id> puts a kit back. New: `tools/variants.mjs` (spec-driven variant runner, win rates with standard errors) and `docs/balance-playbook.md`. |
| **M44** *(done)* | Mage rework: Spellburst, a two-target bursting Arc Bolt (v0.44.0) | Diagnosis: Arc Bolt did 86% of the Mage's damage as direct hits on 1-2 enemies (burn 1%, shock 7%), no area; at 10:00 it still did 58% and the Mage died to crowds after 7:00 (median death 448 s). Swap tests (100 seeds, plain / smart): Mage with Forge Hammer 100% / 100%, with Ember Bow 79% / 77%, own bolt 62% / 83%: the weapon, not the kit. Shipped: **Spellburst** (Mage trait, `systems/status.js`): an enemy that dies burning, chilled/frozen or shocked bursts once per element (radius 55, 25% of its max HP each, cap 300, bosses excluded, depth-limited like Shatter), drawn in the element colours; its hits are proc hits so they roll the Mage's element chances. **Arc Bolt**: base 2 targets and a `direct` on-hit burst (radius 36, 30%); **Prismatic Bolt** gets a larger one (46, 50%) so evolving stays an upgrade. Numbers (200 seeds, plain / smart, `BOT_SPEND=none`): Mage 62% / 83% -> 76% / 94-97%; Archer 67% / 77% and Summoner 74% / 99% unchanged. Rejected: burst only (62 / 88), two targets only (57 / 90), Spellburst only (62 / 90), Spellburst 15% (53 / 84, too weak), 35% (78 / 91, no gain over 25%), bigger bursts (no gain). Arc Bolt max-level DPS (class-neutral, 3 seeds): single 86 -> 111, pinned crowd 259 -> 549, live crowd 259 -> 1919 (noisy column; win rates are the arbiter); Prismatic 113 -> 167 / 1158 / 5351. Tests `tests/m44.test.mjs`, `m42` seeking-bolt test counts bolts without Arc Bolt's burst. |
| **M44b** *(done)* | Shot shapes: the weapon picks the shape, the element is a skin (v0.44.1) | Fire shots were drawn as ember balls because the element chose the whole shape. Now `render/entities.js` `shapeOf` reads the weapon's `shot` (`arrow`, `javelin`, `shard`) or, failing that, its behavior (`projectile` -> arrow, `rod` -> javelin, `nova` -> shard); the cached result lives on the weapon def. Arrows: neutral shaft and fletching, pointed head; javelins: thicker shaft, leaf blade; shards: the old crystal. The element only colours the head (frost blue, fire orange, storm yellow, none steel) and adds a trail (ice flecks, embers, a spark zigzag). Weapons with no shape (chakram, saws, fusion shots, souls) keep the old element streaks. One batched path per layer and element. Visual only: hitboxes and damage unchanged, no balance run. A glow disc at the tip was tried and dropped (read as a dull blob over the head). |
| **M44c** *(done)* | One shot system: discs, blades, falling arrows, several elements (v0.44.2) | All shot drawing moved to `render/shots.js` (re-exported by `entities.js`), shape by weapon and element as skin, no more element-shaped streaks. New shapes: **disc** (chakram, Gyre, Ricochet Saw, fusion saws: steel blades, the elements as arcs of the rim, split into one arc per element), **blade** (Bladestorm and any weapon without a shape: steel kite, element edge). Fusion volleys are arrows (`look` 4), Bladestorm blades `look` 5, saws 1, fusion shards 2 (now element skinned), Summoner souls 3 (a wisp, unchanged by design: no element). **Several elements:** the first element (frost, fire, storm) colours the head, every further one is a band behind the head (across the middle of a shard) and every element leaves its own trail side by side; the Starforge star (Starfall arrows, Return Orbit shards) takes the head in cyan and the element moves to a band. **Rain of Arrows** and **Starfall** now draw their falling arrows with the same arrow shape (steel head for the rain, cyan head and star glints for Starfall). Visual only. Test `m35b` stale-look test now expects look 4 for shrapnel. |
| **M44d** *(done)* | Area effects you can see (v0.44.3) | Audit: every area effect drew the same thin 0.22 s outline ring (a `puff`), so explosions of every element, Chain Reaction and Overload were nearly the same orange, a Forked Strike was the same yellow arc as a shock chain, and Wildfire had no cue at all. New fx kind `burst` (`render/fx.js` `addBurst`): a flash, a bright core and a thick ring growing to the effect's REAL radius in 0.32 s, plus a mark per effect: plain rays (explosions, in the weapon's element colour; Spellburst, one per element; rain landings; Embers), pink sparks (Chain Reaction, the only pink in the game), ice shards (Shatter), lightning cracks (Overload, Thunderclap), rising steam (Quench). Forked Strikes arcs are green (`ARC_FORK`) with a mark where the strike splits; Wildfire marks the dying enemy and draws an orange ember thread to each enemy it lights. At most 36 bursts are alive at once (`world.fxBursts`), so a chain reaction through a packed crowd stays readable and cheap. Visual only. Tests in `m44.test.mjs`. |
| **M44e** *(done)* | Status looks: shaded bodies and outlines (v0.44.4) | Enemies under a status used to wear a coloured circle. Now `render/sprites.js` `getSprite(id, flash, status)` returns the sprite shaded in the colour of its most important status (frozen, then burning, shocked, chilled; tints 36-50%, so the art shows through) and every other status is an outline in its own colour, the next one out further (frozen hides chilled). Looks are built lazily per status mask and cached on the sprite, drawn padded (`canvas.pad`) so outlines fit. Enemies with no art (tests) keep the old rings. A frozen status disc fill and rings are gone for sprites. Blending the colours was tried and rejected: chilled + shocked came out an unreadable olive. Visual only. |
| **M44f** *(done)* | Melee looks: axe swings and hammer craters (v0.44.5) | `render/melee.js` draws Rending/Reaper Axe swings as a haft and bearded head whipping through the cone (direction alternates per swing) with a tapered smear and edge sparks, and Whirlwind Cleaver as three cleavers on hafts dragging smears. Slams show a maul falling onto the telegraph, then a `BURST_SLAM` crater (pit, ground cracks, shockwave, rubble; 0.55 s). Element colours the smear and ring. Arc `SWING_TIME` is 0.26 s (drawing only; hits land on the first frame). Visual only. |
| **M44g** *(done)* | Damage number scale experiment (v0.44.6, default on v0.44.7) | Defaults are now `numscale` 30 and `numfx` on (`?numscale=1&numfx=0` restores true numbers). `?numscale=N` (any positive number) multiplies the damage numbers SHOWN by `render/fx.js` `addDamageNumber`; the damage dealt is untouched, so the sim, bots and balance are unaffected. Numbers of 10,000 and up abbreviate (12.4K, 1.2M ... Qi). `numfx` also makes crit text bigger (28px), lets numbers linger 1.6x and raises the live cap from 60 to 100. `setNumberStyle(scale, big)` is also on `window.__overforged` to change it live. Frame time measured identical to baseline in a 120-enemy crowd (vsync-bound headless). |
| **M44h** *(done)* | Weapon looks: auras, orbits, mortars, Judgement, trails (v0.44.8) | `render/auras.js` and `render/melee.js`. Ember ward (Cinder Ward, Pyre Crown: heat field, counter-turning rune rings, rising embers, flame crown, burn-tick snap), Halo charge glow, light-ring look for every expanding ring (Halo, Shockwave, Pulse Wake; `hazards.js` RING). Orbiting blades are daggers pointing along travel with a smear (Spear Wheel turns them outward; Binary Stars pairs are cyan blades). Mortar shells fly a lob with shadow, trail and fuse spark, landing mark with turning ticks (shells carry visual-only `ox, oy`). Judgement: sigil telegraph, light column, impact ring. Trail patches (Frost/Steam Wake, Sunpiercer's line, Fault Line) share a `chain`/`ci` (`newChain`, `linkPatch` in hazards.js; projectiles reset them at spawn) and are filled as ONE tapering ribbon by `drawPatchChains`, with per-look marks (frost, steam, flames, crackle); other patches stay blobs. Visual only. |
| **M44i** *(done)* | Singularity far vortex, Gyre parks at the crowd (v0.44.9) | Singularity's vortex trigger has `minDist: 150`: `effects/index.js` `farSpot` opens it on the densest enemy cluster at least max(minDist, 1.3 x radius + 24) from the player (within 340), or pushes the aimed spot out to that distance, so the pull drags the horde away from you instead of onto you. Damage fraction 2.2 -> 4.0 to keep its DPS (live 3963 -> ~4000, single 162 -> ~250). Gyre's park is `onHit: true, overshoot: 30`: the disc stops 30 units past the first enemy it cuts and spins there; a throw that meets nobody comes straight home instead of spinning in an empty field. Damage 40 -> 18 because parking in the crowd tripled its live DPS (2315 -> 7334 at 40; 18 lands near 5000, level with Prismatic Bolt); single-target 160 -> ~200. Mage bots unchanged (74 / 97 at 100 seeds). Specs: `tools/specs/gyre-sing*.json`. |
| **M44j** *(done)* | Ground shockwave look (v0.44.10) | `render/auras.js` `drawWave` draws every wave hazard (Quakebreaker's cross, Fault Line, shockwave triggers) as a forward-bulging crescent crest with a bright lip, rubble thrown up behind it and dust at the shoulders (a ground crack along the path was tried in v0.44.10 and removed in v0.44.11: it read as a jagged yellow line). Waves now remember their start (`x0, y0`, visual only). |
| **M44k** *(done)* | Elite looks: a body and a signature per affix (v0.44.12) | The gold ring is gone. `render/elite-art.js` holds hand-drawn woodcut SVG bodies `elite_<affix>` (Swift cutthroat, Armoured knight, Volatile bomber, Regenerating mossy troll, Warded warden); `entities.js` `spriteIdOf` picks the first affix's body for an elite (the second affix is overlay only). `render/elites.js` draws the affix effects: Swift afterimages and streaks, Warded faceted bubble while above `untilHpFrac` (flickers just before dropping, gone below it), Regenerating plus-sign motes and a halo while actually mending, Armoured plates (overlay only when the body is not its own) with sparks on hit, Volatile glow, cracks and embers that quicken as hp falls and a dashed blast-radius ring under 30% hp. The affix name stays above the elite in the affix's colour. `sprites.js` merges the elite art into `SPRITE_ART`. Hit boxes and stats unchanged. |
| **M44l** *(done)* | A second boss: the Ashen Seer at 8:00 (v0.44.13) | The Warlord moves from 5:00 to 4:00 (the elite at 4:00 moved to 4:30, the war party from 8:00 to 6:45) and the **Ashen Seer** arrives at 8:00. `ai: 'boss_caster'`, `caster {range, every, windup, count, countRage, rageAt, rageSpeed, radius, spread, fuse, stagger, lead, damage}` in `data/enemies.js`; `enemy-ai.js` `casterStep` keeps it at about 300 units (backs off inside 0.75x range, closes beyond), stands and flashes for `windup`, then `systems/boss-zones.js` `castMeteors` marks circles in `run.bossZones` (the first aimed `lead` seconds ahead of a moving player, the rest scattered around), each filling over `fuse` and then blasting for `damage` x damageScale; below `rageAt` hp it casts 1.5x as often and drops 7 circles instead of 4. Sprite in `render/boss-art.js` (merged in `sprites.js`). Bots cannot dodge telegraphs, so damage was tuned with `ENEMY_OVERRIDE` (new in `bench.mjs`/`variants.mjs`, spec `boss2.json`) to cost the bots about 5 to 10 win-rate points against the old timeline (100 seeds). 6000 hp / 45 damage cost 30 to 45 points, so it ships at 3500 hp / 18 damage. |
| **M44m** *(done)* | Crusher, a late heavy enemy (v0.44.14) | New regular enemy from 6:00 (`WAVES` 360-600: 0.02 to 0.08 per s, on top of the late rate ramp). `data/enemies.js` `crusher`: hp 300, armour 6, speed 38, radius 24, `ai: 'slammer'`, `slam {every 6, windup 0.9, radius 95, damage 12}`. `enemy-ai.js` `slamStep`: walks at you; within 1.6x the slam radius and off cooldown it stands still, flashes, and `boss-zones.js` `castSlam` marks a circle on itself in `run.bossZones` that blasts at the end of the windup (reuses the Seer's telegraph and blast). Sprite `crusher` in `render/boss-art.js`. Bench (100 seeds, plain bots, vs the v0.44.13 timeline): at 0.05 to 0.22 per s, 400 hp and 22 damage it cost 30 to 60 points for ranged classes; a harmless slam alone cost about 7 (it is the hp and armour), so rate and slam damage came down to cost about 6 to 13. |
| **M44n** *(done)* | Grafts are now Fusions (v0.44.15) | Everything called a graft is a fusion (verb: fuse): the forge tab and button text, the compendium tab, results and history, `game/fusion.js` (`fuse`, `fusionOptions`), `data/fusions.js` (`FUSION`), `inst.fusion`, `CAUSE.FUSION` (the damage breakdown reads "Fusion"), and the CSS classes. The older meaning of "fusion" (an evolution recipe with `with`, which needs two base weapons) is now a **combo**: `comboPartners`, `LEVELUP.comboPartnerBoost`, `CHEST.comboPartnerBoost`, "Combine with" in the forge. Saves written before the rename still load: `normalize` reads `discovered.grafts` and a history entry's `grafts` when the new keys are absent (tested in `m8.test.mjs`). Older milestone rows and design docs were renamed too, so they say "fusion" where the code of the day said "graft". |
| **M44o** *(done)* | Live previews for fusions in the compendium (v0.44.16) | An opened, discovered masterwork on the Fusions tab shows the same live canvas as weapons (`ui/weapon-preview.js` `startPreview(canvas, hostId, level, pair)`): host and donor at max level, one starsteel, fused with the real `fuse()`, so you see the masterwork's own effect. `compendium.js` entries carry `fusePair: [host, donor]` only once found (an undiscovered masterwork stays a secret, no preview). `ui/compendium.js` reads `data-pair`; `pv:` acts now take the whole id because fusion ids contain a colon. Tests in `m44c.test.mjs`. |
| **M44p** *(done)* | Builds reviewed and extended to every class (v0.44.17) | `data/builds.js` now has 3 to 4 builds per class (Archer 4, Smith 3, Berserker 3, Mage 4, Summoner 3, Saint 3; 20 in all), each with `passives` and an `end` (the finished weapons after evolving, and the masterwork `fuse` pair if it has one), so a build now leads through evolutions and fusions. The compendium shows `Finished:`, `Fusion:` and `Passives:` lines. **Chosen by bench:** `bench.mjs --builds --late` sets up each candidate's end state (evolved weapons L6, perks L3, fusion applied) and clears 300 enemies at 10x hp and a 20000 hp boss; 28 candidates were tried, and the ones that were clearly slower than their class baseline were dropped (Splinter Volley, Storm Chain, Millstone, Bladestorm, Wrath and a few more). Bench caveats: it is a stationary, un-enhanced, no-trait duel, so melee classes look weak on the boss column. **Found on the way:** a weapon with `class` set is offered only to that class, so three masterworks cannot be made by any class (Eventide Volley: Archer + Mage evolutions; Familiars: Mage + Summoner; Sanctum Titan: Summoner + Saint). New tests (`m44c`) check every build is reachable by its class: its weapons, each evolution's technique and passive, and the fusion pair. The old tip that mentioned Frost Wake now says Vapor Wheel. Also fixed the bench tools' imports, which the fusion rename (v0.44.15) had broken. |
| **M44q** *(done)* | Three masterworks redesigned so every one can be made (v0.44.18) | Eventide Volley, Familiars and Sanctum Titan each needed evolved weapons from two different classes, so no class could make them. Each now pairs weapons one class can reach, and the effect and name follow the new pair. **Stormfall** (Storm Volley + Stormshell Mortar, Archer): every other volley drops a storm shell on the target and a ring of four around it, bursting after 0.45 s, burning and shocking (`stormfall` effect in `effects/index.js`). **Seraph Titan** (Bone Colossus + Seraph Blades, Summoner): each minion wears a wheel of five blades that cut and bless what is near it, plus the kill heal (`minionBlades` hook; blades are drawn in `behaviors/summon.js`). **Stormfangs** (Grave Legion + Stormfrost Lance, Summoner): each hound fires a piercing lance at the nearest enemy every 1.2 s, with chill and shock (`minionLance` hook). Ids are `stormfall`, `seraph_titan`, `stormfangs`. Removed with the old effects: the `bend` projectile hook, `minionPulse`, and Familiars' hovering hounds in `bolt.js`. Three new builds use them (Archer Stormfall, Summoner Stormfangs and Seraph Titan), so the Summoner has five and the Archer five. Tuned with `bench.mjs --builds --late` and `tools/masterwork-review.mjs`; a new test fails if any masterwork needs weapons from two classes. |
| **M44r** *(done)* | Masterwork builds stay hidden until the masterwork is found (v0.44.19) | A build whose `end.fuse` is a masterwork named its pair, so the Builds tab gave away undiscovered masterworks. `compendium.js` `buildVisible` hides those builds (and their "Used in" lines on weapon and technique entries) until the masterwork is in `discovered.fusions`; builds with no fusion always show (9 of 20 at the start). Test in `m44c.test.mjs` checks no masterwork name appears in the builds text before discovery. |
| **M45a** *(done, v0.45.1)* | Retune the generic tempers | Honed raised from 20% to 30% more damage. `bench.mjs --tempers` (one weapon per behavior) shows Honed 30% and Hasted -20% about even (1.30 vs 1.28 single, 1.28 vs 1.23 live); Mighty and Vast already split single-target vs crowd. Spec: `docs/design-m45.md`. |
| **M45b** *(done, v0.45.2)* | Tempers by weapon shape | Every behavior gets its own +5 and +10 temper pair (projectile Longshot/Barrage, slam Crushing/Flurry, orbit, aura, summon, bolt, trail/mortar...) so each choice is a playstyle, not a flat bump. Spec: `docs/design-m45.md`. |
| **M45c** *(done, v0.45.3)* | Affix cleanup and new affixes | Merge Keen and Brutal, replace Shoving with Staggering, make Heavy a `more` bonus. New: Lingering, Broad, Swiftshot, Bane, Seeking, Packmaster, and unconditional epics Echoing, Overcharged, Hunter's Mark, Prismatic. Spec: `docs/design-m45.md`. |
| **M45d** *(done, v0.45.4)* | Legendary tier | One legendary slot per weapon at +10, bought with starsteel, pick 1 of 3 by shape: Wellspring, Overflow, Starfall, Bloodpact, Twinned. Spec: `docs/design-m45.md`. |
| **M45e** *(done)* | Forge review | Bot bench before and after M45a-d, 6 classes, plain and smart bots, 100 seeds: average win rate 73.3/86.5 (plain/smart) to 82.0/90.0, nearly all from Archer, Mage and Summoner; Smith, Berserker and Saint were already at the ceiling. Costs left alone by decision. Bench modes `--tempers`, `--affixes [--legendary]` and the `BOT_FORGE=full` bot are in the playbook. Spec: `docs/design-m45.md`. |
| **M45f** *(done, v0.45.5)* | Archer sustain | Bot sweeps showed Archer's gap was survival, not damage (pierce and Rain of Arrows buffs were all noise; +20 HP and regen 0.3/s moved the bots 58/69% to 85/95%). Archer now has +20 max HP and 0.3 regen (`data/classes.js`); sweep specs `tools/specs/archer-pierce-rain.json` and `archer-sustain.json`. |
| **M45g** *(done, v0.45.6)* | Summoner regen, side screens | Summoner gets 0.3 regen (bots 54/93% to 78/99% plain/smart). Level-up and forge screens gain Build and Compendium buttons in a header row (side screens, kept away from Reroll/Banish/Return) that return to the screen they came from. Return to battle asks first ("You can still afford: ...", then Leave anyway) while an enhance, reforge, quench, starforge, legendary, evolution or fusion is affordable. |
| **M45h** *(done, v0.45.7)* | History duplicate fix | A run recorded twice (identical in everything but the timestamp) is now counted once, and an existing duplicate is dropped on load with the run, win and boss counters corrected. |
| **M45i** *(done, v0.45.8)* | Compendium readability and live progress | Entries are structured sections (paragraph, label/value facts, level ladder, evolution recipe boxes, used-in chips) instead of a text block. Opened from a run (pause, level-up, forge) it sorts what you hold first, marks owned weapons/techniques/passives, and shows each evolution or fusion as a checklist: met, short (yours is 5, need 6) or missing (grayed). On the Weapons tab an owned weapon shows only "Owned · Lv N" and a chip per evolution (with progress) that jumps to its Evolve entry, where the requirements live. Filters collapse behind a toggle. An open entry's title row is pinned while its body scrolls and is the only open/close target; opening or closing scrolls that entry's title to the top of the list. The build screen shows an evolution chip (with progress) per weapon that opens that weapon's Evolve entry, plus a Compendium button; closing the compendium returns to the build screen at the same scroll (v0.45.9). |
| **M45j** *(done, v0.45.10)* | Effects volume | A separate Effects volume slider (title and pause, above the Music controls) scales the sound-effects bus only; saved as `sfxVolume` (default 1 = the old level), plays a blip on release. The Sound button still mutes everything. |
| **M45k** *(done, v0.45.11)* | History layout | History rows lost their padding when compendium entries were restyled (v0.45.8). They now use the same layout: a padded, pinned title row that is the only toggle, label/value facts (weapons and fusions one per line), and a full-width Same seed button. |
| **M45l** *(done, v0.45.12)* | History weapon tiles | Each weapon in an expanded history row is a tile: border colour = tier (common grey, uncommon green, evolved orange, fused purple), icon = type (sword close, arrow ranged, paw summon), element dots, and marks for enhance level, starforge and legendary. Runs now store a per-weapon `gear` array (enhance, star, tempers, effects, legendary); older entries show tier and type only. Tempers and effects are stored but not drawn. |
| **M45m** *(done, v0.45.13)* | Compendium cross-links | Any mention of a weapon, evolution, fusion, build, technique or passive in an open entry links to its entry: weapon/technique -> builds that use it; evolved weapon -> fusion rules and found masterworks; masterwork -> host and donor; build -> every weapon, technique, passive and its finished fusion; recipe boxes link the weapons and the technique/passive they need. Undiscovered masterworks are never linked. A Back button (to the entry you came from) returns to the previous tab, open entries and scroll. |
| **M45n** *(done, v0.45.14)* | Forest floor | The grid is replaced by a gridless woodland floor (`src/render/ground.js`): soft dark olive tones, dirt paths, fallen logs, leaf litter, ferns, stones; greens kept muted so the green goblins stay readable. Procedural from a cell hash, so infinite and stable. Decoration only, no collision. `?ground=forge\|frost\|cinder\|ruins\|crystal\|catacomb` tries other floors, `?ground=grid` is the old grid. |
| **M45o** *(done, v0.45.15)* | Shield bubble | The player's shield (Mage Arcane Ward, any shield) is now a glassy bubble (`src/render/shield.js`): clear centre, bright rim, a sliding glint, rune ticks for each quarter left, flicker when low, a flash when it soaks a hit, shards when it breaks and a closing ring when it refills. Replaces the plain blue circle. |
| **M45p** *(done, v0.45.16)* | Forge anvil art | The title/results/in-game forge sprite is redrawn as a proper anvil (horn, face, waist, foot) on a stone plinth with a layered flame, steel and stone gradients and a lighter ink wobble. Hand-drawn in `tools/art/shrine.svg`; `tools/make-sprites.py` uses any `tools/art/<id>.svg` in place of the canvas symbol. |
| **M45q** *(done, v0.45.17)* | Gems survive a screen clear | When the 600-slot pickup pool filled (a fusion clearing the screen), every new gem was merged into the gem farthest from the player: the XP was kept but showed as no drop and sat on one far-off gem. Now past 85% full a gem joins the nearest pile within 48 units, and if the pool is full with nothing near the XP is paid out at once (as ore is). No XP is lost either way. |
| **M45r** *(done, v0.45.18)* | Service worker deletes only its own caches | Games published under the same github.io origin share cache storage, and `sw.js` used to delete every cache that was not its own when it activated, so this game and Overclocked (danjaekim/overclocked) would have wiped each other's offline copy. A `PREFIX` (`overforged-`) now scopes the cleanup: activate deletes only prefixed caches other than the current `CACHE`. Test `sw.test.mjs` loads `sw.js` in a stub worker and checks that other games' caches survive. |
| **M45g** *(done, v0.45.6)* | Summoner regen, side screens | Summoner gets 0.3 regen (bots 54/93% to 78/99% plain/smart). Level-up and forge screens gain Build and Compendium buttons in a header row (side screens, kept away from Reroll/Banish/Return) that return to the screen they came from. |

After M8: see `docs/roadmap.md` (M9 onward: statuses, perks, elites and chests, reforge choice, more weapons and evolutions, balance, remaining classes).

---

## 11. How to extend (cheat sheet for agents)

- **New weapon with existing behavior** → add to `data/weapons.js`. Run tests (validation). Done.
- **New behavior** → `src/behaviors/<name>.js` + one line in `behaviors/index.js`. Read only via `ctx.stat()`; never touch StatBlock internals.
- **New passive/title/affix** → data only. If it needs non-stat behavior, add an effect to `effects/` and reference it via `triggers`.
- **New stat** → add to `STATS`, then read it where relevant. Don't hardcode numbers in systems that should be stats.
- **New condition** → `stats/conditions.js`.
- **New enemy / wave change** → `data/enemies.js`, `data/waves.js`.
- **Balance change** → data only; note it in the commit message.
- Keep files small (< ~300 lines). Prefer adding a file over growing one.
- Update this document when an interface here changes.

---

## 12. Decisions

Closed on 2026-10-12. Changing any of these means updating the sections cited.

| Question | Decision | Where |
|---|---|---|
| Orientation | **Portrait only**, phone-first. Desktop shows the same portrait-shaped view. | §1, §8 |
| Run length | **10 minutes**, kept short for mobile. One constant (`RUN.length`) rescales the whole timeline if it feels wrong. | §5.8 |
| Enhance failure | **Never destroys a weapon.** Worst case is losing one enhance level above +7 (tunable, can be set to 0). | §6.5 |
| Forge access | **Via shrine pickups**, from M6. Replaces timed auto-opens in the default timeline. | §6.3 |

Deferred beyond M8: Mage, Summoner and Saint, more enemies and biomes, balance passes, real art and music, gold, reforge locks, title triggers, the 1.3x offer weight for recipe progress.

Tuning knobs to revisit after playtesting (not blockers): `RUN.length`, `ENHANCE.downgradeChance`, shrine count and `ttl`.
