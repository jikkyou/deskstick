/**
 * 组件注册表
 * 每个组件 = 一个模块，导出一个定义：
 *   { type, name, size:{w,h}, config:{}, render(body, ctx) }
 * ctx: { model, state, save, toast, api, refresh() }
 * 加新组件只要写一个文件 + 在 main.js 里 import 一次。
 */
export const registry = new Map();

export function defineWidget(def) {
  if (!def || !def.type) throw new Error('组件必须有 type');
  registry.set(def.type, { size: { w: 300, h: 260 }, config: {}, ...def });
  return def;
}

export function widgetDefs() {
  return [...registry.values()];
}
