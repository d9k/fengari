/*jshint esversion: 6 */
"use strict";

const assert = require('assert');

const defs    = require('./defs.js');
const ldebug  = require('./ldebug.js');
const lobject = require('./lobject.js');
const lstring = require('./lstring.js');
const lstate  = require('./lstate.js');
const CT      = defs.constant_types;

/* used to prevent conflicts with lightuserdata keys */
let lightuserdata_hashes = new WeakMap();
const get_lightuserdata_hash = function(v) {
    let hash = lightuserdata_hashes.get(v);
    if (!hash) {
        /* Hash should be something unique that is a valid WeakMap key
           so that it ends up in dead_weak when removed from a table */
        hash = {};
        lightuserdata_hashes.set(v, hash);
    }
    return hash;
};

const table_hash = function(L, key) {
    switch(key.type) {
    case CT.LUA_TNIL:
        return ldebug.luaG_runerror(L, defs.to_luastring("table index is nil", true));
    case CT.LUA_TNUMFLT:
        if (isNaN(key.value))
            return ldebug.luaG_runerror(L, defs.to_luastring("table index is NaN", true));
        /* fall through */
    case CT.LUA_TNUMINT: /* takes advantage of floats and integers being same in JS */
    case CT.LUA_TBOOLEAN:
    case CT.LUA_TTABLE:
    case CT.LUA_TLCL:
    case CT.LUA_TLCF:
    case CT.LUA_TCCL:
    case CT.LUA_TUSERDATA:
    case CT.LUA_TTHREAD:
        return key.value;
    case CT.LUA_TSHRSTR:
    case CT.LUA_TLNGSTR:
        return lstring.luaS_hashlongstr(key.tsvalue());
    case CT.LUA_TLIGHTUSERDATA:
        let v = key.value;
        switch(typeof v) {
        case "string":
            /* possible conflict with LUA_TSTRING.
               prefix this string with "*" so they don't clash */
            return "*" + v;
        case "number":
            /* possible conflict with LUA_TNUMBER.
               turn into string and prefix with "#" to avoid clash with other strings */
            return "#" + v;
        case "boolean":
            /* possible conflict with LUA_TBOOLEAN. use strings ?true and ?false instead */
            return v?"?true":"?false";
        case "function":
            /* possible conflict with LUA_TLCF.
               indirect via a weakmap */
            return get_lightuserdata_hash(v);
        case "object":
            /* v shouldn't be a CClosure, LClosure, Table or Userdata from this state as they're never exposed
               the only exposed internal type is a lua_State */
            if (v instanceof lstate.lua_State && v.l_G === L.l_G) {
                /* indirect via a weakmap */
                return get_lightuserdata_hash(v);
            }
            /* fall through */
        default:
            return v;
        }
    default:
        throw new Error("unknown key type: " + key.type);
    }
};

class Table {
    constructor(L) {
        this.id = L.l_G.id_counter++;
        this.strong = new Map();
        this.dead_strong = new Map();
        this.dead_weak = void 0; /* initialised when needed */
        this.f = void 0; /* first entry */
        this.l = void 0; /* last entry */
        this.metatable = null;
        this.flags = ~0;
    }
}

const invalidateTMcache = function(t) {
    t.flags = 0;
};

const add = function(t, hash, key, value) {
    t.dead_strong.clear();
    t.dead_weak = void 0;
    let prev = null;
    let entry = {
        key: key,
        value: value,
        p: prev = t.l,
        n: void 0
    };
    if (!t.f) t.f = entry;
    if (prev) prev.n = entry;
    t.strong.set(hash, entry);
    t.l = entry;
};

const is_valid_weakmap_key = function(k) {
    return typeof k === 'object' ? k !== null : typeof k === 'function';
};

/* Move out of 'strong' part and into 'dead' part. */
const mark_dead = function(t, hash) {
    let e = t.strong.get(hash);
    if (e) {
        e.key.setdeadvalue();
        e.value = void 0;
        let next = e.n;
        let prev = e.p;
        e.p = void 0; /* no need to know previous item any more */
        if(prev) prev.n = next;
        if(next) next.p = prev;
        if(t.f === e) t.f = next;
        if(t.l === e) t.l = prev;
        t.strong.delete(hash);
        if (is_valid_weakmap_key(hash)) {
            if (!t.dead_weak) t.dead_weak = new WeakMap();
            t.dead_weak.set(hash, e);
        } else {
            /* can't be used as key in weakmap */
            t.dead_strong.set(hash, e);
        }
    }
};

