// Live overlay for the recorder: a small HTTP server that serves an overlay
// page (timers, current section, keys being played, last agent action) and
// streams the run's events to it with Server-Sent Events. OBS shows it as a
// browser source; it works for any game plugin that logs game.playback.
import http from "node:http";
import { followEvents, readRunLog } from "./events.mjs";

const PAGE = `<!doctype html><meta charset="utf-8"><title>AAS overlay</title>
<style>
html,body{margin:0;background:transparent;font-family:"Segoe UI",system-ui,sans-serif;color:#fff;text-shadow:0 0 6px #000,0 0 2px #000}
#box{position:absolute;left:24px;bottom:24px;display:flex;flex-direction:column;gap:6px}
.row{display:flex;gap:14px;align-items:baseline}
.lab{font-size:20px;opacity:.75;width:60px}.val{font-size:40px;font-variant-numeric:tabular-nums}
#keys{display:flex;gap:8px;min-height:44px}#keys[hidden]{display:none}
.key{padding:6px 12px;border:2px solid rgba(255,255,255,.35);border-radius:8px;font-size:22px;background:rgba(0,0,0,.35);opacity:.35}
.key.on{opacity:1;background:rgba(80,180,255,.55);border-color:#fff}
#status{font-size:22px;opacity:.9}#section{font-size:22px;opacity:.75}
</style>
<div id="box">
 <div id="section"></div>
 <div class="row"><span class="lab">RTA</span><span class="val" id="rta">00:00:00</span><span class="lab">IGT</span><span class="val" id="igt">00:00:00.0</span></div>
 <div id="keys" hidden></div>
 <div id="status">waiting for the run to start…</div>
</div>
<script>
const KEYS=["forward","back","left","right","jump","duck","use","attack","attack2"];
const LABEL={forward:"W",back:"S",left:"A",right:"D",jump:"SPACE",duck:"CTRL",use:"E",attack:"LMB",attack2:"RMB"};
const keysEl=document.getElementById("keys");
for(const k of KEYS){const d=document.createElement("div");d.className="key";d.id="k-"+k;d.textContent=LABEL[k];keysEl.appendChild(d)}
let t0=null,igt=0,playing=null,section="Start";
const pad=(n,w=2)=>String(n).padStart(w,"0");
const hms=(s,dec)=>{const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return pad(h)+":"+pad(m)+":"+(dec?(x<10?"0":"")+x.toFixed(1):pad(Math.floor(x)))};
function setKeys(on){for(const k of KEYS)document.getElementById("k-"+k).classList.toggle("on",on.includes(k))}
function tick(){
 if(t0)document.getElementById("rta").textContent=hms((Date.now()-t0)/1000);
 let g=igt;
 if(playing){const el=(Date.now()-playing.t)/1000;let acc=0;let on=[];
  for(const st of playing.steps){const d=st.ticks*0.015;if(el<acc+d){on=st.keys||[];break}acc+=d}
  g+=Math.min(el,playing.total);setKeys(on)}
 document.getElementById("igt").textContent=hms(g,true);
 requestAnimationFrame(tick)}
requestAnimationFrame(tick);
const es=new EventSource("/events");
es.onmessage=(m)=>{const r=JSON.parse(m.data);const d=r.data||{};const st=document.getElementById("status");
 if(r.kind==="event"){
  if(r.event==="run.started"){t0=Date.parse(r.timestamp);st.textContent="run started"}
  if(r.event==="recording.started"&&d.t0)t0=Date.parse(d.t0);
  if(r.event==="game.playback"&&d.phase==="start"){document.getElementById("keys").hidden=!(d.steps&&d.steps.length);playing={t:Date.now(),steps:d.steps||[],total:(d.planned_ticks||0)*0.015};st.textContent=d.command?"playing: "+d.command:"playing "+((d.planned_ticks||0)*0.015).toFixed(1)+" s"}
  if(r.event==="game.playback"&&d.phase==="end"){playing=null;setKeys([]);if(typeof d.ticks==="number")igt+=d.ticks*0.015;else if(typeof d.seconds==="number")igt+=d.seconds;st.textContent="thinking…"}
  if(r.event==="game.milestone"&&d.chapter){section=d.label;document.getElementById("section").textContent=section}
  if(r.event==="game.attempt"&&d.phase==="start"){st.textContent="attempt "+d.attempt}
  if(r.event==="game.over"){playing=null;setKeys([]);st.textContent=d.victory?"victory":"died, restart"}
  if(r.event==="run.ended"){playing=null;setKeys([]);if(!/victory/.test(st.textContent))st.textContent="run ended"}
 } else if(r.kind==="tool_call"){st.textContent=r.name.replace(/^.*_/,"")+(r.input&&r.input.code?": "+String(r.input.code).replace(/\\s+/g," ").slice(0,90):"")}
};
</script>`;

export function startOverlayServer(runDir, { port = 0, host = "127.0.0.1" } = {}) {
  const clients = new Set();
  const write = (record) => {
    const line = `data: ${JSON.stringify(record)}\n\n`;
    for (const c of clients) c.write(line);
  };
  const server = http.createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "Access-Control-Allow-Origin": "*" });
      res.write(":ok\n\n");
      // Replay the run so far, so a browser source that (re)loads mid-run catches up.
      for (const r of readRunLog(runDir)) if (r.kind === "event" || r.kind === "tool_call") res.write(`data: ${JSON.stringify(r)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const follower = followEvents(runDir, () => {}, { intervalMs: 250, all: true, onRecord: (r) => (r.kind === "event" || r.kind === "tool_call") && write(r) });
  return new Promise((resolve) =>
    server.listen(port, host, () => {
      const url = `http://${host}:${server.address().port}/`;
      resolve({
        url,
        port: server.address().port,
        push: write,
        async close() {
          await follower.stop();
          for (const c of clients) c.end();
          await new Promise((r) => server.close(() => r()));
        },
      });
    }),
  );
}
