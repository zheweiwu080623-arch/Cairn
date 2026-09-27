// routes/connectors.mjs —— 数据源接口（R2：从 server.mjs 拆出来的第三组）
//
// 这里管的是 `/api/connectors*`：
//   列表 / 单个状态 / 导入 / **测试连接**（连接向导用的那个）/ 离线示例 / 推进平台。
//
// 两条不能改的底线（都有验证盯着，见 tests/credential-mask.test.mjs 与 tests/connectors-*.test.mjs）：
//   1. **回给界面的配置永远是掩码**，明文只留在库里；
//   2. **测试连接走的就是导入那条代码路径**（真拉一次、只取少量），
//      所以它给出的结论跟"真导入"一致 —— 不要为了"快"另写一套假检查。

import {
  maskConfigJson, maskConnectorConfig, unmaskConnectorConfig,
} from '../credential-mask.mjs';
// 实例 id = 类型（第一条）/ 类型#2、#3…（2026-09-26：同一类型可以配多条）
import { instanceOrdinal, instanceSuffix, instanceType, nextInstanceId } from '../connectors/instances.mjs';

export function createConnectorRoutes(ctx) {
  const {
    store, sendJson, sendError, notFound, readBody,
    listConnectorMeta, getConnector, normalizeForStore,
    describeTestResult, humanizeConnectorError, pushItemToPlanner,
  } = ctx;

  async function handleConnectors(req, res, url) {
    const seg = url.pathname.split('/').filter(Boolean); // ['api','connectors', source?, action?]
    const method = req.method;

    // metadata + status overview
    if (seg.length === 2 && method === 'GET') {
      const meta = listConnectorMeta();
      // 凭据只回掩码：界面照常填充，但接口不再泄露明文
      const configs = store.listConnectors().map((c) => ({
        ...c,
        type: instanceType(c.source),
        instance: instanceOrdinal(c.source),
        suffix: instanceSuffix(c.source),
        config_json: maskConfigJson(instanceType(c.source), c.config_json),
      }));
      // counts 仍按**类型**合计（历史上有别的页面在用），另给一份按实例的
      const counts = {};
      for (const m of meta) counts[m.id] = 0;
      const countsByInstance = {};
      for (const c of store.listConnectors()) {
        const t = instanceType(c.source);
        const n = store.countConnectorData(c.source);
        countsByInstance[c.source] = n;
        if (counts[t] === undefined) counts[t] = 0;
        counts[t] += n;
      }
      return sendJson(res, 200, { connectors: meta, configs, counts, counts_by_instance: countsByInstance });
    }

    // seg[2] 既可能是类型（`rss`），也可能是某条实例（`rss@2`）；类型用来查定义，实例才是存取键。
    // **要解码**：有些客户端会把 `@` 写成 `%40`（我自己的验证脚本就踩过 —— 编码后不解码，
    // 于是"删 rss@2"变成了 404）。
    const decode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
    const source = decode(seg[2]);
    const action = seg[3];
    const type = instanceType(source);
    if (!source || !getConnector(type)) return sendError(res, 404, '未知数据源');

    if (!action && method === 'GET') {
      const config = store.getConnector(source);
      return sendJson(res, 200, {
        source,
        type,
        meta: getConnector(type).meta,
        config: config ? maskConnectorConfig(type, JSON.parse(config.config_json || '{}')) : null,
        status: config ? config.status : 'never',
        last_sync: config ? config.last_sync : null,
        last_error: config ? config.last_error : null,
        data: store.listConnectorData(source),
        count: store.countConnectorData(source),
      });
    }

    /** 取"库里存的那份配置"（坏了就当空对象，不要因为一份脏数据把接口打挂）。 */
    const storedConfigOf = (src) => {
      const row = store.getConnector(src);
      try { return JSON.parse(row?.config_json || '{}'); } catch { return {}; }
    };

    /**
     * 决定这次写哪一条实例（同类型可以有多条）：
     *   * 带了 `instance` ⇒ 就是它（"改一下"那条路）；
     *   * `create: true` ⇒ **新建一条**：类型还没人用就用类型本身，否则 `rss#2`、`rss#3`…
     *     （界面上点「＋ 添加数据源」走这条 —— 这是"两个 RSS"的关键）；
     *   * 都没有 ⇒ 沿用老语义，**按 key 刷新/覆盖这一条**（幂等，脚本和老界面都靠它）。
     */
    const resolveTarget = (wanted, create) => {
      const w = String(wanted || '').trim();
      if (w) return instanceType(w) === type ? w : null;
      if (create) return nextInstanceId(type, store.listConnectors().map((c) => c.source));
      return source;
    };

    // 删掉一个**已经加过**的数据源（2026-09-26 用户要求：加错了要能删）。
    // 一并清掉它导入进 connector_data 的那些条目；**已经推送到日程/任务的不会动**
    //（那些已经是用户自己的任务了，删数据源不该连带删掉）。
    if (!action && method === 'DELETE') {
      const had = !!store.getConnector(source);
      const items = store.countConnectorData(source);
      if (items) store.clearConnectorData(source);
      const removed = store.deleteConnector(source);
      return sendJson(res, 200, {
        ok: true, source, removed_config: removed, removed_items: items,
        note: had ? '已删除（含它导入的数据）' : '本来就没有配置，已清理干净',
      });
    }

    if (action === 'import' && method === 'POST') {
      const body = await readBody(req);
      const target = resolveTarget(body.instance, body.create === true);
      if (!target) return sendError(res, 400, '实例和类型对不上');
      // 界面拿到的凭据是掩码（••••1234）；原样带回时沿用已存的真值，别把掩码存成新密码
      const storedConfig = storedConfigOf(target);
      const config = unmaskConnectorConfig(type, body.config || {}, storedConfig);
      const conn = getConnector(type);
      try {
        const result = await conn.fetchAll(config);
        store.clearConnectorData(target);
        let inserted = 0;
        for (const it of result.items) {
          store.insertConnectorData(target, normalizeForStore(it, target));
          inserted++;
        }
        store.setConnector(target, JSON.stringify(config), inserted ? 'ok' : 'empty', null);
        return sendJson(res, 200, {
          source: target, type, instance: instanceOrdinal(target), inserted, raw: result.raw, status: 'ok',
        });
      } catch (e) {
        store.setConnector(target, JSON.stringify(config), 'error', e.message);
        return sendJson(res, 200, { source: target, type, instance: instanceOrdinal(target), inserted: 0, error: e.message, status: 'error' });
      }
    }

    // ---------- 测试连接（W4-2 连接向导）----------
    // 用"真拉一次、只取少量"验证配置：走的就是导入那条代码路径，所以结论最可信。
    // 失败时报错会被翻译成人话 + 下一步怎么做。
    if (action === 'test' && method === 'POST') {
      const body = await readBody(req);
      const storedConfig = storedConfigOf(source);
      // 没填的字段回落到已保存的值；界面传来的掩码凭据也沿用已存的真值
      // （"只改一个字段再测一次"是最常见的用法）
      const config = unmaskConnectorConfig(type, { ...storedConfig, ...(body.config || {}) }, storedConfig);

      // 必填项检查（用连接器自己的字段定义，别让用户猜）
      const meta = getConnector(type).meta || {};
      const missing = (meta.fields || [])
        .filter((f) => f.required && !String(config[f.key] ?? '').trim())
        .map((f) => f.label || f.key);
      if (missing.length) {
        return sendJson(res, 200, {
          ok: false, missing,
          message: `还有必填项没填：${missing.join('、')}`,
        });
      }

      const started = Date.now();
      try {
        const result = await Promise.race([
          getConnector(type).fetchAll(config),
          new Promise((_, reject) => setTimeout(() => reject(new Error('ETIMEDOUT 连接超时（60 秒）')), 60000)),
        ]);
        const items = result?.items || [];
        return sendJson(res, 200, {
          ok: true, count: items.length, ms: Date.now() - started,
          message: describeTestResult(type, { ok: true, count: items.length }),
          sample: items.slice(0, 3).map((i) => String(i.title || '').slice(0, 60)),
        });
      } catch (e) {
        const h = humanizeConnectorError(type, e);
        return sendJson(res, 200, { ok: false, error: h.raw, message: h.text, ms: Date.now() - started });
      }
    }

    if (action === 'demo' && method === 'POST') {
      const body = await readBody(req).catch(() => ({}));
      const target = resolveTarget(body && body.instance, body && body.create === true) || source;
      const conn = getConnector(type);
      const result = conn.fromSample();
      store.clearConnectorData(target);
      let inserted = 0;
      for (const it of result.items) {
        store.insertConnectorData(target, normalizeForStore(it, target));
        inserted++;
      }
      store.setConnector(target, '{}', 'demo', null);
      return sendJson(res, 200, { source: target, type, inserted, raw: result.raw, status: 'demo' });
    }

    if (action === 'push' && method === 'POST') {
      // Merge connector data into the planner (events / tasks / notifications).
      const rows = store.listConnectorData(source);
      let pushed = 0;
      for (const r of rows) { r.source = source; pushed += pushItemToPlanner(r); }
      return sendJson(res, 200, { source, pushed });
    }

    return notFound(res);
  }

  return { handleConnectors };
}