const luaH_new = function(L) {
    return new Table(L);
};

const getgeneric = function(t, hash) {
    let v = t.strong.get(hash);
    return v ? v.value : lobject.luaO_nilobject;
};

const luaH_getint = function(t, key) {
    assert(typeof key == "number" && (key|0) === key);
    return getgeneric(t, key);
};

const luaH_getstr = function(t, key) {
    assert(key instanceof lstring.TString);
    return getgeneric(t, lstring.luaS_hashlongstr(key));
};

const luaH_get = function(L, t, key) {
    assert(key instanceof lobject.TValue);
    if (key.ttisnil() || (key.ttisfloat() && isNaN(key.value)))
        return lobject.luaO_nilobject;
    return getgeneric(t, table_hash(L, key));
};

const setgeneric = function(t, hash, key) {
    let v = t.strong.get(hash);
    if (v)
        return v.value;

    let kv = key.value;
    if ((key.ttisfloat() && (kv|0) === kv)) { /* does index fit in an integer? */
        /* insert it as an integer */
        key = new lobject.TValue(CT.LUA_TNUMINT, kv);
    } else {
        key = new lobject.TValue(key.type, kv);
    }
    let tv = new lobject.TValue(CT.LUA_TNIL, null);
    add(t, hash, key, tv);
    return tv;
};

const luaH_setint = function(t, key, value) {
    assert(typeof key == "number" && (key|0) === key && value instanceof lobject.TValue);
    let hash = key; /* table_hash known result */
    if (value.ttisnil()) {
        mark_dead(t, hash);
        return;
    }
    let v = t.strong.get(hash);
    if (v) {
        let tv = v.value;
        tv.setfrom(value);
    } else {
        let k = new lobject.TValue(CT.LUA_TNUMINT, key);
        let v = new lobject.TValue(value.type, value.value);
        add(t, hash, k, v);
    }
};

const luaH_set = function(L, t, key) {
    assert(key instanceof lobject.TValue);
    let hash = table_hash(L, key);
    return setgeneric(t, hash, key);
};

const luaH_delete = function(L, t, key) {
    assert(key instanceof lobject.TValue);
    let hash = table_hash(L, key);
    return mark_dead(t, hash);
};

/*
** Try to find a boundary in table 't'. A 'boundary' is an integer index
** such that t[i] is non-nil and t[i+1] is nil (and 0 if t[1] is nil).
*/
const luaH_getn = function(t) {
    let i = 0;
    let j = t.strong.size + 1; /* use known size of Map to bound search */
    /* now do a binary search between them */
    while (j - i > 1) {
        let m = Math.floor((i+j)/2);
        if (luaH_getint(t, m).ttisnil()) j = m;
        else i = m;
    }
    return i;
};

const luaH_next = function(L, table, keyI) {
    let keyO = L.stack[keyI];

    let entry;
    if (keyO.type === CT.LUA_TNIL) {
        entry = table.f;
        if (!entry)
            return false;
    } else {
        /* First find current key */
        let hash = table_hash(L, keyO);
        /* Look in main part of table */
        entry = table.strong.get(hash);
        if (entry) {
            entry = entry.n;
            if (!entry)
                return false;
        } else {
            /* Try dead keys */
            entry = (table.dead_weak && table.dead_weak.get(hash)) || table.dead_strong.get(hash);
            if (!entry)
                /* item not in table */
                return ldebug.luaG_runerror(L, defs.to_luastring("invalid key to 'next'"));
            /* Iterate until either out of keys, or until finding a non-dead key */
            do {
                entry = entry.n;
                if (!entry)
                    return false;
            } while (entry.key.ttisdeadkey());
        }
    }
    L.stack[keyI] = new lobject.TValue(entry.key.type, entry.key.value);
    L.stack[keyI+1] = new lobject.TValue(entry.value.type, entry.value.value);
    return true;
};

module.exports.invalidateTMcache = invalidateTMcache;
module.exports.luaH_delete  = luaH_delete;
module.exports.luaH_get     = luaH_get;
module.exports.luaH_getint  = luaH_getint;
module.exports.luaH_getn    = luaH_getn;
module.exports.luaH_getstr  = luaH_getstr;
module.exports.luaH_set     = luaH_set;
module.exports.luaH_setint  = luaH_setint;
module.exports.luaH_new     = luaH_new;
module.exports.luaH_next    = luaH_next;
