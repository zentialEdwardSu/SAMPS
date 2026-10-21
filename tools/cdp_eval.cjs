"use strict";
// Development helper: evaluate an async snippet inside the loaded SAMPS panel through the
// UDT debugger socket and print its JSON result. Read-only unless the snippet itself edits.
//   node tools/cdp_eval.cjs snippet.js [timeoutSeconds]
// The snippet is the body of an async function; `ps` (photoshop) and `uxp` are in scope.
const fs = require("node:fs");
const path = require("node:path");

const logFolder = path.join(process.env.APPDATA, "Adobe/Adobe UXP Developer Tool/Logs");
const latest = fs.readdirSync(logFolder).filter(name => /^appLogs-.*\.log$/.test(name)).sort().at(-1);
const sockets = [...fs.readFileSync(path.join(logFolder, latest), "utf8")
  .matchAll(/ws=127\.0\.0\.1:14001\/socket\/cdt\/([a-f0-9-]+)/g)];
if (!sockets.length) throw new Error("No UDT debugger session found; click Debug in UDT first");
const body = fs.readFileSync(process.argv[2], "utf8");
const timeout = Number(process.argv[3] || 60) * 1000;
const key = `__sampsEval${Date.now()}`;
const expression = `globalThis.${key}={state:'running'};(async()=>{const ps=require('photoshop');const uxp=require('uxp');
${body}
})().then(v=>{globalThis.${key}={state:'done',ok:true,value:v};},e=>{globalThis.${key}={state:'done',ok:false,
error:String(e&&e.message||e),code:e&&e.code,number:e&&e.number,stack:String(e&&e.stack||'').slice(0,800)};});`;

const ws = new WebSocket(`ws://127.0.0.1:14001/socket/cdt/${sockets.at(-1)[1]}`);
let id = 1, contextId, poll;
const send = (method, params) => ws.send(JSON.stringify({ id: id++, method, params }));
const verbose = process.env.SAMPS_CDP_VERBOSE === "1";
const finish = code => { clearInterval(poll); clearTimeout(deadline); try { ws.close(); } catch {} process.exit(code); };
const deadline = setTimeout(() => { console.error("timed out"); finish(2); }, timeout);
const start = context => {
  if (contextId !== undefined) return;
  contextId = context;
  send("Runtime.evaluate", { contextId, expression, returnByValue: true });
  poll = setInterval(() => send("Runtime.evaluate", { contextId, expression: `JSON.stringify(globalThis.${key})`, returnByValue: true }), 300);
};
// UXP does not always announce its existing context after Runtime.enable; its panel context is id 3.
ws.onopen = () => { send("Runtime.enable", {}); setTimeout(() => start(3), 500); };
ws.onmessage = event => {
  const message = JSON.parse(event.data);
  if (verbose) console.error(String(event.data).slice(0, 300));
  if (message.method === "Runtime.executionContextCreated") { start(message.params.context.id); return; }
  if (message.result && message.result.exceptionDetails) {
    console.error(JSON.stringify(message.result.exceptionDetails, null, 2));
    finish(1); return;
  }
  const value = message.result && message.result.result && message.result.result.value;
  if (typeof value !== "string") return;
  const state = JSON.parse(value);
  if (state.state !== "done") return;
  console.log(JSON.stringify(state.ok ? state.value : state, null, 2));
  finish(state.ok ? 0 : 1);
};
ws.onerror = error => { console.error("socket error", error.message || error); finish(1); };
ws.onclose = () => { if (verbose) console.error("socket closed"); };
