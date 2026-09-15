#!/usr/bin/env node
// Produce a text-only public derivative of a Codex rollout log (the private
// per-thread .jsonl Codex writes). Review the output before publishing it.
// Images, reasoning payloads, prompts injected by the host, and metadata are omitted.
//
// Derived from cozyblaze's portal-agent, tools/export-session.mjs
// (MIT, Copyright (c) 2026 cozyblaze; license text in packages/core/vendor/portal-agent/LICENSE; see packages/core/NOTICE).
// Changes: time zone from AAS_TIME_ZONE (default: system), completion marker
// from AAS_COMPLETION_MARKER (a prefix of the agent's final message) instead
// of the Portal-specific text, summary.json keeps schema_version 2 so it stays
// byte-compatible with portal-agent's evidence; `aas publish` raises it and adds
// the blocks that belong to a bundle.
//
// Usage: node export-codex-rollout.mjs <private-rollout.jsonl> <new-output-directory>
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {once} from 'node:events';
import {defaultTimeZone, localTimestamp} from '../core/src/timestamp.mjs';
import {createSanitizer} from '../core/src/sanitize.mjs';
const TIME_ZONE = defaultTimeZone();
const COMPLETION_MARKER = process.env.AAS_COMPLETION_MARKER || null;
const ts = value => localTimestamp(value, TIME_ZONE);
const [input, destination] = process.argv.slice(2);
if (!input || !destination) throw new Error('Usage: node export-codex-rollout.mjs <private-rollout.jsonl> <new-output-directory>');
fs.mkdirSync(destination,{recursive:true});
const output=fs.createWriteStream(path.join(destination,'session.sanitized.jsonl'),{flags:'wx'});
const counts={source_records:0,exported_records:0,omitted_records:0};
const ids=new Map();const calls=new Map();const models=new Map();const methods=new Map();
// What the rollout itself reports, per model: its provider (session_meta), its context window (token_count, for the
// model of the turn it follows) and the Codex CLI version. Codex reports no maximum output.
let provider=null,currentModel=null;const cliVersions=new Set();
let firstTime, lastTime, completionTime, finalUsage, sequence=0;
const {cleanText,clean,counts:imageCounts,redactions}=createSanitizer();
function contentText(content){return (content??[]).filter(c=>typeof c.text==='string').map(c=>c.text).join('\n');}
for await(const line of readline.createInterface({input:fs.createReadStream(input),crlfDelay:Infinity})){
 const row=JSON.parse(line),p=row.payload??{};counts.source_records++;
 firstTime??=row.timestamp;lastTime=row.timestamp;
 if(row.type==='session_meta'){if(typeof p.cli_version==='string'&&p.cli_version)cliVersions.add(p.cli_version);provider=p.model_provider??provider;}
 if(row.type==='turn_context'){currentModel=JSON.stringify({model:p.model,reasoning_effort:p.effort??null});if(!models.has(currentModel))models.set(currentModel,{provider,context_window:null});}
 if(row.type==='event_msg'&&p.type==='token_count'&&currentModel&&Number.isInteger(p.info?.model_context_window))models.get(currentModel).context_window=p.info.model_context_window;
 if(row.type==='token_usage_record')finalUsage=p.thread_token_usage;
 if(row.type==='event_msg'&&p.type==='task_complete'&&COMPLETION_MARKER&&p.last_agent_message?.startsWith(COMPLETION_MARKER))completionTime=row.timestamp;
 let item;
 if(row.type==='response_item'){
  if(p.type==='message'&&['user','assistant'].includes(p.role)){
   const text=contentText(p.content);
   // The run instructions are published separately, without their environment wrapper.
   if(p.role==='user'&&(text.startsWith('# AGENTS.md instructions')||text.trim().startsWith('<environment_context>'))){}
   else if(text.trim())item={kind:'message',role:p.role,channel:p.channel??null,text:cleanText(text)};
  }else if(p.type==='custom_tool_call'){
   const id='call-'+String(ids.size+1).padStart(5,'0');ids.set(p.call_id,id);calls.set(p.call_id,p.name);
   for(const m of p.input.matchAll(/tools\.([A-Za-z0-9_]+)/g))methods.set(m[1],(methods.get(m[1])??0)+1);
   item={kind:'tool_call',call:id,name:p.name,input:cleanText(p.input)};
  }else if(p.type==='custom_tool_call_output'&&ids.has(p.call_id))item={kind:'tool_result',call:ids.get(p.call_id),output:clean(p.output)};
  else if(p.type==='function_call'&&p.name==='wait'){
   const id='call-'+String(ids.size+1).padStart(5,'0');ids.set(p.call_id,id);
   item={kind:'tool_call',call:id,name:p.name,input:cleanText(p.arguments)};
  }else if(p.type==='function_call_output'&&ids.has(p.call_id))item={kind:'tool_result',call:ids.get(p.call_id),output:clean(p.output)};
 }
 if(item){const result={sequence:++sequence,timestamp:ts(row.timestamp),elapsed_seconds:Math.round((Date.parse(row.timestamp)-Date.parse(firstTime))/1000),...item};if(!output.write(JSON.stringify(result)+'\n'))await once(output,'drain');counts.exported_records++;}
 else counts.omitted_records++;
}
output.end();await once(output,'finish');
const summary={schema_version:2,time_zone:TIME_ZONE,run_dates:`${ts(firstTime).slice(0,10)} to ${ts(lastTime).slice(0,10)}`,started_at:ts(firstTime),completed_at:completionTime?ts(completionTime):null,ended_at:ts(lastTime),models:[...models].map(([k,r])=>({...JSON.parse(k),context_window:r.context_window,max_output_tokens:null,provider:r.provider??null})),...counts,removed_images:imageCounts.removed_images,redactions,elapsed_to_completion_seconds:completionTime?Math.round((Date.parse(completionTime)-Date.parse(firstTime))/1000):null,elapsed_including_post_completion_seconds:Math.round((Date.parse(lastTime)-Date.parse(firstTime))/1000),last_reported_thread_token_usage:finalUsage,tool_methods_in_exec:Object.fromEntries(methods),cli_versions:[...cliVersions],export_notes:['Sanitized text export of run messages, tool calls, and results.',`Timestamps use ${TIME_ZONE} time, with an explicit UTC offset; elapsed seconds are durations.`,'Host/system/developer context, world state, context-compaction/history/note tool records, reasoning payloads, opaque data and original identifiers are omitted.','Embedded images are omitted from this text release.','Token counts are cumulative reported usage and include cached input.']};
fs.writeFileSync(path.join(destination,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({records:counts,redactions}));
