'use strict';
/**
 * 轻量 JSON 语义层（包装 JavaScript 原生 JSON）。
 *
 * Node 自带 JSON 解析/序列化，这里只补齐两处上游接口需要的语义：
 *  1. optObj / optStr / optLong ... 的「安全取值」——键不存在返回默认值。
 *  2. stringify(v, skipNulls) 中 skipNulls 模拟 JS 中 undefined 被省略的行为
 *     （用于把 null 字段省略）。
 *
 * 数字语义直接交给原生：整数不带小数点，1.0 也输出为 1。
 */

class JsonException extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'JsonException';
  }
}

/** 解析 JSON 文本；非法输入抛 JsonException。null/undefined 返回 null。 */
function parse(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new JsonException(e.message);
  }
}

/** 解析并要求顶层是对象；空串返回空对象（宽容上游空体）。 */
function parseObject(text) {
  if (text === null || text === undefined) return {};
  if (typeof text === 'string' && text.trim() === '') return {};
  const v = parse(text);
  if (v === null || v === undefined) return {};
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new JsonException('期望 JSON 对象，实际是 ' + typeName(v));
  }
  return v;
}

/** 递归去掉对象里的 null/undefined 字段（数组元素原样保留）。 */
function stripNulls(v) {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v)) {
      if (v[k] === null || v[k] === undefined) continue;
      out[k] = stripNulls(v[k]);
    }
    return out;
  }
  return v;
}

/** 序列化为 JSON 文本；skipNulls 为 true 时省略值为 null 的字段。 */
function stringify(v, skipNulls = false) {
  return JSON.stringify(skipNulls ? stripNulls(v) : v);
}

/** 美化输出（仅用于日志与落盘）。 */
function stringifyPretty(v) {
  return JSON.stringify(v, null, 2);
}

function typeName(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

/** 取对象；不存在或非对象返回 null。 */
function optObj(v) {
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null;
}

/** 取数组；不存在或非数组返回空数组。 */
function optArr(v) {
  return Array.isArray(v) ? v : [];
}

/** 取字符串；null/undefined 返回 def，数字/布尔按 JS 隐式转换。 */
function optStr(v, def = '') {
  if (v === null || v === undefined) return def;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return def;
}

/** 取整数；非数字返回 def。 */
function optLong(v, def = 0) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string') {
    const n = parseInt(v.trim(), 10);
    return Number.isNaN(n) ? def : n;
  }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return def;
}

function optInt(v, def = 0) {
  return optLong(v, def);
}

/** 取浮点；整型值也会正确转换。 */
function optDouble(v, def = 0) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseFloat(v.trim());
    return Number.isNaN(n) ? def : n;
  }
  return def;
}

/** 取布尔：true/1/yes/on 为真，false/0/no/off 为假。 */
function optBool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1') return true;
    if (s === 'false' || s === '0') return false;
  }
  return def;
}

function obj() { return {}; }
function arr() { return []; }

module.exports = {
  parse, parseObject, stringify, stringifyPretty,
  optObj, optArr, optStr, optLong, optInt, optDouble, optBool,
  obj, arr,
};
