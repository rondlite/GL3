import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import mccodesAttributes from "@gl3/plugin-mccodes-attributes";
import { playerStats } from "../src/db/schema/index.js";
import { testDb } from "./helpers/db.js";
import { registerVerifiedPlayer } from "./helpers/register.js";
import { bootTestServer } from "./helpers/server.js";

/**
 * A missed shot costs will (`combat.miss.will_cost`, gl3 seeds 10). Will is
 * composure: it feeds crime formulas (`WILL`) and gym yield, so a reckless
 * fighter pays in both. Flat, clamped to the pool — the shot has already
 * fired and the bullet is already gone, so an empty pool is never a 409 —
 * and a no-op wherever no plugin declares the pool, so an install without
 * `mccodes-attributes` is byte-identical.
 */
const { db, sql: conn } = testDb();

afterAll(async () => { await conn.end(); });

async function insertItem(effects: Record<string, unknown>, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO items (id, name, item_type, effects)
    VALUES (${id}, ${name}, ${"weapon"}, ${JSON.stringify(effects)}::jsonb)`);
  return id;
}

async function seedSettings(cost: string): Promise<void> {
  await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
  await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.miss.will_cost', ${cost}) ON CONFLICT (key) DO UPDATE SET value = ${cost}`);
}

/** Two players in one town; the attacker holds `gun`, both level 100 (no newbie shield). */
async function arena(
  server: Awaited<ReturnType<typeof bootTestServer>>,
  gunEffects: Record<string, unknown>,
  ip: string,
  attackerWill?: number,
) {
  const attacker = await registerVerifiedPlayer(server, { remoteAddress: `${ip}.1` });
  const victim = await registerVerifiedPlayer(server, { remoteAddress: `${ip}.2` });
  const town = crypto.randomUUID();
  await db.execute(sql`INSERT INTO locations (id, name) VALUES (${town}, ${"Missville"})`);
  const gun = await insertItem(gunEffects, "Test Gun");
  await db.update(playerStats).set({
    locationId: town, weaponItemId: gun, exp: 1000n, level: 100, bullets: 5n,
    ...(attackerWill !== undefined ? { will: attackerWill } : {}),
  }).where(eq(playerStats.playerId, attacker.playerId));
  await db.update(playerStats).set({
    locationId: town, health: 500, exp: 1000n, level: 100,
  }).where(eq(playerStats.playerId, victim.playerId));
  return { attacker, victim };
}

async function willOf(playerId: string): Promise<number> {
  const [row] = await db.select({ will: playerStats.will }).from(playerStats).where(eq(playerStats.playerId, playerId));
  return row?.will ?? -1;
}

async function attack(server: Awaited<ReturnType<typeof bootTestServer>>, a: { token: string }, v: { playerId: string }) {
  return server.app.inject({
    method: "POST", url: `/api/combat/attack/${v.playerId}`,
    headers: { authorization: `Bearer ${a.token}` },
  });
}

describe("combat: a miss costs will", () => {
  it("a missed shot spends the configured will; bullets are still spent", async () => {
    await seedSettings("10");
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 0, accuracy: 0, damageMin: 1, damageMax: 1 }, "10.31.1");
      expect(await willOf(attacker.playerId)).toBe(100);
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().hit).toBe(false);
      expect(res.json().backfire).toBe(false);
      expect(res.json().bulletsSpent).toBe(1);
      expect(await willOf(attacker.playerId)).toBe(90);
    } finally {
      await server.close();
    }
  });

  it("clamps to the pool — a miss on 5 will leaves 0, never a 409", async () => {
    await seedSettings("10");
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 0, accuracy: 0, damageMin: 1, damageMax: 1 }, "10.31.2", 5);
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().hit).toBe(false);
      expect(await willOf(attacker.playerId)).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("a hit costs nothing", async () => {
    await seedSettings("10");
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 0, accuracy: 100, damageMin: 1, damageMax: 1 }, "10.31.3");
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().hit).toBe(true);
      expect(await willOf(attacker.playerId)).toBe(100);
    } finally {
      await server.close();
    }
  });

  it("a backfire is not a miss and costs nothing", async () => {
    await seedSettings("10");
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 100, accuracy: 100, damageMin: 1, damageMax: 1 }, "10.31.4");
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().backfire).toBe(true);
      expect(await willOf(attacker.playerId)).toBe(100);
    } finally {
      await server.close();
    }
  });

  it("is a no-op when the setting is absent (default 0)", async () => {
    await db.execute(sql`INSERT INTO settings (key, value) VALUES ('combat.cooldown_seconds', '1') ON CONFLICT (key) DO UPDATE SET value = '1'`);
    await db.execute(sql`DELETE FROM settings WHERE key = 'combat.miss.will_cost'`);
    const server = await bootTestServer({ plugins: [mccodesAttributes] });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 0, accuracy: 0, damageMin: 1, damageMax: 1 }, "10.31.5");
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().hit).toBe(false);
      expect(await willOf(attacker.playerId)).toBe(100);
    } finally {
      await server.close();
    }
  });

  it("is a no-op where no plugin declares the will pool (v2 profile)", async () => {
    await seedSettings("10");
    const server = await bootTestServer({ profile: "v2" });
    try {
      const { attacker, victim } = await arena(server, { backfireChance: 0, accuracy: 0, damageMin: 1, damageMax: 1 }, "10.31.6");
      const before = await willOf(attacker.playerId);
      const res = await attack(server, attacker, victim);
      expect(res.statusCode).toBe(200);
      expect(res.json().hit).toBe(false);
      expect(await willOf(attacker.playerId)).toBe(before);
    } finally {
      await server.close();
    }
  });
});
