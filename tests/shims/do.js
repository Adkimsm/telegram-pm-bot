// In-process Durable Object namespace: one instance per name, with a storage
// map and a manually-fired alarm so tests control the debounce timing.
export class Storage {
  constructor() { this.map = new Map(); this.alarmAt = null; }
  async get(k) { return this.map.get(k); }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { return this.map.delete(k); }
  async deleteAll() { this.map.clear(); this.alarmAt = null; }
  async setAlarm(t) { this.alarmAt = t; }
  async deleteAlarm() { this.alarmAt = null; }
  async getAlarm() { return this.alarmAt; }
}

export class DONamespace {
  constructor(Class, env) { this.Class = Class; this.env = env; this.instances = new Map(); }
  idFromName(name) { return { name, toString: () => name }; }
  get(id) {
    const key = id.name ?? String(id);
    if (!this.instances.has(key)) {
      const storage = new Storage();
      this.instances.set(key, new this.Class({ storage }, this.env));
    }
    return this.instances.get(key);
  }
  /** Fire the pending alarm for one instance, as the runtime would. */
  async fireAlarm(name) {
    const inst = this.instances.get(name);
    if (!inst) return false;
    if (inst.ctx.storage.alarmAt === null) return false;
    inst.ctx.storage.alarmAt = null;
    await inst.alarm();
    return true;
  }
  async fireAllAlarms() {
    let n = 0;
    for (const name of [...this.instances.keys()]) if (await this.fireAlarm(name)) n++;
    return n;
  }
}
